# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0
# This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

"""Tests for new power reduction format (loads_p/gens_p) support.

The Expert_op4grid_recommender library now uses active power setpoint changes
(set_load_p/set_gen_p) instead of bus disconnection (bus=-1) for load shedding
and curtailment actions. These tests verify that Co-Study4Grid handles both
the legacy and new formats correctly.
"""

import numpy as np
import pytest
from unittest.mock import MagicMock, patch
from expert_backend.services.recommender_service import RecommenderService


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_obs(name_line, p_or, name_load=None, load_p=None,
              name_gen=None, gen_p=None):
    obs = MagicMock()
    obs.name_line = name_line
    obs.p_or = np.array(p_or, dtype=float)
    obs.name_load = name_load or []
    obs.load_p = np.array(load_p or [], dtype=float)
    obs.name_gen = name_gen or []
    obs.gen_p = np.array(gen_p or [], dtype=float)
    obs.rho = np.array([0.1] * len(name_line))
    return obs


def _make_service_with_context(obs_n1, dict_action=None):
    svc = RecommenderService()
    svc._analysis_context = {"obs_simu_defaut": obs_n1}
    svc._dict_action = dict_action or {}
    return svc


# ===========================================================================
# _compute_load_shedding_details — new power reduction format
# ===========================================================================

class TestComputeLoadSheddingPowerReduction:
    """Test _compute_load_shedding_details with loads_p (new format)."""

    def test_detects_load_from_loads_p_attribute(self):
        """Action object with loads_p attribute should be detected."""
        service = RecommenderService()
        service._analysis_context = {
            "obs_simu_defaut": _make_obs([], [], ["LOAD_1"], [50.0])
        }

        action_obj = MagicMock()
        action_obj.loads_bus = {}
        action_obj.loads_p = {"LOAD_1": 0.0}

        obs_action = MagicMock()
        obs_action.name_load = ["LOAD_1"]
        obs_action.load_p = np.array([0.0])  # reduced to 0

        action_data = {"action": action_obj, "observation": obs_action}

        with patch("expert_backend.services.network_service.network_service") as mock_ns:
            mock_ns.get_load_voltage_level.return_value = "VL_ALPHA"
            details = service._compute_load_shedding_details(action_data)

        assert details is not None
        assert len(details) == 1
        assert details[0]["load_name"] == "LOAD_1"
        assert details[0]["shedded_mw"] == 50.0
        assert details[0]["voltage_level_id"] == "VL_ALPHA"

    def test_detects_load_from_content_set_load_p(self):
        """Fallback: loads_p not on action object but in content.set_load_p."""
        service = RecommenderService()
        service._analysis_context = {
            "obs_simu_defaut": _make_obs([], [], ["MY_LOAD"], [30.0])
        }

        action_obj = MagicMock()
        action_obj.loads_bus = {}
        action_obj.loads_p = None  # not on the object

        obs_action = MagicMock()
        obs_action.name_load = ["MY_LOAD"]
        obs_action.load_p = np.array([5.0])  # reduced from 30 to 5

        action_data = {
            "action": action_obj,
            "observation": obs_action,
            "content": {"set_load_p": {"MY_LOAD": 5.0}},
        }

        with patch("expert_backend.services.network_service.network_service") as mock_ns:
            mock_ns.get_load_voltage_level.return_value = "VL_X"
            details = service._compute_load_shedding_details(action_data)

        assert details is not None
        assert len(details) == 1
        assert details[0]["load_name"] == "MY_LOAD"
        assert details[0]["shedded_mw"] == 25.0

    def test_no_duplicates_when_both_formats_present(self):
        """If same load appears in both loads_bus and loads_p, report once."""
        service = RecommenderService()
        service._analysis_context = {
            "obs_simu_defaut": _make_obs([], [], ["LOAD_A"], [100.0])
        }

        action_obj = MagicMock()
        action_obj.loads_bus = {"LOAD_A": -1}
        action_obj.loads_p = {"LOAD_A": 0.0}

        obs_action = MagicMock()
        obs_action.name_load = ["LOAD_A"]
        obs_action.load_p = np.array([0.0])

        action_data = {"action": action_obj, "observation": obs_action}

        with patch("expert_backend.services.network_service.network_service") as mock_ns:
            mock_ns.get_load_voltage_level.return_value = "VL_1"
            details = service._compute_load_shedding_details(action_data)

        assert details is not None
        assert len(details) == 1  # not 2

    def test_returns_none_when_neither_format_present(self):
        service = RecommenderService()
        action_obj = MagicMock()
        action_obj.loads_bus = {}
        action_obj.loads_p = {}

        action_data = {
            "action": action_obj,
            "observation": MagicMock(),
        }
        details = service._compute_load_shedding_details(action_data)
        assert details is None

    def test_legacy_format_still_works(self):
        """Legacy bus=-1 format should still be detected (backwards compat)."""
        service = RecommenderService()
        service._analysis_context = {
            "obs_simu_defaut": _make_obs([], [], ["LOAD_LEG"], [60.0])
        }

        action_obj = MagicMock()
        action_obj.loads_bus = {"LOAD_LEG": -1}
        action_obj.loads_p = None

        obs_action = MagicMock()
        obs_action.name_load = ["LOAD_LEG"]
        obs_action.load_p = np.array([0.0])

        action_data = {"action": action_obj, "observation": obs_action}

        with patch("expert_backend.services.network_service.network_service") as mock_ns:
            mock_ns.get_load_voltage_level.return_value = "VL_LEG"
            details = service._compute_load_shedding_details(action_data)

        assert details is not None
        assert details[0]["load_name"] == "LOAD_LEG"
        assert details[0]["shedded_mw"] == 60.0


# ===========================================================================
# _compute_curtailment_details — new power reduction format
# ===========================================================================

class TestComputeCurtailmentPowerReduction:
    """Test _compute_curtailment_details with gens_p (new format)."""

    def test_detects_gen_from_gens_p_attribute(self):
        service = RecommenderService()
        service._is_renewable_gen = MagicMock(return_value=True)
        service._analysis_context = {
            "obs_simu_defaut": _make_obs(
                [], [], name_gen=["WIND_1"], gen_p=[80.0]
            )
        }

        action_obj = MagicMock()
        action_obj.gens_bus = {}
        action_obj.gens_p = {"WIND_1": 0.0}

        obs_action = MagicMock()
        obs_action.name_gen = ["WIND_1"]
        obs_action.gen_p = np.array([0.0])

        action_data = {"action": action_obj, "observation": obs_action}

        with patch("expert_backend.services.network_service.network_service") as mock_ns:
            mock_ns.get_generator_voltage_level.return_value = "VL_WIND"
            details = service._compute_curtailment_details(action_data)

        assert details is not None
        assert len(details) == 1
        assert details[0]["gen_name"] == "WIND_1"
        assert details[0]["curtailed_mw"] == 80.0
        assert details[0]["voltage_level_id"] == "VL_WIND"

    def test_detects_gen_from_content_set_gen_p(self):
        service = RecommenderService()
        service._is_renewable_gen = MagicMock(return_value=True)
        service._analysis_context = {
            "obs_simu_defaut": _make_obs(
                [], [], name_gen=["SOLAR_1"], gen_p=[50.0]
            )
        }

        action_obj = MagicMock()
        action_obj.gens_bus = {}
        action_obj.gens_p = None

        obs_action = MagicMock()
        obs_action.name_gen = ["SOLAR_1"]
        obs_action.gen_p = np.array([10.0])

        action_data = {
            "action": action_obj,
            "observation": obs_action,
            "content": {"set_gen_p": {"SOLAR_1": 10.0}},
        }

        with patch("expert_backend.services.network_service.network_service") as mock_ns:
            mock_ns.get_generator_voltage_level.return_value = "VL_SOLAR"
            details = service._compute_curtailment_details(action_data)

        assert details is not None
        assert details[0]["gen_name"] == "SOLAR_1"
        assert details[0]["curtailed_mw"] == 40.0

    def test_no_duplicates_when_both_formats_present(self):
        service = RecommenderService()
        service._is_renewable_gen = MagicMock(return_value=True)
        service._analysis_context = {
            "obs_simu_defaut": _make_obs([], [], name_gen=["GEN_A"], gen_p=[70.0])
        }

        action_obj = MagicMock()
        action_obj.gens_bus = {"GEN_A": -1}
        action_obj.gens_p = {"GEN_A": 0.0}

        obs_action = MagicMock()
        obs_action.name_gen = ["GEN_A"]
        obs_action.gen_p = np.array([0.0])

        action_data = {"action": action_obj, "observation": obs_action}

        with patch("expert_backend.services.network_service.network_service") as mock_ns:
            mock_ns.get_generator_voltage_level.return_value = "VL_1"
            details = service._compute_curtailment_details(action_data)

        assert details is not None
        assert len(details) == 1

    def test_legacy_gens_bus_still_works(self):
        service = RecommenderService()
        service._is_renewable_gen = MagicMock(return_value=True)
        service._analysis_context = {
            "obs_simu_defaut": _make_obs([], [], name_gen=["EOL_1"], gen_p=[90.0])
        }

        action_obj = MagicMock()
        action_obj.gens_bus = {"EOL_1": -1}
        action_obj.gens_p = None

        obs_action = MagicMock()
        obs_action.name_gen = ["EOL_1"]
        obs_action.gen_p = np.array([0.0])

        action_data = {"action": action_obj, "observation": obs_action}

        with patch("expert_backend.services.network_service.network_service") as mock_ns:
            mock_ns.get_generator_voltage_level.return_value = "VL_EOL"
            details = service._compute_curtailment_details(action_data)

        assert details is not None
        assert details[0]["gen_name"] == "EOL_1"
        assert details[0]["curtailed_mw"] == 90.0


# ===========================================================================
# _mw_start_load_shedding — new set_load_p content format
# ===========================================================================

class TestMwStartLoadSheddingPowerReduction:
    def test_extracts_load_p_from_set_load_p_content(self):
        obs = _make_obs([], [], name_load=["LOAD_1", "LOAD_2"], load_p=[150.0, 80.0])
        dict_action = {
            "load_shedding_LOAD_1": {
                "content": {
                    "set_load_p": {"LOAD_1": 0.0}
                }
            }
        }
        svc = _make_service_with_context(obs, dict_action)

        scores = {"load_shedding": {"scores": {"load_shedding_LOAD_1": 0.4}}}
        result = svc._compute_mw_start_for_scores(scores)

        assert result["load_shedding"]["mw_start"]["load_shedding_LOAD_1"] == pytest.approx(150.0, abs=0.1)

    def test_sums_multiple_loads_from_set_load_p(self):
        obs = _make_obs([], [], name_load=["L1", "L2", "L3"], load_p=[60.0, 40.0, 20.0])
        dict_action = {
            "ls_multi": {
                "content": {
                    "set_load_p": {"L1": 0.0, "L2": 0.0}  # L3 not reduced
                }
            }
        }
        svc = _make_service_with_context(obs, dict_action)

        scores = {"load_shedding": {"scores": {"ls_multi": 0.3}}}
        result = svc._compute_mw_start_for_scores(scores)

        assert result["load_shedding"]["mw_start"]["ls_multi"] == pytest.approx(100.0, abs=0.1)

    def test_prefers_set_load_p_over_set_bus(self):
        """When both set_load_p and set_bus.loads_id exist, set_load_p takes priority."""
        obs = _make_obs([], [], name_load=["LOAD_X"], load_p=[200.0])
        dict_action = {
            "ls_both": {
                "content": {
                    "set_load_p": {"LOAD_X": 0.0},
                    "set_bus": {"loads_id": {"LOAD_X": -1}},
                }
            }
        }
        svc = _make_service_with_context(obs, dict_action)

        scores = {"load_shedding": {"scores": {"ls_both": 0.5}}}
        result = svc._compute_mw_start_for_scores(scores)

        assert result["load_shedding"]["mw_start"]["ls_both"] == pytest.approx(200.0, abs=0.1)

    def test_legacy_set_bus_still_works(self):
        obs = _make_obs([], [], name_load=["LOAD_OLD"], load_p=[75.0])
        dict_action = {
            "ls_legacy": {
                "content": {
                    "set_bus": {"loads_id": {"LOAD_OLD": -1}}
                }
            }
        }
        svc = _make_service_with_context(obs, dict_action)

        scores = {"load_shedding": {"scores": {"ls_legacy": 0.4}}}
        result = svc._compute_mw_start_for_scores(scores)

        assert result["load_shedding"]["mw_start"]["ls_legacy"] == pytest.approx(75.0, abs=0.1)


# ===========================================================================
# _mw_start_curtailment — new set_gen_p content format
# ===========================================================================

class TestMwStartCurtailmentPowerReduction:
    def test_extracts_gen_p_from_set_gen_p_content(self):
        obs = _make_obs([], [], name_gen=["WIND_1"], gen_p=[120.0])
        dict_action = {
            "curtail_WIND_1": {
                "content": {
                    "set_gen_p": {"WIND_1": 0.0}
                }
            }
        }
        svc = _make_service_with_context(obs, dict_action)

        scores = {"renewable_curtailment": {"scores": {"curtail_WIND_1": 0.6}}}
        result = svc._compute_mw_start_for_scores(scores)

        assert result["renewable_curtailment"]["mw_start"]["curtail_WIND_1"] == pytest.approx(120.0, abs=0.1)

    def test_prefers_set_gen_p_over_set_bus(self):
        obs = _make_obs([], [], name_gen=["GEN_Y"], gen_p=[95.0])
        dict_action = {
            "curtail_GEN_Y": {
                "content": {
                    "set_gen_p": {"GEN_Y": 0.0},
                    "set_bus": {"generators_id": {"GEN_Y": -1}},
                }
            }
        }
        svc = _make_service_with_context(obs, dict_action)

        scores = {"renewable_curtailment": {"scores": {"curtail_GEN_Y": 0.5}}}
        result = svc._compute_mw_start_for_scores(scores)

        assert result["renewable_curtailment"]["mw_start"]["curtail_GEN_Y"] == pytest.approx(95.0, abs=0.1)

    def test_legacy_set_bus_still_works(self):
        obs = _make_obs([], [], name_gen=["GEN_OLD"], gen_p=[88.0])
        dict_action = {
            "curtail_GEN_OLD": {
                "content": {
                    "set_bus": {"generators_id": {"GEN_OLD": -1}}
                }
            }
        }
        svc = _make_service_with_context(obs, dict_action)

        scores = {"renewable_curtailment": {"scores": {"curtail_GEN_OLD": 0.7}}}
        result = svc._compute_mw_start_for_scores(scores)

        assert result["renewable_curtailment"]["mw_start"]["curtail_GEN_OLD"] == pytest.approx(88.0, abs=0.1)


# ===========================================================================
# _build_action_entry_from_topology — new loads_p/gens_p mapping
# ===========================================================================

class TestBuildActionEntryPowerReduction:
    def test_maps_loads_p_to_set_load_p(self):
        topo = {"loads_p": {"LOAD_1": 0.0, "LOAD_2": 5.0}}
        entry = RecommenderService._build_action_entry_from_topology("test_ls", topo)

        assert "set_load_p" in entry["content"]
        assert entry["content"]["set_load_p"]["LOAD_1"] == 0.0
        assert entry["content"]["set_load_p"]["LOAD_2"] == 5.0

    def test_maps_gens_p_to_set_gen_p(self):
        topo = {"gens_p": {"WIND_1": 0.0}}
        entry = RecommenderService._build_action_entry_from_topology("test_curtail", topo)

        assert "set_gen_p" in entry["content"]
        assert entry["content"]["set_gen_p"]["WIND_1"] == 0.0

    def test_legacy_topo_still_produces_set_bus(self):
        topo = {"loads_bus": {"LOAD_1": -1}}
        entry = RecommenderService._build_action_entry_from_topology("test_legacy", topo)

        assert "set_bus" in entry["content"]
        assert entry["content"]["set_bus"]["loads_id"]["LOAD_1"] == -1

    def test_mixed_topo_includes_both(self):
        topo = {
            "loads_bus": {"LOAD_1": -1},
            "loads_p": {"LOAD_2": 0.0},
            "gens_p": {"GEN_1": 0.0},
        }
        entry = RecommenderService._build_action_entry_from_topology("test_mixed", topo)

        assert entry["content"]["set_bus"]["loads_id"]["LOAD_1"] == -1
        assert entry["content"]["set_load_p"]["LOAD_2"] == 0.0
        assert entry["content"]["set_gen_p"]["GEN_1"] == 0.0

    def test_combined_switches_and_injections(self):
        # The interactive SLD edit can stage a breaker toggle AND a generator
        # retune AND a load retune in one action — the content must carry all
        # three keys so env.action_space(content) applies them together.
        topo = {
            "switches": {"SW_A": True},
            "gens_p": {"GEN_A": 24.0},
            "loads_p": {"LOAD_A": 3.0},
        }
        entry = RecommenderService._build_action_entry_from_topology(
            "user_topo_VL_X_1", topo
        )
        content = entry["content"]
        assert content["switches"] == {"SW_A": True}
        assert content["set_gen_p"] == {"GEN_A": 24.0}
        assert content["set_load_p"] == {"LOAD_A": 3.0}

    def test_empty_loads_p_not_included(self):
        topo = {"loads_p": {}}
        entry = RecommenderService._build_action_entry_from_topology("test_empty", topo)

        assert "set_load_p" not in entry.get("content", {})


# ===========================================================================
# Dynamic action creation — new format
# ===========================================================================

class TestDynamicActionsPowerReduction:
    @pytest.fixture
    def service(self):
        s = RecommenderService()
        s._dict_action = {"dummy": {}}
        return s

    @pytest.fixture
    def mock_env(self):
        with patch("expert_backend.services.recommender_service.RecommenderService._get_simulation_env") as mock_get_env:
            env = MagicMock()
            mock_get_env.return_value = env

            obs = MagicMock()
            obs.n_components = 1
            obs.main_component_load_mw = 1000.0
            obs.name_line = ["LINE_1"]
            obs.rho = np.array([0.1])
            obs.name_load = ["LOAD_DYN"]
            obs.load_p = np.array([50.0])
            obs.name_gen = ["GEN_DYN"]
            obs.gen_p = np.array([80.0])

            sim_obs = MagicMock()
            sim_obs.n_components = 1
            sim_obs.main_component_load_mw = 1000.0
            sim_obs.rho = np.array([0.05])
            sim_obs.name_line = ["LINE_1"]
            sim_obs.name_load = ["LOAD_DYN"]
            sim_obs.load_p = np.array([0.0])
            sim_obs.name_gen = ["GEN_DYN"]
            sim_obs.gen_p = np.array([0.0])

            obs.simulate.return_value = (sim_obs, 0.5, False, {"exception": None})
            env.get_obs.return_value = obs

            class MockAction:
                def __init__(self, content):
                    set_bus = content.get("set_bus", {})
                    self.loads_bus = set_bus.get("loads_id", {})
                    self.gens_bus = set_bus.get("generators_id", {})
                    self.lines_ex_bus = set_bus.get("lines_ex_id", {})
                    self.lines_or_bus = set_bus.get("lines_or_id", {})
                    self.pst_tap = content.get("pst_tap", {})
                    # New power reduction fields
                    self.loads_p = content.get("set_load_p", {})
                    self.gens_p = content.get("set_gen_p", {})

            env.action_space.side_effect = lambda content: MockAction(content)
            yield env

    def test_dynamic_load_shedding_uses_loads_p_format(self, service, mock_env):
        """Dynamic load_shedding_ actions should use loads_p topology."""
        action_id = "load_shedding_LOAD_DYN"
        service._dict_action = {"dummy": {}}

        with patch.object(service, "_get_monitoring_parameters", return_value=(set(), set())), \
             patch.object(service, "_compute_deltas", return_value={}):
            result = service.simulate_manual_action(action_id, "CONTINGENCY")

        # Topology should contain loads_p, not loads_bus with -1
        assert "action_topology" in result
        assert result["action_topology"].get("loads_p") == {"LOAD_DYN": 0.0}

        # Content should use set_load_p format
        action_entry = service._dict_action[action_id]
        assert "set_load_p" in action_entry["content"]
        assert action_entry["content"]["set_load_p"]["LOAD_DYN"] == 0.0

    @patch("expert_backend.services.network_service.network_service.get_generator_voltage_level")
    def test_dynamic_curtailment_uses_gens_p_format(self, mock_get_vl, service, mock_env):
        """Dynamic curtail_ actions should use gens_p topology."""
        mock_get_vl.return_value = "VL_GEN"
        service._is_renewable_gen = MagicMock(return_value=True)
        action_id = "curtail_GEN_DYN"
        service._dict_action = {"dummy": {}}

        with patch.object(service, "_get_monitoring_parameters", return_value=(set(), set())), \
             patch.object(service, "_compute_deltas", return_value={}):
            result = service.simulate_manual_action(action_id, "CONTINGENCY")

        assert "action_topology" in result
        assert result["action_topology"].get("gens_p") == {"GEN_DYN": 0.0}

        action_entry = service._dict_action[action_id]
        assert "set_gen_p" in action_entry["content"]
        assert action_entry["content"]["set_gen_p"]["GEN_DYN"] == 0.0
