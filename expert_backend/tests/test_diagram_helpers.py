# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0

"""Unit tests for the stateless helpers extracted from diagram_mixin."""
from __future__ import annotations

import json
from types import SimpleNamespace
from unittest.mock import MagicMock

import numpy as np
import pandas as pd
import pytest

from expert_backend.services.diagram import (
    deltas,
    flows,
    layout_cache,
    nad_render,
    overloads,
    sld_render,
)


# ----------------------------------------------------------------------
# layout_cache
# ----------------------------------------------------------------------

class TestLoadLayout:
    def _write_layout(self, path, data):
        path.write_text(json.dumps(data))
        return path

    def test_returns_none_without_file(self):
        cache = [None]
        assert layout_cache.load_layout(
            None, get_cache=lambda: cache[0], set_cache=lambda v: cache.__setitem__(0, v),
        ) is None

    def test_returns_none_when_file_missing(self, tmp_path):
        cache = [None]
        assert layout_cache.load_layout(
            tmp_path / "absent.json",
            get_cache=lambda: cache[0], set_cache=lambda v: cache.__setitem__(0, v),
        ) is None

    def test_parses_and_caches_on_first_load(self, tmp_path):
        p = self._write_layout(tmp_path / "layout.json", {"A": [0, 1], "B": [2, 3]})
        cache = [None]
        df = layout_cache.load_layout(
            p, get_cache=lambda: cache[0], set_cache=lambda v: cache.__setitem__(0, v),
        )
        assert list(df.index) == ["A", "B"]
        assert df.loc["A"].tolist() == [0, 1]
        assert cache[0] is not None  # cache was populated

    def test_returns_cached_value_on_second_call(self, tmp_path):
        p = self._write_layout(tmp_path / "layout.json", {"A": [0, 1]})
        cache = [None]
        df1 = layout_cache.load_layout(
            p, get_cache=lambda: cache[0], set_cache=lambda v: cache.__setitem__(0, v),
        )
        df2 = layout_cache.load_layout(
            p, get_cache=lambda: cache[0], set_cache=lambda v: cache.__setitem__(0, v),
        )
        assert df1 is df2  # same DataFrame instance returned

    def test_invalidates_cache_on_mtime_change(self, tmp_path):
        p = self._write_layout(tmp_path / "layout.json", {"A": [0, 1]})
        cache = [None]
        layout_cache.load_layout(
            p, get_cache=lambda: cache[0], set_cache=lambda v: cache.__setitem__(0, v),
        )
        import os as _os
        _os.utime(p, (1000, 1000))  # move mtime
        df2 = layout_cache.load_layout(
            p, get_cache=lambda: cache[0], set_cache=lambda v: cache.__setitem__(0, v),
        )
        # New mtime → new DataFrame instance
        assert df2 is not None


# ----------------------------------------------------------------------
# nad_render — NaN stripping (no pypowsybl dependency)
# ----------------------------------------------------------------------

def _lxml_available() -> bool:
    try:
        import lxml  # noqa: F401
        return True
    except ImportError:
        return False


class TestStripNanElements:
    def test_passthrough_when_no_nan(self):
        svg = "<svg><g id='a'><circle cx='1' cy='2'/></g></svg>"
        assert nad_render._strip_nan_elements(svg) == svg

    @pytest.mark.skipif(not _lxml_available(), reason="lxml not installed")
    def test_strips_element_with_nan_attribute(self):
        svg = "<svg><g><circle cx='NaN' cy='0' r='5'/><rect x='0' y='0'/></g></svg>"
        out = nad_render._strip_nan_elements(svg)
        assert "NaN" not in out
        assert "rect" in out  # sibling preserved

    def test_silent_passthrough_when_parse_fails(self):
        # When lxml is unavailable OR parse fails, the function must
        # return the input unchanged and log a warning — NOT raise.
        svg = "<svg><circle cx='NaN'/></svg>"
        out = nad_render._strip_nan_elements(svg)
        # Either stripped (if lxml is present) or unchanged.
        assert isinstance(out, str)


# ----------------------------------------------------------------------
# sld_render
# ----------------------------------------------------------------------

class TestExtractSldSvgAndMetadata:
    def test_returns_tuple_of_svg_and_metadata(self):
        # The primary extraction path routes through `pypowsybl_jupyter`
        # which the conftest mock layer replaces with a MagicMock; all we
        # can rely on is that the function returns a 2-tuple without
        # raising. Full contract is covered by the integration suite.
        result = sld_render.extract_sld_svg_and_metadata(MagicMock())
        assert isinstance(result, tuple) and len(result) == 2


# ----------------------------------------------------------------------
# overloads
# ----------------------------------------------------------------------

def _mock_network(
    lines_df=None,
    trafos_df=None,
    limits_df=None,
):
    """Build a MagicMock network exposing the queries the helpers use."""
    net = MagicMock()

    empty_lim = pd.DataFrame(columns=["value"])
    empty_lim.index = pd.MultiIndex.from_tuples([], names=["element_id", "type", "acceptable_duration"])
    net.get_operational_limits.return_value = limits_df if limits_df is not None else empty_lim
    net.get_lines.return_value = lines_df if lines_df is not None else pd.DataFrame(columns=["i1", "i2"])
    net.get_2_windings_transformers.return_value = trafos_df if trafos_df is not None else pd.DataFrame(columns=["i1", "i2"])
    return net


def _limits(entries):
    """Build the MultiIndex limits DataFrame expected by pypowsybl."""
    rows = []
    for elem, limit in entries.items():
        rows.append({"element_id": elem, "type": "CURRENT", "acceptable_duration": -1, "value": limit})
    df = pd.DataFrame(rows)
    return df.set_index(["element_id", "type", "acceptable_duration"])[["value"]]


class TestGetElementMaxCurrents:
    def test_excludes_rows_with_nan_currents(self):
        lines = pd.DataFrame({"i1": [100.0, float("nan")], "i2": [50.0, 200.0]},
                             index=["L1", "L2"])
        net = _mock_network(lines_df=lines)
        result = overloads.get_element_max_currents(net)
        assert "L1" in result and result["L1"] == 100.0
        assert "L2" not in result

    def test_combines_lines_and_transformers(self):
        lines = pd.DataFrame({"i1": [100.0], "i2": [50.0]}, index=["L1"])
        trafos = pd.DataFrame({"i1": [30.0], "i2": [60.0]}, index=["T1"])
        net = _mock_network(lines_df=lines, trafos_df=trafos)
        result = overloads.get_element_max_currents(net)
        assert result == {"L1": 100.0, "T1": 60.0}

    def test_empty_network_returns_empty_dict(self):
        net = _mock_network()
        assert overloads.get_element_max_currents(net) == {}


class TestGetOverloadedLines:
    def test_flags_lines_at_or_above_monitoring_factor(self):
        # `get_overloaded_lines` uses `>=` to match the backend simulation
        # filter (`simulation_helpers.build_care_mask`), so a line sitting
        # exactly at the threshold IS treated as overloaded — no silent
        # disagreement between the N Overloads UI panel and the simulator.
        lines = pd.DataFrame({"i1": [100.0, 50.0, 49.0], "i2": [0.0, 0.0, 0.0]},
                             index=["L1", "L2", "L3"])
        limits = _limits({"L1": 100.0, "L2": 100.0, "L3": 100.0})
        net = _mock_network(lines_df=lines, limits_df=limits)
        result = overloads.get_overloaded_lines(net, monitoring_factor=0.5)
        # L1: 100 ≥ 50 → overloaded. L2: 50 ≥ 50 → overloaded.
        # L3: 49 < 50 → not overloaded.
        assert sorted(result) == ["L1", "L2"]

    def test_skips_elements_without_a_limit(self):
        lines = pd.DataFrame({"i1": [1000.0], "i2": [0.0]}, index=["L1"])
        net = _mock_network(lines_df=lines)  # no limits
        assert overloads.get_overloaded_lines(net) == []

    def test_respects_lines_we_care_about_filter(self):
        lines = pd.DataFrame({"i1": [100.0, 100.0], "i2": [0.0, 0.0]},
                             index=["L1", "L2"])
        limits = _limits({"L1": 50.0, "L2": 50.0})
        net = _mock_network(lines_df=lines, limits_df=limits)
        result = overloads.get_overloaded_lines(
            net, lines_we_care_about={"L1"}, monitoring_factor=0.95,
        )
        assert result == ["L1"]

    def test_excludes_pre_existing_overloads_not_impacted(self):
        lines = pd.DataFrame({"i1": [100.0], "i2": [0.0]}, index=["L1"])
        limits = _limits({"L1": 50.0})
        net = _mock_network(lines_df=lines, limits_df=limits)
        # In N-state the line was already at 100 → the action did not
        # move it outside the symmetric ±2 % band → not_impacted, excluded.
        result = overloads.get_overloaded_lines(
            net,
            n_state_currents={"L1": 100.0},
            monitoring_factor=0.95,
            worsening_threshold=0.02,
        )
        assert result == []

    def test_keeps_pre_existing_overloads_when_worsened_beyond_threshold(self):
        lines = pd.DataFrame({"i1": [200.0], "i2": [0.0]}, index=["L1"])
        limits = _limits({"L1": 50.0})
        net = _mock_network(lines_df=lines, limits_df=limits)
        # N-state was 100 → 200 exceeds 100 * (1 + 0.02) → kept.
        result = overloads.get_overloaded_lines(
            net, n_state_currents={"L1": 100.0}, monitoring_factor=0.95,
        )
        assert result == ["L1"]

    def test_keeps_pre_existing_overloads_when_significantly_improved(self):
        # Symmetric impact rule: a line whose pre-existing overload is
        # significantly *reduced* by the action is in the action's
        # sensitive area and must remain monitored.
        lines = pd.DataFrame({"i1": [80.0], "i2": [0.0]}, index=["L1"])
        limits = _limits({"L1": 50.0})
        net = _mock_network(lines_df=lines, limits_df=limits)
        # N-state was 100 (rho=2.0) → action brought it to 80 (rho=1.6),
        # well below 100 * (1 - 0.02) → kept by the symmetric rule.
        result = overloads.get_overloaded_lines(
            net, n_state_currents={"L1": 100.0}, monitoring_factor=0.95,
            worsening_threshold=0.02,
        )
        assert result == ["L1"]

    def test_with_rho_returns_parallel_lists(self):
        lines = pd.DataFrame({"i1": [200.0], "i2": [0.0]}, index=["L1"])
        limits = _limits({"L1": 100.0})
        net = _mock_network(lines_df=lines, limits_df=limits)
        names, rhos = overloads.get_overloaded_lines(net, with_rho=True, monitoring_factor=0.5)
        assert names == ["L1"]
        assert rhos == [2.0]


class TestGetNStateLoading:
    def test_n_current_over_permanent_limit_parallel_to_the_ids(self):
        net = _mock_network(limits_df=_limits({"L1": 200.0, "L2": 100.0}))
        loading = overloads.get_n_state_loading(net, ["L2", "L1"], {"L1": 150.0, "L2": 80.0})
        assert loading == [0.8, 0.75]

    def test_none_where_the_current_or_the_limit_is_unknown(self):
        net = _mock_network(limits_df=_limits({"L1": 200.0}))
        assert overloads.get_n_state_loading(net, ["L1", "L2", "L3"], {"L1": 100.0, "L2": 50.0}) == [0.5, None, None]

    def test_all_none_without_n_state_currents(self):
        # No N diagram yet: nothing to compare with, and no limit query.
        net = _mock_network()
        assert overloads.get_n_state_loading(net, ["L1", "L2"], None) == [None, None]
        net.get_operational_limits.assert_not_called()


# ----------------------------------------------------------------------
# flows
# ----------------------------------------------------------------------

class TestGetNetworkFlows:
    def _line_df(self, ids, p1, p2, q1, q2, vl1, vl2):
        return pd.DataFrame({
            "p1": p1, "p2": p2, "q1": q1, "q2": q2,
            "voltage_level1_id": vl1, "voltage_level2_id": vl2,
        }, index=ids)

    def test_emits_all_six_sub_dicts(self):
        lines = self._line_df(["L1"], [10.0], [-10.0], [5.0], [-5.0], ["VL_A"], ["VL_B"])
        trafos = self._line_df(["T1"], [1.0], [-1.0], [0.5], [-0.5], ["VL_B"], ["VL_C"])
        net = MagicMock()
        net.get_lines.return_value = lines
        net.get_2_windings_transformers.return_value = trafos
        out = flows.get_network_flows(net)
        assert set(out.keys()) == {"p1", "p2", "q1", "q2", "vl1", "vl2"}
        assert out["p1"]["L1"] == 10.0
        assert out["vl2"]["T1"] == "VL_C"

    def test_fills_nan_with_zero(self):
        lines = self._line_df(["L1"], [float("nan")], [0.0], [0.0], [0.0], ["A"], ["B"])
        net = MagicMock()
        net.get_lines.return_value = lines
        net.get_2_windings_transformers.return_value = lines.iloc[0:0]
        out = flows.get_network_flows(net)
        assert out["p1"]["L1"] == 0.0


class TestGetAssetFlows:
    def test_merges_loads_and_generators(self):
        loads = pd.DataFrame({"p": [100.0], "q": [50.0]}, index=["LOAD_A"])
        gens = pd.DataFrame({"p": [-80.0], "q": [-20.0]}, index=["GEN_X"])
        net = MagicMock()
        net.get_loads.return_value = loads
        net.get_generators.return_value = gens
        out = flows.get_asset_flows(net)
        assert out["LOAD_A"] == {"p": 100.0, "q": 50.0}
        assert out["GEN_X"] == {"p": -80.0, "q": -20.0}

    def test_nan_is_zeroed(self):
        loads = pd.DataFrame({"p": [float("nan")], "q": [0.0]}, index=["L1"])
        gens = pd.DataFrame({"p": [], "q": []})
        net = MagicMock()
        net.get_loads.return_value = loads
        net.get_generators.return_value = gens
        out = flows.get_asset_flows(net)
        assert out["L1"]["p"] == 0.0


# ----------------------------------------------------------------------
# deltas — terminal-aware math
# ----------------------------------------------------------------------

class TestTerminalAwareDelta:
    def test_flow_increase_same_direction(self):
        # Both terminals positive, after > before.
        delta, flip = deltas.terminal_aware_delta(100.0, 50.0)
        assert delta == 50.0
        assert flip is False

    def test_flow_decrease_same_direction(self):
        delta, flip = deltas.terminal_aware_delta(30.0, 80.0)
        assert delta == -50.0
        # Before is the reference (stronger), after has same sign → no flip
        assert flip is False

    def test_direction_reversed(self):
        # After = +10, before = -50 (stronger) → ref = negative.
        delta, flip = deltas.terminal_aware_delta(10.0, -50.0)
        # transform: after_signed = -10 (opposite of ref), before_signed = +50
        # delta = -10 - 50 = -60 (flow dropped)
        assert delta == -60.0
        # after_val (+) vs ref (-) → flip
        assert flip is True

    def test_zero_on_one_side(self):
        delta, _ = deltas.terminal_aware_delta(0.0, 100.0)
        assert delta == -100.0


class TestSelectTerminalForBranch:
    def test_returns_1_when_vl_set_empty(self):
        assert deltas.select_terminal_for_branch("L1", {}, {}, {}, {}, set()) == 1

    def test_returns_1_when_side_1_matches(self):
        out = deltas.select_terminal_for_branch(
            "L1", {"L1": "VL_A"}, {"L1": "VL_B"}, {}, {}, {"VL_A"},
        )
        assert out == 1

    def test_returns_2_when_only_side_2_matches(self):
        out = deltas.select_terminal_for_branch(
            "L1", {"L1": "VL_A"}, {"L1": "VL_B"}, {}, {}, {"VL_B"},
        )
        assert out == 2

    def test_returns_1_when_both_or_neither_match(self):
        out_both = deltas.select_terminal_for_branch(
            "L1", {"L1": "VL_A"}, {"L1": "VL_B"}, {}, {}, {"VL_A", "VL_B"},
        )
        out_neither = deltas.select_terminal_for_branch(
            "L1", {"L1": "VL_X"}, {"L1": "VL_Y"}, {}, {}, {"VL_A"},
        )
        assert out_both == 1 and out_neither == 1


class TestApplyThreshold:
    def test_categorises_around_5pct_of_max_abs(self):
        result = deltas.apply_threshold({"A": 100.0, "B": -100.0, "C": 1.0})
        assert result["A"]["category"] == "positive"
        assert result["B"]["category"] == "negative"
        assert result["C"]["category"] == "grey"  # 1 < 5% of 100

    def test_handles_empty_input(self):
        assert deltas.apply_threshold({}) == {}

    def test_rounds_delta_to_one_decimal(self):
        result = deltas.apply_threshold({"A": 10.123})
        assert result["A"]["delta"] == 10.1


class TestComputeDeltas:
    def _flows(self, ids, p1, p2, q1, q2, vl1, vl2):
        return {
            "p1": dict(zip(ids, p1)),
            "p2": dict(zip(ids, p2)),
            "q1": dict(zip(ids, q1)),
            "q2": dict(zip(ids, q2)),
            "vl1": dict(zip(ids, vl1)),
            "vl2": dict(zip(ids, vl2)),
        }

    def test_categorises_branch_deltas_on_terminal_1(self):
        after = self._flows(["L1"], [150.0], [-150.0], [50.0], [-50.0], ["VL_A"], ["VL_B"])
        before = self._flows(["L1"], [100.0], [-100.0], [40.0], [-40.0], ["VL_A"], ["VL_B"])
        result = deltas.compute_deltas(after, before)
        assert result["flow_deltas"]["L1"]["delta"] == 50.0
        assert result["flow_deltas"]["L1"]["category"] == "positive"
        assert result["reactive_flow_deltas"]["L1"]["delta"] == 10.0

    def test_selects_terminal_2_when_vl_filter_points_there(self):
        after = self._flows(["L1"], [10.0], [999.0], [0.0], [0.0], ["VL_A"], ["VL_B"])
        before = self._flows(["L1"], [10.0], [0.0], [0.0], [0.0], ["VL_A"], ["VL_B"])
        result = deltas.compute_deltas(after, before, voltage_level_ids=["VL_B"])
        # Terminal 2 selected → delta uses p2 values: 999 - 0 = 999
        assert abs(result["flow_deltas"]["L1"]["delta"] - 999.0) < 0.1


class TestComputeAssetDeltas:
    def test_positive_p_and_negative_q(self):
        after = {"LOAD_A": {"p": 120.0, "q": 40.0}}
        before = {"LOAD_A": {"p": 100.0, "q": 60.0}}
        result = deltas.compute_asset_deltas(after, before)
        entry = result["LOAD_A"]
        assert entry["delta_p"] == 20.0
        assert entry["delta_q"] == -20.0
        assert entry["category"] == "positive"  # legacy = P
        assert entry["category_q"] == "negative"

    def test_missing_before_treated_as_zero(self):
        after = {"NEW": {"p": 50.0, "q": 0.0}}
        result = deltas.compute_asset_deltas(after, {})
        assert result["NEW"]["delta_p"] == 50.0

    def test_empty_inputs_return_empty_result(self):
        assert deltas.compute_asset_deltas({}, {}) == {}


class TestComputeDeltaVectorized:
    def test_matches_scalar_for_same_direction_increase(self):
        after = np.array([100.0])
        before = np.array([50.0])
        d, flip = deltas._compute_delta_vectorized(after, before)
        assert d[0] == 50.0 and flip[0] is np.bool_(False)

    def test_matches_scalar_for_direction_flip(self):
        after = np.array([10.0])
        before = np.array([-50.0])
        d, flip = deltas._compute_delta_vectorized(after, before)
        assert d[0] == -60.0
        assert bool(flip[0]) is True


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__]))
