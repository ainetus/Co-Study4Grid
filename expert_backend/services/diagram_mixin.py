# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0
# This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

"""Diagram generation mixin for RecommenderService.

Thin orchestrator around the seven focused modules under
``services/diagram/``:

 - ``layout_cache``   — `(path, mtime)`-keyed ``grid_layout.json`` loader
 - ``nad_params``     — default ``NadParameters`` factory
 - ``nad_render``     — ``generate_diagram`` + NaN element stripping
 - ``sld_render``     — SLD SVG + metadata extraction
 - ``overloads``      — overload filtering + per-element current scans
 - ``flows``          — branch + asset flow extractors
 - ``deltas``         — terminal-aware delta math (pure)

Public method signatures are unchanged. Each method is a short
orchestrator that switches the right variant, calls the stateless
helpers, and mutates the per-service caches (``_layout_cache``,
``_n_state_currents``, ``_lf_status_by_variant``).
"""

import logging
import time

from expert_op4grid_recommender import config
from expert_op4grid_recommender.utils.make_env_utils import create_olf_rte_parameter

from expert_backend.services.diagram.deltas import (
    apply_threshold,
    compute_asset_deltas,
    compute_deltas,
    select_terminal_for_branch,
    terminal_aware_delta,
)
from expert_backend.services.diagram.flows import (
    get_asset_flows,
    get_network_flows,
)
from expert_backend.services.diagram.layout_cache import load_layout
from expert_backend.services.diagram.action_patch import (
    build_action_patch_payload,
    compute_vl_topology_diff,
    extract_vl_subtrees_with_edges,
    get_disconnected_branches_from_snapshot,
)
from expert_backend.services.diagram.nad_params import default_nad_parameters
from expert_backend.services.diagram.nad_render import generate_diagram
from expert_backend.services.diagram.obs_prewarm import build_prewarmed_obs
from expert_backend.services.diagram.overloads import (
    get_element_max_currents,
    get_overloaded_lines,
)
from expert_backend.services.diagram.sld_render import (
    extract_sld_svg_and_metadata,
    extract_vl_switch_states,
)
from typing import TYPE_CHECKING

from expert_backend.services.sanitize import sanitize_for_json
from expert_backend.services.simulation_helpers import canonicalize_action_id

logger = logging.getLogger(__name__)


class ActionResultUnavailableError(ValueError):
    """The action is not in the backend's ``_last_result``.

    Subclasses ``ValueError`` so existing ``except ValueError`` /
    ``except Exception`` boundaries keep returning HTTP 400 unchanged.
    The dedicated type lets the API layer recognise an *expected*
    post-reload condition — the frontend silently falls back to
    ``/api/simulate-and-variant-diagram`` — and log it quietly instead
    of dumping a full ERROR-level traceback for what is normal
    behaviour after a session reload (or for any manually-added action,
    which is never in ``_last_result`` either).
    """


if TYPE_CHECKING:
    from expert_backend.services._recommender_state import RecommenderState

    _Base = RecommenderState
else:
    _Base = object


class DiagramMixin(_Base):
    """Mixin providing diagram generation and flow analysis methods."""

    # ------------------------------------------------------------------
    # Layout / NAD parameter helpers — thin wrappers around the stateless
    # helpers. Kept as methods so existing tests that patch them on the
    # service instance keep working.
    # ------------------------------------------------------------------

    def _load_layout(self):
        """Load layout DataFrame from ``grid_layout.json``, cached by ``(path, mtime)``."""
        layout_file = getattr(config, "LAYOUT_FILE_PATH", None)
        return load_layout(
            layout_file,
            get_cache=lambda: getattr(self, "_layout_cache", None),
            set_cache=lambda value: setattr(self, "_layout_cache", value),
        )

    def _default_nad_parameters(self):
        """Return default ``NadParameters`` for diagram generation."""
        return default_nad_parameters()

    def _generate_diagram(self, network, voltage_level_ids=None, depth=0):
        """Generate NAD and return svg + metadata dict."""
        return generate_diagram(
            network,
            df_layout=self._load_layout(),
            nad_parameters=self._default_nad_parameters(),
            voltage_level_ids=voltage_level_ids,
            depth=depth,
        )

    # ------------------------------------------------------------------
    # Flow / overload helpers — stateless wrappers for legacy tests.
    # ------------------------------------------------------------------

    def _get_element_max_currents(self, network):
        return get_element_max_currents(network)

    def _get_overloaded_lines(
        self, network, n_state_currents=None, lines_we_care_about=None, with_rho=False
    ):
        return get_overloaded_lines(
            network,
            n_state_currents=n_state_currents,
            lines_we_care_about=lines_we_care_about,
            with_rho=with_rho,
            monitoring_factor=getattr(config, "MONITORING_FACTOR_THERMAL_LIMITS", 0.95),
            worsening_threshold=getattr(config, "PRE_EXISTING_OVERLOAD_WORSENING_THRESHOLD", 0.02),
        )

    def _get_network_flows(self, network):
        return get_network_flows(network)

    def _get_asset_flows(self, network):
        return get_asset_flows(network)

    def _get_contingency_flows(self, disconnected_elements) -> dict:
        """Branch flows of the network in the contingency state using a cached variant."""
        n = self._get_base_network()
        var_id = self._get_contingency_variant(disconnected_elements)
        original_variant = n.get_working_variant_id()

        n.set_working_variant(var_id)
        flows = get_network_flows(n)
        n.set_working_variant(original_variant)
        return flows

    # ------------------------------------------------------------------
    # Delta helpers — thin wrappers so existing tests that reference
    # them directly on the mixin keep working. The heavy math lives in
    # :mod:`diagram.deltas`.
    # ------------------------------------------------------------------

    @staticmethod
    def _terminal_aware_delta(after_val, before_val):
        return terminal_aware_delta(after_val, before_val)

    @staticmethod
    def _select_terminal_for_branch(lid, avl1, avl2, bvl1, bvl2, vl_set):
        return select_terminal_for_branch(lid, avl1, avl2, bvl1, bvl2, vl_set)

    @staticmethod
    def _apply_threshold(deltas):
        return apply_threshold(deltas)

    def _compute_deltas(self, after_flows, before_flows, voltage_level_ids=None):
        return compute_deltas(after_flows, before_flows, voltage_level_ids)

    def _compute_asset_deltas(self, after_asset_flows, before_asset_flows):
        return compute_asset_deltas(after_asset_flows, before_asset_flows)

    def _get_lines_we_care_about(self):
        """Return the set of monitored line IDs, or ``None`` when all lines are monitored."""
        if not getattr(config, "IGNORE_LINES_MONITORING", True) and getattr(config, "LINES_MONITORING_FILE", None):
            try:
                from expert_op4grid_recommender.data_loader import load_interesting_lines
                return set(load_interesting_lines(file_name=config.LINES_MONITORING_FILE))
            except Exception as e:
                logger.warning("Warning: Failed to load lines_we_care_about: %s", e)
        return None

    @staticmethod
    def _extract_sld_svg_and_metadata(sld):
        return extract_sld_svg_and_metadata(sld)

    # ------------------------------------------------------------------
    # Public NAD endpoints
    # ------------------------------------------------------------------

    def get_network_diagram(self, voltage_level_ids=None, depth=0):
        """Base-state (N) NAD."""
        n = self._get_base_network()
        original_variant = n.get_working_variant_id()
        n_variant_id = self._get_n_variant()
        n.set_working_variant(n_variant_id)

        try:
            diagram = self._generate_diagram(n, voltage_level_ids=voltage_level_ids, depth=depth)
            names, rhos = self._get_overloaded_lines(
                n, lines_we_care_about=self._get_lines_we_care_about(), with_rho=True
            )
            diagram["lines_overloaded"] = names
            diagram["lines_overloaded_rho"] = rhos
            # Cache N-state element currents for N-1 comparison
            self._n_state_currents = self._get_element_max_currents(n)
            return diagram
        finally:
            n.set_working_variant(original_variant)

    def get_contingency_diagram(self, disconnected_elements, voltage_level_ids=None, depth=0):
        """Post-contingency NAD (N-1, N-2, ..., N-K) with flow deltas vs N."""
        norm = self._normalize_contingency_elements(disconnected_elements)
        logger.info(
            "[RECO] Generating contingency diagram for %s (VLs=%s, depth=%d)...",
            norm, voltage_level_ids, depth,
        )

        n = self._get_base_network()
        original_variant = n.get_working_variant_id()
        variant_id = self._get_contingency_variant(norm)
        n.set_working_variant(variant_id)

        try:
            converged, lf_status = self._lf_status_for_variant(n, variant_id, norm)
            if not converged:
                logger.warning(
                    "Warning: AC load flow did not converge for contingency (%s): %s",
                    norm, lf_status,
                )

            diagram = self._generate_diagram(n, voltage_level_ids=voltage_level_ids, depth=depth)
            diagram["lf_converged"] = converged
            diagram["lf_status"] = lf_status

            self._attach_flow_deltas_vs_base(diagram, n, voltage_level_ids=None)

            # Exclude pre-existing overloads (already overloaded in N) unless worsened.
            names, rhos = self._get_overloaded_lines(
                n,
                n_state_currents=getattr(self, "_n_state_currents", None),
                lines_we_care_about=self._get_lines_we_care_about(),
                with_rho=True,
            )
            diagram["lines_overloaded"] = names
            diagram["lines_overloaded_rho"] = rhos
            # Pre-warm the post-contingency observation cache while the
            # variant is already set. Step 1 of the analysis pipeline
            # then re-uses this observation instead of running a second
            # AC load flow on a fresh variant. The cache key is the
            # contingency variant ID; switching to a different
            # contingency naturally falls back to a fresh build.
            if converged:
                try:
                    self._cache_obs_for_variant(n, variant_id, norm)
                except Exception as exc:
                    # Pre-warming is a best-effort optimisation — a failure
                    # here must never break the diagram fetch. Step 1 will
                    # just rebuild the obs the slow way.
                    logger.debug("[RECO] obs prewarm skipped for %s: %s", norm, exc)
            return diagram
        finally:
            n.set_working_variant(original_variant)

    def _cache_obs_for_variant(self, n, variant_id: str, disconnected_elements) -> None:
        """Pre-warm ``_cached_obs_n1*`` so ``run_analysis_step1`` skips
        a redundant contingency LF. Thin wrapper around
        ``build_prewarmed_obs`` (no-op when no env is reachable)."""
        prewarmed = build_prewarmed_obs(
            cached_env_context=self._cached_env_context,
            get_simulation_env=self._get_simulation_env,
            variant_id=variant_id, disconnected_elements=disconnected_elements,
        )
        if prewarmed is not None:
            self._cached_obs_n1, self._cached_obs_n1_id, self._cached_obs_n1_elements = prewarmed

    def get_action_variant_diagram(self, action_id, voltage_level_ids=None, depth=0, mode="network"):
        """Generate a NAD showing the network state after applying a remedial action.

        Uses the variant ID and network manager stored in the observation
        from the last analysis run to switch to the post-action network
        state directly, avoiding the need to replay disconnections on a
        fresh network.
        """
        actions = self._require_action(action_id)
        obs = actions[action_id]["observation"]
        nm = obs._network_manager
        nm.set_working_variant(obs._variant_id)

        network = nm.network
        diagram = self._generate_diagram(network, voltage_level_ids=voltage_level_ids, depth=depth)
        diagram["action_id"] = action_id
        self._attach_convergence_from_obs(diagram, obs)

        # Always include flow deltas so mode switching is instant on the frontend.
        try:
            action_flows = get_network_flows(network)
            action_assets = get_asset_flows(network)
            cont_flows, cont_assets = self._snapshot_contingency_state(self._last_disconnected_elements)
            deltas = compute_deltas(action_flows, cont_flows, voltage_level_ids=voltage_level_ids)
            diagram["flow_deltas"] = deltas["flow_deltas"]
            diagram["reactive_flow_deltas"] = deltas["reactive_flow_deltas"]
            diagram["asset_deltas"] = compute_asset_deltas(action_assets, cont_assets)
        except Exception as e:
            logger.warning("Warning: Failed to compute flow deltas: %s", e)
            diagram["flow_deltas"] = {}
            diagram["reactive_flow_deltas"] = {}
            diagram["asset_deltas"] = {}

        return diagram

    # ------------------------------------------------------------------
    # Patch-only endpoints (SVG DOM recycling)
    # ------------------------------------------------------------------
    #
    # get_n1_diagram_patch and get_action_variant_diagram_patch return the
    # same delta/overload payload as their full-NAD siblings but SKIP the
    # `_generate_diagram(...)` call entirely. The frontend clones the
    # already-loaded N-state SVG DOM and applies these patches in-place,
    # saving ~2-4 s of pypowsybl NAD generation and ~20-28 MB of SVG
    # transfer + parse per call on large grids.
    #
    # Topology-changing actions (switch opens, line reconnections) are
    # flagged `patchable: false` so the frontend falls back to the full
    # NAD endpoint — pypowsybl's concentric multi-circle VL node
    # rendering cannot be faithfully reproduced by DOM patching.
    #
    # See docs/performance/history/svg-dom-recycling.md for the full
    # rationale and benchmark results.

    def _build_contingency_patch_payload(self, disconnected_elements) -> dict:
        """Compute the contingency patch payload without generating the NAD SVG.

        Mirrors the flow-delta / overload logic in
        ``get_contingency_diagram`` but skips ``_generate_diagram`` and
        ``_get_svg_*`` entirely — returns only the per-branch /
        per-asset data needed by the frontend to patch a cloned
        N-state SVG.
        """
        import time

        norm = self._normalize_contingency_elements(disconnected_elements)
        t_start = time.time()
        n = self._get_base_network()
        original_variant = n.get_working_variant_id()
        variant_id = self._get_contingency_variant(norm)
        n.set_working_variant(variant_id)

        try:
            cached_status = getattr(self, '_lf_status_by_variant', {}).get(variant_id)
            if cached_status is not None:
                converged = cached_status["converged"]
                lf_status = cached_status["lf_status"]
            else:
                params = create_olf_rte_parameter()
                results = self._run_ac_with_fallback(n, params)
                converged = any(r.status.name == 'CONVERGED' for r in results)
                lf_status = results[0].status.name if results else "UNKNOWN"

            payload = {
                "patchable": True,
                "contingency_id": "+".join(norm) if norm else "",
                "contingency_elements": list(norm),
                "lf_converged": converged,
                "lf_status": lf_status,
                "disconnected_edges": list(norm),
            }

            try:
                cont_flows = self._get_network_flows(n)
                cont_assets = self._get_asset_flows(n)

                n_base = self._get_base_network()
                original_variant_base = n_base.get_working_variant_id()
                n_variant_id_base = self._get_n_variant()
                n_base.set_working_variant(n_variant_id_base)

                base_flows = self._get_network_flows(n_base)
                base_assets = self._get_asset_flows(n_base)

                deltas = self._compute_deltas(cont_flows, base_flows)
                payload["absolute_flows"] = {
                    "p1": cont_flows["p1"],
                    "p2": cont_flows["p2"],
                    "q1": cont_flows["q1"],
                    "q2": cont_flows["q2"],
                    "vl1": cont_flows["vl1"],
                    "vl2": cont_flows["vl2"],
                }
                payload["flow_deltas"] = deltas["flow_deltas"]
                payload["reactive_flow_deltas"] = deltas["reactive_flow_deltas"]
                payload["asset_deltas"] = self._compute_asset_deltas(cont_assets, base_assets)

                n_base.set_working_variant(original_variant_base)
            except Exception as e:
                logger.warning(f"Warning: Failed to compute contingency patch flow deltas: {e}")
                payload["absolute_flows"] = {}
                payload["flow_deltas"] = {}
                payload["reactive_flow_deltas"] = {}
                payload["asset_deltas"] = {}

            n_state_currents = getattr(self, '_n_state_currents', None)
            names, rhos = self._get_overloaded_lines(
                n,
                n_state_currents=n_state_currents,
                lines_we_care_about=self._get_lines_we_care_about(),
                with_rho=True,
            )
            payload["lines_overloaded"] = names
            payload["lines_overloaded_rho"] = rhos

            payload["meta"] = {
                "base_state": "N",
                "elapsed_ms": int((time.time() - t_start) * 1000),
            }
            # Pre-warm the post-contingency observation cache while the
            # variant is already set. ``run_analysis_step1`` then re-uses
            # it instead of running a second AC load flow. Mirrors the
            # prewarm in ``get_contingency_diagram`` — the React frontend
            # uses the patch endpoint by default (SVG DOM recycling
            # fast path), so the prewarm must live here too.
            if converged:
                try:
                    self._cache_obs_for_variant(n, variant_id, norm)
                except Exception as exc:
                    logger.debug("[RECO] obs prewarm skipped for %s: %s", norm, exc)
            return sanitize_for_json(payload)
        finally:
            n.set_working_variant(original_variant)

    def get_contingency_diagram_patch(self, disconnected_elements) -> dict:
        """Return the contingency patch payload (SVG-less).

        The frontend uses this to patch a clone of the N-state SVG DOM
        instead of fetching a fresh ~20 MB contingency NAD. Falls back
        to ``get_contingency_diagram`` on the frontend side if anything
        in this endpoint raises.
        """
        norm = self._normalize_contingency_elements(disconnected_elements)
        logger.info(f"[RECO] Contingency patch payload for {norm}...")
        return self._build_contingency_patch_payload(norm)

    # Action-variant patch pipeline lives in
    # ``services/diagram/action_patch.py`` — the three helpers below
    # are thin static-method wrappers kept on the mixin so that
    # ``tests/test_diagram_patch_helpers.py`` (which calls them as
    # ``DiagramMixin._compute_vl_topology_diff`` etc.) keeps working
    # without churn.

    @staticmethod
    def _compute_vl_topology_diff(action_buses_snap, n1_network):
        return compute_vl_topology_diff(action_buses_snap, n1_network)

    def _extract_vl_subtrees_with_edges(self, action_network, vl_ids):
        return extract_vl_subtrees_with_edges(
            action_network, vl_ids, generate_diagram=self._generate_diagram,
        )

    @staticmethod
    def _get_disconnected_branches_from_snapshot(action_lines_conn_snap, action_trafos_conn_snap):
        return get_disconnected_branches_from_snapshot(
            action_lines_conn_snap, action_trafos_conn_snap,
        )

    def get_action_variant_diagram_patch(self, action_id: str) -> dict:
        """Return the action-variant patch payload (SVG-less).

        Thin wrapper around ``build_action_patch_payload``: the heavy
        orchestration (snapshot discipline, VL-diff, subtree
        extraction, flow / overload computation) lives in
        ``services/diagram/action_patch.py``.
        """
        return build_action_patch_payload(self, action_id)

    # ------------------------------------------------------------------
    # Public SLD endpoints
    # ------------------------------------------------------------------

    def get_n_sld(self, voltage_level_id: str) -> dict:
        """Single Line Diagram in the base N state."""
        n = self._get_base_network()
        original_variant = n.get_working_variant_id()
        n.set_working_variant(self._get_n_variant())
        try:
            sld = n.get_single_line_diagram(voltage_level_id)
            svg, sld_metadata = extract_sld_svg_and_metadata(sld)
            switch_states = extract_vl_switch_states(n, voltage_level_id)
        finally:
            n.set_working_variant(original_variant)
        return {
            "svg": svg,
            "sld_metadata": sld_metadata,
            "voltage_level_id": voltage_level_id,
            "switch_states": switch_states,
        }

    def get_contingency_sld(self, disconnected_elements, voltage_level_id: str) -> dict:
        """Single Line Diagram in the contingency state (N-1 / N-K)."""
        norm = self._normalize_contingency_elements(disconnected_elements)
        n = self._get_base_network()
        original_variant = n.get_working_variant_id()
        n.set_working_variant(self._get_contingency_variant(norm))

        try:
            sld = n.get_single_line_diagram(voltage_level_id)
            svg, sld_metadata = extract_sld_svg_and_metadata(sld)
            switch_states = extract_vl_switch_states(n, voltage_level_id)
            result = {
                "svg": svg,
                "sld_metadata": sld_metadata,
                "voltage_level_id": voltage_level_id,
                "disconnected_elements": list(norm),
                "switch_states": switch_states,
            }
            self._attach_flow_deltas_vs_base(result, n, voltage_level_ids=[voltage_level_id])
            return result
        finally:
            n.set_working_variant(original_variant)

    def get_action_variant_sld(self, action_id: str, voltage_level_id: str) -> dict:
        """Single Line Diagram in the post-action state, with flow deltas vs N-1.

        Mirrors `get_action_variant_diagram` (the NAD sibling that
        already computes correct action-vs-N-1 deltas) as closely as
        possible — same variant-switch cadence, same helper
        (`_snapshot_n1_state`), same argument order into
        `compute_deltas`. The only endpoint-specific extras are the
        SLD-rendering call + `changed_switches` diff. Keeping the two
        sides structurally identical means any future fix to the
        flow-delta pipeline only needs to land in one place.
        """
        actions = self._require_action(action_id)
        obs = actions[action_id]["observation"]
        nm = obs._network_manager
        action_variant_id = obs._variant_id
        nm.set_working_variant(action_variant_id)

        network = nm.network
        sld = network.get_single_line_diagram(voltage_level_id)
        svg, sld_metadata = extract_sld_svg_and_metadata(sld)
        switch_states = extract_vl_switch_states(network, voltage_level_id)

        result = {
            "svg": svg,
            "sld_metadata": sld_metadata,
            "action_id": action_id,
            "voltage_level_id": voltage_level_id,
            "switch_states": switch_states,
        }
        self._attach_convergence_from_obs(result, obs)

        # Capture the action-variant switch snapshot NOW — still on the
        # action variant, pypowsybl DataFrames are live views that
        # reflect whatever variant is currently active when accessed.
        # `.copy()` forces pandas to materialise the values in this
        # frame, independent of any subsequent variant flip on the
        # shared handle. Same rationale as the NAD-patch endpoint (see
        # the comment on `action_switches_snap` in
        # `get_action_variant_diagram_patch`).
        try:
            action_switches_snap = network.get_switches(attributes=["open"]).copy()
        except Exception as e:
            logger.debug("Suppressed exception while snapshotting switches: %s", e)
            action_switches_snap = None

        # Flow + asset snapshots — identical call order to
        # `get_action_variant_diagram`. `get_network_flows` /
        # `get_asset_flows` already return plain dicts materialised
        # from pandas `.to_dict()`, so the snapshots are safe to hold
        # across the subsequent variant switch inside
        # `_snapshot_n1_state`.
        try:
            action_flows = get_network_flows(network)
            action_assets = get_asset_flows(network)
            # `_snapshot_n1_state` saves the current working variant
            # (ACTION), flips to N-1 to read, then restores to ACTION
            # — exactly the cadence used by the NAD sibling endpoint.
            cont_flows, cont_assets = self._snapshot_contingency_state(self._last_disconnected_elements)

            # Diagnostic: confirm the snapshots really do differ. If
            # max |Δp1| is 0 for every branch, the upstream action
            # simulation either did not actually modify the pypowsybl
            # variant (grid2op-cached result, no-op action, …) or
            # ``obs._variant_id`` points to the same variant as the
            # contingency reference. Either way the frontend will
            # render the cell-free "Δ +0.0" / grey Impacts view the
            # operator reported — and the fix won't be in this
            # function.
            try:
                p1_after = (action_flows or {}).get("p1") or {}
                p1_before = (cont_flows or {}).get("p1") or {}
                common = set(p1_after.keys()) & set(p1_before.keys())
                max_abs = 0.0
                top5: list = []
                if common:
                    diffs = [(bid, float(p1_after[bid]) - float(p1_before[bid])) for bid in common]
                    diffs.sort(key=lambda t: abs(t[1]), reverse=True)
                    max_abs = abs(diffs[0][1]) if diffs else 0.0
                    top5 = [(bid, round(d, 2)) for bid, d in diffs[:5]]
                logger.info(
                    "[SLD action-variant] action_id=%s vl=%s action_variant=%s "
                    "branches=%d common=%d max|Δp1|=%.2f top5=%s",
                    action_id, voltage_level_id, action_variant_id,
                    len(p1_after), len(common), max_abs, top5,
                )
            except Exception as diag_e:
                logger.debug("[SLD action-variant] flow-diff diagnostic failed: %s", diag_e)

            deltas = compute_deltas(action_flows, cont_flows, voltage_level_ids=[voltage_level_id])
            result["flow_deltas"] = deltas["flow_deltas"]
            result["reactive_flow_deltas"] = deltas["reactive_flow_deltas"]
            result["asset_deltas"] = compute_asset_deltas(action_assets, cont_assets)
        except Exception as e:
            logger.warning("Warning: Failed to compute SLD flow deltas for manual action: %s", e)
            result["flow_deltas"] = {}
            result["reactive_flow_deltas"] = {}
            result["asset_deltas"] = {}

        # Switch-diff comes AFTER `_snapshot_contingency_state` (which
        # restores the working variant to ACTION). The
        # `action_switches_snap` we captured at the top is a materialised
        # copy so the diff is variant-independent — we just need the
        # contingency-state half, which we re-read with a short-lived
        # variant flip + restore.
        try:
            result["changed_switches"] = self._diff_action_switches_vs_contingency(
                action_switches_snap, self._last_disconnected_elements,
            )
        except Exception as e:
            logger.warning("Warning: Failed to diff switches: %s", e)
            result["changed_switches"] = {}

        return result

    def _render_topological_sld(self, network, voltage_level_id):
        """Render a VL SLD with topological (per-connected-bus) colouring.

        Topological colouring is what makes a node split / merge visible:
        opening a coupling splits the busbar into two connected
        components, which pypowsybl then paints in distinct colours —
        the same affordance the ``manoeuvre_ihm`` target-topology view
        relies on. Falls back to the default parameters when the
        installed pypowsybl predates ``SldParameters`` or rejects the
        flag.
        """
        try:
            import pypowsybl.network as pn
            params = pn.SldParameters(use_name=True, topological_coloring=True)
            return network.get_single_line_diagram(voltage_level_id, parameters=params)
        except Exception as e:
            logger.debug("Topological SLD params unavailable, using default: %s", e)
            return network.get_single_line_diagram(voltage_level_id)

    def get_topology_preview_sld(
        self, disconnected_elements, voltage_level_id, switches, base_action_id=None
    ) -> dict:
        """Render a *target-topology preview* SLD.

        Clones a throwaway variant from the contingency state (or the
        post-action variant when ``base_action_id`` is given), applies
        the user's pending switch overrides, and re-renders the VL SLD
        with topological colouring. NO load flow is run — the flow
        values shown are stale, so the response carries
        ``stale_flows: True`` and the frontend greys them out until the
        operator commits the simulation.

        The throwaway variant is always removed and the working variant
        restored in a ``finally`` so the shared Network is never left
        mutated.
        """
        norm = self._normalize_contingency_elements(disconnected_elements)

        if base_action_id:
            actions = self._require_action(base_action_id)
            obs = actions[base_action_id]["observation"]
            nm = obs._network_manager
            network = nm.network
            base_variant = obs._variant_id
        else:
            network = self._get_base_network()
            base_variant = self._get_contingency_variant(norm)

        original_variant = network.get_working_variant_id()
        preview_variant = f"sld_preview_{voltage_level_id}_{time.time_ns()}"
        network.clone_variant(base_variant, preview_variant)
        try:
            network.set_working_variant(preview_variant)
            if switches:
                ids = [str(k) for k in switches.keys()]
                opens = [bool(switches[k]) for k in switches.keys()]
                network.update_switches(id=ids, open=opens)
            sld = self._render_topological_sld(network, voltage_level_id)
            svg, sld_metadata = extract_sld_svg_and_metadata(sld)
            switch_states = extract_vl_switch_states(network, voltage_level_id)
            return {
                "svg": svg,
                "sld_metadata": sld_metadata,
                "voltage_level_id": voltage_level_id,
                "switch_states": switch_states,
                "stale_flows": True,
            }
        finally:
            network.set_working_variant(original_variant)
            try:
                network.remove_variant(preview_variant)
            except Exception as e:
                logger.debug("Failed to remove preview variant %s: %s", preview_variant, e)

    def _diff_action_switches_vs_contingency(self, action_switches_snap, disconnected_elements) -> dict:
        """Diff a pre-captured action-variant switch snapshot against the
        live contingency variant.

        Centralises the save/switch/read/restore dance so
        ``get_action_variant_sld`` doesn't have to interleave variant
        management with the flow-delta pipeline. Returns ``{}`` on any
        failure — switches are informational, they must not break the
        SLD response.
        """
        if action_switches_snap is None:
            return {}
        n = self._get_base_network()
        original_variant = n.get_working_variant_id()
        try:
            n.set_working_variant(self._get_contingency_variant(disconnected_elements))
            return self._diff_switches(action_switches_snap, n)
        finally:
            n.set_working_variant(original_variant)

    # ------------------------------------------------------------------
    # Private orchestrator helpers
    # ------------------------------------------------------------------

    def _require_action(self, action_id: str) -> dict:
        """Return the prioritized actions dict, or raise if the action is missing.

        Raises :class:`ActionResultUnavailableError` (a ``ValueError``
        subclass) so the API layer can tell this *expected* post-reload
        condition from a genuine fault — see the class docstring.
        """
        if not self._last_result or not self._last_result.get("prioritized_actions"):
            raise ActionResultUnavailableError(
                "No analysis result available. Run analysis first."
            )
        actions = self._last_result["prioritized_actions"]
        if action_id not in actions:
            # Combined actions are stored under a CANONICAL key (the
            # "+"-joined parts sorted alphabetically — see
            # ``canonicalize_action_id``). A caller using the raw,
            # unsorted order (e.g. ``base+user_topo`` straight from the
            # frontend) would otherwise miss it. Alias the raw key onto
            # the canonical entry so ``actions[action_id]`` works for
            # either ordering.
            canon = canonicalize_action_id(action_id)
            if canon != action_id and canon in actions:
                actions[action_id] = actions[canon]
            else:
                raise ActionResultUnavailableError(
                    f"Action '{action_id}' not found in last analysis result."
                )
        return actions

    def _lf_status_for_variant(self, network, variant_id: str, disconnected_elements) -> tuple:
        """Return ``(converged, lf_status)`` for ``variant_id``.

        Prefers the cached status from ``_get_contingency_variant``
        (populated when the variant was first created) — avoids a
        ~600 ms-1 s re-run of the AC LF per diagram on large grids.
        """
        cached = getattr(self, "_lf_status_by_variant", {}).get(variant_id)
        if cached is not None:
            logger.info("[RECO] Contingency LF status for %s served from cache", disconnected_elements)
            return cached["converged"], cached["lf_status"]

        t0 = time.time()
        params = create_olf_rte_parameter()
        results = self._run_ac_with_fallback(network, params)
        converged = any(r.status.name == "CONVERGED" for r in results)
        lf_status = results[0].status.name if results else "UNKNOWN"
        logger.info("[RECO] Contingency LF check %s: %.2fs", disconnected_elements, time.time() - t0)
        return converged, lf_status

    def _snapshot_contingency_state(self, disconnected_elements) -> tuple[dict, dict]:
        """Fetch ``(branch_flows, asset_flows)`` in the contingency state.

        Positions the base network on the contingency variant, reads
        both snapshots, restores the original variant. Used by the
        action-variant diagram to produce deltas against the
        contingency state.
        """
        cont_flows = self._get_contingency_flows(disconnected_elements)
        cont_network = self._get_base_network()
        original_variant = cont_network.get_working_variant_id()
        cont_network.set_working_variant(self._get_contingency_variant(disconnected_elements))
        try:
            cont_assets = get_asset_flows(cont_network)
        finally:
            cont_network.set_working_variant(original_variant)
        return cont_flows, cont_assets

    def _attach_flow_deltas_vs_base(self, diagram: dict, n_contingency_network, voltage_level_ids) -> None:
        """Populate ``flow_deltas`` / ``reactive_flow_deltas`` / ``asset_deltas`` on ``diagram``.

        ``n_contingency_network`` MUST already be positioned on the
        contingency variant. The function snapshots the flows, then
        positions the base network on N, takes another snapshot, and
        restores the original variant.
        """
        try:
            # IMPORTANT: flows must be read while the contingency variant
            # is still active on the caller's network object.
            n1_flows = get_network_flows(n_contingency_network)
            n1_assets = get_asset_flows(n_contingency_network)

            n_base = self._get_base_network()
            original_variant_base = n_base.get_working_variant_id()
            n_base.set_working_variant(self._get_n_variant())
            base_flows = get_network_flows(n_base)
            base_assets = get_asset_flows(n_base)

            deltas = compute_deltas(n1_flows, base_flows, voltage_level_ids=voltage_level_ids)
            diagram["flow_deltas"] = deltas["flow_deltas"]
            diagram["reactive_flow_deltas"] = deltas["reactive_flow_deltas"]
            diagram["asset_deltas"] = compute_asset_deltas(n1_assets, base_assets)
            n_base.set_working_variant(original_variant_base)
        except Exception as e:
            logger.warning("Warning: Failed to compute flow deltas: %s", e)
            diagram["flow_deltas"] = {}
            diagram["reactive_flow_deltas"] = {}
            diagram["asset_deltas"] = {}

    @staticmethod
    def _attach_convergence_from_obs(diagram: dict, obs) -> None:
        """Copy ``lf_converged`` / ``lf_status`` / ``non_convergence`` from an observation."""
        info_action = getattr(obs, "_last_info", {}) or {}
        sim_exception = info_action.get("exception")
        diagram["lf_converged"] = not bool(sim_exception)
        if sim_exception:
            if isinstance(sim_exception, list):
                non_convergence = "; ".join(str(e) for e in sim_exception)
            else:
                non_convergence = str(sim_exception)
        else:
            non_convergence = None
        diagram["lf_status"] = non_convergence if non_convergence else "CONVERGED"
        diagram["non_convergence"] = non_convergence

    @staticmethod
    def _diff_switches(action_switches_df, cont_network) -> dict:
        """Return ``{switch_id: {from_open, to_open}}`` for each switch whose state changed."""
        if action_switches_df is None:
            return {}
        changed: dict[str, dict] = {}
        try:
            cont_switches_df = cont_network.get_switches()
            for sw_id in action_switches_df.index:
                if sw_id in cont_switches_df.index:
                    a_open = bool(action_switches_df.loc[sw_id, "open"])
                    cont_open = bool(cont_switches_df.loc[sw_id, "open"])
                    if a_open != cont_open:
                        changed[sw_id] = {"from_open": cont_open, "to_open": a_open}
        except Exception as e:
            logger.warning("Warning: Failed to compare switch states: %s", e)
        return changed
