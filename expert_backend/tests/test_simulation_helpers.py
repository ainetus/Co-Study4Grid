# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0
# This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

"""Unit tests for the stateless helpers extracted from simulation_mixin.

These focus on each helper in isolation — no service instantiation,
no network loading. They guarantee the decomposition preserves the
behaviour the orchestrator methods relied on.
"""
import numpy as np
import pandas as pd
import pytest
from unittest.mock import MagicMock

from expert_backend.services.simulation_helpers import (
    TOPO_KEYS,
    build_half_open_reactive,
    build_care_mask,
    build_combined_description,
    canonicalize_action_id,
    classify_action_content,
    clamp_tap,
    compute_action_metrics,
    compute_combined_rho,
    compute_reduction_setpoint,
    compute_redispatch_setpoint,
    extract_action_topology,
    is_pst_action,
    normalise_non_convergence,
    parse_pst_tap_id,
    pst_fallback_line_idxs,
    resolve_lines_overloaded,
    serialize_action_result,
)


# ----------------------------------------------------------------------
# canonicalize_action_id
# ----------------------------------------------------------------------

class TestCanonicalizeActionId:
    def test_single_id_is_returned_as_is(self):
        assert canonicalize_action_id("act1") == "act1"

    def test_empty_string_is_returned_as_is(self):
        assert canonicalize_action_id("") == ""

    def test_multi_id_is_sorted(self):
        assert canonicalize_action_id("zeta+alpha+gamma") == "alpha+gamma+zeta"

    def test_multi_id_components_are_stripped(self):
        assert canonicalize_action_id("  act2  + act1 ") == "act1+act2"


# ----------------------------------------------------------------------
# compute_reduction_setpoint
# ----------------------------------------------------------------------

class TestComputeReductionSetpoint:
    def _mock_obs(self):
        obs = MagicMock()
        obs.name_load = ["LOAD_A", "LOAD_B"]
        obs.load_p = np.array([50.0, 30.0])
        obs.name_gen = ["GEN_X", "GEN_Y"]
        obs.gen_p = np.array([100.0, -80.0])
        return obs

    def test_none_target_returns_zero(self):
        assert compute_reduction_setpoint("LOAD_A", "load", None, self._mock_obs()) == 0.0

    def test_none_obs_returns_zero(self):
        assert compute_reduction_setpoint("LOAD_A", "load", 10.0, None) == 0.0

    def test_partial_load_reduction(self):
        # 50 MW load, reduce by 20 -> remaining 30 MW
        assert compute_reduction_setpoint("LOAD_A", "load", 20.0, self._mock_obs()) == 30.0

    def test_full_load_shedding_clamps_at_zero(self):
        # 30 MW load, reduce by 40 -> clamped to 0
        assert compute_reduction_setpoint("LOAD_B", "load", 40.0, self._mock_obs()) == 0.0

    def test_generator_curtailment_uses_absolute_value(self):
        # gen_p = -80 (generating), reduce by 30 -> |(-80)| - 30 = 50
        assert compute_reduction_setpoint("GEN_Y", "gen", 30.0, self._mock_obs()) == 50.0

    def test_missing_element_falls_back_to_zero(self):
        assert compute_reduction_setpoint("UNKNOWN", "load", 10.0, self._mock_obs()) == 0.0

    def test_result_is_rounded_to_two_decimals(self):
        obs = self._mock_obs()
        obs.load_p = np.array([50.123456, 0])
        assert compute_reduction_setpoint("LOAD_A", "load", 10.0, obs) == 40.12


# ----------------------------------------------------------------------
# compute_redispatch_setpoint
# ----------------------------------------------------------------------

class TestComputeRedispatchSetpoint:
    def _mock_obs(self):
        obs = MagicMock()
        obs.name_gen = ["GEN_X", "GEN_Y"]
        obs.gen_p = np.array([-50.0, -30.0])  # producing 50 / 30 MW
        return obs

    def test_raise_adds_delta(self):
        # 30 MW production + 10 MW raise -> 40 MW target
        assert compute_redispatch_setpoint("GEN_Y", 10.0, self._mock_obs()) == 40.0

    def test_lower_subtracts_delta(self):
        # 50 MW production - 20 MW lower -> 30 MW target
        assert compute_redispatch_setpoint("GEN_X", -20.0, self._mock_obs()) == 30.0

    def test_lower_clamps_at_zero(self):
        # 30 MW production - 100 MW lower -> clamped to 0
        assert compute_redispatch_setpoint("GEN_Y", -100.0, self._mock_obs()) == 0.0

    def test_none_delta_uses_default_raise(self):
        # default delta is a raise on current production (30 + 10 = 40)
        assert compute_redispatch_setpoint("GEN_Y", None, self._mock_obs(), 10.0) == 40.0

    def test_missing_element_falls_back_to_delta(self):
        assert compute_redispatch_setpoint("UNKNOWN", 10.0, self._mock_obs()) == 10.0

    def test_none_obs_returns_delta(self):
        assert compute_redispatch_setpoint("GEN_X", 10.0, None) == 10.0


# ----------------------------------------------------------------------
# parse_pst_tap_id + clamp_tap
# ----------------------------------------------------------------------

class TestParsePstTapId:
    def test_pst_tap_inc(self):
        assert parse_pst_tap_id("pst_tap_PST_A_inc2") == ("PST_A", 2)

    def test_pst_tap_dec(self):
        assert parse_pst_tap_id("pst_tap_PST_B_dec3") == ("PST_B", -3)

    def test_pst_short_prefix(self):
        # "pst_" prefix (no "_tap_") is the alternative
        assert parse_pst_tap_id("pst_PST_C_inc1") == ("PST_C", 1)

    def test_invalid_prefix_returns_none(self):
        assert parse_pst_tap_id("curtail_WIND_1") is None

    def test_missing_direction_returns_none(self):
        assert parse_pst_tap_id("pst_tap_PST_A_42") is None

    def test_id_with_underscores_in_pst_name(self):
        assert parse_pst_tap_id("pst_tap_.ARKA_TD_661_inc2") == (".ARKA_TD_661", 2)


class TestClampTap:
    def test_within_bounds_passthrough(self):
        assert clamp_tap(5, {"tap": 5, "low_tap": 0, "high_tap": 10}) == 5

    def test_below_low_clamps_to_low(self):
        assert clamp_tap(-3, {"low_tap": 0, "high_tap": 10}) == 0

    def test_above_high_clamps_to_high(self):
        assert clamp_tap(15, {"low_tap": 0, "high_tap": 10}) == 10

    def test_none_pst_info_returns_unchanged(self):
        assert clamp_tap(42, None) == 42


# ----------------------------------------------------------------------
# classify_action_content
# ----------------------------------------------------------------------

class TestClassifyActionContent:
    def test_single_topology_broadcasts_to_all_aids(self):
        topo = {"switches": {"SW1": 1}}
        result = classify_action_content(topo, ["a", "b"])
        assert result == {"a": topo, "b": topo}

    def test_per_action_dict_is_returned_as_is(self):
        per_action = {"a": {"switches": {"SW1": 1}}, "b": {"loads_p": {"L1": 0}}}
        assert classify_action_content(per_action, ["a", "b"]) == per_action

    def test_empty_content_returns_empty(self):
        assert classify_action_content(None, ["a"]) == {}
        assert classify_action_content({}, ["a"]) == {}

    def test_topo_keys_includes_pst_tap(self):
        # pst_tap is a topology field too — regression guard for earlier
        # bug where pst_tap-only content was treated as per-action map
        assert "pst_tap" in TOPO_KEYS
        topo = {"pst_tap": {"PST_A": 5}}
        assert classify_action_content(topo, ["a"]) == {"a": topo}


# ----------------------------------------------------------------------
# is_pst_action + pst_fallback_line_idxs
# ----------------------------------------------------------------------

class TestIsPstAction:
    def _classifier(self, action_type=None):
        c = MagicMock()
        c.identify_action_type.return_value = action_type
        return c

    def test_classifier_returns_pst(self):
        assert is_pst_action("foo", {"foo": {}}, self._classifier("pst")) is True

    def test_classifier_returns_pst_tap(self):
        assert is_pst_action("foo", {"foo": {}}, self._classifier("pst_tap")) is True

    def test_id_contains_pst_tap_even_if_classifier_misses(self):
        assert is_pst_action("pst_tap_A_inc2", {}, self._classifier("unknown")) is True

    def test_id_contains_pst_prefix(self):
        assert is_pst_action("pst_A_inc2", {}, self._classifier("unknown")) is True

    def test_non_pst_action(self):
        assert is_pst_action("reco_LINE_A", {"reco_LINE_A": {}}, self._classifier("reco")) is False

    def test_none_dict_action_is_safe(self):
        assert is_pst_action("pst_A", None, self._classifier("pst")) is True


class TestPstFallbackLineIdxs:
    def test_finds_pst_in_content_pst_tap(self):
        dict_action = {"a": {"content": {"pst_tap": {"PST_1": 5}}}}
        assert pst_fallback_line_idxs("a", dict_action, {}, ["PST_1", "LINE_X"]) == [0]

    def test_finds_pst_in_action_topology(self):
        dict_action = {"a": {"action_topology": {"pst_tap": {"PST_2": 5}}}}
        assert pst_fallback_line_idxs("a", dict_action, {}, ["PST_1", "PST_2"]) == [1]

    def test_falls_back_to_all_actions_if_dict_missing(self):
        all_actions = {"a": {"content": {"pst_tap": {"PST_1": 5}}}}
        assert pst_fallback_line_idxs("a", None, all_actions, ["PST_1"]) == [0]

    def test_unknown_pst_returns_empty(self):
        dict_action = {"a": {"content": {"pst_tap": {"UNKNOWN": 5}}}}
        assert pst_fallback_line_idxs("a", dict_action, {}, ["LINE_X"]) == []

    def test_no_pst_tap_returns_empty(self):
        assert pst_fallback_line_idxs("a", {"a": {"content": {}}}, {}, ["L1"]) == []


# ----------------------------------------------------------------------
# build_care_mask
# ----------------------------------------------------------------------

class TestBuildCareMask:
    def test_excludes_lines_not_in_care_set(self):
        mask = build_care_mask(
            action_names=np.array(["A", "B", "C"]),
            action_rho=np.array([0.5, 0.5, 0.5]),
            base_rho=np.array([0.5, 0.5, 0.5]),
            lines_we_care_about={"A", "C"},
            branches_with_limits={"A", "B", "C"},
            lines_overloaded_ids=[],
            monitoring_factor=0.95,
            worsening_threshold=0.02,
        )
        assert mask.tolist() == [True, False, True]

    def test_excludes_lines_not_in_limits(self):
        mask = build_care_mask(
            action_names=np.array(["A", "B", "C"]),
            action_rho=np.array([0.5, 0.5, 0.5]),
            base_rho=np.array([0.5, 0.5, 0.5]),
            lines_we_care_about={"A", "B", "C"},
            branches_with_limits={"A", "C"},
            lines_overloaded_ids=[],
            monitoring_factor=0.95,
            worsening_threshold=0.02,
        )
        assert mask.tolist() == [True, False, True]

    def test_excludes_preexisting_overloads_not_impacted(self):
        # Symmetric impact rule: a pre-existing overload is excluded only
        # when the action leaves it inside the ±worsening_threshold band.
        # A: pre-existing 1.0, action 1.0 → not_impacted → excluded.
        # B: pre-existing 1.0, action 1.5 → worsened beyond +2% → included.
        # C: pre-existing 1.0, action 0.7 → improved beyond -2% → included
        #    (the action operates in this line's sensitive area).
        mask = build_care_mask(
            action_names=np.array(["A", "B", "C"]),
            action_rho=np.array([1.0, 1.5, 0.7]),
            base_rho=np.array([1.0, 1.0, 1.0]),
            lines_we_care_about={"A", "B", "C"},
            branches_with_limits={"A", "B", "C"},
            lines_overloaded_ids=[],
            monitoring_factor=0.95,
            worsening_threshold=0.02,
        )
        assert mask.tolist() == [False, True, True]

    def test_excludes_only_strictly_inert_preexisting_overloads(self):
        # Inside the symmetric ±2% band the line is treated as "not impacted".
        # Just outside the band (either direction) → kept.
        mask = build_care_mask(
            action_names=np.array(["INSIDE_BAND", "JUST_BELOW_BAND", "JUST_ABOVE_BAND"]),
            action_rho=np.array([0.99, 0.97, 1.03]),
            base_rho=np.array([1.0, 1.0, 1.0]),
            lines_we_care_about={"INSIDE_BAND", "JUST_BELOW_BAND", "JUST_ABOVE_BAND"},
            branches_with_limits={"INSIDE_BAND", "JUST_BELOW_BAND", "JUST_ABOVE_BAND"},
            lines_overloaded_ids=[],
            monitoring_factor=0.95,
            worsening_threshold=0.02,
        )
        assert mask.tolist() == [False, True, True]

    def test_obs_rho_threshold_is_one_not_monitoring_factor(self):
        # Regression: grid2op's ``obs.rho`` is already pre-scaled by
        # ``monitoring_factor`` (rho = current / (limit * mf)), so the
        # "is overloaded" boundary on ``base_rho`` / ``action_rho`` is
        # 1.0 — not ``mf``. The earlier code used ``>= mf`` here, which
        # double-applied the factor and treated lines at ~mf**2 ≈ 90.25 %
        # of the permanent limit as already overloaded — silently dropping
        # them from the simulator's max_rho through the pre-existing
        # filter. This test pins the corrected boundary.
        #
        # A: pre-existing 0.97 (between mf and 1.0) → NOT pre-existing,
        #    action 0.50 → included (no exclusion fires).
        # B: pre-existing 1.05 (above 1.0) → pre-existing, action 1.05
        #    is inside the ±2 % band → excluded.
        mask = build_care_mask(
            action_names=np.array(["A", "B"]),
            action_rho=np.array([0.50, 1.05]),
            base_rho=np.array([0.97, 1.05]),
            lines_we_care_about={"A", "B"},
            branches_with_limits={"A", "B"},
            lines_overloaded_ids=[],
            monitoring_factor=0.95,
            worsening_threshold=0.02,
        )
        assert mask.tolist() == [True, False]

    def test_force_includes_overloaded_ids(self):
        mask = build_care_mask(
            action_names=np.array(["A", "B"]),
            action_rho=np.array([0.5, 0.5]),
            base_rho=np.array([0.5, 0.5]),
            lines_we_care_about=set(),  # nothing passes normally
            branches_with_limits=set(),
            lines_overloaded_ids=[0],
            monitoring_factor=0.95,
            worsening_threshold=0.02,
        )
        assert mask.tolist() == [True, False]


# ----------------------------------------------------------------------
# resolve_lines_overloaded
# ----------------------------------------------------------------------

class TestResolveLinesOverloaded:
    def _obs(self, rho):
        obs = MagicMock()
        obs.name_line = ["A", "B", "C"]
        obs.rho = np.array(rho)
        return obs

    def test_analysis_context_takes_priority(self):
        obs_n1 = self._obs([0.1, 0.1, 0.1])
        obs_n = self._obs([0.1, 0.1, 0.1])
        ids, names = resolve_lines_overloaded(
            obs_n1, obs_n,
            analysis_context_overloaded=["B"],
            caller_overloaded=["A"],
            lines_we_care_about={"A", "B", "C"},
            branches_with_limits={"A", "B", "C"},
            monitoring_factor=0.95,
            worsening_threshold=0.02,
        )
        assert ids == [1] and names == ["B"]

    def test_caller_list_used_when_no_context(self):
        obs_n1 = self._obs([1.0, 1.0, 1.0])
        obs_n = self._obs([0.1, 0.1, 0.1])
        ids, names = resolve_lines_overloaded(
            obs_n1, obs_n,
            analysis_context_overloaded=None,
            caller_overloaded=["C", "A"],
            lines_we_care_about={"A", "C"},
            branches_with_limits={"A", "C"},
            monitoring_factor=0.95,
            worsening_threshold=0.02,
        )
        # Preserves caller order but maps to correct indices
        assert set(ids) == {0, 2}

    def test_recomputes_when_no_hints(self):
        obs_n1 = self._obs([1.2, 0.5, 1.1])
        obs_n = self._obs([0.1, 0.1, 0.1])
        ids, names = resolve_lines_overloaded(
            obs_n1, obs_n,
            analysis_context_overloaded=None,
            caller_overloaded=None,
            lines_we_care_about={"A", "B", "C"},
            branches_with_limits={"A", "B", "C"},
            monitoring_factor=0.95,
            worsening_threshold=0.02,
        )
        # Both A (1.2) and C (1.1) are overloaded and not pre-existing
        assert ids == [0, 2]
        assert names == ["A", "C"]

    def test_recompute_threshold_is_one_not_monitoring_factor(self):
        # Regression for the obs.rho double-scaling fix. Grid2op's
        # ``obs.rho`` is already divided by ``limit * mf``, so a line is
        # "overloaded" only when ``obs.rho >= 1.0`` — not when
        # ``>= monitoring_factor``. The earlier check ``action_rho >= mf``
        # wrongly treated 0.96 as overloaded.
        obs_n1 = self._obs([0.96, 1.05, 0.50])
        obs_n = self._obs([0.10, 0.10, 0.10])
        ids, names = resolve_lines_overloaded(
            obs_n1, obs_n,
            analysis_context_overloaded=None,
            caller_overloaded=None,
            lines_we_care_about={"A", "B", "C"},
            branches_with_limits={"A", "B", "C"},
            monitoring_factor=0.95,
            worsening_threshold=0.02,
        )
        # Only B (1.05 >= 1.0) is overloaded. A (0.96) is below the
        # corrected threshold; the old code wrongly flagged it as well.
        assert ids == [1]
        assert names == ["B"]

    def test_ignores_missing_context_lines(self):
        obs_n1 = self._obs([0.1, 0.1, 0.1])
        obs_n = self._obs([0.1, 0.1, 0.1])
        ids, _ = resolve_lines_overloaded(
            obs_n1, obs_n,
            analysis_context_overloaded=["UNKNOWN_LINE"],
            caller_overloaded=None,
            lines_we_care_about=set(),
            branches_with_limits=set(),
            monitoring_factor=0.95,
            worsening_threshold=0.02,
        )
        assert ids == []


# ----------------------------------------------------------------------
# compute_action_metrics
# ----------------------------------------------------------------------

class TestComputeActionMetrics:
    def _obs(self, rho, *, n_comp=1, mw=1000.0, names=None):
        obs = MagicMock()
        obs.rho = np.array(rho)
        obs.name_line = names or ["L1", "L2", "L3"]
        obs.n_components = n_comp
        obs.main_component_load_mw = mw
        return obs

    def test_non_convergence_returns_zeroed_metrics(self):
        metrics = compute_action_metrics(
            obs=self._obs([0.5, 0.5, 0.5]),
            obs_simu_defaut=self._obs([0.5, 0.5, 0.5]),
            obs_simu_action=self._obs([0.0, 0.0, 0.0]),
            info_action={"exception": ["LF did not converge"]},
            lines_overloaded_ids=[0],
            lines_we_care_about={"L1", "L2", "L3"},
            branches_with_limits={"L1", "L2", "L3"},
            monitoring_factor=0.95,
            worsening_threshold=0.02,
        )
        assert metrics["max_rho"] == 0.0
        assert metrics["rho_after"] is None
        assert metrics["is_islanded"] is False

    def test_islanding_detected_when_components_increase(self):
        metrics = compute_action_metrics(
            obs=self._obs([0.5], n_comp=1, mw=1000.0),
            obs_simu_defaut=self._obs([0.5], n_comp=1, mw=1000.0),
            obs_simu_action=self._obs([0.4], n_comp=2, mw=800.0),
            info_action={"exception": None},
            lines_overloaded_ids=[],
            lines_we_care_about={"L1"},
            branches_with_limits={"L1"},
            monitoring_factor=0.95,
            worsening_threshold=0.02,
        )
        assert metrics["is_islanded"] is True
        assert metrics["disconnected_mw"] == 200.0
        assert metrics["n_components_after"] == 2

    def test_islanding_below_mw_threshold_is_filtered(self):
        """Sub-1 MW disconnected load is treated as a numerical artefact:
        n_components increases but is_islanded stays False."""
        metrics = compute_action_metrics(
            obs=self._obs([0.5], n_comp=1, mw=1000.0),
            obs_simu_defaut=self._obs([0.5], n_comp=1, mw=1000.0),
            # Loadless extra component (e.g. extreme PST tap, fast-mode
            # local AC non-convergence on a transit branch).
            obs_simu_action=self._obs([0.4], n_comp=2, mw=1000.0),
            info_action={"exception": None},
            lines_overloaded_ids=[],
            lines_we_care_about={"L1"},
            branches_with_limits={"L1"},
            monitoring_factor=0.95,
            worsening_threshold=0.02,
        )
        assert metrics["is_islanded"] is False
        assert metrics["disconnected_mw"] == 0.0
        # The bare topology counter is still surfaced for diagnostics.
        assert metrics["n_components_after"] == 2

    def test_rho_reduction_detected(self):
        metrics = compute_action_metrics(
            obs=self._obs([0.5, 0.5, 0.5]),
            obs_simu_defaut=self._obs([1.2, 1.1, 1.0]),
            obs_simu_action=self._obs([0.8, 0.7, 0.6]),
            info_action={"exception": None},
            lines_overloaded_ids=[0, 1],
            lines_we_care_about={"L1", "L2", "L3"},
            branches_with_limits={"L1", "L2", "L3"},
            monitoring_factor=0.95,
            worsening_threshold=0.02,
        )
        assert metrics["is_rho_reduction"] is True
        assert metrics["rho_before"] == pytest.approx([1.2 * 0.95, 1.1 * 0.95], rel=1e-6)
        assert metrics["rho_after"] == pytest.approx([0.8 * 0.95, 0.7 * 0.95], rel=1e-6)

    def test_max_rho_picks_highest_monitored_line(self):
        metrics = compute_action_metrics(
            obs=self._obs([0.1, 0.1, 0.1]),
            obs_simu_defaut=self._obs([0.1, 0.1, 0.1]),
            obs_simu_action=self._obs([0.5, 1.3, 0.9]),
            info_action={"exception": None},
            lines_overloaded_ids=[],
            lines_we_care_about={"L1", "L2", "L3"},
            branches_with_limits={"L1", "L2", "L3"},
            monitoring_factor=0.95,
            worsening_threshold=0.02,
        )
        assert metrics["max_rho_line"] == "L2"
        assert metrics["max_rho"] == pytest.approx(1.3 * 0.95)


# ----------------------------------------------------------------------
# build_half_open_reactive  (Issue 3 — charging-current annotation)
# ----------------------------------------------------------------------

class TestBuildHalfOpenReactive:
    def _net(self, lines, trafos=None):
        net = MagicMock()
        net.get_lines.return_value = pd.DataFrame.from_dict(lines, orient="index")
        net.get_2_windings_transformers.return_value = (
            pd.DataFrame.from_dict(trafos, orient="index")
            if trafos
            else pd.DataFrame(columns=["name", "connected1", "connected2", "q1", "q2"])
        )
        return net

    def test_half_open_line_returns_live_end_reactive(self):
        # Reproduces the reported case: MARSIL61PRAGN open at s2 (connected2=False),
        # live end s1 draws q1 = -16.8 MVAr of capacitive charging current.
        net = self._net(
            {
                "relation_8423569-225": {
                    "name": "MARSIL61PRAGN",
                    "connected1": True, "connected2": False,
                    "q1": -16.8, "q2": 0.0,
                },
            }
        )
        out = build_half_open_reactive(net)
        # abs(live-end q), reachable by both IIDM id and friendly name.
        assert out["relation_8423569-225"] == pytest.approx(16.8)
        assert out["MARSIL61PRAGN"] == pytest.approx(16.8)

    def test_picks_the_connected_terminal_reactive(self):
        net = self._net(
            {"L": {"name": "L", "connected1": False, "connected2": True, "q1": 0.0, "q2": -9.5}}
        )
        out = build_half_open_reactive(net)
        assert out["L"] == pytest.approx(9.5)  # live end is s2 → |q2|

    def test_fully_connected_and_fully_open_are_excluded(self):
        net = self._net(
            {
                "connected": {"name": "C", "connected1": True, "connected2": True, "q1": 5.0, "q2": -5.0},
                "fully_open": {"name": "O", "connected1": False, "connected2": False, "q1": 0.0, "q2": 0.0},
            }
        )
        out = build_half_open_reactive(net)
        assert "connected" not in out and "C" not in out
        assert "fully_open" not in out and "O" not in out

    def test_transformers_included(self):
        net = self._net(
            {"L1": {"name": "L1", "connected1": True, "connected2": True, "q1": 1.0, "q2": 1.0}},
            trafos={"T1": {"name": "TR1", "connected1": True, "connected2": False, "q1": 4.2, "q2": 0.0}},
        )
        out = build_half_open_reactive(net)
        assert out["T1"] == pytest.approx(4.2)
        assert out["TR1"] == pytest.approx(4.2)

    def test_pypowsybl_failure_degrades_to_empty(self):
        net = MagicMock()
        net.get_lines.side_effect = RuntimeError("boom")
        net.get_2_windings_transformers.side_effect = RuntimeError("boom")
        assert build_half_open_reactive(net) == {}


# ----------------------------------------------------------------------
# extract_action_topology
# ----------------------------------------------------------------------

class TestExtractActionTopology:
    def test_reads_standard_topology_fields(self):
        action = MagicMock()
        action.lines_ex_bus = {"L1": 1}
        action.loads_p = {"LOAD_A": 0.0}
        action.gens_p = None  # empty / falsy
        topo = extract_action_topology(action, "some_id", {})
        assert "lines_ex_bus" in topo
        assert topo["loads_p"] == {"LOAD_A": 0.0}
        assert "gens_p" not in topo

    def test_injects_heuristic_curtail_when_gens_p_missing(self):
        action = MagicMock()
        for f in ("lines_ex_bus", "lines_or_bus", "gens_bus", "loads_bus",
                  "pst_tap", "substations", "switches", "loads_p", "gens_p"):
            setattr(action, f, None)
        dict_action = {"curtail_WIND_1": {"content": {"set_gen_p": {"WIND_1": 0.0}}}}
        topo = extract_action_topology(action, "curtail_WIND_1", dict_action)
        assert topo["gens_p"] == {"WIND_1": 0.0}

    def test_injects_heuristic_load_shedding_when_loads_p_missing(self):
        action = MagicMock()
        for f in ("lines_ex_bus", "lines_or_bus", "gens_bus", "loads_bus",
                  "pst_tap", "substations", "switches", "loads_p", "gens_p"):
            setattr(action, f, None)
        dict_action = {"load_shedding_LOAD_A": {"content": {"set_load_p": {"LOAD_A": 0.0}}}}
        topo = extract_action_topology(action, "load_shedding_LOAD_A", dict_action)
        assert topo["loads_p"] == {"LOAD_A": 0.0}

    def test_pulls_switches_from_dict_entry_when_missing_on_action(self):
        action = MagicMock()
        for f in ("lines_ex_bus", "lines_or_bus", "gens_bus", "loads_bus",
                  "pst_tap", "substations", "switches", "loads_p", "gens_p"):
            setattr(action, f, None)
        dict_action = {"a": {"content": {"switches": {"SW1": 1}}}}
        topo = extract_action_topology(action, "a", dict_action)
        assert topo["switches"] == {"SW1": 1}

    def test_backfills_both_gens_and_loads_for_user_built_combined_action(self):
        # A user-built combined injection action sets BOTH set_gen_p and
        # set_load_p; the grid2op action object exposes neither, so the
        # topology must be back-filled from the content so the SLD highlights
        # BOTH the generator and the load.
        action = MagicMock()
        for f in ("lines_ex_bus", "lines_or_bus", "gens_bus", "loads_bus",
                  "pst_tap", "substations", "switches", "loads_p", "gens_p"):
            setattr(action, f, None)
        dict_action = {
            "user_topo_VL_X_1": {
                "content": {"set_gen_p": {"GEN_A": 24.0}, "set_load_p": {"LOAD_A": 3.0}},
            }
        }
        topo = extract_action_topology(action, "user_topo_VL_X_1", dict_action)
        assert topo["gens_p"] == {"GEN_A": 24.0}
        assert topo["loads_p"] == {"LOAD_A": 3.0}

    def test_action_attributes_take_precedence_over_content_backfill(self):
        action = MagicMock()
        for f in ("lines_ex_bus", "lines_or_bus", "gens_bus", "loads_bus",
                  "pst_tap", "substations", "switches", "loads_p"):
            setattr(action, f, None)
        action.gens_p = {"GEN_A": 99.0}  # already on the action
        dict_action = {"user_topo_x": {"content": {"set_gen_p": {"GEN_A": 24.0}}}}
        topo = extract_action_topology(action, "user_topo_x", dict_action)
        assert topo["gens_p"] == {"GEN_A": 99.0}


# ----------------------------------------------------------------------
# serialize_action_result + normalise_non_convergence
# ----------------------------------------------------------------------

class TestSerializeActionResult:
    def test_produces_expected_keys(self):
        action_data = {
            "description_unitaire": "Desc",
            "rho_before": [0.5],
            "rho_after": [0.4],
            "max_rho": 0.7,
            "max_rho_line": "L1",
            "is_rho_reduction": True,
            "is_islanded": False,
            "disconnected_mw": 0.0,
            "n_components": 1,
            "non_convergence": None,
            "lines_overloaded_after": ["L1"],
            "action_topology": {"switches": {"SW1": 1}},
            "curtailment_details": None,
            "load_shedding_details": None,
            "pst_details": None,
            "content": {"switches": {"SW1": 1}},
        }
        result = serialize_action_result("act1", action_data)
        assert result["action_id"] == "act1"
        assert result["is_estimated"] is False
        assert result["lines_overloaded"] == ["L1"]
        assert result["lines_overloaded_after"] == ["L1"]

    def test_defaults_description_when_missing(self):
        result = serialize_action_result("act1", {})
        assert result["description_unitaire"] == "No description available"
        assert result["n_components"] == 1


class TestNormaliseNonConvergence:
    def test_none_returns_none(self):
        assert normalise_non_convergence(None) is None

    def test_empty_list_returns_none(self):
        assert normalise_non_convergence([]) is None

    def test_scalar_exception_is_stringified(self):
        assert normalise_non_convergence(ValueError("bad state")) == "bad state"

    def test_list_is_joined(self):
        assert normalise_non_convergence([ValueError("a"), ValueError("b")]) == "a; b"


# ----------------------------------------------------------------------
# build_combined_description
# ----------------------------------------------------------------------

class TestBuildCombinedDescription:
    def test_single_id_uses_description_unitaire(self):
        dict_action = {"a": {"description_unitaire": "Action A"}}
        assert build_combined_description(["a"], dict_action, {}) == "Action A"

    def test_single_id_falls_back_to_description(self):
        dict_action = {"a": {"description": "Fallback desc"}}
        assert build_combined_description(["a"], dict_action, {}) == "Fallback desc"

    def test_single_id_falls_back_to_id(self):
        assert build_combined_description(["some_id"], {}, {}) == "some_id"

    def test_combined_prefixes_with_COMBINED(self):
        dict_action = {
            "a": {"description_unitaire": "Act A"},
            "b": {"description_unitaire": "Act B"},
        }
        assert (
            build_combined_description(["a", "b"], dict_action, {})
            == "[COMBINED] Act A + Act B"
        )

    def test_combined_falls_back_to_recent_actions(self):
        recent = {"a": {"description_unitaire": "From recent"}}
        dict_action = {"b": {"description_unitaire": "In dict"}}
        assert (
            build_combined_description(["a", "b"], dict_action, recent)
            == "[COMBINED] From recent + In dict"
        )


# ----------------------------------------------------------------------
# compute_combined_rho
# ----------------------------------------------------------------------

class TestComputeCombinedRho:
    def _obs(self, rho):
        obs = MagicMock()
        obs.rho = np.array(rho, dtype=float)
        return obs

    def test_equal_weights(self):
        # betas = [0.5, 0.5], remainder = 0 → avg of the two action obs
        obs_start = self._obs([0.0, 0.0])
        obs1 = self._obs([1.0, 2.0])
        obs2 = self._obs([3.0, 4.0])
        rho = compute_combined_rho(obs_start, obs1, obs2, [0.5, 0.5])
        np.testing.assert_allclose(rho, [2.0, 3.0])

    def test_zero_weights_recovers_start(self):
        obs_start = self._obs([1.0, 2.0])
        obs1 = self._obs([10.0, 20.0])
        obs2 = self._obs([30.0, 40.0])
        rho = compute_combined_rho(obs_start, obs1, obs2, [0.0, 0.0])
        np.testing.assert_allclose(rho, [1.0, 2.0])

    def test_takes_absolute_value(self):
        # Negative combined rho (e.g. phasor inversion) is returned as magnitude.
        obs_start = self._obs([1.0])
        obs1 = self._obs([-3.0])
        obs2 = self._obs([0.0])
        rho = compute_combined_rho(obs_start, obs1, obs2, [1.0, 0.0])
        # (1 - 1)·1 + 1·(-3) + 0·0 = -3 → |−3| = 3
        np.testing.assert_allclose(rho, [3.0])


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__]))
