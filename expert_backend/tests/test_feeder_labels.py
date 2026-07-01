# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0
# This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

"""Tests for the SLD feeder-label helper (other-end VL name + parallel index).

See docs/features/sld-diagram-feeder-labels.md.
"""

from unittest.mock import MagicMock

import pandas as pd

from expert_backend.services.diagram.sld_render import build_feeder_labels


def _df(rows: dict) -> pd.DataFrame:
    """Build a DataFrame indexed by equipment id from ``{eid: {col: val}}``."""
    return pd.DataFrame.from_dict(rows, orient="index")


def _make_network(vls: dict, lines: dict, trafos: dict | None = None) -> MagicMock:
    net = MagicMock()
    net.get_voltage_levels.return_value = pd.DataFrame.from_dict(vls, orient="index")
    net.get_lines.return_value = _df(lines)
    trafo_df = (
        _df(trafos)
        if trafos
        else pd.DataFrame(columns=["name", "voltage_level1_id", "voltage_level2_id"])
    )
    net.get_2_windings_transformers.return_value = trafo_df
    return net


class TestBuildFeederLabels:
    def _network(self):
        vls = {
            "VL_PRAGN": {"name": "PRAGNERES 225kV"},
            "VL_MARSIL": {"name": "MARSILLON 225kV"},
            "VL_LANNE": {"name": "LANNEMEZAN 225kV"},
            "VL_NONAME": {"name": "VL_NONAME"},        # name == id → not a real name
            "VL_TRAFOEND": {"name": "TRAFOSUB 400kV"},
        }
        lines = {
            # overloaded line, far end MARSILLON → single
            "relation_8423569-225": {
                "name": "MARSIL61PRAGN",
                "voltage_level1_id": "VL_MARSIL",
                "voltage_level2_id": "VL_PRAGN",
            },
            # parallel pair PRAGN↔LANNE (with line_par1)
            "relation_8423570-225": {
                "name": "LANNEL61PRAGN",
                "voltage_level1_id": "VL_PRAGN",
                "voltage_level2_id": "VL_LANNE",
            },
            "line_par1": {
                "name": "LANNEL62PRAGN",
                "voltage_level1_id": "VL_PRAGN",
                "voltage_level2_id": "VL_LANNE",
            },
            # far-end VL unnamed → fall back to the branch's own name
            "line_to_noname": {
                "name": "X.LINE",
                "voltage_level1_id": "VL_PRAGN",
                "voltage_level2_id": "VL_NONAME",
            },
            # far-end VL unnamed AND branch name == id → no label
            "line_nn2": {
                "name": "line_nn2",
                "voltage_level1_id": "VL_PRAGN",
                "voltage_level2_id": "VL_NONAME",
            },
            # does not touch VL_PRAGN → excluded
            "other_line": {
                "name": "MARSIL61LANNE",
                "voltage_level1_id": "VL_MARSIL",
                "voltage_level2_id": "VL_LANNE",
            },
        }
        trafos = {
            "trafo1": {
                "name": "TR1",
                "voltage_level1_id": "VL_PRAGN",
                "voltage_level2_id": "VL_TRAFOEND",
            },
        }
        return _make_network(vls, lines, trafos)

    def test_single_branch_labelled_with_far_end_vl_name(self):
        result = build_feeder_labels(self._network(), "VL_PRAGN")
        assert result["relation_8423569-225"]["label"] == "MARSILLON 225kV"
        # The branch's own friendly (operator) name is carried for overload matching.
        assert result["relation_8423569-225"]["name"] == "MARSIL61PRAGN"
        assert result["relation_8423569-225"]["other_vl"] == "VL_MARSIL"

    def test_parallel_branches_get_indices(self):
        result = build_feeder_labels(self._network(), "VL_PRAGN")
        # Sorted by equipment id: "line_par1" < "relation_8423570-225".
        assert result["line_par1"]["label"] == "LANNEMEZAN 225kV 1"
        assert result["relation_8423570-225"]["label"] == "LANNEMEZAN 225kV 2"

    def test_unnamed_far_end_falls_back_to_branch_name(self):
        result = build_feeder_labels(self._network(), "VL_PRAGN")
        assert result["line_to_noname"]["label"] == "X.LINE"

    def test_no_label_when_neither_far_end_nor_branch_named(self):
        result = build_feeder_labels(self._network(), "VL_PRAGN")
        assert result["line_nn2"]["label"] is None
        assert result["line_nn2"]["name"] is None

    def test_branch_not_touching_vl_is_excluded(self):
        result = build_feeder_labels(self._network(), "VL_PRAGN")
        assert "other_line" not in result

    def test_transformer_feeder_labelled(self):
        result = build_feeder_labels(self._network(), "VL_PRAGN")
        assert result["trafo1"]["label"] == "TRAFOSUB 400kV"
        assert result["trafo1"]["other_vl"] == "VL_TRAFOEND"

    def test_empty_vl_id_returns_empty(self):
        assert build_feeder_labels(self._network(), "") == {}

    def test_pypowsybl_failure_degrades_to_empty(self):
        net = MagicMock()
        net.get_voltage_levels.side_effect = RuntimeError("boom")
        net.get_lines.side_effect = RuntimeError("boom")
        net.get_2_windings_transformers.side_effect = RuntimeError("boom")
        # Must not raise — relabelling is additive.
        assert build_feeder_labels(net, "VL_PRAGN") == {}
