# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# SPDX-License-Identifier: MPL-2.0
"""Tests for the explicit RecommenderService ⇄ recommender-registry composition.

Successor of the orphaned root ``tests/test_service_integration.py``
(2026-07 D1 revision). The integration is no longer an import-time
monkey-patch: :class:`RecommenderService` inherits
:class:`ModelSelectionMixin` directly, ``update_config`` / ``reset``
call ``_apply_model_settings`` / ``_reset_model_settings`` themselves,
and the single, model-aware ``run_analysis_step2`` lives on
:class:`AnalysisMixin`. These tests pin that wiring — and would fail
loudly if anyone reintroduced a shadowing wrapper.

Needs the real ``expert_op4grid_recommender`` (``run_analysis_step2``
builds recommenders from the registry, whose package ``__init__``
imports the concrete model classes), so it is skipped under the
conftest mock layer.
"""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

pytest.importorskip("expert_op4grid_recommender.models.base")

from expert_backend.services.model_selection_mixin import ModelSelectionMixin  # noqa: E402
from expert_backend.services.recommender_service import (  # noqa: E402
    RecommenderService,
    recommender_service,
)


# ---------------------------------------------------------------------
# Composition wiring
# ---------------------------------------------------------------------

def test_service_inherits_model_selection_mixin():
    assert ModelSelectionMixin in RecommenderService.__mro__


def test_service_class_has_model_selection_helpers():
    for attr in (
        "get_active_model_name",
        "get_compute_overflow_graph",
        "_reset_model_settings",
        "_apply_model_settings",
    ):
        assert hasattr(RecommenderService, attr), f"missing {attr!r}"


def test_no_import_time_wrappers_remain():
    """The de-ghosting contract: production methods are the ones defined
    in their home modules — no ``_with_model`` wrapper shadows them."""
    assert RecommenderService.update_config.__name__ == "update_config"
    assert RecommenderService.reset.__name__ == "reset"
    assert RecommenderService.run_analysis_step2.__name__ == "run_analysis_step2"
    assert (
        RecommenderService.run_analysis_step2.__module__
        == "expert_backend.services.analysis_mixin"
    )


def test_singleton_has_default_model_state():
    # __init__ initialises the model-selection state, so the module-level
    # singleton exposes the defaults before /api/config is ever called.
    assert recommender_service.get_active_model_name() == "expert"
    assert recommender_service.get_compute_overflow_graph() is True


def test_fresh_instance_has_default_model_state():
    svc = RecommenderService()
    assert svc.get_active_model_name() == "expert"
    assert svc.get_compute_overflow_graph() is True


def test_reset_restores_model_defaults():
    svc = RecommenderService()
    svc._recommender_model_name = "random"
    svc._compute_overflow_graph = False
    svc.reset()
    assert svc.get_active_model_name() == "expert"
    assert svc.get_compute_overflow_graph() is True


def test_update_config_captures_model_selection(tmp_path):
    """``update_config`` applies the two model-selection fields itself
    (formerly done by an import-time wrapper)."""
    svc = RecommenderService()
    settings = SimpleNamespace(
        network_path=str(tmp_path / "net.xiidm"),
        action_file_path=str(tmp_path / "actions.json"),
        min_line_reconnections=2.0,
        min_close_coupling=3.0,
        min_open_coupling=2.0,
        min_line_disconnections=3.0,
        n_prioritized_actions=10,
        model="random_overflow",
        compute_overflow_graph=False,
    )
    with patch.object(RecommenderService, "prefetch_base_nad_async"), \
         patch(
             "expert_backend.services.recommender_service.load_actions",
             return_value={"disco_X": {"description": "d"}},
         ), \
         patch(
             "expert_backend.services.recommender_service.enrich_actions_lazy",
             side_effect=lambda raw, net: raw,
         ):
        svc.update_config(settings)
    assert svc.get_active_model_name() == "random_overflow"
    assert svc.get_compute_overflow_graph() is False


# ---------------------------------------------------------------------
# Model-aware run_analysis_step2 behaviour
# ---------------------------------------------------------------------

def test_run_analysis_step2_requires_context():
    """Without step-1 having populated the context, step-2 must error out."""
    svc = RecommenderService()
    svc._analysis_context = None
    gen = svc.run_analysis_step2(selected_overloads=[])
    with pytest.raises(ValueError, match="Analysis context not found"):
        next(gen)


def test_run_analysis_step2_emits_error_for_unknown_model():
    """Unknown model -> single error event then closes the stream."""
    svc = RecommenderService()
    # Fake a non-empty context so we reach the model build step.
    svc._analysis_context = {
        "lines_overloaded_names": [],
        "lines_overloaded_ids": [],
        "lines_overloaded_ids_kept": [],
        "lines_we_care_about": None,
    }
    svc._recommender_model_name = "__not_a_model__"
    svc._compute_overflow_graph = False

    events = list(svc.run_analysis_step2(
        selected_overloads=[],
        all_overloads=[],
        monitor_deselected=False,
        additional_lines_to_cut=[],
    ))

    assert len(events) == 1
    assert events[0]["type"] == "error"
    assert "__not_a_model__" in events[0]["message"]


# ---------------------------------------------------------------------
# Step-2 overflow-graph cache on the model-aware path.
#
# The overflow graph is model-INDEPENDENT — only action discovery
# consumes the recommender — so a re-run with the same contingency +
# Step-2 inputs but a different model must REUSE the cached graph and
# skip `run_analysis_step2_graph`.
# ---------------------------------------------------------------------

def _seed_step2_state(svc, tmp_path):
    """Put `svc` into the post-step1 state and stub the per-instance
    helpers so `run_analysis_step2` runs end to end without the heavy
    pipeline. Returns the fake produced-HTML path."""
    svc._reset_model_settings()
    svc._last_disconnected_elements = ["LINE_C"]
    svc._analysis_context = {
        "lines_overloaded_names": ["L1"],
        "lines_overloaded_ids": [0],
        "lines_overloaded_ids_kept": [0],
        "lines_we_care_about": None,
    }
    svc._last_step2_context = None
    svc._last_step2_signature = None
    svc._overflow_layout_cache = {}
    pdf = tmp_path / "overflow.html"
    pdf.write_text("<html></html>")
    svc._narrow_context_to_selected_overloads = MagicMock(side_effect=lambda ctx, *a, **k: ctx)
    svc._get_latest_pdf_path = MagicMock(return_value=str(pdf))
    svc._enrich_actions = MagicMock(return_value={})
    svc._augment_combined_actions_with_target_max_rho = MagicMock()
    svc._compute_mw_start_for_scores = MagicMock(return_value={})
    return str(pdf)


def _graph_required_recommender(name="expert"):
    rec = MagicMock()
    rec.requires_overflow_graph = True
    rec.name = name
    return rec


_DISCOVERY_RESULT = {
    "prioritized_actions": {},
    "action_scores": {},
    "lines_overloaded_names": ["L1"],
}


def test_unchanged_signature_reuses_overflow_graph(tmp_path):
    """Re-running with an identical signature (only the model swapped)
    skips `run_analysis_step2_graph` and reuses the cached graph —
    discovery still re-runs because it's the model-dependent step."""
    svc = RecommenderService()
    expected_pdf = _seed_step2_state(svc, tmp_path)

    with patch(
        "expert_backend.recommenders.registry.build_recommender",
        return_value=_graph_required_recommender(),
    ), patch(
        "expert_backend.services.analysis_mixin.run_analysis_step2_graph",
        side_effect=lambda ctx: ctx,
    ) as mock_graph, patch(
        "expert_backend.services.analysis_mixin.run_analysis_step2_discovery",
        return_value=dict(_DISCOVERY_RESULT),
    ) as mock_discovery:
        kwargs = dict(
            selected_overloads=["L1"], all_overloads=["L1"],
            monitor_deselected=False, additional_lines_to_cut=["EXTRA"],
        )
        # First run — builds the graph and seeds the cache.
        events1 = list(svc.run_analysis_step2(**kwargs))
        assert mock_graph.call_count == 1
        assert svc._last_step2_signature is not None
        pdf_event1 = next(e for e in events1 if e.get("type") == "pdf")
        assert pdf_event1["pdf_path"] == expected_pdf

        # Second run, identical signature — graph rebuild is skipped,
        # discovery re-runs (a model swap only affects discovery).
        events2 = list(svc.run_analysis_step2(**kwargs))
        assert mock_graph.call_count == 1            # NOT rebuilt
        assert mock_discovery.call_count == 2        # discovery re-ran
        pdf_event2 = next(e for e in events2 if e.get("type") == "pdf")
        assert pdf_event2["pdf_path"] == expected_pdf
        assert pdf_event2.get("cached") is True


def test_changed_additional_lines_rebuilds_overflow_graph(tmp_path):
    """Changing the `additional_lines_to_cut` hypothesis changes the
    signature, so the overflow graph MUST be rebuilt."""
    svc = RecommenderService()
    _seed_step2_state(svc, tmp_path)

    with patch(
        "expert_backend.recommenders.registry.build_recommender",
        return_value=_graph_required_recommender(),
    ), patch(
        "expert_backend.services.analysis_mixin.run_analysis_step2_graph",
        side_effect=lambda ctx: ctx,
    ) as mock_graph, patch(
        "expert_backend.services.analysis_mixin.run_analysis_step2_discovery",
        return_value=dict(_DISCOVERY_RESULT),
    ):
        list(svc.run_analysis_step2(
            selected_overloads=["L1"], all_overloads=["L1"],
            monitor_deselected=False, additional_lines_to_cut=["EXTRA"],
        ))
        assert mock_graph.call_count == 1

        list(svc.run_analysis_step2(
            selected_overloads=["L1"], all_overloads=["L1"],
            monitor_deselected=False, additional_lines_to_cut=["OTHER"],
        ))
        assert mock_graph.call_count == 2  # rebuilt for the new signature


def test_graph_skipping_model_does_not_reuse_or_seed_cache(tmp_path):
    """A model that doesn't need the overflow graph never builds OR
    reuses it — and clears the signature so a later graph-requiring run
    can't false-hit on it."""
    svc = RecommenderService()
    _seed_step2_state(svc, tmp_path)
    # Pre-seed a stale cache to prove the no-graph path clears it.
    svc._last_step2_signature = ("stale",)
    svc._last_step2_context = {"stale": True}

    no_graph_rec = MagicMock()
    no_graph_rec.requires_overflow_graph = False
    no_graph_rec.name = "random"

    with patch(
        "expert_backend.recommenders.registry.build_recommender",
        return_value=no_graph_rec,
    ), patch(
        "expert_backend.services.analysis_mixin.run_analysis_step2_graph",
    ) as mock_graph, patch(
        "expert_backend.services.analysis_mixin.run_analysis_step2_discovery",
        return_value=dict(_DISCOVERY_RESULT),
    ):
        # The operator did not opt into the (expensive) graph build, and
        # the model doesn't require it → the graph step is skipped.
        svc._compute_overflow_graph = False
        events = list(svc.run_analysis_step2(
            selected_overloads=["L1"], all_overloads=["L1"],
            monitor_deselected=False, additional_lines_to_cut=[],
        ))

    mock_graph.assert_not_called()
    pdf_event = next(e for e in events if e.get("type") == "pdf")
    assert pdf_event["pdf_path"] is None
    assert svc._last_step2_signature is None
    assert svc._last_step2_context is None


def test_result_event_restores_antenna_meta_from_discovery():
    """Regression guard for the antenna_meta mirror-drift bug: the
    model-aware generator must forward ``antenna_meta`` from the
    discovery results to the result event (the frontend's AntennaNotice
    reads it). The pre-D1 production wrapper silently dropped it."""
    svc = RecommenderService()
    svc._reset_model_settings()
    svc._compute_overflow_graph = False
    svc._last_disconnected_elements = ["LINE_C"]
    svc._analysis_context = {
        "lines_overloaded_names": ["L1"],
        "lines_overloaded_ids": [0],
        "lines_overloaded_ids_kept": [0],
        "lines_we_care_about": None,
    }
    svc._narrow_context_to_selected_overloads = MagicMock(side_effect=lambda ctx, *a, **k: ctx)
    svc._enrich_actions = MagicMock(return_value={})
    svc._augment_combined_actions_with_target_max_rho = MagicMock()
    svc._compute_mw_start_for_scores = MagicMock(return_value={})

    no_graph_rec = MagicMock()
    no_graph_rec.requires_overflow_graph = False
    no_graph_rec.name = "random"
    antenna = {"pocket_subs": ["SUB_A"], "direction": "import"}

    with patch(
        "expert_backend.recommenders.registry.build_recommender",
        return_value=no_graph_rec,
    ), patch(
        "expert_backend.services.analysis_mixin.run_analysis_step2_discovery",
        return_value={**_DISCOVERY_RESULT, "antenna_meta": antenna},
    ):
        events = list(svc.run_analysis_step2(selected_overloads=["L1"]))

    result_event = next(e for e in events if e.get("type") == "result")
    assert result_event["antenna_meta"] == antenna
