# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0
# This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study. 

import pytest
import numpy as np
from unittest.mock import MagicMock, patch
from expert_backend.services.recommender_service import RecommenderService
from expert_op4grid_recommender import config

@pytest.fixture
def recommender():
    return RecommenderService()

def test_run_analysis_filtering_combined_actions(recommender):
    # Mock config
    config.MONITORING_FACTOR_THERMAL_LIMITS = 1.0 # Simplify
    config.SAVE_FOLDER_VISUALIZATION = MagicMock()
    
    # Mock internal methods
    recommender._get_simulation_env = MagicMock()
    recommender._get_monitoring_parameters = MagicMock(return_value=([], {}))
    recommender._get_latest_pdf_path = MagicMock(return_value=None)
    recommender._load_network_if_needed = MagicMock()
    recommender._get_base_network = MagicMock()
    recommender._get_n_variant = MagicMock()
    recommender._get_contingency_variant = MagicMock()
    recommender._get_overloaded_lines = MagicMock(return_value=[])
    recommender._get_element_max_currents = MagicMock(return_value={})
    
    # Mock network_service
    with patch('expert_backend.services.network_service.network_service') as mock_ns:
        mock_ns.network = MagicMock()
        
        # Mock _enrich_actions — accepts the optional
        # `lines_overloaded_names` kwarg used by the production
        # implementation to compute lines_overloaded_after for
        # recommender-suggested actions.
        def mock_enrich(actions_dict, lines_overloaded_names=None, action_scores=None):  # noqa: ARG001
            return {aid: {"max_rho": d.get("max_rho", 0), "is_estimated": d.get("is_estimated", False)} for aid, d in actions_dict.items()}
        recommender._enrich_actions = MagicMock(side_effect=mock_enrich)

        # Patch threading.Thread to run synchronously
        with patch('threading.Thread') as mock_thread:
            def mock_start():
                target = mock_thread.call_args[1]['target']
                target()
            mock_thread.return_value.start.side_effect = mock_start

            with patch('expert_backend.services.analysis_mixin.run_analysis') as mock_lib_run:
                mock_lib_run.return_value = {
                    "prioritized_actions": {
                        "act1": {"description": "Action 1", "max_rho": 0.5},
                        "act2": {"description": "Action 2", "max_rho": 0.6},
                        "act1+act2": {"description": "Action 1 + 2", "max_rho": 0.4, "is_estimated": True}
                    },
                    "action_scores": {"act1": 10},
                    "lines_overloaded_names": ["LINE1"],
                    "combined_actions": {
                        "act1+act2": {"description": "Action 1 + 2", "max_rho": 0.4}
                    },
                    "dc_fallback": False
                }
                
                # Run analysis
                results = list(recommender.run_analysis("contingency_A"))
                
                # Find the 'result' type message
                result_msg = next((r for r in results if isinstance(r, dict) and r.get("type") == "result"), None)
                assert result_msg is not None, "Should have found a result message"
                
                actions = result_msg["actions"]
                combined_actions = result_msg.get("combined_actions", {})
                
                # Verify filtering: 'act1+act2' should NOT be in 'actions'
                assert "act1" in actions
                assert "act2" in actions
                assert "act1+act2" not in actions
                
                # Verify it IS in 'combined_actions'
                assert "act1+act2" in combined_actions

def test_simulate_manual_action_for_combined(recommender):
    # Mock config
    config.MONITORING_FACTOR_THERMAL_LIMITS = 0.95
    config.PRE_EXISTING_OVERLOAD_WORSENING_THRESHOLD = 0.02
    
    # Mock environment and observations
    env = MagicMock()
    recommender._get_simulation_env = MagicMock(return_value=env)
    recommender._get_monitoring_parameters = MagicMock(return_value=(["LINE1"], {"LINE1": 100}))
    recommender._get_n_variant = MagicMock()
    recommender._get_contingency_variant = MagicMock()
    
    # Mock N-state obs (Should NOT be overloaded on LINE1)
    obs_n = MagicMock()
    obs_n.rho = np.array([0.5]) 
    obs_n.name_line = ["LINE1"]
    obs_n.n_components = 1
    obs_n.main_component_load_mw = 1000.0
    
    # Mock N-1 state obs (IS overloaded on LINE1)
    obs_n1 = MagicMock()
    obs_n1.rho = np.array([1.1]) 
    obs_n1.name_line = ["LINE1"]
    obs_n1.n_components = 1
    obs_n1.main_component_load_mw = 1000.0
    
    # env.get_obs is called twice: once for N, once for N-1
    env.get_obs.side_effect = [obs_n, obs_n1]
    env.name_line = ["LINE1"]
    
    # Mock simulating the action
    mock_obs_after = MagicMock()
    mock_obs_after.rho = np.array([0.8]) 
    mock_obs_after.name_line = ["LINE1"]
    mock_obs_after.n_components = 1
    mock_obs_after.main_component_load_mw = 1000.0
    obs_n1.simulate.return_value = (mock_obs_after, None, None, {"exception": None})
    
    # Mock dict_action
    recommender._dict_action = {
        "act1": {"content": "content1", "description_unitaire": "Desc 1"},
        "act2": {"content": "content2", "description_unitaire": "Desc 2"}
    }
    
    # Mock action merging
    env.action_space.return_value = MagicMock()
    
    # Run simulation
    recommender._last_result = {"prioritized_actions": {}}
    
    result = recommender.simulate_manual_action("act1+act2", "contingency_A")
    
    assert result["action_id"] == "act1+act2"
    assert result["rho_after"] is not None
    # 0.8 * 0.95 = 0.76 (after)
    # 1.1 * 0.95 = 1.045 (before)
    # 0.76 + 0.01 < 1.045 is True
    assert result["is_rho_reduction"] is True
    
    # Verify it was stored in _last_result with is_estimated: False
    stored = recommender._last_result["prioritized_actions"]["act1+act2"]
    assert stored["is_estimated"] is False
    assert stored["rho_after"] is not None


def _wire_manual_action_mocks(recommender, name_line, base_rho, n1_rho, after_rho):
    """Common scaffolding for simulate_manual_action ctx-key tests.

    Mocks the smallest service surface needed to drive
    ``simulation_mixin.simulate_manual_action`` end-to-end with two
    monitored lines and a single-action ``"act_solo"`` entry. Returns
    the obs mocks so tests can poke them post-call.
    """
    config.MONITORING_FACTOR_THERMAL_LIMITS = 0.95
    config.PRE_EXISTING_OVERLOAD_WORSENING_THRESHOLD = 0.02

    env = MagicMock()
    recommender._get_simulation_env = MagicMock(return_value=env)
    recommender._get_monitoring_parameters = MagicMock(
        return_value=(set(name_line), {l: 100 for l in name_line})
    )
    recommender._get_n_variant = MagicMock()
    recommender._get_contingency_variant = MagicMock()
    recommender._ensure_contingency_state_ready = MagicMock()
    recommender._fetch_n_and_contingency_observations = MagicMock()

    obs_n = MagicMock(
        rho=np.array(base_rho), name_line=name_line,
        n_components=1, main_component_load_mw=1000.0,
    )
    obs_n1 = MagicMock(
        rho=np.array(n1_rho), name_line=name_line,
        n_components=1, main_component_load_mw=1000.0,
    )
    obs_after = MagicMock(
        rho=np.array(after_rho), name_line=name_line,
        n_components=1, main_component_load_mw=1000.0,
    )
    obs_n1.simulate.return_value = (obs_after, None, None, {"exception": None})
    recommender._fetch_n_and_contingency_observations.return_value = (obs_n, obs_n1)

    env.action_space.return_value = MagicMock()
    recommender._dict_action = {
        "act_solo": {"content": "c", "description_unitaire": "Desc"}
    }
    return obs_n, obs_n1, obs_after


# Regression for the ``lines_overloaded_names`` ctx-key fix in
# ``simulation_mixin.simulate_manual_action``. Step1 populates
# ``_analysis_context["lines_overloaded_names"]`` (see
# ``test_overload_filtering.py``) but the consumer only read
# ``ctx.get("lines_overloaded")`` — silently falling through to the
# vectorised obs-based path and re-emitting grid2op's synthetic
# ``line_<i>`` names instead of the pypowsybl-style friendly
# identifiers step1 had already resolved. The frontend's
# ``displayName`` resolver has no mapping for the synthetic strings,
# so manual-sim action cards displayed e.g. ``line_0: 90.7 %``
# instead of ``BEON L31CPVAN: 90.7 %``.
def test_simulate_manual_uses_lines_overloaded_names_from_step1_context(recommender):
    # rho_before / rho_after are indexed against the ctx-resolved
    # overload list (lines_overloaded_ids in
    # ``compute_action_metrics``). Picking a single-overload ctx
    # against a two-line ``name_line`` lets us assert on the array
    # cardinality: prior to the fix the consumer fell through to
    # vectorised recomputation and emitted a TWO-line rho_before
    # (both lines on rho ≥ 1.0), proving the wrong code path ran.
    name_line = ["BEON L31CPVAN", "DARCEL61VIELM"]
    _wire_manual_action_mocks(
        recommender, name_line,
        base_rho=[0.10, 0.10], n1_rho=[1.20, 1.15], after_rho=[0.90, 1.10],
    )
    # Step1 shape — the resolved friendly identifiers go under
    # ``lines_overloaded_names``, NOT ``lines_overloaded``.
    recommender._analysis_context = {
        "lines_overloaded_names": ["BEON L31CPVAN"],
        "lines_we_care_about": set(name_line),
    }

    result = recommender.simulate_manual_action("act_solo", "P.SAOL31RONCI")

    # Single ctx overload → single rho_before / rho_after entry.
    # Pre-fix this came back with two entries because the consumer
    # silently fell through to obs-based recomputation, which
    # masked both 1.20- and 1.15-loaded lines on the N-1 state.
    assert len(result["rho_before"]) == 1, (
        "post-step1 manual sims must reuse the step1 overload set, "
        "not fall through to obs-based recomputation"
    )
    assert len(result["rho_after"]) == 1


# Session-reload writes the same field under the legacy
# ``lines_overloaded`` key (see
# ``RecommenderService.restore_analysis_context``). The dual-key
# read MUST keep that path working — otherwise a reloaded session
# would lose its overload set on the next manual simulation.
def test_simulate_manual_uses_lines_overloaded_from_session_reload_context(recommender):
    name_line = ["BEON L31CPVAN", "DARCEL61VIELM"]
    _wire_manual_action_mocks(
        recommender, name_line,
        base_rho=[0.10, 0.10], n1_rho=[1.20, 1.15], after_rho=[0.90, 1.10],
    )
    # Session-reload shape — the legacy key.
    recommender._analysis_context = {
        "lines_overloaded": ["BEON L31CPVAN"],
        "lines_we_care_about": set(name_line),
    }

    result = recommender.simulate_manual_action("act_solo", "P.SAOL31RONCI")

    assert len(result["rho_before"]) == 1
    assert len(result["rho_after"]) == 1


# ``lines_overloaded_names`` takes priority over ``lines_overloaded``
# when both keys are present — matches the ordering compute_superposition
# already used.
def test_simulate_manual_lines_overloaded_names_wins_over_legacy_key(recommender):
    name_line = ["A", "B", "C"]
    _wire_manual_action_mocks(
        recommender, name_line,
        base_rho=[0.10, 0.10, 0.10], n1_rho=[1.20, 1.10, 1.05],
        after_rho=[0.90, 0.85, 0.80],
    )
    # Stale legacy key spans two lines; the live names-key has a
    # single entry. The dual-key resolver MUST honour the
    # names-key — proven by the single-entry rho_before length.
    recommender._analysis_context = {
        "lines_overloaded_names": ["A"],
        "lines_overloaded": ["A", "B"],
        "lines_we_care_about": set(name_line),
    }

    result = recommender.simulate_manual_action("act_solo", "ctg")

    assert len(result["rho_before"]) == 1


# Without analysis context AND without a caller-supplied list the
# resolver falls through to obs-based recomputation — same path as
# before the fix. Pins the regression boundary so a future change
# can't accidentally start treating the empty-ctx case as a step1
# context.
def test_simulate_manual_falls_back_to_obs_when_ctx_empty(recommender):
    name_line = ["A", "B"]
    _wire_manual_action_mocks(
        recommender, name_line,
        base_rho=[0.10, 0.10], n1_rho=[1.20, 1.15], after_rho=[0.90, 1.10],
    )
    recommender._analysis_context = None

    result = recommender.simulate_manual_action("act_solo", "ctg")

    # Both N-1 rho values cross the 1.0 threshold and neither
    # pre-existed in N — the vectorised path picks them both up.
    assert len(result["rho_before"]) == 2


if __name__ == "__main__":
    pytest.main([__file__])
