# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0
# This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

"""Simulation mixin for RecommenderService.

Contains manual action simulation, superposition computation,
and action dictionary management methods.
"""

import logging
import time

import numpy as np

from expert_op4grid_recommender import config
from expert_op4grid_recommender.action_evaluation.classifier import ActionClassifier
from expert_op4grid_recommender.utils.superposition import (
    compute_combined_pair_superposition,
    _identify_action_elements,
)

from typing import TYPE_CHECKING

from expert_backend.services.sanitize import sanitize_for_json
from expert_backend.services.simulation_helpers import (
    build_combined_description,
    build_manual_action_description,
    canonicalize_action_id,
    classify_action_content,
    clamp_tap,
    compute_action_metrics,
    compute_combined_rho,
    compute_reduction_setpoint,
    compute_redispatch_setpoint,
    compute_target_max_rho,
    extract_action_topology,
    half_open_overload_notes,
    is_injection_action,
    is_pst_action,
    is_switch_only_content,
    normalise_non_convergence,
    parse_pst_tap_id,
    pst_fallback_line_idxs,
    resolve_lines_overloaded,
    serialize_action_result,
)

logger = logging.getLogger(__name__)


if TYPE_CHECKING:
    from expert_backend.services._recommender_state import RecommenderState

    _Base = RecommenderState
else:
    _Base = object


class SimulationMixin(_Base):
    """Mixin providing action simulation and superposition methods."""

    def get_all_action_ids(self):
        """Return a list of {id, description, type} for every action in the loaded dictionary."""
        if not self._dict_action:
            raise ValueError("No action dictionary loaded. Load a config first.")
        
        from expert_op4grid_recommender.action_evaluation.classifier import ActionClassifier
        classifier = ActionClassifier()
        
        result = []
        for action_id, action_desc in self._dict_action.items():
            result.append({
                "id": action_id,
                "description": action_desc.get("description_unitaire",
                                               action_desc.get("description", "")),
                "type": classifier.identify_action_type(action_desc)
            })
        return result

    @staticmethod
    def _canonicalize_id(action_id: str) -> str:
        return canonicalize_action_id(action_id)

    @staticmethod
    def _build_action_entry_from_topology(action_id, topo):
        """Build an action dict entry from saved topology fields.

        Converts action_topology (lines_ex_bus, lines_or_bus, gens_bus,
        loads_bus, substations) back into a content dict that
        env.action_space(content) can parse.
        """
        entry = {"description_unitaire": f"Restored action: {action_id}"}
        content = {}

        # Build set_bus from element-level topology (dict format, matching raw action files)
        set_bus = {}
        topo_to_content = {
            "lines_ex_bus": "lines_ex_id",
            "lines_or_bus": "lines_or_id",
            "gens_bus": "generators_id",
            "loads_bus": "loads_id",
        }
        for topo_field, content_field in topo_to_content.items():
            vals = topo.get(topo_field)
            if vals and isinstance(vals, dict):
                set_bus[content_field] = {name: int(bus) for name, bus in vals.items()}

        # Include substations (critical for node_merging_* actions)
        subs = topo.get("substations") or {}
        if subs:
            set_bus["substations_id"] = [
                (int(sub_id), [int(b) for b in bus_array])
                for sub_id, bus_array in subs.items()
            ]

        if set_bus:
            content["set_bus"] = set_bus

        # Include switches if present
        switches = topo.get("switches") or {}
        if switches:
            content["switches"] = switches

        # Include PST tap if present
        pst_tap = topo.get("pst_tap") or {}
        if pst_tap:
            content["pst_tap"] = pst_tap

        # Power reduction actions: set_load_p / set_gen_p (new format)
        loads_p = topo.get("loads_p") or {}
        if loads_p and isinstance(loads_p, dict):
            content["set_load_p"] = {name: float(p) for name, p in loads_p.items()}

        gens_p = topo.get("gens_p") or {}
        if gens_p and isinstance(gens_p, dict):
            content["set_gen_p"] = {name: float(p) for name, p in gens_p.items()}

        entry["content"] = content if content else {}
        return entry

    def simulate_manual_action(
        self,
        raw_action_id: str,
        disconnected_elements,
        action_content=None,
        lines_overloaded=None,
        target_mw=None,
        target_tap=None,
        voltage_level_id=None,
    ):
        """Simulate a single or combined action and return its impact.

        Orchestrator — delegates each phase to a private helper so the
        flow stays readable. See module docstring + `simulation_helpers`
        for per-step detail.

        raw_action_id may combine multiple IDs with `+` (e.g. "act1+act2").
        action_content is an optional topology dict (or per-action map)
        for actions not in the dictionary — used by session reload.
        target_mw / target_tap reduce a load shedding / curtailment /
        PST action to a specific setpoint instead of full reduction.
        """
        if not self._dict_action:
            raise ValueError("No action dictionary loaded. Load a config first.")

        norm_contingency = self._normalize_contingency_elements(disconnected_elements)
        # Variant-state guard — drains the NAD prefetch and pins the
        # working variant on the contingency variant before reading obs.
        # See docs/performance/history/grid2op-shared-network.md.
        self._ensure_contingency_state_ready(norm_contingency)

        action_id = self._canonicalize_id(raw_action_id.strip())
        if lines_overloaded is None:
            lines_overloaded = []
        action_ids = action_id.split("+")
        recent_actions = (
            self._last_result.get("prioritized_actions", {}) if self._last_result else {}
        )

        self._inject_action_content_entries(
            action_ids, action_content, recent_actions, voltage_level_id=voltage_level_id
        )

        env = self._get_simulation_env()
        nm = env.network_manager
        n = nm.network
        original_variant = n.get_working_variant_id()

        # Prefer the (obs, obs_simu_defaut) pair captured by step1 and
        # stored on ``_analysis_context``. The grid2op ↔ pypowsybl env
        # bridge does not re-sync ``env.get_obs()`` to
        # ``n.set_working_variant(...)``, so a fresh fetch here can
        # return an N-state observation even after pinning the N-1
        # variant — the downstream ``obs.simulate(..., keep_variant=True)``
        # would then run against the wrong baseline and the backend's
        # max_rho drifts from the library's own simulation. Reusing the
        # step1 obs keeps this path numerically aligned with step2 and
        # with ``compute_superposition`` (which uses the same pattern
        # via ``_obs_n1_from_context``).
        ctx = self._analysis_context or {}
        ctx_obs_n1 = self._obs_n1_from_context()
        ctx_obs_n = ctx.get("obs")
        used_context_obs = ctx_obs_n1 is not None and ctx_obs_n is not None
        if used_context_obs:
            obs, obs_simu_defaut = ctx_obs_n, ctx_obs_n1
            # NOTE: do NOT overwrite ``obs_simu_defaut._variant_id``. The
            # library stamped it at step1 with its own kept variant id,
            # and ``pypowsybl_backend.observation.simulate`` clones from
            # ``self._variant_id`` at simulate time — rewriting it to a
            # backend-scoped variant that doesn't exist in the library's
            # ``NetworkManager`` would raise ``Variant ... not found``.
        else:
            # Fallback: no step1 context (direct simulate without prior
            # step1, or session reload — ``restore_analysis_context``
            # doesn't serialize obs objects). The stale-obs desync still
            # applies on this path; tracked as a follow-up.
            obs, obs_simu_defaut = self._fetch_n_and_contingency_observations(env, n, norm_contingency)
        obs_n1 = obs_simu_defaut

        self._create_dynamic_actions_if_needed(
            action_ids, recent_actions, obs_n1, nm, target_mw
        )

        for aid in action_ids:
            if aid not in self._dict_action and aid not in recent_actions:
                raise ValueError(
                    f"Action '{aid}' not found in the loaded action dictionary or recent analysis."
                )

        self._last_disconnected_elements = list(norm_contingency)

        lines_we_care_about, branches_with_limits = self._get_monitoring_parameters(obs_simu_defaut)
        monitoring_factor = getattr(config, "MONITORING_FACTOR_THERMAL_LIMITS", 0.95)
        worsening_threshold = getattr(config, "PRE_EXISTING_OVERLOAD_WORSENING_THRESHOLD", 0.02)

        # Step1 stores the resolved friendly names under
        # ``lines_overloaded_names``; session reload writes them
        # under ``lines_overloaded`` (see
        # ``RecommenderService.restore_analysis_context``). Check both
        # so manual simulations triggered after step1 reuse the same
        # pypowsybl-style identifiers the rest of the UI is wired
        # against — the previous single-key read silently fell through
        # to the vectorised obs-based path and re-emitted grid2op's
        # synthetic ``line_<i>`` names, which the frontend's
        # ``displayName`` resolver has no mapping for. Same lookup
        # order as ``compute_superposition`` (see ``simulation_mixin``
        # bottom-half). ``ctx`` is the same dict captured earlier in
        # the function for ``ctx_obs_n1`` / ``ctx_obs_n``.
        ctx_overloaded = ctx.get("lines_overloaded_names") or ctx.get("lines_overloaded")
        lines_overloaded_ids, lines_overloaded_names = resolve_lines_overloaded(
            obs_simu_defaut,
            obs,
            ctx_overloaded,
            lines_overloaded,
            lines_we_care_about,
            branches_with_limits,
            monitoring_factor,
            worsening_threshold,
        )

        self._promote_recent_actions_to_dict(action_ids, recent_actions)
        self._apply_target_mw_updates(action_ids, target_mw, obs_n1)
        self._apply_target_tap_updates(action_ids, target_tap, nm)

        action = self._build_combined_action_object(action_ids, env, recent_actions)

        # Re-pin the working variant to the backend's N-1 only on the
        # fallback path. `_fetch_n_and_n1_observations` can return a
        # cached obs whose associated working variant has drifted (its
        # cache-hit branches don't touch the variant), so an
        # ``obs.simulate(..., keep_variant=True)`` on that obs can run
        # against the wrong variant. The context path is already safe:
        # the library stamped ``obs_simu_defaut._variant_id`` to its own
        # kept N-1 variant, which ``pypowsybl_backend.observation.simulate``
        # clones from directly (independent of the working variant).
        if not used_context_obs:
            n.set_working_variant(self._get_contingency_variant(norm_contingency))

        actual_fast_mode = getattr(config, "PYPOWSYBL_FAST_MODE", False)
        obs_simu_action, _, _, info_action = obs_simu_defaut.simulate(
            action,
            time_step=0,
            keep_variant=True,
            fast_mode=actual_fast_mode,
        )
        n.set_working_variant(original_variant)

        # Tracker kept for future perf instrumentation — cheap to keep.
        _ = time.perf_counter()

        description_unitaire = build_combined_description(
            action_ids, self._dict_action, recent_actions
        )

        metrics = compute_action_metrics(
            obs,
            obs_simu_defaut,
            obs_simu_action,
            info_action,
            lines_overloaded_ids,
            lines_we_care_about,
            branches_with_limits,
            monitoring_factor,
            worsening_threshold,
        )
        non_convergence = normalise_non_convergence(info_action.get("exception"))

        # When the action leaves a still-"overloaded" line open at ONE end, its
        # loading is real but is pure capacitive CHARGING current (the line is
        # energised from the live end only) — the SLD / NAD show p = 0 while the
        # card shows e.g. 33 %. Capture the live-end reactive power for any such
        # line whose loading stays above ~1 % so the UI can annotate the value
        # instead of it reading as a residual overload.
        half_open_overloads = half_open_overload_notes(
            obs_simu_action, lines_overloaded_names, metrics.get("rho_after") or []
        )

        topo = extract_action_topology(action, action_id, self._dict_action)
        description, content = self._resolve_action_description_and_content(
            action_id, description_unitaire, topo
        )

        action_data = {
            "content": content,
            "observation": obs_simu_action,
            "description": description or description_unitaire or "",
            "description_unitaire": description_unitaire or "",
            "action": action,
            "action_topology": topo,
            "rho_before": metrics["rho_before"],
            "rho_after": metrics["rho_after"],
            "max_rho": metrics["max_rho"],
            "max_rho_line": metrics["max_rho_line"],
            "is_rho_reduction": metrics["is_rho_reduction"],
            "is_islanded": metrics["is_islanded"],
            "disconnected_mw": metrics["disconnected_mw"],
            "n_components": metrics["n_components_after"],
            "non_convergence": non_convergence,
            "lines_overloaded_after": sanitize_for_json(metrics["lines_overloaded_after"]),
            "half_open_overloads": sanitize_for_json(half_open_overloads),
            "is_estimated": False,
        }

        action_data["curtailment_details"] = self._compute_curtailment_details(
            action_data, obs_n1=obs_n1
        )
        action_data["load_shedding_details"] = self._compute_load_shedding_details(
            action_data, obs_n1=obs_n1
        )
        if action_id.startswith("redispatch_"):
            action_data["redispatch_details"] = self._compute_redispatch_details(
                action_data, obs_n1=obs_n1
            )
        action_data["pst_details"] = self._compute_pst_details(action_data)

        self._register_action_result(action_id, action_data, info_action, obs_simu_action)

        return serialize_action_result(action_id, action_data)

    # ------------------------------------------------------------------
    # Private helpers — each owns one phase of simulate_manual_action.
    # Keeping them on the class (not the helpers module) because they
    # read/mutate self state (caches, `_dict_action`, `_last_result`).
    # ------------------------------------------------------------------

    def _inject_action_content_entries(
        self, action_ids, action_content, recent_actions, voltage_level_id=None
    ) -> None:
        """Inject caller-provided topology dicts into `_dict_action`.

        Used on session reload AND on user-built SLD topology edits:
        actions whose ID was minted at the call site (e.g.
        ``user_topo_<vl>_<ts>``) aren't in the action dictionary, and
        their content has to be available before
        ``env.action_space(content)`` is called.

        When the action is a user-built SLD edit (a ``user_topo_*`` id) or a
        switch-only content, the placeholder ``Restored action`` description
        is replaced with a human-readable one so the resulting card in the
        frontend feed reads "Manoeuvre manuelle sur <vl>: …" instead of the
        synthetic id. The description covers both breaker / disconnector
        toggles AND load / generator active-power retunes staged from the
        same diagram (see ``build_manual_action_description``).
        """
        if not action_content:
            return
        per_action = classify_action_content(action_content, action_ids)
        for aid in action_ids:
            if aid in self._dict_action or aid in recent_actions:
                continue
            topo = per_action.get(aid)
            if not topo:
                continue
            entry = self._build_action_entry_from_topology(aid, topo)
            content = entry.get("content") or {}
            if aid.startswith("user_topo_") or is_switch_only_content(content):
                desc = build_manual_action_description(
                    content, voltage_level_id=voltage_level_id
                )
                entry["description_unitaire"] = desc
                entry["description"] = desc
            self._dict_action[aid] = entry
            logger.info(
                "[simulate_manual_action] Injected restored action '%s' into dict", aid
            )

    def _fetch_n_and_contingency_observations(self, env, n, disconnected_elements) -> tuple:
        """Return ``(obs_n, obs_contingency)`` for the current simulation.

        Maintains the CALL ORDER (N first, then contingency) that legacy
        tests assert on ``env.get_obs.call_count == 2``. Also tags
        ``obs_contingency._variant_id`` explicitly so downstream diagram
        code knows which state to compare against.
        """
        # Call 1: N state
        n_variant_id = self._get_n_variant()
        if self._cached_obs_n is not None and self._cached_obs_n_id == n_variant_id:
            obs = self._cached_obs_n
        else:
            n.set_working_variant(n_variant_id)
            obs = env.get_obs()
            self._cached_obs_n = obs
            self._cached_obs_n_id = n_variant_id

        # Call 2: contingency state (N-1, N-2, ..., N-K)
        cont_variant_id = self._get_contingency_variant(disconnected_elements)
        if self._cached_obs_n1 is not None and self._cached_obs_n1_id == cont_variant_id:
            obs_simu_defaut = self._cached_obs_n1
        else:
            n.set_working_variant(cont_variant_id)
            obs_simu_defaut = env.get_obs()
            self._cached_obs_n1 = obs_simu_defaut
            self._cached_obs_n1_id = cont_variant_id

        # Explicitly tag the variant so the action-variant diagram code
        # knows what to compare against downstream.
        obs_simu_defaut._variant_id = cont_variant_id
        return obs, obs_simu_defaut

    def _create_dynamic_actions_if_needed(
        self, action_ids, recent_actions, obs_n1, nm, target_mw
    ) -> None:
        """Auto-create heuristic actions for redispatch_ / curtail_ / load_shedding_ / pst_tap_ / reco_ prefixes."""
        for aid in action_ids:
            if aid in self._dict_action or aid in recent_actions:
                continue
            if aid.startswith("redispatch_"):
                self._create_dynamic_redispatch(aid, target_mw, obs_n1)
            elif aid.startswith("curtail_"):
                self._create_dynamic_curtailment(aid, target_mw, obs_n1)
            elif aid.startswith("load_shedding_"):
                self._create_dynamic_load_shedding(aid, target_mw, obs_n1)
            elif aid.startswith("pst_tap_") or aid.startswith("pst_"):
                self._create_dynamic_pst(aid, nm)
            elif aid.startswith("reco_"):
                self._create_dynamic_reconnection(aid)

    def _create_dynamic_redispatch(self, aid, target_mw, obs_n1) -> None:
        gen_name = aid[len("redispatch_"):]
        default_delta = getattr(config, "REDISPATCH_DEFAULT_DELTA_MW", 10.0)
        # For redispatch, ``target_mw`` is the SIGNED delta (raise > 0 / lower
        # < 0); the resulting absolute setpoint is current production + delta.
        setpoint = compute_redispatch_setpoint(gen_name, target_mw, obs_n1, default_delta)
        topo = {"gens_p": {gen_name: setpoint}}
        entry = self._build_action_entry_from_topology(aid, topo)

        vl_id = None
        try:
            from expert_backend.services.network_service import network_service as ns
            vl_id = ns.get_generator_voltage_level(gen_name)
        except Exception as e:
            logger.debug("Suppressed exception: %s", e)
        delta = float(target_mw) if target_mw is not None else float(default_delta)
        verb = "hausse" if delta >= 0 else "baisse"
        if vl_id:
            entry["description"] = (
                f"Redispatch on generator '{gen_name}' at voltage level '{vl_id}'"
            )
            entry["description_unitaire"] = f"Redispatch {verb} '{gen_name}' ('{vl_id}')"
        else:
            entry["description"] = f"Redispatch on generator '{gen_name}'"
            entry["description_unitaire"] = f"Redispatch {verb} '{gen_name}'"

        self._dict_action[aid] = entry
        logger.info(
            "[simulate_manual_action] Created dynamic redispatch action '%s' (setpoint=%s MW)",
            aid, setpoint,
        )

    def _create_dynamic_curtailment(self, aid, target_mw, obs_n1) -> None:
        gen_name = aid[len("curtail_"):]
        setpoint = compute_reduction_setpoint(gen_name, "gen", target_mw, obs_n1)
        topo = {"gens_p": {gen_name: setpoint}}
        entry = self._build_action_entry_from_topology(aid, topo)

        vl_id = None
        try:
            from expert_backend.services.network_service import network_service as ns
            vl_id = ns.get_generator_voltage_level(gen_name)
        except Exception as e:
            logger.debug("Suppressed exception: %s", e)
        if vl_id:
            entry["description"] = (
                f"Renewable curtailment on generator '{gen_name}' at voltage level '{vl_id}'"
            )
            entry["description_unitaire"] = f"Effacement '{gen_name}' ('{vl_id}')"
        else:
            entry["description"] = f"Renewable curtailment on generator '{gen_name}'"
            entry["description_unitaire"] = f"Effacement '{gen_name}'"

        self._dict_action[aid] = entry
        logger.info(
            "[simulate_manual_action] Created dynamic curtailment action '%s' (setpoint=%s MW)",
            aid, setpoint,
        )

    def _create_dynamic_load_shedding(self, aid, target_mw, obs_n1) -> None:
        load_name = aid[len("load_shedding_"):]
        setpoint = compute_reduction_setpoint(load_name, "load", target_mw, obs_n1)
        topo = {"loads_p": {load_name: setpoint}}
        entry = self._build_action_entry_from_topology(aid, topo)

        vl_id = None
        try:
            from expert_backend.services.network_service import network_service as ns
            vl_id = ns.get_load_voltage_level(load_name)
        except Exception as e:
            logger.debug("Suppressed exception: %s", e)
        if vl_id:
            entry["description"] = f"Load shedding on '{load_name}' at voltage level '{vl_id}'"
            entry["description_unitaire"] = f"Effacement '{load_name}' ('{vl_id}')"
        else:
            entry["description"] = f"Load shedding on '{load_name}'"
            entry["description_unitaire"] = f"Effacement '{load_name}'"

        self._dict_action[aid] = entry
        logger.info(
            "[simulate_manual_action] Created dynamic load shedding action '%s' (setpoint=%s MW)",
            aid, setpoint,
        )

    def _create_dynamic_pst(self, aid, nm) -> None:
        parsed = parse_pst_tap_id(aid)
        if not parsed:
            return
        pst_id, variation = parsed
        pst_info = nm.get_pst_tap_info(pst_id)
        if not pst_info:
            return

        current_tap = pst_info["tap"]
        new_tap = clamp_tap(current_tap + variation, pst_info)
        topo = {"pst_tap": {pst_id: new_tap}}
        entry = self._build_action_entry_from_topology(aid, topo)
        entry["description"] = f"PST tap change for {pst_id} (tap: {current_tap} -> {new_tap})"
        entry["description_unitaire"] = f"Variation PST {pst_id}"
        self._dict_action[aid] = entry
        logger.info("[simulate_manual_action] Created dynamic PST action '%s'", aid)

    def _create_dynamic_reconnection(self, aid) -> None:
        line_name = aid[len("reco_"):]
        # Reconnect both ends of the line to bus 1.
        topo = {
            "lines_or_bus": {line_name: 1},
            "lines_ex_bus": {line_name: 1},
        }
        entry = self._build_action_entry_from_topology(aid, topo)
        entry["description"] = f"Line reconnection: '{line_name}'"
        entry["description_unitaire"] = f"Reconnexion '{line_name}'"
        self._dict_action[aid] = entry
        logger.info("[simulate_manual_action] Created dynamic reconnection action '%s'", aid)

    def _promote_recent_actions_to_dict(self, action_ids, recent_actions) -> None:
        """Promote heuristic actions found on `_last_result.prioritized_actions`
        into `_dict_action` so that target_mw updates can mutate their content.
        """
        for aid in action_ids:
            if aid in self._dict_action or aid not in recent_actions:
                continue
            a_obj = recent_actions[aid]["action"]
            topo = {}
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
                val = getattr(a_obj, field, None)
                if val:
                    topo[field] = val  # _build_action_entry_from_topology sanitises
            entry = self._build_action_entry_from_topology(aid, topo)
            if recent_actions[aid].get("description_unitaire"):
                entry["description_unitaire"] = recent_actions[aid]["description_unitaire"]
            if recent_actions[aid].get("description"):
                entry["description"] = recent_actions[aid]["description"]
            self._dict_action[aid] = entry
            logger.info(
                "[simulate_manual_action] Promoted heuristic action '%s' to registry for target_mw update",
                aid,
            )

    def _apply_target_mw_updates(self, action_ids, target_mw, obs_n1) -> None:
        if target_mw is None:
            return
        for aid in action_ids:
            entry = self._dict_action.get(aid)
            if not entry:
                continue
            content = entry.get("content", {})
            is_redispatch = aid.startswith("redispatch_")
            if "set_load_p" in content:
                for load_name in content["set_load_p"]:
                    sp = compute_reduction_setpoint(load_name, "load", target_mw, obs_n1)
                    content["set_load_p"][load_name] = sp
                    logger.info(
                        "[simulate_manual_action] Updated set_load_p[%s] = %s MW",
                        load_name, sp,
                    )
            if "set_gen_p" in content:
                for gen_name in content["set_gen_p"]:
                    if is_redispatch:
                        # target_mw is the signed delta; setpoint = current + delta.
                        default_delta = getattr(config, "REDISPATCH_DEFAULT_DELTA_MW", 10.0)
                        sp = compute_redispatch_setpoint(gen_name, target_mw, obs_n1, default_delta)
                    else:
                        sp = compute_reduction_setpoint(gen_name, "gen", target_mw, obs_n1)
                    content["set_gen_p"][gen_name] = sp
                    logger.info(
                        "[simulate_manual_action] Updated set_gen_p[%s] = %s MW",
                        gen_name, sp,
                    )

    def _apply_target_tap_updates(self, action_ids, target_tap, nm) -> None:
        if target_tap is None:
            return
        for aid in action_ids:
            entry = self._dict_action.get(aid)
            if not entry:
                continue
            content = entry.get("content", {})
            if "pst_tap" not in content:
                continue
            for pst_id in content["pst_tap"]:
                pst_info = nm.get_pst_tap_info(pst_id)
                clamped = clamp_tap(target_tap, pst_info)
                content["pst_tap"][pst_id] = clamped
                if pst_info:
                    logger.info(
                        "[simulate_manual_action] Updated pst_tap[%s] = %s",
                        pst_id, clamped,
                    )
                else:
                    logger.info(
                        "[simulate_manual_action] Updated pst_tap[%s] = %s (no bounds info)",
                        pst_id, target_tap,
                    )

    def _build_combined_action_object(self, action_ids, env, recent_actions):
        """Concatenate Grid2Op action objects for each ID into one combined action."""
        try:
            action = None
            for aid in action_ids:
                if aid in self._dict_action:
                    a_obj = env.action_space(self._dict_action[aid]["content"])
                else:
                    a_obj = recent_actions[aid]["action"]
                action = a_obj if action is None else action + a_obj
            return action
        except Exception as e:
            raise ValueError(f"Could not create action from description: {e}")

    def _resolve_action_description_and_content(self, action_id, description_unitaire, topo) -> tuple:
        """Pull description + content from `_dict_action`, reconstructing from
        topology as a fallback. Guarantees `content` is never None — the
        library's rule validator crashes on `content.get("set_bus", {})`.
        """
        description = description_unitaire
        content = None
        if self._dict_action:
            entry = self._dict_action.get(action_id)
            if entry:
                if "description" in entry:
                    description = entry["description"]
                if "content" in entry:
                    content = entry["content"]

        if content is None and topo:
            try:
                restored = self._build_action_entry_from_topology(action_id, topo)
                content = restored.get("content")
            except Exception as e:
                logger.debug("Suppressed exception: %s", e)

        if content is None:
            content = {}
        return description, content

    def _register_action_result(self, action_id, action_data, info_action, obs_simu_action) -> None:
        """Persist the simulated action to `_last_result` and merge into `_dict_action`.

        Uses merge (not replace) on `_dict_action` so the library's
        `_identify_action_elements` can still find the original structure.
        """
        if not info_action.get("exception") and obs_simu_action is not None:
            if self._last_result is None:
                self._last_result = {"prioritized_actions": {}}
            if "prioritized_actions" not in self._last_result:
                self._last_result["prioritized_actions"] = {}
            self._last_result["prioritized_actions"][action_id] = action_data

        if self._dict_action is None:
            self._dict_action = {}
        if action_id in self._dict_action:
            existing = self._dict_action[action_id]
            logger.info(
                "[simulate_manual_action] Merging into existing _dict_action['%s']", action_id
            )
            existing["observation"] = action_data.get("observation")
            existing["action"] = action_data.get("action")
            existing["action_topology"] = action_data.get("action_topology")
            # Always update content — even empty {} is valid and must replace
            # a stale None to prevent content.get() crashes.
            if action_data.get("content") is not None:
                existing["content"] = action_data["content"]
        else:
            logger.info(
                "[simulate_manual_action] NEW _dict_action['%s'] (no existing entry)", action_id
            )
            self._dict_action[action_id] = action_data


    def compute_superposition(self, action1_id: str, action2_id: str, disconnected_elements):
        """Compute the combined effect of two actions via the superposition theorem.

        Orchestrator — delegates to private helpers so the flow stays
        readable. Used when a pair was NOT part of the initial analysis
        (e.g. two manually-simulated actions). Always re-runs
        simulations for any missing action before computing betas.
        """
        norm_contingency = self._normalize_contingency_elements(disconnected_elements)
        # Same contingency variant guard as simulate_manual_action.
        self._ensure_contingency_state_ready(norm_contingency)

        all_actions = self._ensure_pair_simulated(action1_id, action2_id, norm_contingency)

        env = self._get_simulation_env()
        classifier = ActionClassifier()

        self._log_dict_action_snapshot(action1_id, action2_id, all_actions)

        line_idxs1, sub_idxs1 = self._identify_elements_with_pst_fallback(
            action1_id, all_actions, classifier, env
        )
        line_idxs2, sub_idxs2 = self._identify_elements_with_pst_fallback(
            action2_id, all_actions, classifier, env
        )
        # Injection actions (load shedding / curtailment / redispatch) carry no
        # topology element — they are combined via the Generalized Superposition
        # Theorem. Only topology actions must resolve to a switched element.
        act1_is_injection = is_injection_action(action1_id, self._dict_action, classifier)
        act2_is_injection = is_injection_action(action2_id, self._dict_action, classifier)
        if (not act1_is_injection and not line_idxs1 and not sub_idxs1) or \
           (not act2_is_injection and not line_idxs2 and not sub_idxs2):
            return {
                "error": (
                    f"Cannot identify elements for one or both actions "
                    f"(Act1: {len(line_idxs1)} lines, {len(sub_idxs1)} subs; "
                    f"Act2: {len(line_idxs2)} lines, {len(sub_idxs2)} subs)"
                )
            }

        n = env.network_manager.network
        original_variant = n.get_working_variant_id()

        # Fetch N-1 and N observations (order matters for test mocks).
        # Prefer the N-1 observation captured at step1 when available —
        # grid2op's ``obs.simulate(action, keep_variant=True)`` used by
        # ``simulate_manual_action`` can mutate the shared N-1 variant,
        # so a fresh ``env.get_obs()`` here would drift away from the
        # baseline step2 used to pre-compute ``combined_actions`` betas.
        # Reusing the context obs keeps the on-demand re-estimation
        # numerically consistent with the "Computed Pairs" view.
        ctx_obs_n1 = self._obs_n1_from_context()
        if ctx_obs_n1 is not None:
            obs_start = ctx_obs_n1
        else:
            n.set_working_variant(self._get_contingency_variant(norm_contingency))
            obs_start = env.get_obs()
        self._log_per_line_rho(action1_id, action2_id, line_idxs1, line_idxs2, obs_start, env, all_actions)

        monitoring_factor = getattr(config, "MONITORING_FACTOR_THERMAL_LIMITS", 0.95)
        worsening_threshold = getattr(config, "PRE_EXISTING_OVERLOAD_WORSENING_THRESHOLD", 0.02)
        name_line_list = list(env.name_line)
        name_to_idx_map = {l: i for i, l in enumerate(name_line_list)}
        num_lines = len(name_line_list)

        n.set_working_variant(self._get_n_variant())
        obs_n = env.get_obs()
        # obs.rho is already pre-scaled by monitoring_factor (grid2op
        # divides current by ``limit * mf``), so the overload threshold
        # on obs.rho is 1.0 — not mf. Using mf here would double-apply
        # the factor and treat lines at ~90 % of the permanent limit as
        # "already overloaded". See simulation_helpers.build_care_mask.
        pre_existing_rho = {
            i: obs_n.rho[i]
            for i in range(len(obs_n.rho))
            if obs_n.rho[i] >= 1.0
        }

        lines_we_care_about, branches_with_limits = self._get_monitoring_parameters(obs_start)
        lines_overloaded_ids = self._superposition_lines_overloaded(
            obs_start,
            name_line_list,
            name_to_idx_map,
            pre_existing_rho,
            lines_we_care_about,
            branches_with_limits,
            monitoring_factor,
            worsening_threshold,
        )

        act1_is_pst = is_pst_action(action1_id, self._dict_action, classifier)
        act2_is_pst = is_pst_action(action2_id, self._dict_action, classifier)

        logger.info("[compute_superposition] Calling compute_combined_pair_superposition with:")
        logger.info(
            "  act1_line_idxs=%s, act1_sub_idxs=%s, act1_is_pst=%s, act1_is_injection=%s",
            line_idxs1, sub_idxs1, act1_is_pst, act1_is_injection,
        )
        logger.info(
            "  act2_line_idxs=%s, act2_sub_idxs=%s, act2_is_pst=%s, act2_is_injection=%s",
            line_idxs2, sub_idxs2, act2_is_pst, act2_is_injection,
        )
        combined_id = f"{action1_id}+{action2_id}"
        result = compute_combined_pair_superposition(
            obs_start=obs_start,
            obs_act1=all_actions[action1_id]["observation"],
            obs_act2=all_actions[action2_id]["observation"],
            act1_line_idxs=line_idxs1,
            act1_sub_idxs=sub_idxs1,
            act2_line_idxs=line_idxs2,
            act2_sub_idxs=sub_idxs2,
            obs_combined=all_actions.get(combined_id, {}).get("observation"),
            act1_is_pst=act1_is_pst,
            act2_is_pst=act2_is_pst,
            act1_is_injection=act1_is_injection,
            act2_is_injection=act2_is_injection,
        )

        if "error" not in result:
            self._augment_superposition_result(
                result,
                obs_start,
                obs_n,
                all_actions,
                action1_id,
                action2_id,
                name_line_list,
                lines_we_care_about,
                branches_with_limits,
                lines_overloaded_ids,
                monitoring_factor,
                worsening_threshold,
                num_lines,
            )

        n.set_working_variant(original_variant)
        return sanitize_for_json(result)

    # ------------------------------------------------------------------
    # Private helpers for compute_superposition
    # ------------------------------------------------------------------

    def _ensure_pair_simulated(self, action1_id, action2_id, disconnected_elements):
        """Re-run ``simulate_manual_action`` for any pair member missing from
        ``_last_result.prioritized_actions``. Returns the up-to-date
        ``prioritized_actions`` dict.
        """
        all_actions = (
            self._last_result.get("prioritized_actions", {}) if self._last_result else {}
        )
        if action1_id not in all_actions:
            self.simulate_manual_action(action1_id, disconnected_elements)
            all_actions = self._last_result["prioritized_actions"]
        if action2_id not in all_actions:
            self.simulate_manual_action(action2_id, disconnected_elements)
            all_actions = self._last_result["prioritized_actions"]
        return all_actions

    def _identify_elements_with_pst_fallback(self, action_id, all_actions, classifier, env) -> tuple:
        """Run `_identify_action_elements` with a PST-content-based fallback
        when it returns empty (PST tap changes don't appear as topology
        switches).
        """
        act_obj = all_actions[action_id]["action"]
        line_idxs, sub_idxs = _identify_action_elements(
            act_obj, action_id, self._dict_action, classifier, env
        )
        logger.info(
            "[compute_superposition] _identify_action_elements: '%s' line_idxs=%s, sub_idxs=%s",
            action_id, line_idxs, sub_idxs,
        )
        if not line_idxs and not sub_idxs:
            fallback = pst_fallback_line_idxs(
                action_id, self._dict_action, all_actions, list(env.name_line)
            )
            if fallback:
                logger.info(
                    "[compute_superposition] PST fallback for '%s': line_idxs=%s",
                    action_id, fallback,
                )
                return fallback, sub_idxs
        return line_idxs, sub_idxs

    def _superposition_lines_overloaded(
        self,
        obs_start,
        name_line_list,
        name_to_idx_map,
        pre_existing_rho,
        lines_we_care_about,
        branches_with_limits,
        monitoring_factor,
        worsening_threshold,
    ):
        """Determine the active monitoring set for the superposition result.

        Prefers the analysis context's overload set when available (keeps
        the pair result aligned with the step2 "Computed Pairs" view);
        otherwise recomputes from `obs_start` with the same
        pre-existing-worsening rule as `simulate_manual_action`.

        Context lookup order:
          1. ``lines_overloaded_ids`` — indices resolved by step1 against
             the same ``name_line`` ordering (used by step2 discovery).
          2. ``lines_overloaded_names`` — step1 populates this key.
          3. ``lines_overloaded`` — written by session reload
             (``restore_analysis_context``).
        """
        ctx = self._analysis_context or {}
        ctx_ids = ctx.get("lines_overloaded_ids")
        if ctx_ids:
            ids = [int(i) for i in ctx_ids if 0 <= int(i) < len(name_line_list)]
            logger.info(
                "[compute_superposition] Using analysis context lines_overloaded_ids: %d lines",
                len(ids),
            )
            return ids
        ctx_overloaded = ctx.get("lines_overloaded_names") or ctx.get("lines_overloaded")
        if ctx_overloaded:
            ids = [name_to_idx_map[l] for l in ctx_overloaded if l in name_to_idx_map]
            logger.info(
                "[compute_superposition] Using analysis context lines_overloaded names: %d lines",
                len(ids),
            )
            return ids

        wt = float(worsening_threshold)
        lwca_set = set(lines_we_care_about) if lines_we_care_about else set(name_line_list)
        bwl_set = set(branches_with_limits)
        # obs.rho is already pre-scaled by monitoring_factor — threshold
        # is 1.0, not mf. See simulation_helpers.build_care_mask docstring.
        ids = []
        for i in range(len(obs_start.rho)):
            ln = name_line_list[i]
            if obs_start.rho[i] >= 1.0 and ln in lwca_set and ln in bwl_set:
                # Symmetric impact rule — see ``simulation_helpers.build_care_mask``.
                if i in pre_existing_rho:
                    lower = pre_existing_rho[i] * (1 - wt)
                    upper = pre_existing_rho[i] * (1 + wt)
                    if lower <= obs_start.rho[i] <= upper:
                        continue
                ids.append(i)
        logger.info(
            "[compute_superposition] Computed lines_overloaded from N-1 state: %d lines "
            "(filtered by %d care + %d with-limits)",
            len(ids), len(lwca_set), len(bwl_set),
        )
        return ids

    def _augment_superposition_result(
        self,
        result,
        obs_start,
        obs_n,
        all_actions,
        action1_id,
        action2_id,
        name_line_list,
        lines_we_care_about,
        branches_with_limits,
        lines_overloaded_ids,
        monitoring_factor,
        worsening_threshold,
        num_lines,
    ) -> None:
        """Post-process the library result into scalar max_rho + rho_before/after.

        Mirrors the care_mask logic in `compute_action_metrics` so the
        pair view matches single-action displays.
        """
        mf = float(monitoring_factor)
        wt = float(worsening_threshold)

        if lines_we_care_about is not None and len(lines_we_care_about) > 0:
            care_mask = np.isin(name_line_list, list(lines_we_care_about))
        else:
            care_mask = np.ones(num_lines, dtype=bool)
        limits_mask = np.isin(name_line_list, list(branches_with_limits))
        care_mask &= limits_mask

        rho_combined = compute_combined_rho(
            obs_start,
            all_actions[action1_id]["observation"],
            all_actions[action2_id]["observation"],
            result["betas"],
        )

        base_rho_n = (
            np.array(obs_n.rho[:num_lines])
            if len(obs_n.rho) >= num_lines
            else np.array(obs_n.rho)
        )
        # obs.rho is already pre-scaled by monitoring_factor — threshold
        # is 1.0, not mf. See simulation_helpers.build_care_mask docstring.
        # ``rho_combined`` is in the same scale (linear combination of
        # obs.rho values).
        pre_existing = base_rho_n >= 1.0
        # Symmetric impact rule — see ``simulation_helpers.build_care_mask``.
        rho_c = rho_combined[:num_lines]
        not_impacted = (rho_c >= base_rho_n * (1 - wt)) & (rho_c <= base_rho_n * (1 + wt))
        care_mask &= ~(pre_existing & not_impacted)

        for idx in lines_overloaded_ids:
            if idx < len(care_mask):
                care_mask[idx] = True

        max_rho = 0.0
        max_rho_line = "N/A"
        if np.any(care_mask):
            masked_rho = rho_combined[care_mask]
            masked_names = np.array(name_line_list)[care_mask]
            max_idx = int(np.argmax(masked_rho))
            max_rho = float(masked_rho[max_idx])
            max_rho_line = masked_names[max_idx]

        target_max_rho, target_max_rho_line = compute_target_max_rho(
            rho_combined, name_line_list, lines_overloaded_ids,
        )

        logger.info(
            "[compute_superposition] monitored lines: %d/%d, lines_overloaded force-included: %d",
            int(np.sum(care_mask)), num_lines, len(lines_overloaded_ids),
        )
        logger.info(
            "[compute_superposition] RESULT: max_rho_line=%s, max_rho_raw=%.6f, max_rho_scaled=%.4f",
            max_rho_line, max_rho, max_rho * mf,
        )

        rho_after_raw = rho_combined[lines_overloaded_ids]
        baseline_rho = obs_start.rho[lines_overloaded_ids]
        is_rho_reduction = bool(np.all(rho_after_raw + 0.01 < baseline_rho))

        result.update({
            "max_rho": max_rho * monitoring_factor,
            "max_rho_line": max_rho_line,
            # Max computed over the USER-SELECTED overloaded lines — the
            # ones the pair is meant to resolve.  Lets the UI show the
            # effect on the target contingency alongside the global
            # `max_rho`, which may land on an off-target line due to
            # linearisation error on lines far from either action.
            "target_max_rho": target_max_rho * monitoring_factor if target_max_rho else 0.0,
            "target_max_rho_line": target_max_rho_line,
            "is_rho_reduction": is_rho_reduction,
            "rho_after": (rho_combined[lines_overloaded_ids] * monitoring_factor).tolist(),
            "rho_before": (obs_start.rho[lines_overloaded_ids] * monitoring_factor).tolist(),
            "is_estimated": True,
        })

    def _log_dict_action_snapshot(self, action1_id, action2_id, all_actions) -> None:
        """Debug-only: log _dict_action entry keys for a pair (silent in prod)."""
        for aid in (action1_id, action2_id):
            entry = self._dict_action.get(aid) if self._dict_action else None
            if entry:
                logger.debug(
                    "[compute_superposition] _dict_action['%s'] keys: %s",
                    aid, list(entry.keys()),
                )
            else:
                logger.debug("[compute_superposition] _dict_action['%s'] = NOT FOUND", aid)
            if not all_actions.get(aid):
                logger.debug("[compute_superposition] all_actions['%s'] = NOT FOUND", aid)

    def _log_per_line_rho(
        self, action1_id, action2_id, line_idxs1, line_idxs2, obs_start, env, all_actions
    ) -> None:
        """Debug-only: log rho + p_or deltas per identified line index."""
        name_line = list(env.name_line)
        for aid, lidxs in [(action1_id, line_idxs1), (action2_id, line_idxs2)]:
            obs_act = all_actions[aid]["observation"]
            try:
                for li in lidxs:
                    ln = name_line[li] if li < len(name_line) else f"idx_{li}"
                    logger.debug(
                        "[compute_superposition] rho at %s(idx=%d): "
                        "obs_start=%.6f, obs_act(%s)=%.6f, delta=%.6f",
                        ln, li,
                        float(obs_start.rho[li]), aid,
                        float(obs_act.rho[li]),
                        float(obs_act.rho[li] - obs_start.rho[li]),
                    )
            except (TypeError, ValueError, IndexError):
                logger.warning(
                    "[compute_superposition] Could not log rho for %s (mock or missing data)", aid
                )
