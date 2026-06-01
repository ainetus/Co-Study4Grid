# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0
"""Unit tests for :class:`ToOpRecommender` (per-topology combined actions).

These tests run without ToOp installed — they cover the optional-install
degradation path, the registry wiring, the per-VL/per-line topology diff,
and the merge into a single combined action content. End-to-end execution
against the real ToOp engine is a separate integration concern (Python
3.11 + GPU env).
"""
from __future__ import annotations

from unittest.mock import MagicMock, patch

import pandas as pd

from expert_backend.recommenders import toop as toop_module
from expert_backend.recommenders.registry import get_model_class, list_models
from expert_backend.recommenders.toop import ToOpRecommender, _is_line_open


# ---------------------------------------------------------------------
# Registry wiring
# ---------------------------------------------------------------------
class TestRegistryWiring:
    def test_model_is_registered(self):
        assert get_model_class("toop") is ToOpRecommender

    def test_listed_in_models_endpoint_payload(self):
        names = [m["name"] for m in list_models()]
        assert "toop" in names

    def test_label_and_overflow_flag(self):
        descriptor = next(m for m in list_models() if m["name"] == "toop")
        assert descriptor["label"] == "ToOp (Elia Group)"
        assert descriptor["requires_overflow_graph"] is False

    def test_params_spec_declares_expected_knobs(self):
        descriptor = next(m for m in list_models() if m["name"] == "toop")
        names = {p["name"] for p in descriptor["params"]}
        assert {
            "n_prioritized_actions",
            "include_busbar_splits",
            "runtime_seconds",
            "n_worst_contingencies",
        } <= names


# ---------------------------------------------------------------------
# Optional-install degradation
# ---------------------------------------------------------------------
class TestOptionalInstall:
    def test_returns_empty_when_toop_not_installed(self):
        inputs = MagicMock()
        inputs.network = MagicMock()
        inputs.env = MagicMock()
        with patch.object(toop_module, "_import_run_pipeline", return_value=None):
            out = ToOpRecommender().recommend(inputs, {"n_prioritized_actions": 5})
        assert out.prioritized_actions == {}
        assert out.action_scores == {}

    def test_returns_empty_when_omegaconf_not_installed(self):
        inputs = MagicMock()
        inputs.network = MagicMock()
        inputs.env = MagicMock()
        with patch.object(toop_module, "_import_run_pipeline", return_value=lambda **_: None), \
             patch.object(toop_module, "_import_dictconfig", return_value=None):
            out = ToOpRecommender().recommend(inputs, {})
        assert out.prioritized_actions == {}

    def test_returns_empty_when_env_missing(self):
        inputs = MagicMock()
        inputs.network = MagicMock()
        inputs.env = None
        with patch.object(toop_module, "_import_run_pipeline", return_value=lambda **_: None), \
             patch.object(toop_module, "_import_dictconfig", return_value=dict):
            out = ToOpRecommender().recommend(inputs, {})
        assert out.prioritized_actions == {}

    def test_clears_stale_topology_groups_on_degraded_return(self):
        rec = ToOpRecommender()
        rec._last_topology_groups = [{"topology_id": "stale"}]
        inputs = MagicMock()
        inputs.network = MagicMock()
        inputs.env = MagicMock()
        with patch.object(toop_module, "_import_run_pipeline", return_value=None):
            rec.recommend(inputs, {})
        assert rec._last_topology_groups == []


# ---------------------------------------------------------------------
# _is_line_open helper
# ---------------------------------------------------------------------
class TestIsLineOpen:
    def test_both_terminals_connected_is_closed(self):
        df = pd.DataFrame({"connected1": [True], "connected2": [True]}, index=["L"])
        assert _is_line_open(df, "L") is False

    def test_either_terminal_disconnected_is_open(self):
        df = pd.DataFrame(
            {"connected1": [True, False], "connected2": [False, True]},
            index=["L1", "L2"],
        )
        assert _is_line_open(df, "L1") is True
        assert _is_line_open(df, "L2") is True

    def test_missing_line_id_is_closed(self):
        df = pd.DataFrame({"connected1": [True], "connected2": [True]}, index=["L"])
        assert _is_line_open(df, "GHOST") is False

    def test_missing_columns_defaults_closed(self):
        df = pd.DataFrame({"other": [1]}, index=["L"])
        assert _is_line_open(df, "L") is False


# ---------------------------------------------------------------------
# _merge_topology_content
# ---------------------------------------------------------------------
class TestMergeTopologyContent:
    @staticmethod
    def _enrich_ok(raw, _network):
        """Fake enrich_actions_lazy that resolves each VL entry to a content."""
        out = {}
        for aid, entry in raw.items():
            e = dict(entry)
            vl = entry["VoltageLevelId"]
            e["content"] = {
                "set_bus": {
                    "lines_or_id": {f"{vl}_LINE": 2},
                    "lines_ex_id": {},
                    "loads_id": {f"{vl}_LOAD": 1},
                    "generators_id": {},
                    "shunts_id": {},
                },
                "switches": entry["switches"],
            }
            out[aid] = e
        return out

    def test_merges_line_toggles_only(self):
        merged, constituents = ToOpRecommender()._merge_topology_content(
            line_toggles={"LINE_A": -1, "LINE_B": 1},
            vl_switches={},
            enrich=None,
            network=MagicMock(),
        )
        assert merged["set_bus"]["lines_or_id"] == {"LINE_A": -1, "LINE_B": 1}
        assert merged["set_bus"]["lines_ex_id"] == {"LINE_A": -1, "LINE_B": 1}
        assert "open LINE_A" in constituents
        assert "close LINE_B" in constituents

    def test_merges_vl_splits_via_enrich(self):
        merged, constituents = ToOpRecommender()._merge_topology_content(
            line_toggles={},
            vl_switches={"VL_A": {"VL_A_sw1": True}, "VL_B": {"VL_B_sw2": False}},
            enrich=self._enrich_ok,
            network=MagicMock(),
        )
        # set_bus from both VLs is unioned.
        assert merged["set_bus"]["lines_or_id"] == {"VL_A_LINE": 2, "VL_B_LINE": 2}
        assert merged["set_bus"]["loads_id"] == {"VL_A_LOAD": 1, "VL_B_LOAD": 1}
        # switches from both VLs are unioned.
        assert merged["switches"] == {"VL_A_sw1": True, "VL_B_sw2": False}
        assert set(constituents) == {"split VL_A", "split VL_B"}

    def test_line_toggle_wins_over_split_for_same_branch(self):
        def enrich_sets_line(raw, _network):
            out = {}
            for aid, entry in raw.items():
                e = dict(entry)
                e["content"] = {
                    "set_bus": {
                        "lines_or_id": {"SHARED_LINE": 2},  # split would set bus 2
                        "lines_ex_id": {}, "loads_id": {},
                        "generators_id": {}, "shunts_id": {},
                    },
                    "switches": entry["switches"],
                }
                out[aid] = e
            return out

        merged, _ = ToOpRecommender()._merge_topology_content(
            line_toggles={"SHARED_LINE": -1},  # explicit open
            vl_switches={"VL_A": {"VL_A_sw1": True}},
            enrich=enrich_sets_line,
            network=MagicMock(),
        )
        # Line toggle applied last → -1 overrides the split's bus 2.
        assert merged["set_bus"]["lines_or_id"]["SHARED_LINE"] == -1

    def test_returns_none_when_nothing_simulable(self):
        # enrich fails for the only VL and there are no line toggles.
        def enrich_empty(raw, _network):
            return {aid: {**e, "content": None} for aid, e in raw.items()}

        merged, constituents = ToOpRecommender()._merge_topology_content(
            line_toggles={},
            vl_switches={"VL_A": {"VL_A_sw1": True}},
            enrich=enrich_empty,
            network=MagicMock(),
        )
        assert merged is None
        assert constituents == []

    def test_enrich_unavailable_keeps_line_toggles(self):
        merged, constituents = ToOpRecommender()._merge_topology_content(
            line_toggles={"LINE_A": -1},
            vl_switches={"VL_A": {"VL_A_sw1": True}},  # dropped (no enrich)
            enrich=None,
            network=MagicMock(),
        )
        assert merged["set_bus"]["lines_or_id"] == {"LINE_A": -1}
        assert constituents == ["open LINE_A"]


# ---------------------------------------------------------------------
# _build_topology_actions (uses the conftest pypowsybl mock)
# ---------------------------------------------------------------------
class TestBuildTopologyActions:
    def _mock_pn_load(self, orig_lines, orig_switches, mod_map):
        """Return a fake pypowsybl.network.load resolving paths to networks.

        mod_map: {substring_in_path: (lines_df, switches_df)}.
        """
        def load(path):
            net = MagicMock()
            for needle, (lines, switches) in mod_map.items():
                if needle in str(path):
                    net.get_lines.return_value = lines
                    net.get_switches.return_value = switches
                    return net
            net.get_lines.return_value = orig_lines
            net.get_switches.return_value = orig_switches
            return net
        return load

    def test_one_action_per_topology_with_line_toggle(self, tmp_path):
        import pypowsybl.network as pn_mod

        orig_lines = pd.DataFrame(
            {"connected1": [True, True], "connected2": [True, True]},
            index=["LINE_A", "LINE_B"],
        )
        orig_switches = pd.DataFrame(
            {"open": [False], "voltage_level_id": ["VL_A"]}, index=["sw1"],
        )
        # topology_1 opens LINE_A.
        mod_lines = pd.DataFrame(
            {"connected1": [False, True], "connected2": [True, True]},
            index=["LINE_A", "LINE_B"],
        )
        topo1 = tmp_path / "topology_1"
        topo1.mkdir()
        (topo1 / "modified_network.xiidm").write_text("")

        env = MagicMock()
        env.action_space.side_effect = lambda c: ("ACTION", c)
        loader = self._mock_pn_load(
            orig_lines, orig_switches, {"topology_1": (mod_lines, orig_switches)},
        )
        with patch.object(pn_mod, "load", loader):
            prioritized, scores, groups, entries = ToOpRecommender()._build_topology_actions(
                topology_paths=[topo1],
                original_grid_file=tmp_path / "grid.xiidm",
                env=env,
                network=MagicMock(),
                include_busbar_splits=True,
                n=5,
            )
        assert list(prioritized.keys()) == ["toop_topology_1"]
        assert scores["toop_topology_1"] == 0.0
        assert groups[0]["constituents"] == ["open LINE_A"]
        assert groups[0]["line_count"] == 1
        # dict_entry content carries the line toggle for re-simulation.
        content = entries["toop_topology_1"]["content"]
        assert content["set_bus"]["lines_or_id"] == {"LINE_A": -1}

    def test_skips_topology_with_no_diff(self, tmp_path):
        import pypowsybl.network as pn_mod

        orig_lines = pd.DataFrame(
            {"connected1": [True], "connected2": [True]}, index=["LINE_A"],
        )
        orig_switches = pd.DataFrame(
            {"open": [False], "voltage_level_id": ["VL_A"]}, index=["sw1"],
        )
        topo = tmp_path / "topology_1"
        topo.mkdir()
        (topo / "modified_network.xiidm").write_text("")

        env = MagicMock()
        env.action_space.side_effect = lambda c: ("ACTION", c)
        # modified == original → no diff.
        loader = self._mock_pn_load(
            orig_lines, orig_switches, {"topology_1": (orig_lines, orig_switches)},
        )
        with patch.object(pn_mod, "load", loader):
            prioritized, _, groups, _ = ToOpRecommender()._build_topology_actions(
                topology_paths=[topo],
                original_grid_file=tmp_path / "grid.xiidm",
                env=env, network=MagicMock(),
                include_busbar_splits=True, n=5,
            )
        assert prioritized == {}
        assert groups == []

    def test_caps_at_n_topologies(self, tmp_path):
        import pypowsybl.network as pn_mod

        orig_lines = pd.DataFrame(
            {"connected1": [True], "connected2": [True]}, index=["LINE_A"],
        )
        orig_switches = pd.DataFrame(
            {"open": [False], "voltage_level_id": ["VL_A"]}, index=["sw1"],
        )
        mod_lines = pd.DataFrame(
            {"connected1": [False], "connected2": [True]}, index=["LINE_A"],
        )
        topos = []
        for i in range(4):
            d = tmp_path / f"topology_{i}"
            d.mkdir()
            (d / "modified_network.xiidm").write_text("")
            topos.append(d)

        env = MagicMock()
        env.action_space.side_effect = lambda c: ("ACTION", c)
        # Every topology opens LINE_A.
        loader = self._mock_pn_load(
            orig_lines, orig_switches, {"topology_": (mod_lines, orig_switches)},
        )
        with patch.object(pn_mod, "load", loader):
            prioritized, _, _, _ = ToOpRecommender()._build_topology_actions(
                topology_paths=topos,
                original_grid_file=tmp_path / "grid.xiidm",
                env=env, network=MagicMock(),
                include_busbar_splits=True, n=2,
            )
        assert len(prioritized) == 2

    def test_action_space_rejection_skips_topology(self, tmp_path):
        import pypowsybl.network as pn_mod

        orig_lines = pd.DataFrame(
            {"connected1": [True], "connected2": [True]}, index=["LINE_A"],
        )
        orig_switches = pd.DataFrame(
            {"open": [False], "voltage_level_id": ["VL_A"]}, index=["sw1"],
        )
        mod_lines = pd.DataFrame(
            {"connected1": [False], "connected2": [True]}, index=["LINE_A"],
        )
        topo = tmp_path / "topology_1"
        topo.mkdir()
        (topo / "modified_network.xiidm").write_text("")

        env = MagicMock()
        env.action_space.side_effect = RuntimeError("backend rejected")
        loader = self._mock_pn_load(
            orig_lines, orig_switches, {"topology_1": (mod_lines, orig_switches)},
        )
        with patch.object(pn_mod, "load", loader):
            prioritized, _, groups, _ = ToOpRecommender()._build_topology_actions(
                topology_paths=[topo],
                original_grid_file=tmp_path / "grid.xiidm",
                env=env, network=MagicMock(),
                include_busbar_splits=True, n=5,
            )
        assert prioritized == {}
        assert groups == []
