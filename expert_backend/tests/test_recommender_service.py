# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0
# This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study. 

import os
from pathlib import Path
from unittest.mock import patch, mock_open, MagicMock

import numpy as np
import pytest

from expert_backend.services.recommender_service import RecommenderService
from expert_backend.main import ConfigRequest
from expert_op4grid_recommender import config

class TestRecommenderService:
    @patch("expert_backend.services.recommender_service.enrich_actions_lazy")
    @patch("expert_backend.services.recommender_service.load_actions")
    @patch("expert_backend.services.network_service.network_service")
    @patch("builtins.open", new_callable=mock_open)
    def test_update_config_applies_settings(self, mock_file, mock_network_service, mock_load_actions, mock_enrich):
        # Set up mocks
        mock_load_actions.return_value = {"existing_action": {}}
        mock_network_service.get_disconnectable_elements.return_value = ["line1", "line2"]
        mock_network_service.get_monitored_elements.return_value = ["line1"]
        
        service = RecommenderService()
        
        # Test paths
        network_path = "/tmp/test_network.xiidm"
        action_path = "/tmp/test_actions.json"
        layout_path = "/tmp/test_layout.json"

        # Create a sample config request with test data paths and custom values
        settings = ConfigRequest(
            network_path=network_path,
            action_file_path=action_path,
            layout_path=layout_path,
            min_line_reconnections=5.0,
            min_close_coupling=4.0,
            min_open_coupling=3.0,
            min_line_disconnections=2.0,
            n_prioritized_actions=20,
            monitoring_factor=0.85,
            pre_existing_overload_threshold=0.05,
            ignore_reconnections=True,
            pypowsybl_fast_mode=False,
            min_redispatch=2,
            allowed_action_types=["redispatch", "disco"],
        )

        service.update_config(settings)

        # Verify that config module was updated correctly
        assert config.ENV_PATH == Path(network_path)
        assert config.ENV_NAME == "test_network.xiidm"
        assert config.ENV_FOLDER == Path("/tmp")
        assert config.ACTION_FILE_PATH == Path(action_path)
        assert config.LAYOUT_FILE_PATH == Path(layout_path)
        
        assert config.MIN_LINE_RECONNECTIONS == 5.0
        assert config.MIN_CLOSE_COUPLING == 4.0
        assert config.MIN_OPEN_COUPLING == 3.0
        assert config.MIN_LINE_DISCONNECTIONS == 2.0
        assert config.N_PRIORITIZED_ACTIONS == 20
        assert config.MONITORING_FACTOR_THERMAL_LIMITS == 0.85
        assert config.PRE_EXISTING_OVERLOAD_WORSENING_THRESHOLD == 0.05
        
        # Verify the new settings are applied
        assert config.IGNORE_RECONNECTIONS is True
        assert config.PYPOWSYBL_FAST_MODE is False

        # Redispatch floor + recommender action-type restriction
        assert config.MIN_REDISPATCH == 2
        assert config.ALLOWED_ACTION_TYPES == ["redispatch", "disco"]

        # Overflow viewer: HTML is now the default output format (PR #74
        # interactive viewer). Legacy .pdf loading is handled at the
        # file-watcher / session-load layer, not via config.
        assert config.VISUALIZATION_FORMAT == "html"

        # Verify side effects (mocks)
        mock_load_actions.assert_called_once_with(Path(action_path))
        # Since disco_ actions were not in mock_load_actions.return_value, it should have auto-generated them
        # and called open(action_path, 'w')
        mock_file.assert_called_with(Path(action_path), 'w')

    @patch("expert_backend.services.recommender_service.enrich_actions_lazy")
    @patch("expert_backend.services.recommender_service.load_actions")
    @patch("expert_backend.services.network_service.network_service")
    @patch("builtins.open", new_callable=mock_open)
    def test_update_config_disables_superposition_verify(
        self, mock_file, mock_network_service, mock_load_actions, mock_enrich
    ):
        """update_config must flip VERIFY_SUPERPOSITION_MAX_RHO off so the
        combined-action-pair simulation verification doesn't double the
        Step-2 runtime in production analyses. Guarded by hasattr so
        older recommender installs stay happy — we simulate the upstream
        attribute being present (commit 1f980169 onward) by pre-setting
        it to True on the config module."""
        mock_load_actions.return_value = {"disco_line1": {}}  # already has disco
        mock_network_service.get_disconnectable_elements.return_value = ["line1"]
        mock_network_service.get_monitored_elements.return_value = ["line1"]

        # Simulate an install that has the verify flag (like venv_py310).
        # `reset_config` autouse fixture restores the original value/absence
        # after the test, so this assignment is test-local.
        config.VERIFY_SUPERPOSITION_MAX_RHO = True

        service = RecommenderService()
        settings = ConfigRequest(
            network_path="/tmp/net.xiidm",
            action_file_path="/tmp/act.json",
        )
        service.update_config(settings)

        assert config.VERIFY_SUPERPOSITION_MAX_RHO is False

    @patch("expert_backend.services.recommender_service.enrich_actions_lazy")
    @patch("expert_backend.services.recommender_service.load_actions")
    @patch("expert_backend.services.network_service.network_service")
    @patch("builtins.open", new_callable=mock_open)
    def test_update_config_superposition_verify_absent_is_noop(
        self, mock_file, mock_network_service, mock_load_actions, mock_enrich
    ):
        """Older recommender installs (pre-commit 1f980169) don't have
        VERIFY_SUPERPOSITION_MAX_RHO on the config module. update_config
        must NOT raise AttributeError nor synthesize the attribute —
        the hasattr guard keeps backward compatibility."""
        mock_load_actions.return_value = {"disco_line1": {}}
        mock_network_service.get_disconnectable_elements.return_value = ["line1"]
        mock_network_service.get_monitored_elements.return_value = ["line1"]

        # Ensure the attribute is absent before the call. `reset_config`
        # will restore the module state afterwards.
        if hasattr(config, "VERIFY_SUPERPOSITION_MAX_RHO"):
            delattr(config, "VERIFY_SUPERPOSITION_MAX_RHO")

        service = RecommenderService()
        settings = ConfigRequest(
            network_path="/tmp/net.xiidm",
            action_file_path="/tmp/act.json",
        )
        service.update_config(settings)  # must not raise

        # Backend must not have synthesized the field when it wasn't there
        # upstream — keeps the recommender config as authoritative.
        assert not hasattr(config, "VERIFY_SUPERPOSITION_MAX_RHO")
        
    def test_update_config_defaults(self):
        # We also want to verify that default settings work as expected
        with patch("expert_backend.services.recommender_service.load_actions") as mock_load, \
             patch("expert_backend.services.recommender_service.enrich_actions_lazy") as mock_enrich, \
             patch("expert_backend.services.network_service.network_service") as mock_ns, \
             patch("builtins.open", mock_open()):
            
            mock_load.return_value = {"disco_line1": {}} # already has disco
            service = RecommenderService()
            
            settings = ConfigRequest(
                network_path="/tmp/net",
                action_file_path="/tmp/act.json"
                # using defaults for the rest
            )
            
            service.update_config(settings)
            
            # Defaults check (based on main.py)
            assert config.IGNORE_RECONNECTIONS is False
            assert config.PYPOWSYBL_FAST_MODE is True
            assert config.MONITORING_FACTOR_THERMAL_LIMITS == 0.95
            assert config.PRE_EXISTING_OVERLOAD_WORSENING_THRESHOLD == 0.02
            # No restriction by default → recommender considers all families.
            assert config.ALLOWED_ACTION_TYPES == []


class TestRestoreAnalysisContext:
    """Tests for RecommenderService.restore_analysis_context()."""

    def test_restore_sets_analysis_context(self):
        service = RecommenderService()
        assert service._analysis_context is None

        service.restore_analysis_context(
            lines_we_care_about=["LINE_A", "LINE_B"],
            disconnected_elements=["LINE_X"],
            lines_overloaded=["LINE_A"],
        )

        assert service._analysis_context is not None
        assert service._analysis_context["lines_we_care_about"] == ["LINE_A", "LINE_B"]
        assert service._analysis_context["lines_overloaded"] == ["LINE_A"]
        assert service._last_disconnected_elements == ["LINE_X"]

    def test_restore_with_none_lines(self):
        service = RecommenderService()
        service.restore_analysis_context(lines_we_care_about=None)

        assert service._analysis_context is not None
        assert service._analysis_context["lines_we_care_about"] is None

    def test_restore_with_computed_pairs(self):
        service = RecommenderService()
        pairs = {"act1+act2": {"max_rho": 0.5, "betas": [0.1, 0.2]}}
        service.restore_analysis_context(
            lines_we_care_about=["L1"],
            computed_pairs=pairs,
        )

        assert service._saved_computed_pairs == pairs
        assert service.get_saved_computed_pairs() == pairs

    def test_restore_without_computed_pairs(self):
        service = RecommenderService()
        service.restore_analysis_context(lines_we_care_about=["L1"])

        assert service._saved_computed_pairs is None
        assert service.get_saved_computed_pairs() is None

    def test_restore_without_optional_fields(self):
        service = RecommenderService()
        service.restore_analysis_context(lines_we_care_about=["L1", "L2"])

        assert service._analysis_context["lines_we_care_about"] == ["L1", "L2"]
        assert "lines_overloaded" not in service._analysis_context
        assert service._last_disconnected_elements == []

    def test_restore_updates_disconnected_element(self):
        service = RecommenderService()
        service._last_disconnected_elements = ["OLD_LINE"]
        service.restore_analysis_context(
            lines_we_care_about=["L1"],
            disconnected_elements=["NEW_LINE"],
        )
        assert service._last_disconnected_elements == ["NEW_LINE"]

    def test_restore_does_not_overwrite_disconnected_element_if_none(self):
        service = RecommenderService()
        service._last_disconnected_elements = ["EXISTING"]
        service.restore_analysis_context(
            lines_we_care_about=["L1"],
            disconnected_elements=None,
        )
        # None is falsy, so it should not overwrite
        assert service._last_disconnected_elements == ["EXISTING"]

    def test_reset_clears_restored_context(self):
        service = RecommenderService()
        service.restore_analysis_context(
            lines_we_care_about=["L1"],
            computed_pairs={"p": {}},
        )
        assert service._analysis_context is not None
        assert service._saved_computed_pairs is not None

        service.reset()
        assert service._analysis_context is None
        assert service._saved_computed_pairs is None


class TestGetMonitoringParametersWithContext:
    """Tests that _get_monitoring_parameters uses restored analysis context."""

    def _make_mock_obs(self, line_names):
        obs = MagicMock()
        obs.name_line = line_names
        obs._network_manager = MagicMock()
        network = MagicMock()
        obs._network_manager.network = network
        # Return empty limits so branches_with_limits defaults to set()
        import pandas as pd
        network.get_operational_limits.return_value = pd.DataFrame()
        return obs

    def test_uses_context_lines_we_care_about(self):
        service = RecommenderService()
        service._analysis_context = {
            "lines_we_care_about": ["LINE_A", "LINE_C"]
        }
        obs = self._make_mock_obs(["LINE_A", "LINE_B", "LINE_C"])

        lines, _ = service._get_monitoring_parameters(obs)
        assert lines == ["LINE_A", "LINE_C"]

    def test_fallback_without_context(self):
        service = RecommenderService()
        service._analysis_context = None
        obs = self._make_mock_obs(["LINE_A", "LINE_B"])

        # With IGNORE_LINES_MONITORING=True (default), falls back to all lines
        original = getattr(config, 'IGNORE_LINES_MONITORING', True)
        config.IGNORE_LINES_MONITORING = True
        try:
            lines, _ = service._get_monitoring_parameters(obs)
            assert lines == ["LINE_A", "LINE_B"]
        finally:
            config.IGNORE_LINES_MONITORING = original

    def test_context_with_none_care_falls_back_to_all_lines(self):
        service = RecommenderService()
        service._analysis_context = {"lines_we_care_about": None}
        obs = self._make_mock_obs(["L1", "L2", "L3"])

        lines, _ = service._get_monitoring_parameters(obs)
        assert lines == ["L1", "L2", "L3"]


class TestGetBaseNetworkMutualisation:
    """`_get_base_network` must reuse `network_service.network` when available
    to avoid re-parsing the same .xiidm file twice (~3-5 s of wasted pypowsybl
    work on large grids). See docs/performance/history/shared-network.md."""

    def test_reuses_network_service_network_when_available(self):
        from expert_backend.services.network_service import network_service

        service = RecommenderService()
        sentinel = MagicMock(name="shared_pypowsybl_network")
        # `_capture_initial_pst_taps` touches pypowsybl tap-changer APIs —
        # stub it out so the test doesn't need a real pp object.
        saved = network_service.network
        network_service.network = sentinel
        try:
            with patch.object(service, "_capture_initial_pst_taps"), \
                 patch("pypowsybl.network.load") as mock_load:
                n = service._get_base_network()
                # Mutualisation: no fresh pp.network.load() was issued.
                mock_load.assert_not_called()
                assert n is sentinel
                # Convenience method installed.
                assert callable(getattr(n, "get_line_ids", None))
                # Cache populated so the next call is a no-op.
                assert service._base_network is sentinel
        finally:
            network_service.network = saved

    def test_falls_back_to_standalone_load_when_network_service_empty(self):
        """Preserves direct-instantiation path for unit tests and callers
        that bypass `/api/config` (and therefore don't populate
        `network_service.network`)."""
        from expert_backend.services.network_service import network_service

        service = RecommenderService()
        loaded = MagicMock(name="freshly_loaded")

        saved = network_service.network
        network_service.network = None
        try:
            env_path = MagicMock()
            env_path.is_dir.return_value = False
            env_path.exists.return_value = True
            env_path.__str__ = lambda self: "/fake/grid.xiidm"  # type: ignore[assignment]

            with patch.object(config, "ENV_PATH", env_path), \
                 patch.object(service, "_capture_initial_pst_taps"), \
                 patch("pypowsybl.network.load", return_value=loaded) as mock_load:
                n = service._get_base_network()
                mock_load.assert_called_once()
                assert n is loaded
        finally:
            network_service.network = saved


class TestPrefetchBaseNad:
    """Tests for the base-NAD prefetch (perf #2 — see docs/performance/history/nad-prefetch.md).

    The prefetch runs concurrently with `setup_environment_configs_pypowsybl`
    inside `update_config` so the subsequent `/api/network-diagram` XHR can
    skip the ~6 s of pypowsybl NAD regeneration entirely.
    """

    def test_initial_state_has_no_prefetch(self):
        service = RecommenderService()
        assert service._prefetched_base_nad is None
        assert service._prefetched_base_nad_event is None
        assert service.get_prefetched_base_nad() is None

    def test_prefetch_populates_cache_on_success(self):
        service = RecommenderService()

        expected = {"svg": "<svg>prefetched</svg>", "metadata": None}
        # `_get_base_network()` is called in the main thread to pre-warm
        # the network cache; the worker then calls `get_network_diagram`
        # on the hot cache. Patch both so we don't need pypowsybl.
        with patch.object(service, "_get_base_network", return_value=MagicMock()), \
             patch.object(service, "get_network_diagram", return_value=expected):
            service.prefetch_base_nad_async()
            # Block until the worker completes.
            result = service.get_prefetched_base_nad(timeout=10)

        assert result == expected
        assert service._prefetched_base_nad_error is None

    def test_prefetch_surfaces_worker_exception(self):
        service = RecommenderService()

        boom = RuntimeError("pypowsybl exploded")
        with patch.object(service, "_get_base_network", return_value=MagicMock()), \
             patch.object(service, "get_network_diagram", side_effect=boom):
            service.prefetch_base_nad_async()
            with pytest.raises(RuntimeError, match="pypowsybl exploded"):
                service.get_prefetched_base_nad(timeout=10)

    def test_prefetch_records_network_load_error_without_spawning_worker(self):
        """If `_get_base_network()` fails in the main thread, no worker
        should be started — the error is recorded directly and the event
        is pre-set so the next `get_prefetched_base_nad()` re-raises
        instantly."""
        service = RecommenderService()

        boom = FileNotFoundError("network file gone")
        with patch.object(service, "_get_base_network", side_effect=boom):
            service.prefetch_base_nad_async()
        # Worker thread was never started.
        assert service._prefetched_base_nad_thread is None
        # Event is pre-set so there is no wait.
        assert service._prefetched_base_nad_event is not None
        assert service._prefetched_base_nad_event.is_set()
        with pytest.raises(FileNotFoundError):
            service.get_prefetched_base_nad(timeout=0.1)

    def test_reset_drains_pending_prefetch_and_clears_state(self):
        """A dangling worker thread that finishes after reset() would
        otherwise write stale SVG into the next study's cache. `reset()`
        must join the worker and then zero the fields."""
        service = RecommenderService()
        expected = {"svg": "<svg>first_study</svg>", "metadata": None}
        with patch.object(service, "_get_base_network", return_value=MagicMock()), \
             patch.object(service, "get_network_diagram", return_value=expected):
            service.prefetch_base_nad_async()
            # Make sure the worker ran to completion before reset.
            service.get_prefetched_base_nad(timeout=10)

        service.reset()
        assert service._prefetched_base_nad is None
        assert service._prefetched_base_nad_error is None
        assert service._prefetched_base_nad_event is None
        assert service._prefetched_base_nad_thread is None
        assert service.get_prefetched_base_nad() is None

    def test_timeout_returns_none_without_raising(self):
        """When the caller runs out of patience, `get_prefetched_base_nad`
        returns None (signalling 'fall through to fresh compute') rather
        than raising, so the endpoint stays usable. The worker keeps
        running — its eventual result will be discarded on the next reset."""
        service = RecommenderService()

        import threading
        release = threading.Event()

        def slow_get_diagram():
            release.wait(timeout=5)
            return {"svg": "<svg/>", "metadata": None}

        try:
            with patch.object(service, "_get_base_network", return_value=MagicMock()), \
                 patch.object(service, "get_network_diagram", side_effect=slow_get_diagram):
                service.prefetch_base_nad_async()
                result = service.get_prefetched_base_nad(timeout=0.05)
                assert result is None
        finally:
            # Let the worker finish so the daemon thread doesn't linger.
            release.set()
            if service._prefetched_base_nad_thread is not None:
                service._prefetched_base_nad_thread.join(timeout=5)


class TestUpdateConfigSharesNetworkWithGrid2op:
    """`update_config` must pass the already-loaded Network to the upstream
    `setup_environment_configs_pypowsybl(network=...)` so grid2op does not
    re-parse the same .xiidm file. See docs/performance/history/grid2op-shared-network.md."""

    @patch("builtins.open", new_callable=mock_open)
    @patch("expert_backend.services.network_service.network_service")
    @patch("expert_backend.services.recommender_service.load_actions")
    @patch("expert_backend.services.recommender_service.enrich_actions_lazy")
    def test_update_config_injects_preloaded_network_into_upstream(
        self, mock_enrich, mock_load, mock_ns, mock_file
    ):
        mock_load.return_value = {"disco_line1": {}}  # skip disco auto-gen
        mock_ns.get_disconnectable_elements.return_value = []
        mock_ns.get_monitored_elements.return_value = []

        service = RecommenderService()
        # Pre-populate the base network so `prefetch_base_nad_async` doesn't
        # try the real load. The same sentinel must land in the upstream call.
        preloaded = MagicMock(name="preloaded_network")
        service._base_network = preloaded

        settings = ConfigRequest(
            network_path="/tmp/net.xiidm",
            action_file_path="/tmp/actions.json",
        )

        with patch(
            "expert_op4grid_recommender.environment_pypowsybl.setup_environment_configs_pypowsybl"
        ) as mock_setup, patch.object(
            service, "prefetch_base_nad_async"
        ):
            mock_setup.return_value = (
                MagicMock(),  # env
                MagicMock(),  # obs
                "/tmp/env",   # env_path
                "chronic",    # chronic_name
                None,         # custom_layout
                {},           # raw_dict
                [],           # lines_non_reconnectable
                [],           # lines_we_care_about
            )

            service.update_config(settings)

            # Upstream helper MUST receive the pre-loaded Network to skip
            # its own pp.network.load() — this is the whole point of the
            # perf-grid2op-shared-network optimisation.
            mock_setup.assert_called_once()
            call_kwargs = mock_setup.call_args.kwargs
            assert call_kwargs.get("network") is preloaded
            # AND `skip_initial_obs=True` — the obs returned by upstream
            # is discarded below (we never store it in `_cached_env_context`),
            # so computing it wastes ~3-5 s on a large grid. Requires
            # expert_op4grid_recommender >= 0.2.0.post3.
            # See docs/performance/history/skip-initial-obs.md.
            assert call_kwargs.get("skip_initial_obs") is True





class TestEnsureNStateReady:
    """Guard that runs at the entry of every analyze/suggest/simulate
    endpoint: must drain any pending NAD prefetch AND position the shared
    pypowsybl Network on the N variant. See docs/performance/history/grid2op-shared-network.md
    ("variant-state guard")."""

    def test_drains_prefetch_then_positions_n_variant(self):
        service = RecommenderService()
        fake_net = MagicMock(name="shared_network")
        fake_net.get_variant_ids.return_value = ["N_state_cached"]
        service._base_network = fake_net

        with patch.object(service, "_drain_pending_base_nad_prefetch") as drain, \
             patch.object(service, "_get_n_variant", return_value="N_state_cached"):
            service._ensure_n_state_ready()

            drain.assert_called_once()
            fake_net.set_working_variant.assert_called_once_with("N_state_cached")

    def test_is_noop_before_any_network_is_loaded(self):
        """Calling the guard before /api/config has run at all must not
        raise — callers downstream will produce their own error when
        they actually need the network."""
        service = RecommenderService()
        assert service._base_network is None
        saved_env_path = getattr(config, "ENV_PATH", None)
        try:
            config.ENV_PATH = None
            service._ensure_n_state_ready()  # Must not raise.
        finally:
            config.ENV_PATH = saved_env_path

    def test_swallows_and_logs_variant_positioning_errors(self):
        """If `_get_n_variant` fails (e.g. LF diverged), the guard must not
        propagate — downstream code produces a clearer error on its first
        variant access."""
        service = RecommenderService()
        service._base_network = MagicMock(name="net")
        with patch.object(service, "_drain_pending_base_nad_prefetch"), \
             patch.object(service, "_get_n_variant", side_effect=RuntimeError("LF diverged")):
            service._ensure_n_state_ready()  # Must not re-raise.


class TestVariantRestorationIsSafeOnException:
    """`_get_n_variant` and `_get_contingency_variant` must restore the original
    working variant even when the AC load flow raises. Otherwise the
    shared Network (used by network_service and grid2op) gets stuck on
    a `*_cached` variant and silently corrupts concurrent reads."""

    def test_get_n_variant_restores_original_on_lf_failure(self):
        service = RecommenderService()
        fake_net = MagicMock(name="net")
        fake_net.get_working_variant_id.return_value = "InitialState"
        fake_net.get_variant_ids.return_value = []  # variant doesn't exist → create path
        service._base_network = fake_net

        with patch.object(service, "_run_ac_with_fallback", side_effect=RuntimeError("LF boom")):
            with pytest.raises(RuntimeError, match="LF boom"):
                service._get_n_variant()

        # MUST have been called to restore the original variant, even
        # though the LF raised inside the try block.
        fake_net.set_working_variant.assert_any_call("InitialState")

    def test_get_contingency_variant_restores_original_on_lf_failure(self):
        service = RecommenderService()
        fake_net = MagicMock(name="net")
        fake_net.get_working_variant_id.return_value = "InitialState"
        # N variant already exists → _get_n_variant is a fast path (no LF).
        fake_net.get_variant_ids.return_value = ["N_state_cached"]
        service._base_network = fake_net

        with patch.object(service, "_run_ac_with_fallback", side_effect=RuntimeError("LF boom")):
            with pytest.raises(RuntimeError, match="LF boom"):
                service._get_contingency_variant("LINE_A")

        fake_net.set_working_variant.assert_any_call("InitialState")


class TestEnsureN1StateReady:
    """`_ensure_contingency_state_ready(disconnected_element)` is used by
    `simulate_manual_action` and `compute_superposition` — they operate
    on top of a known contingency, so the natural entry state is N-1
    (not N). The guard drains the NAD prefetch worker, then positions
    the shared Network on the N-1 variant for the given contingency."""

    def test_drains_prefetch_then_positions_n1_variant(self):
        service = RecommenderService()
        fake_net = MagicMock(name="shared_network")
        service._base_network = fake_net

        with patch.object(service, "_drain_pending_base_nad_prefetch") as drain, \
             patch.object(service, "_get_contingency_variant", return_value="contingency_state_LINE_A") as n1:
            service._ensure_contingency_state_ready("LINE_A")

            drain.assert_called_once()
            n1.assert_called_once_with(["LINE_A"])
            fake_net.set_working_variant.assert_called_once_with("contingency_state_LINE_A")

    def test_is_noop_before_any_network_is_loaded(self):
        service = RecommenderService()
        assert service._base_network is None
        saved_env_path = getattr(config, "ENV_PATH", None)
        try:
            config.ENV_PATH = None
            service._ensure_contingency_state_ready("LINE_A")  # Must not raise.
        finally:
            config.ENV_PATH = saved_env_path

    def test_drain_only_when_disconnected_element_is_empty(self):
        """If the caller has no contingency in hand (e.g. an odd fallback
        path), drain but don't attempt to position — there's no
        meaningful N-1 to ask for."""
        service = RecommenderService()
        service._base_network = MagicMock(name="net")
        with patch.object(service, "_drain_pending_base_nad_prefetch") as drain, \
             patch.object(service, "_get_contingency_variant") as n1:
            service._ensure_contingency_state_ready("")

            drain.assert_called_once()
            n1.assert_not_called()

    def test_swallows_and_logs_variant_positioning_errors(self):
        service = RecommenderService()
        service._base_network = MagicMock(name="net")
        with patch.object(service, "_drain_pending_base_nad_prefetch"), \
             patch.object(service, "_get_contingency_variant", side_effect=RuntimeError("LF diverged")):
            service._ensure_contingency_state_ready("LINE_A")  # Must not re-raise.


class TestOverflowLayoutToggle:
    """Tests for the Hierarchical / Geo layout toggle on the Overflow
    Analysis tab — `_load_layout_coords` and `regenerate_overflow_graph`
    (cache-backed, SVG-transform based)."""

    def _make_layout_df(self, rows):
        import pandas as pd
        df = pd.DataFrame(rows)
        if "id" in df.columns:
            df = df.set_index("id")
        return df

    # ---- _load_layout_coords ----

    def test_load_layout_coords_returns_dict_from_indexed_df(self):
        service = RecommenderService()
        df = self._make_layout_df([
            {"id": "A", "x": 1.0, "y": 2.0},
            {"id": "B", "x": 3.0, "y": 4.0},
        ])
        with patch.object(service, "_load_layout", return_value=df):
            coords = service._load_layout_coords()
        assert coords == {"A": (1.0, 2.0), "B": (3.0, 4.0)}

    def test_load_layout_coords_empty_when_no_layout(self):
        service = RecommenderService()
        with patch.object(service, "_load_layout", return_value=None):
            assert service._load_layout_coords() == {}

    # ---- regenerate_overflow_graph ----

    def test_regenerate_rejects_bad_mode(self):
        import pytest
        service = RecommenderService()
        with pytest.raises(ValueError, match="Unknown overflow layout mode"):
            service.regenerate_overflow_graph("bogus")

    def test_regenerate_requires_prior_step2(self):
        """When no hierarchical file was produced by Step 2 yet, both
        modes fail fast — there is nothing to transform and nothing to
        serve."""
        import pytest
        service = RecommenderService()
        service._overflow_layout_cache = {}
        with pytest.raises(ValueError, match="Run the analysis"):
            service.regenerate_overflow_graph("geo")
        with pytest.raises(ValueError, match="Run the analysis"):
            service.regenerate_overflow_graph("hierarchical")

    def test_regenerate_hierarchical_returns_cached_file(self, tmp_path):
        """Hierarchical is always the file Step-2 produced; the regen
        endpoint simply returns it from the cache."""
        service = RecommenderService()
        h_file = tmp_path / "overflow_hierarchi.html"
        h_file.write_text("<html></html>")
        service._overflow_layout_cache = {"hierarchical": str(h_file)}

        result = service.regenerate_overflow_graph("hierarchical")
        assert result == {
            "pdf_path": str(h_file),
            "mode": "hierarchical",
            "cached": True,
        }

    def test_regenerate_geo_runs_transform_and_writes_new_file(self, tmp_path):
        """First Geo call reads the cached hierarchical HTML, runs
        `overflow_geo_transform.transform_html` with the layout coords,
        and writes the result to `<hierarchical>_geo.html`."""
        service = RecommenderService()
        h_file = tmp_path / "overflow.html"
        h_file.write_text("<html>hierarchical</html>")
        service._overflow_layout_cache = {"hierarchical": str(h_file)}

        layout = {"A": (0.0, 0.0)}
        with patch.object(service, "_load_layout_coords", return_value=layout), \
             patch(
                "expert_backend.services.analysis.overflow_geo_transform.transform_html",
                return_value="<html>geo</html>",
             ) as transform:
            result = service.regenerate_overflow_graph("geo")

        transform.assert_called_once_with("<html>hierarchical</html>", layout)
        expected = tmp_path / "overflow_geo.html"
        assert result == {"pdf_path": str(expected), "mode": "geo", "cached": False}
        assert expected.read_text() == "<html>geo</html>"
        assert service._overflow_layout_cache["geo"] == str(expected)
        assert service._overflow_layout_mode == "geo"

    def test_regenerate_geo_raises_when_layout_missing(self, tmp_path):
        import pytest
        service = RecommenderService()
        h_file = tmp_path / "overflow.html"
        h_file.write_text("<html>hierarchical</html>")
        service._overflow_layout_cache = {"hierarchical": str(h_file)}
        with patch.object(service, "_load_layout_coords", return_value={}):
            with pytest.raises(ValueError, match="no grid_layout.json"):
                service.regenerate_overflow_graph("geo")
        assert "geo" not in service._overflow_layout_cache

    def test_regenerate_geo_surfaces_transform_errors(self, tmp_path):
        import pytest
        service = RecommenderService()
        h_file = tmp_path / "overflow.html"
        h_file.write_text("<html>hierarchical</html>")
        service._overflow_layout_cache = {"hierarchical": str(h_file)}
        with patch.object(service, "_load_layout_coords", return_value={"A": (0, 0)}), \
             patch(
                "expert_backend.services.analysis.overflow_geo_transform.transform_html",
                side_effect=ValueError("No positioned nodes"),
             ):
            with pytest.raises(ValueError, match="No positioned nodes"):
                service.regenerate_overflow_graph("geo")
        assert "geo" not in service._overflow_layout_cache

    def test_regenerate_geo_second_call_hits_cache(self, tmp_path):
        """The second Geo click MUST NOT re-run the transform."""
        service = RecommenderService()
        h_file = tmp_path / "overflow.html"
        h_file.write_text("<html>hierarchical</html>")
        service._overflow_layout_cache = {"hierarchical": str(h_file)}

        with patch.object(service, "_load_layout_coords", return_value={"A": (0, 0)}), \
             patch(
                "expert_backend.services.analysis.overflow_geo_transform.transform_html",
                return_value="<html>geo</html>",
             ) as transform:
            first = service.regenerate_overflow_graph("geo")
            second = service.regenerate_overflow_graph("geo")

        assert first["cached"] is False
        assert second["cached"] is True
        assert second["pdf_path"] == first["pdf_path"]
        transform.assert_called_once()

    def test_regenerate_toggle_between_modes_reuses_cache(self, tmp_path):
        """Hier → Geo → Hier → Geo should transform exactly once."""
        service = RecommenderService()
        h_file = tmp_path / "overflow.html"
        h_file.write_text("<html>hierarchical</html>")
        service._overflow_layout_cache = {"hierarchical": str(h_file)}

        with patch.object(service, "_load_layout_coords", return_value={"A": (0, 0)}), \
             patch(
                "expert_backend.services.analysis.overflow_geo_transform.transform_html",
                return_value="<html>geo</html>",
             ) as transform:
            r1 = service.regenerate_overflow_graph("hierarchical")
            r2 = service.regenerate_overflow_graph("geo")
            r3 = service.regenerate_overflow_graph("hierarchical")
            r4 = service.regenerate_overflow_graph("geo")

        # Every call is a cache hit because hierarchical is pre-seeded
        # and geo was cached after the first miss.
        assert [r1["cached"], r2["cached"], r3["cached"], r4["cached"]] == [True, False, True, True]
        transform.assert_called_once()

    def test_reset_clears_overflow_layout_state(self):
        service = RecommenderService()
        service._overflow_layout_mode = "geo"
        service._overflow_layout_cache = {"geo": "/tmp/x.html"}
        service._last_step2_context = {"env": MagicMock()}
        service.reset()
        assert service._overflow_layout_mode == "hierarchical"
        assert service._overflow_layout_cache == {}
        assert service._last_step2_context is None
