# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0

"""Layout completion for the voltage levels a ``grid_layout.json`` misses or stacks.

``services/diagram/layout_completion.py`` positions the missing ones and
spreads the ones sharing a point before pypowsybl sees the layout. Otherwise
its GEOGRAPHICAL layout places the missing ones on its own scale or at NaN
(the NAD root viewBox turns into ``NaN NaN NaN NaN``), and draws a branch
between two stacked voltage levels with NaN coordinates. Seen on the 2026
France snapshot drawn with the 2024 RTE layout. The unit tests run on a
hand-built pandas network; the last class drives real pypowsybl.
"""
from __future__ import annotations

import json
import math
import re
from pathlib import Path
from unittest.mock import MagicMock

import pandas as pd
import pytest

from expert_backend.services.diagram import layout_completion
from expert_backend.services.diagram.layout_completion import (
    DISK_RADIUS,
    SPACING_MARGIN,
    complete_layout,
    complete_layout_cached,
    node_boost,
)


def _frame(rows, columns):
    """A pypowsybl-like table: ``rows`` is ``{id: (col values...)}``."""
    return pd.DataFrame.from_dict(dict(rows), orient="index", columns=columns)


class _FakeNetwork:
    """The pypowsybl table getters ``complete_layout`` reads, over pandas.

    Like pypowsybl, a getter asked for a column its table lacks raises.
    ``get_boundary_lines`` (pypowsybl >= 1.16) is left out on purpose so the
    ``get_dangling_lines`` fallback runs.
    """

    def __init__(self, vls, lines=(), transformers=(), hvdc=(), stations=(), ties=(),
                 dangling=(), voltages=None, network_id="fake"):
        self.id = network_id
        nominal_v = {vl: (sub, (voltages or {}).get(vl, 400.0)) for vl, sub in vls.items()}
        self._tables = {
            "get_voltage_levels": _frame(nominal_v, ["substation_id", "nominal_v"]),
            "get_lines": _frame(lines, ["voltage_level1_id", "voltage_level2_id"]),
            "get_2_windings_transformers": _frame(
                transformers, ["voltage_level1_id", "voltage_level2_id"]),
            "get_3_windings_transformers": _frame(
                (), ["voltage_level1_id", "voltage_level2_id", "voltage_level3_id"]),
            "get_hvdc_lines": _frame(hvdc, ["converter_station1_id", "converter_station2_id"]),
            "get_vsc_converter_stations": _frame(stations, ["voltage_level_id"]),
            "get_lcc_converter_stations": _frame((), ["voltage_level_id"]),
            "get_tie_lines": _frame(ties, ["dangling_line1_id", "dangling_line2_id"]),
            "get_dangling_lines": _frame(dangling, ["voltage_level_id"]),
        }

    def __getattr__(self, getter):
        tables = self.__dict__.get("_tables", {})
        if getter not in tables:
            raise AttributeError(getter)
        return lambda attributes=None: tables[getter][list(attributes or [])]


# A 4-VL grid spanning 100,000 units: below 500 voltage levels the frontend
# draws native disks, so voltage levels are kept one diameter + 30 % apart.
GRID = {
    "S1_400": (10_000.0, 20_000.0),
    "S1_225": (12_000.0, 20_000.0),
    "S2_400": (100_000.0, 0.0),
    "S3_400": (0.0, 100_000.0),
}
SPACING = 2 * DISK_RADIUS * SPACING_MARGIN
BASE_VLS = {"S1_400": "S1", "S1_225": "S1", "S2_400": "S2", "S3_400": "S3"}


def _layout(positions):
    df = pd.DataFrame.from_dict(positions, orient="index", columns=["x", "y"])
    df.index.name = "id"
    return df


def _distance(df, vl, point):
    return math.dist(tuple(df.loc[vl]), point)


class TestCompleteLayout:
    def test_layout_covering_the_network_is_returned_as_is(self):
        df = _layout(GRID)
        assert complete_layout(df, _FakeNetwork(BASE_VLS)) is df

    def test_layout_for_another_grid_is_returned_as_is(self):
        df = _layout({"ELSEWHERE": (0.0, 0.0), "FARAWAY": (5.0, 5.0)})
        assert complete_layout(df, _FakeNetwork(BASE_VLS)) is df

    def test_missing_vl_lands_next_to_its_substation(self):
        net = _FakeNetwork({**BASE_VLS, "S1_63": "S1"}, lines={"L": ("S1_63", "S2_400")})
        out = complete_layout(_layout(GRID), net)
        # Substation siblings win over the electrical neighbour S2_400.
        assert _distance(out, "S1_63", (11_000.0, 20_000.0)) == pytest.approx(SPACING)

    def test_new_substation_lands_between_its_neighbours(self):
        net = _FakeNetwork(
            {**BASE_VLS, "NEW_400": "NEW"},
            lines={"L1": ("NEW_400", "S2_400")},
            transformers={"T1": ("S3_400", "NEW_400")},
        )
        out = complete_layout(_layout(GRID), net)
        assert _distance(out, "NEW_400", (50_000.0, 50_000.0)) == pytest.approx(SPACING)

    def test_a_chain_of_new_vls_hangs_off_the_grid(self):
        # A_TAIL only touches Z_HEAD, which only touches the grid: A_TAIL
        # sorts first, so it is placed by a second pass.
        net = _FakeNetwork(
            {**BASE_VLS, "A_TAIL": "TAIL", "Z_HEAD": "HEAD"},
            lines={"L1": ("A_TAIL", "Z_HEAD"), "L2": ("Z_HEAD", "S2_400")},
        )
        out = complete_layout(_layout(GRID), net)
        assert _distance(out, "Z_HEAD", GRID["S2_400"]) == pytest.approx(SPACING)
        assert _distance(out, "A_TAIL", tuple(out.loc["Z_HEAD"])) == pytest.approx(SPACING)

    def test_hvdc_and_tie_lines_count_as_neighbours(self):
        net = _FakeNetwork(
            {**BASE_VLS, "OFFSHORE": "OFF", "BORDER": "XB"},
            hvdc={"H1": ("VSC_OFF", "VSC_S2")},
            stations={"VSC_OFF": ("OFFSHORE",), "VSC_S2": ("S2_400",)},
            ties={"TIE": ("DL_X", "DL_FR")},
            dangling={"DL_X": ("BORDER",), "DL_FR": ("S3_400",)},
        )
        out = complete_layout(_layout(GRID), net)
        assert _distance(out, "OFFSHORE", GRID["S2_400"]) == pytest.approx(SPACING)
        assert _distance(out, "BORDER", GRID["S3_400"]) == pytest.approx(SPACING)

    def test_isolated_vls_are_parked_inside_the_grid(self):
        net = _FakeNetwork({**BASE_VLS, "ISO_1": "I1", "ISO_2": "I2"})
        out = complete_layout(_layout(GRID), net)
        # One step in from the bottom-left corner (x min, y max), then rightwards.
        assert tuple(out.loc["ISO_1"]) == pytest.approx((SPACING, 100_000.0 - SPACING))
        assert tuple(out.loc["ISO_2"]) == pytest.approx((2 * SPACING, 100_000.0 - SPACING))

    def test_offsets_are_deterministic_and_keep_vls_apart(self):
        net = _FakeNetwork({**BASE_VLS, "S1_63": "S1", "S1_20": "S1"})
        first = complete_layout(_layout(GRID), net)
        second = complete_layout(_layout(GRID), net)
        pd.testing.assert_frame_equal(first, second)
        assert tuple(first.loc["S1_63"]) != tuple(first.loc["S1_20"])

    def test_non_finite_row_is_replaced(self):
        positions = {**GRID, "S1_225": (math.nan, 20_000.0)}
        out = complete_layout(_layout(positions), _FakeNetwork(BASE_VLS))
        assert out.notna().all().all()
        assert _distance(out, "S1_225", GRID["S1_400"]) == pytest.approx(SPACING)

    def test_keeps_rows_for_vls_outside_the_network(self):
        # The layout file may cover a wider grid; those rows are passed on.
        positions = {**GRID, "OTHER_GRID_VL": (1.0, 2.0)}
        out = complete_layout(_layout(positions), _FakeNetwork({**BASE_VLS, "S1_63": "S1"}))
        assert tuple(out.loc["OTHER_GRID_VL"]) == (1.0, 2.0)
        assert list(out.columns) == ["x", "y"]
        assert out.index.name == "id"


class TestSpreadColocated:
    """Voltage levels the layout puts at one point are moved apart."""

    POINT = (50_000.0, 50_000.0)

    def test_highest_voltage_keeps_the_point_the_other_heads_for_its_lines(self):
        positions = {**GRID, "S4_400": self.POINT, "S4_63": self.POINT}
        net = _FakeNetwork(
            {**BASE_VLS, "S4_400": "S4", "S4_63": "S4"},
            lines={"L": ("S4_63", "S2_400")},
            voltages={"S4_63": 63.0},
        )
        out = complete_layout(_layout(positions), net)
        assert tuple(out.loc["S4_400"]) == self.POINT
        # Towards S2_400 at (100 000, 0): south-east of the point, i.e. -45°.
        expected = (self.POINT[0] + SPACING / math.sqrt(2), self.POINT[1] - SPACING / math.sqrt(2))
        assert tuple(out.loc["S4_63"]) == pytest.approx(expected)

    def test_a_group_is_spread_evenly_round_the_point(self):
        positions = {**GRID, "A": self.POINT, "B": self.POINT, "C": self.POINT}
        net = _FakeNetwork(
            {**BASE_VLS, "A": "SA", "B": "SA", "C": "SA"},
            voltages={"A": 63.0, "B": 225.0, "C": 20.0},
        )
        out = complete_layout(_layout(positions), net)
        assert tuple(out.loc["B"]) == self.POINT  # the highest voltage stays
        assert _distance(out, "A", self.POINT) == pytest.approx(SPACING)
        assert _distance(out, "C", self.POINT) == pytest.approx(SPACING)
        assert _distance(out, "A", tuple(out.loc["C"])) == pytest.approx(2 * SPACING)

    def test_equal_voltages_keep_the_smallest_id_and_spread_border_nodes(self):
        positions = {**GRID, ".ABAD 6": self.POINT, ".ELGE 6": self.POINT}
        net = _FakeNetwork({**BASE_VLS, ".ABAD 6": "XA", ".ELGE 6": "XE"})
        out = complete_layout(_layout(positions), net)
        assert tuple(out.loc[".ABAD 6"]) == self.POINT
        assert _distance(out, ".ELGE 6", self.POINT) == pytest.approx(SPACING)

    def test_layout_rows_outside_the_network_share_points_freely(self):
        df = _layout({**GRID, "GHOST": GRID["S1_400"]})
        assert complete_layout(df, _FakeNetwork(BASE_VLS)) is df

    def test_completed_and_stacked_voltage_levels_together(self):
        positions = {**GRID, "S4_400": self.POINT, "S4_63": self.POINT}
        net = _FakeNetwork(
            {**BASE_VLS, "S4_400": "S4", "S4_63": "S4", "S4_20": "S4"},
            voltages={"S4_63": 63.0, "S4_20": 20.0},
        )
        out = complete_layout(_layout(positions), net)
        points = [tuple(out.loc[vl]) for vl in ("S4_400", "S4_63", "S4_20")]
        assert len(set(points)) == 3
        # The missing 20 kV level lands one spacing away from its substation's mean.
        assert _distance(out, "S4_20", self.POINT) == pytest.approx(SPACING)


class TestNodeBoostMirror:
    """The spacing follows the node boost svgBoost.ts applies to VL disks."""

    def test_matches_the_france_snapshot_boost(self):
        # The 2026 France NAD: the frontend computed scale(30.75) on this viewBox.
        assert node_boost(1_643_872, 1_304_459, 5888) == pytest.approx(30.75, abs=0.01)

    def test_native_disks_below_500_voltage_levels_or_on_small_diagrams(self):
        assert node_boost(1_643_872, 1_304_459, 499) == 1.0
        assert node_boost(3_000, 3_000, 5888) == 1.0

    def test_capped_at_the_ceiling(self):
        assert node_boost(400_000_000, 400_000_000, 600) == 60.0

    def test_constants_match_svgboost_ts(self):
        ts = Path(__file__).resolve().parents[2] / "frontend" / "src" / "utils" / "svg" / "svgBoost.ts"
        if not ts.exists():
            pytest.skip("frontend sources not checked out")
        source = ts.read_text()

        def const(name):
            expr = re.search(rf"const {name} = ([^;]+);", source).group(1)
            num, _, den = expr.partition("/")
            return float(num) / (float(den) if den else 1.0)

        assert const("REFERENCE_SIZE") == layout_completion._BOOST_REFERENCE_SIZE
        assert const("BOOST_THRESHOLD") == layout_completion._BOOST_THRESHOLD
        assert const("NODE_BOOST_FLOOR") == layout_completion._NODE_BOOST_FLOOR
        assert const("NODE_BOOST_OFFSET") == layout_completion._NODE_BOOST_OFFSET
        assert const("NODE_BOOST_GAIN") == pytest.approx(layout_completion._NODE_BOOST_GAIN)
        assert const("NODE_BOOST_CEILING") == layout_completion._NODE_BOOST_CEILING
        assert const("VL_DENSITY_REFERENCE") == layout_completion._VL_DENSITY_REFERENCE
        assert f"vlCount < {layout_completion._BOOST_MIN_VL_COUNT}" in source


class TestCompleteLayoutCached:
    @pytest.fixture
    def counting(self, monkeypatch):
        calls = []
        real = layout_completion.complete_layout

        def spy(df, network):
            calls.append(network)
            return real(df, network)

        monkeypatch.setattr(layout_completion, "complete_layout", spy)
        return calls

    @staticmethod
    def _run(df, network, cache):
        return complete_layout_cached(
            df, network, get_cache=lambda: cache[0], set_cache=lambda v: cache.__setitem__(0, v),
        )

    def test_reuses_the_completion_for_the_same_layout_and_network(self, counting):
        df, cache = _layout(GRID), [None]
        net = _FakeNetwork({**BASE_VLS, "S1_63": "S1"})
        first = self._run(df, net, cache)
        assert self._run(df, net, cache) is first
        # A copy of the network (a reassessment worker's) shares the entry.
        assert self._run(df, _FakeNetwork({**BASE_VLS, "S1_63": "S1"}), cache) is first
        assert len(counting) == 1

    def test_recomputes_for_a_new_layout_version(self, counting):
        cache = [None]
        net = _FakeNetwork({**BASE_VLS, "S1_63": "S1"})
        self._run(_layout(GRID), net, cache)
        self._run(_layout(GRID), net, cache)  # reloaded file: new frame object
        assert len(counting) == 2

    def test_recomputes_for_a_network_with_other_voltage_levels(self, counting):
        df, cache = _layout(GRID), [None]
        self._run(df, _FakeNetwork({**BASE_VLS, "S1_63": "S1"}), cache)
        out = self._run(df, _FakeNetwork({**BASE_VLS, "S1_20": "S1"}), cache)
        assert len(counting) == 2
        assert "S1_20" in out.index

    def test_failure_falls_back_to_the_raw_layout(self):
        df, cache = _layout(GRID), [None]
        broken = MagicMock()
        broken.get_voltage_levels.side_effect = RuntimeError("no network")
        assert self._run(df, broken, cache) is df
        assert cache[0] is None


def _real_pypowsybl():
    try:
        import pypowsybl.network as pn
        import pypowsybl_jupyter.util as pju
    except ImportError:
        return None
    if isinstance(pn, MagicMock) or isinstance(pju, MagicMock):
        return None
    return pn


@pytest.mark.skipif(_real_pypowsybl() is None, reason="needs the real pypowsybl")
class TestCompletedLayoutWithPypowsybl:
    def test_missing_vl_drawn_next_to_its_substation(self):
        from expert_backend.services.diagram.nad_params import default_nad_parameters
        from expert_backend.services.diagram.nad_render import generate_diagram

        network = _real_pypowsybl().create_ieee14()
        vls = list(network.get_voltage_levels().index)
        # A layout on the RTE scale (units of ~100 km), missing VL7.
        df = _layout({vl: (100_000.0 * i, 50_000.0 * (i % 4)) for i, vl in enumerate(vls) if vl != "VL7"})

        completed = complete_layout(df, network)
        diagram = generate_diagram(network, df_layout=completed, nad_parameters=default_nad_parameters())

        nodes = {n["equipmentId"]: (n["x"], n["y"]) for n in json.loads(diagram["metadata"])["nodes"]}
        # VL7 shares substation S4 with VL4 and VL9.
        mean = ((df.x["VL4"] + df.x["VL9"]) / 2, (df.y["VL4"] + df.y["VL9"]) / 2)
        assert math.dist(nodes["VL7"], mean) == pytest.approx(SPACING, rel=1e-3)
        view_box = re.search(r'<svg[^>]*viewBox="([^"]+)"', diagram["svg"]).group(1)
        x, y, w, h = map(float, view_box.split())
        # The diagram spans the layout (plus padding), nothing beyond.
        assert x < min(df.x) < max(df.x) < x + w
        assert w < (max(df.x) - min(df.x)) * 1.1

    def test_stacked_voltage_levels_drawn_without_nan(self):
        from pypowsybl_jupyter.util import _get_svg_string

        from expert_backend.services.diagram.nad_params import default_nad_parameters

        network = _real_pypowsybl().create_ieee14()
        vls = network.get_voltage_levels(attributes=["nominal_v"])
        positions = {vl: (100_000.0 * i, 50_000.0 * (i % 4)) for i, vl in enumerate(vls.index)}
        # Substation S4's three voltage levels, joined by transformers, at one point.
        stacked = ("VL4", "VL7", "VL9")
        for vl in stacked:
            positions[vl] = positions["VL4"]
        df = _layout(positions)

        def nad(layout):
            return _get_svg_string(network.get_network_area_diagram(
                fixed_positions=layout, nad_parameters=default_nad_parameters()))

        assert "NaN" in nad(df), "pypowsybl draws edges between stacked voltage levels with NaN"
        completed = complete_layout(df, network)
        assert "NaN" not in nad(completed)
        assert len({tuple(completed.loc[vl]) for vl in stacked}) == 3
        anchor = max(stacked, key=lambda vl: (vls.nominal_v[vl], [-ord(c) for c in vl]))
        assert tuple(completed.loc[anchor]) == positions["VL4"]
