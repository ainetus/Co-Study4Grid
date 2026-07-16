import pytest
import time
import numpy as np
from unittest.mock import MagicMock, patch
import pandas as pd
from expert_backend.services.recommender_service import RecommenderService
from expert_op4grid_recommender import config

class TestPerformanceBudgets:
    """Benchmark tests to ensure logic stays within performance budgets."""

    def _make_large_obs(self, n_lines=2000):
        obs = MagicMock()
        obs.rho = np.random.rand(n_lines)
        obs.name_line = [f"LINE_{i}" for i in range(n_lines)]
        obs.n_components = 1
        obs.main_component_load_mw = 100.0
        obs._network_manager = MagicMock()
        network = MagicMock()
        obs._network_manager.network = network
        
        limits_df = pd.DataFrame({
            'element_id': obs.name_line,
            'type': ['CURRENT'] * n_lines,
            'acceptable_duration': [-1] * n_lines,
        })
        network.get_operational_limits.return_value = limits_df
        return obs

    @patch.object(RecommenderService, '_get_contingency_variant')
    @patch.object(RecommenderService, '_get_n_variant')
    @patch.object(RecommenderService, '_get_simulation_env')
    @patch.object(RecommenderService, '_get_base_network')
    def test_simulation_logic_budget_large_grid(self, mock_get_net, mock_get_env, mock_get_n, mock_get_n1):
        """Budget: < 50ms for 2,000 lines (logic only, mocked simulation)."""
        service = RecommenderService()
        service._dict_action = {"act1": {"content": {}}}
        service._last_result = {"prioritized_actions": {}}
        
        n_lines = 2000
        obs_n = self._make_large_obs(n_lines)
        obs_n1 = self._make_large_obs(n_lines)
        obs_after = self._make_large_obs(n_lines)
        
        # Mock simulation to be instant
        obs_n1.simulate.return_value = (obs_after, None, None, {"exception": None})
        
        env = MagicMock()
        env.get_obs.side_effect = [obs_n, obs_n1]
        mock_get_env.return_value = env
        
        with patch.object(config, 'MONITORING_FACTOR_THERMAL_LIMITS', 0.95), \
             patch.object(config, 'PRE_EXISTING_OVERLOAD_WORSENING_THRESHOLD', 0.02):
            
            # Warm up
            service.simulate_manual_action("act1", "DISCO_1")

            # Measured runs (using cache for N/N1 to isolate logic).
            # Best-of-3: an absolute wall-clock budget on a shared CI runner
            # is dominated by scheduler noise (CPU steal, GC pauses) — a real
            # regression slows EVERY run, noise rarely hits all three.
            durations = []
            for _ in range(3):
                start_time = time.perf_counter()
                service.simulate_manual_action("act1", "DISCO_1")
                end_time = time.perf_counter()
                durations.append((end_time - start_time) * 1000)
            duration_ms = min(durations)
            print(f"\n[PERF] 2,000 line simulation logic took {duration_ms:.2f}ms (best of 3)")

            # Target: < 50ms. Vectorized logic should easily be < 10ms on modern CPUs.
            assert duration_ms < 50, f"Performance regression! Logic took {duration_ms:.2f}ms (budget: 50ms)"

    @patch.object(RecommenderService, '_get_contingency_variant')
    @patch.object(RecommenderService, '_get_n_variant')
    @patch.object(RecommenderService, '_get_simulation_env')
    def test_simulation_logic_budget_small_grid(self, mock_get_env, mock_get_n, mock_get_n1):
        """Budget: < 150ms for small scale (e.g. 100 lines)."""
        service = RecommenderService()
        service._dict_action = {"act1": {"content": {}}}
        service._last_result = {"prioritized_actions": {}}
        
        n_lines = 100
        obs_n = self._make_large_obs(n_lines)
        obs_n1 = self._make_large_obs(n_lines)
        obs_after = self._make_large_obs(n_lines)
        obs_n1.simulate.return_value = (obs_after, None, None, {"exception": None})
        
        env = MagicMock()
        env.get_obs.side_effect = [obs_n, obs_n1]
        mock_get_env.return_value = env
        
        with patch.object(config, 'MONITORING_FACTOR_THERMAL_LIMITS', 0.95):
            # Warm up to absorb first-call overhead (module import resolution,
            # MagicMock attribute caching, cold BLAS/pandas paths). Without
            # this, a cold first call on a loaded CI machine occasionally
            # spikes past the budget even though the steady-state logic is
            # an order of magnitude faster. Mirrors the warm-up in the
            # large-grid test above.
            service.simulate_manual_action("act1", "DISCO_1")

            # Best-of-3 (same rationale as the large-grid test: shed shared-
            # runner scheduler noise; a real regression slows every run).
            # env.get_obs is re-driven from a side_effect iterator on every
            # simulate_manual_action call, so it is rebuilt per run — the
            # warm-up consumed the first two obs values we prepared.
            durations = []
            for _ in range(3):
                obs_n2 = self._make_large_obs(n_lines)
                obs_n1_2 = self._make_large_obs(n_lines)
                obs_after2 = self._make_large_obs(n_lines)
                obs_n1_2.simulate.return_value = (obs_after2, None, None, {"exception": None})
                env.get_obs.side_effect = [obs_n2, obs_n1_2]

                start_time = time.perf_counter()
                service.simulate_manual_action("act1", "DISCO_1")
                end_time = time.perf_counter()
                durations.append((end_time - start_time) * 1000)
            duration_ms = min(durations)
            print(f"\n[PERF] 100 line simulation logic took {duration_ms:.2f}ms (best of 3)")

            assert duration_ms < 150, f"Performance regression! Small logic took {duration_ms:.2f}ms (budget: 150ms)"
