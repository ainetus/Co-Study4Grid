# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# SPDX-License-Identifier: MPL-2.0

"""Coverage for the post-contingency-observation pre-warm and reuse path.

The N-1 diagram endpoints (full SVG + DOM-recycling patch) pre-compute
the AC load flow on a contingency variant. Before this optimisation,
``run_analysis_step1`` blindly re-ran the same load flow when the
operator clicked "Analyze & Suggest" — typically the most expensive
single step on large grids (~1-3 s).

The optimisation has two halves:

1. **Pre-warm** — both ``get_contingency_diagram`` and
   ``get_contingency_diagram_patch`` build a ``PypowsyblObservation``
   off the already-converged variant and stash it on the service.
2. **Reuse** — ``run_analysis_step1`` validates the cache against the
   contingency variant ID + element list before forwarding the
   observation to the upstream library through the
   ``prebuilt_obs_simu_defaut`` kwarg. A safety gate disables the
   reuse when ``DO_RECO_MAINTENANCE`` is True so the analysis state
   still matches the upstream maintenance-reconnection contract.
"""
from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from expert_op4grid_recommender import config
from expert_backend.services.recommender_service import RecommenderService


# ---------------------------------------------------------------------
# Pre-warm: _cache_obs_for_variant
# ---------------------------------------------------------------------

class TestCacheObsForVariant:
    """The helper builds an obs off the current variant and stamps it
    with the contingency element list + variant id so the analysis
    side can validate the cache."""

    def test_uses_env_from_cached_env_context_when_available(self):
        service = RecommenderService()
        env = MagicMock(name="env")
        obs = MagicMock(name="obs")
        env.get_obs.return_value = obs
        service._cached_env_context = {"env": env}

        n = MagicMock(name="network")
        service._cache_obs_for_variant(n, "contingency_state_LINE_A", ["LINE_A"])

        env.get_obs.assert_called_once()
        assert service._cached_obs_n1 is obs
        assert service._cached_obs_n1_id == "contingency_state_LINE_A"
        assert service._cached_obs_n1_elements == ("LINE_A",)
        # The obs is stamped with its variant id so downstream
        # action-variant code can branch off it.
        assert obs._variant_id == "contingency_state_LINE_A"

    def test_falls_back_to_get_simulation_env_when_context_missing(self):
        service = RecommenderService()
        service._cached_env_context = None
        env = MagicMock(name="env")
        obs = MagicMock(name="obs")
        env.get_obs.return_value = obs

        with patch.object(RecommenderService, "_get_simulation_env", return_value=env) as mock_get:
            n = MagicMock(name="network")
            service._cache_obs_for_variant(n, "v_xy", ["B"])

        mock_get.assert_called_once()
        env.get_obs.assert_called_once()
        assert service._cached_obs_n1 is obs
        assert service._cached_obs_n1_elements == ("B",)

    def test_silently_skips_when_no_env_is_available(self):
        service = RecommenderService()
        service._cached_env_context = None

        with patch.object(
            RecommenderService, "_get_simulation_env",
            side_effect=Exception("no env yet"),
        ):
            n = MagicMock(name="network")
            # Must not raise — the prewarm is best-effort.
            service._cache_obs_for_variant(n, "v", ["X"])

        assert service._cached_obs_n1 is None
        assert service._cached_obs_n1_id is None


# ---------------------------------------------------------------------
# Reset: cached fields are cleared
# ---------------------------------------------------------------------

class TestResetClearsCachedObsState:

    def test_reset_clears_cached_obs_n1_elements(self):
        service = RecommenderService()
        service._cached_obs_n1 = MagicMock()
        service._cached_obs_n1_id = "v"
        service._cached_obs_n1_elements = ("A", "B")

        # Stub the heavy reset side-effects.
        with patch.object(
            RecommenderService, "_drain_pending_base_nad_prefetch",
        ):
            service.reset()

        assert service._cached_obs_n1 is None
        assert service._cached_obs_n1_id is None
        assert service._cached_obs_n1_elements is None


# ---------------------------------------------------------------------
# Reuse: run_analysis_step1 cache hit / miss / safety gate
# ---------------------------------------------------------------------

# Re-import after ``analysis_mixin`` has been imported by the package
# so the patched ``run_analysis_step1`` callable inside that module
# is the seam we intercept in tests below.
from expert_backend.services import analysis_mixin as _analysis_mixin  # noqa: E402


def _make_service_for_step1(monkeypatch, contingency_elements):
    """Build a RecommenderService stubbed enough to drive
    ``run_analysis_step1`` end-to-end. Returns the service + a recorder
    for the kwargs the upstream library was called with."""
    service = RecommenderService()
    service._dict_action = {}
    service._cached_env_context = MagicMock()
    monkeypatch.setattr(service, "_ensure_n_state_ready", lambda: None)
    monkeypatch.setattr(
        service, "_normalize_contingency_elements",
        lambda elts: list(elts) if isinstance(elts, (list, tuple)) else [elts],
    )

    seen_kwargs: dict = {}

    def fake_step1(**kwargs):
        seen_kwargs.update(kwargs)
        # Mimic the upstream contract: return ``(None, context)`` on
        # success. The context only needs ``lines_overloaded_names`` for
        # the wrapper's post-processing.
        return None, {"lines_overloaded_names": ["L1"]}

    monkeypatch.setattr(_analysis_mixin, "run_analysis_step1", fake_step1)
    # Force the introspection helper to report support — it inspects
    # the live upstream symbol which we just replaced with a stub.
    monkeypatch.setattr(
        _analysis_mixin, "_upstream_step1_supports_prebuilt_obs",
        lambda: True,
    )
    return service, seen_kwargs


class TestRunAnalysisStep1Reuse:

    def test_passes_prebuilt_obs_when_cache_matches(self, monkeypatch):
        service, seen = _make_service_for_step1(monkeypatch, ["LINE_A"])
        # Pre-warm the cache with a matching variant id + elements.
        cached_obs = MagicMock(name="cached_obs")
        variant_id = service._contingency_variant_id(["LINE_A"])
        service._cached_obs_n1 = cached_obs
        service._cached_obs_n1_id = variant_id
        service._cached_obs_n1_elements = ("LINE_A",)

        config.DO_RECO_MAINTENANCE = False
        res = service.run_analysis_step1(["LINE_A"])

        assert res["can_proceed"] is True
        # The cached obs is forwarded to the upstream library so the
        # ``simulate_contingency_pypowsybl`` call is skipped.
        assert seen.get("prebuilt_obs_simu_defaut") is cached_obs

    def test_does_not_pass_prebuilt_obs_on_variant_mismatch(self, monkeypatch):
        service, seen = _make_service_for_step1(monkeypatch, ["LINE_A"])
        service._cached_obs_n1 = MagicMock()
        service._cached_obs_n1_id = "stale_variant_for_different_contingency"
        service._cached_obs_n1_elements = ("OTHER_LINE",)

        config.DO_RECO_MAINTENANCE = False
        service.run_analysis_step1(["LINE_A"])

        # The kwarg is omitted entirely on miss (so the upstream
        # library falls back to its own simulate_contingency path).
        assert "prebuilt_obs_simu_defaut" not in seen

    def test_safety_gate_disables_reuse_when_do_reco_maintenance_is_on(
        self, monkeypatch,
    ):
        """The diagram-side prewarm does NOT apply maintenance
        reconnections. When the operator opts into them, the cached
        obs would be physically wrong, so the reuse path must be
        disabled regardless of variant match."""
        service, seen = _make_service_for_step1(monkeypatch, ["LINE_A"])
        cached_obs = MagicMock(name="cached_obs")
        variant_id = service._contingency_variant_id(["LINE_A"])
        service._cached_obs_n1 = cached_obs
        service._cached_obs_n1_id = variant_id
        service._cached_obs_n1_elements = ("LINE_A",)

        config.DO_RECO_MAINTENANCE = True
        service.run_analysis_step1(["LINE_A"])

        assert "prebuilt_obs_simu_defaut" not in seen

    def test_records_step1_time_in_service_state(self, monkeypatch):
        service, _ = _make_service_for_step1(monkeypatch, ["LINE_A"])
        config.DO_RECO_MAINTENANCE = False
        res = service.run_analysis_step1(["LINE_A"])

        # The wrapper measures wall-clock around the call so the step-2
        # result event can surface it to the React UI.
        assert "step1_time" in res
        assert isinstance(res["step1_time"], float)
        assert res["step1_time"] >= 0.0
        assert service._last_step1_time == pytest.approx(res["step1_time"])


# ---------------------------------------------------------------------
# Backward-compat: fall back when upstream lacks the kwarg
# ---------------------------------------------------------------------

class TestUpstreamCompatibilityFallback:

    def test_omits_kwarg_when_upstream_signature_lacks_it(self, monkeypatch):
        """Older ``expert_op4grid_recommender`` releases don't accept
        ``prebuilt_obs_simu_defaut`` — passing it would raise
        ``TypeError``. The wrapper must introspect the signature and
        drop the kwarg in that case (with a one-line log)."""
        service, seen = _make_service_for_step1(monkeypatch, ["LINE_A"])
        cached_obs = MagicMock(name="cached_obs")
        variant_id = service._contingency_variant_id(["LINE_A"])
        service._cached_obs_n1 = cached_obs
        service._cached_obs_n1_id = variant_id
        service._cached_obs_n1_elements = ("LINE_A",)

        # Force the support detector to report False as if the upstream
        # library were the legacy version.
        monkeypatch.setattr(
            _analysis_mixin, "_upstream_step1_supports_prebuilt_obs",
            lambda: False,
        )

        config.DO_RECO_MAINTENANCE = False
        service.run_analysis_step1(["LINE_A"])

        # No kwarg passed, despite the cache being warm — the
        # upstream library is free to run its own contingency simulate.
        assert "prebuilt_obs_simu_defaut" not in seen
