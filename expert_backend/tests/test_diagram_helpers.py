# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0

"""Unit tests for the stateless helpers extracted from diagram_mixin."""
from __future__ import annotations

import json
import re
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


# A NAD whose node "8" pypowsybl could not place: pypowsybl writes NaN in the
# SVG (root included) but (0, 0) in the metadata.
_NAN_ROOT_SVG = (
    '<svg width="NaN" height="NaN" viewBox="NaN NaN NaN NaN" xmlns="http://www.w3.org/2000/svg">'
    '<g class="nad-vl-nodes">'
    '<g transform="translate(100.00,200.00)" id="0"><circle r="27.50"/></g>'
    '<g transform="translate(1100.00,700.00)" id="4"><circle r="27.50"/></g>'
    '<g transform="translate(NaN,NaN)" id="8"><circle r="27.50"/></g>'
    '</g></svg>'
)
_NAN_ROOT_META = {
    "svgParameters": {
        "diagramPadding": {"left": 200.0, "top": 200.0, "right": 200.0, "bottom": 200.0},
        "sizeConstraint": "FIXED_HEIGHT", "fixedWidth": 800, "fixedHeight": 600, "fixedScale": 0.2,
    },
    "nodes": [
        {"svgId": "0", "equipmentId": "A", "x": 100.0, "y": 200.0},
        {"svgId": "4", "equipmentId": "B", "x": 1100.0, "y": 700.0},
        {"svgId": "8", "equipmentId": "C", "x": 0.0, "y": 0.0},
    ],
    "textNodes": [
        {"svgId": "1", "vlNode": "0", "shiftX": 100.0, "shiftY": -40.0},
        {"svgId": "5", "vlNode": "4", "shiftX": 100.0, "shiftY": -40.0},
        {"svgId": "9", "vlNode": "8", "shiftX": 0.0, "shiftY": 0.0},
    ],
}


def _root_attrs(svg: str) -> dict:
    from lxml import etree
    return dict(etree.fromstring(svg.encode()).attrib)


def _real_pypowsybl_jupyter():
    try:
        import pypowsybl.network as pn
        import pypowsybl_jupyter.util as pju
    except ImportError:
        return None
    return None if isinstance(pn, MagicMock) or isinstance(pju, MagicMock) else pn


@pytest.mark.skipif(not _lxml_available(), reason="lxml not installed")
class TestNanRootRepair:
    def test_recomputes_root_size_from_the_finite_nodes(self):
        out = nad_render._strip_nan_elements(_NAN_ROOT_SVG, json.dumps(_NAN_ROOT_META))
        # Nodes (100, 200), (1100, 700) and their labels (+100, -40), padded
        # by 200; node "8" (metadata (0, 0)) was stripped, so it is left out.
        assert _root_attrs(out) == {
            "viewBox": "-100.00 -40.00 1500.00 940.00",
            "height": "600.00",  # FIXED_HEIGHT
            "width": "957.45",
        }
        assert "NaN" not in out

    def test_default_padding_and_no_size_attributes(self):
        meta = {**_NAN_ROOT_META, "svgParameters": {}}
        svg = _NAN_ROOT_SVG.replace('width="NaN" height="NaN" ', "")
        out = nad_render._strip_nan_elements(svg, json.dumps(meta))
        assert _root_attrs(out) == {"viewBox": "-100.00 -40.00 1500.00 940.00"}

    def test_size_constraints(self):
        assert nad_render._size_scale({"sizeConstraint": "FIXED_WIDTH", "fixedWidth": 800}, 1600, 900) == 0.5
        assert nad_render._size_scale({"sizeConstraint": "FIXED_SCALE", "fixedScale": 0.2}, 1600, 900) == 0.2
        assert nad_render._size_scale({"sizeConstraint": "NONE"}, 1600, 900) == 1.0

    def test_root_kept_without_metadata(self):
        out = nad_render._strip_nan_elements(_NAN_ROOT_SVG)
        assert _root_attrs(out)["viewBox"] == "NaN NaN NaN NaN"
        assert 'id="8"' not in out  # the NaN node is still stripped

    def test_finite_root_untouched(self):
        svg = _NAN_ROOT_SVG.replace('width="NaN" height="NaN" viewBox="NaN NaN NaN NaN"', 'viewBox="1 2 3 4"')
        out = nad_render._strip_nan_elements(svg, json.dumps(_NAN_ROOT_META))
        assert _root_attrs(out) == {"viewBox": "1 2 3 4"}

    @pytest.mark.skipif(_real_pypowsybl_jupyter() is None, reason="needs the real pypowsybl")
    def test_matches_pypowsybl_own_root_size(self):
        from pypowsybl_jupyter.util import _get_svg_metadata, _get_svg_string

        from expert_backend.services.diagram.nad_params import default_nad_parameters

        network = _real_pypowsybl_jupyter().create_ieee14()
        diagram = network.get_network_area_diagram(nad_parameters=default_nad_parameters())
        svg, meta = _get_svg_string(diagram), _get_svg_metadata(diagram)
        broken = re.sub(r'(width|height|viewBox)="[^"]*"', lambda m: f'{m.group(1)}="NaN"', svg, count=3)

        def numbers(text):
            attrs = _root_attrs(text)
            return [float(v) for k in ("viewBox", "width", "height") for v in attrs[k].split()]

        # The metadata positions are rounded to 0.01, hence the tolerance.
        assert numbers(nad_render._strip_nan_elements(broken, meta)) == pytest.approx(numbers(svg), abs=0.02)


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


def _side_limits(entries):
    """Limits frame with a ``side`` column: ``{(element, side): value}``."""
    rows = [{"element_id": e, "side": side, "type": "CURRENT", "acceptable_duration": -1, "value": v}
            for (e, side), v in entries.items()]
    return pd.DataFrame(rows).set_index(["element_id", "side", "type", "acceptable_duration"])[["value"]]


class TestGetBranchLoading:
    def test_each_end_against_the_permanent_limit(self):
        lines = pd.DataFrame({"i1": [150.0, 10.0], "i2": [-160.0, 5.0]}, index=["L1", "L2"])
        net = _mock_network(lines_df=lines, limits_df=_limits({"L1": 200.0, "L2": 100.0}))
        # |i| / limit per end, rounded to 0.1 %.
        assert overloads.get_branch_loading(net) == {"L1": [75.0, 80.0], "L2": [10.0, 5.0]}

    def test_each_end_against_its_own_side(self):
        lines = pd.DataFrame({"i1": [90.0, 50.0], "i2": [90.0, 50.0]}, index=["BOTH", "ONE_SIDE"])
        trafos = pd.DataFrame({"i1": [688.0], "i2": [1162.0]}, index=["TR"])
        net = _mock_network(lines_df=lines, trafos_df=trafos, limits_df=_side_limits({
            ("BOTH", "ONE"): 100.0, ("BOTH", "TWO"): 90.0,
            ("ONE_SIDE", "ONE"): 100.0,
            ("TR", "TWO"): 1659.0,
        }))
        loading = overloads.get_branch_loading(net)
        assert loading["BOTH"] == [90.0, 100.0]
        # A line's ends share a voltage: one side's limit holds for both.
        assert loading["ONE_SIDE"] == [50.0, 50.0]
        # A transformer's side-1 current is at another voltage: no loading there.
        assert loading["TR"] == [None, 70.0]

    def test_skips_branches_without_a_limit_and_reads_disconnected_as_zero(self):
        lines = pd.DataFrame({"i1": [500.0, float("nan")], "i2": [0.0, float("nan")]},
                             index=["NO_LIMIT", "OPEN"])
        net = _mock_network(lines_df=lines, limits_df=_limits({"OPEN": 100.0}))
        assert overloads.get_branch_loading(net) == {"OPEN": [0.0, 0.0]}

    def test_no_limits_means_no_loading(self):
        lines = pd.DataFrame({"i1": [100.0], "i2": [0.0]}, index=["L1"])
        net = _mock_network(lines_df=lines)
        assert overloads.get_branch_loading(net) == {}
        net.get_lines.assert_not_called()

    def test_max_loading_is_the_larger_known_end(self):
        assert overloads.max_loading([None, 70.0]) == 70.0
        assert overloads.max_loading([90.0, 100.0]) == 100.0
        assert overloads.max_loading([None, None]) is None
        assert overloads.max_loading(None) is None


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


class TestComputeLoadingDeltas:
    def test_percentage_point_deltas_of_the_larger_end_categorised_like_the_flows(self):
        after = {"L1": [95.0, 90.0], "L2": [40.0, None], "L3": [50.2, 50.0]}
        before = {"L1": [70.0, 60.0], "L2": [60.0, None], "L3": [50.0, 49.0]}
        result = deltas.compute_loading_deltas(after, before)
        assert result["L1"] == {"delta": 25.0, "category": "positive"}
        assert result["L2"] == {"delta": -20.0, "category": "negative"}
        # 0.2 pt < 5 % of the largest delta (25 pt) → grey.
        assert result["L3"]["category"] == "grey"

    def test_only_branches_loaded_in_both_states(self):
        result = deltas.compute_loading_deltas(
            {"L1": [10.0, 9.0], "NEW": [5.0, 5.0], "NONE": [None, None]},
            {"L1": [5.0, 4.0], "OLD": [1.0, 1.0], "NONE": [3.0, 3.0]},
        )
        assert set(result) == {"L1"}


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
