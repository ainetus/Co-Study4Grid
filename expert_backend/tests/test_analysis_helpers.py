# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0

"""Unit tests for the stateless helpers extracted from analysis_mixin.

These cover the pure functions under ``services/analysis/`` in
isolation — no ``RecommenderService`` instance, no network layer.
"""
from __future__ import annotations

import os
from types import SimpleNamespace
from unittest.mock import MagicMock

import numpy as np
import pytest

from expert_backend.services.analysis import (
    action_enrichment,
    analysis_runner,
    mw_start_scoring,
    pdf_watcher,
)


# ----------------------------------------------------------------------
# pdf_watcher
# ----------------------------------------------------------------------

class TestFindLatestPdf:
    def test_returns_none_for_empty_folder(self, tmp_path):
        assert pdf_watcher.find_latest_pdf(str(tmp_path)) is None

    def test_picks_the_newest_pdf(self, tmp_path):
        a = tmp_path / "old.pdf"
        b = tmp_path / "new.pdf"
        a.write_bytes(b"a")
        b.write_bytes(b"b")
        os.utime(a, (100, 100))
        os.utime(b, (200, 200))
        assert pdf_watcher.find_latest_pdf(str(tmp_path)) == str(b)

    def test_filters_by_analysis_start_time(self, tmp_path):
        stale = tmp_path / "stale.pdf"
        fresh = tmp_path / "fresh.pdf"
        stale.write_bytes(b"a")
        fresh.write_bytes(b"b")
        os.utime(stale, (100, 100))
        os.utime(fresh, (500, 500))
        # Only PDFs newer than 400 should be returned (minus 1s safety margin).
        assert pdf_watcher.find_latest_pdf(str(tmp_path), analysis_start_time=400) == str(fresh)

    def test_returns_none_when_all_pdfs_predate_start_time(self, tmp_path):
        p = tmp_path / "x.pdf"
        p.write_bytes(b"a")
        os.utime(p, (100, 100))
        assert pdf_watcher.find_latest_pdf(str(tmp_path), analysis_start_time=500) is None

    def test_mtime_safety_margin_accepts_almost_new_pdfs(self, tmp_path):
        # A PDF written 0.5s before the start time must still be picked up
        # — the safety margin is 1s.
        p = tmp_path / "x.pdf"
        p.write_bytes(b"a")
        os.utime(p, (99.5, 99.5))
        assert pdf_watcher.find_latest_pdf(str(tmp_path), analysis_start_time=100.0) == str(p)

    def test_picks_html_only(self, tmp_path):
        # VISUALIZATION_FORMAT="html" is now the default — interactive
        # overflow viewer lands as .html in SAVE_FOLDER_VISUALIZATION.
        html = tmp_path / "overflow.html"
        html.write_text("<html></html>")
        os.utime(html, (200, 200))
        assert pdf_watcher.find_latest_pdf(str(tmp_path)) == str(html)

    def test_picks_pdf_when_no_html(self, tmp_path):
        # Legacy fallback: if only a .pdf is present (e.g. older
        # expert_op4grid_recommender without HTML export), return it.
        pdf = tmp_path / "overflow.pdf"
        pdf.write_bytes(b"%PDF-1.4")
        os.utime(pdf, (200, 200))
        assert pdf_watcher.find_latest_pdf(str(tmp_path)) == str(pdf)

    def test_picks_newest_html_over_older_pdf(self, tmp_path):
        # Mixed folder (e.g. a previous PDF-era run left a .pdf behind):
        # pick whichever is newest, regardless of extension.
        old_pdf = tmp_path / "old.pdf"
        new_html = tmp_path / "new.html"
        old_pdf.write_bytes(b"%PDF-1.4")
        new_html.write_text("<html></html>")
        os.utime(old_pdf, (100, 100))
        os.utime(new_html, (200, 200))
        assert pdf_watcher.find_latest_pdf(str(tmp_path)) == str(new_html)

    def test_mixed_start_time_filter(self, tmp_path):
        # Start-time filter applies uniformly to both extensions.
        stale_html = tmp_path / "stale.html"
        fresh_pdf = tmp_path / "fresh.pdf"
        stale_html.write_text("<html></html>")
        fresh_pdf.write_bytes(b"%PDF-1.4")
        os.utime(stale_html, (100, 100))
        os.utime(fresh_pdf, (500, 500))
        assert pdf_watcher.find_latest_pdf(str(tmp_path), analysis_start_time=400) == str(fresh_pdf)


# ----------------------------------------------------------------------
# action_enrichment
# ----------------------------------------------------------------------

class TestNormaliseNonConvergence:
    def test_none_and_empty_return_none(self):
        assert action_enrichment.normalise_non_convergence(None) is None
        assert action_enrichment.normalise_non_convergence([]) is None

    def test_scalar_is_stringified(self):
        assert action_enrichment.normalise_non_convergence(ValueError("bad")) == "bad"

    def test_list_is_joined(self):
        assert action_enrichment.normalise_non_convergence([ValueError("a"), "b"]) == "a; b"


class TestDeriveNonConvergence:
    def test_explicit_takes_priority(self):
        obs = SimpleNamespace(_last_info={"exception": "from obs"})
        out = action_enrichment.derive_non_convergence(
            {"non_convergence": "explicit", "observation": obs}
        )
        assert out == "explicit"

    def test_falls_back_to_observation_last_info(self):
        obs = SimpleNamespace(_last_info={"exception": "LF diverged"})
        assert action_enrichment.derive_non_convergence({"observation": obs}) == "LF diverged"

    def test_no_observation_returns_none(self):
        assert action_enrichment.derive_non_convergence({}) is None


class TestComputeLinesOverloadedAfter:
    def test_raw_loa_is_returned_as_list_when_present(self):
        out = action_enrichment.compute_lines_overloaded_after(
            raw_loa=["A", "B"],
            rho_after_raw=[1.5],
            lines_overloaded_names=["X"],
            max_rho_raw=None,
            max_rho_line="",
        )
        assert out == ["A", "B"]

    def test_reconstructs_from_rho_after_when_empty(self):
        out = action_enrichment.compute_lines_overloaded_after(
            raw_loa=None,
            rho_after_raw=[1.2, 0.5, 1.8],
            lines_overloaded_names=["A", "B", "C"],
            max_rho_raw=None,
            max_rho_line="",
        )
        assert out == ["A", "C"]

    def test_injects_max_rho_line_when_exceeds_threshold(self):
        out = action_enrichment.compute_lines_overloaded_after(
            raw_loa=None,
            rho_after_raw=[0.5],
            lines_overloaded_names=["A"],
            max_rho_raw=1.1,
            max_rho_line="BRAND_NEW_OVERLOAD",
        )
        assert out == ["BRAND_NEW_OVERLOAD"]

    def test_does_not_duplicate_max_rho_line(self):
        out = action_enrichment.compute_lines_overloaded_after(
            raw_loa=None,
            rho_after_raw=[1.3],
            lines_overloaded_names=["A"],
            max_rho_raw=1.3,
            max_rho_line="A",
        )
        assert out == ["A"]


class TestScaleRhoSeries:
    def test_none_returns_none(self):
        assert action_enrichment.scale_rho_series(None, 0.95) is None

    def test_scales_each_value(self):
        assert action_enrichment.scale_rho_series([1.0, 0.5], 0.9) == [0.9, 0.45]


class TestIsRenewableGen:
    def _obs(self, names, types):
        obs = MagicMock()
        obs.name_gen = names
        obs.gen_type = types
        return obs

    def test_wind_from_observation(self):
        ns = MagicMock()
        obs = self._obs(["W_1"], ["wind"])
        assert action_enrichment.is_renewable_gen("W_1", obs, ns) is True

    def test_solar_from_observation(self):
        ns = MagicMock()
        obs = self._obs(["S_1"], ["SOLAR"])
        assert action_enrichment.is_renewable_gen("S_1", obs, ns) is True

    def test_fallback_to_network_service(self):
        ns = MagicMock()
        ns.get_generator_type.return_value = "wind"
        # obs without gen_type attribute
        obs = SimpleNamespace(name_gen=["W_1"])
        assert action_enrichment.is_renewable_gen("W_1", obs, ns) is True

    def test_fallback_name_heuristic(self):
        ns = MagicMock()
        ns.get_generator_type.return_value = None
        obs = SimpleNamespace(name_gen=["W_1"])
        assert action_enrichment.is_renewable_gen("WIND_42", obs, ns) is True
        assert action_enrichment.is_renewable_gen("GAS_42", obs, ns) is False


class TestExtractActionTopology:
    def test_reads_attribute_fields(self):
        action = SimpleNamespace(
            lines_ex_bus={"L1": 1}, lines_or_bus={}, gens_bus={}, loads_bus={},
            pst_tap={}, substations={}, switches={"SW1": 1}, loads_p={}, gens_p={},
        )
        topo = action_enrichment.extract_action_topology(action, "a", {})
        assert topo["lines_ex_bus"] == {"L1": 1}
        assert topo["switches"] == {"SW1": 1}

    def test_backfills_switches_from_dict_action(self):
        action = SimpleNamespace(
            lines_ex_bus={}, lines_or_bus={}, gens_bus={}, loads_bus={},
            pst_tap={}, substations={}, switches=None, loads_p={}, gens_p={},
        )
        dict_action = {"a": {"content": {"switches": {"SW_DICT": 1}}}}
        topo = action_enrichment.extract_action_topology(action, "a", dict_action)
        assert topo["switches"] == {"SW_DICT": 1}


class TestComputeLoadSheddingDetails:
    def _obs(self, names, load_p):
        return SimpleNamespace(name_load=names, load_p=np.array(load_p))

    def test_returns_none_without_action(self):
        assert action_enrichment.compute_load_shedding_details({}, None, MagicMock()) is None

    def test_returns_none_when_no_loads_affected(self):
        action = SimpleNamespace(loads_bus={}, loads_p={})
        ns = MagicMock()
        out = action_enrichment.compute_load_shedding_details(
            {"action": action, "observation": self._obs(["L1"], [10.0])}, None, ns
        )
        assert out is None

    def test_shed_mw_from_loads_p_format(self):
        action = SimpleNamespace(loads_bus={}, loads_p={"L1": 0.0})
        obs_n1 = self._obs(["L1"], [50.0])
        obs_action = self._obs(["L1"], [20.0])
        ns = MagicMock()
        ns.get_load_voltage_level.return_value = "VL_A"
        out = action_enrichment.compute_load_shedding_details(
            {"action": action, "observation": obs_action}, obs_n1, ns
        )
        assert out == [{"load_name": "L1", "voltage_level_id": "VL_A", "shedded_mw": 30.0}]

    def test_legacy_bus_format(self):
        action = SimpleNamespace(loads_bus={"L1": -1, "L2": 1})
        obs_n1 = self._obs(["L1", "L2"], [15.0, 10.0])
        obs_action = self._obs(["L1", "L2"], [0.0, 10.0])
        ns = MagicMock()
        ns.get_load_voltage_level.return_value = None
        out = action_enrichment.compute_load_shedding_details(
            {"action": action, "observation": obs_action}, obs_n1, ns
        )
        assert len(out) == 1
        assert out[0]["load_name"] == "L1"
        assert out[0]["shedded_mw"] == 15.0


class TestComputeCurtailmentDetails:
    def _obs(self, names, gen_p):
        return SimpleNamespace(name_gen=names, gen_p=np.array(gen_p))

    def test_returns_none_without_action(self):
        assert action_enrichment.compute_curtailment_details({}, None, MagicMock()) is None

    def test_curtailed_mw_for_renewable(self):
        action = SimpleNamespace(gens_bus={}, gens_p={"WIND_1": 0.0})
        obs_n1 = self._obs(["WIND_1"], [100.0])
        obs_action = self._obs(["WIND_1"], [30.0])
        ns = MagicMock()
        ns.get_generator_voltage_level.return_value = "VL_W"
        out = action_enrichment.compute_curtailment_details(
            {"action": action, "observation": obs_action}, obs_n1, ns,
            is_renewable_fn=lambda g, obs: True,
        )
        assert out == [{"gen_name": "WIND_1", "voltage_level_id": "VL_W", "curtailed_mw": 70.0}]

    def test_filters_out_non_renewable(self):
        action = SimpleNamespace(gens_bus={}, gens_p={"GAS_1": 0.0})
        ns = MagicMock()
        obs = self._obs(["GAS_1"], [50.0])
        out = action_enrichment.compute_curtailment_details(
            {"action": action, "observation": obs}, obs, ns,
            is_renewable_fn=lambda g, obs: False,
        )
        assert out is None

    def test_disconnected_mw_fallback_when_no_observation(self):
        action = SimpleNamespace(gens_bus={"WIND_1": -1, "WIND_2": -1})
        ns = MagicMock()
        ns.get_generator_voltage_level.return_value = None
        out = action_enrichment.compute_curtailment_details(
            {"action": action, "observation": None, "disconnected_mw": 100.0},
            None, ns,
            is_renewable_fn=lambda g, obs: True,
        )
        assert out is not None
        assert all(d["curtailed_mw"] == 50.0 for d in out)


class TestComputePstDetails:
    def test_returns_none_without_action_or_content(self):
        assert action_enrichment.compute_pst_details({}, None) is None

    def test_reads_pst_tap_from_action_obj(self):
        action = SimpleNamespace(pst_tap={"PST_A": 5})
        details = action_enrichment.compute_pst_details(
            {"action": action}, pst_tap_info_fn=None,
        )
        assert details == [{"pst_name": "PST_A", "tap_position": 5,
                            "low_tap": None, "high_tap": None}]

    def test_fills_bounds_from_pst_tap_info_fn(self):
        action = SimpleNamespace(pst_tap={"PST_A": 5})
        info_fn = MagicMock(return_value={"low_tap": -5, "high_tap": 10})
        details = action_enrichment.compute_pst_details(
            {"action": action}, pst_tap_info_fn=info_fn,
        )
        assert details[0]["low_tap"] == -5
        assert details[0]["high_tap"] == 10

    def test_reads_from_content_when_action_has_no_pst_tap(self):
        action = SimpleNamespace(pst_tap=None)
        details = action_enrichment.compute_pst_details(
            {"action": action, "content": {"pst_tap": {"PST_B": 3}}},
            pst_tap_info_fn=None,
        )
        assert details[0]["pst_name"] == "PST_B"
        assert details[0]["tap_position"] == 3


# ----------------------------------------------------------------------
# mw_start_scoring
# ----------------------------------------------------------------------

class TestClassifyActionType:
    @pytest.mark.parametrize("action_type,expected", [
        ("load_shedding", "load_shedding"),
        ("LS_GROUP", "load_shedding"),
        ("renewable_curtailment", "curtail"),
        ("redispatch", "redispatch"),
        ("line_disconnection", "disco"),
        ("pst_tap_change", "pst"),
        ("open_coupling", "open"),
        ("unknown", "other"),
    ])
    def test_mapping(self, action_type, expected):
        assert mw_start_scoring.classify_action_type(action_type) == expected


class TestIsNaActionType:
    @pytest.mark.parametrize("t", ["line_reconnection", "reco_X", "close_coupling"])
    def test_positive(self, t):
        assert mw_start_scoring.is_na_action_type(t) is True

    @pytest.mark.parametrize("t", ["line_disconnection", "pst_tap_change", "load_shedding"])
    def test_negative(self, t):
        assert mw_start_scoring.is_na_action_type(t) is False


class TestMwStartLoadShedding:
    def test_reads_set_load_p(self):
        obs = SimpleNamespace(load_p=np.array([42.0, 10.0]))
        entry = {"content": {"set_load_p": {"LOAD_A": 0.0}}}
        result = mw_start_scoring.mw_start_load_shedding(
            "some_id", entry, obs, {"LOAD_A": 0, "LOAD_B": 1},
        )
        assert result == 42.0

    def test_reads_legacy_set_bus_loads(self):
        obs = SimpleNamespace(load_p=np.array([30.0, 20.0]))
        entry = {"content": {"set_bus": {"loads_id": {"LOAD_A": -1, "LOAD_B": 1}}}}
        result = mw_start_scoring.mw_start_load_shedding(
            "x", entry, obs, {"LOAD_A": 0, "LOAD_B": 1},
        )
        assert result == 30.0

    def test_action_id_pattern_fallback(self):
        obs = SimpleNamespace(load_p=np.array([17.0]))
        result = mw_start_scoring.mw_start_load_shedding(
            "load_shedding_LOAD_A", None, obs, {"LOAD_A": 0},
        )
        assert result == 17.0

    def test_returns_none_when_unmatched(self):
        obs = SimpleNamespace(load_p=np.array([10.0]))
        assert mw_start_scoring.mw_start_load_shedding(
            "unknown", None, obs, {"LOAD_A": 0},
        ) is None


class TestMwStartCurtailment:
    def test_reads_set_gen_p(self):
        obs = SimpleNamespace(gen_p=np.array([85.0, 10.0]))
        entry = {"content": {"set_gen_p": {"WIND_1": 0.0}}}
        result = mw_start_scoring.mw_start_curtailment(
            "x", entry, obs, {"WIND_1": 0, "WIND_2": 1},
        )
        assert result == 85.0

    def test_falls_back_to_prod_p_when_no_gen_p(self):
        # Legacy observations expose prod_p instead of gen_p.
        obs = SimpleNamespace(prod_p=np.array([50.0]))
        result = mw_start_scoring.mw_start_curtailment(
            "curtail_WIND_1", None, obs, {"WIND_1": 0},
        )
        assert result == 50.0


class TestMwStartLineDisconnection:
    def test_reads_line_or_with_bus_minus_one(self):
        obs = SimpleNamespace(p_or=np.array([123.4]))
        entry = {"content": {"set_bus": {"lines_or_id": {"LINE_X": -1}}}}
        result = mw_start_scoring.mw_start_line_disconnection(
            entry, obs, {"LINE_X": 0},
        )
        assert result == 123.4


class TestMwStartOpenCouplingHelper:
    def test_injected_fn_is_called(self):
        fn = MagicMock(return_value=66.0)
        set_bus = {
            "lines_or_id": {"L1": 1},
            "lines_ex_id": {"L2": 2},
        }
        obs = SimpleNamespace(name_gen=[])
        result = mw_start_scoring.mw_start_open_coupling(
            set_bus, obs, {"L1": 0, "L2": 1}, {},
            virtual_line_flow_fn=fn,
        )
        assert result == 66.0
        fn.assert_called_once()

    def test_returns_none_with_no_positive_buses(self):
        assert mw_start_scoring.mw_start_open_coupling(
            {"lines_or_id": {"L1": -1}}, SimpleNamespace(name_gen=[]), {}, {},
            virtual_line_flow_fn=lambda *a: 99.0,
        ) is None


class TestGetActionMwStartDispatcher:
    def test_dispatches_load_shedding(self):
        obs = SimpleNamespace(load_p=np.array([40.0]))
        result = mw_start_scoring.get_action_mw_start(
            "load_shedding_LOAD_A", "load_shedding", obs,
            line_idx_map={}, load_idx_map={"LOAD_A": 0}, gen_idx_map={},
            action_entry=None,
        )
        assert result == 40.0

    def test_returns_none_for_na_type_with_no_entry(self):
        obs = SimpleNamespace()
        result = mw_start_scoring.get_action_mw_start(
            "anything", "other", obs, {}, {}, {}, action_entry=None,
        )
        assert result is None


class TestGetPstTapStart:
    def test_uses_parameters_previous_tap_first(self):
        entry = {
            "content": {"pst_tap": {"PST_A": 8}},
            "parameters": {"previous tap": 3},
        }
        result = mw_start_scoring.get_pst_tap_start(
            entry,
            initial_pst_taps={"PST_A": {"low_tap": -5, "high_tap": 10}},
            pst_tap_info_fn=None,
        )
        assert result == {"pst_name": "PST_A", "tap": 3, "low_tap": -5, "high_tap": 10}

    def test_falls_back_to_initial_pst_taps_cache(self):
        entry = {"content": {"pst_tap": {"PST_B": 7}}}
        result = mw_start_scoring.get_pst_tap_start(
            entry,
            initial_pst_taps={"PST_B": {"tap": 4, "low_tap": -3, "high_tap": 9}},
            pst_tap_info_fn=None,
        )
        assert result == {"pst_name": "PST_B", "tap": 4, "low_tap": -3, "high_tap": 9}

    def test_live_info_fn_fallback(self):
        entry = {"content": {"pst_tap": {"PST_C": 2}}}
        info_fn = MagicMock(return_value={"tap": 5, "low_tap": 0, "high_tap": 10})
        result = mw_start_scoring.get_pst_tap_start(
            entry, initial_pst_taps=None, pst_tap_info_fn=info_fn,
        )
        assert result["tap"] == 5

    def test_returns_none_when_no_entry(self):
        assert mw_start_scoring.get_pst_tap_start(None, None, None) is None

    def test_returns_none_when_no_pst_tap(self):
        assert mw_start_scoring.get_pst_tap_start({"content": {}}, None, None) is None


# ----------------------------------------------------------------------
# analysis_runner
# ----------------------------------------------------------------------

class TestDeriveAnalysisMessage:
    def test_returns_original_when_result_is_present(self):
        assert analysis_runner.derive_analysis_message(
            "all good", "whatever", result={"foo": "bar"},
        ) == "all good"

    def test_detects_no_topological_solution(self):
        out = analysis_runner.derive_analysis_message(
            "", "No topological solution without load shedding", result=None,
        )
        assert "No topological solution" in out

    def test_detects_grid_broken_apart(self):
        out = analysis_runner.derive_analysis_message(
            "", "Overload breaks the grid apart", result=None,
        )
        assert "Grid instability" in out

    def test_generic_fallback_message(self):
        out = analysis_runner.derive_analysis_message("", "unrelated output", result=None)
        assert "no recommendations" in out


class TestComputeRedispatchDetails:
    def _obs(self, names, gen_p):
        return SimpleNamespace(name_gen=names, gen_p=np.array(gen_p))

    def test_returns_none_without_action(self):
        assert action_enrichment.compute_redispatch_details({}, None, MagicMock()) is None

    def test_raise_direction_positive_delta(self):
        # Therm at 30 MW (gen_p negative convention), target 40 MW -> +10 raise.
        action = SimpleNamespace(gens_p={"THERM_1": 40.0})
        obs_n1 = self._obs(["THERM_1"], [-30.0])
        obs_action = self._obs(["THERM_1"], [-40.0])
        ns = MagicMock()
        ns.get_generator_voltage_level.return_value = "VL_T"
        ns.get_generator_active_power_limits.return_value = (0.0, 100.0)
        out = action_enrichment.compute_redispatch_details(
            {"action": action, "observation": obs_action}, obs_n1, ns,
        )
        assert out == [{
            "gen_name": "THERM_1", "voltage_level_id": "VL_T",
            "delta_mw": 10.0, "target_mw": 40.0, "direction": "up",
            "current_mw": 30.0,
            "max_raise_mw": 70.0,   # 100 (max_p) - 30 (current)
            "max_lower_mw": 30.0,   # 30 (current) - 0 (min_p)
        }]

    def test_headroom_none_when_limits_unavailable(self):
        action = SimpleNamespace(gens_p={"THERM_1": 40.0})
        obs_n1 = self._obs(["THERM_1"], [-30.0])
        obs_action = self._obs(["THERM_1"], [-40.0])
        ns = MagicMock()
        ns.get_generator_voltage_level.return_value = None
        ns.get_generator_active_power_limits.return_value = None
        out = action_enrichment.compute_redispatch_details(
            {"action": action, "observation": obs_action}, obs_n1, ns,
        )
        assert out[0]["max_raise_mw"] is None
        assert out[0]["max_lower_mw"] is None
        assert out[0]["current_mw"] == 30.0

    def test_lower_direction_negative_delta(self):
        action = SimpleNamespace(gens_p={"THERM_1": 20.0})
        obs_n1 = self._obs(["THERM_1"], [-50.0])
        obs_action = self._obs(["THERM_1"], [-20.0])
        ns = MagicMock()
        ns.get_generator_voltage_level.return_value = None
        out = action_enrichment.compute_redispatch_details(
            {"action": action, "observation": obs_action}, obs_n1, ns,
        )
        assert out[0]["delta_mw"] == -30.0
        assert out[0]["direction"] == "down"

    def test_delta_uses_encoded_target_not_redistributed_simulation(self):
        # Regression: a 10 MW lower from 12 MW encodes target_p = 2 MW, but the
        # load flow may back the unit off to 0 MW. The editable delta must stay
        # the INTENDED -10 MW (encoded target vs current), NOT -12 MW (simulated).
        action = SimpleNamespace(gens_p={"G": 2.0})
        obs_n1 = self._obs(["G"], [-12.0])       # producing 12 MW
        obs_action = self._obs(["G"], [0.0])      # slack redistribution → 0 MW
        ns = MagicMock()
        ns.get_generator_voltage_level.return_value = None
        out = action_enrichment.compute_redispatch_details(
            {"action": action, "observation": obs_action}, obs_n1, ns,
        )
        assert out[0]["delta_mw"] == -10.0
        assert out[0]["target_mw"] == 2.0
        assert out[0]["current_mw"] == 12.0
        assert out[0]["direction"] == "down"

    def test_discovery_stage_uses_target_from_content(self):
        # No post-action observation: fall back to the encoded set_gen_p target.
        obs_n1 = self._obs(["THERM_1"], [-30.0])
        ns = MagicMock()
        ns.get_generator_voltage_level.return_value = None
        out = action_enrichment.compute_redispatch_details(
            {"action": SimpleNamespace(gens_p={}),
             "content": {"set_gen_p": {"THERM_1": 45.0}}, "observation": None},
            obs_n1, ns,
        )
        assert out[0]["target_mw"] == 45.0
        assert out[0]["delta_mw"] == 15.0
        assert out[0]["direction"] == "up"


class TestMwStartRedispatch:
    def test_reads_set_gen_p(self):
        obs = SimpleNamespace(gen_p=np.array([-55.0, 10.0]))
        entry = {"content": {"set_gen_p": {"THERM_1": 65.0}}}
        result = mw_start_scoring.mw_start_redispatch(
            "x", entry, obs, {"THERM_1": 0, "THERM_2": 1},
        )
        assert result == 55.0  # current production magnitude, not the target

    def test_action_id_fallback(self):
        obs = SimpleNamespace(gen_p=np.array([-42.0]))
        result = mw_start_scoring.mw_start_redispatch(
            "redispatch_THERM_1", None, obs, {"THERM_1": 0},
        )
        assert result == 42.0

    def test_dispatcher_routes_redispatch(self):
        obs = SimpleNamespace(gen_p=np.array([-33.0]))
        result = mw_start_scoring.get_action_mw_start(
            "redispatch_THERM_1", "redispatch", obs,
            line_idx_map={}, load_idx_map={}, gen_idx_map={"THERM_1": 0},
            action_entry=None,
        )
        assert result == 33.0


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__]))
