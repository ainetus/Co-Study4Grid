"""Unit tests for the pure geometry of separate_voltage_levels.py.

These exercise the import-safe helpers only (no pypowsybl required) — the
network-coupled ``main`` / ``_build_topology`` path is covered by running the
script against a real network dataset.
"""
from __future__ import annotations

import math
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import separate_voltage_levels as S  # noqa: E402


def test_angular_gaps_empty_is_full_circle():
    gaps = S.angular_gaps([])
    assert len(gaps) == 1
    assert gaps[0][1] == pytest.approx(2 * math.pi)


def test_angular_gaps_two_opposite_angles():
    gaps = S.angular_gaps([0.0, math.pi])
    assert len(gaps) == 2
    # both gaps are half-circles
    assert all(g[1] == pytest.approx(math.pi) for g in gaps)
    # bisectors point up / down
    bisectors = sorted(g[0] for g in gaps)
    assert bisectors[0] == pytest.approx(-math.pi / 2)
    assert bisectors[1] == pytest.approx(math.pi / 2)


def test_angular_gaps_sorted_descending():
    gaps = S.angular_gaps([0.0, 0.1, math.pi])
    sizes = [g[1] for g in gaps]
    assert sizes == sorted(sizes, reverse=True)


def test_default_separation_clears_one_boosted_diameter():
    # the two disks must not overlap on screen: separation must exceed the
    # boosted disk diameter (2 × 27.5 × boost ceiling).
    assert S.DEFAULT_SEPARATION > S.BOOSTED_DIAMETER


def test_placement_single_mover_prefers_open_gap_aligned_with_own_lines():
    # lines clustered to the right (angles near 0) → open gap points left (±pi)
    gaps = S.angular_gaps([0.2, -0.2, 0.4])
    [theta] = S.placement_directions(gaps, [None])
    # the only open gap is the big one opposite the cluster → near pi
    assert S._ang_dist(theta, math.pi) < math.radians(30)


def test_placement_two_movers_are_distinct():
    gaps = S.angular_gaps([0.0, math.pi / 2, math.pi, -math.pi / 2])
    thetas = S.placement_directions(gaps, [None, None])
    assert S._ang_dist(thetas[0], thetas[1]) > math.radians(20)


def test_placement_more_movers_than_gaps_fans_them_out():
    # a single dominant open gap, three levels to place → all distinct
    gaps = S.angular_gaps([0.0, 0.1, 0.2])
    thetas = S.placement_directions(gaps, [None, None, None])
    for i in range(len(thetas)):
        for j in range(i + 1, len(thetas)):
            assert S._ang_dist(thetas[i], thetas[j]) > math.radians(10)


def test_separate_layout_keeps_highest_voltage_and_moves_lower():
    # one substation with a co-located 400 + 225 pair, plus a far neighbour
    layout = {
        "vl_hi": [0.0, 0.0],
        "vl_lo": [30.0, 20.0],          # co-located (≈36 units away)
        "vl_far": [5000.0, 0.0],
    }
    vl_sub = {"vl_hi": "S1", "vl_lo": "S1", "vl_far": "S2"}
    vl_nom = {"vl_hi": 400.0, "vl_lo": 225.0, "vl_far": 400.0}
    # the lower level has a line out to the far station
    line_nb = {"vl_hi": ["vl_far"], "vl_lo": ["vl_far"], "vl_far": ["vl_hi", "vl_lo"]}

    new, n_moved = S.separate_layout(layout, vl_sub, vl_nom, line_nb)
    assert n_moved == 1
    assert new["vl_hi"] == [0.0, 0.0]              # anchor untouched
    assert new["vl_far"] == [5000.0, 0.0]          # single-VL station untouched
    moved = new["vl_lo"]
    d = math.hypot(moved[0], moved[1])             # distance from anchor
    assert d == pytest.approx(S.DEFAULT_SEPARATION, abs=1.0)
    assert d > S.BOOSTED_DIAMETER                  # disks clear on screen


def test_separation_is_configurable():
    layout = {"vl_hi": [0.0, 0.0], "vl_lo": [30.0, 20.0]}
    vl_sub = {"vl_hi": "S1", "vl_lo": "S1"}
    vl_nom = {"vl_hi": 400.0, "vl_lo": 225.0}
    new, _ = S.separate_layout(layout, vl_sub, vl_nom, {"vl_hi": [], "vl_lo": []},
                               separation=8000.0)
    assert math.hypot(*new["vl_lo"]) == pytest.approx(8000.0, abs=1.0)
