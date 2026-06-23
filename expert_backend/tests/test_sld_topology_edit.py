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
  - ``get_topology_preview_sld`` clones a throwaway variant, applies
    user switch overrides, renders with topological colouring + flags
    flows as stale, and always restores the working variant.
  - ``_require_action`` resolves combined-action ids regardless of "+"
    ordering by aliasing the raw key onto the canonical entry.
  - HTTP boundary: ``/api/sld-topology-preview`` plumbing.
"""
from unittest.mock import MagicMock, patch

import pandas as pd
import pytest
from fastapi.testclient import TestClient

from expert_backend.services.diagram.sld_render import (
    extract_vl_injections,
    extract_vl_switch_states,
)
from expert_backend.services.simulation_helpers import (
    build_manual_action_description,
    build_switch_action_description,
    canonicalize_action_id,
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


class TestExtractVlInjections:
    """``extract_vl_injections`` is the load / generator analogue of
    ``extract_vl_switch_states``: it lists the editable active-power
    injections on a VL with their current setpoint + (for generators)
    capability bounds + energy source."""

    def _network(self):
        network = MagicMock()
        network.get_generators.return_value = pd.DataFrame(
            {
                "voltage_level_id": ["VL_A", "VL_B"],
                "target_p": [120.0, 50.0],
                "min_p": [0.0, 10.0],
                "max_p": [200.0, 80.0],
                "energy_source": ["WIND", "NUCLEAR"],
            },
            index=["GEN_A", "GEN_B"],
        )
        network.get_loads.return_value = pd.DataFrame(
            {"voltage_level_id": ["VL_A", "VL_C"], "p0": [42.5, 10.0]},
            index=["LOAD_A", "LOAD_C"],
        )
        return network

    def test_collects_generators_and_loads_for_vl(self):
        inj = extract_vl_injections(self._network(), "VL_A")
        assert set(inj.keys()) == {"GEN_A", "LOAD_A"}
        assert inj["GEN_A"] == {
            "kind": "generator", "p": 120.0,
            "min_p": 0.0, "max_p": 200.0, "energy_source": "WIND",
        }
        assert inj["LOAD_A"] == {"kind": "load", "p": 42.5}

    def test_filters_out_other_voltage_levels(self):
        inj = extract_vl_injections(self._network(), "VL_B")
        assert set(inj.keys()) == {"GEN_B"}

    def test_returns_empty_on_pypowsybl_failure(self):
        network = MagicMock()
        network.get_generators.side_effect = RuntimeError("boom")
        network.get_loads.side_effect = RuntimeError("boom")
        assert extract_vl_injections(network, "VL_A") == {}

    def test_coerces_non_finite_setpoints_to_none(self):
        network = MagicMock()
        network.get_generators.return_value = pd.DataFrame(
            {
                "voltage_level_id": ["VL_A"],
                "target_p": [float("nan")],
                "min_p": [float("-inf")],
                "max_p": [float("inf")],
                "energy_source": ["SOLAR"],
            },
            index=["GEN_NAN"],
        )
        network.get_loads.return_value = pd.DataFrame(
            {"voltage_level_id": ["VL_OTHER"], "p0": [1.0]}, index=["LOAD_OTHER"]
        )
        inj = extract_vl_injections(network, "VL_A")
        assert inj["GEN_NAN"]["p"] is None
        assert inj["GEN_NAN"]["min_p"] is None
        assert inj["GEN_NAN"]["max_p"] is None

    def test_falls_back_when_attributes_unsupported(self):
        network = MagicMock()
        df_gen = pd.DataFrame(
            {
                "voltage_level_id": ["VL_A"], "target_p": [12.0],
                "min_p": [0.0], "max_p": [20.0], "energy_source": ["HYDRO"],
            },
            index=["GEN_X"],
        )
        # First call (rich attributes) raises; fallback get_generators() works.
        network.get_generators.side_effect = [TypeError("no attrs"), df_gen]
        network.get_loads.return_value = pd.DataFrame(
            {"voltage_level_id": ["VL_A"], "p0": [5.0]}, index=["LOAD_X"]
        )
        inj = extract_vl_injections(network, "VL_A")
        assert inj["GEN_X"]["energy_source"] == "HYDRO"
        assert inj["LOAD_X"] == {"kind": "load", "p": 5.0}

    def test_handles_missing_bounds_and_source_columns(self):
        network = MagicMock()
        network.get_generators.side_effect = [
            TypeError("no attrs"),
            pd.DataFrame(
                {"voltage_level_id": ["VL_A"], "target_p": [7.0]}, index=["GEN_BARE"]
            ),
        ]
        network.get_loads.return_value = pd.DataFrame(
            {"voltage_level_id": ["VL_A"], "p0": [3.0]}, index=["LOAD_A"]
        )
        inj = extract_vl_injections(network, "VL_A")
        assert inj["GEN_BARE"] == {"kind": "generator", "p": 7.0}


class TestBuildManualActionDescription:
    """``build_manual_action_description`` generalises the switch-only
    description to combined switch + injection user-built actions, while
    keeping the switch-only output byte-identical."""

    def test_switch_only_matches_switch_builder(self):
        content = {"switches": {"SW_A": True, "SW_B": False}}
        assert build_manual_action_description(content, "VL_X") == \
            build_switch_action_description({"SW_A": True, "SW_B": False}, "VL_X")

    def test_includes_injection_setpoints(self):
        content = {"set_gen_p": {"GEN_A": 90.0}, "set_load_p": {"LOAD_A": 30.0}}
        desc = build_manual_action_description(content, "VL_X")
        assert "VL_X" in desc
        assert "GEN_A P=90.0 MW" in desc
        assert "LOAD_A P=30.0 MW" in desc

    def test_combines_switch_and_injection(self):
        content = {"switches": {"SW_A": True}, "set_gen_p": {"GEN_A": 12.5}}
        desc = build_manual_action_description(content)
        assert "SW_A ouvert" in desc
        assert "GEN_A P=12.5 MW" in desc

    def test_empty_content(self):
        assert "vide" in build_manual_action_description({}).lower()


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


class TestSimulateManualActionInjectionEdit:
    """A user-built SLD edit can stage active-power retunes (loads / gens)
    alongside switch toggles; ``_inject_action_content_entries`` must build
    the combined ``set_gen_p`` / ``set_load_p`` content AND a human-readable
    description covering both."""

    def test_injects_injection_content_and_description(self):
        from expert_backend.services.recommender_service import RecommenderService

        service = RecommenderService()
        service._dict_action = {}

        service._inject_action_content_entries(
            ["user_topo_VL_X_9"],
            {"gens_p": {"GEN_A": 90.0}, "loads_p": {"LOAD_A": 30.0},
             "switches": {"SW_A": True}},
            recent_actions={},
            voltage_level_id="VL_X",
        )

        entry = service._dict_action["user_topo_VL_X_9"]
        desc = entry["description_unitaire"]
        assert "VL_X" in desc
        assert "GEN_A P=90.0 MW" in desc
        assert "LOAD_A P=30.0 MW" in desc
        assert "SW_A ouvert" in desc
        # Topology dict round-trips into env-parseable set_gen_p / set_load_p.
        assert entry["content"]["set_gen_p"] == {"GEN_A": 90.0}
        assert entry["content"]["set_load_p"] == {"LOAD_A": 30.0}
        assert entry["content"]["switches"] == {"SW_A": True}

    def test_combined_action_topology_reports_both_feeders(self):
        # End-to-end on the backend side of the combined-injection highlight:
        # _inject_action_content_entries builds the dict content, and
        # extract_action_topology must then report BOTH the generator and the
        # load (back-filled from the content) so the SLD highlights both — even
        # though the grid2op action object exposes neither.
        from expert_backend.services.recommender_service import RecommenderService
        from expert_backend.services.simulation_helpers import extract_action_topology

        service = RecommenderService()
        service._dict_action = {}
        service._inject_action_content_entries(
            ["user_topo_VL_X_2"],
            {"gens_p": {"GEN_A": 24.0}, "loads_p": {"LOAD_A": 3.0}},
            recent_actions={},
            voltage_level_id="VL_X",
        )

        action = MagicMock()
        for f in ("lines_ex_bus", "lines_or_bus", "gens_bus", "loads_bus",
                  "pst_tap", "substations", "switches", "loads_p", "gens_p"):
            setattr(action, f, None)
        topo = extract_action_topology(action, "user_topo_VL_X_2", service._dict_action)
        assert topo["gens_p"] == {"GEN_A": 24.0}
        assert topo["loads_p"] == {"LOAD_A": 3.0}


class TestTopologyPreviewSld:
    """get_topology_preview_sld clones a throwaway variant, applies the
    switch overrides, renders with topological colouring, and always
    removes the temp variant + restores the working variant."""

    def _service_with_net(self):
        from expert_backend.services.recommender_service import RecommenderService

        service = RecommenderService()
        mock_net = MagicMock()
        mock_net.get_working_variant_id.return_value = "ContingencyVar"
        mock_net.get_switches.return_value = pd.DataFrame(
            {
                "open": [True],
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
        service._get_contingency_variant = lambda norm: "ContingencyVar"
        service._normalize_contingency_elements = staticmethod(lambda e: list(e))
        return service, mock_net

    def test_applies_switches_and_marks_stale(self):
        service, mock_net = self._service_with_net()
        result = service.get_topology_preview_sld(
            ["LINE_1"], "VL_X", {"SW_X": False},
        )
        assert result["stale_flows"] is True
        assert result["voltage_level_id"] == "VL_X"
        # update_switches called with the override
        mock_net.update_switches.assert_called_once()
        _, kwargs = mock_net.update_switches.call_args
        assert kwargs["id"] == ["SW_X"]
        assert kwargs["open"] == [False]

    def test_clones_and_removes_temp_variant(self):
        service, mock_net = self._service_with_net()
        service.get_topology_preview_sld(["LINE_1"], "VL_X", {"SW_X": False})
        mock_net.clone_variant.assert_called_once()
        clone_args = mock_net.clone_variant.call_args[0]
        assert clone_args[0] == "ContingencyVar"
        preview_variant = clone_args[1]
        mock_net.remove_variant.assert_called_once_with(preview_variant)
        # Working variant restored to the original.
        assert mock_net.set_working_variant.call_args_list[-1][0][0] == "ContingencyVar"

    def test_removes_temp_variant_even_on_render_failure(self):
        service, mock_net = self._service_with_net()
        mock_net.get_single_line_diagram.side_effect = RuntimeError("render boom")
        with pytest.raises(RuntimeError):
            service.get_topology_preview_sld(["LINE_1"], "VL_X", {"SW_X": False})
        mock_net.remove_variant.assert_called_once()
        assert mock_net.set_working_variant.call_args_list[-1][0][0] == "ContingencyVar"


class TestRequireActionCanonicalAlias:
    """A combined action is registered under a CANONICAL (sorted) key;
    ``_require_action`` must still resolve it when looked up with the
    raw, unsorted ordering the frontend sends."""

    def test_resolves_raw_unsorted_combined_id(self):
        from expert_backend.services.recommender_service import RecommenderService

        service = RecommenderService()
        # Registered under the canonical (alphabetically sorted) key.
        service._last_result = {
            "prioritized_actions": {
                "user_topo_BEON+user_topo_COUCHP6": {"observation": object()},
            }
        }
        # Looked up with the raw order (base + new) as minted by the UI.
        actions = service._require_action("user_topo_COUCHP6+user_topo_BEON")
        assert "user_topo_COUCHP6+user_topo_BEON" in actions

    def test_still_raises_when_truly_absent(self):
        from expert_backend.services.recommender_service import RecommenderService
        from expert_backend.services.diagram_mixin import ActionResultUnavailableError

        service = RecommenderService()
        service._last_result = {"prioritized_actions": {"some_action": {}}}
        with pytest.raises(ActionResultUnavailableError):
            service._require_action("nonexistent+other")


class TestSldEndpointSwitchStates:
    """get_*_sld endpoints expose switch_states + injections alongside
    svg + metadata."""

    def test_get_n_sld_attaches_switch_states_and_injections(self):
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
        mock_net.get_generators.return_value = pd.DataFrame(
            {
                "voltage_level_id": ["VL_X"], "target_p": [80.0],
                "min_p": [0.0], "max_p": [150.0], "energy_source": ["WIND"],
            },
            index=["GEN_X"],
        )
        mock_net.get_loads.return_value = pd.DataFrame(
            {"voltage_level_id": ["VL_X"], "p0": [25.0]}, index=["LOAD_X"]
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
        assert result["injections"]["GEN_X"]["kind"] == "generator"
        assert result["injections"]["GEN_X"]["max_p"] == 150.0
        assert result["injections"]["LOAD_X"] == {"kind": "load", "p": 25.0}


class TestExtractVlSwitchStatesEdgeCases:
    """Additional defensive paths."""

    def test_skips_rows_with_unreadable_open_value(self):
        # A row where `bool(row["open"])` raises must not abort the
        # whole VL extraction — it's a corrupt-input recovery path,
        # critical when partial pypowsybl exports leak NaNs / None.
        network = MagicMock()

        class _Boom:
            def __bool__(self):
                raise ValueError("not a bool")

        network.get_switches.return_value = pd.DataFrame(
            {
                "open": [True, _Boom(), False],
                "voltage_level_id": ["VL_A", "VL_A", "VL_A"],
                "kind": ["BREAKER", "BREAKER", "DISCONNECTOR"],
                "fictitious": [False, False, False],
                "retained": [True, True, True],
            },
            index=["SW_OK", "SW_BAD", "SW_OK2"],
        )
        states = extract_vl_switch_states(network, "VL_A")
        assert states == {"SW_OK": True, "SW_OK2": False}

    def test_no_match_on_voltage_level_returns_empty(self):
        network = MagicMock()
        network.get_switches.return_value = pd.DataFrame(
            {"open": [False], "voltage_level_id": ["VL_OTHER"],
             "kind": ["BREAKER"], "fictitious": [False], "retained": [True]},
            index=["SW_OTHER"],
        )
        assert extract_vl_switch_states(network, "VL_MISSING") == {}

    def test_handles_missing_fictitious_column(self):
        # ``fictitious`` may be absent on legacy pypowsybl builds — the
        # extractor must still return states (no row filtering).
        network = MagicMock()
        network.get_switches.return_value = pd.DataFrame(
            {"open": [False, True], "voltage_level_id": ["VL_A", "VL_A"]},
            index=["SW_1", "SW_2"],
        )
        # Force the extractor onto the fallback get_switches call.
        network.get_switches.side_effect = [
            TypeError("unsupported"),
            pd.DataFrame(
                {"open": [False, True], "voltage_level_id": ["VL_A", "VL_A"]},
                index=["SW_1", "SW_2"],
            ),
        ]
        assert extract_vl_switch_states(network, "VL_A") == {
            "SW_1": False, "SW_2": True,
        }


class TestBuildSwitchActionDescriptionShape:
    """Description format is the contract the frontend filter relies on
    (`coupl` + ouvert/fermé → open/close, line + ouvert/fermé → disco/
    reco — see ``actionTypes.test.ts``)."""

    def test_segments_join_with_comma(self):
        desc = build_switch_action_description(
            {"SW_A": True, "SW_B": False, "SW_C": True},
            voltage_level_id="VL_X",
        )
        assert desc.count(",") == 2  # 3 switches → 2 separators

    def test_starts_with_french_label(self):
        desc = build_switch_action_description({"SW_A": True})
        assert desc.lower().startswith("manoeuvre manuelle")


class TestCanonicalAliasSymmetry:
    """``_require_action`` must resolve a combined id whatever its
    "+"-component ordering: A+B and B+A both alias onto the canonical
    sorted entry."""

    def _service_with(self, registered_id, extra=None):
        from expert_backend.services.recommender_service import RecommenderService

        service = RecommenderService()
        service._last_result = {
            "prioritized_actions": {registered_id: {"observation": object()}}
        }
        if extra:
            service._last_result["prioritized_actions"].update(extra)
        return service

    def test_resolves_either_order_for_two_part_id(self):
        service = self._service_with("user_topo_A+user_topo_B")
        # Both orderings must land on the same entry.
        actions = service._require_action("user_topo_B+user_topo_A")
        assert "user_topo_B+user_topo_A" in actions
        assert actions["user_topo_B+user_topo_A"] is actions["user_topo_A+user_topo_B"]

    def test_canonicalize_is_idempotent(self):
        # Sanity: applying canonicalize twice doesn't shuffle further.
        once = canonicalize_action_id("user_topo_Z+user_topo_A+user_topo_M")
        twice = canonicalize_action_id(once)
        assert once == twice
        # Canonical key is alphabetically sorted.
        assert once == "user_topo_A+user_topo_M+user_topo_Z"

    def test_singleton_ids_pass_through_unchanged(self):
        assert canonicalize_action_id("disco_LINE_A") == "disco_LINE_A"


class TestTopologyPreviewEmptyAndPostAction:
    """Additional ``get_topology_preview_sld`` paths the earlier tests
    don't exercise: empty switches dict (no update_switches call) and
    the post-action branch (``base_action_id`` provided → reads from
    the action's network manager, not the contingency variant)."""

    def _mock_net_with_sld(self):
        mock_net = MagicMock()
        mock_net.get_working_variant_id.return_value = "ContingencyVar"
        mock_net.get_switches.return_value = pd.DataFrame(
            {"open": [True], "voltage_level_id": ["VL_X"],
             "kind": ["BREAKER"], "fictitious": [False], "retained": [True]},
            index=["SW_X"],
        )
        mock_sld = MagicMock()
        mock_sld._repr_svg_.return_value = "<svg/>"
        mock_sld._metadata = "{}"
        mock_net.get_single_line_diagram.return_value = mock_sld
        return mock_net

    def test_empty_switches_skips_update_call(self):
        from expert_backend.services.recommender_service import RecommenderService

        service = RecommenderService()
        net = self._mock_net_with_sld()
        service._get_base_network = lambda: net
        service._get_contingency_variant = lambda norm: "ContingencyVar"
        service._normalize_contingency_elements = staticmethod(lambda e: list(e))

        result = service.get_topology_preview_sld(["LINE_1"], "VL_X", {})
        assert result["stale_flows"] is True
        net.update_switches.assert_not_called()
        # Clone + remove still happen so the working variant is restored.
        net.clone_variant.assert_called_once()
        net.remove_variant.assert_called_once()

    def test_post_action_path_uses_action_network_manager(self):
        from expert_backend.services.recommender_service import RecommenderService

        service = RecommenderService()
        # Action observation owns its OWN network_manager (which owns
        # its OWN network) — the preview must operate on THIS network,
        # not the base contingency one. Mirrors get_action_variant_sld.
        action_net = self._mock_net_with_sld()
        nm = MagicMock()
        nm.network = action_net
        obs = MagicMock()
        obs._network_manager = nm
        obs._variant_id = "ActionVariant"

        service._last_result = {
            "prioritized_actions": {"act_42": {"observation": obs}}
        }
        service._normalize_contingency_elements = staticmethod(lambda e: list(e))

        result = service.get_topology_preview_sld(
            ["LINE_1"], "VL_X", {"SW_X": False}, base_action_id="act_42",
        )
        assert result["voltage_level_id"] == "VL_X"
        # Cloned from the action variant, not the base contingency.
        action_net.clone_variant.assert_called_once()
        assert action_net.clone_variant.call_args[0][0] == "ActionVariant"
        action_net.update_switches.assert_called_once()


class TestSldTopologyPreviewEndpoint:
    """HTTP-boundary coverage for /api/sld-topology-preview: payload
    shape, success path, and error→400 translation.

    Importing ``expert_backend.main`` pulls in
    ``expert_op4grid_recommender.models.expert`` (via
    ``expert_backend.recommenders``). Sandboxes that mock
    ``expert_op4grid_recommender`` as a plain MagicMock cannot resolve
    the submodule lookup, so we skip this whole class when the import
    isn't satisfiable. CI installs the real package and runs it.
    """

    @pytest.fixture
    def client_and_service(self):
        pytest.importorskip("expert_op4grid_recommender.models.expert")
        from expert_backend.main import app
        with patch("expert_backend.main.recommender_service") as mock_rs:
            yield TestClient(app), mock_rs

    def test_routes_to_service_and_returns_payload(self, client_and_service):
        client, mock_rs = client_and_service
        mock_rs.get_topology_preview_sld.return_value = {
            "svg": "<svg/>",
            "sld_metadata": "{}",
            "voltage_level_id": "VL_X",
            "switch_states": {"SW_X": False},
            "stale_flows": True,
        }
        body = {
            "voltage_level_id": "VL_X",
            "disconnected_elements": ["LINE_1"],
            "switches": {"SW_X": False},
            "base_action_id": None,
        }
        r = client.post("/api/sld-topology-preview", json=body)
        assert r.status_code == 200
        data = r.json()
        assert data["stale_flows"] is True
        assert data["switch_states"] == {"SW_X": False}
        mock_rs.get_topology_preview_sld.assert_called_once_with(
            ["LINE_1"], "VL_X", {"SW_X": False}, base_action_id=None,
        )

    def test_post_action_id_is_forwarded(self, client_and_service):
        client, mock_rs = client_and_service
        mock_rs.get_topology_preview_sld.return_value = {
            "svg": "<svg/>", "sld_metadata": None, "voltage_level_id": "VL_X",
            "switch_states": {}, "stale_flows": True,
        }
        client.post("/api/sld-topology-preview", json={
            "voltage_level_id": "VL_X",
            "disconnected_elements": [],
            "switches": {"SW_X": True},
            "base_action_id": "disco_LINE_42",
        })
        kwargs = mock_rs.get_topology_preview_sld.call_args.kwargs
        assert kwargs["base_action_id"] == "disco_LINE_42"

    def test_service_error_is_translated_to_400(self, client_and_service):
        client, mock_rs = client_and_service
        mock_rs.get_topology_preview_sld.side_effect = RuntimeError("boom")
        r = client.post("/api/sld-topology-preview", json={
            "voltage_level_id": "VL_X",
            "disconnected_elements": [],
            "switches": {},
        })
        assert r.status_code == 400
        assert "boom" in r.json()["detail"]


class TestSimulateManualActionEndpointPlumbsVoltageLevel:
    """``voltage_level_id`` must travel from the HTTP payload all the
    way down to ``simulate_manual_action`` so auto-description picks
    up the VL prefix."""

    def test_voltage_level_id_forwarded(self):
        pytest.importorskip("expert_op4grid_recommender.models.expert")
        from expert_backend.main import app
        with patch("expert_backend.main.recommender_service") as mock_rs:
            mock_rs.simulate_manual_action.return_value = {
                "action_id": "user_topo_VL_X_1",
                "description_unitaire": "Manoeuvre manuelle sur VL_X: SW_A ouvert",
                "rho_before": [], "rho_after": [], "max_rho": 0.0,
                "max_rho_line": "N/A", "is_rho_reduction": False,
                "non_convergence": None, "lines_overloaded": [],
            }
            client = TestClient(app)
            r = client.post("/api/simulate-manual-action", json={
                "action_id": "user_topo_VL_X_1",
                "disconnected_elements": ["LINE_1"],
                "action_content": {"switches": {"SW_A": True}},
                "voltage_level_id": "VL_X",
            })
            assert r.status_code == 200
            kwargs = mock_rs.simulate_manual_action.call_args.kwargs
            assert kwargs["voltage_level_id"] == "VL_X"
            assert kwargs["action_content"] == {"switches": {"SW_A": True}}
