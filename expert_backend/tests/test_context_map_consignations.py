# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0
"""Context tab — the network outline (liseré) and the consignations.

Both are Carte-Front layers, ported: the rule that tells a consigned circuit
(no current at either end AND isolated at both substations, ``TOPO`` read from
the node-breaker topology) and the 400 / 225 kV trace of the grid. The
network is hand-built, its tables plain pandas frames, so every verdict
below can be checked by hand.
"""
from __future__ import annotations

from types import SimpleNamespace

import pandas as pd
import pytest
from fastapi.testclient import TestClient

from expert_backend.services.context_map import geography
from expert_backend.services.context_map.builder import build_context_map
from expert_backend.services.context_map.consignations import (
    COLUMNS,
    detect_consignations,
    voltage_class,
)
from expert_backend.services.context_map.network_layers import consignation_layer, grid_outline
from expert_backend.services.context_map.service import ContextMapService
from expert_backend.services.context_map.snapshot import capture_snapshot
from expert_backend.tests.test_context_map import FakeNetwork, _frame

NAN = float("nan")

LINE_COLUMNS = ["name", "voltage_level1_id", "voltage_level2_id", "p1", "q1", "i1", "p2", "q2", "i2",
                "connected1", "connected2"]


def _circuit(vl1, vl2, i1=NAN, i2=NAN, connected1=True, connected2=True, p1=NAN, p2=NAN, q1=NAN, q2=NAN):
    return {"name": "", "voltage_level1_id": vl1, "voltage_level2_id": vl2, "p1": p1, "q1": q1,
            "i1": i1, "p2": p2, "q2": q2, "i2": i2, "connected1": connected1, "connected2": connected2}


def _topology(nodes: dict[int, tuple[str, str]], switches: list[tuple[int, int, bool]] = (),
              internal: list[tuple[int, int]] = ()):
    """What ``get_node_breaker_topology`` returns: ``nodes`` (node → (connectable id, type)),
    ``switches`` (node1, node2, open) and ``internal_connections``."""
    return SimpleNamespace(
        nodes=pd.DataFrame([{"connectable_id": cid, "connectable_type": kind} for cid, kind in nodes.values()],
                           index=pd.Index(list(nodes), name="node")),
        switches=pd.DataFrame([{"node1": a, "node2": b, "open": o} for a, b, o in switches],
                              columns=["node1", "node2", "open"]),
        internal_connections=pd.DataFrame([{"node1": a, "node2": b} for a, b in internal],
                                          columns=["node1", "node2"]),
    )


BUSBAR = "BUSBAR_SECTION"
LINE = "LINE"


class TopologyNetwork:
    """Only the topology reads the detector makes; a voltage level without
    an entry is bus-breaker (pypowsybl raises)."""

    def __init__(self, topologies: dict):
        self._topologies = topologies

    def get_node_breaker_topology(self, voltage_level):
        if voltage_level not in self._topologies:
            raise RuntimeError(f"{voltage_level} is not a node/breaker voltage level")
        return self._topologies[voltage_level]


def _tables(lines: dict[str, dict]) -> pd.DataFrame:
    return _frame(lines, LINE_COLUMNS)


NOMINAL = {"A": 400.0, "B": 400.0, "C": 380.0, "D": 225.0, "E": 220.0, "LOW": 63.0, "T": 225.0}


def _alone(circuit: str, busbar: str = "") -> object:
    """A voltage level whose bay for ``circuit`` is cut by an open breaker."""
    nodes = {0: (busbar, BUSBAR)} if busbar else {0: ("", "")}
    nodes[1], nodes[2] = ("", ""), (circuit, LINE)
    return _topology(nodes, switches=[(0, 1, False), (1, 2, True)])


def detect(lines: dict, topologies: dict, transformers: dict | None = None, nominal=NOMINAL,
           flows: bool = True) -> pd.DataFrame:
    """The verdict on ``lines``, in a file whose other circuits carry flow (as any real
    situation: a consigned circuit is the exception, not the file)."""
    if flows:
        lines = {**{f"BACKGROUND_{n}": _circuit("A", "B", i1=120.0, i2=118.0) for n in range(4)}, **lines}
    return detect_consignations(TopologyNetwork(topologies), _tables(lines),
                                _tables(transformers or {}), nominal)


class TestVoltageClass:
    @pytest.mark.parametrize("kv, label", [
        (400.0, "400 kV"), (380.0, "400 kV"), (300.0, "400 kV"),
        (225.0, "225 kV"), (220.0, "225 kV"), (180.0, "225 kV"),
        (150.0, None), (63.0, None), (NAN, None), (None, None),
    ])
    def test_extra_high_voltage_classes(self, kv, label):
        assert voltage_class(kv) == label


class TestRule:
    def test_a_circuit_without_current_cut_at_both_ends_is_consigned(self):
        found = detect(
            {"OUT": _circuit("A", "B", connected1=False, connected2=False)},
            {"A": _alone("OUT"), "B": _alone("OUT")})
        assert list(found.index) == ["OUT"]
        assert found.loc["OUT"].to_dict() == {"vl1": "A", "vl2": "B", "voltage": "400 kV", "kind": "line"}

    def test_a_circuit_carrying_current_is_not(self):
        found = detect({"LIVE": _circuit("A", "B", i1=310.0, i2=305.0)},
                       {"A": _alone("LIVE"), "B": _alone("LIVE")})
        assert found.empty

    def test_a_line_energised_from_one_end_keeps_its_charging_current(self):
        # Open at B, closed at A: the A end still carries ~58 A of charging
        # current — it is in service, not consigned (Carte-Front's `I` rule).
        found = detect({"CHARGED": _circuit("A", "B", i1=58.0, i2=0.0, connected2=False)},
                       {"A": _alone("CHARGED"), "B": _alone("CHARGED")})
        assert found.empty

    def test_the_threshold_is_half_an_ampere(self):
        lines = {"TINY": _circuit("A", "B", i1=0.49, i2=0.0), "SMALL": _circuit("A", "B", i1=0.5, i2=0.0)}
        topologies = {"A": _alone("TINY"), "B": _alone("TINY")}
        topologies["A"].nodes.loc[3] = ["SMALL", LINE]
        topologies["B"].nodes.loc[3] = ["SMALL", LINE]
        assert list(detect(lines, topologies).index) == ["TINY"]

    def test_a_circuit_still_on_a_node_with_a_live_one_is_not_isolated(self):
        # No current, open at A — but at B it shares its node with a live line.
        shared = _topology({0: (LINE, LINE), 1: ("LIVE", LINE)}, switches=[(0, 1, False)])
        shared.nodes.loc[0] = ["HALF", LINE]
        found = detect(
            {"HALF": _circuit("A", "B", connected1=False), "LIVE": _circuit("B", "D", i1=200.0, i2=200.0)},
            {"A": _alone("HALF"), "B": shared, "D": _alone("LIVE")})
        assert found.empty

    def test_busbar_sections_and_fictitious_elements_are_the_nodes_own_wiring(self):
        # Closed to a bare busbar (and a fict_ element): nothing else shares its node.
        bare = _topology({0: ("B_1", BUSBAR), 1: ("HALF", LINE), 2: ("fict_load", "LOAD")},
                         switches=[(0, 1, False), (0, 2, False)])
        found = detect({"HALF": _circuit("A", "B")}, {"A": _alone("HALF"), "B": bare})
        assert list(found.index) == ["HALF"]

    def test_an_open_switch_cuts_the_node(self):
        cut = _topology({0: ("B_1", BUSBAR), 1: ("HALF", LINE), 2: ("LIVE", LINE)},
                        switches=[(0, 2, False), (0, 1, True)])
        found = detect(
            {"HALF": _circuit("A", "B"), "LIVE": _circuit("B", "D", i1=200.0, i2=200.0)},
            {"A": _alone("HALF"), "B": cut, "D": _alone("LIVE")})
        assert list(found.index) == ["HALF"]

    def test_internal_connections_join_nodes(self):
        joined = _topology({0: ("B_1", BUSBAR), 1: ("HALF", LINE), 2: ("LIVE", LINE)},
                           switches=[(0, 2, False)], internal=[(0, 1)])
        found = detect(
            {"HALF": _circuit("A", "B"), "LIVE": _circuit("B", "D", i1=200.0, i2=200.0)},
            {"A": _alone("HALF"), "B": joined, "D": _alone("LIVE")})
        assert found.empty

    def test_consigned_circuits_tied_together_are_each_consigned(self):
        # An antenna: two circuits out of service meet on one node, neither "alone".
        tied = _topology({0: ("B_1", BUSBAR), 1: ("G1", LINE), 2: ("G2", LINE)},
                         switches=[(0, 1, False), (0, 2, False)])
        found = detect(
            {"G1": _circuit("A", "B", connected1=False), "G2": _circuit("D", "B", connected1=False)},
            {"A": _alone("G1"), "D": _alone("G2"), "B": tied})
        assert sorted(found.index) == ["G1", "G2"]

    def test_a_bus_breaker_end_is_isolated_when_disconnected(self):
        # "A" and "B" have no switches to reason on.
        lines = {"CUT": _circuit("A", "B", connected1=False, connected2=False),
                 "ZERO": _circuit("A", "B", i1=0.0, i2=0.0)}
        assert list(detect(lines, {}).index) == ["CUT"]

    def test_only_extra_high_voltage_circuits(self):
        lines = {"LOW": _circuit("LOW", "LOW", connected1=False, connected2=False),
                 "MIXED": _circuit("A", "LOW", connected1=False, connected2=False),
                 "EUROPE": _circuit("C", "E", connected1=False, connected2=False)}
        found = detect(lines, {})
        assert list(found.index) == ["EUROPE"]
        assert found.loc["EUROPE", "voltage"] == "400 kV"  # 380 / 220 kV: the higher class

    def test_a_transformer_is_a_circuit_too(self):
        found = detect({}, {}, transformers={"TR": _circuit("A", "D", connected1=False, connected2=False)})
        assert found.loc["TR"].to_dict() == {"vl1": "A", "vl2": "D", "voltage": "400 kV", "kind": "transformer"}

    def test_current_is_rebuilt_from_the_flow_when_pypowsybl_gives_none(self):
        # No computed bus voltage → `I` = sqrt(P² + Q²) / (sqrt(3)·V) at the nominal voltage:
        # 100 MW at 400 kV is 144 A, a live line; 0 MW is none.
        lines = {"FLOWING": _circuit("A", "B", p1=100.0, q1=10.0, p2=-99.0, q2=-8.0),
                 "DEAD": _circuit("A", "B", p1=0.0, q1=0.0, p2=0.0, q2=0.0)}
        topologies = {vl: _topology({0: ("FLOWING", LINE), 1: ("DEAD", LINE)}) for vl in "AB"}
        assert list(detect(lines, topologies).index) == ["DEAD"]

    def test_a_file_without_any_flow_tells_nothing(self):
        # Every circuit would read "no current": only the topology could say, and it is
        # not enough on its own — no consignations rather than all of them.
        lines = {f"L{n}": _circuit("A", "B") for n in range(4)}
        topologies = {vl: _topology({n: (f"L{n}", LINE) for n in range(4)}) for vl in "AB"}
        assert detect(lines, topologies, flows=False).empty

    def test_nothing_to_say_without_voltages_or_circuits(self):
        assert detect_consignations(TopologyNetwork({}), _tables({}), _tables({}), {}).empty
        assert list(detect({}, {}).columns) == COLUMNS

    def test_an_unreadable_topology_falls_back_on_the_connection(self):
        broken = TopologyNetwork({})
        broken.get_node_breaker_topology = lambda vl: (_ for _ in ()).throw(ValueError("unreadable"))
        lines = {f"LIVE_{n}": _circuit("A", "B", i1=120.0, i2=118.0) for n in range(3)}
        lines["CUT"] = _circuit("A", "B", connected1=False, connected2=False)
        found = detect_consignations(broken, _tables(lines), _tables({}), NOMINAL)
        assert list(found.index) == ["CUT"]


class LayerNetwork(FakeNetwork):
    """A country-mesh network placed on the ground, with voltages, currents and topologies."""

    def __init__(self, lines, transformers=None, topologies=None):
        super().__init__(
            substations={"S_A": {"name": "", "country": "FR", "regionCvg": None},
                         "S_B": {"name": "", "country": "DE", "regionCvg": None},
                         "S_D": {"name": "", "country": "FR", "regionCvg": None},
                         "S_E": {"name": "", "country": "FR", "regionCvg": None},
                         "S_LOW": {"name": "", "country": "FR", "regionCvg": None}},
            # A and A2 are two voltage levels of one substation: a transformer joins them.
            vls={"A": "S_A", "A2": "S_A", "B": "S_B", "D": "S_D", "E": "S_E", "LOW": "S_LOW"},
            positions={"S_A": {"latitude": 48.85, "longitude": 2.35},
                       "S_B": {"latitude": 52.52, "longitude": 13.40},
                       "S_D": {"latitude": 45.76, "longitude": 4.84},
                       "S_E": {"latitude": 50.63, "longitude": 3.06},
                       "S_LOW": {"latitude": 47.0, "longitude": 3.0}},
            vl_names={"A": "PARIS 400kV", "B": "BERLIN 400kV"},
        )
        nominal = {"A": 400.0, "A2": 225.0, "B": 400.0, "D": 225.0, "E": 225.0, "LOW": 63.0}
        self._vls = self._vls.assign(nominal_v=pd.Series(nominal))
        self._lines = _tables(lines)
        self._trafos = _tables(transformers or {})
        self._topologies = topologies or {}

    def get_2_windings_transformers(self):
        return self._trafos

    get_node_breaker_topology = TopologyNetwork.get_node_breaker_topology


@pytest.fixture
def layer_network() -> LayerNetwork:
    return LayerNetwork(
        lines={
            "OUT": _circuit("A", "B", connected1=False, connected2=False),
            "OUT_TWIN": _circuit("A", "B", connected1=False, connected2=False),
            **{f"LIVE_{n}": _circuit("A", "B", i1=300.0, i2=300.0) for n in range(5)},
            "OUT_225": _circuit("D", "E", connected1=False, connected2=False),
            "LOW_LINE": _circuit("LOW", "LOW", i1=10.0, i2=10.0),
        },
        transformers={"TR_OUT": _circuit("A", "A2", connected1=False, connected2=False)},
        topologies={"A": _topology({0: ("OUT", LINE), 1: ("OUT_TWIN", LINE), 2: ("TR_OUT", "TWO_WINDINGS_TRANSFORMER")}),
                    "A2": _topology({0: ("TR_OUT", "TWO_WINDINGS_TRANSFORMER")}),
                    "B": _topology({0: ("OUT", LINE), 1: ("OUT_TWIN", LINE)}),
                    "D": _topology({0: ("OUT_225", LINE)}),
                    "E": _topology({0: ("OUT_225", LINE)})})


class TestSnapshot:
    def test_capture_reads_the_voltages_and_the_consignations(self, layer_network):
        snap = capture_snapshot(layer_network)
        assert snap.vl_nominal["A"] == 400.0
        assert sorted(snap.consignations.index) == ["OUT", "OUT_225", "OUT_TWIN", "TR_OUT"]
        assert set(snap.branches["kind"]) == {"line", "transformer"}

    def test_a_failing_detection_only_leaves_the_layer_out(self, layer_network, monkeypatch):
        from expert_backend.services.context_map import snapshot
        monkeypatch.setattr(snapshot, "detect_consignations",
                            lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom")))
        snap = capture_snapshot(layer_network)
        assert snap.consignations.empty and not snap.branches.empty

    def test_a_network_without_voltages_has_none(self):
        net = FakeNetwork(
            substations={"S1": {"name": "", "country": "FR", "regionCvg": None},
                         "S2": {"name": "", "country": "DE", "regionCvg": None}},
            vls={"V1": "S1", "V2": "S2"})
        assert capture_snapshot(net).consignations.empty


class TestPayload:
    @pytest.fixture
    def cmap(self, layer_network):
        snap = capture_snapshot(layer_network)
        return snap, build_context_map(snap, layout={})

    def test_consignations_ride_in_the_map_payload(self, cmap):
        _, built = cmap
        layer = built.payload["consignations"]
        assert layer["total"] == 4
        by_id = {c["id"]: c for c in layer["items"]}
        assert sorted(by_id) == ["OUT", "OUT_225", "OUT_TWIN", "TR_OUT"]
        out = by_id["OUT"]
        assert (out["voltage"], out["kind"]) == ("400 kV", "line")
        assert out["vls"] == ["PARIS 400kV", "BERLIN 400kV"]
        assert out["points"][0] == [round(v, 3) for v in geography.project(2.35, 48.85, built.lat0)]
        assert out["points"][1] == [round(v, 3) for v in geography.project(13.40, 52.52, built.lat0)]
        assert by_id["OUT_225"]["voltage"] == "225 kV"
        # A transformer's ends coincide: the frontend draws it as a point.
        assert by_id["TR_OUT"]["points"][0] == by_id["TR_OUT"]["points"][1]

    def test_a_circuit_the_map_cannot_place_is_counted_not_drawn(self, layer_network):
        snap = capture_snapshot(layer_network)
        layer = consignation_layer(snap, {"A": (0.0, 0.0)})  # B, D, E unplaced
        assert layer == {"items": [], "total": 4}

    def test_the_network_outline_is_not_in_the_payload(self, cmap):
        assert "segments" not in cmap[1].payload and "outline" not in cmap[1].payload


class TestOutline:
    def test_one_segment_per_pair_of_places_by_voltage(self, layer_network):
        snap = capture_snapshot(layer_network)
        built = build_context_map(snap, layout={})
        outline = grid_outline(snap, built.vl_xy)
        # OUT, OUT_TWIN (parallel) and the LIVE ones melt into ONE A–B segment; the 225 kV line
        # is its own; a transformer, a 63 kV line and a loop on a point are no segment.
        assert {voltage: len(found) for voltage, found in outline["segments"].items()} == {
            "400 kV": 1, "225 kV": 1}
        a, b = (round(v, 3) for v in built.vl_xy["A"]), (round(v, 3) for v in built.vl_xy["B"])
        assert sorted([list(a), list(b)]) == [outline["segments"]["400 kV"][0][:2],
                                              outline["segments"]["400 kV"][0][2:]]

    def test_400_comes_first_and_an_unplaced_grid_has_none(self, layer_network):
        snap = capture_snapshot(layer_network)
        built = build_context_map(snap, layout={})
        assert list(grid_outline(snap, built.vl_xy)["segments"]) == ["400 kV", "225 kV"]
        assert grid_outline(snap, {}) == {"segments": {}}

    def test_a_hand_built_table_without_kinds_reads_as_lines(self, layer_network):
        snap = capture_snapshot(layer_network)
        built = build_context_map(snap, layout={})
        snap.branches = snap.branches.drop(columns="kind")
        assert sum(map(len, grid_outline(snap, built.vl_xy)["segments"].values())) >= 2


class TestService:
    def test_outline_is_built_once_and_stamped(self, layer_network):
        service = ContextMapService()
        assert service.outline() is None
        service.capture(layer_network)
        first = service.outline()
        assert first is service.outline()
        assert first["capture_id"] == 1 and set(first["segments"]) == {"400 kV", "225 kV"}
        service.capture(layer_network)
        assert service.outline()["capture_id"] == 2

    def test_a_network_without_a_map_has_an_empty_outline(self):
        net = FakeNetwork(substations={"S1": {"name": "", "country": "FR", "regionCvg": None}},
                          vls={"V1": "S1"})
        service = ContextMapService()
        service.capture(net)
        assert service.outline()["segments"] == {}


class TestRoute:
    @pytest.fixture
    def client(self, monkeypatch):
        from expert_backend import context_map_api
        from expert_backend.main import app
        service = ContextMapService()
        monkeypatch.setattr(context_map_api, "context_map_service", service)
        return TestClient(app), service

    def test_404_before_a_study_is_loaded(self, client):
        http, _ = client
        response = http.get("/api/context-map/network")
        assert response.status_code == 404 and response.json()["code"] == "NOT_FOUND"

    def test_serves_the_outline(self, client, layer_network):
        http, service = client
        service.capture(layer_network)
        body = http.get("/api/context-map/network").json()
        assert set(body["segments"]) == {"400 kV", "225 kV"} and body["capture_id"] == 1
        assert all(len(seg) == 4 for seg in body["segments"]["400 kV"])
