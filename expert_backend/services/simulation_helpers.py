# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0
# This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

"""Stateless helpers for simulation_mixin.

These are the small, self-contained pieces that used to live as inline
blocks inside `simulate_manual_action` and `compute_superposition`.
Extracting them:
 - Shrinks the orchestrator methods (they were 599 / 285 lines),
 - Lets each concern be unit-tested in isolation, and
 - Makes the data flow explicit (arguments vs. closures).
"""
from __future__ import annotations

import logging
import re
from typing import Any

import numpy as np

from expert_backend.services.sanitize import sanitize_for_json

logger = logging.getLogger(__name__)

# Topology keys recognised by `_build_action_entry_from_topology` — also
# used to distinguish "single topology dict" from "dict of per-action
# topologies" in the caller-provided `action_content`.
TOPO_KEYS: frozenset[str] = frozenset({
    "lines_ex_bus",
    "lines_or_bus",
    "gens_bus",
    "loads_bus",
    "substations",
    "switches",
    "loads_p",
    "gens_p",
    "pst_tap",
})

# Minimum disconnected load (MW) required to flag an islanding event.
# Below this, an extra connected component is treated as an AC load-flow
# numerical artefact (typically fast-mode local non-convergence on
# extreme PST taps) rather than a real outage.
ISLANDING_MW_THRESHOLD: float = 1.0


def canonicalize_action_id(action_id: str) -> str:
    """Return a canonical "+"-joined ID (components sorted alphabetically)."""
    if not action_id or "+" not in action_id:
        return action_id
    return "+".join(sorted(p.strip() for p in action_id.split("+")))


def is_switch_only_content(content: Any) -> bool:
    """True if ``content`` carries only a non-empty ``switches`` dict.

    Used by ``simulate_manual_action`` to decide whether to auto-build a
    human-readable description for user-built SLD-edit actions, instead
    of falling back to the raw ``action_id`` (which is just a generated
    placeholder like ``user_topo_<vl>_<ts>``).
    """
    if not isinstance(content, dict):
        return False
    switches = content.get("switches")
    if not isinstance(switches, dict) or not switches:
        return False
    other_keys = [k for k in content.keys() if k != "switches"]
    return len(other_keys) == 0


def build_switch_action_description(
    switches: dict[str, bool],
    voltage_level_id: str | None = None,
) -> str:
    """Return ``"Manoeuvre manuelle sur <vl>: A ouvert, B fermé"`` ."""
    if not switches:
        return "Manoeuvre manuelle (aucun switch)"
    parts: list[str] = []
    for sw_id, is_open in switches.items():
        verb = "ouvert" if is_open else "fermé"
        parts.append(f"{sw_id} {verb}")
    body = ", ".join(parts)
    if voltage_level_id:
        return f"Manoeuvre manuelle sur {voltage_level_id}: {body}"
    return f"Manoeuvre manuelle: {body}"


def _fmt_setpoint_mw(value: Any) -> str:
    """Format an active-power setpoint for an action description (1 decimal)."""
    try:
        return f"{float(value):.1f}"
    except (TypeError, ValueError):
        return str(value)


def build_manual_action_description(
    content: dict[str, Any],
    voltage_level_id: str | None = None,
) -> str:
    """Describe a user-built SLD-edit action (switch toggles AND/OR injection
    setpoint changes) in one human-readable French clause.

    Generalises :func:`build_switch_action_description` to the combined
    interactive-SLD gesture: the operator can, from the same diagram, flip
    breakers / disconnectors **and** retune the active power of loads /
    generators before simulating one manual action. For a switch-only
    ``content`` the output is byte-identical to
    :func:`build_switch_action_description`, so the existing card / filter
    contract is preserved.

    ``content`` is the post-``_build_action_entry_from_topology`` form, i.e.
    ``switches`` plus ``set_gen_p`` / ``set_load_p`` (absolute MW setpoints).
    """
    parts: list[str] = []
    for sw_id, is_open in (content.get("switches") or {}).items():
        parts.append(f"{sw_id} {'ouvert' if is_open else 'fermé'}")
    for gen_id, p in (content.get("set_gen_p") or {}).items():
        parts.append(f"{gen_id} P={_fmt_setpoint_mw(p)} MW")
    for load_id, p in (content.get("set_load_p") or {}).items():
        parts.append(f"{load_id} P={_fmt_setpoint_mw(p)} MW")
    if not parts:
        return "Manoeuvre manuelle (vide)"
    body = ", ".join(parts)
    if voltage_level_id:
        return f"Manoeuvre manuelle sur {voltage_level_id}: {body}"
    return f"Manoeuvre manuelle: {body}"


def compute_reduction_setpoint(
    element_name: str,
    element_type: str,
    target_mw: float | None,
    obs_n1: Any,
) -> float:
    """Compute the remaining MW setpoint after a target reduction.

    ``element_type`` is 'load' or 'gen'. Returns ``max(0, |current| - target)``.
    Falls back to 0.0 if ``target_mw`` is ``None``, ``obs_n1`` is missing, or
    the element cannot be found on the observation — i.e. the function
    degrades to "full reduction" rather than raising.
    """
    if target_mw is None or obs_n1 is None:
        return 0.0
    try:
        if element_type == "load":
            idx = list(obs_n1.name_load).index(element_name)
            current_mw = float(obs_n1.load_p[idx])
        else:
            idx = list(obs_n1.name_gen).index(element_name)
            current_mw = float(obs_n1.gen_p[idx])
        remaining = max(0.0, abs(current_mw) - float(target_mw))
        return round(remaining, 2)
    except Exception as e:
        logger.warning(
            "[compute_reduction_setpoint] could not compute setpoint for %s: %s — falling back to 0.0",
            element_name, e,
        )
        return 0.0


def compute_redispatch_setpoint(
    gen_name: str,
    delta_mw: float | None,
    obs_n1: Any,
    default_delta_mw: float = 10.0,
) -> float:
    """Compute the new generator setpoint for a redispatch (current + signed delta).

    Unlike :func:`compute_reduction_setpoint` (which *subtracts* a reduction
    from the current output), redispatch *adds* a signed delta: a positive
    ``delta_mw`` raises production, a negative one lowers it. Works in
    production-positive magnitude (pypowsybl ``target_p`` convention) and is
    floored at 0. Falls back to ``default_delta_mw`` (raise) when no delta is
    supplied, and to ``default_delta_mw`` itself when the generator cannot be
    located on the observation.
    """
    delta = float(delta_mw) if delta_mw is not None else float(default_delta_mw)
    if obs_n1 is None:
        return round(max(0.0, delta), 2)
    try:
        idx = list(obs_n1.name_gen).index(gen_name)
        current_mw = abs(float(obs_n1.gen_p[idx]))
        return round(max(0.0, current_mw + delta), 2)
    except Exception as e:
        logger.warning(
            "[compute_redispatch_setpoint] could not compute setpoint for %s: %s — using delta only",
            gen_name, e,
        )
        return round(max(0.0, delta), 2)


_PST_TAP_PATTERN = re.compile(r"(pst(?:_tap)?_(.+))_(inc|dec)(\d+)$")


def parse_pst_tap_id(action_id: str) -> tuple[str, int] | None:
    """Parse a dynamic PST action ID like ``pst_tap_<id>_inc2``.

    Returns ``(pst_id, signed_variation)`` or ``None`` if the ID doesn't
    match the expected shape. ``signed_variation`` is positive for ``inc``
    and negative for ``dec``.
    """
    match = _PST_TAP_PATTERN.match(action_id)
    if not match:
        return None
    _, pst_id, direction, val_str = match.groups()
    val = int(val_str)
    return pst_id, val if direction == "inc" else -val


def clamp_tap(target_tap: int, pst_info: dict[str, int] | None) -> int:
    """Clamp a requested tap position to the PST's ``[low_tap, high_tap]`` bounds.

    ``pst_info`` can be ``None`` (unknown bounds) — in that case the input
    is returned as-is.
    """
    if not pst_info:
        return int(target_tap)
    return max(int(pst_info["low_tap"]), min(int(pst_info["high_tap"]), int(target_tap)))


def classify_action_content(action_content: Any, action_ids: list[str]) -> dict[str, Any]:
    """Normalise a caller-provided ``action_content`` into ``{aid: topology}``.

    ``action_content`` may be:
      - A single topology dict (any of the keys in ``TOPO_KEYS``) — broadcast
        to every ``aid`` in ``action_ids``.
      - A dict mapping ``aid -> topology`` — returned as-is.
    """
    if not action_content:
        return {}
    if any(k in action_content for k in TOPO_KEYS):
        return {aid: action_content for aid in action_ids}
    return action_content


def is_pst_action(action_id: str, dict_action: dict | None, classifier: Any) -> bool:
    """Detect PST actions — mirrors the logic used by the library's
    ``compute_all_pairs_superposition``.
    """
    desc = (dict_action or {}).get(action_id, {})
    action_type = classifier.identify_action_type(desc, by_description=True)
    return (
        action_type in {"pst", "pst_tap"}
        or "pst_tap" in action_id
        or "pst_" in action_id
    )


# Injection-action detection — kept in sync with the recommender library's
# ``superposition.is_injection_action`` (id prefix + classifier action type).
# Replicated here (rather than imported) so it stays correct when the library
# module is stubbed by the test mock layer, exactly like ``is_pst_action``.
_INJECTION_ID_PREFIXES: tuple[str, ...] = ("load_shedding_", "curtail_", "redispatch_")
_INJECTION_ACTION_TYPES: frozenset[str] = frozenset({
    "load_power_reduction", "gen_power_reduction", "gen_redispatch",
    "open_load", "open_gen",
})


def is_injection_action(action_id: str, dict_action: dict | None, classifier: Any) -> bool:
    """Detect injection actions (load shedding / curtailment / redispatch).

    These change only nodal injections (``set_load_p`` / ``set_gen_p``), not the
    topology, and are combined with topology actions through the Generalized
    Superposition Theorem (GST). Detection is by action-id prefix and, when the
    classifier resolves a type, by the injection action types — mirroring the
    library's ``superposition.is_injection_action``.
    """
    if action_id and action_id.startswith(_INJECTION_ID_PREFIXES):
        return True
    desc = (dict_action or {}).get(action_id, {})
    action_type = classifier.identify_action_type(desc, by_description=True)
    return action_type in _INJECTION_ACTION_TYPES


def pst_fallback_line_idxs(
    action_id: str,
    dict_action: dict | None,
    all_actions: dict | None,
    name_line: list[str],
) -> list[int]:
    """Locate the PST transformer line index from an action's ``pst_tap`` content.

    Used when ``_identify_action_elements`` returns empty for a PST action
    (PST tap changes are not topology switches — they don't appear in
    ``lines_ex_bus`` / ``lines_or_bus``).
    """
    entry = (dict_action or {}).get(action_id) or (all_actions or {}).get(action_id, {})
    pst_tap = entry.get("content", {}).get("pst_tap", {})
    if not pst_tap:
        pst_tap = entry.get("action_topology", {}).get("pst_tap", {})
    if not pst_tap:
        return []
    idxs: list[int] = []
    for pst_name in pst_tap:
        if pst_name in name_line:
            idxs.append(name_line.index(pst_name))
    return idxs


def _to_1d(arr: Any) -> np.ndarray:
    """Coerce an array-like (including MagicMock-friendly lists) to 1D numpy."""
    return np.atleast_1d(arr)


def build_care_mask(
    action_names: np.ndarray,
    action_rho: np.ndarray,
    base_rho: np.ndarray,
    lines_we_care_about: Any,
    branches_with_limits: Any,
    lines_overloaded_ids: list[int],
    monitoring_factor: float,
    worsening_threshold: float,
) -> np.ndarray:
    """Build a boolean mask over ``action_names`` selecting "monitored" lines.

    Rules:
      1. Must be in ``lines_we_care_about`` AND ``branches_with_limits``.
      2. Exclude pre-existing N-state overloads UNLESS the action moved
         the line outside the symmetric ``±worsening_threshold`` band
         around its N value (``not_impacted``). Lines whose rho barely
         changes belong to "other issues" and should not pollute the
         action's max_rho; lines whose rho moved significantly — in
         either direction — belong to the action's sensitive area and
         must remain monitored, even when they were already overloaded.
      3. Always force-include lines at ``lines_overloaded_ids`` (active monitoring).

    NOTE: ``action_rho`` and ``base_rho`` come from grid2op observations,
    where ``obs.rho`` is already pre-scaled by the monitoring factor:
    ``obs.rho = current / (permanent_limit * monitoring_factor)``. So
    ``obs.rho >= 1.0`` already means "at or above the monitoring
    threshold", and the comparison MUST use 1.0 — not
    ``monitoring_factor`` — otherwise we double-apply the factor and
    flag lines as overloaded at ``mf**2 ≈ 90.25 %`` of the permanent
    limit instead of 95 %. The ``monitoring_factor`` parameter is kept
    only because it sets the symmetric-impact band scale via
    ``worsening_threshold`` and for parity with the diagram-side
    ``get_overloaded_lines``, which compares pypowsybl currents (NOT
    pre-scaled) against ``limit * monitoring_factor``.

    Falls back to an all-False mask if numpy comparisons fail (legacy tests
    pass MagicMocks for observations).
    """
    mask = np.isin(action_names, list(lines_we_care_about))
    mask &= np.isin(action_names, list(branches_with_limits))
    wt = float(worsening_threshold)
    OBS_RHO_OVERLOAD_THRESHOLD = 1.0  # see docstring — obs.rho is mf-scaled
    try:
        pre_existing = base_rho >= OBS_RHO_OVERLOAD_THRESHOLD
        not_impacted = (action_rho >= base_rho * (1 - wt)) & (action_rho <= base_rho * (1 + wt))
        mask &= ~(pre_existing & not_impacted)
    except Exception as e:
        logger.warning("build_care_mask: vectorised comparison failed (mock context?): %s", e)
        mask = np.zeros(len(action_names), dtype=bool)
    for idx in lines_overloaded_ids:
        if idx < len(mask):
            mask[idx] = True
    return mask


def resolve_lines_overloaded(
    obs_simu_defaut: Any,
    obs_n: Any,
    analysis_context_overloaded: list[str] | None,
    caller_overloaded: list[str] | None,
    lines_we_care_about: Any,
    branches_with_limits: Any,
    monitoring_factor: float,
    worsening_threshold: float,
) -> tuple[list[int], list[str]]:
    """Determine which lines are treated as "overloaded" for reporting.

    Priority: analysis context > caller-provided list > vectorised recomputation.
    Returns ``(ids, names)`` matching ``obs_simu_defaut.name_line``.
    """
    name_line = obs_simu_defaut.name_line
    name_to_idx = {l: i for i, l in enumerate(name_line)}

    if analysis_context_overloaded:
        ids = [name_to_idx[l] for l in analysis_context_overloaded if l in name_to_idx]
        return ids, [name_line[i] for i in ids]

    if caller_overloaded:
        ids = [name_to_idx[l] for l in caller_overloaded if l in name_to_idx]
        return ids, [name_line[i] for i in ids]

    action_names = _to_1d(obs_simu_defaut.name_line)
    action_rho = _to_1d(obs_simu_defaut.rho)
    base_rho = _to_1d(obs_n.rho)
    wt = float(worsening_threshold)
    # obs.rho is already pre-scaled by monitoring_factor — see
    # ``build_care_mask`` docstring. Threshold is 1.0, not mf.
    OBS_RHO_OVERLOAD_THRESHOLD = 1.0

    mask = np.isin(action_names, list(lines_we_care_about))
    mask &= np.isin(action_names, list(branches_with_limits))
    try:
        rho_mask = action_rho >= OBS_RHO_OVERLOAD_THRESHOLD
        pre_existing = base_rho >= OBS_RHO_OVERLOAD_THRESHOLD
        # Symmetric impact rule — see ``build_care_mask`` for rationale.
        not_impacted = (action_rho >= base_rho * (1 - wt)) & (action_rho <= base_rho * (1 + wt))
        mask &= rho_mask & ~(pre_existing & not_impacted)
    except Exception as e:
        logger.warning("resolve_lines_overloaded: vectorised comparison failed: %s", e)
        mask = np.zeros(len(action_names), dtype=bool)

    ids = np.where(mask)[0].tolist()
    names = action_names[mask].tolist()
    return ids, names


def compute_action_metrics(
    obs: Any,
    obs_simu_defaut: Any,
    obs_simu_action: Any,
    info_action: dict,
    lines_overloaded_ids: list[int],
    lines_we_care_about: Any,
    branches_with_limits: Any,
    monitoring_factor: float,
    worsening_threshold: float,
) -> dict[str, Any]:
    """Post-process a single-action simulation result into a scalar summary.

    Returns a dict with: ``rho_before``, ``rho_after``, ``max_rho``,
    ``max_rho_line``, ``is_rho_reduction``, ``is_islanded``,
    ``n_components_after``, ``disconnected_mw``, ``lines_overloaded_after``.
    Handles the non-convergence case by zeroing action-side fields.
    """
    mf = float(monitoring_factor)
    rho_before = (
        (_to_1d(obs_simu_defaut.rho)[lines_overloaded_ids] * mf).tolist()
        if lines_overloaded_ids
        else []
    )

    result = {
        "rho_before": rho_before,
        "rho_after": None,
        "max_rho": 0.0,
        "max_rho_line": "N/A",
        "is_rho_reduction": False,
        "is_islanded": False,
        "n_components_after": 1,
        "disconnected_mw": 0.0,
        "lines_overloaded_after": [],
    }

    if info_action.get("exception"):
        return result

    n_components_after = obs_simu_action.n_components
    result["n_components_after"] = n_components_after
    if (
        n_components_after > obs.n_components
        or n_components_after > obs_simu_defaut.n_components
    ):
        # Topology shows more components, but only flag a real islanding
        # when actual load left the main component. Sub-threshold deltas
        # are almost always AC-LF numerical artefacts (extreme PST taps,
        # fast-mode local non-convergence) rather than physical outages.
        disconnected_mw = float(
            max(0.0, obs_simu_defaut.main_component_load_mw - obs_simu_action.main_component_load_mw)
        )
        if disconnected_mw >= ISLANDING_MW_THRESHOLD:
            result["is_islanded"] = True
            result["disconnected_mw"] = disconnected_mw

    rho_after = (_to_1d(obs_simu_action.rho)[lines_overloaded_ids] * mf).tolist()
    result["rho_after"] = rho_after
    if rho_before:
        try:
            result["is_rho_reduction"] = bool(
                np.all(np.array(rho_after) + 0.01 < np.array(rho_before))
            )
        except Exception as e:
            logger.debug("compute_action_metrics: rho reduction check failed: %s", e)

    action_names = _to_1d(obs_simu_action.name_line)
    action_rho = _to_1d(obs_simu_action.rho)
    base_rho = _to_1d(obs.rho)
    care_mask = build_care_mask(
        action_names,
        action_rho,
        base_rho,
        lines_we_care_about,
        branches_with_limits,
        lines_overloaded_ids,
        monitoring_factor,
        worsening_threshold,
    )

    try:
        monitored_rho = action_rho[care_mask]
        monitored_names = action_names[care_mask]
        # obs.rho is mf-scaled — see ``build_care_mask`` docstring — so
        # the "overloaded" boundary on ``monitored_rho`` is 1.0, not mf.
        overload_mask = monitored_rho >= 1.0
        result["lines_overloaded_after"] = monitored_names[overload_mask].tolist()
        if len(monitored_rho) > 0:
            result["max_rho"] = float(np.max(monitored_rho)) * mf
            result["max_rho_line"] = monitored_names[int(np.argmax(monitored_rho))]
    except Exception as e:
        logger.warning("compute_action_metrics: max_rho / overload calc failed: %s", e)

    return result


def extract_action_topology(action: Any, action_id: str, dict_action: dict | None) -> dict:
    """Read topology fields off a Grid2Op action and sanitise them for JSON.

    Supplements switches + heuristic (curtail / load_shedding) power
    setpoints that don't appear as public attributes on standard actions.
    """
    topo: dict[str, Any] = {}
    for field in (
        "lines_ex_bus",
        "lines_or_bus",
        "gens_bus",
        "loads_bus",
        "pst_tap",
        "substations",
        "switches",
        "loads_p",
        "gens_p",
    ):
        val = getattr(action, field, None)
        if val:
            topo[field] = sanitize_for_json(val)

    if not topo.get("switches") and dict_action:
        entry = dict_action.get(action_id)
        if entry:
            sw = entry.get("switches")
            if not sw:
                content_in_dict = entry.get("content")
                if isinstance(content_in_dict, dict):
                    sw = content_in_dict.get("switches")
            if sw:
                topo["switches"] = sanitize_for_json(sw)

    if action_id.startswith("curtail_") and not topo.get("gens_p"):
        gen_name = action_id.replace("curtail_", "")
        reg = (dict_action or {}).get(action_id, {}).get("content", {}).get("set_gen_p", {})
        topo["gens_p"] = {gen_name: reg.get(gen_name, 0.0)}
    elif action_id.startswith("load_shedding_") and not topo.get("loads_p"):
        load_name = action_id.replace("load_shedding_", "")
        reg = (dict_action or {}).get(action_id, {}).get("content", {}).get("set_load_p", {})
        topo["loads_p"] = {load_name: reg.get(load_name, 0.0)}
    return topo


def serialize_action_result(action_id: str, action_data: dict) -> dict:
    """Build the JSON-serialisable payload returned by ``simulate_manual_action``."""
    return {
        "action_id": action_id,
        "description_unitaire": action_data.get("description_unitaire") or "No description available",
        "rho_before": sanitize_for_json(action_data.get("rho_before")),
        "rho_after": sanitize_for_json(action_data.get("rho_after")),
        "max_rho": sanitize_for_json(action_data.get("max_rho")),
        "max_rho_line": action_data.get("max_rho_line", ""),
        "is_rho_reduction": bool(action_data.get("is_rho_reduction", False)),
        "is_islanded": bool(action_data.get("is_islanded", False)),
        "disconnected_mw": sanitize_for_json(action_data.get("disconnected_mw", 0.0)),
        "n_components": int(action_data.get("n_components", 1)),
        "non_convergence": action_data.get("non_convergence"),
        "lines_overloaded": sanitize_for_json(action_data.get("lines_overloaded_after", [])),
        "lines_overloaded_after": sanitize_for_json(action_data.get("lines_overloaded_after", [])),
        "is_estimated": False,
        "action_topology": action_data.get("action_topology"),
        "curtailment_details": action_data.get("curtailment_details"),
        "load_shedding_details": action_data.get("load_shedding_details"),
        "redispatch_details": action_data.get("redispatch_details"),
        "pst_details": action_data.get("pst_details"),
        "content": action_data.get("content"),
    }


def normalise_non_convergence(exception: Any) -> str | None:
    """Convert a list or scalar simulation exception into a user-facing message."""
    if not exception:
        return None
    if isinstance(exception, list):
        return "; ".join(str(e) for e in exception)
    return str(exception)


def build_combined_description(
    action_ids: list[str],
    dict_action: dict | None,
    recent_actions: dict | None,
) -> str:
    """Build a ``"[COMBINED] desc1 + desc2"`` string for multi-action IDs.

    For single IDs, returns the single description (falling back through the
    same resolution chain the caller would use).
    """
    def _get_desc(aid: str) -> str:
        entry = (dict_action or {}).get(aid)
        if entry:
            return (
                entry.get("description_unitaire")
                or entry.get("description")
                or aid
            )
        recent = (recent_actions or {}).get(aid, {})
        return (
            recent.get("description_unitaire")
            or recent.get("description")
            or aid
        )

    if len(action_ids) == 1:
        return str(_get_desc(action_ids[0]))
    return "[COMBINED] " + " + ".join(str(_get_desc(aid)) for aid in action_ids)


def compute_combined_rho(
    obs_start: Any,
    obs_act1: Any,
    obs_act2: Any,
    betas: list[float],
) -> np.ndarray:
    """Compute the superposed rho vector: (1 - Σβ)·ρ_start + β₁·ρ₁ + β₂·ρ₂.

    Absolute value — betas can be negative and the library convention is
    magnitude-only downstream.
    """
    return np.abs(
        (1.0 - sum(betas)) * obs_start.rho
        + betas[0] * obs_act1.rho
        + betas[1] * obs_act2.rho
    )


def compute_target_max_rho(
    rho_combined: np.ndarray,
    name_line_list: Any,
    lines_overloaded_ids: list[int],
) -> tuple[float, str]:
    """Pick max rho / line over the user-selected overloaded lines only.

    Rationale: the global ``max_rho`` scan across every monitored line
    has to stay broad to catch NEW overloads that the action pair may
    introduce (see ``test_superposition_max_rho_filtering_regression``
    which pins that behaviour).  But on lines far from either action,
    linearisation error can put an arbitrary high-loaded line at the
    top of the scan — a line with no relation to the contingency the
    user is resolving.  The "target" max reports the effect ON THE
    LINES THE USER CARES ABOUT — the contingency's actual overloads —
    so the UI can surface it alongside the global max and give a
    direct estimated-vs-simulated comparison on the same line set.

    Returns ``(0.0, "N/A")`` when no overload ids are available or all
    are out of range (caller should treat that as "no target info").
    """
    if not lines_overloaded_ids:
        return 0.0, "N/A"
    n_lines = len(rho_combined)
    focus_ids = [int(i) for i in lines_overloaded_ids if 0 <= int(i) < n_lines]
    if not focus_ids:
        return 0.0, "N/A"
    focus_rho = rho_combined[focus_ids]
    argmax = int(np.argmax(focus_rho))
    names = list(name_line_list)
    return float(focus_rho[argmax]), str(names[focus_ids[argmax]])
