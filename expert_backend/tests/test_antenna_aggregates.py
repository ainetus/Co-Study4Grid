# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0
# This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

"""Evacuation-antenna aggregate actions (expert_op4grid_recommender 0.3.4+).

``curtail_<antenna_id>`` / ``redispatch_<antenna_id>`` act on several
generators and name their antenna, not a generator: they are rebuilt from the
analysis' score params, their MW target is spread pro rata, their MW-at-start
sums their generators, and they get a description the library leaves empty.
"""
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import numpy as np
import pytest

from expert_backend.services.antenna_aggregates import (
    antenna_aggregate_descriptions,
    antenna_aggregate_entry,
    antenna_aggregate_params,
    describe_antenna_aggregate,
    is_antenna_aggregate_params,
)
from expert_backend.services.recommender_service import RecommenderService
from expert_backend.services.simulation_helpers import split_target_mw

CURTAIL_ID = "curtail_EVAC_SOULLP4_1"
REDISPATCH_ID = "redispatch_EVAC_DOWN_2"

# Score params as the recommender 0.3.4 emits them for an antenna aggregate.
CURTAIL_PARAMS = {
    "substation": "SOULLP4",
    "node_type": "amont",
    "gen_names": ["WIND_A", "WIND_B"],
    "action_mode": "power_reduction",
    "target_p_MW": {"WIND_A": 81.0, "WIND_B": 27.0},
    "reduction_MW": 12.0,
    "via_evacuation_antenna": True,
    "evacuation_antenna_id": "EVAC_SOULLP4_1",
}
REDISPATCH_PARAMS = {
    "substation": "DOWNP6",
    "node_type": "aval",
    "direction": "up",
    "gen_names": ["CCG_A", "CCG_B"],
    "action_mode": "redispatch",
    "target_p_MW": {"CCG_A": 110.0, "CCG_B": 60.0},
    "delta_MW": 20.0,
    "via_evacuation_antenna": True,
    "evacuation_antenna_id": "EVAC_DOWN_2",
}
ACTION_SCORES = {
    "renewable_curtailment": {
        "scores": {"curtail_WIND_A": 0.9, CURTAIL_ID: 0.8},
        "params": {
            # A per-generator candidate: its target is a float, not a dict.
            "curtail_WIND_A": {"gen_name": "WIND_A", "target_p_MW": 0.0},
            CURTAIL_ID: CURTAIL_PARAMS,
        },
    },
    "redispatch": {
        "scores": {REDISPATCH_ID: 0.5},
        "params": {REDISPATCH_ID: REDISPATCH_PARAMS},
    },
    "line_reconnection": {
        "scores": {"reco_L1": 0.3},
        "params": {"percentage_threshold_min_dispatch_flow": 0.1},
    },
}


def _obs(gen_p, gen_pmax=None, load_p=None):
    """Minimal N-1 observation: generators WIND_A / WIND_B / CCG_A / CCG_B."""
    obs = SimpleNamespace(
        name_line=[],
        name_gen=["WIND_A", "WIND_B", "CCG_A", "CCG_B"],
        gen_p=np.array(gen_p, dtype=float),
        name_load=["LOAD_A", "LOAD_B"],
        load_p=np.array(load_p if load_p is not None else [30.0, 10.0], dtype=float),
    )
    if gen_pmax is not None:
        obs.gen_pmax = np.array(gen_pmax, dtype=float)
    return obs


class TestAggregateParams:
    def test_found_in_any_family(self):
        assert antenna_aggregate_params(ACTION_SCORES, CURTAIL_ID) is CURTAIL_PARAMS
        assert antenna_aggregate_params(ACTION_SCORES, REDISPATCH_ID) is REDISPATCH_PARAMS

    def test_per_generator_candidates_are_not_aggregates(self):
        assert antenna_aggregate_params(ACTION_SCORES, "curtail_WIND_A") is None
        assert not is_antenna_aggregate_params({"gen_name": "WIND_A", "target_p_MW": 0.0})

    @pytest.mark.parametrize("scores", [None, {}, MagicMock(), {"x": None}, {"x": {"params": None}}])
    def test_tolerates_missing_or_foreign_scores(self, scores):
        assert antenna_aggregate_params(scores, CURTAIL_ID) is None

    def test_only_injection_ids(self):
        scores = {"t": {"params": {"disco_EVAC": CURTAIL_PARAMS}}}
        assert antenna_aggregate_params(scores, "disco_EVAC") is None


class TestDescriptions:
    def test_curtailment(self):
        description, unitaire = describe_antenna_aggregate(CURTAIL_ID, CURTAIL_PARAMS)
        assert unitaire == "Effacement antenne 'EVAC_SOULLP4_1' ('WIND_A', 'WIND_B')"
        assert "evacuation antenna 'EVAC_SOULLP4_1'" in description
        assert "'SOULLP4'" in description

    @pytest.mark.parametrize("direction, verb", [("up", "hausse"), ("down", "baisse")])
    def test_redispatch_direction(self, direction, verb):
        _, unitaire = describe_antenna_aggregate(REDISPATCH_ID, {**REDISPATCH_PARAMS, "direction": direction})
        assert unitaire == f"Redispatch {verb} antenne 'EVAC_DOWN_2' ('CCG_A', 'CCG_B')"

    def test_antenna_id_falls_back_to_the_action_id(self):
        params = {k: v for k, v in CURTAIL_PARAMS.items() if k != "evacuation_antenna_id"}
        assert "'EVAC_SOULLP4_1'" in describe_antenna_aggregate(CURTAIL_ID, params)[1]

    def test_descriptions_only_for_aggregates(self):
        assert antenna_aggregate_descriptions(ACTION_SCORES, "curtail_WIND_A") == {}
        assert set(antenna_aggregate_descriptions(ACTION_SCORES, CURTAIL_ID)) == {
            "description", "description_unitaire",
        }

    def test_entry_carries_the_recommender_setpoints(self):
        entry = antenna_aggregate_entry(CURTAIL_ID, CURTAIL_PARAMS)
        assert entry["content"] == {"set_gen_p": {"WIND_A": 81.0, "WIND_B": 27.0}}
        assert entry["description_unitaire"].startswith("Effacement antenne")


class TestSplitTargetMw:
    def test_single_element_takes_the_whole_target(self):
        assert split_target_mw({"WIND_A": 0.0}, "gen", 12, _obs([90, 30, 100, 50])) == {"WIND_A": 12.0}

    def test_reduction_by_current_production(self):
        shares = split_target_mw({"WIND_A": 0, "WIND_B": 0}, "gen", 12.0, _obs([-90, -30, 100, 50]))
        assert shares == pytest.approx({"WIND_A": 9.0, "WIND_B": 3.0})

    def test_raise_by_headroom(self):
        obs = _obs([0, 0, 100, 50], gen_pmax=[0, 0, 120, 110])
        shares = split_target_mw({"CCG_A": 0, "CCG_B": 0}, "gen", 20.0, obs, raising=True)
        assert shares == pytest.approx({"CCG_A": 5.0, "CCG_B": 15.0})

    def test_raise_without_pmax_falls_back_to_production(self):
        shares = split_target_mw({"CCG_A": 0, "CCG_B": 0}, "gen", 30.0, _obs([0, 0, 100, 50]), raising=True)
        assert shares == pytest.approx({"CCG_A": 20.0, "CCG_B": 10.0})

    def test_loads(self):
        shares = split_target_mw({"LOAD_A": 0, "LOAD_B": 0}, "load", 8.0, _obs([0, 0, 0, 0]))
        assert shares == pytest.approx({"LOAD_A": 6.0, "LOAD_B": 2.0})

    def test_equal_split_when_no_weight_is_readable(self):
        shares = split_target_mw({"X": 0, "Y": 0}, "gen", 10.0, _obs([0, 0, 0, 0]))
        assert shares == pytest.approx({"X": 5.0, "Y": 5.0})


class TestServiceIntegration:
    @pytest.fixture
    def service(self):
        s = RecommenderService()
        s._dict_action = {"dummy": {}}
        s._last_result = {"prioritized_actions": {}, "action_scores": ACTION_SCORES}
        return s

    def test_unprioritized_aggregate_is_rebuilt_from_the_score_params(self, service):
        service._create_dynamic_actions_if_needed([CURTAIL_ID], {}, _obs([-90, -30, 100, 50]), MagicMock(), None)
        entry = service._dict_action[CURTAIL_ID]
        # Both generators at the recommender's setpoints — never a generator
        # parsed out of the antenna id.
        assert entry["content"] == {"set_gen_p": {"WIND_A": 81.0, "WIND_B": 27.0}}
        assert entry["description_unitaire"] == "Effacement antenne 'EVAC_SOULLP4_1' ('WIND_A', 'WIND_B')"

    def test_per_generator_ids_keep_the_id_parsing(self, service):
        with patch.object(service, "_create_dynamic_curtailment") as per_gen:
            service._create_dynamic_actions_if_needed(["curtail_WIND_A"], {}, _obs([-90, -30, 100, 50]), MagicMock(), None)
        per_gen.assert_called_once()

    def test_target_mw_is_spread_pro_rata(self, service):
        obs = _obs([-90, -30, 100, 50])
        service._create_dynamic_actions_if_needed([CURTAIL_ID], {}, obs, MagicMock(), 12.0)
        service._apply_target_mw_updates([CURTAIL_ID], 12.0, obs)
        # 12 MW over 90 + 30 MW of production: 9 + 3, not 12 on each unit.
        assert service._dict_action[CURTAIL_ID]["content"]["set_gen_p"] == pytest.approx(
            {"WIND_A": 81.0, "WIND_B": 27.0}
        )

    def test_redispatch_raise_is_spread_by_headroom(self, service):
        obs = _obs([0, 0, 100, 50], gen_pmax=[0, 0, 120, 110])
        service._create_dynamic_actions_if_needed([REDISPATCH_ID], {}, obs, MagicMock(), 20.0)
        service._apply_target_mw_updates([REDISPATCH_ID], 20.0, obs)
        assert service._dict_action[REDISPATCH_ID]["content"]["set_gen_p"] == pytest.approx(
            {"CCG_A": 105.0, "CCG_B": 65.0}
        )

    def test_mw_start_sums_the_aggregate_generators(self, service):
        service._analysis_context = {"obs_simu_defaut": _obs([-90, -30, 100, 50])}
        scores = {
            "renewable_curtailment": {
                "scores": {CURTAIL_ID: 0.8},
                "params": {CURTAIL_ID: CURTAIL_PARAMS},
            },
        }
        with patch.object(service, "_pst_tap_info_fn", return_value=None):
            out = service._compute_mw_start_for_scores(scores)
        assert out["renewable_curtailment"]["mw_start"][CURTAIL_ID] == 120.0

    def test_prioritized_aggregate_gets_a_description(self, service):
        prioritized = {CURTAIL_ID: {"action": None, "rho_before": None, "rho_after": None, "max_rho": None}}
        with patch.object(service, "_compute_load_shedding_details", return_value=None), \
             patch.object(service, "_compute_curtailment_details", return_value=None), \
             patch.object(service, "_compute_pst_details", return_value=None):
            enriched = service._enrich_actions(prioritized, action_scores=ACTION_SCORES)
        assert enriched[CURTAIL_ID]["description_unitaire"].startswith("Effacement antenne 'EVAC_SOULLP4_1'")
