# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0
"""Unit tests for :class:`ToOpRecommender` (line-switching MVP).

These tests run without ToOp installed — they cover the optional-install
degradation path, the registry wiring, the result parser, and the
action-translation logic. End-to-end execution against the real ToOp
engine is a future integration-test concern (Python 3.11 + GPU env).
"""
from __future__ import annotations

from unittest.mock import MagicMock, patch

import pandas as pd
import pytest

from expert_backend.recommenders import toop as toop_module
from expert_backend.recommenders.registry import get_model_class, list_models
from expert_backend.recommenders.toop import (
    ToOpRecommender,
    _coerce_score,
    _iter_switches,
)


# ---------------------------------------------------------------------
# Registry wiring
# ---------------------------------------------------------------------
class TestRegistryWiring:
    def test_model_is_registered(self):
        """ToOp shows up in the registry after package import."""
        assert get_model_class("toop") is ToOpRecommender

    def test_listed_in_models_endpoint_payload(self):
        names = [m["name"] for m in list_models()]
        assert "toop" in names

    def test_does_not_require_overflow_graph(self):
        descriptor = next(m for m in list_models() if m["name"] == "toop")
        assert descriptor["requires_overflow_graph"] is False

    def test_params_spec_declares_runtime_and_count_knobs(self):
        descriptor = next(m for m in list_models() if m["name"] == "toop")
        param_names = {p["name"] for p in descriptor["params"]}
        assert {"n_prioritized_actions", "runtime_seconds", "n_worst_contingencies"} <= param_names


# ---------------------------------------------------------------------
# Optional-install degradation
# ---------------------------------------------------------------------
class TestOptionalInstall:
    def test_returns_empty_when_toop_not_installed(self, caplog):
        """No ToOp install → empty output + one info log, never a crash."""
        inputs = MagicMock()
        inputs.network = MagicMock()
        inputs.env = MagicMock()
        with patch.object(toop_module, "_import_run_pipeline", return_value=None):
            with caplog.at_level("INFO"):
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

    def test_xiidm_export_failure_yields_empty(self):
        inputs = MagicMock()
        inputs.network = MagicMock()
        # Make save() raise to simulate an unsupported network shape.
        inputs.network.save.side_effect = RuntimeError("XIIDM export unsupported")
        inputs.env = MagicMock()
        with patch.object(toop_module, "_import_run_pipeline", return_value=lambda **_: None), \
             patch.object(toop_module, "_import_dictconfig", return_value=dict):
            out = ToOpRecommender().recommend(inputs, {})
        assert out.prioritized_actions == {}


# ---------------------------------------------------------------------
# Result parsing — _extract_line_switches + helpers
# ---------------------------------------------------------------------
class TestResultParsing:
    def test_parses_list_of_dicts_with_line_switches(self):
        pareto = [
            {
                "overload_energy_n_1": 12.5,
                "line_switches": [{"line_id": "LINE_A", "status": -1}],
            },
            {
                "overload_energy_n_1": 5.0,
                "line_switches": [{"line_id": "LINE_B", "open": False}],
            },
        ]
        out = ToOpRecommender()._extract_line_switches(pareto, n=5)
        # Sorted by score ascending (lower = better congestion).
        assert out[0][0] == "LINE_B"
        assert out[0][1] == 1
        assert out[1][0] == "LINE_A"
        assert out[1][1] == -1

    def test_truncates_to_top_n(self):
        pareto = [
            {"overload_energy_n_1": float(i), "line_switches": [{"line_id": f"L{i}", "status": -1}]}
            for i in range(10)
        ]
        out = ToOpRecommender()._extract_line_switches(pareto, n=3)
        assert len(out) == 3
        assert [r[0] for r in out] == ["L0", "L1", "L2"]

    def test_dedupes_same_line_status_keeping_best_score(self):
        pareto = [
            {"score": 9.0, "line_switches": [{"line_id": "LINE_A", "status": -1}]},
            {"score": 2.0, "line_switches": [{"line_id": "LINE_A", "status": -1}]},
        ]
        out = ToOpRecommender()._extract_line_switches(pareto, n=5)
        assert len(out) == 1
        assert out[0] == ("LINE_A", -1, 2.0)

    def test_accepts_object_with_solutions_attribute(self):
        sol = MagicMock()
        sol.score = 1.0
        sol.line_switches = [{"line_id": "LINE_X", "status": 1}]
        container = MagicMock()
        container.solutions = [sol]
        out = ToOpRecommender()._extract_line_switches(container, n=5)
        assert out == [("LINE_X", 1, 1.0)]

    def test_unknown_shape_returns_empty_and_logs(self, caplog):
        with caplog.at_level("WARNING"):
            out = ToOpRecommender()._extract_line_switches(object(), n=5)
        assert out == []

    def test_none_returns_empty(self):
        assert ToOpRecommender()._extract_line_switches(None, n=5) == []

    def test_skips_entries_with_missing_line_id_or_status(self):
        pareto = [{
            "score": 1.0,
            "line_switches": [
                {"status": -1},          # missing line_id
                {"line_id": "LINE_Y"},   # missing status
                {"line_id": "LINE_Z", "status": 99},  # invalid status
                {"line_id": "LINE_OK", "status": -1},
            ],
        }]
        out = ToOpRecommender()._extract_line_switches(pareto, n=5)
        assert out == [("LINE_OK", -1, 1.0)]


class TestCoerceScore:
    def test_reads_overload_energy_n_1(self):
        assert _coerce_score({"overload_energy_n_1": 3.5}) == 3.5

    def test_falls_back_to_score_then_cost(self):
        assert _coerce_score({"score": 2.0}) == 2.0
        assert _coerce_score({"cost": 4.0}) == 4.0

    def test_returns_inf_when_nothing_recognised(self):
        assert _coerce_score({}) == float("inf")
        assert _coerce_score(object()) == float("inf")


class TestIterSwitches:
    def test_dict_with_branch_switches_alias(self):
        sol = {"branch_switches": [{"branch_id": "L1", "status": -1}]}
        assert list(_iter_switches(sol)) == [("L1", -1)]

    def test_tuple_form(self):
        sol = {"line_switches": [("L1", -1), ("L2", 1)]}
        assert list(_iter_switches(sol)) == [("L1", -1), ("L2", 1)]

    def test_empty_when_no_switches(self):
        assert list(_iter_switches({})) == []
        assert list(_iter_switches({"line_switches": []})) == []


# ---------------------------------------------------------------------
# Action materialisation
# ---------------------------------------------------------------------
class TestMaterialiseActions:
    @pytest.fixture
    def network_with_lines(self, mock_network):
        return mock_network

    def test_prefers_existing_disco_entry_from_dict_action(self, network_with_lines):
        env = MagicMock()
        env.action_space.side_effect = lambda content: ("ACTION", content)
        dict_action = {
            "disco_LINE_A": {
                "content": {"set_bus": {"lines_or_id": {"LINE_A": -1}, "lines_ex_id": {"LINE_A": -1}}},
                "description": "Open LINE_A",
            },
        }
        out, scores = ToOpRecommender()._materialise_actions(
            switches=[("LINE_A", -1, 5.0)],
            env=env,
            dict_action=dict_action,
            non_connected_reconnectable_lines=[],
            network=network_with_lines,
        )
        # Reused the operator's vocabulary instead of fabricating a toop_disco_*.
        assert "disco_LINE_A" in out
        assert "toop_disco_LINE_A" not in out
        assert scores["disco_LINE_A"] == -5.0

    def test_synthesises_toop_disco_when_dict_action_lacks_entry(self, network_with_lines):
        env = MagicMock()
        env.action_space.side_effect = lambda content: ("ACTION", content)
        out, scores = ToOpRecommender()._materialise_actions(
            switches=[("LINE_A", -1, 1.0)],
            env=env,
            dict_action={},
            non_connected_reconnectable_lines=[],
            network=network_with_lines,
        )
        assert "toop_disco_LINE_A" in out
        # Negated score = "higher is better" convention.
        assert scores["toop_disco_LINE_A"] == -1.0

    def test_reconnection_uses_toop_reco_prefix(self, network_with_lines):
        env = MagicMock()
        env.action_space.side_effect = lambda content: ("ACTION", content)
        out, _ = ToOpRecommender()._materialise_actions(
            switches=[("LINE_A", 1, 0.5)],
            env=env,
            dict_action={},
            non_connected_reconnectable_lines=["LINE_A"],
            network=network_with_lines,
        )
        assert "toop_reco_LINE_A" in out

    def test_drops_lines_not_on_loaded_network(self, network_with_lines):
        env = MagicMock()
        env.action_space.side_effect = lambda content: ("ACTION", content)
        out, scores = ToOpRecommender()._materialise_actions(
            switches=[("LINE_GHOST", -1, 1.0), ("LINE_A", -1, 2.0)],
            env=env,
            dict_action={},
            non_connected_reconnectable_lines=[],
            network=network_with_lines,
        )
        # LINE_GHOST isn't in the mock network's lines DataFrame.
        assert "toop_disco_LINE_GHOST" not in out
        assert "toop_disco_LINE_A" in out

    def test_skips_actions_env_rejects(self, network_with_lines):
        env = MagicMock()
        env.action_space.side_effect = RuntimeError("invalid action")
        out, _ = ToOpRecommender()._materialise_actions(
            switches=[("LINE_A", -1, 1.0)],
            env=env,
            dict_action={},
            non_connected_reconnectable_lines=[],
            network=network_with_lines,
        )
        assert out == {}


# ---------------------------------------------------------------------
# Light end-to-end with everything mocked — the happy path
# ---------------------------------------------------------------------
class TestRecommendHappyPath:
    def test_full_flow_with_mocked_toop(self, mock_network):
        fake_pareto = [
            {
                "overload_energy_n_1": 7.0,
                "line_switches": [{"line_id": "LINE_A", "status": -1}],
            },
        ]
        fake_run_pipeline = MagicMock(return_value=fake_pareto)

        inputs = MagicMock()
        inputs.network = mock_network
        inputs.env = MagicMock()
        inputs.env.action_space.side_effect = lambda content: ("ACTION", content)
        inputs.dict_action = {}
        inputs.non_connected_reconnectable_lines = []

        # Bypass real XIIDM export AND the ToOp config-building (PipelineConfig /
        # prepare_importer_parameters / etc. only exist when ToOp is installed).
        fake_grid_file = MagicMock()
        with patch.object(toop_module, "_import_run_pipeline", return_value=fake_run_pipeline), \
             patch.object(toop_module, "_import_dictconfig", return_value=dict), \
             patch.object(ToOpRecommender, "_export_network", return_value=fake_grid_file), \
             patch.object(ToOpRecommender, "_run_toop", return_value=fake_pareto):
            out = ToOpRecommender().recommend(inputs, {"n_prioritized_actions": 3})

        assert "toop_disco_LINE_A" in out.prioritized_actions
        assert out.action_scores["toop_disco_LINE_A"] == -7.0
        fake_run_pipeline.assert_called_once()
