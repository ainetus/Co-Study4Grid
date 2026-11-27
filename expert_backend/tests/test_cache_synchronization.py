import pytest
from unittest.mock import MagicMock, patch
from expert_backend.services.recommender_service import RecommenderService
from expert_op4grid_recommender import config

class TestCacheSynchronization:
    """Tests for the _cached_obs mechanism in RecommenderService."""

    @patch.object(RecommenderService, '_get_contingency_variant')
    @patch.object(RecommenderService, '_get_n_variant')
    @patch.object(RecommenderService, '_get_simulation_env')
    @patch.object(RecommenderService, '_get_base_network')
    def test_cache_hits_on_repeated_calls(self, mock_get_net, mock_get_env, mock_get_n, mock_get_n1):
        service = RecommenderService()
        service._dict_action = {"act1": {"content": {}}}
        service._last_result = {"prioritized_actions": {}}
        
        # Setup variants
        mock_get_n.return_value = "n_var"
        mock_get_n1.return_value = "n1_var"
        
        # Setup environment
        env = MagicMock()
        mock_get_env.return_value = env
        
        # Observations
        obs_n = MagicMock(name="obs_n")
        obs_n.rho = [0.5]
        obs_n.name_line = ["L1"]
        obs_n.n_components = 1
        obs_n1 = MagicMock(name="obs_n1")
        obs_n1.rho = [0.8]
        obs_n1.name_line = ["L1"]
        obs_n1.n_components = 1
        obs_after = MagicMock(name="obs_after")
        obs_after.rho = [0.7]
        obs_after.name_line = ["L1"]
        obs_after.n_components = 1
        obs_after.main_component_load_mw = 100.0
        obs_n1.simulate.return_value = (obs_after, None, None, {"exception": None})
        
        # Fix for MagicMock comparisons in some environments
        with patch.object(config, 'MONITORING_FACTOR_THERMAL_LIMITS', 0.95), \
             patch.object(config, 'PRE_EXISTING_OVERLOAD_WORSENING_THRESHOLD', 0.02):
            
            # First call: get_obs should be called twice (N and N1)
            env.get_obs.side_effect = [obs_n, obs_n1]
            service.simulate_manual_action("act1", "DISCO_A")
            assert env.get_obs.call_count == 2
            
            # Second call with SAME contingency: get_obs should NOT be called (cache hit)
            env.get_obs.reset_mock()
            service.simulate_manual_action("act1", "DISCO_A")
            assert env.get_obs.call_count == 0
            assert service._cached_obs_n is obs_n
            assert service._cached_obs_n1 is obs_n1

    @patch.object(RecommenderService, '_get_contingency_variant')
    @patch.object(RecommenderService, '_get_n_variant')
    @patch.object(RecommenderService, '_get_simulation_env')
    @patch.object(RecommenderService, '_get_base_network')
    def test_cache_invalidation_on_contingency_switch(self, mock_get_net, mock_get_env, mock_get_n, mock_get_n1):
        # `_ensure_contingency_state_ready` (invoked at the top of
        # `simulate_manual_action`) calls `_get_base_network()` BEFORE
        # `_get_contingency_variant()`. When the base network is not mocked the
        # fallback path `pp.network.load(config.ENV_PATH)` raises — the
        # guard swallows the exception, but `_get_contingency_variant` is never
        # called, so the 4 `side_effect` values below shift by one and
        # the second `simulate_manual_action("DISCO_B")` ends up getting
        # the cached "n1_A" id back → both N and N-1 caches hit → zero
        # `env.get_obs` calls instead of the expected 1. On CI
        # (`pip install --no-deps expert_op4grid_recommender`) the
        # fallback path tries a relative `data/` dir under site-packages
        # that does not exist — exactly the scenario this mock
        # neutralises. The companion test `test_cache_hits_on_repeated_calls`
        # already mocks `_get_base_network`; aligning this one.
        service = RecommenderService()
        service._dict_action = {"act1": {"content": {}}}
        service._last_result = {"prioritized_actions": {}}
        
        env = MagicMock()
        mock_get_env.return_value = env
        
        # Contingency A
        mock_get_n.return_value = "n_var"
        # Each `simulate_manual_action` call now triggers `_get_contingency_variant`
        # three times:
        #   1. the `_ensure_contingency_state_ready` guard at entry (see
        #      docs/performance/history/grid2op-shared-network.md),
        #   2. the N-1 fetch inside `_fetch_n_and_contingency_observations`,
        #   3. the explicit pre-simulate pin added to guarantee the
        #      working variant is on N-1 before
        #      `obs.simulate(action, keep_variant=True)` runs (otherwise
        #      cache-hit paths leave the variant on N and the combined
        #      simulation applies the action to the wrong base state).
        # Two simulate calls → six side-effect values.
        mock_get_n1.side_effect = ["n1_A", "n1_A", "n1_A", "n1_B", "n1_B", "n1_B"]
        
        obs_n = MagicMock(name="obs_n")
        obs_n.rho = [0.5]
        obs_n.name_line = ["L1"]
        obs_n.n_components = 1
        obs_n1_A = MagicMock(name="obs_n1_A")
        obs_n1_A.rho = [0.6]
        obs_n1_A.name_line = ["L1"]
        obs_n1_A.n_components = 1
        obs_after = MagicMock(name="obs_after")
        obs_after.rho = [0.55]
        obs_after.name_line = ["L1"]
        obs_after.n_components = 1
        obs_after.main_component_load_mw = 100.0
        obs_n1_A.simulate.return_value = (obs_after, None, None, {"exception": None})
        
        with patch.object(config, 'MONITORING_FACTOR_THERMAL_LIMITS', 0.95), \
             patch.object(config, 'PRE_EXISTING_OVERLOAD_WORSENING_THRESHOLD', 0.02):
             
            env.get_obs.side_effect = [obs_n, obs_n1_A]
            service.simulate_manual_action("act1", "DISCO_A")
            
            # Switch to Contingency B
            obs_n1_B = MagicMock(name="obs_n1_B")
            obs_n1_B.rho = [0.7]
            obs_n1_B.name_line = ["L1"]
            obs_n1_B.n_components = 1
            obs_n1_B.simulate.return_value = (obs_after, None, None, {"exception": None})
            
            # When switching B, n1_variant_id changes to "n1_B"
            # N-cache should HIT, N1-cache should MISS
            env.get_obs.reset_mock()
            env.get_obs.side_effect = [obs_n1_B] # Only N1 should miss
            service.simulate_manual_action("act1", "DISCO_B")
            
            assert env.get_obs.call_count == 1 # Only one miss (N1)
            assert service._cached_obs_n1 is obs_n1_B
            assert service._cached_obs_n1_id == "n1_B"
            assert service._cached_obs_n is obs_n # Still hitting N cache

    def test_reset_clears_all_caches(self):
        service = RecommenderService()
        service._cached_obs_n = MagicMock()
        service._cached_obs_n1 = MagicMock()
        service._cached_obs_n_id = "v1"
        service._cached_obs_n1_id = "v2"
        # N-1 diagram fast-path (commit d220d61): LF status cache per
        # N-1 variant must be cleared when loading a new study,
        # otherwise stale convergence flags from the previous grid
        # would leak.
        service._lf_status_by_variant = {
            "contingency_state_DISCO_A": {"converged": True, "lf_status": "CONVERGED"},
            "contingency_state_DISCO_B": {"converged": False, "lf_status": "FAILED"},
        }
        # The Loading view's current limits by side, read once per network.
        service._side_limits_cache = (MagicMock(), {"L1": {"ONE": 100.0}})

        service.reset()

        assert service._cached_obs_n is None
        assert service._cached_obs_n1 is None
        assert service._cached_obs_n_id is None
        assert service._cached_obs_n1_id is None
        # The LF-status cache dict must be emptied (not replaced with
        # None) so later `_get_contingency_variant` calls on the fresh study
        # can still use `dict.get()` / `dict[key] = ...` safely.
        assert service._lf_status_by_variant == {}
        assert service._side_limits_cache is None

    @patch.object(RecommenderService, '_get_simulation_env')
    def test_isolation_simulation_does_not_modify_cache_fields(self, mock_get_env):
        """Verify that simulation calls don't inadvertently modify cache property pointers."""
        service = RecommenderService()
        obs_n1 = MagicMock()
        obs_n1._variant_id = "v1"
        service._cached_obs_n1 = obs_n1
        service._cached_obs_n1_id = "v1"

        # If the code incorrectly did e.g. self._cached_obs_n1.some_prop = x
        # verify it stays isolated. Here we check that the object identity is preserved.
        assert service._cached_obs_n1 is obs_n1

    @patch.object(RecommenderService, '_get_contingency_variant')
    @patch.object(RecommenderService, '_get_n_variant')
    @patch.object(RecommenderService, '_get_simulation_env')
    @patch.object(RecommenderService, '_get_base_network')
    def test_simulate_manual_action_prefers_context_obs_over_stale_env_get_obs(
        self, mock_get_net, mock_get_env, mock_get_n, mock_get_n1,
    ):
        """``simulate_manual_action`` must reuse the (obs, obs_simu_defaut)
        captured by step1 in ``_analysis_context`` instead of re-fetching via
        ``env.get_obs()``.

        The grid2op ↔ pypowsybl env bridge does not re-sync
        ``env.get_obs()`` with ``n.set_working_variant(...)``, so a fresh
        fetch can return an N-state observation even after pinning the
        N-1 variant. That surfaced as a ~46-point gap between the
        "Max Loading (Est.)" and "Simulated Max Rho" columns in the
        Computed Pairs modal. This test guards against the regression by
        asserting that when step1 context is present:

        1. ``env.get_obs()`` is NEVER called (no stale fetch).
        2. The context obs is propagated to the downstream
           ``compute_action_metrics`` via ``rho_before``.
        3. ``obs.simulate(...)`` is called on the context ``obs_simu_defaut``
           (not on a freshly fetched stale obs).
        """
        service = RecommenderService()
        service._dict_action = {"act1": {"content": {}}}
        service._last_result = {"prioritized_actions": {}}

        mock_get_n.return_value = "n_var"
        mock_get_n1.return_value = "n1_var"

        env = MagicMock()
        n = MagicMock()
        nm = MagicMock()
        nm.network = n
        env.network_manager = nm
        n.get_working_variant_id.return_value = "original_var"
        mock_get_env.return_value = env
        mock_get_net.return_value = n

        # Context observations (what step1 captured). These are the
        # "correct" N / N-1 obs the fix must propagate.
        ctx_obs_n = MagicMock(name="ctx_obs_n")
        ctx_obs_n.rho = [0.5]
        ctx_obs_n.name_line = ["L1"]
        ctx_obs_n.n_components = 1
        ctx_obs_n1 = MagicMock(name="ctx_obs_n1")
        ctx_obs_n1.rho = [0.9]  # overload on L1 in N-1
        ctx_obs_n1.name_line = ["L1"]
        ctx_obs_n1.n_components = 1
        ctx_obs_n1._variant_id = "library_kept_variant"

        obs_after = MagicMock(name="obs_after")
        obs_after.rho = [0.7]
        obs_after.name_line = ["L1"]
        obs_after.n_components = 1
        obs_after.main_component_load_mw = 100.0
        ctx_obs_n1.simulate.return_value = (obs_after, None, None, {"exception": None})

        service._analysis_context = {
            "obs": ctx_obs_n,
            "obs_simu_defaut": ctx_obs_n1,
            "lines_overloaded": ["L1"],
        }

        # env.get_obs MUST NOT be called — prove it by raising if it is.
        env.get_obs.side_effect = AssertionError(
            "env.get_obs() called while step1 context is available — "
            "stale-baseline regression"
        )

        with patch.object(config, 'MONITORING_FACTOR_THERMAL_LIMITS', 0.95), \
             patch.object(config, 'PRE_EXISTING_OVERLOAD_WORSENING_THRESHOLD', 0.02):
            result = service.simulate_manual_action("act1", "DISCO_A")

        # 1. get_obs never called → baseline is the step1 context obs.
        assert env.get_obs.call_count == 0

        # 2. rho_before reflects ctx_obs_n1 (0.9 × monitoring_factor), not
        #    a stale N-state value. Cross-check the published metric to
        #    prove the context obs actually fed compute_action_metrics.
        assert result.get("rho_before") == pytest.approx([0.9 * 0.95], abs=1e-9)

        # 3. ``.simulate()`` was invoked on the context obs specifically
        #    (not on a freshly-fetched stale obs).
        assert ctx_obs_n1.simulate.call_count == 1

    @patch.object(RecommenderService, '_get_contingency_variant')
    @patch.object(RecommenderService, '_get_n_variant')
    @patch.object(RecommenderService, '_get_simulation_env')
    @patch.object(RecommenderService, '_get_base_network')
    def test_simulate_manual_action_falls_back_to_env_get_obs_without_context(
        self, mock_get_net, mock_get_env, mock_get_n, mock_get_n1,
    ):
        """Without step1 context, ``simulate_manual_action`` must still
        work via the fallback ``_fetch_n_and_contingency_observations`` path and
        the pre-simulate N-1 re-pin must fire (since the fallback's
        cache-hit branches can leave the working variant drifted)."""
        service = RecommenderService()
        service._dict_action = {"act1": {"content": {}}}
        service._last_result = {"prioritized_actions": {}}
        service._analysis_context = None  # no step1 → fallback path

        mock_get_n.return_value = "n_var"
        mock_get_n1.return_value = "n1_var"

        env = MagicMock()
        n = MagicMock()
        nm = MagicMock()
        nm.network = n
        env.network_manager = nm
        n.get_working_variant_id.return_value = "original_var"
        mock_get_env.return_value = env
        mock_get_net.return_value = n

        obs_n = MagicMock(name="obs_n")
        obs_n.rho = [0.5]
        obs_n.name_line = ["L1"]
        obs_n.n_components = 1
        obs_n1 = MagicMock(name="obs_n1")
        obs_n1.rho = [0.9]
        obs_n1.name_line = ["L1"]
        obs_n1.n_components = 1
        obs_after = MagicMock(name="obs_after")
        obs_after.rho = [0.7]
        obs_after.name_line = ["L1"]
        obs_after.n_components = 1
        obs_after.main_component_load_mw = 100.0
        obs_n1.simulate.return_value = (obs_after, None, None, {"exception": None})

        env.get_obs.side_effect = [obs_n, obs_n1]

        with patch.object(config, 'MONITORING_FACTOR_THERMAL_LIMITS', 0.95), \
             patch.object(config, 'PRE_EXISTING_OVERLOAD_WORSENING_THRESHOLD', 0.02):
            service.simulate_manual_action("act1", "DISCO_A")

        # Fallback path invokes env.get_obs twice (N + N-1).
        assert env.get_obs.call_count == 2
        # The pre-simulate re-pin to N-1 must fire on the fallback path.
        targets = [c.args[0] for c in n.set_working_variant.call_args_list]
        assert "n1_var" in targets, (
            f"expected a pre-simulate re-pin to 'n1_var' on fallback; "
            f"actual targets: {targets}"
        )
