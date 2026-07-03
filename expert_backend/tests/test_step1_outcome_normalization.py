# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# SPDX-License-Identifier: MPL-2.0
"""Coverage for ``_normalize_step1_outcome`` — cross-version tolerance of
``run_analysis_step1``'s return shape.

Older ``expert_op4grid_recommender`` releases returned a ``(res_step1,
context)`` 2-tuple (non-``None`` ``res_step1`` = "no actionable overload").
The typed-pipeline refactor returns a single ``AnalysisContext`` (proceed) or
``AnalysisResult`` (short-circuit). ``AnalysisMixin.run_analysis_step1`` must
keep working against BOTH, so it normalises the outcome back to the legacy
pair. These tests pin:

* the tuple pass-through (always),
* the ``isinstance(outcome, AnalysisResult)`` path (real library installed),
* the structural fallback used when the class isn't importable (mock layer),
* and the service-level short-circuit / proceed decisions.

They run in BOTH modes: under the ``conftest.py`` mock layer (library absent)
and against a real ``expert_op4grid_recommender`` install (CI). The tests that
require the real dataclasses skip cleanly when the library is mocked.
"""
from __future__ import annotations

import sys
from unittest.mock import MagicMock

import pytest

from expert_op4grid_recommender import config
from expert_backend.services import analysis_mixin as _analysis_mixin
from expert_backend.services.analysis_mixin import _normalize_step1_outcome
from expert_backend.services.recommender_service import RecommenderService

# Detect whether the REAL typed dataclasses are importable (CI) vs the mock
# layer (a MagicMock attribute is not a ``type``).
try:
    from expert_op4grid_recommender.main import (  # noqa: F401
        AnalysisContext as _RealContext,
        AnalysisResult as _RealResult,
    )
    _HAS_REAL = isinstance(_RealResult, type) and isinstance(_RealContext, type)
except Exception:  # pragma: no cover - defensive
    _RealContext = _RealResult = None
    _HAS_REAL = False

_needs_real = pytest.mark.skipif(
    not _HAS_REAL,
    reason="real expert_op4grid_recommender typed dataclasses not installed",
)


# ---------------------------------------------------------------------
# Unit: _normalize_step1_outcome
# ---------------------------------------------------------------------

class TestNormalizeStep1Outcome:
    def test_legacy_tuple_passes_through(self):
        assert _normalize_step1_outcome(("RESULT", "CONTEXT")) == ("RESULT", "CONTEXT")

    def test_legacy_tuple_short_circuit_shape(self):
        # (result, None) — the historical "no overload" signal.
        assert _normalize_step1_outcome(("R", None)) == ("R", None)

    def _force_structural_fallback(self, monkeypatch):
        # Make ``AnalysisResult`` a non-type so ``isinstance`` raises TypeError,
        # forcing the structural probe deterministically in any environment.
        main_mod = sys.modules["expert_op4grid_recommender.main"]
        monkeypatch.setattr(main_mod, "AnalysisResult", object(), raising=False)

    def test_structural_probe_detects_result(self, monkeypatch):
        self._force_structural_fallback(monkeypatch)
        # A result exposes prioritized_actions and carries no live obs.
        result_like = {"lines_overloaded_names": ["L1"], "prioritized_actions": {},
                       "action_scores": {}}
        assert _normalize_step1_outcome(result_like) == (result_like, None)

    def test_structural_probe_detects_context(self, monkeypatch):
        self._force_structural_fallback(monkeypatch)
        context_like = {"obs": object(), "lines_overloaded_names": ["L1"],
                        "prioritized_actions": {}}
        res, ctx = _normalize_step1_outcome(context_like)
        assert res is None and ctx is context_like

    def test_isinstance_branch_classifies_result_and_context(self, monkeypatch):
        # Simulate the real library: AnalysisResult is a class.
        class AnalysisResult(dict):
            pass

        main_mod = sys.modules["expert_op4grid_recommender.main"]
        monkeypatch.setattr(main_mod, "AnalysisResult", AnalysisResult, raising=False)

        early = AnalysisResult({"lines_overloaded_names": ["L1"]})
        assert _normalize_step1_outcome(early) == (early, None)
        # A value that is NOT an AnalysisResult is treated as a context.
        ctx_like = {"obs": 1}
        assert _normalize_step1_outcome(ctx_like) == (None, ctx_like)

    @_needs_real
    def test_real_analysis_result_is_short_circuit(self):
        early = _RealResult(lines_overloaded_names=["L1"])
        assert _normalize_step1_outcome(early) == (early, None)

    @_needs_real
    def test_real_analysis_context_is_proceed(self):
        ctx = _RealContext(env="E", lines_overloaded_names=["L1"])
        res, out = _normalize_step1_outcome(ctx)
        assert res is None and out is ctx


# ---------------------------------------------------------------------
# Service integration: AnalysisMixin.run_analysis_step1
# ---------------------------------------------------------------------

def _service_returning(monkeypatch, outcome):
    """A RecommenderService stubbed just enough to drive run_analysis_step1,
    with the upstream library replaced by a stub returning ``outcome``."""
    service = RecommenderService()
    service._dict_action = {}
    service._cached_env_context = MagicMock()
    monkeypatch.setattr(service, "_ensure_n_state_ready", lambda: None)
    monkeypatch.setattr(
        service, "_normalize_contingency_elements",
        lambda elts: list(elts) if isinstance(elts, (list, tuple)) else [elts],
    )
    monkeypatch.setattr(_analysis_mixin, "run_analysis_step1", lambda **kw: outcome)
    config.DO_RECO_MAINTENANCE = False
    return service


class TestServiceStep1Outcome:
    def test_legacy_tuple_proceed(self, monkeypatch):
        legacy = (None, {"obs": 1, "lines_overloaded_names": ["L1"]})
        res = _service_returning(monkeypatch, legacy).run_analysis_step1(["LINE_A"])
        assert res["can_proceed"] is True
        assert res["lines_overloaded"] == ["L1"]

    def test_legacy_tuple_short_circuit(self, monkeypatch):
        legacy = ({"lines_overloaded_names": ["L9"]}, None)
        service = _service_returning(monkeypatch, legacy)
        res = service.run_analysis_step1(["LINE_A"])
        assert res["can_proceed"] is False
        assert res["lines_overloaded"] == ["L9"]
        assert service._analysis_context is None

    @_needs_real
    def test_real_context_union_proceeds(self, monkeypatch):
        ctx = _RealContext(obs=object(), lines_overloaded_names=["L1", "L2"])
        service = _service_returning(monkeypatch, ctx)
        res = service.run_analysis_step1(["LINE_A"])
        assert res["can_proceed"] is True
        assert res["lines_overloaded"] == ["L1", "L2"]
        assert service._analysis_context is ctx

    @_needs_real
    def test_real_result_union_short_circuits(self, monkeypatch):
        result = _RealResult(lines_overloaded_names=["L9"])
        service = _service_returning(monkeypatch, result)
        res = service.run_analysis_step1(["LINE_A"])
        assert res["can_proceed"] is False
        assert res["lines_overloaded"] == ["L9"]
        assert service._analysis_context is None
