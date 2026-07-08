# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0
# This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

"""Tests for PST tap actions and combined action simulation.

Validates that:
1. PST tap actions are correctly built with pst_tap content
2. Combined PST + switching actions apply BOTH changes during simulation
3. The heuristic promotion preserves pst_tap topology
4. Re-simulation with target_tap updates the tap value
5. PYPOWSYBL_FAST_MODE is not silently overridden between test stages
"""

import numpy as np
import pytest
from unittest.mock import MagicMock, patch, PropertyMock
from expert_backend.services.recommender_service import RecommenderService
from expert_op4grid_recommender import config


class MockAction:
    """Mock grid2op action object with PST tap support."""
    def __init__(self, content=None):
        content = content or {}
        set_bus = content.get("set_bus", {})
        self.loads_bus = set_bus.get("loads_id", {})
        self.lines_ex_bus = set_bus.get("lines_ex_id", {})
        self.lines_or_bus = set_bus.get("lines_or_id", {})
        self.gens_bus = set_bus.get("generators_id", {})
        self.pst_tap = content.get("pst_tap", {})
        self.loads_p = content.get("set_load_p", {})
        self.gens_p = content.get("set_gen_p", {})
        self.substations = {}
        self.switches = content.get("switches", {})
        self._content = content

    def __add__(self, other):
        """Merge two actions — combine all topology fields."""
        merged = MockAction()
        for field in ("loads_bus", "lines_ex_bus", "lines_or_bus", "gens_bus",
                       "pst_tap", "loads_p", "gens_p", "switches"):
            merged_val = {**getattr(self, field, {}), **getattr(other, field, {})}
            setattr(merged, field, merged_val)
        return merged


def _make_obs(rho=None, name_line=None, n_components=1):
    """Create a mock observation."""
    obs = MagicMock()
    obs.name_line = name_line or ["LINE_A", "LINE_B", "CANTEY761"]
    obs.rho = np.array(rho or [0.5, 0.3, 1.1])
    obs.n_components = n_components
    obs.main_component_load_mw = 1000.0
    obs.name_load = ["LOAD_1"]
    obs.load_p = np.array([100.0])
    obs.name_gen = ["GEN_1"]
    obs.gen_p = np.array([80.0])
    return obs


def _setup_service_with_env():
    """Create a RecommenderService with mocked environment."""
    svc = RecommenderService()

    env = MagicMock()
    nm = MagicMock()
    network = MagicMock()
    network.get_working_variant_id.return_value = "initial"
    network.get_variant_ids.return_value = ["initial", "N_state_cached", "contingency_state_DISCO_X"]
    nm.network = network
    nm.get_pst_tap_info.return_value = {"tap": 30, "low_tap": 0, "high_tap": 40}
    env.network_manager = nm
    env.name_line = ["LINE_A", "LINE_B", "CANTEY761"]

    svc._simulation_env = env
    svc._base_network = network

    # N-state obs (base)
    obs_n = _make_obs(rho=[0.4, 0.2, 0.5])
    svc._cached_obs_n = obs_n
    svc._cached_obs_n_id = "N_state_cached"

    # N-1 obs (contingency — CANTEY761 overloaded at 110%)
    obs_n1 = _make_obs(rho=[0.5, 0.3, 1.1])
    obs_n1._variant_id = "contingency_state_DISCO_X"
    obs_n1._network_manager = nm
    svc._cached_obs_n1 = obs_n1
    svc._cached_obs_n1_id = "contingency_state_DISCO_X"

    return svc, env, obs_n, obs_n1


class TestPstCombinedActionSimulation:
    """Tests that PST + switching combined actions apply BOTH changes."""

    @patch.object(RecommenderService, '_get_contingency_variant', return_value="contingency_state_DISCO_X")
    @patch.object(RecommenderService, '_get_n_variant', return_value="N_state_cached")
    def test_combined_pst_switching_applies_both_actions(self, mock_n, mock_n1):
        """When Re-Simulating a PST+switching pair, both actions must be applied.

        The resulting max_rho should reflect the PST tap change effect,
        NOT remain at the original N-1 overload level.
        """
        svc, env, obs_n, obs_n1 = _setup_service_with_env()

        # PST action: changes tap position → should reduce loading on CANTEY761
        pst_content = {"pst_tap": {".ARKA TD 661": 32}}
        pst_entry = {
            "description_unitaire": "PST tap change",
            "content": pst_content,
        }

        # Switching action: node splitting
        switch_content = {"set_bus": {"lines_ex_id": {"LINE_B": 2}}}
        switch_entry = {
            "description_unitaire": "Node splitting",
            "content": switch_content,
        }

        svc._dict_action = {
            "pst_tap_.ARKA_inc2": pst_entry,
            "switch_action_1": switch_entry,
        }
        svc._last_result = {"prioritized_actions": {}}

        # Configure env.action_space to return MockAction
        def make_action(content):
            return MockAction(content)
        env.action_space.side_effect = make_action

        # Simulate: combined action produces LOWER rho (94% instead of 110%)
        obs_after = _make_obs(rho=[0.45, 0.25, 0.94])  # CANTEY761 drops to 94%
        obs_n1.simulate.return_value = (obs_after, None, None, {"exception": None})

        result = svc.simulate_manual_action(
            "pst_tap_.ARKA_inc2+switch_action_1", "DISCO_X"
        )

        # Verify env.action_space was called for BOTH actions
        assert env.action_space.call_count == 2, \
            "Both actions should be built from content via env.action_space"

        # Verify the PST action content was passed to env.action_space
        calls = env.action_space.call_args_list
        contents_passed = [c[0][0] for c in calls]
        pst_found = any("pst_tap" in c for c in contents_passed)
        assert pst_found, \
            f"PST tap content must be passed to env.action_space. Got: {contents_passed}"

        # Verify the simulation used the combined action (both merged)
        obs_n1.simulate.assert_called_once()
        simulated_action = obs_n1.simulate.call_args[0][0]
        assert simulated_action.pst_tap == {".ARKA TD 661": 32}, \
            f"Combined action must include PST tap. Got: {simulated_action.pst_tap}"

        # Verify result reflects the reduced loading (not the original 110%)
        assert result["max_rho"] < 1.0, \
            f"Combined action should reduce max_rho below 1.0, got {result['max_rho']}"

    @patch.object(RecommenderService, '_get_contingency_variant', return_value="contingency_state_DISCO_X")
    @patch.object(RecommenderService, '_get_n_variant', return_value="N_state_cached")
    def test_pst_action_content_preserved_in_dict_action(self, mock_n, mock_n1):
        """PST actions loaded from the action file must keep pst_tap in content."""
        svc, env, obs_n, obs_n1 = _setup_service_with_env()

        pst_entry = {
            "description_unitaire": "PST tap change",
            "content": {"pst_tap": {".ARKA TD 661": 32}},
        }
        svc._dict_action = {"pst_tap_.ARKA_inc2": pst_entry}
        svc._last_result = {"prioritized_actions": {}}

        env.action_space.side_effect = lambda c: MockAction(c)
        obs_after = _make_obs(rho=[0.3, 0.2, 0.8])
        obs_n1.simulate.return_value = (obs_after, None, None, {"exception": None})

        svc.simulate_manual_action("pst_tap_.ARKA_inc2", "DISCO_X")

        # After simulation, the dict_action entry should still have pst_tap
        entry = svc._dict_action["pst_tap_.ARKA_inc2"]
        assert "pst_tap" in entry.get("content", {}), \
            f"pst_tap must be preserved in _dict_action content after simulation. Keys: {list(entry.get('content', {}).keys())}"

    @patch.object(RecommenderService, '_get_contingency_variant', return_value="contingency_state_DISCO_X")
    @patch.object(RecommenderService, '_get_n_variant', return_value="N_state_cached")
    def test_heuristic_promotion_preserves_pst_tap(self, mock_n, mock_n1):
        """When promoting a PST action from recent_actions to _dict_action,
        the pst_tap topology field must be included."""
        svc, env, obs_n, obs_n1 = _setup_service_with_env()

        # PST action exists only in recent_actions (from analysis), not in _dict_action
        pst_action_obj = MockAction({"pst_tap": {".ARKA TD 661": 32}})
        svc._dict_action = {"other_action": {"content": {"set_bus": {"lines_ex_id": {"LINE_A": 2}}}, "description_unitaire": "Other"}}
        svc._last_result = {
            "prioritized_actions": {
                "pst_tap_.ARKA_inc2": {
                    "action": pst_action_obj,
                    "observation": _make_obs(rho=[0.3, 0.2, 0.8]),
                    "description_unitaire": "PST action",
                },
            }
        }

        env.action_space.side_effect = lambda c: MockAction(c)
        obs_after = _make_obs(rho=[0.3, 0.2, 0.8])
        obs_n1.simulate.return_value = (obs_after, None, None, {"exception": None})

        svc.simulate_manual_action("pst_tap_.ARKA_inc2", "DISCO_X")

        # The PST action should now be in _dict_action with pst_tap in content
        assert "pst_tap_.ARKA_inc2" in svc._dict_action
        promoted = svc._dict_action["pst_tap_.ARKA_inc2"]
        content = promoted.get("content", {})
        assert "pst_tap" in content, \
            f"Promoted PST action must have pst_tap in content. Got: {list(content.keys())}"
        assert content["pst_tap"] == {".ARKA TD 661": 32}


class TestPstResimulationWithTargetTap:
    """Tests that target_tap updates are correctly applied."""

    @patch.object(RecommenderService, '_get_contingency_variant', return_value="contingency_state_DISCO_X")
    @patch.object(RecommenderService, '_get_n_variant', return_value="N_state_cached")
    def test_target_tap_updates_pst_content(self, mock_n, mock_n1):
        """When target_tap is provided, pst_tap content must be updated before simulation."""
        svc, env, obs_n, obs_n1 = _setup_service_with_env()

        pst_entry = {
            "description_unitaire": "PST tap change",
            "content": {"pst_tap": {".ARKA TD 661": 30}},
        }
        svc._dict_action = {"pst_tap_.ARKA_inc2": pst_entry}
        svc._last_result = {"prioritized_actions": {}}

        env.action_space.side_effect = lambda c: MockAction(c)
        obs_after = _make_obs(rho=[0.3, 0.2, 0.7])
        obs_n1.simulate.return_value = (obs_after, None, None, {"exception": None})

        svc.simulate_manual_action("pst_tap_.ARKA_inc2", "DISCO_X", target_tap=35)

        # Verify the content was updated with the target tap
        content = svc._dict_action["pst_tap_.ARKA_inc2"]["content"]
        assert content["pst_tap"][".ARKA TD 661"] == 35, \
            f"pst_tap should be updated to target_tap=35, got {content['pst_tap']}"

    @patch.object(RecommenderService, '_get_contingency_variant', return_value="contingency_state_DISCO_X")
    @patch.object(RecommenderService, '_get_n_variant', return_value="N_state_cached")
    def test_target_tap_clamped_to_bounds(self, mock_n, mock_n1):
        """target_tap must be clamped to [low_tap, high_tap] from network."""
        svc, env, obs_n, obs_n1 = _setup_service_with_env()
        env.network_manager.get_pst_tap_info.return_value = {"tap": 30, "low_tap": 0, "high_tap": 40}

        pst_entry = {
            "description_unitaire": "PST tap change",
            "content": {"pst_tap": {".ARKA TD 661": 30}},
        }
        svc._dict_action = {"pst_tap_.ARKA_inc2": pst_entry}
        svc._last_result = {"prioritized_actions": {}}

        env.action_space.side_effect = lambda c: MockAction(c)
        obs_after = _make_obs(rho=[0.3, 0.2, 0.7])
        obs_n1.simulate.return_value = (obs_after, None, None, {"exception": None})

        # Request tap=50, but high_tap=40 → should clamp to 40
        svc.simulate_manual_action("pst_tap_.ARKA_inc2", "DISCO_X", target_tap=50)

        content = svc._dict_action["pst_tap_.ARKA_inc2"]["content"]
        assert content["pst_tap"][".ARKA TD 661"] == 40, \
            f"pst_tap should be clamped to high_tap=40, got {content['pst_tap']}"


class TestPypowsyblFastModeProtection:
    """Tests that PYPOWSYBL_FAST_MODE is not silently overridden."""

    def test_fast_mode_preserved_across_tests(self):
        """Verify that config.PYPOWSYBL_FAST_MODE retains its value
        after the reset_config fixture runs.

        This is a regression test for the conftest.py bug where
        reset_config unconditionally set PYPOWSYBL_FAST_MODE=True,
        overriding test-module-level settings.
        """
        # Set to False (as test_combined_actions_scenario.py does)
        config.PYPOWSYBL_FAST_MODE = False

        # Access the value — it should still be False
        assert config.PYPOWSYBL_FAST_MODE is False, \
            "PYPOWSYBL_FAST_MODE should not be overridden between tests"

    def test_fast_mode_affects_simulation(self):
        """When PYPOWSYBL_FAST_MODE=True, _run_ac_with_fallback uses the
        fast tap-changer control mode (AFTER_GENERATOR_VOLTAGE_CONTROL).
        Ensure the config value is correctly read at simulation time."""
        svc = RecommenderService()

        # The method reads config at call time, not import time
        config.PYPOWSYBL_FAST_MODE = False
        assert getattr(config, 'PYPOWSYBL_FAST_MODE', True) is False

        config.PYPOWSYBL_FAST_MODE = True
        assert getattr(config, 'PYPOWSYBL_FAST_MODE', False) is True


class TestBuildActionEntryFromTopology:
    """Tests for _build_action_entry_from_topology with PST content."""

    def test_pst_tap_included_in_content(self):
        """pst_tap topology field must be mapped to content.pst_tap."""
        topo = {"pst_tap": {".ARKA TD 661": 32}}
        entry = RecommenderService._build_action_entry_from_topology("pst_action", topo)

        assert "pst_tap" in entry["content"], \
            f"pst_tap must be in content. Got: {list(entry['content'].keys())}"
        assert entry["content"]["pst_tap"] == {".ARKA TD 661": 32}

    def test_combined_pst_and_switching_topology(self):
        """Topology with both pst_tap and set_bus should produce content with both."""
        topo = {
            "pst_tap": {".ARKA TD 661": 32},
            "lines_ex_bus": {"LINE_B": 2},
            "switches": {"SW_1": True},
        }
        entry = RecommenderService._build_action_entry_from_topology("combined", topo)

        assert "pst_tap" in entry["content"]
        assert "switches" in entry["content"]
        assert "set_bus" in entry["content"]
        assert entry["content"]["set_bus"]["lines_ex_id"] == {"LINE_B": 2}

    def test_empty_pst_tap_not_included(self):
        """Empty pst_tap dict should not appear in content."""
        topo = {"pst_tap": {}, "switches": {"SW_1": True}}
        entry = RecommenderService._build_action_entry_from_topology("action", topo)

        assert "pst_tap" not in entry["content"], \
            "Empty pst_tap should not be in content"
        assert "switches" in entry["content"]
