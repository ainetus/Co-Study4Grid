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
    svc = RecommenderService()
    svc._dict_action = {}
    svc._last_result = {"prioritized_actions": {}}
    return svc


def _make_obs(rho_vals, p_or_vals=None):
    """Create a mock observation with proper numpy arrays."""
    obs = MagicMock()
    obs.rho = np.array(rho_vals)
    if p_or_vals is not None:
        obs.p_or = np.array(p_or_vals)
    else:
        del obs.p_or  # Remove the auto-created MagicMock attribute
    return obs


def _setup_superposition_env(recommender, actions_dict, dict_action, name_line=None):
    """Common setup for superposition tests: mock env, variants, observations."""
    if name_line is None:
        name_line = ["LINE1"]

    recommender._last_result["prioritized_actions"] = actions_dict
    recommender._dict_action = dict_action
    recommender._get_simulation_env = MagicMock()
    recommender._get_n_variant = MagicMock(return_value="N")
    recommender._get_contingency_variant = MagicMock(return_value="N-1")

    env = recommender._get_simulation_env.return_value
    env.name_line = name_line

    n_lines = len(name_line)
    obs_n1 = _make_obs([1.1] * n_lines, [100.0] * n_lines)
    obs_n = _make_obs([0.8] * n_lines, [80.0] * n_lines)
    env.get_obs.side_effect = [obs_n1, obs_n]
    env.network_manager.network.get_working_variant_id.return_value = "ORIG"

    # Ensure config attributes used in compute_superposition are real numbers
    config.MONITORING_FACTOR_THERMAL_LIMITS = 0.95
    config.PRE_EXISTING_OVERLOAD_WORSENING_THRESHOLD = 0.02

    return env


def test_compute_superposition_on_demand(recommender):
    """Verify on-demand superposition returns betas and max_rho."""
    aid1, aid2 = "act1", "act2"
    obs1 = _make_obs([0.9], [90.0])
    obs2 = _make_obs([0.9], [85.0])
    actions = {
        aid1: {"action": MagicMock(), "observation": obs1},
        aid2: {"action": MagicMock(), "observation": obs2},
    }
    _setup_superposition_env(recommender, actions, {})

    with patch('expert_backend.services.simulation_mixin._identify_action_elements', return_value=([0], [])), \
         patch('expert_backend.services.simulation_mixin.compute_combined_pair_superposition') as mock_combine:

        mock_combine.return_value = {
            "betas": [0.5, 0.5],
            "p_or_combined": [100.0]
        }

        result = recommender.compute_superposition(aid1, aid2, "contingency")

        assert "betas" in result
        assert result["max_rho"] is not None
        assert result["is_estimated"] is True


def test_compute_superposition_triggers_simulation(recommender):
    """When one action is missing from results, simulate_manual_action is called."""
    aid1, aid2 = "act1", "act2"
    obs1 = _make_obs([0.9], [90.0])
    actions = {
        aid1: {"action": MagicMock(), "observation": obs1},
    }
    da = {aid2: {"content": "content2", "description_unitaire": "Desc 2"}}

    def mock_simulate(aid, cont):
        recommender._last_result["prioritized_actions"][aid] = {
            "action": MagicMock(),
            "observation": _make_obs([0.9], [85.0]),
        }

    recommender.simulate_manual_action = MagicMock(side_effect=mock_simulate)
    _setup_superposition_env(recommender, actions, da)

    with patch('expert_backend.services.simulation_mixin._identify_action_elements', return_value=([0], [])), \
         patch('expert_backend.services.simulation_mixin.compute_combined_pair_superposition') as mock_combine:

        mock_combine.return_value = {"betas": [0.5, 0.5]}
        result = recommender.compute_superposition(aid1, aid2, "contingency")

        recommender.simulate_manual_action.assert_called_with(aid2, ["contingency"])
        assert "betas" in result


def test_compute_superposition_passes_pst_flag_for_pst_action(recommender):
    """When one action is a PST tap action, act1_is_pst must be True so the
    library uses flow-based no-op detection instead of line-status comparison."""
    pst_id = "pst_tap_.ARKA_TD_661_inc2"
    other_id = "reco_LINE_A"

    obs_pst = _make_obs([0.9], [95.0])
    obs_other = _make_obs([0.85], [90.0])
    actions = {
        pst_id: {"action": MagicMock(), "observation": obs_pst},
        other_id: {"action": MagicMock(), "observation": obs_other},
    }
    da = {
        pst_id: {"content": {"pst_tap": {".ARKA TD 661": 32}}, "description_unitaire": "Variation de slot"},
        other_id: {"content": {"set_bus": {"lines_or_bus": {"LINE_A": 2}}}, "description_unitaire": "Reconnect LINE_A"},
    }
    _setup_superposition_env(recommender, actions, da)

    with patch('expert_backend.services.simulation_mixin._identify_action_elements', return_value=([0], [])), \
         patch('expert_backend.services.simulation_mixin.compute_combined_pair_superposition') as mock_combine:

        mock_combine.return_value = {"betas": [0.6, 0.4]}
        recommender.compute_superposition(pst_id, other_id, "contingency")

        call_kwargs = mock_combine.call_args
        assert call_kwargs.kwargs.get("act1_is_pst") is True, "act1_is_pst should be True for PST action"
        assert call_kwargs.kwargs.get("act2_is_pst") is False, "act2_is_pst should be False for non-PST action"


def test_compute_superposition_pst_flag_true_when_pst_is_second(recommender):
    """When PST action is the second argument, act2_is_pst should be True."""
    other_id = "reco_LINE_A"
    pst_id = "pst_tap_.ARKA_TD_661_inc2"

    obs_other = _make_obs([0.85], [90.0])
    obs_pst = _make_obs([0.9], [95.0])
    actions = {
        other_id: {"action": MagicMock(), "observation": obs_other},
        pst_id: {"action": MagicMock(), "observation": obs_pst},
    }
    da = {
        other_id: {"content": {"set_bus": {"lines_or_bus": {"LINE_A": 2}}}, "description_unitaire": "Reconnect"},
        pst_id: {"content": {"pst_tap": {".ARKA TD 661": 32}}, "description_unitaire": "Variation de slot"},
    }
    _setup_superposition_env(recommender, actions, da)

    with patch('expert_backend.services.simulation_mixin._identify_action_elements', return_value=([0], [])), \
         patch('expert_backend.services.simulation_mixin.compute_combined_pair_superposition') as mock_combine:

        mock_combine.return_value = {"betas": [0.5, 0.5]}
        recommender.compute_superposition(other_id, pst_id, "contingency")

        call_kwargs = mock_combine.call_args
        assert call_kwargs.kwargs.get("act1_is_pst") is False, "act1_is_pst should be False for non-PST action"
        assert call_kwargs.kwargs.get("act2_is_pst") is True, "act2_is_pst should be True for PST action"


def test_compute_superposition_pst_flag_false_for_non_pst(recommender):
    """Non-PST actions should have act_is_pst=False."""
    aid1, aid2 = "reco_LINE_A", "reco_LINE_B"

    obs1 = _make_obs([0.9], [90.0])
    obs2 = _make_obs([0.85], [85.0])
    actions = {
        aid1: {"action": MagicMock(), "observation": obs1},
        aid2: {"action": MagicMock(), "observation": obs2},
    }
    da = {
        aid1: {"content": {"set_bus": {"lines_or_bus": {"LINE_A": 2}}}, "description_unitaire": "Reconnect"},
        aid2: {"content": {"set_bus": {"lines_or_bus": {"LINE_B": 2}}}, "description_unitaire": "Reconnect"},
    }
    _setup_superposition_env(recommender, actions, da)

    with patch('expert_backend.services.simulation_mixin._identify_action_elements', return_value=([0], [])), \
         patch('expert_backend.services.simulation_mixin.compute_combined_pair_superposition') as mock_combine:

        mock_combine.return_value = {"betas": [0.5, 0.5]}
        recommender.compute_superposition(aid1, aid2, "contingency")

        call_kwargs = mock_combine.call_args
        assert call_kwargs.kwargs.get("act1_is_pst") is False
        assert call_kwargs.kwargs.get("act2_is_pst") is False


def test_pst_fallback_line_idxs_used_when_identify_returns_empty(recommender):
    """When _identify_action_elements returns empty for a PST action, the
    fallback should find the line index from the pst_tap content."""
    pst_id = "pst_tap_.ARKA_TD_661_inc2"
    other_id = "reco_LINE_B"

    obs_pst = _make_obs([0.9], [95.0])
    obs_other = _make_obs([0.85], [90.0])
    actions = {
        pst_id: {"action": MagicMock(), "observation": obs_pst},
        other_id: {"action": MagicMock(), "observation": obs_other},
    }
    da = {
        pst_id: {"content": {"pst_tap": {".ARKA TD 661": 32}}, "description_unitaire": "Variation de slot"},
        other_id: {"content": {"set_bus": {"lines_or_bus": {"LINE_B": 2}}}, "description_unitaire": "Reconnect"},
    }
    _setup_superposition_env(recommender, actions, da, name_line=[".ARKA TD 661", "LINE_B"])

    # _identify_action_elements returns empty for PST, non-empty for other
    def side_effect(act_obj, aid, dict_action, classifier, env):
        if aid == pst_id:
            return ([], [])  # PST actions often return empty
        return ([1], [])  # LINE_B at index 1

    with patch('expert_backend.services.simulation_mixin._identify_action_elements', side_effect=side_effect), \
         patch('expert_backend.services.simulation_mixin.compute_combined_pair_superposition') as mock_combine:

        mock_combine.return_value = {"betas": [0.6, 0.4]}
        recommender.compute_superposition(pst_id, other_id, "contingency")

        call_kwargs = mock_combine.call_args
        # Fallback should have found index 0 (.ARKA TD 661) for the PST action
        assert call_kwargs.kwargs.get("act1_line_idxs") == [0]
        assert call_kwargs.kwargs.get("act1_is_pst") is True


def test_dict_action_merge_preserves_original_keys(recommender):
    """After re-simulation, _dict_action entry must retain original keys
    from the library while updating observation/action/content."""

    original_entry = {
        "content": {"pst_tap": {".ARKA TD 661": 29}},
        "description": "PST action",
        "description_unitaire": "Variation de slot .ARKA TD 661 to 29",
        "observation": MagicMock(),
        "action": MagicMock(),
        "action_topology": {"pst_tap": {".ARKA TD 661": 29}},
        # Library-specific keys that must survive re-simulation
        "library_extra_field": "some_value",
        "action_type_info": {"type": "pst_tap"},
    }

    svc = RecommenderService()
    svc._dict_action = {"pst_action_1": dict(original_entry)}

    # Simulate the merge that happens after re-simulation
    new_data = {
        "content": {"pst_tap": {".ARKA TD 661": 32}},
        "observation": MagicMock(),
        "action": MagicMock(),
        "action_topology": {"pst_tap": {".ARKA TD 661": 32}},
    }

    existing = svc._dict_action["pst_action_1"]
    existing["observation"] = new_data["observation"]
    existing["action"] = new_data["action"]
    existing["action_topology"] = new_data["action_topology"]
    if new_data.get("content"):
        existing["content"] = new_data["content"]

    result = svc._dict_action["pst_action_1"]

    # Original library keys must still be present
    assert result["library_extra_field"] == "some_value"
    assert result["action_type_info"] == {"type": "pst_tap"}
    # Updated keys should reflect the new values
    assert result["content"]["pst_tap"][".ARKA TD 661"] == 32
    assert result["observation"] is new_data["observation"]
    assert result["action"] is new_data["action"]


def test_compute_superposition_reuses_context_obs_simu_defaut(recommender):
    """Regression: on-demand `compute_superposition` must use the N-1
    observation captured by step1 (stored on `_analysis_context`) as
    `obs_start` rather than fetching a fresh `env.get_obs()`.

    Background: step2's `run_analysis_step2_discovery` pre-computes betas
    using `context["obs_simu_defaut"]`. Grid2Op's
    `obs.simulate(action, keep_variant=True)` (used by
    `simulate_manual_action`) can mutate the shared N-1 variant, so a
    fresh fetch here would see a drifted baseline and produce betas
    that diverge from the "Computed Pairs" view for the same pair.
    Reusing the context obs keeps the two paths numerically consistent.
    """
    aid1, aid2 = "act1", "act2"
    obs1 = _make_obs([0.9], [90.0])
    obs2 = _make_obs([0.9], [85.0])
    actions = {
        aid1: {"action": MagicMock(), "observation": obs1},
        aid2: {"action": MagicMock(), "observation": obs2},
    }
    _setup_superposition_env(recommender, actions, {})

    # Simulate what step1 leaves behind: a context carrying the original
    # N-1 observation. A later fresh `env.get_obs()` would return a
    # drifted observation (different rho values) — the reuse must pick
    # the context obs, not the drifted fresh fetch.
    ctx_obs = _make_obs([1.5], [150.0])
    recommender._analysis_context = {"obs_simu_defaut": ctx_obs}

    with patch('expert_backend.services.simulation_mixin._identify_action_elements', return_value=([0], [])), \
         patch('expert_backend.services.simulation_mixin.compute_combined_pair_superposition') as mock_combine:
        mock_combine.return_value = {"betas": [0.5, 0.5], "p_or_combined": [100.0]}

        recommender.compute_superposition(aid1, aid2, "contingency")

        obs_start_passed = mock_combine.call_args.kwargs["obs_start"]
        assert obs_start_passed is ctx_obs, (
            "compute_superposition should pass the context's obs_simu_defaut as "
            "obs_start so betas match the step2 pre-computed values"
        )


def test_compute_superposition_falls_back_to_fresh_fetch_without_context(recommender):
    """When no analysis context exists (first-time pair estimation with
    no prior step1), `compute_superposition` must still work by fetching
    `obs_start` from `env.get_obs()`. This test pins the fallback so the
    new context-preferred path does not silently break the no-context
    case.
    """
    aid1, aid2 = "act1", "act2"
    obs1 = _make_obs([0.9], [90.0])
    obs2 = _make_obs([0.9], [85.0])
    actions = {
        aid1: {"action": MagicMock(), "observation": obs1},
        aid2: {"action": MagicMock(), "observation": obs2},
    }
    env = _setup_superposition_env(recommender, actions, {})
    recommender._analysis_context = None

    with patch('expert_backend.services.simulation_mixin._identify_action_elements', return_value=([0], [])), \
         patch('expert_backend.services.simulation_mixin.compute_combined_pair_superposition') as mock_combine:
        mock_combine.return_value = {"betas": [0.5, 0.5], "p_or_combined": [100.0]}

        recommender.compute_superposition(aid1, aid2, "contingency")

        assert env.get_obs.call_count == 2, "expected fresh fetch for both N-1 and N in fallback path"


def _install_fake_monitoring(recommender, lines, with_limits=None):
    """Short-circuit `_get_monitoring_parameters` so the test does not
    rely on the auto-mocked pypowsybl limits chain (which otherwise
    returns an empty `branches_with_limits` and filters every line out
    of the care_mask)."""
    bwl = list(lines if with_limits is None else with_limits)
    recommender._get_monitoring_parameters = MagicMock(return_value=(list(lines), bwl))


def test_compute_superposition_emits_target_max_rho_on_overload_lines(recommender):
    """`compute_superposition` must return ``target_max_rho`` /
    ``target_max_rho_line`` scoped to ``lines_overloaded_ids`` — the
    user-selected overloads the pair is meant to resolve — so the UI
    can surface the pair's effect on the contingency alongside the
    global ``max_rho`` (which may land on an off-target line due to
    linearisation error).

    Regression for "Estimated Max Loading: 81.9% on LOUHAL31PYMON" vs
    "Actual Max Loading: 52.0% on BOCTOL71N.SE5" — neither line was an
    originally-overloaded one; target_* fields let the frontend show
    the effect on the actual overloads.
    """
    aid1, aid2 = "act1", "act2"
    name_line = ["OVERLOAD_TARGET", "FARLINE"]
    obs_n1 = _make_obs([0.4, 0.5], [40.0, 50.0])
    obs_n1.name_line = np.array(name_line)
    obs1 = _make_obs([0.3, 0.6], [30.0, 60.0])
    obs1.name_line = np.array(name_line)
    obs2 = _make_obs([0.3, 0.55], [30.0, 55.0])
    obs2.name_line = np.array(name_line)
    actions = {
        aid1: {"action": MagicMock(), "observation": obs1},
        aid2: {"action": MagicMock(), "observation": obs2},
    }
    _setup_superposition_env(recommender, actions, {}, name_line=name_line)
    _install_fake_monitoring(recommender, name_line)
    recommender._analysis_context = {
        "obs_simu_defaut": obs_n1,
        "lines_overloaded_ids": [0],
    }

    with patch('expert_backend.services.simulation_mixin._identify_action_elements', return_value=([0], [])), \
         patch('expert_backend.services.simulation_mixin.compute_combined_pair_superposition') as mock_sp:
        # rho_combined at betas=[1.5, 0.5]:
        #   OVERLOAD_TARGET: |(1-2)*0.4 + 1.5*0.3 + 0.5*0.3|  = 0.20
        #   FARLINE        : |(1-2)*0.5 + 1.5*0.6 + 0.5*0.55| = 0.675
        mock_sp.return_value = {"betas": [1.5, 0.5], "p_or_combined": [100.0]}
        result = recommender.compute_superposition(aid1, aid2, "contingency")

    assert result["target_max_rho_line"] == "OVERLOAD_TARGET"
    # target_max_rho is scaled by monitoring_factor (0.95):
    # 0.20 * 0.95 = 0.19
    assert abs(result["target_max_rho"] - 0.20 * 0.95) < 1e-3


def test_compute_superposition_target_max_rho_keys_always_present(recommender):
    """The target_max_rho / target_max_rho_line fields must always be in
    the payload so the frontend does not have to branch on their
    existence — the frontend can detect "no target info" via
    ``target_max_rho_line == "N/A"``."""
    aid1, aid2 = "act1", "act2"
    obs1 = _make_obs([0.9], [90.0])
    obs2 = _make_obs([0.85], [85.0])
    actions = {
        aid1: {"action": MagicMock(), "observation": obs1},
        aid2: {"action": MagicMock(), "observation": obs2},
    }
    _setup_superposition_env(recommender, actions, {})
    _install_fake_monitoring(recommender, ["LINE1"])
    recommender._analysis_context = None

    with patch('expert_backend.services.simulation_mixin._identify_action_elements', return_value=([0], [])), \
         patch('expert_backend.services.simulation_mixin.compute_combined_pair_superposition') as mock_sp:
        mock_sp.return_value = {"betas": [0.5, 0.5], "p_or_combined": [100.0]}
        result = recommender.compute_superposition(aid1, aid2, "contingency")

    assert "target_max_rho" in result
    assert "target_max_rho_line" in result


def test_superposition_lines_overloaded_reads_context_ids_or_names(recommender):
    """`_superposition_lines_overloaded` must prefer the step1-populated
    keys (``lines_overloaded_ids`` and ``lines_overloaded_names``) so the
    on-demand monitoring set matches what step2's discovery used —
    previously only the session-reload key ``lines_overloaded`` was
    consulted, causing fresh-analysis on-demand re-estimation to
    recompute from ``obs_start`` and drift from the pre-computed view.
    """
    name_line = ["L0", "L1", "L2", "L3"]
    obs_start = _make_obs([0.5, 0.8, 0.99, 1.1])

    # Case 1: step1-populated `lines_overloaded_ids` wins.
    recommender._analysis_context = {"lines_overloaded_ids": [1, 3]}
    ids = recommender._superposition_lines_overloaded(
        obs_start, name_line, {n: i for i, n in enumerate(name_line)},
        pre_existing_rho={}, lines_we_care_about=set(name_line),
        branches_with_limits=set(name_line),
        monitoring_factor=0.95, worsening_threshold=0.02,
    )
    assert ids == [1, 3]

    # Case 2: only names present — still resolved via name_to_idx_map.
    recommender._analysis_context = {"lines_overloaded_names": ["L2", "L3"]}
    ids = recommender._superposition_lines_overloaded(
        obs_start, name_line, {n: i for i, n in enumerate(name_line)},
        pre_existing_rho={}, lines_we_care_about=set(name_line),
        branches_with_limits=set(name_line),
        monitoring_factor=0.95, worsening_threshold=0.02,
    )
    assert ids == [2, 3]

    # Case 3: session-reload key still honoured for backwards compat.
    recommender._analysis_context = {"lines_overloaded": ["L0"]}
    ids = recommender._superposition_lines_overloaded(
        obs_start, name_line, {n: i for i, n in enumerate(name_line)},
        pre_existing_rho={}, lines_we_care_about=set(name_line),
        branches_with_limits=set(name_line),
        monitoring_factor=0.95, worsening_threshold=0.02,
    )
    assert ids == [0]


def test_augment_combined_actions_with_target_max_rho_adds_target_fields():
    """`AnalysisMixin._augment_combined_actions_with_target_max_rho`
    must add ``target_max_rho`` / ``target_max_rho_line`` to each
    library-populated pair without touching the existing ``max_rho`` /
    ``max_rho_line`` — preserves the global-scan new-overload warning
    while surfacing the pair's effect on the user-selected overloads.
    """
    svc = RecommenderService()

    name_line = ["OVERLOAD_TARGET", "FARLINE"]
    obs_start = _make_obs([0.4, 0.5])
    obs_start.name_line = np.array(name_line)
    obs_act1 = _make_obs([0.3, 0.6])
    obs_act1.name_line = np.array(name_line)
    obs_act2 = _make_obs([0.3, 0.55])
    obs_act2.name_line = np.array(name_line)

    pair_id = "act1+act2"
    results = {
        "prioritized_actions": {
            "act1": {"observation": obs_act1},
            "act2": {"observation": obs_act2},
        },
        "combined_actions": {
            pair_id: {
                "betas": [1.5, 0.5],
                "max_rho": 0.64,
                "max_rho_line": "FARLINE",
            },
        },
    }
    context = {"obs_simu_defaut": obs_start, "lines_overloaded_ids": [0]}

    config.MONITORING_FACTOR_THERMAL_LIMITS = 0.95
    svc._augment_combined_actions_with_target_max_rho(results, context)

    pair = results["combined_actions"][pair_id]
    # Existing fields are preserved.
    assert pair["max_rho_line"] == "FARLINE"
    # New target fields are scoped to lines_overloaded_ids = [0] (OVERLOAD_TARGET).
    assert pair["target_max_rho_line"] == "OVERLOAD_TARGET"
    # target_max_rho is the OVERLOAD_TARGET rho (0.20) scaled by 0.95.
    assert abs(pair["target_max_rho"] - 0.20 * 0.95) < 1e-3


def test_run_analysis_step2_emits_result_event_after_target_augmentation():
    """Regression: the real `run_analysis_step2` body must still build
    `enriched_actions` and yield a ``{type: 'result'}`` event.  Previous
    failure: when the target-max-rho augmentation was added we
    accidentally removed the `enriched_actions` block, so the final
    yield hit ``NameError: name 'enriched_actions' is not defined``
    at runtime — a frontend-visible 500 with no test coverage because
    the existing split-analysis test mocks the whole method at the
    module seam."""
    from expert_backend.services.recommender_service import RecommenderService
    from unittest.mock import patch

    svc = RecommenderService()
    svc._analysis_context = {
        "obs_simu_defaut": _make_obs([0.8]),
        "lines_overloaded_ids": [0],
        "lines_overloaded_names": ["L0"],
        "lines_overloaded_ids_kept": [0],
        "lines_we_care_about": ["L0"],
    }
    svc._analysis_context["obs_simu_defaut"].name_line = np.array(["L0"])

    results = {
        "prioritized_actions": {},
        "action_scores": {},
        "lines_overloaded_names": ["L0"],
        "combined_actions": {},
    }

    with patch("expert_backend.services.analysis_mixin.run_analysis_step2_graph",
               side_effect=lambda ctx: ctx), \
         patch("expert_backend.services.analysis_mixin.run_analysis_step2_discovery",
               return_value=results), \
         patch.object(svc, "_get_latest_pdf_path", return_value=None), \
         patch.object(svc, "_enrich_actions", return_value={}), \
         patch.object(svc, "_compute_mw_start_for_scores", return_value={}):
        events = list(svc.run_analysis_step2(["L0"]))

    # pdf event + result event, both typed, no error.
    event_types = [e.get("type") for e in events]
    assert "error" not in event_types, f"unexpected error event: {events}"
    assert "pdf" in event_types
    assert "result" in event_types
    result_event = next(e for e in events if e.get("type") == "result")
    assert result_event["actions"] == {}
    assert result_event["lines_overloaded"] == ["L0"]


def test_simulate_manual_action_pins_n1_variant_before_simulate_even_on_cache_hit():
    """Regression: `simulate_manual_action` must set the working variant
    to the N-1 id IMMEDIATELY BEFORE `obs.simulate(action, keep_variant=True)`,
    regardless of whether the N / N-1 observation caches hit.

    Why: `_fetch_n_and_contingency_observations` only calls `set_working_variant`
    when a cache misses.  When both caches hit (the common case after
    step1 has run), the working variant is left on whatever the previous
    caller positioned — often N.  `obs.simulate(action, keep_variant=True)`
    applies the action ON TOP OF THE CURRENT WORKING VARIANT in-place,
    so without an explicit pin to N-1 the combined-action simulation
    can run against the N state instead of N-1, surfacing on the
    frontend as Simulated Line landing on the contingency line itself
    with non-zero rho (physically impossible in true N-1).
    """
    svc = RecommenderService()
    svc._dict_action = {"act1": {"content": {}, "description_unitaire": "d1"}}
    svc._last_result = {"prioritized_actions": {}}

    env = MagicMock()
    n = env.network_manager.network
    n.get_working_variant_id.return_value = "orig"
    env.name_line = ["L1"]
    obs_n = MagicMock()
    obs_n.rho = np.array([0.5])
    obs_n.name_line = ["L1"]
    obs_n.n_components = 1
    obs_n1 = MagicMock()
    obs_n1.rho = np.array([0.8])
    obs_n1.name_line = ["L1"]
    obs_n1.n_components = 1
    obs_after = MagicMock()
    obs_after.rho = np.array([0.7])
    obs_after.name_line = ["L1"]
    obs_after.n_components = 1
    obs_n1.simulate.return_value = (obs_after, None, None, {"exception": None})

    svc._get_simulation_env = MagicMock(return_value=env)
    svc._get_base_network = MagicMock(return_value=n)
    svc._get_n_variant = MagicMock(return_value="n_var")
    svc._get_contingency_variant = MagicMock(return_value="n1_var")
    svc._get_monitoring_parameters = MagicMock(return_value=(["L1"], ["L1"]))

    # Prime both caches so `_fetch_n_and_contingency_observations` takes the
    # cache-hit branch — it will NOT touch set_working_variant, so we
    # must verify the explicit pin-to-N-1 kicks in before .simulate().
    svc._cached_obs_n = obs_n
    svc._cached_obs_n_id = "n_var"
    svc._cached_obs_n1 = obs_n1
    svc._cached_obs_n1_id = "n1_var"

    # Track the order of calls against the shared Network.
    call_log = []
    n.set_working_variant.side_effect = lambda vid: call_log.append(("set_working_variant", vid))
    orig_simulate = obs_n1.simulate
    def wrapped_simulate(*args, **kwargs):
        call_log.append(("simulate",))
        return orig_simulate.return_value
    obs_n1.simulate = wrapped_simulate

    config.MONITORING_FACTOR_THERMAL_LIMITS = 0.95
    config.PRE_EXISTING_OVERLOAD_WORSENING_THRESHOLD = 0.02
    config.PYPOWSYBL_FAST_MODE = False

    svc.simulate_manual_action("act1", "DISCO_A")

    # Find the last set_working_variant call before the simulate call.
    sim_idx = next((i for i, c in enumerate(call_log) if c[0] == "simulate"), None)
    assert sim_idx is not None, "simulate was never called"
    pre_simulate_variants = [c[1] for c in call_log[:sim_idx] if c[0] == "set_working_variant"]
    assert pre_simulate_variants, "no set_working_variant was called before simulate"
    assert pre_simulate_variants[-1] == "n1_var", (
        f"expected variant pinned to N-1 ('n1_var') right before simulate, "
        f"last set was {pre_simulate_variants[-1]!r}. Full pre-simulate order: {pre_simulate_variants}"
    )


def test_augment_combined_actions_with_target_max_rho_is_noop_without_context():
    """No-op when the analysis context is missing obs_simu_defaut or
    lines_overloaded_ids — nothing to scope the target against."""
    svc = RecommenderService()

    results = {
        "prioritized_actions": {},
        "combined_actions": {
            "act1+act2": {
                "betas": [1.0, 1.0],
                "max_rho": 0.80,
                "max_rho_line": "LINE_A",
            },
        },
    }
    svc._augment_combined_actions_with_target_max_rho(results, context={})

    pair = results["combined_actions"]["act1+act2"]
    assert "target_max_rho" not in pair
    assert "target_max_rho_line" not in pair


def test_compute_superposition_allows_injection_action(recommender):
    """An injection action (load shedding / curtailment / redispatch) has no
    topology element — it must NOT trigger the 'cannot identify elements'
    bail-out, and must be forwarded to the library with act_is_injection=True
    so the Generalized Superposition Theorem (GST) path handles the pair."""
    topo_id = "disco_LINE1"
    inj_id = "load_shedding_LOAD_7"
    obs_topo = _make_obs([0.9], [0.0])      # LINE1 disconnected
    obs_inj = _make_obs([0.85], [85.0])     # injection state
    actions = {
        topo_id: {"action": MagicMock(), "observation": obs_topo},
        inj_id: {"action": MagicMock(), "observation": obs_inj},
    }
    da = {
        topo_id: {"content": {"set_bus": {"lines_or_bus": {"LINE1": -1}}},
                  "description_unitaire": "Open LINE1"},
        inj_id: {"content": {"set_load_p": {"LOAD_7": 0.0}},
                 "description_unitaire": "Load shedding LOAD_7"},
    }
    _setup_superposition_env(recommender, actions, da)

    def side_effect(act_obj, aid, dict_action, classifier, env):
        # topology action resolves to a line; injection action has no element
        return ([0], []) if aid == topo_id else ([], [])

    with patch('expert_backend.services.simulation_mixin._identify_action_elements', side_effect=side_effect), \
         patch('expert_backend.services.simulation_mixin.compute_combined_pair_superposition') as mock_combine:
        # injection is reported with beta = 1.0 (GST convention)
        mock_combine.return_value = {"betas": [0.7, 1.0], "p_or_combined": [100.0]}
        result = recommender.compute_superposition(topo_id, inj_id, "contingency")

        assert "error" not in result, f"injection pair must not bail out: {result.get('error')}"
        ck = mock_combine.call_args.kwargs
        assert ck.get("act1_is_injection") is False
        assert ck.get("act2_is_injection") is True
        assert result["is_estimated"] is True
        assert "betas" in result


def test_compute_superposition_injection_first(recommender):
    """Injection action on the FIRST side — act1_is_injection must be True."""
    inj_id = "curtail_GEN_2"
    topo_id = "disco_LINE1"
    obs_inj = _make_obs([0.85], [85.0])
    obs_topo = _make_obs([0.9], [0.0])
    actions = {
        inj_id: {"action": MagicMock(), "observation": obs_inj},
        topo_id: {"action": MagicMock(), "observation": obs_topo},
    }
    da = {
        inj_id: {"content": {"set_gen_p": {"GEN_2": 0.0}}, "description_unitaire": "Curtail GEN_2"},
        topo_id: {"content": {"set_bus": {"lines_or_bus": {"LINE1": -1}}}, "description_unitaire": "Open LINE1"},
    }
    _setup_superposition_env(recommender, actions, da)

    def side_effect(act_obj, aid, dict_action, classifier, env):
        return ([], []) if aid == inj_id else ([0], [])

    with patch('expert_backend.services.simulation_mixin._identify_action_elements', side_effect=side_effect), \
         patch('expert_backend.services.simulation_mixin.compute_combined_pair_superposition') as mock_combine:
        mock_combine.return_value = {"betas": [1.0, 0.7], "p_or_combined": [100.0]}
        result = recommender.compute_superposition(inj_id, topo_id, "contingency")

        assert "error" not in result
        ck = mock_combine.call_args.kwargs
        assert ck.get("act1_is_injection") is True
        assert ck.get("act2_is_injection") is False


def test_compute_superposition_injection_plus_injection(recommender):
    """Two injection actions (no topology element on either side) are still
    estimated via the GST (pure injection superposition)."""
    inj1 = "curtail_GEN_2"
    inj2 = "load_shedding_LOAD_7"
    obs1 = _make_obs([0.9], [90.0])
    obs2 = _make_obs([0.85], [85.0])
    actions = {
        inj1: {"action": MagicMock(), "observation": obs1},
        inj2: {"action": MagicMock(), "observation": obs2},
    }
    da = {
        inj1: {"content": {"set_gen_p": {"GEN_2": 0.0}}, "description_unitaire": "Curtail"},
        inj2: {"content": {"set_load_p": {"LOAD_7": 0.0}}, "description_unitaire": "Shed"},
    }
    _setup_superposition_env(recommender, actions, da)

    with patch('expert_backend.services.simulation_mixin._identify_action_elements', return_value=([], [])), \
         patch('expert_backend.services.simulation_mixin.compute_combined_pair_superposition') as mock_combine:
        mock_combine.return_value = {"betas": [1.0, 1.0], "p_or_combined": [100.0]}
        result = recommender.compute_superposition(inj1, inj2, "contingency")

        assert "error" not in result
        ck = mock_combine.call_args.kwargs
        assert ck.get("act1_is_injection") is True
        assert ck.get("act2_is_injection") is True


def test_is_injection_action_helper():
    """The backend injection detector matches the library convention by id
    prefix (independent of the classifier, so it works under the test mock
    layer too)."""
    from expert_backend.services.simulation_helpers import is_injection_action
    classifier = MagicMock()
    classifier.identify_action_type.return_value = "unknown"
    assert is_injection_action("load_shedding_LOAD_5", {}, classifier) is True
    assert is_injection_action("curtail_GEN_2", {}, classifier) is True
    assert is_injection_action("redispatch_GEN_7", {}, classifier) is True
    assert is_injection_action("disco_LINE_3", {}, classifier) is False
    # classifier-resolved injection type also counts
    classifier.identify_action_type.return_value = "load_power_reduction"
    assert is_injection_action("x", {"x": {}}, classifier) is True


if __name__ == "__main__":
    pytest.main([__file__])
