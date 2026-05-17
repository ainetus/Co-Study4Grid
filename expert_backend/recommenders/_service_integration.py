# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0
"""Glue between :class:`RecommenderService` and the recommender registry.

Kept here, away from ``recommender_service.py`` and ``analysis_mixin.py``,
so the diff stays focused on what actually changes — the rest of the
service (network loading, NAD diagrams, simulation, ...) is fully
untouched. Three concerns are handled:

1. State + getters (model name, overflow-graph toggle) attached via
   :class:`ModelSelectionMixin`.
2. ``update_config`` wrapped to capture the two new fields from
   ``ConfigRequest`` every time the operator applies settings.
3. ``run_analysis_step2`` replaced with a model-aware generator that
   builds the recommender via the registry, conditionally skips the
   overflow-graph step, and threads the recommender through to
   ``run_analysis_step2_discovery``.

Applied by ``expert_backend/recommenders/__init__.py`` as a side-effect
of importing the package.
"""
from __future__ import annotations

import logging
import time

from expert_backend.recommenders.registry import build_recommender
from expert_backend.services.model_selection_mixin import ModelSelectionMixin
from expert_backend.services.recommender_service import (
    RecommenderService,
    recommender_service,
)
from expert_backend.services.sanitize import sanitize_for_json

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------
# 1. Attach ModelSelectionMixin members to RecommenderService.
# ---------------------------------------------------------------------
for _attr in (
    "_DEFAULT_MODEL",
    "_DEFAULT_COMPUTE_OVERFLOW_GRAPH",
    "_reset_model_settings",
    "_apply_model_settings",
    "get_active_model_name",
    "get_compute_overflow_graph",
):
    setattr(RecommenderService, _attr, getattr(ModelSelectionMixin, _attr))

# Initialise the existing singleton so any code that pokes at the
# getters before /api/config is called sees the defaults.
recommender_service._reset_model_settings()


# ---------------------------------------------------------------------
# 2. Wrap update_config to capture model + toggle.
# ---------------------------------------------------------------------
_orig_update_config = RecommenderService.update_config


def _update_config_with_model(self, settings):
    # Capture model selection FIRST so any downstream logging in the
    # original method sees the resolved values.
    self._apply_model_settings(settings)
    return _orig_update_config(self, settings)


RecommenderService.update_config = _update_config_with_model


# ---------------------------------------------------------------------
# 3. Wrap reset so model state is cleared along with the rest.
# ---------------------------------------------------------------------
_orig_reset = RecommenderService.reset


def _reset_with_model(self):
    self._reset_model_settings()
    return _orig_reset(self)


RecommenderService.reset = _reset_with_model


# ---------------------------------------------------------------------
# 4. Model-aware run_analysis_step2 — conditional graph build +
#    pluggable recommender dispatch.
# ---------------------------------------------------------------------
def _run_analysis_step2_with_model(
    self,
    selected_overloads,
    all_overloads=None,
    monitor_deselected=False,
    additional_lines_to_cut=None,
):
    """Generator yielding ``pdf`` and ``result`` NDJSON events.

    Drop-in replacement for ``AnalysisMixin.run_analysis_step2``. Same
    inputs and event shape so the FastAPI route and the React frontend
    don't need to change. Differences:

    - Builds the recommender from the registry (``settings.model``).
    - Runs ``run_analysis_step2_graph`` when the chosen model REQUIRES
      the overflow graph (``requires_overflow_graph=True``), OR when the
      operator explicitly opted into computing it via
      ``compute_overflow_graph=True``. A model that declares it requires
      the graph cannot be skipped — the toggle is enforced server-side
      so that direct API calls cannot bypass the requirement either
      (mirrors the UI lock on the Settings → Recommender checkbox).
    - Passes the recommender to ``run_analysis_step2_discovery`` so the
      dispatch happens at the library boundary.
    """
    # Resolve the upstream library helpers via ``analysis_mixin`` so
    # that existing test patches on
    # ``expert_backend.services.analysis_mixin.run_analysis_step2_graph``
    # (and ``…_discovery``) — the long-standing seam used by the
    # legacy step-2 generator — still intercept the calls here.
    # Looking up the attributes at call time (not at import) is what
    # makes the patch effective: replacing the module-level binding on
    # ``analysis_mixin`` is observed by the next ``getattr``.
    from expert_op4grid_recommender import config
    from expert_backend.services import analysis_mixin

    if not self._analysis_context:
        raise ValueError("Analysis context not found. Run step 1 first.")

    try:
        recommender = build_recommender(self.get_active_model_name())
    except KeyError as exc:
        yield {"type": "error", "message": str(exc)}
        return

    # OR (not AND): a model that declares `requires_overflow_graph=True`
    # always runs the graph step, even if the client somehow sent
    # `compute_overflow_graph=False`. The operator opt-in flag only
    # affects models that don't intrinsically need the graph.
    needs_graph = (
        recommender.requires_overflow_graph
        or self.get_compute_overflow_graph()
    )

    # Overflow-graph fast path: the graph is model-INDEPENDENT — only
    # action discovery below consumes the recommender. So a re-run with
    # the same contingency + Step-2 inputs (selected overloads, monitor
    # toggle, additional-lines picker) but a different model reuses the
    # cached graph and skips `_narrow_context_to_selected_overloads` +
    # `run_analysis_step2_graph` + the PDF mtime poll entirely. The
    # signature / reuse-decision helpers live on `AnalysisMixin` so this
    # production replacement and the legacy generator share them.
    step2_signature = self._step2_graph_signature(
        selected_overloads, all_overloads, monitor_deselected, additional_lines_to_cut,
    )
    reuse_graph = needs_graph and self._can_reuse_step2_graph(step2_signature)

    # Per-stage timings (seconds). Reported back to the frontend so the
    # operator can see the breakdown of an analysis run. ``overflow_graph``
    # is None when the model does not consume the overflow graph (no time
    # was spent there); cached re-runs report 0.0 so a model swap is
    # distinguishable from a fresh run.
    # ``overflow_graph_time`` covers the full graph-building phase:
    # ``_narrow_context_to_selected_overloads`` + ``run_analysis_step2_graph``
    # + the PDF mtime poll. That matches what the operator sees as
    # "overflow analysis is appearing on screen".
    overflow_graph_time: float | None = None
    action_prediction_time: float = 0.0
    assessment_time: float = 0.0
    # Enrichment = Co-Study4Grid post-processing AFTER assessment
    # (action enrichment + combined-pair target_max_rho augmentation
    # + MW-start scoring). Distinct from assessment because it is
    # not part of the upstream library's discovery pipeline.
    enrichment_time: float = 0.0
    # Step 1 (contingency simulation + overload detection) ran in a
    # separate HTTP call. We carry the value through via service state
    # so the single ``result`` event surfaces the FULL backend breakdown.
    step1_time: float | None = getattr(self, "_last_step1_time", None)

    try:
        if reuse_graph:
            logger.info(
                "[Step 2] model=%s reusing cached overflow graph (signature unchanged)",
                recommender.name,
            )
            context = self._last_step2_context
            produced_pdf = self._overflow_layout_cache.get("hierarchical")
            overflow_graph_time = 0.0
            yield {"type": "pdf", "pdf_path": produced_pdf, "cached": True,
                   "overflow_graph_time": overflow_graph_time}
        else:
            # Time the entire graph-building phase: narrow + library
            # call + PDF poll. That matches what the operator perceives
            # as "the overflow graph appearing on screen".
            _graph_phase_t0 = time.time()
            context = self._narrow_context_to_selected_overloads(
                self._analysis_context,
                selected_overloads,
                all_overloads,
                monitor_deselected,
                additional_lines_to_cut=additional_lines_to_cut,
            )
            analysis_start_time = time.time()
            self._overflow_layout_cache = {}
            self._overflow_layout_mode = "hierarchical"
            if needs_graph:
                context = analysis_mixin.run_analysis_step2_graph(context)
                produced_pdf = self._get_latest_pdf_path(analysis_start_time)
                overflow_graph_time = time.time() - _graph_phase_t0
                if produced_pdf:
                    self._overflow_layout_cache["hierarchical"] = produced_pdf
                self._last_step2_context = context
                self._last_step2_signature = step2_signature
                yield {"type": "pdf", "pdf_path": produced_pdf,
                       "overflow_graph_time": overflow_graph_time}
            else:
                # Model does not consume the overflow graph: emit an empty
                # `pdf` event so the frontend knows it should not wait for
                # an overflow HTML to appear. No graph is cached, so clear
                # the signature too — a later graph-requiring run must
                # never false-hit on it.
                self._last_step2_context = None
                self._last_step2_signature = None
                yield {"type": "pdf", "pdf_path": None}

        # Drive action discovery here (instead of through the
        # ``run_analysis_step2_discovery`` wrapper) so we can time the
        # two distinct sub-steps separately and surface them to the
        # operator. The discovery wrapper itself just chains:
        #   recommend()                  → action_prediction
        #   reassess_prioritized_actions
        #   propagate_non_convergence_to_scores
        #   compute_combined_pairs       → action_assessment
        # The split here matches what an operator means by
        # "prediction" (the model selects actions) vs. "assessment"
        # (each picked action is re-simulated to compute its actual
        # rho_before / rho_after).
        from expert_op4grid_recommender.utils.reassessment import (
            build_recommender_inputs,
            compute_combined_pairs,
            propagate_non_convergence_to_scores,
            reassess_prioritized_actions,
        )

        params = {"n_prioritized_actions": config.N_PRIORITIZED_ACTIONS}
        # Run the expert action filter when the overflow graph is
        # available (same behaviour as ``run_analysis_step2_discovery``).
        # The function lives in upstream ``main`` as a private helper —
        # accessed via getattr so an older library without it is silently
        # skipped (no behavioural regression on the random path).
        from expert_op4grid_recommender import main as _upstream_main
        _run_expert_action_filter = getattr(
            _upstream_main, "_run_expert_action_filter", None,
        )
        if _run_expert_action_filter is not None and context.get("g_distribution_graph") is not None:
            _run_expert_action_filter(context)

        inputs = build_recommender_inputs(context)
        _t_predict = time.time()
        output = recommender.recommend(inputs, params)
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

        # Co-Study4Grid post-processing (enrichment + target_max_rho
        # augmentation + MW-start scoring). Measured separately from
        # ``assessment_time`` because it is not part of the upstream
        # library's discovery pipeline — it's pure wrapping logic that
        # decorates the recommender output with UI-facing details.
        _t_enrich = time.time()
        enriched_actions = self._enrich_actions(
            results["prioritized_actions"],
            lines_overloaded_names=results.get("lines_overloaded_names"),
        )
        enriched_actions = {
            aid: data for aid, data in enriched_actions.items() if "+" not in aid
        }

        # Only the expert model populates `combined_actions` with the
        # `target_max_rho` decoration; for random models the call is a
        # no-op (combined_actions is empty), so we keep it unconditional.
        self._augment_combined_actions_with_target_max_rho(results, context)
        action_scores = self._compute_mw_start_for_scores(
            results.get("action_scores", {})
        )
        enrichment_time = time.time() - _t_enrich

        logger.info(
            "[Step 2] model=%s yielding result event with %d enriched actions "
            "(step1=%.2fs, overflow_graph=%.2fs, prediction=%.2fs, "
            "assessment=%.2fs, enrichment=%.2fs)",
            recommender.name, len(enriched_actions),
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
            "lines_we_care_about":
                list(lines_we_care_about) if lines_we_care_about is not None else None,
            "message": "Analysis completed",
            "dc_fallback": False,
            "active_model": recommender.name,
            "compute_overflow_graph": needs_graph,
            "step1_time": step1_time,
            "enrichment_time": enrichment_time,
            "overflow_graph_time": overflow_graph_time,
            "action_prediction_time": action_prediction_time,
            "assessment_time": assessment_time,
        })
    except Exception as e:
        logger.exception("Backend Error in Analysis Resolution")
        yield {
            "type": "error",
            "message": f"Backend Error in Analysis Resolution: {str(e)}",
        }


RecommenderService.run_analysis_step2 = _run_analysis_step2_with_model
