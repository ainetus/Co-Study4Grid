# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0

"""Tests for interactive SLD topology edit → manual action simulation.

Covers the additive pieces wired in by this feature:
  - ``extract_vl_switch_states`` filters fictitious switches and skips
    cleanly on pypowsybl failure.
  - ``is_switch_only_content`` / ``build_switch_action_description``
    auto-naming contract.
  - End-to-end: an SLD endpoint payload exposes ``switch_states``, and
    ``simulate_manual_action`` accepts ``action_content={"switches":
    {...}}`` + ``voltage_level_id`` and stamps a human-readable
    description on the resulting action dict entry.
"""
from unittest.mock import MagicMock

import pandas as pd
import pytest

from expert_backend.services.diagram.sld_render import extract_vl_switch_states
from expert_backend.services.simulation_helpers import (
    build_switch_action_description,
    is_switch_only_content,
)


class TestExtractVlSwitchStates:
    def test_filters_to_voltage_level(self):
        network = MagicMock()
        network.get_switches.return_value = pd.DataFrame(
            {
                "open": [True, False, True],
                "voltage_level_id": ["VL_A", "VL_A", "VL_B"],
                "kind": ["BREAKER", "DISCONNECTOR", "BREAKER"],
                "fictitious": [False, False, False],
                "retained": [True, True, True],
            },
            index=["SW_1", "SW_2", "SW_3"],
        )
        states = extract_vl_switch_states(network, "VL_A")
        assert states == {"SW_1": True, "SW_2": False}

    def test_excludes_fictitious(self):
        network = MagicMock()
        network.get_switches.return_value = pd.DataFrame(
            {
                "open": [True, False],
                "voltage_level_id": ["VL_A", "VL_A"],
                "kind": ["BREAKER", "BREAKER"],
                "fictitious": [False, True],
                "retained": [True, True],
            },
            index=["SW_REAL", "SW_FAKE"],
        )
        states = extract_vl_switch_states(network, "VL_A")
        assert states == {"SW_REAL": True}

    def test_returns_empty_on_pypowsybl_failure(self):
        network = MagicMock()
        network.get_switches.side_effect = RuntimeError("boom")
        assert extract_vl_switch_states(network, "VL_A") == {}

    def test_falls_back_when_extended_attributes_unsupported(self):
        network = MagicMock()
        df = pd.DataFrame(
            {"open": [True], "voltage_level_id": ["VL_A"]}, index=["SW_X"]
        )
        # First call (with rich attributes) fails; second call succeeds.
        network.get_switches.side_effect = [TypeError("unknown attr"), df]
        states = extract_vl_switch_states(network, "VL_A")
        assert states == {"SW_X": True}


class TestIsSwitchOnlyContent:
    def test_true_for_pure_switches_dict(self):
        assert is_switch_only_content({"switches": {"SW_A": True}})

    def test_false_for_empty_switches(self):
        assert not is_switch_only_content({"switches": {}})

    def test_false_when_other_keys_present(self):
        assert not is_switch_only_content(
            {"switches": {"SW_A": True}, "set_bus": {"loads_id": {}}}
        )

    def test_false_for_none(self):
        assert not is_switch_only_content(None)


class TestBuildSwitchActionDescription:
    def test_with_vl(self):
        desc = build_switch_action_description(
            {"SW_A": True, "SW_B": False}, voltage_level_id="VL_PARIS"
        )
        assert "VL_PARIS" in desc
        assert "SW_A ouvert" in desc
        assert "SW_B fermé" in desc

    def test_without_vl(self):
        desc = build_switch_action_description({"SW_A": True})
        assert "SW_A ouvert" in desc
        assert ":" in desc

    def test_empty(self):
        assert "aucun" in build_switch_action_description({}).lower()


class TestSimulateManualActionSwitchOnly:
    """End-to-end: feed a switch-only action_content + voltage_level_id and
    check the dict entry receives the auto-built description.

    Bypasses the full simulate path (which needs a real recommender env)
    by exercising ``_inject_action_content_entries`` directly.
    """

    def test_injects_human_readable_description(self):
        from expert_backend.services.recommender_service import RecommenderService

        service = RecommenderService()
        service._dict_action = {}

        service._inject_action_content_entries(
            ["user_topo_VL_TEST_1"],
            {"switches": {"SW_A": True, "SW_B": False}},
            recent_actions={},
            voltage_level_id="VL_TEST",
        )

        entry = service._dict_action["user_topo_VL_TEST_1"]
        assert "VL_TEST" in entry["description_unitaire"]
        assert "SW_A ouvert" in entry["description_unitaire"]
        assert "SW_B fermé" in entry["description_unitaire"]
        # Content round-trips the switches dict for env.action_space(...)
        assert entry["content"]["switches"] == {"SW_A": True, "SW_B": False}

    def test_skips_when_vl_missing(self):
        from expert_backend.services.recommender_service import RecommenderService

        service = RecommenderService()
        service._dict_action = {}

        service._inject_action_content_entries(
            ["user_topo_x"],
            {"switches": {"SW_A": True}},
            recent_actions={},
            voltage_level_id=None,
        )
        # Description is built even without VL — just without VL prefix.
        desc = service._dict_action["user_topo_x"]["description_unitaire"]
        assert "SW_A ouvert" in desc


class TestSldEndpointSwitchStates:
    """get_*_sld endpoints expose switch_states alongside svg + metadata."""

    def test_get_n_sld_attaches_switch_states(self):
        from expert_backend.services.recommender_service import RecommenderService

        service = RecommenderService()

        mock_net = MagicMock()
        mock_net.get_working_variant_id.return_value = "InitialState"
        mock_net.get_switches.return_value = pd.DataFrame(
            {
                "open": [False],
                "voltage_level_id": ["VL_X"],
                "kind": ["BREAKER"],
                "fictitious": [False],
                "retained": [True],
            },
            index=["SW_X"],
        )
        mock_sld = MagicMock()
        mock_sld._repr_svg_.return_value = "<svg/>"
        mock_sld._metadata = "{}"
        mock_net.get_single_line_diagram.return_value = mock_sld

        service._get_base_network = lambda: mock_net
        service._get_n_variant = lambda: "InitialState"

        result = service.get_n_sld("VL_X")
        assert result["voltage_level_id"] == "VL_X"
        assert result["switch_states"] == {"SW_X": False}
