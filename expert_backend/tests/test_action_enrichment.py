# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# SPDX-License-Identifier: MPL-2.0
"""Tests for :func:`extract_action_topology` and helpers.

Covers the action-topology backfill from ``dict_action[id]["content"]["set_bus"]``
and the ``voltage_level_id`` hint propagation that fixes pin placement
and VL chip rendering for coupling / switch-based actions.
"""
from __future__ import annotations

from types import SimpleNamespace

import numpy as np
import pytest

from expert_backend.services.analysis.action_enrichment import (
    _is_meaningful_dict,
    extract_action_topology,
)


# ---------------------------------------------------------------------
# _is_meaningful_dict
# ---------------------------------------------------------------------

def test_is_meaningful_dict_for_nonempty_dict():
    assert _is_meaningful_dict({"a": 1}) is True


def test_is_meaningful_dict_empty_dict():
    assert _is_meaningful_dict({}) is False


def test_is_meaningful_dict_rejects_numpy_array():
    """Regression: previously raised ValueError on truthiness check."""
    arr = np.array([1, 2, 3])
    # Must not raise.
    assert _is_meaningful_dict(arr) is False


def test_is_meaningful_dict_rejects_list():
    assert _is_meaningful_dict([1, 2]) is False


def test_is_meaningful_dict_rejects_none():
    assert _is_meaningful_dict(None) is False


def test_is_meaningful_dict_rejects_string():
    assert _is_meaningful_dict("non-empty") is False


# ---------------------------------------------------------------------
# extract_action_topology — read attributes
# ---------------------------------------------------------------------

def test_topology_reads_attributes_from_action_object():
    action_obj = SimpleNamespace(
        lines_or_bus={"L1": 1},
        lines_ex_bus={"L1": 1},
        gens_bus={},
        loads_bus={},
        pst_tap={},
        substations={},
        switches={},
        loads_p={},
        gens_p={},
    )
    topo = extract_action_topology(action_obj, "a1", {})
    assert topo["lines_or_bus"] == {"L1": 1}
    assert topo["lines_ex_bus"] == {"L1": 1}


def test_topology_tolerates_numpy_array_attribute():
    """Regression: ``if arr`` used to raise on multi-element numpy arrays."""
    action_obj = SimpleNamespace(
        lines_or_bus=np.array([1, 2, 3]),
        lines_ex_bus={"L1": 1},
        gens_bus={},
        loads_bus={},
        pst_tap={},
        substations={},
        switches={},
        loads_p={},
        gens_p={},
    )
    topo = extract_action_topology(action_obj, "a1", {})
    # numpy array isn't a meaningful name-indexed dict → empty.
    assert topo["lines_or_bus"] == {}
    assert topo["lines_ex_bus"] == {"L1": 1}


# ---------------------------------------------------------------------
# extract_action_topology — set_bus backfill
# ---------------------------------------------------------------------

def test_topology_backfills_lines_or_bus_from_set_bus():
    action_obj = SimpleNamespace(lines_or_bus={})
    dict_action = {
        "a1": {"content": {"set_bus": {"lines_or_id": {"L1": 1, "L2": -1}}}},
    }
    topo = extract_action_topology(action_obj, "a1", dict_action)
    assert topo["lines_or_bus"] == {"L1": 1, "L2": -1}


def test_topology_backfills_lines_ex_bus_from_set_bus():
    action_obj = SimpleNamespace(lines_ex_bus={})
    dict_action = {"a1": {"content": {"set_bus": {"lines_ex_id": {"L1": -1}}}}}
    topo = extract_action_topology(action_obj, "a1", dict_action)
    assert topo["lines_ex_bus"] == {"L1": -1}


def test_topology_backfills_gens_bus_from_generators_id():
    action_obj = SimpleNamespace(gens_bus={})
    dict_action = {"a1": {"content": {"set_bus": {"generators_id": {"G1": -1}}}}}
    topo = extract_action_topology(action_obj, "a1", dict_action)
    assert topo["gens_bus"] == {"G1": -1}


def test_topology_backfills_loads_bus_from_loads_id():
    action_obj = SimpleNamespace(loads_bus={})
    dict_action = {"a1": {"content": {"set_bus": {"loads_id": {"LD1": -1}}}}}
    topo = extract_action_topology(action_obj, "a1", dict_action)
    assert topo["loads_bus"] == {"LD1": -1}


def test_topology_does_not_overwrite_existing_attribute_with_backfill():
    """When action_obj exposes a meaningful dict, it wins over the dict entry."""
    action_obj = SimpleNamespace(lines_or_bus={"REAL_LINE": 1})
    dict_action = {"a1": {"content": {"set_bus": {"lines_or_id": {"DICT_LINE": -1}}}}}
    topo = extract_action_topology(action_obj, "a1", dict_action)
    assert topo["lines_or_bus"] == {"REAL_LINE": 1}


def test_topology_backfills_when_action_obj_attribute_was_numpy_array():
    """Numpy-array attributes are non-meaningful → backfill kicks in."""
    action_obj = SimpleNamespace(lines_or_bus=np.zeros(5))
    dict_action = {"a1": {"content": {"set_bus": {"lines_or_id": {"L1": 1}}}}}
    topo = extract_action_topology(action_obj, "a1", dict_action)
    assert topo["lines_or_bus"] == {"L1": 1}


# ---------------------------------------------------------------------
# extract_action_topology — voltage_level_id surfacing
# ---------------------------------------------------------------------

def test_topology_surfaces_voltage_level_id():
    action_obj = SimpleNamespace()
    dict_action = {"a1": {"VoltageLevelId": "VL_HUB"}}
    topo = extract_action_topology(action_obj, "a1", dict_action)
    assert topo["voltage_level_id"] == "VL_HUB"


def test_topology_surfaces_lowercase_voltage_level_id():
    action_obj = SimpleNamespace()
    dict_action = {"a1": {"voltage_level_id": "VL_HUB"}}
    topo = extract_action_topology(action_obj, "a1", dict_action)
    assert topo["voltage_level_id"] == "VL_HUB"


def test_topology_no_voltage_level_id_field_when_absent():
    action_obj = SimpleNamespace()
    topo = extract_action_topology(action_obj, "a1", {"a1": {}})
    assert "voltage_level_id" not in topo


# ---------------------------------------------------------------------
# extract_action_topology — switches fallback (legacy path)
# ---------------------------------------------------------------------

def test_topology_switches_fallback_from_dict_action_top_level():
    action_obj = SimpleNamespace(switches={})
    dict_action = {"a1": {"switches": {"sw1": True}}}
    topo = extract_action_topology(action_obj, "a1", dict_action)
    assert topo["switches"] == {"sw1": True}


def test_topology_switches_fallback_from_content():
    action_obj = SimpleNamespace(switches={})
    dict_action = {"a1": {"content": {"switches": {"sw_a": False}}}}
    topo = extract_action_topology(action_obj, "a1", dict_action)
    assert topo["switches"] == {"sw_a": False}


def test_topology_no_dict_entry_keeps_action_obj_values():
    action_obj = SimpleNamespace(lines_or_bus={"L1": 1})
    topo = extract_action_topology(action_obj, "missing_id", {})
    assert topo["lines_or_bus"] == {"L1": 1}


def test_topology_works_with_none_dict_action():
    action_obj = SimpleNamespace(lines_or_bus={"L1": 1})
    topo = extract_action_topology(action_obj, "a1", None)
    assert topo["lines_or_bus"] == {"L1": 1}


# ---------------------------------------------------------------------
# Combined coverage: switch-based pypowsybl action shape
# ---------------------------------------------------------------------

def test_topology_combined_pypowsybl_switch_based_shape():
    """Realistic switch-based action: VoltageLevelId + switches dict,
    no set_bus, no lines_or_bus on action_obj."""
    action_obj = SimpleNamespace()  # bare action
    dict_action = {
        "669f27a4_AUBE_P4_coupling": {
            "VoltageLevelId": "AUBE P4",
            "switches": {"AUBE 4COUPL.1": False},
            "description": "Ouverture AUBE P4_AUBE 4COUPL.1 DJ_OC",
        },
    }
    topo = extract_action_topology(action_obj, "669f27a4_AUBE_P4_coupling", dict_action)
    assert topo["voltage_level_id"] == "AUBE P4"
    assert topo["switches"] == {"AUBE 4COUPL.1": False}
    # No bus assignments on this kind of action.
    assert topo["lines_or_bus"] == {}
    assert topo["lines_ex_bus"] == {}
