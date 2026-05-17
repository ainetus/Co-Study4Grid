# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0
# This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

"""Analysis mixin for RecommenderService.

Thin orchestrator around the four focused modules under
``services/analysis/``:

 - ``pdf_watcher``        — overflow PDF discovery
 - ``action_enrichment``  — per-action load / curtailment / PST details
 - ``mw_start_scoring``   — MW-at-start per action type
 - ``analysis_runner``    — legacy AC→DC worker + PDF polling

The mixin keeps the three public entry points (``run_analysis_step1``,
``run_analysis_step2``, ``run_analysis``) and the ``_enrich_actions``
iterator; everything else has been extracted to pure helpers that take
their dependencies as arguments (observations, network_service,
pst_tap_info callable).
"""

import logging
import os
import time

from expert_op4grid_recommender import config
from expert_op4grid_recommender.main import (
    Backend,
    run_analysis,  # re-exported for legacy @patch('…analysis_mixin.run_analysis')
    run_analysis_step1,
    run_analysis_step2_graph,
    run_analysis_step2_discovery,
)

# Re-exported so legacy tests can still patch
# ``expert_backend.services.analysis_mixin.get_virtual_line_flow``
# after the helpers were moved to ``analysis/mw_start_scoring``.
from expert_op4grid_recommender.utils.superposition import get_virtual_line_flow  # noqa: F401

from expert_backend.services.analysis.action_enrichment import (
    compute_curtailment_details,
    compute_load_shedding_details,
    compute_lines_overloaded_after,
    compute_pst_details,
    derive_non_convergence,
    extract_action_topology,
    is_renewable_gen,
    scale_rho_series,
)
from expert_backend.services.analysis.analysis_runner import (
    derive_analysis_message,
    run_with_pdf_polling,
)
from expert_backend.services.analysis.mw_start_scoring import (
    classify_action_type,
    get_action_mw_start,
    get_pst_tap_start,
    is_na_action_type,
)
from expert_backend.services.analysis.pdf_watcher import find_latest_pdf
from expert_backend.services.sanitize import sanitize_for_json
from expert_backend.services.simulation_helpers import (
    compute_combined_rho,
    compute_target_max_rho,
)

logger = logging.getLogger(__name__)


def _upstream_step1_supports_prebuilt_obs() -> bool:
    """True when the installed ``expert_op4grid_recommender`` accepts the
    ``prebuilt_obs_simu_defaut`` kwarg on ``run_analysis_step1``.

    Older releases do not, so we keep working against them by skipping
    the kwarg when missing. Resolved lazily (and not cached) so a hot
    reload picks up an upgraded library without a restart.
    """
    try:
        import inspect
        return "prebuilt_obs_simu_defaut" in inspect.signature(run_analysis_step1).parameters
    except (TypeError, ValueError):
        return False


class AnalysisMixin:
    """Mixin providing contingency analysis and action enrichment methods."""

    # ------------------------------------------------------------------
    # Dependency adapters — resolve the instance-level state that the
    # stateless helpers under ``services/analysis/`` need injected.
    # ------------------------------------------------------------------

    def _network_service(self):
        # Lazy import avoids circular dependency during module load.
        from expert_backend.services.network_service import network_service
        return network_service

    def _pst_tap_info_fn(self):
        """Return a callable pst_name → {'tap', 'low_tap', 'high_tap'} | None.

        Falls through to ``None`` when the simulation environment is
        not ready (tests bypassing ``update_config`` / setup errors).
        """
        try:
            env = self._get_simulation_env()
            nm = env.network_manager
        except Exception as e:
            logger.debug("Suppressed exception: %s", e)
            return None
        return nm.get_pst_tap_info

    def _obs_n1_from_context(self):
        """Return the N-1 observation captured by step1, or None."""
        if self._analysis_context and "obs_simu_defaut" in self._analysis_context:
            return self._analysis_context["obs_simu_defaut"]
        return None

    # ------------------------------------------------------------------
    # Per-action detail computations — instance wrappers so existing
    # tests that patch ``self._compute_*_details`` keep working.
    # ------------------------------------------------------------------

    def _compute_load_shedding_details(self, action_data, obs_n1=None):
        """Per-load shedding MW details (delegates to the stateless helper)."""
        return compute_load_shedding_details(
            action_data,
            obs_n1 if obs_n1 is not None else self._obs_n1_from_context(),
            self._network_service(),
        )

    def _compute_curtailment_details(self, action_data, obs_n1=None):
        """Per-generator curtailment MW details (delegates to the stateless helper)."""
        # Forward ``self._is_renewable_gen`` so tests that patch that
        # method on the instance keep working after the extraction.
        return compute_curtailment_details(
            action_data,
            obs_n1 if obs_n1 is not None else self._obs_n1_from_context(),
            self._network_service(),
            is_renewable_fn=lambda gen_name, obs: self._is_renewable_gen(gen_name, obs=obs),
        )

    def _compute_pst_details(self, action_data):
        """Per-PST tap details with current bounds (delegates to the stateless helper)."""
        return compute_pst_details(action_data, self._pst_tap_info_fn())

    def _is_renewable_gen(self, gen_name, obs=None):
        """WIND / SOLAR generator check (delegates to the stateless helper)."""
        return is_renewable_gen(gen_name, obs, self._network_service())

    # ------------------------------------------------------------------
    # Action enrichment — iterates the discovery-engine output and
    # adds presentation-layer fields for the frontend.
    # ------------------------------------------------------------------

    def _enrich_actions(self, prioritized_actions_dict, lines_overloaded_names=None):
        """Convert raw prioritized actions into an enriched, JSON-ready dict.

        Scales raw rho values by ``monitoring_factor``, backfills
        ``lines_overloaded_after`` when the discovery engine leaves it
        empty, extracts action topology, and attaches load
        shedding / curtailment / PST details when applicable.
        """
        monitoring_factor = getattr(config, "MONITORING_FACTOR_THERMAL_LIMITS", 0.95)
        enriched_actions = {}
        for action_id, action_data in prioritized_actions_dict.items():
            rho_before_raw = action_data.get("rho_before")
            rho_after_raw = action_data.get("rho_after")
            max_rho_raw = action_data.get("max_rho")
            max_rho_line = action_data.get("max_rho_line", "")

            rho_before = scale_rho_series(rho_before_raw, monitoring_factor)
            rho_after = scale_rho_series(rho_after_raw, monitoring_factor)
            max_rho = (max_rho_raw * monitoring_factor) if max_rho_raw is not None else None

            non_convergence = derive_non_convergence(action_data)

            lines_overloaded_after = compute_lines_overloaded_after(
                action_data.get("lines_overloaded_after"),
                rho_after_raw,
                lines_overloaded_names,
                max_rho_raw,
                max_rho_line,
            )

            enriched = {
                "description_unitaire": action_data.get("description_unitaire") or "No description available",
                "rho_before": sanitize_for_json(rho_before),
                "rho_after": sanitize_for_json(rho_after),
                "max_rho": sanitize_for_json(max_rho),
                "max_rho_line": max_rho_line,
                "is_rho_reduction": bool(action_data.get("is_rho_reduction", False)),
                "non_convergence": non_convergence,
                "lines_overloaded_after": sanitize_for_json(lines_overloaded_after),
            }

            action_obj = action_data.get("action")
            if action_obj is not None:
                enriched["action_topology"] = extract_action_topology(
                    action_obj, action_id, self._dict_action
                )

            load_shedding = self._compute_load_shedding_details(action_data)
            if load_shedding:
                enriched["load_shedding_details"] = load_shedding

            curtailment = self._compute_curtailment_details(action_data)
            if curtailment:
                enriched["curtailment_details"] = curtailment

            pst_details = self._compute_pst_details(action_data)
            if pst_details:
                enriched["pst_details"] = pst_details

            enriched_actions[action_id] = enriched
        return enriched_actions

    # ------------------------------------------------------------------
    # MW-at-start scoring — builds name→index lookups from the cached
    # obs_n1 once and delegates per-action math to mw_start_scoring.
    # ------------------------------------------------------------------

    def _compute_mw_start_for_scores(self, action_scores):
        """Add ``mw_start`` (and ``tap_start`` for PST) to each action-type entry."""
        if not action_scores:
            return action_scores
        obs_n1 = self._obs_n1_from_context()
        if obs_n1 is None:
            return action_scores

        line_idx = {name: i for i, name in enumerate(obs_n1.name_line)}
        load_idx = {name: i for i, name in enumerate(obs_n1.name_load)}
        gen_idx = {name: i for i, name in enumerate(obs_n1.name_gen)}

        pst_info_fn = self._pst_tap_info_fn()
        for action_type, type_data in action_scores.items():
            scores = type_data.get("scores", {})
            if not scores:
                continue
            is_pst = classify_action_type(action_type) == "pst"
            mw_start: dict = {}
            tap_start: dict | None = {} if is_pst else None

            for action_id in scores:
                if is_na_action_type(action_type):
                    mw_start[action_id] = None
                    continue
                action_entry = self._dict_action.get(action_id) if self._dict_action else None
                mw_start[action_id] = get_action_mw_start(
                    action_id, action_type, obs_n1, line_idx, load_idx, gen_idx, action_entry,
                    # Look up the module-level symbol at call time so tests
                    # patching ``analysis_mixin.get_virtual_line_flow`` take effect.
                    virtual_line_flow_fn=get_virtual_line_flow,
                )
                if is_pst:
                    tap_start[action_id] = get_pst_tap_start(
                        action_entry, self._initial_pst_taps, pst_info_fn
                    )

            type_data["mw_start"] = sanitize_for_json(mw_start)
            if tap_start is not None:
                type_data["tap_start"] = sanitize_for_json(tap_start)
        return action_scores

    def _get_pst_tap_start(self, action_id):
        """Public-style wrapper kept for tests that patch this method directly."""
        action_entry = self._dict_action.get(action_id) if self._dict_action else None
        return get_pst_tap_start(action_entry, self._initial_pst_taps, self._pst_tap_info_fn())

    def _get_action_mw_start(self, action_id, action_type, obs_n1, line_idx_map, load_idx_map, gen_idx_map):
        """Public-style wrapper kept for tests that patch this method directly."""
        action_entry = self._dict_action.get(action_id) if self._dict_action else None
        return get_action_mw_start(
            action_id, action_type, obs_n1, line_idx_map, load_idx_map, gen_idx_map, action_entry,
            virtual_line_flow_fn=get_virtual_line_flow,
        )

    def _mw_start_open_coupling(self, set_bus, obs_n1, line_idx_map, load_idx_map):
        """Legacy wrapper — tests call this directly against a service instance."""
        from expert_backend.services.analysis.mw_start_scoring import mw_start_open_coupling
        return mw_start_open_coupling(
            set_bus, obs_n1, line_idx_map, load_idx_map,
            virtual_line_flow_fn=get_virtual_line_flow,
        )

    def _mw_start_load_shedding(self, action_id, action_entry, obs_n1, load_idx_map):
        """Legacy wrapper — tests call this directly against a service instance."""
        from expert_backend.services.analysis.mw_start_scoring import mw_start_load_shedding
        return mw_start_load_shedding(action_id, action_entry, obs_n1, load_idx_map)

    def _mw_start_curtailment(self, action_id, action_entry, obs_n1, gen_idx_map):
        """Legacy wrapper — tests call this directly against a service instance."""
        from expert_backend.services.analysis.mw_start_scoring import mw_start_curtailment
        return mw_start_curtailment(action_id, action_entry, obs_n1, gen_idx_map)

    # ------------------------------------------------------------------
    # PDF helpers
    # ------------------------------------------------------------------

    def _get_latest_pdf_path(self, analysis_start_time=None):
        """Find the newest overflow PDF (delegates to ``pdf_watcher``)."""
        return find_latest_pdf(config.SAVE_FOLDER_VISUALIZATION, analysis_start_time)

    # ------------------------------------------------------------------
    # Overflow-graph layout toggle
    # ------------------------------------------------------------------

    def regenerate_overflow_graph(self, mode: str) -> dict:
        """Regenerate (or serve from cache) the overflow graph in the
        requested layout mode. Returns ``{pdf_path, mode, cached}``.

        Hierarchical mode just returns the file ``run_analysis_step2``
        already produced (always cached under ``"hierarchical"``).
        Geo mode runs a pure-SVG transform over that hierarchical HTML
        using coordinates from ``grid_layout.json`` — no graphviz
        re-run, no ``env.name_sub`` alignment, no dependency on
        ``alphaDeesp`` custom-layout support. Both results are cached
        per mode for instant subsequent toggles.
        """
        if mode not in ("hierarchical", "geo"):
            raise ValueError(
                f"Unknown overflow layout mode: {mode!r}; expected 'hierarchical' or 'geo'."
            )

        cached_path = self._overflow_layout_cache.get(mode)
        if cached_path and os.path.isfile(cached_path):
            self._overflow_layout_mode = mode
            logger.info("[Overflow] Serving cached %s graph: %s", mode, cached_path)
            return {"pdf_path": cached_path, "mode": mode, "cached": True}

        hierarchical_path = self._overflow_layout_cache.get("hierarchical")
        if not hierarchical_path or not os.path.isfile(hierarchical_path):
            raise ValueError(
                "No hierarchical overflow HTML to transform. Run the analysis "
                "(Step 2) first."
            )

        if mode == "hierarchical":
            # Must have been cached by run_analysis_step2 — we only
            # arrive here on a cache miss, which for hierarchical only
            # happens when someone cleared the cache while the file
            # still exists on disk. Just re-register it.
            self._overflow_layout_mode = "hierarchical"
            self._overflow_layout_cache["hierarchical"] = hierarchical_path
            return {"pdf_path": hierarchical_path, "mode": mode, "cached": False}

        # mode == "geo" — transform the hierarchical HTML in-place.
        from expert_backend.services.analysis.overflow_geo_transform import transform_html

        layout = self._load_layout_coords()
        if not layout:
            raise ValueError(
                "Cannot render in geo mode: no grid_layout.json is configured. "
                "Set the Layout File path in Settings and re-run the analysis."
            )

        with open(hierarchical_path, "r", encoding="utf-8") as f:
            hierarchical_html = f.read()
        try:
            geo_html = transform_html(hierarchical_html, layout)
        except ValueError as e:
            raise ValueError(f"Cannot render in geo mode: {e}") from e

        root, ext = os.path.splitext(hierarchical_path)
        geo_path = f"{root}_geo{ext}"
        with open(geo_path, "w", encoding="utf-8") as f:
            f.write(geo_html)
        self._overflow_layout_mode = "geo"
        self._overflow_layout_cache["geo"] = geo_path
        logger.info("[Overflow] Wrote geo-layout graph: %s", geo_path)
        return {"pdf_path": geo_path, "mode": mode, "cached": False}

    # ------------------------------------------------------------------
    # Public entry points — two-step + legacy single-step.
    # ------------------------------------------------------------------

    def run_analysis_step1(self, disconnected_elements):
        """Step 1 — contingency simulation + overload detection.

        ``disconnected_elements`` may be a single string (legacy) or a
        list of element IDs to disconnect simultaneously, enabling
        N-K (multi-element) contingency studies.
        """
        norm = self._normalize_contingency_elements(disconnected_elements)
        # Variant guard: drain the NAD prefetch + pin to N before grid2op
        # starts switching variants on the shared Network.
        # See docs/performance/history/grid2op-shared-network.md.
        self._ensure_n_state_ready()
        _t0 = time.time()
        # Re-use the post-contingency observation pre-warmed by
        # ``get_contingency_diagram`` if the cache key still matches the
        # contingency we are about to analyse. Saves a redundant AC load
        # flow (the heaviest step in the pipeline) on every analysis run.
        # Cache miss / mismatch falls back to the upstream
        # ``simulate_contingency_pypowsybl`` path inside ``run_analysis_step1``.
        # SAFETY GATE: the diagram path applies the contingency only —
        # NOT any maintenance reconnections. With the default
        # ``DO_RECO_MAINTENANCE=False`` the analysis path also skips
        # those reconnections (empty action), so the two states are
        # equivalent and the cache is safe to reuse. When the operator
        # opts into maintenance reconnections, fall back to the full
        # path so the analysis state matches the upstream contract.
        prebuilt_obs = None
        cont_variant = self._contingency_variant_id(list(norm))
        cache_safe = not getattr(config, "DO_RECO_MAINTENANCE", False)
        if (
            cache_safe
            and getattr(self, "_cached_obs_n1", None) is not None
            and getattr(self, "_cached_obs_n1_id", None) == cont_variant
            and getattr(self, "_cached_obs_n1_elements", None) == tuple(norm)
        ):
            prebuilt_obs = self._cached_obs_n1
            logger.info(
                "[Step 1] Re-using cached post-contingency obs for %s "
                "(skips contingency load-flow)", list(norm),
            )
        try:
            step1_kwargs = {
                "analysis_date": config.DATE,
                "current_timestep": config.TIMESTEP,
                "current_lines_defaut": list(norm),
                "backend": Backend.PYPOWSYBL,
                "fast_mode": getattr(config, "PYPOWSYBL_FAST_MODE", True),
                "dict_action": self._dict_action,
                "prebuilt_env_context": self._cached_env_context,
            }
            # ``prebuilt_obs_simu_defaut`` is only on recent upstream
            # releases; gracefully fall back to the full path when the
            # installed library does not accept the kwarg. Saves the
            # operator from a synced-pull requirement.
            if prebuilt_obs is not None and _upstream_step1_supports_prebuilt_obs():
                step1_kwargs["prebuilt_obs_simu_defaut"] = prebuilt_obs
            elif prebuilt_obs is not None:
                logger.info(
                    "[Step 1] Cached obs available but the installed "
                    "expert_op4grid_recommender lacks ``prebuilt_obs_simu_defaut`` "
                    "support — falling back to the full contingency simulation."
                )
            res_step1, context = run_analysis_step1(**step1_kwargs)
            self._last_disconnected_elements = list(norm)
            # Stash the wall-clock so step 2 can forward it to the result
            # event — the React UI shows the full breakdown including
            # this contingency-simulation slice.
            step1_time = time.time() - _t0
            self._last_step1_time = step1_time

            if res_step1 is not None:
                self._analysis_context = None
                return {
                    "lines_overloaded": res_step1.get("lines_overloaded_names", []),
                    "message": "No overloads detected or grid broken apart.",
                    "can_proceed": False,
                    "step1_time": step1_time,
                }

            self._analysis_context = context
            return {
                "lines_overloaded": context["lines_overloaded_names"],
                "message": f"Detected {len(context['lines_overloaded_names'])} overloads.",
                "can_proceed": True,
                "step1_time": step1_time,
            }
        except Exception:
            self._analysis_context = None
            raise

    # ------------------------------------------------------------------
    # Step-2 overflow-graph cache helpers — shared by the legacy
    # ``run_analysis_step2`` below AND the model-aware production
    # replacement in ``expert_backend/recommenders/_service_integration.py``.
    # Kept as plain methods on the mixin so both code paths (and their
    # unit tests) reuse the exact same signature + reuse-decision logic.
    # ------------------------------------------------------------------

    def _step2_graph_signature(
        self,
        selected_overloads,
        all_overloads,
        monitor_deselected,
        additional_lines_to_cut,
    ) -> tuple:
        """Input signature gating the Step-2 overflow-graph cache.

        When the operator re-runs the analysis against the same
        contingency + the same Step-2 inputs (selected overloads,
        monitor toggle, additional-lines picker), the OverFlowGraph and
        the HTML viewer it produces are byte-for-byte identical — only
        the recommender model (consumed by action discovery) may have
        changed. A matching signature lets ``run_analysis_step2`` skip
        ``_narrow_context_to_selected_overloads`` +
        ``run_analysis_step2_graph`` + the PDF mtime poll, so swapping
        only the model is near-instant.
        """
        return (
            tuple(self._last_disconnected_elements or []),
            tuple(sorted(selected_overloads or [])),
            tuple(sorted(all_overloads or [])),
            bool(monitor_deselected),
            tuple(sorted(additional_lines_to_cut or [])),
        )

    def _can_reuse_step2_graph(self, signature: tuple) -> bool:
        """True when the cached overflow graph still matches ``signature``.

        Requires the previous run to have stored the same signature,
        kept its enriched ``_last_step2_context``, and left the produced
        hierarchical HTML on disk.
        """
        cached_pdf = self._overflow_layout_cache.get("hierarchical")
        return (
            getattr(self, "_last_step2_signature", None) == signature
            and self._last_step2_context is not None
            and cached_pdf is not None
            and os.path.exists(cached_pdf)
        )

    def run_analysis_step2(
        self,
        selected_overloads: list[str],
        all_overloads: list[str] = None,
        monitor_deselected: bool = False,
        additional_lines_to_cut: list[str] = None,
    ):
        """Step 2 — PDF emission + action discovery, streaming NDJSON events.

        ``additional_lines_to_cut`` is the operator-supplied set of extra
        line names (ExpertAgent's `additionalLinesToCut`/`ltc` semantic).
        They are routed to ``context["extra_lines_to_cut_ids"]`` (line
        indices) which the upstream library reads and forwards to
        ``OverFlowGraph(extra_lines_to_cut=…)`` so the simulation cuts
        them like overloads but the viewer keeps them out of the
        ``Overloads`` / ``Low margin lines`` layers (they show up
        under the dedicated ``Extra lines to prevent flow increase``
        layer instead).  Names also stay in ``lines_we_care_about`` so
        monitoring is not silently lost.

        No ``_ensure_*_state_ready`` guard here: step2 inherits the
        ``_analysis_context`` positioned by step1 (observations,
        monitored lines, …).  The NAD prefetch worker was already drained
        by step1 earlier in the same session.
        """
        if not self._analysis_context:
            raise ValueError("Analysis context not found. Run step 1 first.")

        # Overflow-graph fast path — see `_step2_graph_signature` /
        # `_can_reuse_step2_graph`. The shared helpers are used by the
        # model-aware production replacement too, so a re-run with only
        # the recommender model changed skips the graph rebuild.
        step2_signature = self._step2_graph_signature(
            selected_overloads, all_overloads, monitor_deselected, additional_lines_to_cut,
        )
        reuse_graph = self._can_reuse_step2_graph(step2_signature)

        # Per-stage timings (seconds), forwarded to the result event so
        # the frontend can display a per-stage breakdown next to
        # "Suggestions produced by …". ``overflow_graph_time`` covers
        # the full graph-building phase (narrow + library call + PDF
        # poll); ``enrichment_time`` is the Co-Study4Grid post-process
        # that decorates the recommender output; ``step1_time`` is
        # carried from the previous step1 call via service state.
        overflow_graph_time: float | None = None
        action_prediction_time: float = 0.0
        assessment_time: float = 0.0
        enrichment_time: float = 0.0
        step1_time: float | None = getattr(self, "_last_step1_time", None)

        try:
            if reuse_graph:
                logger.info(
                    "[Step 2] Reusing cached overflow graph (signature unchanged)"
                )
                context = self._last_step2_context
                produced_pdf = self._overflow_layout_cache.get("hierarchical")
                overflow_graph_time = 0.0
                # Geo cache is keyed off the same hierarchical source; keep
                # whatever the previous run produced so the toggle stays
                # instant. `_overflow_layout_mode` is left untouched.
                yield {"type": "pdf", "pdf_path": produced_pdf, "cached": True,
                       "overflow_graph_time": overflow_graph_time}
            else:
                _graph_phase_t0 = time.time()
                context = self._narrow_context_to_selected_overloads(
                    self._analysis_context,
                    selected_overloads,
                    all_overloads,
                    monitor_deselected,
                    additional_lines_to_cut=additional_lines_to_cut,
                )
                analysis_start_time = time.time()
                # Fresh Step-2: drop any cached overflow files from a previous
                # contingency resolution. The library always produces the
                # hierarchical layout (graphviz `dot`); the Geo toggle is
                # handled by a pure SVG transform in the regen endpoint, NOT
                # by re-invoking the library. That keeps the analysis step
                # fast and deterministic regardless of layout-file state.
                self._overflow_layout_cache = {}
                self._overflow_layout_mode = "hierarchical"
                # Part 1: graph generation + HTML
                context = run_analysis_step2_graph(context)
                produced_pdf = self._get_latest_pdf_path(analysis_start_time)
                overflow_graph_time = time.time() - _graph_phase_t0
                if produced_pdf:
                    # Step-2 always produces the hierarchical layout — the
                    # regen endpoint transforms it into the geo layout on
                    # demand without re-invoking graphviz.
                    self._overflow_layout_cache["hierarchical"] = produced_pdf
                # Preserve the enriched context (kept for future features
                # that might need to re-run graph generation). The Geo
                # toggle itself no longer uses this.
                self._last_step2_context = context
                self._last_step2_signature = step2_signature
                yield {"type": "pdf", "pdf_path": produced_pdf,
                       "overflow_graph_time": overflow_graph_time}

            # Part 2: action discovery — drive the upstream sub-steps
            # directly so we can time prediction vs. assessment.
            from expert_op4grid_recommender.utils.reassessment import (
                build_recommender_inputs,
                compute_combined_pairs,
                propagate_non_convergence_to_scores,
                reassess_prioritized_actions,
            )
            from expert_op4grid_recommender.models.expert import ExpertRecommender
            from expert_op4grid_recommender import main as _upstream_main

            _run_expert_action_filter = getattr(
                _upstream_main, "_run_expert_action_filter", None,
            )
            if _run_expert_action_filter is not None and context.get("g_distribution_graph") is not None:
                _run_expert_action_filter(context)

            inputs = build_recommender_inputs(context)
            params = {"n_prioritized_actions": config.N_PRIORITIZED_ACTIONS}
            _legacy_recommender = ExpertRecommender()
            _t_predict = time.time()
            output = _legacy_recommender.recommend(inputs, params)
            action_prediction_time = time.time() - _t_predict

            _t_assess = time.time()
            detailed_actions, pre_existing_info = reassess_prioritized_actions(
                output.prioritized_actions, context,
            )
            scores = propagate_non_convergence_to_scores(
                detailed_actions, output.action_scores,
            )
            combined_actions = compute_combined_pairs(detailed_actions, context)
            assessment_time = time.time() - _t_assess

            results = {
                "lines_overloaded_names": context["lines_overloaded_names"],
                "prioritized_actions": detailed_actions,
                "action_scores": scores,
                "pre_existing_overloads": pre_existing_info,
                "combined_actions": combined_actions,
            }
            self._last_result = results

            _t_enrich = time.time()
            enriched_actions = self._enrich_actions(
                results["prioritized_actions"],
                lines_overloaded_names=results.get("lines_overloaded_names"),
            )
            # Never leak combined-action ids into the main actions feed —
            # those are estimations that live in `combined_actions`.
            enriched_actions = {aid: data for aid, data in enriched_actions.items() if "+" not in aid}

            # Enrich each pre-computed pair with a `target_max_rho` /
            # `target_max_rho_line` scoped to the user-selected overloads
            # — the UI can show this alongside the library's global
            # `max_rho` so the operator sees the pair's effect on the
            # contingency they're resolving even when linearisation
            # noise puts the global max on an off-target line.
            self._augment_combined_actions_with_target_max_rho(results, context)

            action_scores = self._compute_mw_start_for_scores(results.get("action_scores", {}))
            enrichment_time = time.time() - _t_enrich

            logger.info(
                "[Step 2] Yielding final result event with %d enriched actions "
                "(step1=%.2fs, overflow_graph=%.2fs, prediction=%.2fs, "
                "assessment=%.2fs, enrichment=%.2fs)",
                len(enriched_actions),
                step1_time if step1_time is not None else -1.0,
                overflow_graph_time if overflow_graph_time is not None else -1.0,
                action_prediction_time, assessment_time, enrichment_time,
            )
            lines_we_care_about = context.get("lines_we_care_about")
            yield sanitize_for_json({
                "type": "result",
                "actions": enriched_actions,
                "action_scores": action_scores,
                "lines_overloaded": results["lines_overloaded_names"],
                "pre_existing_overloads": results.get("pre_existing_overloads", []),
                "combined_actions": results.get("combined_actions", {}),
                "lines_we_care_about": list(lines_we_care_about) if lines_we_care_about is not None else None,
                "active_model": (
                    self.get_active_model_name()
                    if hasattr(self, "get_active_model_name")
                    else None
                ),
                "message": "Analysis completed",
                "dc_fallback": False,
                "step1_time": step1_time,
                "overflow_graph_time": overflow_graph_time,
                "action_prediction_time": action_prediction_time,
                "assessment_time": assessment_time,
                "enrichment_time": enrichment_time,
            })
        except Exception as e:
            logger.exception("Backend Error in Analysis Resolution")
            yield {"type": "error", "message": f"Backend Error in Analysis Resolution: {str(e)}"}

    def _augment_combined_actions_with_target_max_rho(self, results: dict, context: dict) -> None:
        """Add ``target_max_rho`` / ``target_max_rho_line`` to each
        pre-computed pair in ``results['combined_actions']``.

        The target max is computed over ``context['lines_overloaded_ids']``
        only — the user-selected overloads that the pair is meant to
        resolve — using the same formula as the on-demand
        ``compute_superposition`` path.  Leaves ``max_rho`` /
        ``max_rho_line`` untouched so the global-scan warning for
        newly-introduced overloads is preserved (see
        ``test_superposition_max_rho_filtering_regression``).
        """
        combined_actions = results.get("combined_actions") or {}
        if not combined_actions:
            return
        obs_start = context.get("obs_simu_defaut")
        lines_overloaded_ids = context.get("lines_overloaded_ids") or []
        prioritized = results.get("prioritized_actions") or {}
        if obs_start is None or not lines_overloaded_ids:
            return

        try:
            name_line_list = list(obs_start.name_line)
        except Exception as e:
            logger.debug("target max_rho: cannot read name_line: %s", e)
            return
        monitoring_factor = float(getattr(config, "MONITORING_FACTOR_THERMAL_LIMITS", 0.95))

        for pair_id, pair in combined_actions.items():
            if not isinstance(pair, dict) or "error" in pair:
                continue
            betas = pair.get("betas")
            if not betas or len(betas) != 2:
                continue
            try:
                aid1, aid2 = [p.strip() for p in pair_id.split("+", 1)]
            except ValueError:
                continue
            obs1 = (prioritized.get(aid1) or {}).get("observation")
            obs2 = (prioritized.get(aid2) or {}).get("observation")
            if obs1 is None or obs2 is None:
                continue
            try:
                rho_combined = compute_combined_rho(obs_start, obs1, obs2, list(betas))
            except Exception as e:
                logger.debug("target max_rho: rho_combined failed for %s: %s", pair_id, e)
                continue
            target_max, target_line = compute_target_max_rho(
                rho_combined, name_line_list, list(lines_overloaded_ids),
            )
            pair["target_max_rho"] = target_max * monitoring_factor if target_max else 0.0
            pair["target_max_rho_line"] = target_line

    @staticmethod
    def _narrow_context_to_selected_overloads(
        context: dict,
        selected: list[str],
        all_overloads: list[str] | None,
        monitor_deselected: bool,
        additional_lines_to_cut: list[str] | None = None,
    ) -> dict:
        """Filter ``context`` in place to the operator-selected overload subset.

        Mutates and returns ``context`` — kept as a separate method so
        the step2 orchestrator stays readable.

        ``additional_lines_to_cut`` are operator-supplied lines that
        should be cut in the overflow-graph analysis like overloads but
        NOT classified as overloads in the viewer (ExpertAgent's
        ``additionalLinesToCut`` semantic). Names are mapped to
        ``obs_simu_defaut.name_line`` indices and exposed to the
        upstream library through ``context["extra_lines_to_cut_ids"]``
        — see ``Expert_op4grid_recommender`` ≥ 0.2.2 +
        ``ExpertOp4Grid``'s ``OverFlowGraph(extra_lines_to_cut=…)``
        which stamp ``is_extra_cut=True`` on those edges and skip
        them in ``is_overload`` / ``is_monitored``.
        Names are also kept in ``lines_we_care_about`` so monitoring
        stays aligned with the operator's selection.
        """
        all_names = context["lines_overloaded_names"]
        selected_indices = [i for i, name in enumerate(all_names) if name in selected]

        original_ids = context["lines_overloaded_ids"]
        new_ids = [original_ids[i] for i in selected_indices]
        context["lines_overloaded_ids"] = new_ids

        original_kept = set(context["lines_overloaded_ids_kept"])
        context["lines_overloaded_ids_kept"] = [idx for idx in new_ids if idx in original_kept]
        context["lines_overloaded_names"] = [all_names[i] for i in selected_indices]

        if not monitor_deselected and all_overloads:
            deselected = set(all_overloads) - set(selected)
            if deselected and context.get("lines_we_care_about") is not None:
                care = context["lines_we_care_about"]
                before = len(care)
                if isinstance(care, set):
                    context["lines_we_care_about"] = care - deselected
                elif isinstance(care, (list, tuple)):
                    context["lines_we_care_about"] = [n for n in care if n not in deselected]
                else:
                    context["lines_we_care_about"] = set(care) - deselected
                after = len(context["lines_we_care_about"])
                logger.info(
                    "[Step2] Excluded %d deselected overloads from monitoring: %s",
                    before - after, deselected,
                )
                logger.info("[Step2] lines_we_care_about: %d -> %d", before, after)
        else:
            logger.info(
                "[Step2] monitor_deselected=%s, all_overloads=%s -> NOT filtering lines_we_care_about",
                monitor_deselected, all_overloads,
            )

        # Always set the upstream extras channel — empty list when the
        # operator picked nothing — so the library reads a stable key.
        context["extra_lines_to_cut_ids"] = []

        if additional_lines_to_cut:
            obs_start = context.get("obs_simu_defaut")
            try:
                name_line = list(obs_start.name_line) if obs_start is not None else []
            except Exception as e:
                logger.warning("[Step2] additional_lines_to_cut: cannot read name_line (%s)", e)
                name_line = []
            name_to_idx = {name: i for i, name in enumerate(name_line)}

            existing_overloaded_ids = set(context["lines_overloaded_ids"])
            extra_ids: list[int] = []
            extra_names: list[str] = []
            unknown: list[str] = []
            seen_extra: set[int] = set()
            for name in additional_lines_to_cut:
                idx = name_to_idx.get(name)
                if idx is None:
                    unknown.append(name)
                    continue
                # If the operator picks something that is already a
                # selected overload, skip it — the line is already a
                # primary resolution target with full overload styling.
                if idx in existing_overloaded_ids or idx in seen_extra:
                    continue
                extra_ids.append(idx)
                extra_names.append(name)
                seen_extra.add(idx)

            if unknown:
                logger.warning(
                    "[Step2] additional_lines_to_cut: %d unknown line names skipped: %s",
                    len(unknown), unknown,
                )

            if extra_ids:
                context["extra_lines_to_cut_ids"] = extra_ids
                # Keep extras inside the monitoring scope; the deselect
                # filter above may have evicted them otherwise.
                care = context.get("lines_we_care_about")
                if care is not None:
                    if isinstance(care, set):
                        context["lines_we_care_about"] = care | set(extra_names)
                    elif isinstance(care, (list, tuple)):
                        merged = list(care)
                        for name in extra_names:
                            if name not in merged:
                                merged.append(name)
                        context["lines_we_care_about"] = merged
                    else:
                        context["lines_we_care_about"] = set(care) | set(extra_names)
                logger.info(
                    "[Step2] extra_lines_to_cut_ids: %d line(s) routed to upstream "
                    "(not classified as overloads): %s",
                    len(extra_names), extra_names,
                )

        return context

    def run_analysis(self, disconnected_elements):
        """Legacy single-step analysis — streams ``pdf`` then ``result`` NDJSON events.

        Accepts a single element ID (legacy) or a list of element IDs
        for N-K contingencies.
        """
        norm = self._normalize_contingency_elements(disconnected_elements)
        # Variant guard — grid2op will switch variants on the shared
        # Network as soon as the worker kicks in.
        self._ensure_n_state_ready()

        save_folder = config.SAVE_FOLDER_VISUALIZATION

        final_payload: dict | None = None
        # Pass module-level ``run_analysis`` so tests patching
        # ``expert_backend.services.analysis_mixin.run_analysis`` remain
        # effective after the extraction.
        for event in run_with_pdf_polling(
            list(norm), save_folder, runner_fn=run_analysis
        ):
            if event.get("_final"):
                final_payload = event
                break
            yield event

        assert final_payload is not None, "analysis_runner did not yield a final payload"

        result = final_payload["result"]
        output = final_payload["output"]
        analysis_message = derive_analysis_message(
            final_payload["analysis_message"], output, result
        )
        dc_fallback_used = final_payload["dc_fallback_used"]
        latest_pdf = final_payload["latest_pdf"]

        self._last_result = result
        self._last_disconnected_elements = list(norm)

        if result is None:
            enriched_actions: dict = {}
            lines_overloaded: list = []
            action_scores: dict = {}
        else:
            lines_overloaded = result.get("lines_overloaded_names", [])
            prioritized = result.get("prioritized_actions", {})
            action_scores = sanitize_for_json(result.get("action_scores", {}))
            action_scores = self._compute_mw_start_for_scores(action_scores)
            enriched_actions = self._enrich_actions(
                prioritized, lines_overloaded_names=lines_overloaded
            )

        network_service = self._network_service()
        total_branches = len(network_service.get_disconnectable_elements())
        monitored_branches = len(network_service.get_monitored_elements())
        excluded_branches = total_branches - monitored_branches
        info_msg = (
            f"Note: {monitored_branches} out of {total_branches} lines monitored "
            f"({excluded_branches} without permanent limits)."
        )
        analysis_message = f"{analysis_message} {info_msg}" if analysis_message else info_msg

        combined_actions = result.get("combined_actions", {}) if result else {}
        for data in combined_actions.values():
            data["is_estimated"] = True
        combined_actions = sanitize_for_json(combined_actions)

        # Never leak combined-action ids into the main actions feed — estimates
        # belong in `combined_actions`.
        enriched_actions = {aid: data for aid, data in enriched_actions.items() if "+" not in aid}

        care = self._analysis_context.get("lines_we_care_about") if self._analysis_context else None
        yield sanitize_for_json({
            "type": "result",
            "pdf_path": str(latest_pdf) if latest_pdf else None,
            "actions": enriched_actions,
            "action_scores": action_scores,
            "lines_overloaded": lines_overloaded,
            "combined_actions": combined_actions,
            "lines_we_care_about": list(care) if care is not None else None,
            "message": analysis_message,
            "dc_fallback": dc_fallback_used,
        })
