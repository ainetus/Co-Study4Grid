# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# SPDX-License-Identifier: MPL-2.0
"""Tests for :mod:`expert_backend.recommenders.overflow_path_filter`.

Covers the path-based narrowing applied by :class:`RandomOverflowRecommender`
on top of the expert rule filter — including the regression for the
``'<' not supported between instances of 'numpy.str_' and 'int'`` crash
that silently disabled the filter on the current Structured_Overload
Distribution_Graph build.
"""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock

import numpy as np
import pytest

# Importing any expert_backend.recommenders submodule triggers the
# package __init__, which registers the concrete upstream model
# classes — skip in mock-only environments.
pytest.importorskip("expert_op4grid_recommender.models.base")

from expert_backend.recommenders.overflow_path_filter import (
    _action_touches_path,
    _extract_path_targets,
    _resolve_node_to_name,
    restrict_to_overflow_paths,
)


# ---------------------------------------------------------------------
# _resolve_node_to_name
# ---------------------------------------------------------------------

def test_resolve_node_native_int():
    arr = np.array(["A", "B", "C"])
    assert _resolve_node_to_name(1, arr, 3) == "B"


def test_resolve_node_numpy_int():
    arr = np.array(["A", "B", "C"])
    assert _resolve_node_to_name(np.int64(2), arr, 3) == "C"


def test_resolve_node_int_out_of_range_returns_none():
    arr = np.array(["A", "B"])
    assert _resolve_node_to_name(5, arr, 2) is None


def test_resolve_node_int_without_arr_returns_none():
    assert _resolve_node_to_name(1, None, 0) is None


def test_resolve_node_python_string():
    assert _resolve_node_to_name("VL_X", None, 0) == "VL_X"


def test_resolve_node_numpy_string():
    """Regression: numpy.str_ used to crash the legacy idx < n_subs check."""
    arr = np.array(["A", "B"])
    node = arr[0]
    assert isinstance(node, np.str_)
    assert _resolve_node_to_name(node, None, 0) == "A"


def test_resolve_node_bytes():
    assert _resolve_node_to_name(b"VL_X", None, 0) == "VL_X"


def test_resolve_node_none_returns_none():
    assert _resolve_node_to_name(None, None, 0) is None


def test_resolve_node_unknown_type_stringified():
    class _Stringy:
        def __str__(self):
            return "VL_DERIVED"
    assert _resolve_node_to_name(_Stringy(), None, 0) == "VL_DERIVED"


# ---------------------------------------------------------------------
# _extract_path_targets
# ---------------------------------------------------------------------

class _StubGraph:
    """Minimal stand-in for Structured_Overload_Distribution_Graph."""
    def __init__(self, dispatch_lines, loop_nodes,
                 constrained_lines, constrained_nodes, other_blue_nodes):
        self._dispatch_lines = dispatch_lines
        self._loop_nodes = loop_nodes
        self._constrained_lines = constrained_lines
        self._constrained_nodes = constrained_nodes
        self._other_blue_nodes = other_blue_nodes

    def get_dispatch_edges_nodes(self, only_loop_paths=False):
        if only_loop_paths:
            return ([], self._loop_nodes)
        return (self._dispatch_lines, [])

    def get_constrained_edges_nodes(self):
        return (self._constrained_lines, self._constrained_nodes,
                [], self._other_blue_nodes)


def test_extract_targets_with_string_nodes():
    """Current build: distribution graph returns node IDs as names directly."""
    graph = _StubGraph(
        dispatch_lines=["L_dispatch"],
        loop_nodes=["LOOP_VL"],
        constrained_lines=["L_constrained"],
        constrained_nodes=["CONSTRAINED_VL"],
        other_blue_nodes=["BLUE_VL"],
    )
    targets = _extract_path_targets(graph, None, hubs=["HUB_VL"])
    assert targets is not None
    lines, subs = targets
    assert lines == {"L_dispatch", "L_constrained"}
    assert subs == {"LOOP_VL", "CONSTRAINED_VL", "BLUE_VL", "HUB_VL"}


def test_extract_targets_with_int_nodes_resolves_via_obs():
    """Legacy build: distribution graph returns node IDs as int indices."""
    graph = _StubGraph(
        dispatch_lines=["L1"],
        loop_nodes=[0],
        constrained_lines=["L2"],
        constrained_nodes=[1],
        other_blue_nodes=[2],
    )
    obs = SimpleNamespace(name_sub=["NODE_0", "NODE_1", "NODE_2", "NODE_3"])
    targets = _extract_path_targets(graph, obs, hubs=[])
    assert targets is not None
    lines, subs = targets
    assert lines == {"L1", "L2"}
    assert subs == {"NODE_0", "NODE_1", "NODE_2"}


def test_extract_targets_handles_numpy_str_nodes():
    """Regression for the numpy.str_ comparison crash that disabled the
    whole narrow filter and let RandomOverflow sample at large."""
    nodes = np.array(["VL_A", "VL_B"])
    graph = _StubGraph(
        dispatch_lines=[],
        loop_nodes=list(nodes),  # entries are numpy.str_
        constrained_lines=[],
        constrained_nodes=[],
        other_blue_nodes=[],
    )
    targets = _extract_path_targets(graph, None, [])
    assert targets is not None
    _, subs = targets
    assert subs == {"VL_A", "VL_B"}


def test_extract_targets_returns_none_when_graph_is_none():
    assert _extract_path_targets(None, SimpleNamespace(), []) is None


def test_extract_targets_returns_none_on_exception():
    bad_graph = MagicMock()
    bad_graph.get_dispatch_edges_nodes.side_effect = RuntimeError("boom")
    assert _extract_path_targets(bad_graph, SimpleNamespace(), []) is None


def test_extract_targets_filters_out_none_entries():
    graph = _StubGraph(
        dispatch_lines=["L1", None],
        loop_nodes=[None, "LOOP"],
        constrained_lines=[],
        constrained_nodes=[],
        other_blue_nodes=[],
    )
    lines, subs = _extract_path_targets(graph, None, [])
    assert lines == {"L1"}
    assert subs == {"LOOP"}


def test_extract_targets_obs_without_name_sub_uses_strings_only():
    """obs missing name_sub should not crash — only name-string nodes contribute."""
    graph = _StubGraph(
        dispatch_lines=[],
        loop_nodes=["VL_LOOP", 5],  # the int falls through (no name_sub)
        constrained_lines=[],
        constrained_nodes=[],
        other_blue_nodes=[],
    )
    targets = _extract_path_targets(graph, SimpleNamespace(), hubs=[])
    assert targets is not None
    _, subs = targets
    assert subs == {"VL_LOOP"}


# ---------------------------------------------------------------------
# _action_touches_path
# ---------------------------------------------------------------------

RELEVANT_LINES = {"L_dispatch", "L_constrained"}
RELEVANT_SUBS = {"VL_HUB", "VL_LOOP", "VL_BLUE"}


def test_action_matches_by_voltage_level_id():
    entry = {"VoltageLevelId": "VL_HUB"}
    assert _action_touches_path("a1", entry, RELEVANT_LINES, RELEVANT_SUBS) is True


def test_action_matches_by_voltage_level_id_lowercase():
    entry = {"voltage_level_id": "VL_LOOP"}
    assert _action_touches_path("a1", entry, RELEVANT_LINES, RELEVANT_SUBS) is True


def test_action_matches_by_lines_or_id():
    entry = {"content": {"set_bus": {"lines_or_id": {"L_dispatch": 1}}}}
    assert _action_touches_path("a1", entry, RELEVANT_LINES, RELEVANT_SUBS) is True


def test_action_matches_by_lines_ex_id():
    entry = {"content": {"set_bus": {"lines_ex_id": {"L_constrained": -1}}}}
    assert _action_touches_path("a1", entry, RELEVANT_LINES, RELEVANT_SUBS) is True


def test_action_matches_by_pst_tap():
    entry = {"content": {"pst_tap": {"L_dispatch": 5}}}
    assert _action_touches_path("a1", entry, RELEVANT_LINES, RELEVANT_SUBS) is True


def test_action_matches_by_disco_prefix():
    entry = {"description": "..."}
    assert _action_touches_path(
        "disco_L_dispatch", entry, RELEVANT_LINES, RELEVANT_SUBS,
    ) is True


def test_action_matches_by_reco_prefix():
    entry = {"description": "..."}
    assert _action_touches_path(
        "reco_L_constrained", entry, RELEVANT_LINES, RELEVANT_SUBS,
    ) is True


def test_action_matches_by_uuid_segment_scan():
    """Pypowsybl UUID-prefixed coupling action: ``<uuid>_<VL>_..._coupling``."""
    aid = "549215c1-b252_VL_LOOP_MOTTA3ZRAGE.1"
    entry = {"description": "Ouverture switch dans VL_LOOP"}
    assert _action_touches_path(
        aid, entry, RELEVANT_LINES, RELEVANT_SUBS,
    ) is True


def test_action_matches_substation_as_trailing_segment():
    """A relevant substation appearing as the LAST underscore-delimited
    segment must still match (the padded-underscore anchoring)."""
    assert _action_touches_path(
        "coupling_VL_HUB", {"description": "..."}, RELEVANT_LINES, RELEVANT_SUBS,
    ) is True


def test_action_does_not_match_substation_as_non_segment_substring():
    """Regression guard for the underscore-in-substation-name fix: a
    relevant substation name (`VL_LOOP`) embedded as a NON-segment
    substring (`XVL_LOOPY`) must NOT match — the anchored `_<sub>_`
    match is what distinguishes a real segment from a coincidental
    substring."""
    aid = "549215c1_XVL_LOOPY_MOTTA"  # contains 'VL_LOOP' but not as a segment
    assert _action_touches_path(
        aid, {"description": "..."}, RELEVANT_LINES, RELEVANT_SUBS,
    ) is False


def test_action_rejects_when_nothing_matches():
    entry = {
        "VoltageLevelId": "FOREIGN_VL",
        "content": {"set_bus": {"lines_or_id": {"FOREIGN_LINE": -1}}},
    }
    assert _action_touches_path(
        "foreign", entry, RELEVANT_LINES, RELEVANT_SUBS,
    ) is False


def test_action_rejects_non_dict_entry():
    assert _action_touches_path(
        "a", "not a dict", RELEVANT_LINES, RELEVANT_SUBS,
    ) is False


def test_action_handles_numpy_str_line_ids_in_set_bus():
    """numpy.str_ values in set_bus keys must compare against plain-str sets."""
    np_line = np.str_("L_dispatch")
    entry = {"content": {"set_bus": {"lines_or_id": {np_line: 1}}}}
    assert _action_touches_path("a1", entry, RELEVANT_LINES, RELEVANT_SUBS) is True


# ---------------------------------------------------------------------
# restrict_to_overflow_paths
# ---------------------------------------------------------------------

def test_restrict_keeps_only_matching_actions():
    graph = _StubGraph(
        dispatch_lines=["L_dispatch"],
        loop_nodes=["VL_LOOP"],
        constrained_lines=[],
        constrained_nodes=[],
        other_blue_nodes=[],
    )
    dict_action = {
        "on_path": {"content": {"set_bus": {"lines_or_id": {"L_dispatch": 1}}}},
        "off_path": {"content": {"set_bus": {"lines_or_id": {"FAR_LINE": -1}}}},
        "coupling_on_path": {"VoltageLevelId": "VL_LOOP"},
    }
    out = restrict_to_overflow_paths(
        ["on_path", "off_path", "coupling_on_path"],
        dict_action, graph, obs=None, hubs=[],
    )
    assert sorted(out) == ["coupling_on_path", "on_path"]


def test_restrict_returns_input_on_extraction_error():
    """Conservative: never silently empty the pool on extraction failure."""
    bad_graph = MagicMock()
    bad_graph.get_dispatch_edges_nodes.side_effect = RuntimeError("boom")
    out = restrict_to_overflow_paths(
        ["a1", "a2"], {"a1": {}, "a2": {}}, bad_graph, None, [],
    )
    assert out == ["a1", "a2"]


def test_restrict_returns_empty_when_path_targets_are_empty():
    """Empty path → [] is the CORRECT behaviour (no overflow-relevant
    actions for this contingency). Must NOT silently fall back."""
    empty_graph = _StubGraph([], [], [], [], [])
    out = restrict_to_overflow_paths(
        ["a1"], {"a1": {}}, empty_graph, None, hubs=[],
    )
    assert out == []


def test_restrict_skips_ids_missing_from_dict():
    graph = _StubGraph(
        dispatch_lines=["L"], loop_nodes=[],
        constrained_lines=[], constrained_nodes=[], other_blue_nodes=[],
    )
    dict_action = {"a1": {"content": {"set_bus": {"lines_or_id": {"L": 1}}}}}
    out = restrict_to_overflow_paths(
        ["a1", "missing"], dict_action, graph, None, hubs=[],
    )
    assert out == ["a1"]


def test_restrict_returns_input_when_dict_action_is_empty():
    graph = _StubGraph(["L"], [], [], [], [])
    out = restrict_to_overflow_paths(["a1"], {}, graph, None, hubs=[])
    assert out == ["a1"]


def test_restrict_end_to_end_with_numpy_str_nodes():
    """End-to-end regression: filter must NOT silently disable on numpy.str_ nodes."""
    nodes = np.array(["VL_LOOP"])
    graph = _StubGraph(
        dispatch_lines=[],
        loop_nodes=list(nodes),
        constrained_lines=[],
        constrained_nodes=[],
        other_blue_nodes=[],
    )
    dict_action = {
        "on_path": {"VoltageLevelId": "VL_LOOP"},
        "off_path": {"VoltageLevelId": "VL_OTHER"},
    }
    out = restrict_to_overflow_paths(
        ["on_path", "off_path"], dict_action, graph, None, [],
    )
    assert out == ["on_path"]
