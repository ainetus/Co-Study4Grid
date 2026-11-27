# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0

"""Readable names of generators, loads, busbars and switches — what the SLD,
the action cards and the manual-action descriptions show instead of raw ids.

See docs/features/sld-diagram-feeder-labels.md § 4.
"""
import json
import math
import random
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pandas as pd

from expert_backend.services import equipment_names
from expert_backend.services.context_map.plants import SCHEMA, _main_plant, load_plant_names
from expert_backend.services.diagram.sld_render import build_feeder_labels
from expert_backend.services.equipment_names import (
    VoltageLevelNames,
    busbar_names,
    injection_names,
    manual_action_names,
    switch_names,
)
from expert_backend.services.network_service import NetworkService
from expert_backend.services.simulation_helpers import (
    build_manual_action_description,
    build_switch_action_description,
    describe_manual_action,
)

VL = "VL_MANDA"


def _df(rows: dict, columns: list[str]) -> pd.DataFrame:
    return pd.DataFrame.from_dict(rows, orient="index", columns=columns)


def _node_breaker_topology() -> SimpleNamespace:
    """MANDARINS-like bay layout: two busbars (nodes 0, 1), a coupling
    between them (0-10-11-1), a line bay (BBS1/BBS2 → 2 → breaker → 3) and a
    generator bay (BBS1 → 4 → breaker → 5)."""
    switches = _df({
        "COUPL_D1": {"kind": "DISCONNECTOR", "node1": 0, "node2": 10},
        "COUPL": {"kind": "BREAKER", "node1": 10, "node2": 11},
        "COUPL_D2": {"kind": "DISCONNECTOR", "node1": 11, "node2": 1},
        "D_LINE": {"kind": "DISCONNECTOR", "node1": 0, "node2": 2},
        "D2_LINE": {"kind": "DISCONNECTOR", "node1": 1, "node2": 2},
        "BK_LINE": {"kind": "BREAKER", "node1": 2, "node2": 3},
        "D_GEN": {"kind": "DISCONNECTOR", "node1": 0, "node2": 4},
        "BK_GEN": {"kind": "BREAKER", "node1": 4, "node2": 12},
    }, ["kind", "node1", "node2"])
    nodes = _df({
        0: {"connectable_id": "BBS1", "connectable_type": "BUSBAR_SECTION"},
        1: {"connectable_id": "BBS2", "connectable_type": "BUSBAR_SECTION"},
        3: {"connectable_id": "LINE_W", "connectable_type": "LINE"},
        5: {"connectable_id": "GEN_S", "connectable_type": "GENERATOR"},
    }, ["connectable_id", "connectable_type"])
    # The generator hangs off node 12 through an internal connection.
    internal = pd.DataFrame({"node1": [12], "node2": [5]})
    return SimpleNamespace(switches=switches, nodes=nodes, internal_connections=internal)


def _network() -> MagicMock:
    net = MagicMock()
    net.get_voltage_levels.return_value = _df({
        VL: {"name": "MANDARINS 400kV"},
        "VL_RAW": {"name": "VL_RAW"},
    }, ["name"])
    net.get_generators.return_value = _df({
        "GEN_S": {"name": "MANDARINS 400kV Solar", "voltage_level_id": VL},
        "G_UNNAMED": {"name": "", "voltage_level_id": VL},
        "G_PLANT": {"name": None, "voltage_level_id": VL},
        "G_ELSEWHERE": {"name": "", "voltage_level_id": "VL_RAW"},
    }, ["name", "voltage_level_id"])
    net.get_loads.return_value = _df({
        "L1": {"name": "", "voltage_level_id": VL},
        "L2": {"name": "L2", "voltage_level_id": VL},   # name == id → unnamed
        "X_GB": {"name": "Exchange with GB", "voltage_level_id": VL},
    }, ["name", "voltage_level_id"])
    net.get_busbar_sections.return_value = _df({
        "BBS1": {"name": "MANDARINS JdB1", "voltage_level_id": VL},
        "BBS2": {"name": "BBS2", "voltage_level_id": VL},
        "OTHER_BBS": {"name": "ELSEWHERE JdB1", "voltage_level_id": "VL_RAW"},
    }, ["name", "voltage_level_id"])
    net.get_node_breaker_topology.return_value = _node_breaker_topology()
    net.get_switches.return_value = _df({
        "BK_LINE": {"voltage_level_id": VL},
        "COUPL": {"voltage_level_id": VL},
    }, ["voltage_level_id"])
    return net


class TestInjectionNames:
    def test_own_name_plant_and_fallback(self):
        names = injection_names(_network(), plants={"G_PLANT": "Gravelines"})
        assert names["GEN_S"] == "MANDARINS 400kV Solar"
        assert names["G_PLANT"] == "Gravelines"
        assert names["G_UNNAMED"] == "Generator — MANDARINS 400kV"
        assert names["X_GB"] == "Exchange with GB"
        # A voltage level without a real name reads by its id.
        assert names["G_ELSEWHERE"] == "Generator — VL_RAW"

    def test_unnamed_injections_sharing_a_voltage_level_are_numbered(self):
        names = injection_names(_network())
        # G_UNNAMED and G_PLANT (no plant given) are two unnamed generators.
        assert names["G_PLANT"] == "Generator 1 — MANDARINS 400kV"
        assert names["G_UNNAMED"] == "Generator 2 — MANDARINS 400kV"
        assert names["L1"] == "Load 1 — MANDARINS 400kV"
        assert names["L2"] == "Load 2 — MANDARINS 400kV"

    def test_one_voltage_level(self):
        names = injection_names(_network(), voltage_level_id="VL_RAW")
        assert names == {"G_ELSEWHERE": "Generator — VL_RAW"}

    def test_pypowsybl_failure_gives_nothing(self):
        net = MagicMock()
        net.get_voltage_levels.side_effect = RuntimeError("boom")
        net.get_generators.side_effect = RuntimeError("boom")
        net.get_loads.side_effect = RuntimeError("boom")
        assert injection_names(net) == {}


class TestSwitchNames:
    ELEMENTS = {"LINE_W": "MANDAL71WARAN", "GEN_S": "MANDARINS 400kV Solar"}

    def test_switches_read_by_the_feeder_their_bay_serves(self):
        names = switch_names(_network(), VL, self.ELEMENTS)
        assert names["BK_LINE"] == "disjoncteur MANDAL71WARAN"
        assert names["BK_GEN"] == "disjoncteur MANDARINS 400kV Solar"

    def test_busbar_selector_names_its_busbar(self):
        names = switch_names(_network(), VL, self.ELEMENTS)
        assert names["D_LINE"] == "sectionneur MANDAL71WARAN (MANDARINS JdB1)"
        # An unnamed busbar reads by its id.
        assert names["D2_LINE"] == "sectionneur MANDAL71WARAN (BBS2)"

    def test_a_bay_serving_no_feeder_is_a_coupling(self):
        names = switch_names(_network(), VL, self.ELEMENTS)
        assert names["COUPL"] == "disjoncteur de couplage"
        assert names["COUPL_D1"] == "sectionneur de couplage (MANDARINS JdB1)"

    def test_unnamed_feeder_falls_back_to_its_id(self):
        assert switch_names(_network(), VL, {})["BK_LINE"] == "disjoncteur LINE_W"

    def test_bus_breaker_voltage_level_gives_nothing(self):
        net = _network()
        net.get_node_breaker_topology.side_effect = RuntimeError("not node-breaker")
        assert switch_names(net, VL, self.ELEMENTS) == {}


def test_busbar_names_keeps_the_named_busbars_of_the_voltage_level():
    assert busbar_names(_network(), VL) == {"BBS1": "MANDARINS JdB1"}


class TestManualActionNames:
    def test_switches_injections_and_voltage_levels(self):
        content = {"switches": {"BK_LINE": True}, "set_gen_p": {"GEN_S": 10.0}}
        names = manual_action_names(
            _network(), content, TestSwitchNames.ELEMENTS, {VL: "MANDARINS 400kV"},
        )
        assert names["BK_LINE"] == "disjoncteur MANDAL71WARAN"
        assert names["GEN_S"] == "MANDARINS 400kV Solar"
        assert names[VL] == "MANDARINS 400kV"

    def test_description_in_the_names_the_operator_sees(self):
        content = {"switches": {"BK_LINE": True, "COUPL": False}, "set_gen_p": {"GEN_S": 10.0},
                   "set_load_p": {"L1": 90.0}}
        names = manual_action_names(
            _network(), content, {**TestSwitchNames.ELEMENTS, "L1": "Load — MANDARINS 400kV"},
            {VL: "MANDARINS 400kV"},
        )
        assert build_manual_action_description(content, VL, names) == (
            "Manoeuvre manuelle sur MANDARINS 400kV: disjoncteur MANDAL71WARAN ouvert, "
            "disjoncteur de couplage fermé, MANDARINS 400kV Solar P=10.0 MW, "
            "Load — MANDARINS 400kV P=90.0 MW"
        )

    def test_switch_only_description_reads_names_too(self):
        desc = build_switch_action_description({"BK_LINE": True}, VL, {
            "BK_LINE": "disjoncteur MANDAL71WARAN", VL: "MANDARINS 400kV"})
        assert desc == "Manoeuvre manuelle sur MANDARINS 400kV: disjoncteur MANDAL71WARAN ouvert"


class TestDescribeManualAction:
    def test_names_come_from_the_network_service(self):
        fake = MagicMock()
        fake.manual_action_names.return_value = {"SW": "disjoncteur X", VL: "MANDARINS 400kV"}
        with patch("expert_backend.services.network_service.network_service", fake):
            desc = describe_manual_action({"switches": {"SW": True}}, VL)
        assert desc == "Manoeuvre manuelle sur MANDARINS 400kV: disjoncteur X ouvert"

    def test_raw_ids_when_naming_fails(self):
        fake = MagicMock()
        fake.manual_action_names.side_effect = RuntimeError("no network")
        with patch("expert_backend.services.network_service.network_service", fake):
            desc = describe_manual_action({"switches": {"SW": True}}, VL)
        assert desc == f"Manoeuvre manuelle sur {VL}: SW ouvert"


class TestNetworkServiceDisplayNames:
    @staticmethod
    def _service() -> NetworkService:
        service = NetworkService()
        net = _network()
        net.get_lines.return_value = _df({
            "LINE_W": {"name": "MANDAL71WARAN", "voltage_level1_id": VL, "voltage_level2_id": "VL_RAW"},
        }, ["name", "voltage_level1_id", "voltage_level2_id"])
        net.get_2_windings_transformers.return_value = pd.DataFrame()
        service.network = net
        return service

    def test_branches_and_injections_in_one_cached_map(self):
        service = self._service()
        names = service.get_display_names()
        assert names["LINE_W"] == "MANDAL71WARAN"
        assert names["GEN_S"] == "MANDARINS 400kV Solar"
        service.network.get_lines.reset_mock()
        assert service.get_display_names() is names
        service.network.get_lines.assert_not_called()

    def test_a_new_network_drops_the_cache(self):
        service = self._service()
        service.get_display_names()
        service._invalidate_equipment_caches()
        assert service._display_names is None

    def test_plant_names_beside_the_network(self, tmp_path):
        (tmp_path / "power_plants.json").write_text(json.dumps({
            "schema": SCHEMA,
            "generators": {"G_PLANT": {"capacity_mw": {"Nuclear": 3600.0},
                                       "sites": {"Nuclear": {"name": "Gravelines"}}}},
        }))
        service = self._service()
        service._source_path = str(tmp_path / "network.xiidm")
        assert service.get_injection_names()["G_PLANT"] == "Gravelines"

    def test_manual_action_names_need_a_network(self):
        assert NetworkService().manual_action_names({"switches": {"SW": True}}) == {}

    def test_manual_action_names(self):
        names = self._service().manual_action_names({"switches": {"BK_LINE": True}})
        assert names["BK_LINE"] == "disjoncteur MANDAL71WARAN"
        assert names[VL] == "MANDARINS 400kV"


class TestMainPlant:
    def test_nuclear_site(self):
        assert _main_plant({"capacity_mw": {"Nuclear": 3804.0, "Solar": 12.7},
                            "sites": {"Nuclear": {"name": "Blayais"}}}) == "Blayais"

    def test_largest_named_plant(self):
        entry = {"capacity_mw": {"Wind Offshore": 994.0},
                 "eic": {"Wind Offshore": [["Fecamp Wind Farm", 400.0, ["x"]],
                                           ["Saint-Brieuc", 400.0, ["y"]]]}}
        # Neither is most of the capacity on its own: no single plant name.
        assert _main_plant(entry) is None
        entry["eic"]["Wind Offshore"][0][1] = 600.0
        assert _main_plant(entry) == "Fecamp Wind Farm"

    def test_a_minor_named_plant_does_not_name_the_generator(self):
        assert _main_plant({"capacity_mw": {"Solar": 500.0, "Run-Of-River": 30.0},
                            "eic": {"Run-Of-River": [["Dam", 30.0, []]]}}) is None

    def test_unreadable_or_foreign_file(self, tmp_path):
        assert load_plant_names(None) == {}
        bad = tmp_path / "power_plants.json"
        bad.write_text("{not json")
        assert load_plant_names(bad) == {}
        bad.write_text(json.dumps({"schema": "other/1", "generators": {}}))
        assert load_plant_names(bad) == {}


class TestFeederLabelsForInjectionsAndBusbars:
    def test_injections_and_named_busbars_are_labelled(self):
        net = _network()
        net.get_lines.return_value = pd.DataFrame(columns=["name", "voltage_level1_id", "voltage_level2_id"])
        net.get_2_windings_transformers.return_value = pd.DataFrame(
            columns=["name", "voltage_level1_id", "voltage_level2_id"])
        injections = {"GEN_S": {"kind": "generator"}, "L1": {"kind": "load"}, "NO_NAME": {"kind": "load"}}
        labels = build_feeder_labels(net, VL, injections, {
            "GEN_S": "MANDARINS 400kV Solar", "L1": "Load — MANDARINS 400kV", "NO_NAME": "NO_NAME"})
        assert labels["GEN_S"] == {"name": None, "other_vl": None,
                                   "label": "MANDARINS 400kV Solar", "kind": "generator"}
        assert labels["L1"]["label"] == "Load — MANDARINS 400kV"
        # A display name equal to the id relabels nothing.
        assert "NO_NAME" not in labels
        assert labels["BBS1"] == {"name": None, "other_vl": None, "label": "MANDARINS JdB1", "kind": "busbar"}
        assert "BBS2" not in labels

    def test_without_display_names_only_the_branches(self):
        net = _network()
        net.get_lines.return_value = pd.DataFrame(columns=["name", "voltage_level1_id", "voltage_level2_id"])
        net.get_2_windings_transformers.return_value = pd.DataFrame(
            columns=["name", "voltage_level1_id", "voltage_level2_id"])
        assert build_feeder_labels(net, VL) == {}


class TestSldEndpointNames:
    """The SLD endpoints carry the switch names and the injection / busbar
    labels — what the maneuver list and the relabelled feeders read."""

    @staticmethod
    def _service_and_network():
        from expert_backend.services.recommender_service import RecommenderService

        service = RecommenderService()
        net = _network()
        net.get_working_variant_id.return_value = "InitialState"
        empty = pd.DataFrame(columns=["name", "voltage_level1_id", "voltage_level2_id"])
        net.get_lines.return_value = empty
        net.get_2_windings_transformers.return_value = empty
        sld = MagicMock()
        sld._repr_svg_.return_value = "<svg/>"
        sld._metadata = "{}"
        net.get_single_line_diagram.return_value = sld
        service._get_base_network = lambda: net
        service._get_n_variant = lambda: "InitialState"
        return service

    def test_n_sld_names_switches_injections_and_busbars(self):
        service = self._service_and_network()
        fake = MagicMock()
        fake.get_display_names.return_value = TestSwitchNames.ELEMENTS
        with patch("expert_backend.services.network_service.network_service", fake):
            result = service.get_n_sld(VL)
        assert result["switch_labels"]["BK_LINE"] == "disjoncteur MANDAL71WARAN"
        assert result["switch_labels"]["COUPL"] == "disjoncteur de couplage"
        assert result["feeder_labels"]["GEN_S"]["label"] == "MANDARINS 400kV Solar"
        assert result["feeder_labels"]["BBS1"]["kind"] == "busbar"

    def test_no_names_without_a_loaded_network(self):
        service = self._service_and_network()
        fake = MagicMock()
        fake.get_display_names.side_effect = ValueError("Network not loaded")
        with patch("expert_backend.services.network_service.network_service", fake):
            result = service.get_n_sld(VL)
        assert result["switch_labels"] == {}
        assert "GEN_S" not in result["feeder_labels"]


class TestNameSwitchesIn:
    """Step-2 descriptions quote no switch id the operator never sees."""

    @staticmethod
    def _name(description: str, switches: dict, names: dict) -> str:
        from expert_backend.services.analysis.action_enrichment import name_switches_in

        fake = MagicMock()
        fake.manual_action_names.return_value = names
        with patch("expert_backend.services.network_service.network_service", fake):
            return name_switches_in(description, {"switches": switches})

    def test_a_coupling_switch_is_dropped_from_a_coupling_sentence(self):
        out = self._name("Ouverture du couplage 'VL_X_COUPL' dans le poste 'MANDARINS 400kV'",
                         {"VL_X_COUPL": True}, {"VL_X_COUPL": "disjoncteur de couplage"})
        assert out == "Ouverture du couplage dans le poste 'MANDARINS 400kV'"

    def test_a_feeder_switch_reads_by_its_name(self):
        out = self._name("Ouverture 'VL_X_BK_L1' dans le poste 'MANDARINS 400kV'",
                         {"VL_X_BK_L1": True}, {"VL_X_BK_L1": "disjoncteur MANDAL71WARAN"})
        assert out == "Ouverture 'disjoncteur MANDAL71WARAN' dans le poste 'MANDARINS 400kV'"

    def test_untouched_without_quoted_switches_or_names(self):
        from expert_backend.services.analysis.action_enrichment import name_switches_in

        assert name_switches_in("Ouverture de la ligne 'L1'", {"switches": {"SW": True}}) == \
            "Ouverture de la ligne 'L1'"
        assert name_switches_in("Ouverture 'SW'", None) == "Ouverture 'SW'"
        assert self._name("Ouverture 'SW'", {"SW": True}, {}) == "Ouverture 'SW'"



# ---------------------------------------------------------------------------
# Nameless buses — PyPSA virtual buses on lines, substations OSM never named
# ---------------------------------------------------------------------------

TAP = "VL_virtual_relation_1_a_1-225"        # raw-named tap between ALPHA and BRAVO
CODE_TAP = "VL_virtual_relation_2_1-225"     # tap the pipeline named after its line code
FAR = "VL_virtual_way_3_0-225"               # tap two hops from ALPHA
NEAR = "VL_virtual_way_4_1-225"              # tap one hop from ALPHA
LONE = "VL_virtual_way_5_0-225"              # tap tied to nothing
POSTE = "VL_way_9-225"                       # real substation OSM never named
LINE_COLS = ["name", "voltage_level1_id", "voltage_level2_id"]


def _nameless_network() -> MagicMock:
    net = MagicMock()
    net.get_voltage_levels.return_value = _df({
        "VL_A": {"name": "ALPHA 225kV", "nominal_v": 225.0},
        "VL_B": {"name": "BRAVO 225kV", "nominal_v": 225.0},
        "VL_C": {"name": "CHARLIE 225kV", "nominal_v": 225.0},
        "VL_D": {"name": "DELTA 225kV", "nominal_v": 225.0},
        TAP: {"name": "virtual_relation_1_a_1-225 225kV", "nominal_v": 225.0},
        CODE_TAP: {"name": "CHARLL61DELTA 225kV", "nominal_v": 225.0},
        FAR: {"name": "virtual_way_3_0-225 225kV", "nominal_v": 225.0},
        NEAR: {"name": "virtual_way_4_1-225 225kV", "nominal_v": 225.0},
        LONE: {"name": "virtual_way_5_0-225 225kV", "nominal_v": 225.0},
        POSTE: {"name": "way_9-225 225kV", "nominal_v": 225.0},
    }, ["name", "nominal_v"])
    net.get_lines.return_value = _df({
        "L_A_TAP": {"name": "relation/1:a-225", "voltage_level1_id": "VL_A", "voltage_level2_id": TAP},
        "L_TAP_B": {"name": "relation/1:b-225", "voltage_level1_id": TAP, "voltage_level2_id": "VL_B"},
        "L_TAP_CODE": {"name": "Liaison 225 kV n°1", "voltage_level1_id": TAP, "voltage_level2_id": CODE_TAP},
        "L_CODE_C": {"name": "CHARLL61DELTA", "voltage_level1_id": CODE_TAP, "voltage_level2_id": "VL_C"},
        "L_CODE_D": {"name": "CHARLL61DELTA", "voltage_level1_id": CODE_TAP, "voltage_level2_id": "VL_D"},
        "L_FAR_NEAR": {"name": "way/3-225", "voltage_level1_id": FAR, "voltage_level2_id": NEAR},
        "L_NEAR_A": {"name": "way/4-225", "voltage_level1_id": NEAR, "voltage_level2_id": "VL_A"},
        "L_B_POSTE": {"name": "", "voltage_level1_id": "VL_B", "voltage_level2_id": POSTE},
        "L_POSTE_C": {"name": "", "voltage_level1_id": POSTE, "voltage_level2_id": "VL_C"},
    }, LINE_COLS)
    net.get_2_windings_transformers.return_value = _df({
        "T_TAP": {"name": "G.SOL - virtual_relation_1_a_1-225", "voltage_level1_id": TAP,
                  "voltage_level2_id": TAP},
    }, LINE_COLS)
    net.get_generators.return_value = _df({
        "G_TAP_SOLAR": {"name": "virtual_relation_1_a_1-225 225kV Solar", "voltage_level_id": TAP},
        "G_TAP": {"name": "", "voltage_level_id": TAP},
        "G_CODE_SOLAR": {"name": "CHARLL61DELTA 225kV Solar", "voltage_level_id": CODE_TAP},
    }, ["name", "voltage_level_id"])
    net.get_loads.return_value = pd.DataFrame(columns=["name", "voltage_level_id"])
    return net


class TestVoltageLevelNames:
    def test_a_tap_reads_by_the_substations_it_ties(self):
        names = VoltageLevelNames(_nameless_network())
        # One hop: ALPHA and BRAVO; the line-code tap is walked through, not named.
        assert names.name(TAP) == "Piquage ALPHA / BRAVO 225kV"

    def test_substations_keep_their_names(self):
        assert VoltageLevelNames(_nameless_network()).name("VL_A") == "ALPHA 225kV"

    def test_a_virtual_bus_never_reads_by_its_line(self):
        """The pipeline names some virtual buses after their line — its RTE
        code or its OSM name: a voltage-level label must name substations."""
        net = _nameless_network()
        names = VoltageLevelNames(net)
        assert names.name(CODE_TAP) == "Piquage CHARLIE / DELTA 225kV"
        vls = net.get_voltage_levels.return_value
        vls.loc[CODE_TAP, "name"] = "Liaison 225 kV n°2 Charlie - Delta 225kV"
        assert VoltageLevelNames(net).name(CODE_TAP) == "Piquage CHARLIE / DELTA 225kV"

    def test_a_tap_far_from_any_substation_walks_through_the_others(self):
        names = VoltageLevelNames(_nameless_network())
        assert names.name(FAR) == "Piquage ALPHA 225kV"
        # The second bus that would read alike is numbered.
        assert names.name(NEAR) == "Piquage ALPHA (2) 225kV"

    def test_an_unnamed_substation_sits_near_the_ones_it_ties(self):
        assert VoltageLevelNames(_nameless_network()).name(POSTE) == "Poste près de BRAVO / CHARLIE 225kV"

    def test_a_bus_tied_to_nothing_keeps_its_raw_name(self):
        assert VoltageLevelNames(_nameless_network()).name(LONE) == "virtual_way_5_0-225 225kV"

    def test_seen_from_a_line_a_tap_leaves_out_the_other_end(self):
        names = VoltageLevelNames(_nameless_network())
        assert names.seen_from(TAP, "VL_A") == "Piquage BRAVO 225kV"
        # Seen from another nameless bus, nothing to leave out.
        assert names.seen_from(TAP, CODE_TAP) == "Piquage ALPHA / BRAVO 225kV"
        assert names.seen_from("VL_A", TAP) == "ALPHA 225kV"

    def test_raw_bus_names_inside_other_names_are_rewritten(self):
        names = VoltageLevelNames(_nameless_network())
        assert names.rewrite("G.SOL - virtual_relation_1_a_1-225") == "G.SOL - Piquage ALPHA / BRAVO"
        assert names.rewrite("way_77-225 stays") == "way_77-225 stays"

    def test_generators_named_after_a_tap_read_by_its_name(self):
        names = injection_names(_nameless_network())
        assert names["G_TAP_SOLAR"] == "Piquage ALPHA / BRAVO 225kV Solar"
        assert names["G_TAP"] == "Generator — Piquage ALPHA / BRAVO 225kV"
        assert names["G_CODE_SOLAR"] == "Piquage CHARLIE / DELTA 225kV Solar"

    def test_network_service_names_voltage_levels_and_lines_alike(self):
        service = NetworkService()
        service.network = _nameless_network()
        vls = service.get_voltage_level_names()
        assert vls[TAP] == "Piquage ALPHA / BRAVO 225kV"
        assert vls[POSTE] == "Poste près de BRAVO / CHARLIE 225kV"
        lines = service.get_element_names()
        # A raw-named line reads by its ends, the tap without the other end.
        assert lines["L_A_TAP"] == "ALPHA — Piquage BRAVO"
        assert lines["L_TAP_B"] == "Piquage ALPHA — BRAVO"
        assert lines["L_B_POSTE"] == "BRAVO — Poste près de CHARLIE"
        assert lines["T_TAP"] == "G.SOL - Piquage ALPHA / BRAVO"
        # A line keeps its own real name, even the one a virtual bus took.
        assert lines["L_CODE_C"] == "CHARLL61DELTA"
        assert vls[CODE_TAP] == "Piquage CHARLIE / DELTA 225kV"
        assert not any("virtual_" in name for name in {**vls, **lines}.values() if name != vls[LONE])

    def test_the_sld_names_a_tap_at_the_far_end_of_a_feeder(self):
        net = _nameless_network()
        labels = build_feeder_labels(net, "VL_A", vl_names=VoltageLevelNames(net))
        assert labels["L_A_TAP"]["label"] == "Piquage BRAVO 225kV"
        assert labels["L_A_TAP"]["other_vl"] == TAP
        # Without the names, a raw far end is no label: the branch's id stays.
        assert build_feeder_labels(net, "VL_A")["L_A_TAP"]["label"] is None


# ---------------------------------------------------------------------------
# The walk from a nameless bus: bounded, skipped on a grid without names
# ---------------------------------------------------------------------------

def _graph_network(vls: dict[str, str], edges: list[tuple[str, str]]) -> MagicMock:
    """225 kV voltage levels ``{id: name}`` tied by the lines ``edges``."""
    net = MagicMock()
    net.get_voltage_levels.return_value = _df(
        {vl: {"name": name, "nominal_v": 225.0} for vl, name in vls.items()}, ["name", "nominal_v"])
    net.get_lines.return_value = _df(
        {f"L{i}": {"name": "", "voltage_level1_id": a, "voltage_level2_id": b}
         for i, (a, b) in enumerate(edges)}, LINE_COLS)
    net.get_2_windings_transformers.return_value = pd.DataFrame(columns=LINE_COLS)
    return net


def _bounded_and_unbounded(net: MagicMock) -> tuple[VoltageLevelNames, VoltageLevelNames]:
    """The names as built, and as built by a walk that never stops early."""
    bounded = VoltageLevelNames(net)
    with patch.object(equipment_names, "_ENOUGH_PLACES", math.inf):
        unbounded = VoltageLevelNames(net)
    return bounded, unbounded


def _assert_same_names(bounded: VoltageLevelNames, unbounded: VoltageLevelNames) -> int:
    """Every name the walk feeds is the unbounded walk's — own names,
    ``seen_from`` any other voltage level, ``_pick`` with any substation left
    out. Returns how many walks the bound cut short."""
    assert bounded.as_dict() == unbounded.as_dict()
    assert bounded._raw_tokens == unbounded._raw_tokens
    vls = list(unbounded.network_names)
    cut_short = 0
    for vl in vls:
        assert bounded.name(vl) == unbounded.name(vl)
        assert bounded.is_nameless(vl) == unbounded.is_nameless(vl)
        assert [bounded.seen_from(vl, o) for o in vls] == [unbounded.seen_from(vl, o) for o in vls]
        short, full = bounded._places.get(vl, []), unbounded._places.get(vl, [])
        # Whole hops, nearest first: the bounded places open the full list.
        assert full[:len(short)] == short
        cut_short += len(short) < len(full)
        for exclude in [None, *(name for _, name in full)]:
            for at_least in (1, 2):
                assert VoltageLevelNames._pick(short, exclude, at_least) == \
                    VoltageLevelNames._pick(full, exclude, at_least)
    return cut_short


def _virtual(i: int) -> str:
    return f"VL_virtual_way_{i}-225"


def _raw(vl: str) -> str:
    return f"{vl[3:]} 225kV"


class TestBoundedWalk:
    """The walk from a nameless bus stops at the hop that finds three real
    substations — the names are those of a walk that never stops."""

    def test_more_substations_than_named_at_the_nearest_hop(self):
        tap, behind = _virtual(1), _virtual(2)
        subs = {f"VL_{c}": f"{n} 225kV" for c, n in
                zip("ABCDEF", ("ALPHA", "BRAVO", "CHARLIE", "DELTA", "ECHO", "FOXTROT"))}
        net = _graph_network({**subs, tap: _raw(tap), behind: _raw(behind)}, [
            (tap, "VL_A"), (tap, "VL_B"), (tap, "VL_C"), (tap, "VL_D"),
            (tap, behind), (behind, "VL_E"), (behind, "VL_F"),
        ])
        bounded, unbounded = _bounded_and_unbounded(net)
        assert bounded._places[tap] == [(1, "ALPHA"), (1, "BRAVO"), (1, "CHARLIE"), (1, "DELTA")]
        assert len(unbounded._places[tap]) == 6
        assert bounded.name(tap) == "Piquage ALPHA / BRAVO / CHARLIE 225kV"
        # Seen from ALPHA, the fourth nearest takes its place.
        assert bounded.seen_from(tap, "VL_A") == "Piquage BRAVO / CHARLIE / DELTA 225kV"
        assert bounded.name(behind) == "Piquage ECHO / FOXTROT 225kV"
        assert _assert_same_names(bounded, unbounded)

    def test_taps_several_hops_away(self):
        # X — HOTEL; X — W — KILO; X — Y — Z — GOLF / MIKE; Z — Q — ROMEO.
        x, w, y, z, q = (_virtual(i) for i in range(1, 6))
        net = _graph_network({
            "VL_H": "HOTEL 225kV", "VL_K": "KILO 225kV", "VL_G": "GOLF 225kV",
            "VL_M": "MIKE 225kV", "VL_R": "ROMEO 225kV", **{vl: _raw(vl) for vl in (x, w, y, z, q)},
        }, [(x, "VL_H"), (x, w), (w, "VL_K"), (x, y), (y, z), (z, "VL_G"), (z, "VL_M"),
            (z, q), (q, "VL_R")])
        bounded, unbounded = _bounded_and_unbounded(net)
        assert bounded._places[x] == [(1, "HOTEL"), (2, "KILO"), (3, "GOLF"), (3, "MIKE")]
        assert unbounded._places[x][-1] == (4, "ROMEO")
        # The nearest, completed with the next nearest; one left out, the
        # nearest of the others.
        assert bounded.name(x) == "Piquage HOTEL / KILO 225kV"
        assert bounded.seen_from(x, "VL_H") == "Piquage KILO 225kV"
        assert bounded.seen_from(x, "VL_K") == "Piquage HOTEL 225kV"
        assert bounded._places[q] == [(1, "ROMEO"), (2, "GOLF"), (2, "MIKE")]
        assert bounded.name(q) == "Piquage ROMEO / GOLF 225kV"
        assert bounded.seen_from(q, "VL_R") == "Piquage GOLF / MIKE 225kV"
        assert _assert_same_names(bounded, unbounded)

    def test_a_substation_at_two_voltages_counts_once(self):
        """Places are substations: ALPHA 225 kV and ALPHA 400 kV are one."""
        u, v, s = _virtual(1), _virtual(2), _virtual(3)
        net = _graph_network({
            "VL_A225": "ALPHA 225kV", "VL_A400": "ALPHA 400kV", "VL_B": "BRAVO 225kV",
            "VL_C": "CHARLIE 225kV", "VL_D": "DELTA 225kV", **{vl: _raw(vl) for vl in (u, v, s)},
        }, [(u, "VL_A225"), (u, "VL_A400"), (u, v), (v, "VL_B"), (v, "VL_C"), (v, s), (s, "VL_D")])
        bounded, unbounded = _bounded_and_unbounded(net)
        assert bounded._places[u] == [(1, "ALPHA"), (2, "BRAVO"), (2, "CHARLIE")]
        assert unbounded._places[u][-1] == (3, "DELTA")
        assert bounded.name(u) == "Piquage ALPHA / BRAVO 225kV"
        assert bounded.seen_from(u, "VL_A400") == "Piquage BRAVO / CHARLIE 225kV"
        assert _assert_same_names(bounded, unbounded)

    def test_random_grids(self):
        """Seeded random grids: few substation names (ties, namesakes at two
        voltages), virtual buses, substations OSM never named, chains."""
        rng = random.Random(20261126)
        cut_short = 0
        for _ in range(200):
            vls = {}
            for i in range(rng.randint(2, 24)):
                kind = rng.random()
                if kind < 0.35:
                    vls[f"VL_{i}"] = f"{rng.choice('ABCDEF')} {rng.choice(('225kV', '400kV'))}"
                elif kind < 0.85:
                    vls[_virtual(i)] = _raw(_virtual(i))
                else:
                    vls[f"VL_way_{i}-225"] = rng.choice(("", f"way_{i}-225 225kV"))
            ids = list(vls)
            edges = [tuple(rng.sample(ids, 2)) for _ in range(rng.randint(1, 2 * len(ids)))]
            cut_short += _assert_same_names(*_bounded_and_unbounded(_graph_network(vls, edges)))
        # The bound did cut walks short — the comparison is not vacuous.
        assert cut_short > 100

    def test_a_grid_without_a_single_name_is_not_walked(self):
        """An RTE grid names none of its voltage levels: no substation to
        find, so the branches are not even read; every bus stays nameless
        and keeps whatever raw name it has."""
        lone = _virtual(9)
        net = _graph_network({"VL_0": "", "VL_1": "", "VL_2": "", lone: _raw(lone)},
                             [("VL_0", "VL_1"), ("VL_1", "VL_2"), ("VL_2", lone)])
        names = VoltageLevelNames(net)
        net.get_lines.assert_not_called()
        net.get_2_windings_transformers.assert_not_called()
        assert all(names.is_nameless(vl) for vl in ("VL_0", "VL_1", "VL_2", lone))
        assert names.as_dict() == {lone: _raw(lone)}
        assert names.name("VL_0") == "VL_0"
        assert names.seen_from("VL_0", "VL_1") is None


class TestNetworkServiceNamer:
    def test_requests_racing_for_the_names_build_them_once(self):
        """``/api/branches`` and ``/api/voltage-levels`` arrive together."""
        service = NetworkService()
        service.network = _nameless_network()
        built = []

        def build(network):
            built.append(network)
            time.sleep(0.05)  # every request asks meanwhile
            return VoltageLevelNames(network)

        start = threading.Barrier(4)

        def request(_):
            start.wait()
            return service.voltage_level_namer()

        with patch("expert_backend.services.network_service.VoltageLevelNames", side_effect=build), \
                ThreadPoolExecutor(4) as pool:
            namers = list(pool.map(request, range(4)))
        assert len(built) == 1
        assert all(namer is namers[0] for namer in namers)

    def test_names_built_for_a_replaced_network_are_not_served(self):
        """A request still building the previous study's names when the next
        study loads must not leave them to the new network."""
        service = NetworkService()
        service.network = _nameless_network()
        first = service.voltage_level_namer()
        assert service.voltage_level_namer() is first
        service.network = _graph_network({"VL_A": "ALPHA 225kV"}, [])
        assert service.voltage_level_namer() is not first
        assert service.voltage_level_namer().name("VL_A") == "ALPHA 225kV"
