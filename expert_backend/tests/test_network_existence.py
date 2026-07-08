# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# SPDX-License-Identifier: MPL-2.0
"""Tests for :mod:`expert_backend.recommenders.network_existence`.

Covers the defensive filter that drops dict_action entries whose target
VL / line / 2WT id is unknown to the loaded pypowsybl network (regression
for the ``AUBE P4`` case on a small grid with a large-grid action dict).
"""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

# Importing any expert_backend.recommenders submodule triggers the
# package __init__, which registers the concrete upstream model
# classes — skip in mock-only environments.
pytest.importorskip("expert_op4grid_recommender.models.base")

from expert_backend.recommenders.network_existence import (
    _action_targets_known_elements,
    _network_existence_sets,
    filter_to_existing_network_elements,
)


def _mock_network(line_ids=("L1", "L2"), twt_ids=("T1",), vl_ids=("VL_A", "VL_B")):
    net = MagicMock()
    net.get_voltage_levels.return_value = SimpleNamespace(index=list(vl_ids))
    net.get_lines.return_value = SimpleNamespace(index=list(line_ids))
    net.get_2_windings_transformers.return_value = SimpleNamespace(index=list(twt_ids))
    return net


# ---------------------------------------------------------------------
# _network_existence_sets
# ---------------------------------------------------------------------

def test_network_existence_sets_none_when_network_is_none():
    assert _network_existence_sets(None) is None


def test_network_existence_sets_returns_union_of_lines_and_twt():
    net = _mock_network(line_ids=("L1",), twt_ids=("T1",), vl_ids=("VL",))
    vl_ids, branch_ids = _network_existence_sets(net)
    assert vl_ids == {"VL"}
    assert branch_ids == {"L1", "T1"}


def test_network_existence_sets_tolerates_missing_2wt_api():
    net = _mock_network()
    net.get_2_windings_transformers.side_effect = AttributeError("no 2WT")
    vl_ids, branch_ids = _network_existence_sets(net)
    assert "L1" in branch_ids
    assert "T1" not in branch_ids


def test_network_existence_sets_returns_none_on_vl_failure():
    net = _mock_network()
    net.get_voltage_levels.side_effect = RuntimeError("boom")
    assert _network_existence_sets(net) is None


def test_network_existence_sets_tolerates_missing_lines_api():
    net = _mock_network()
    net.get_lines.side_effect = AttributeError("no lines")
    vl_ids, branch_ids = _network_existence_sets(net)
    # Lines unavailable → only 2WT remain.
    assert "L1" not in branch_ids
    assert "T1" in branch_ids


# ---------------------------------------------------------------------
# _action_targets_known_elements
# ---------------------------------------------------------------------

VL_IDS = {"VL_A", "VL_B"}
BRANCH_IDS = {"L1", "L2", "T1"}


def test_action_accepts_known_voltage_level_id():
    entry = {"VoltageLevelId": "VL_A"}
    assert _action_targets_known_elements(entry, VL_IDS, BRANCH_IDS) is True


def test_action_accepts_lowercase_voltage_level_id():
    entry = {"voltage_level_id": "VL_B"}
    assert _action_targets_known_elements(entry, VL_IDS, BRANCH_IDS) is True


def test_action_rejects_unknown_voltage_level_id():
    entry = {"VoltageLevelId": "AUBE P4"}
    assert _action_targets_known_elements(entry, VL_IDS, BRANCH_IDS) is False


def test_action_accepts_known_lines_or_id():
    entry = {"content": {"set_bus": {"lines_or_id": {"L1": 1}}}}
    assert _action_targets_known_elements(entry, VL_IDS, BRANCH_IDS) is True


def test_action_rejects_unknown_lines_or_id():
    entry = {"content": {"set_bus": {"lines_or_id": {"FOREIGN_LINE": -1}}}}
    assert _action_targets_known_elements(entry, VL_IDS, BRANCH_IDS) is False


def test_action_rejects_unknown_lines_ex_id():
    entry = {"content": {"set_bus": {"lines_ex_id": {"FOREIGN_LINE": -1}}}}
    assert _action_targets_known_elements(entry, VL_IDS, BRANCH_IDS) is False


def test_action_accepts_when_no_references():
    """Conservative default: no target references → can't prove invalid."""
    entry = {"description": "x", "content": {}}
    assert _action_targets_known_elements(entry, VL_IDS, BRANCH_IDS) is True


def test_action_rejects_non_dict_entries():
    assert _action_targets_known_elements("not a dict", VL_IDS, BRANCH_IDS) is False
    assert _action_targets_known_elements(None, VL_IDS, BRANCH_IDS) is False


def test_action_short_circuits_on_first_unknown_line():
    entry = {"content": {"set_bus": {
        "lines_or_id": {"L1": 1, "FOREIGN": -1},
        "lines_ex_id": {"L2": 1},
    }}}
    # Even though L1/L2 are present, FOREIGN makes the action invalid.
    assert _action_targets_known_elements(entry, VL_IDS, BRANCH_IDS) is False


def test_action_accepts_transformer_id_in_branch_ids():
    entry = {"content": {"set_bus": {"lines_or_id": {"T1": -1}}}}
    assert _action_targets_known_elements(entry, VL_IDS, BRANCH_IDS) is True


# ---------------------------------------------------------------------
# filter_to_existing_network_elements
# ---------------------------------------------------------------------

def test_filter_returns_input_when_network_is_none():
    candidates = ["a1", "a2"]
    out = filter_to_existing_network_elements(candidates, {"a1": {}, "a2": {}}, None)
    assert out == ["a1", "a2"]


def test_filter_drops_actions_for_unknown_vl():
    """Regression: the AUBE P4 case from the small_grid bug report."""
    net = _mock_network(vl_ids=("VL_A",))
    dict_action = {
        "ok": {"VoltageLevelId": "VL_A"},
        "bad": {"VoltageLevelId": "AUBE P4"},
    }
    out = filter_to_existing_network_elements(["ok", "bad"], dict_action, net)
    assert out == ["ok"]


def test_filter_drops_actions_for_unknown_line():
    net = _mock_network(line_ids=("L1",), twt_ids=(), vl_ids=("VL",))
    dict_action = {
        "ok": {"content": {"set_bus": {"lines_or_id": {"L1": -1}}}},
        "bad": {"content": {"set_bus": {"lines_or_id": {"FOREIGN": -1}}}},
    }
    out = filter_to_existing_network_elements(["ok", "bad"], dict_action, net)
    assert out == ["ok"]


def test_filter_returns_input_when_dict_action_is_empty():
    net = _mock_network()
    assert filter_to_existing_network_elements(["a"], {}, net) == ["a"]


def test_filter_returns_input_when_introspection_fails():
    """Conservative: never silently empty the pool on backend errors."""
    net = MagicMock()
    net.get_voltage_levels.side_effect = RuntimeError("boom")
    out = filter_to_existing_network_elements(
        ["a"], {"a": {"VoltageLevelId": "VL"}}, net,
    )
    assert out == ["a"]


def test_filter_skips_unknown_action_ids():
    net = _mock_network()
    out = filter_to_existing_network_elements(["unknown"], {"other": {}}, net)
    assert out == []


def test_filter_preserves_input_order():
    net = _mock_network(vl_ids=("VL_A", "VL_B"))
    dict_action = {
        "a3": {"VoltageLevelId": "VL_A"},
        "a1": {"VoltageLevelId": "VL_B"},
        "a2": {"VoltageLevelId": "VL_A"},
    }
    out = filter_to_existing_network_elements(["a3", "a1", "a2"], dict_action, net)
    assert out == ["a3", "a1", "a2"]
