# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0

"""SLD (Single Line Diagram) extraction helpers."""
from __future__ import annotations

import logging
import math
import re
from collections import defaultdict
from typing import Any

logger = logging.getLogger(__name__)

# A pypowsybl ``name`` field is "not a real name" when it is missing, equal to
# the element id, or still a raw OSM identifier (``way/...`` / ``relation_...``)
# the PyPSA→IIDM conversion left in place. Mirrors ``network_service`` so the
# feeder relabelling and the NAD composite-name logic agree on what counts as a
# human-readable name.
_RAW_OSM_RE = re.compile(r"^(way|relation)[/_]")


def _is_real_name(name: Any, element_id: Any) -> bool:
    """True when ``name`` is a human-readable label (not blank / id / raw OSM)."""
    if name is None:
        return False
    s = str(name).strip()
    if s == "" or s == "nan" or s == str(element_id):
        return False
    return not _RAW_OSM_RE.match(s)


def _finite_float(value: Any) -> float | None:
    """Coerce ``value`` to a finite float, or ``None`` when it is missing /
    NaN / infinite. Keeps the injection payload JSON-safe (the SLD response is
    serialised straight to the client, which cannot parse ``NaN`` / ``Infinity``).
    """
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def extract_vl_switch_states(network: Any, voltage_level_id: str) -> dict[str, bool]:
    """Return ``{switch_id: is_open}`` for every operable switch on a VL.

    Source of truth for the frontend's SLD-edit baseline: the operator
    can only toggle a switch the user-built action then sends back as
    ``{"switches": {id: bool}}`` to ``simulate_manual_action``, so the
    payload here is the contract — any switch missing from this map is
    not editable. Filters out fictitious / retained switches that
    pypowsybl exposes for internal bookkeeping (they cannot be
    manoeuvred). Returns ``{}`` rather than raising on any pypowsybl
    failure: switch editing is an additive feature, the SLD must still
    render.
    """
    try:
        df = network.get_switches(
            attributes=["open", "voltage_level_id", "kind", "fictitious", "retained"]
        )
    except Exception as e:
        logger.debug("get_switches failed for VL %s: %s", voltage_level_id, e)
        try:
            df = network.get_switches(attributes=["open", "voltage_level_id"])
        except Exception as e2:
            logger.debug("get_switches fallback also failed for VL %s: %s", voltage_level_id, e2)
            return {}

    try:
        sub = df[df["voltage_level_id"] == voltage_level_id]
    except Exception as e:
        logger.debug("Switch VL filter failed for %s: %s", voltage_level_id, e)
        return {}

    if "fictitious" in sub.columns:
        sub = sub[~sub["fictitious"].astype(bool)]

    states: dict[str, bool] = {}
    for sw_id, row in sub.iterrows():
        try:
            states[str(sw_id)] = bool(row["open"])
        except Exception:
            continue
    return states


def _collect_vl_generators(
    network: Any, voltage_level_id: str, out: dict[str, dict]
) -> None:
    """Add this VL's generators to ``out`` as editable-injection entries."""
    try:
        df = network.get_generators(
            attributes=["voltage_level_id", "target_p", "min_p", "max_p", "energy_source"]
        )
    except Exception as e:
        logger.debug("get_generators failed for VL %s: %s", voltage_level_id, e)
        try:
            df = network.get_generators()
        except Exception as e2:
            logger.debug("get_generators fallback failed for VL %s: %s", voltage_level_id, e2)
            return
    try:
        sub = df[df["voltage_level_id"] == voltage_level_id]
    except Exception as e:
        logger.debug("Generator VL filter failed for %s: %s", voltage_level_id, e)
        return
    has_source = "energy_source" in sub.columns
    has_bounds = "min_p" in sub.columns and "max_p" in sub.columns
    p_col = "target_p" if "target_p" in sub.columns else None
    for gen_id, row in sub.iterrows():
        try:
            entry: dict[str, Any] = {
                "kind": "generator",
                "p": _finite_float(row[p_col]) if p_col else None,
            }
            if has_bounds:
                entry["min_p"] = _finite_float(row["min_p"])
                entry["max_p"] = _finite_float(row["max_p"])
            if has_source and row["energy_source"] is not None:
                entry["energy_source"] = str(row["energy_source"])
            out[str(gen_id)] = entry
        except Exception:
            continue


def _collect_vl_loads(network: Any, voltage_level_id: str, out: dict[str, dict]) -> None:
    """Add this VL's loads to ``out`` as editable-injection entries."""
    try:
        df = network.get_loads(attributes=["voltage_level_id", "p0"])
    except Exception as e:
        logger.debug("get_loads failed for VL %s: %s", voltage_level_id, e)
        try:
            df = network.get_loads()
        except Exception as e2:
            logger.debug("get_loads fallback failed for VL %s: %s", voltage_level_id, e2)
            return
    try:
        sub = df[df["voltage_level_id"] == voltage_level_id]
    except Exception as e:
        logger.debug("Load VL filter failed for %s: %s", voltage_level_id, e)
        return
    p_col = "p0" if "p0" in sub.columns else None
    for load_id, row in sub.iterrows():
        try:
            out[str(load_id)] = {
                "kind": "load",
                "p": _finite_float(row[p_col]) if p_col else None,
            }
        except Exception:
            continue


def extract_vl_injections(network: Any, voltage_level_id: str) -> dict[str, dict]:
    """Return ``{equipment_id: {...}}`` for every editable injection on a VL.

    Baseline for the interactive SLD injection-edit gesture — the mirror of
    :func:`extract_vl_switch_states` for loads and generators. The operator
    can retune the active-power setpoint of any element listed here and the
    user-built action sends it back as ``{"loads_p"/"gens_p": {id: MW}}``.

    Each entry carries:
      - ``kind``: ``"generator"`` or ``"load"``.
      - ``p``: current active-power setpoint (MW) — ``target_p`` for a
        generator, ``p0`` for a load — i.e. the value the edit field seeds
        from and that ``set_gen_p`` / ``set_load_p`` overrides.
      - ``min_p`` / ``max_p`` (generators only): active-power capability
        bounds shown in the edit bubble so the operator stays within range.
      - ``energy_source`` (generators only): e.g. ``WIND`` / ``NUCLEAR``.

    Returns ``{}`` on any pypowsybl failure — injection editing is additive,
    so the SLD must still render even when this metadata is unavailable.
    """
    injections: dict[str, dict] = {}
    _collect_vl_generators(network, voltage_level_id, injections)
    _collect_vl_loads(network, voltage_level_id, injections)
    return injections


def _vl_name_map(network: Any) -> dict[str, str]:
    """Return ``{vl_id: friendly_name}`` for every voltage level with a real name.

    Best-effort: returns ``{}`` on any pypowsybl failure (feeder relabelling
    is additive and must never break SLD rendering).
    """
    try:
        vls = network.get_voltage_levels(attributes=["name"])
    except Exception as e:
        logger.debug("get_voltage_levels(name) failed: %s", e)
        try:
            vls = network.get_voltage_levels()
        except Exception as e2:
            logger.debug("get_voltage_levels fallback failed: %s", e2)
            return {}
    out: dict[str, str] = {}
    try:
        if vls is None or "name" not in getattr(vls, "columns", []):
            return out
        for vl_id, row in vls.iterrows():
            nm = row.get("name")
            if _is_real_name(nm, vl_id):
                out[str(vl_id)] = str(nm)
    except Exception as e:
        logger.debug("VL name map build failed: %s", e)
    return out


def _collect_vl_branches(network: Any, voltage_level_id: str) -> list[dict]:
    """Return ``[{eid, name, other_vl}]`` for every line / 2-winding transformer
    that has a terminal in ``voltage_level_id``.

    ``other_vl`` is the voltage-level id at the FAR end of the branch (the same
    VL for a self-loop). ``name`` is the branch's friendly name when it has one,
    else ``None``.
    """
    branches: list[dict] = []
    for getter in ("get_lines", "get_2_windings_transformers"):
        try:
            df = getattr(network, getter)(
                attributes=["name", "voltage_level1_id", "voltage_level2_id"]
            )
        except Exception as e:
            logger.debug("%s(attrs) failed: %s", getter, e)
            try:
                df = getattr(network, getter)()
            except Exception as e2:
                logger.debug("%s fallback failed: %s", getter, e2)
                continue
        try:
            cols = list(getattr(df, "columns", []))
            if "voltage_level1_id" not in cols or "voltage_level2_id" not in cols:
                continue
            mask = (df["voltage_level1_id"] == voltage_level_id) | (
                df["voltage_level2_id"] == voltage_level_id
            )
            sub = df[mask]
            has_name = "name" in cols
            for eid, row in sub.iterrows():
                vl1 = str(row["voltage_level1_id"])
                vl2 = str(row["voltage_level2_id"])
                other = vl2 if vl1 == voltage_level_id else vl1
                line_name = row.get("name") if has_name else None
                branches.append(
                    {
                        "eid": str(eid),
                        "name": str(line_name) if _is_real_name(line_name, eid) else None,
                        "other_vl": other,
                    }
                )
        except Exception as e:
            logger.debug("branch collection failed for %s: %s", getter, e)
            continue
    return branches


def build_feeder_labels(network: Any, voltage_level_id: str) -> dict[str, dict]:
    """Return ``{equipment_id: {name, other_vl, label}}`` for the branch feeders
    of ``voltage_level_id``.

    ``label`` is the **name of the voltage level at the OTHER end** of the
    branch — far more interpretable than the raw IIDM branch id pypowsybl draws
    by default (e.g. ``relation_8423569-225``). When several branches of this VL
    terminate at the SAME far-end VL (parallel circuits) the label is
    disambiguated with a 1-based index (``"MARSILLON 225kV 1"`` / ``" 2"``).

    Resolution / fall-backs for ``label``:
      1. far-end VL friendly name (+ parallel index when needed);
      2. the branch's own friendly name (already unique → no index) when the
         far-end VL has no human-readable name;
      3. ``None`` — the frontend then keeps pypowsybl's default id label.

    ``name`` carries the branch's friendly name (the grid2op / operator name
    such as ``MARSIL61PRAGN``) so the frontend can map an overloaded line —
    reported by friendly name — back to the IIDM-id-keyed SLD cell and draw its
    overload halo.

    Returns ``{}`` on any pypowsybl failure: relabelling is additive, the SLD
    must still render.
    """
    if not voltage_level_id:
        return {}
    vl_names = _vl_name_map(network)
    branches = _collect_vl_branches(network, voltage_level_id)

    by_other: dict[str, list[dict]] = defaultdict(list)
    for b in branches:
        by_other[b["other_vl"]].append(b)

    result: dict[str, dict] = {}
    for other_vl, members in by_other.items():
        members.sort(key=lambda b: b["eid"])
        multiple = len(members) > 1
        other_name = vl_names.get(other_vl)
        for idx, b in enumerate(members, start=1):
            if other_name:
                label = f"{other_name} {idx}" if multiple else other_name
            elif b["name"]:
                # Far-end VL is unnamed — fall back to the branch's own name.
                # Parallel branches already carry distinct names, so no index.
                label = b["name"]
            else:
                label = None
            result[b["eid"]] = {
                "name": b["name"],
                "other_vl": other_vl or None,
                "label": label,
            }
    return result


def extract_sld_svg_and_metadata(sld: Any) -> tuple:
    """Extract ``(svg, metadata)`` from a pypowsybl SLD diagram object.

    The metadata JSON contains ``feederNodes`` with ``{id, equipmentId}``
    entries that map SVG element IDs back to network equipment IDs.
    Falls back to ``sld._repr_svg_()`` / ``sld._metadata`` when the
    primary extraction raises.
    """
    try:
        from pypowsybl_jupyter.util import _get_svg_metadata, _get_svg_string
        svg = _get_svg_string(sld)
        metadata = _get_svg_metadata(sld)
    except Exception as e:
        logger.debug("Primary SLD extraction failed, trying fallback: %s", e)
        try:
            svg = sld._repr_svg_()
        except Exception as e:
            logger.debug("SVG extraction fallback: %s", e)
            svg = str(sld)
        metadata = getattr(sld, "_metadata", None)
    return svg, metadata
