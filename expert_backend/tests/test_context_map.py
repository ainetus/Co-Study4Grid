# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0
"""Context tab — the Carte-Front situation map (``services/context_map``).

A hand-built network stands in for pypowsybl (its tables are plain pandas
frames), so every number below can be checked by hand: zones and mesh,
production by generation type, consumption, inter-zone transfers, the
georeferencing of a layout, and the two HTTP routes.
"""
from __future__ import annotations

import json
import math
from datetime import datetime, timezone
from unittest.mock import MagicMock

import numpy as np
import pandas as pd
import pytest
from fastapi.testclient import TestClient

from expert_backend.services.context_map import geography
from expert_backend.services.context_map.aggregate import build_zoning
from expert_backend.services.context_map.builder import build_context_map, element_geometry
from expert_backend.services.context_map.georef import (
    OP4GRID_PLAN_AFFINE,
    MERCATOR_RADIUS_M,
    fit_layout,
    georeference,
    load_layout_points,
)
from expert_backend.services.context_map.nuclear import PLANT_LONLAT, plant_of, ring_offsets
from expert_backend.services.context_map.plants import (
    PLANTS_FILE_NAME,
    SCHEMA as PLANTS_SCHEMA,
    load_plant_matching,
    resolve_plants_path,
)
from expert_backend.services.context_map.service import ContextMapService, resolve_layout_path
from expert_backend.services.context_map.situation import (
    SITUATION_FILE_NAME,
    load_situation,
)
from expert_backend.services.context_map.snapshot import capture_snapshot

NAN = float("nan")


def _frame(rows: dict[str, dict], columns: list[str]) -> pd.DataFrame:
    df = pd.DataFrame.from_dict(rows, orient="index", columns=columns)
    df.index.name = "id"
    return df


class FakeNetwork:
    """The pypowsybl tables the context map reads, as pandas frames."""

    def __init__(self, substations, vls, lines=None, generators=None, loads=None,
                 hvdc=None, stations=None, positions=None):
        self.case_date = datetime(2026, 1, 10, 17, 30, tzinfo=timezone.utc)
        self._subs = _frame(substations, ["name", "country", "regionCvg"])
        self._vls = _frame({k: {"substation_id": v} for k, v in vls.items()}, ["substation_id"])
        self._lines = _frame(lines or {}, ["name", "voltage_level1_id", "voltage_level2_id",
                                           "p1", "p2", "connected1", "connected2"])
        self._gens = _frame(generators or {}, ["voltage_level_id", "p", "target_p",
                                               "energy_source", "connected", "genreCvg", "max_p",
                                               "name", "carrier", "plant", "plant_lon", "plant_lat"])
        self._loads = _frame(loads or {}, ["voltage_level_id", "p", "p0", "connected",
                                           "type", "neighbour"])
        self._hvdc = _frame(hvdc or {}, ["name", "converter_station1_id", "converter_station2_id"])
        self._stations = _frame(stations or {}, ["voltage_level_id", "p"])
        self._positions = _frame(positions or {}, ["latitude", "longitude"])

    def get_substations(self, all_attributes=False):
        return self._subs

    def get_voltage_levels(self):
        return self._vls

    def get_extensions(self, name):
        return self._positions

    def get_lines(self):
        return self._lines

    def get_2_windings_transformers(self):
        return self._lines.iloc[0:0]

    def get_tie_lines(self):
        return pd.DataFrame()

    def get_hvdc_lines(self):
        return self._hvdc

    def get_vsc_converter_stations(self):
        return self._stations

    def get_lcc_converter_stations(self):
        return self._stations.iloc[0:0]

    def get_generators(self, all_attributes=False):
        return self._gens

    def get_loads(self, all_attributes=False):
        return self._loads


def _line(vl1, vl2, p1, p2, connected2=True):
    return {"name": "", "voltage_level1_id": vl1, "voltage_level2_id": vl2,
            "p1": p1, "p2": p2, "connected1": True, "connected2": connected2}


def _gen(vl, p, target=NAN, source="OTHER", genre=None, max_p=NAN, connected=True):
    return {"voltage_level_id": vl, "p": p, "target_p": target, "energy_source": source,
            "connected": connected, "genreCvg": genre, "max_p": max_p}


@pytest.fixture
def french_network() -> FakeNetwork:
    """Three RTE regions, two neighbours, an HVDC link and a dead line."""
    return FakeNetwork(
        substations={
            "S_LYON": {"name": "Lyon S", "country": "FR", "regionCvg": "LYON"},
            "S_PARIS": {"name": "Paris S", "country": "FR", "regionCvg": "paris"},
            "S_NANCY": {"name": "Nancy S", "country": "FR", "regionCvg": "NANCY"},
            "S_ES": {"name": "Spain S", "country": "ES", "regionCvg": "ESPAGNE"},
            "S_IT": {"name": "Italy S", "country": "IT", "regionCvg": "ITALIE"},
        },
        vls={"V_LYON": "S_LYON", "V_PARIS": "S_PARIS", "V_NANCY": "S_NANCY",
             "V_ES": "S_ES", "V_IT": "S_IT"},
        lines={
            "L_LYON_PARIS": dict(_line("V_LYON", "V_PARIS", 500.0, -495.0), name="Lyon-Paris"),
            "L_PARIS_NANCY": _line("V_PARIS", "V_NANCY", -300.0, 302.0),
            "L_LYON_IT": _line("V_LYON", "V_IT", -800.0, 805.0),
            "L_ES_IT": _line("V_ES", "V_IT", 100.0, -100.0),
            "L_DEAD": _line("V_LYON", "V_NANCY", 900.0, NAN, connected2=False),
        },
        generators={
            "G_NUC": _gen("V_LYON", -1000.0, source="NUCLEAR", genre="NUCLEAIRE"),
            "G_HYD": _gen("V_LYON", -300.0, source="HYDRO"),
            "G_GAS": _gen("V_PARIS", NAN, target=400.0, source="THERMAL"),
            "G_PUMP": _gen("V_NANCY", 50.0, source="HYDRO", genre="POMPAGE"),
            "G_IT": _gen("V_IT", -5000.0, source="THERMAL"),
        },
        loads={
            "LD_LYON": {"voltage_level_id": "V_LYON", "p": 800.0, "p0": 790.0, "connected": True},
            "LD_PARIS": {"voltage_level_id": "V_PARIS", "p": 1500.0, "p0": 1500.0, "connected": True},
            "LD_NANCY": {"voltage_level_id": "V_NANCY", "p": NAN, "p0": 200.0, "connected": True},
        },
        hvdc={"H_LYON_ES": {"name": "HVDC", "converter_station1_id": "CS1",
                            "converter_station2_id": "CS2"}},
        stations={"CS1": {"voltage_level_id": "V_LYON", "p": 200.0},
                  "CS2": {"voltage_level_id": "V_ES", "p": -198.0}},
    )


@pytest.fixture
def french_map(french_network):
    snap = capture_snapshot(french_network)
    return snap, build_context_map(snap, layout={})


class TestRegionMesh:
    def test_mesh_and_zones(self, french_map):
        _, cmap = french_map
        payload = cmap.payload
        assert payload["mesh"] == "region" and payload["home"] == "FR"
        kinds = {z["id"]: z["kind"] for z in payload["zones"]}
        # Region tags are upper-cased; a foreign substation stays its COUNTRY
        # (its own regionCvg, "ITALIE", is ignored — Carte-Front's rule).
        assert kinds == {"LYON": "region", "PARIS": "region", "NANCY": "region",
                         "ES": "neighbor", "IT": "neighbor"}

    def test_production_mix_and_consumption(self, french_map):
        _, cmap = french_map
        zones = {z["id"]: z for z in cmap.payload["zones"]}
        # genreCvg wins, energySource fills in; a missing p falls back on target_p.
        assert zones["LYON"]["production"] == {"nuclear": 1000.0, "hydro": 300.0}
        assert zones["PARIS"]["production"] == {"gas": 400.0}
        # A generator drawing power (pump) counts as consumption; a missing
        # load p falls back on p0.
        assert zones["NANCY"]["production_total"] == 0
        assert zones["NANCY"]["consumption"] == pytest.approx(250.0)
        assert zones["LYON"]["consumption"] == pytest.approx(800.0)

    def test_reconstructed_rte7000_genres(self):
        # The Game Mode "France THT" grids spell oil FUEL (THERMAL in IIDM:
        # it must not read as gas), combined-cycle CCG, pumped storage STEP.
        net = FakeNetwork(
            substations={"S": {"name": "", "country": "FR", "regionCvg": "LYON"},
                         "S2": {"name": "", "country": "FR", "regionCvg": "PARIS"}},
            vls={"V": "S", "V2": "S2"},
            generators={"G_FUEL": _gen("V", -10.0, source="THERMAL", genre="FUEL"),
                        "G_CCG": _gen("V", -20.0, source="THERMAL", genre="CCG"),
                        "G_STEP": _gen("V", -30.0, source="HYDRO", genre="STEP"),
                        "G_AUTRE": _gen("V", -40.0, source="THERMAL", genre="AUTRE")},
        )
        payload = build_context_map(capture_snapshot(net), layout={}).payload
        assert payload["zones"][0]["production"] == {"oil": 10.0, "gas": 20.0, "storage": 30.0, "other": 40.0}
        # No neighbour in the network: no net-export headline (not "0 MW").
        assert payload["totals"]["net_export"] is None

    def test_transfers(self, french_map):
        _, cmap = french_map
        flows = {(f["from"], f["to"]): f for f in cmap.payload["flows"]}
        # Mean of both ends; oriented by the sign; open ends carry nothing.
        assert flows[("LYON", "PARIS")]["mw"] == pytest.approx(497.5)
        assert flows[("LYON", "PARIS")]["kind"] == "inter_zone"
        assert flows[("NANCY", "PARIS")]["mw"] == pytest.approx(301.0)
        assert flows[("IT", "LYON")]["direction"] == "import"
        assert flows[("IT", "LYON")]["mw"] == pytest.approx(802.5)
        # The HVDC converter stations read as branch ends.
        assert flows[("LYON", "ES")]["mw"] == pytest.approx(199.0)
        assert flows[("LYON", "ES")]["direction"] == "export"
        # Foreign ↔ foreign is not drawn on the region mesh; the dead line neither.
        assert not any({"ES", "IT"} == {a, b} for a, b in flows)
        assert ("LYON", "NANCY") not in flows and ("NANCY", "LYON") not in flows
        assert cmap.payload["flows_available"] is True

    def test_totals(self, french_map):
        _, cmap = french_map
        totals = cmap.payload["totals"]
        assert totals["production"] == pytest.approx(1700.0)
        assert totals["consumption"] == pytest.approx(800.0 + 1500.0 + 250.0)
        # Home exports: 199 MW to Spain, 802.5 MW imported from Italy.
        assert totals["net_export"] == pytest.approx(199.0 - 802.5)

    def test_france_frame_and_placement(self, french_map):
        _, cmap = french_map
        payload = cmap.payload
        assert payload["frame"] == "geo" and payload["georef"] is None
        assert payload["case_date"].startswith("2026-01-10T17:30")
        lon_min, lon_max, lat_min, lat_max = geography.FRANCE_VIEW
        x0, _ = geography.project(lon_min, 0, geography.FRANCE_LAT0)
        assert payload["bounds"][0] == pytest.approx(x0)
        assert payload["bounds"][1] == pytest.approx(-lat_max)
        zones = {z["id"]: z for z in payload["zones"]}
        # Pivot city; a region with a pie tweak uses it.
        assert (zones["LYON"]["x"], zones["LYON"]["y"]) == pytest.approx(
            geography.project(*geography.REGION_POS["LYON"], geography.FRANCE_LAT0))
        assert zones["PARIS"]["y"] == pytest.approx(-geography.REGION_PIE_POS["PARIS"][1])
        assert zones["LYON"]["label_side"] == "left"
        assert "badge" in zones["ES"] and "badge" in zones["IT"]
        # France drawn in the light "home" fill, the neighbours dark.
        active = {c["iso"] for c in payload["basemap"] if c["active"]}
        assert {"FR", "ES", "IT"} <= active
        assert {lab["text"] for lab in payload["country_labels"]} >= {"Spain", "Italy"}

    def test_element_without_georeference_falls_back_on_zones(self, french_map):
        snap, cmap = french_map
        el = element_geometry(cmap, snap, "L_LYON_PARIS")
        assert el["kind"] == "branch" and el["name"] == "Lyon-Paris"
        assert el["zones"] == ["LYON", "PARIS"]
        assert el["points"] is None
        assert el["zone_points"][0] == pytest.approx(list(cmap.zone_xy["LYON"]))
        gen = element_geometry(cmap, snap, "G_NUC")
        assert gen["kind"] == "injection" and gen["zones"] == ["LYON"]
        assert element_geometry(cmap, snap, "NOPE") is None


def _country_network(positions=None) -> FakeNetwork:
    return FakeNetwork(
        substations={"S_FR": {"name": "", "country": "FR", "regionCvg": None},
                     "S_DE": {"name": "", "country": "DE", "regionCvg": None},
                     "S_BE": {"name": "", "country": "BE", "regionCvg": None}},
        vls={"V_FR": "S_FR", "V_DE": "S_DE", "V_BE": "S_BE"},
        lines={"L1": _line("V_FR", "V_DE", -120.0, 121.0), "L2": _line("V_BE", "V_FR", 60.0, -59.0)},
        generators={"G1": _gen("V_DE", -500.0)},
        loads={"LD1": {"voltage_level_id": "V_FR", "p": 300.0, "p0": 300.0, "connected": True}},
        positions=positions,
    )


class TestCountryMesh:
    def test_falls_back_to_countries_without_regions(self):
        cmap = build_context_map(capture_snapshot(_country_network()), layout={})
        payload = cmap.payload
        assert payload["mesh"] == "country" and payload["home"] is None
        assert {z["id"]: z["kind"] for z in payload["zones"]} == {
            "BE": "country", "DE": "country", "FR": "country"}
        flows = {(f["from"], f["to"]): f["mw"] for f in payload["flows"]}
        assert flows == pytest.approx({("DE", "FR"): 120.5, ("BE", "FR"): 59.5})
        assert all(f["kind"] == "inter_zone" for f in payload["flows"])
        # Countries sit at their mainland centroid; no net export headline.
        de = next(z for z in payload["zones"] if z["id"] == "DE")
        lon, lat = geography.label_point("DE")
        assert de["y"] == pytest.approx(-lat)
        assert payload["totals"]["net_export"] is None

    def test_substation_position_extension_places_elements(self):
        positions = {"S_FR": {"latitude": 48.85, "longitude": 2.35},
                     "S_DE": {"latitude": 52.52, "longitude": 13.40},
                     "S_BE": {"latitude": 50.85, "longitude": 4.35}}
        net = _country_network(positions)
        snap = capture_snapshot(net)
        cmap = build_context_map(snap, layout={})
        assert cmap.payload["georef"] == "substation_position"
        el = element_geometry(cmap, snap, "L1")
        assert el["points"][0] == pytest.approx(list(geography.project(2.35, 48.85, cmap.lat0)))

    def test_available_with_two_zones_on_the_ground(self):
        payload = build_context_map(capture_snapshot(_country_network()), layout={}).payload
        assert payload["available"] is True and payload["frame"] == "geo"


class TestPrerequisite:
    """No Context tab for a network that cannot place two zones on the map."""

    def test_unavailable_without_countries(self):
        net = FakeNetwork(
            substations={"S1": {"name": "", "country": None, "regionCvg": None}},
            vls={"V1": "S1", "V2": "S1"},
            loads={"LD": {"voltage_level_id": "V1", "p": 10.0, "p0": 10.0, "connected": True}},
        )
        cmap = build_context_map(capture_snapshot(net), layout={"V1": (0.0, 0.0), "V2": (10.0, 20.0)})
        assert cmap.payload["available"] is False
        assert "carry no country" in cmap.payload["unavailable_reason"]
        assert "zones" not in cmap.payload

    def test_unavailable_for_a_single_zone(self):
        # A France-only grid without RTE regions: one pie says little.
        net = FakeNetwork(
            substations={"S1": {"name": "", "country": "FR", "regionCvg": None},
                          "S2": {"name": "", "country": "FR", "regionCvg": None}},
            vls={"V1": "S1", "V2": "S2"},
            lines={"L1": _line("V1", "V2", 100.0, -99.0)},
            generators={"G1": _gen("V1", -500.0)},
        )
        reason = build_context_map(capture_snapshot(net), layout={}).payload["unavailable_reason"]
        assert reason.startswith("it covers a single zone (France)") and "regionCvg" in reason

    def test_france_alone_with_its_exchanges(self):
        # A France-only grid rebuilt on a real hour: its exchanges with the
        # neighbours it leaves out are fictitious loads at the borders.
        net = FakeNetwork(
            substations={"S1": {"name": "", "country": "FR", "regionCvg": None},
                         "S2": {"name": "", "country": "FR", "regionCvg": None}},
            vls={"V1": "S1", "V2": "S2"},
            lines={"L1": _line("V1", "V2", 100.0, -99.0)},
            generators={"G1": dict(_gen("V1", -5000.0, source="NUCLEAR"), carrier="Nuclear")},
            loads={"L2": {"voltage_level_id": "V2", "p": 3600.0, "p0": 3600.0, "connected": True},
                   "X_BE_V1": _exchange("V1", -1700.0, "BE"),
                   "X_IT_V2": _exchange("V2", 2100.0, "IT"),
                   "X_GB_V1": _exchange("V1", 1000.0, "GB")},
        )
        cmap = build_context_map(capture_snapshot(net), layout={})
        payload = cmap.payload
        assert payload["available"] is True
        # One zone, drawn on Carte-Front's France frame with the neighbours'
        # badges and names around it.
        assert payload["mesh"] == "country" and payload["home"] == "FR"
        assert cmap.lat0 == geography.FRANCE_LAT0 and payload["country_labels"]
        zones = {z["id"]: z for z in payload["zones"]}
        assert zones["FR"]["kind"] == "country" and zones["FR"]["placed"]
        assert all(zones[n]["kind"] == "neighbor" and "badge" in zones[n] for n in ("BE", "IT", "GB"))
        flows = {(f["from"], f["to"]): f["mw"] for f in payload["flows"]}
        assert flows == {("FR", "IT"): 2100.0, ("BE", "FR"): 1700.0, ("FR", "GB"): 1000.0}
        # France's net position headlines the summary.
        assert payload["totals"]["net_export"] == pytest.approx(1400.0)

    def test_france_alone_takes_the_rte_regions_where_it_lies(self):
        # No regionCvg, but substations on the ground (the PyPSA France
        # bundle): each takes the region of the nearest RTE substations.
        sites = {"S_LIL": (3.06, 50.63), "S_DUN": (2.38, 51.03), "S_PAR": (2.35, 48.86),
                 "S_MAR": (5.37, 43.30)}
        net = FakeNetwork(
            substations={s: {"name": "", "country": "FR", "regionCvg": None} for s in sites},
            vls={f"V{s}": s for s in sites},
            lines={"L1": _line("VS_LIL", "VS_PAR", 800.0, -790.0),
                   "L2": _line("VS_DUN", "VS_LIL", 300.0, -299.0)},
            generators={"G1": _gen("VS_DUN", -1500.0, source="NUCLEAR")},
            loads={"LD": {"voltage_level_id": "VS_PAR", "p": 1400.0, "p0": 1400.0, "connected": True}},
            positions={s: {"latitude": lat, "longitude": lon} for s, (lon, lat) in sites.items()},
        )
        payload = build_context_map(capture_snapshot(net), layout={}).payload
        assert payload["available"] is True and payload["mesh"] == "region"
        zones = {z["id"]: z["kind"] for z in payload["zones"]}
        assert zones == {"LILLE": "region", "PARIS": "region", "MARSEILLE": "region"}
        flows = {(f["from"], f["to"]): f["mw"] for f in payload["flows"]}
        assert flows == {("LILLE", "PARIS"): pytest.approx(795.0)}

    def test_rte_line_codes_name_the_region(self):
        # Nogent-sur-Seine's nuclear plant lies nearer Paris' RTE substations,
        # but its line code names Boctois – Méry-sur-Seine: NANCY's, as RTE
        # tags them.
        sites = {"S_NOG": (3.52, 48.52), "S_MERY": (3.89, 48.51), "S_PAR": (2.35, 48.86)}
        net = FakeNetwork(
            substations={s: {"name": "", "country": "FR", "regionCvg": None} for s in sites},
            vls={f"V{s}": s for s in sites},
            lines={"BOCTOL72M.SEI": dict(_line("VS_NOG", "VS_MERY", 900.0, -899.0),
                                         name="BOCTOL72M.SEI"),
                   "L2": _line("VS_MERY", "VS_PAR", 600.0, -598.0)},
            positions={s: {"latitude": lat, "longitude": lon} for s, (lon, lat) in sites.items()},
        )
        snap = capture_snapshot(net)
        payload = build_context_map(snap, layout={}).payload
        assert snap.substation_region == {"S_NOG": "NANCY", "S_MERY": "NANCY", "S_PAR": "PARIS"}
        flows = {(f["from"], f["to"]): f["mw"] for f in payload["flows"]}
        assert flows == {("NANCY", "PARIS"): pytest.approx(599.0)}

    def test_regions_are_inferred_for_france_alone_only(self):
        # A grid spanning countries keeps the country mesh.
        sites = {"S_LIL": ("FR", 3.06, 50.63), "S_PAR": ("FR", 2.35, 48.86),
                 "S_DE": ("DE", 8.68, 50.11)}
        net = FakeNetwork(
            substations={s: {"name": "", "country": c, "regionCvg": None} for s, (c, _, _) in sites.items()},
            vls={f"V{s}": s for s in sites},
            lines={"L1": _line("VS_DE", "VS_LIL", 500.0, -499.0)},
            positions={s: {"latitude": lat, "longitude": lon} for s, (_, lon, lat) in sites.items()},
        )
        payload = build_context_map(capture_snapshot(net), layout={}).payload
        assert payload["mesh"] == "country"
        assert {z["id"] for z in payload["zones"]} == {"FR", "DE"}

    def test_service_serves_the_reason_and_no_elements(self):
        svc = ContextMapService()
        net = FakeNetwork(substations={"S1": {"name": "", "country": None, "regionCvg": None}},
                          vls={"V1": "S1"}, lines={"L1": _line("V1", "V1", 1.0, -1.0)})
        svc.capture(net)
        payload = svc.get_map().payload
        assert payload["available"] is False and payload["capture_id"] >= 1
        assert svc.elements(["L1"]) == []


def _exchange(vl, p, neighbour):
    return {"voltage_level_id": vl, "p": p, "p0": p, "connected": True,
            "type": "FICTITIOUS", "neighbour": neighbour}


def _situation_network() -> FakeNetwork:
    """A real hour rebuilt on a PyPSA-EUR grid (build_situation.py): fuel-
    tagged generators, nuclear units naming their plant, and the exchanges
    the grid leaves out as fictitious loads."""
    return FakeNetwork(
        substations={c: {"name": c, "country": c, "regionCvg": None} for c in ("FR", "DE", "IT", "GR")},
        vls={f"V_{c}": c for c in ("FR", "DE", "IT", "GR")},
        lines={"L_DE_FR": _line("V_DE", "V_FR", 500.0, -498.0),
               "L_IT_FR": _line("V_IT", "V_FR", -200.0, 201.0)},
        generators={
            "G_FR_NUC1": dict(_gen("V_FR", -900.0, source="NUCLEAR", max_p=1300.0), name="Gravelines 1",
                              plant="Gravelines", plant_lon="2.13610", plant_lat="51.01560"),
            "G_FR_NUC2": dict(_gen("V_FR", -700.0, source="NUCLEAR", max_p=1300.0), name="Gravelines 2",
                              plant="Gravelines", plant_lon="2.13610", plant_lat="51.01560"),
            "G_DE_LIG": dict(_gen("V_DE", -3000.0, source="THERMAL"), carrier="Lignite"),
            "G_DE_GAS": dict(_gen("V_DE", -1000.0, source="THERMAL"), carrier="Natural Gas"),
            "G_DE_ROR": dict(_gen("V_DE", -200.0, source="HYDRO"), carrier="Run-Of-River"),
            "G_IT_GAS": dict(_gen("V_IT", -2000.0, source="THERMAL"), carrier="Natural Gas"),
            "G_GR_GAS": dict(_gen("V_GR", -100.0, source="THERMAL"), carrier="Natural Gas"),
        },
        loads={
            "L_FR": {"voltage_level_id": "V_FR", "p": 4000.0, "p0": 4000.0, "connected": True},
            "L_DE": {"voltage_level_id": "V_DE", "p": 3700.0, "p0": 3700.0, "connected": True},
            "L_IT": {"voltage_level_id": "V_IT", "p": 1400.0, "p0": 1400.0, "connected": True},
            "L_GR": {"voltage_level_id": "V_GR", "p": 500.0, "p0": 500.0, "connected": True},
            "X_GB_FR": _exchange("V_FR", -1900.0, "GB"),   # Great Britain → France
            "X_NO_DE": _exchange("V_DE", -1000.0, "NO"),   # Norway → Germany
            # An HVDC link inside the grid: one fictitious load at each end.
            "X_GR_IT": _exchange("V_IT", 400.0, "GR"),
            "X_IT_GR": _exchange("V_GR", -400.0, "IT"),
        },
    )


class TestRebuiltSituation:
    """A PyPSA-EUR situation rebuilt on a real hour (``build_situation.py``)."""

    @pytest.fixture
    def cmap(self):
        snap = capture_snapshot(_situation_network())
        return snap, build_context_map(snap, layout={})

    def test_fuel_tags_type_the_production(self, cmap):
        _, built = cmap
        de = next(z for z in built.payload["zones"] if z["id"] == "DE")
        # Lignite is coal and gas is gas, not the THERMAL default; hydro too.
        assert de["production"] == {"gas": 1000.0, "coal": 3000.0, "hydro": 200.0}

    def test_exchanges_are_not_consumption(self, cmap):
        snap, built = cmap
        assert "X_GB_FR" not in snap.loads.index and len(snap.exchanges) == 4
        fr = next(z for z in built.payload["zones"] if z["id"] == "FR")
        assert fr["consumption"] == 4000.0

    def test_exchanges_drawn_towards_the_neighbours(self, cmap):
        _, built = cmap
        zones = {z["id"]: z for z in built.payload["zones"]}
        # Countries the grid leaves out become neighbour badges, placed.
        assert zones["GB"]["kind"] == zones["NO"]["kind"] == "neighbor"
        assert zones["GB"]["placed"] and zones["GB"]["label"] == "United Kingdom"
        assert zones["FR"]["kind"] == "country" and "badge" not in zones["GB"]
        flows = {(f["from"], f["to"]): (f["mw"], f["kind"]) for f in built.payload["flows"]}
        assert flows[("GB", "FR")] == (1900.0, "border")
        assert flows[("NO", "DE")] == (1000.0, "border")
        # The HVDC link inside the grid counts once, from its exporting end.
        assert flows[("IT", "GR")] == (400.0, "inter_zone")
        # France's net position: 499 MW in from Germany, 200.5 out to Italy,
        # 1 900 in from Great Britain.
        assert zones["FR"]["net_export"] == pytest.approx(-499.0 + 200.5 - 1900.0)
        # Inside totals leave the neighbours out.
        assert built.payload["totals"]["production"] == pytest.approx(7900.0)

    def test_nuclear_units_named_and_placed_by_their_plant(self, cmap):
        _, built = cmap
        nuclear = built.payload["nuclear"]
        (plant,) = nuclear["plants"]
        assert plant["name"] == "Gravelines" and plant["units"] == 2
        assert plant["production"] == 1600.0 and plant["capacity"] == 2600.0
        # Real output, read off the network: no "estimated" flag.
        assert plant["matched"] is False
        x, y = geography.project(2.1361, 51.0156, built.lat0)
        assert (plant["x"], plant["y"]) == pytest.approx((x, y))
        assert sorted(u["name"] for u in nuclear["units"]) == ["Gravelines 1", "Gravelines 2"]

    def test_situation_file_beside_the_network(self, tmp_path):
        record = {"schema": "costudy4grid-situation/1", "at_utc": "2025-01-14T08:00Z", "dispatch": "opf",
                  "sources": [{"name": "Energy-Charts (Fraunhofer ISE)", "url": "https://www.energy-charts.info",
                               "licence": "CC BY 4.0", "attribution": "energy-charts.info"}],
                  "countries": {}}
        (tmp_path / SITUATION_FILE_NAME).write_text(json.dumps(record), encoding="utf-8")
        (tmp_path / "network.xiidm").write_text("<x/>", encoding="utf-8")
        svc = ContextMapService()
        svc.capture(_situation_network(), network_path=str(tmp_path / "network.xiidm"))
        situation = svc.get_map().payload["situation"]
        assert situation == {"at_utc": "2025-01-14T08:00Z", "dispatch": "opf", "sources": [{
            "name": "Energy-Charts (Fraunhofer ISE)", "url": "https://www.energy-charts.info",
            "licence": "CC BY 4.0"}]}
        # Another schema, or no file: no hour.
        (tmp_path / SITUATION_FILE_NAME).write_text(json.dumps(dict(record, schema="x/1")), encoding="utf-8")
        assert load_situation(tmp_path / SITUATION_FILE_NAME) is None
        assert build_context_map(capture_snapshot(_situation_network()), layout={}).payload["situation"] is None


class TestNuclear:
    """Carte-Front's nuclear units layer, on the region mesh."""

    @pytest.fixture
    def nuclear(self):
        nuc = {"source": "NUCLEAR", "genre": "NUCLEAIRE"}
        net = FakeNetwork(
            substations={
                "BUGEY": {"name": "", "country": "FR", "regionCvg": "LYON"},
                "CATG1": {"name": "", "country": "FR", "regionCvg": "NANCY"},
                "CATG2": {"name": "", "country": "FR", "regionCvg": "NANCY"},
                "S_GRAV": {"name": "Centrale de Gravelines", "country": "FR", "regionCvg": "LILLE"},
                "S_UNKNOWN": {"name": "Somewhere", "country": "FR", "regionCvg": "PARIS"},
                "S_BE": {"name": "Doel", "country": "BE", "regionCvg": None},
            },
            vls={"V_BUG": "BUGEY", "V_CAT1": "CATG1", "V_CAT2": "CATG2", "V_GRAV": "S_GRAV",
                 "V_UNK": "S_UNKNOWN", "V_BE": "S_BE"},
            generators={
                "BUG_1": _gen("V_BUG", -900.0, max_p=900.0, **nuc),
                # Disconnected: its set point must not make it run.
                "BUG_2": _gen("V_BUG", NAN, target=900.0, max_p=900.0, connected=False, **nuc),
                "CAT_1": _gen("V_CAT1", -650.0, max_p=1300.0, **nuc),
                # Unsolved file: no p, the set point stands in.
                "CAT_2": _gen("V_CAT2", NAN, target=1300.0, max_p=1300.0, **nuc),
                "GRAV_1": _gen("V_GRAV", -0.5, max_p=950.0, source="NUCLEAR"),
                "UNK_1": _gen("V_UNK", -800.0, max_p=900.0, **nuc),
                "BE_1": _gen("V_BE", -1000.0, max_p=1000.0, **nuc),
            },
        )
        cmap = build_context_map(capture_snapshot(net), layout={})
        return cmap, cmap.payload["nuclear"]

    def test_plants_gathered_and_placed_on_real_coordinates(self, nuclear):
        cmap, layer = nuclear
        plants = {p["id"]: p for p in layer["plants"]}
        # Split substations (CATG1/CATG2) under one plant; a name match; the
        # foreign unit (region mesh) and the unplaceable plant are left out.
        assert set(plants) == {"Bugey", "Cattenom", "Gravelines"}
        assert plants["Cattenom"]["units"] == 2
        x, y = geography.project(*PLANT_LONLAT["Cattenom"], cmap.lat0)
        assert (plants["Cattenom"]["x"], plants["Cattenom"]["y"]) == pytest.approx((x, y))
        assert {u["id"] for u in layer["units"]} == {"BUG_1", "BUG_2", "CAT_1", "CAT_2", "GRAV_1"}

    def test_levels_and_running_state(self, nuclear):
        _, layer = nuclear
        units = {u["id"]: u for u in layer["units"]}
        assert units["BUG_1"]["running"] and units["BUG_1"]["level"] == pytest.approx(1.0)
        assert not units["BUG_2"]["running"] and units["BUG_2"]["p"] == 0.0
        assert units["CAT_1"]["level"] == pytest.approx(0.5)
        assert units["CAT_2"]["running"] and units["CAT_2"]["p"] == pytest.approx(1300.0)
        assert not units["GRAV_1"]["running"]  # under 1 MW
        bugey = next(p for p in layer["plants"] if p["id"] == "Bugey")
        assert (bugey["running"], bugey["production"], bugey["capacity"]) == (1, 900.0, 1800.0)

    def test_plant_matching_and_ring(self):
        assert plant_of("SSAL7", "") == "Saint-Alban"
        assert plant_of("FESS5", "FESS5") == "Fessenheim"
        assert plant_of("X1", "Centrale nucléaire de SAINT-LAURENT-des-Eaux") == "Saint-Laurent"
        assert plant_of("X1", "Lyon") is None
        assert ring_offsets(1, 46.6) == [(0.0, 0.0)]
        ring = ring_offsets(6, 46.6)
        assert len(ring) == 6 and ring[0][0] == pytest.approx(0.0)
        assert math.hypot(ring[0][0], ring[0][1]) == pytest.approx(0.052)


# --- Georeferencing ------------------------------------------------------------

#: Spread-out French cities (lon, lat) — a network that fills its country.
CITIES = {
    "PARIS": (2.35, 48.86), "LYON": (4.84, 45.76), "MARSEILLE": (5.37, 43.30),
    "BORDEAUX": (-0.58, 44.84), "LILLE": (3.06, 50.63), "STRASBOURG": (7.75, 48.57),
    "BREST": (-4.49, 48.39), "NICE": (7.26, 43.70), "TOULOUSE": (1.44, 43.60),
    "NANTES": (-1.55, 47.22), "PERPIGNAN": (2.90, 42.70), "DUNKERQUE": (2.38, 51.03),
    "CHERBOURG": (-1.62, 49.64), "BIARRITZ": (-1.56, 43.48), "METZ": (6.18, 49.12),
    "GRENOBLE": (5.72, 45.19), "CLERMONT": (3.08, 45.78), "DIJON": (5.04, 47.32),
    "ROUEN": (1.10, 49.44), "LIMOGES": (1.26, 45.83), "MULHOUSE": (7.34, 47.75),
    "LA_ROCHELLE": (-1.15, 46.16), "MONTPELLIER": (3.88, 43.61), "REIMS": (4.03, 49.26),
}


def _city_network() -> FakeNetwork:
    return FakeNetwork(
        substations={f"S_{c}": {"name": c, "country": "FR", "regionCvg": None} for c in CITIES},
        vls={f"V_{c}": f"S_{c}" for c in CITIES},
    )


def _km(a, b) -> float:
    return math.hypot((a[0] - b[0]) * math.cos(math.radians(a[1])) * 111.0, (a[1] - b[1]) * 111.0)


def _plants_file(tmp_path, generators):
    path = tmp_path / PLANTS_FILE_NAME
    path.write_text(json.dumps({
        "schema": PLANTS_SCHEMA,
        "source": {"name": "powerplantmatching", "url": "https://x", "licence": "CC BY 4.0"},
        "generators": generators,
    }), encoding="utf-8")
    return path


def _untyped_network() -> FakeNetwork:
    """The PyPSA-EUR shape: one untyped generator per bus, all at the same
    set point — the substation of a 5 GW nuclear plant included."""
    return FakeNetwork(
        substations={"S_FR": {"name": "", "country": "FR", "regionCvg": None},
                     "S_FR2": {"name": "", "country": "FR", "regionCvg": None},
                     "S_DE": {"name": "", "country": "DE", "regionCvg": None},
                     "S_IT": {"name": "", "country": "IT", "regionCvg": None}},
        vls={"V_FR": "S_FR", "V_FR2": "S_FR2", "V_DE": "S_DE", "V_IT": "S_IT"},
        generators={"G_FR": _gen("V_FR", -16.0, max_p=24.0), "G_FR2": _gen("V_FR2", -16.0, max_p=24.0),
                    "G_DE": _gen("V_DE", -16.0, max_p=24.0, source="WIND"),
                    "G_IT": _gen("V_IT", -16.0, max_p=24.0)},
    )


class TestPlantMatching:
    """``power_plants.json`` beside an untyped network (PyPSA-EUR bundles)."""

    GRAVELINES = {"name": "Gravelines", "lon": 2.1361, "lat": 51.0156,
                  "units": [["Gravelines 1", 2730.0], ["Gravelines 2", 2730.0]]}
    GENERATORS = {
        # Gravelines + a solar farm on G_FR; pumped storage split from hydro.
        "G_FR": {"capacity_mw": {"Nuclear": 5460.0, "Solar": 60.0, "Hydro": 0.0},
                 "sites": {"Nuclear": GRAVELINES}},
        "G_FR2": {"capacity_mw": {"Hydro": 300.0, "Pumped Storage": 100.0, "Waste": 0.0}},
        # The network already types G_DE (WIND): its matching must not win.
        "G_DE": {"capacity_mw": {"Lignite": 2000.0}},
    }
    #: Typical output of the French fleet: capacity × load factor.
    FR_FLEET = {"nuclear": 5460 * 0.75, "solar": 60 * 0.12, "hydro": 300 * 0.35, "storage": 100 * 0.08}

    def test_load_and_resolve(self, tmp_path):
        matching = load_plant_matching(_plants_file(tmp_path, self.GENERATORS))
        assert matching.expected["G_FR"] == pytest.approx({"nuclear": 4095.0, "solar": 7.2})
        assert matching.expected["G_FR2"] == pytest.approx({"hydro": 105.0, "storage": 8.0})
        site = matching.nuclear_sites["G_FR"]
        assert (site.name, site.lon, site.lat, site.capacity) == ("Gravelines", 2.1361, 51.0156, 5460.0)
        assert site.units == [("Gravelines 1", 2730.0), ("Gravelines 2", 2730.0)]
        assert matching.source["licence"] == "CC BY 4.0"
        net = tmp_path / "network.xiidm"
        assert resolve_plants_path(str(net)) == tmp_path / PLANTS_FILE_NAME
        assert resolve_plants_path(None) is None
        # Absent, unreadable or of another schema: no matching, no crash.
        assert load_plant_matching(None) is None
        (tmp_path / "bad.json").write_text("{not json")
        assert load_plant_matching(tmp_path / "bad.json") is None
        (tmp_path / "other.json").write_text(json.dumps({"schema": "x/9", "generators": {}}))
        assert load_plant_matching(tmp_path / "other.json") is None

    def test_zone_production_typed_by_its_fleet(self, tmp_path):
        snap = capture_snapshot(_untyped_network())
        snap.plants = load_plant_matching(_plants_file(tmp_path, self.GENERATORS))
        payload = build_context_map(snap, layout={}).payload
        zones = {z["id"]: z for z in payload["zones"]}
        # France's 32 MW (two 16 MW substations) typed AS A WHOLE by its
        # fleet's typical output — not substation by substation, where the
        # nuclear site's bus would weigh as much as the hydro one.
        total = sum(self.FR_FLEET.values())
        assert zones["FR"]["production"] == pytest.approx(
            {f: round(32 * mw / total, 1) for f, mw in self.FR_FLEET.items()}, abs=0.1)
        assert zones["FR"]["production"]["nuclear"] / 32 > 0.95
        # The network's own typing wins; a zone without plants stays "other".
        assert zones["DE"]["production"] == {"wind": 16.0}
        assert zones["IT"]["production"] == {"other": 16.0}
        assert payload["totals"]["production"] == pytest.approx(64.0)  # unchanged: types only
        assert payload["plant_source"]["name"] == "powerplantmatching"

    def test_nuclear_plant_drawn_unit_by_unit_at_real_capacity(self, tmp_path):
        snap = capture_snapshot(_untyped_network())
        snap.plants = load_plant_matching(_plants_file(tmp_path, self.GENERATORS))
        cmap = build_context_map(snap, layout={})
        (plant,) = cmap.payload["nuclear"]["plants"]
        # Real site, real capacity; its output is the pie's nuclear slice.
        nuclear_slice = next(z for z in cmap.payload["zones"] if z["id"] == "FR")["production"]["nuclear"]
        assert plant["name"] == "Gravelines" and plant["matched"] and plant["units"] == 2
        assert plant["capacity"] == 5460.0
        assert plant["production"] == pytest.approx(nuclear_slice, abs=0.2)
        cx, cy = geography.project(2.1361, 51.0156, cmap.lat0)
        assert (plant["x"], plant["y"]) == pytest.approx((cx, cy))
        units = cmap.payload["nuclear"]["units"]
        assert [u["name"] for u in units] == ["Gravelines 1", "Gravelines 2"]
        assert all(u["pmax"] == 2730.0 and u["running"] for u in units)
        assert units[0]["level"] == pytest.approx(units[0]["p"] / 2730.0, rel=0.02)

    def test_without_matching_nothing_changes(self):
        payload = build_context_map(capture_snapshot(_untyped_network()), layout={}).payload
        assert {z["id"]: z["production"] for z in payload["zones"]} == {
            "FR": {"other": 32.0}, "DE": {"wind": 16.0}, "IT": {"other": 16.0}}
        assert payload["plant_source"] is None
        assert payload["nuclear"] == {"plants": [], "units": []}

    def test_service_reads_the_file_beside_the_network(self, tmp_path):
        _plants_file(tmp_path, self.GENERATORS)
        service = ContextMapService()
        service.capture(_untyped_network(), layout_path=None, network_path=str(tmp_path / "network.xiidm"))
        assert service.get_map().payload["plant_source"]["licence"] == "CC BY 4.0"


class TestGeoreference:
    def test_mercator_layout_is_recovered(self):
        """PyPSA-EUR layouts: raw Web-Mercator metres, centred, y down."""
        merc = {f"V_{c}": (math.radians(lon) * MERCATOR_RADIUS_M,
                           -math.log(math.tan(math.pi / 4 + math.radians(lat) / 2)) * MERCATOR_RADIUS_M)
                for c, (lon, lat) in CITIES.items()}
        cx = (max(x for x, _ in merc.values()) + min(x for x, _ in merc.values())) / 2
        cy = (max(y for _, y in merc.values()) + min(y for _, y in merc.values())) / 2
        layout = {k: (x - cx, y - cy) for k, (x, y) in merc.items()}
        snap = capture_snapshot(_city_network())
        geo = fit_layout(layout, snap, build_zoning(snap))
        assert geo is not None and geo.method == "layout"
        errors = [_km(geo.vl_lonlat[f"V_{c}"], ll) for c, ll in CITIES.items()]
        assert np.median(errors) < 30.0

    def test_op4grid_plan_frame_uses_carte_front_calibration(self):
        """A layout in the RTE op4grid plan frame maps through its affine."""
        (al, bl, cl), (aa, ba, ca) = OP4GRID_PLAN_AFFINE
        inverse = np.linalg.inv(np.array([[al, bl], [aa, ba]]))
        layout = {}
        for c, (lon, lat) in CITIES.items():
            x, y = inverse @ np.array([lon - cl, lat - ca])
            layout[f"V_{c}"] = (float(x), float(y))
        snap = capture_snapshot(_city_network())
        geo = georeference(snap, build_zoning(snap), layout)
        assert geo.method == "op4grid_plan"
        assert geo.vl_lonlat["V_LYON"] == pytest.approx(CITIES["LYON"], abs=1e-6)

    def test_partial_network_is_not_stretched_over_its_country(self):
        """A cluster along a line cannot be fitted to France's box."""
        layout = {f"V_{c}": (i * 1000.0, i * 3.0) for i, c in enumerate(CITIES)}
        snap = capture_snapshot(_city_network())
        geo = georeference(snap, build_zoning(snap), layout)
        assert geo.method is None and geo.vl_lonlat == {}

    def test_load_layout_points_skips_bad_entries(self, tmp_path):
        path = tmp_path / "grid_layout.json"
        path.write_text('{"A": [1, 2], "B": [null, 3], "C": "x", "D": [4.5, -1]}')
        assert load_layout_points(path) == {"A": (1.0, 2.0), "D": (4.5, -1.0)}
        assert load_layout_points(tmp_path / "missing.json") == {}
        assert load_layout_points(None) == {}


class TestGeography:
    def test_points_in_rings(self):
        square = np.array([[0, 0], [2, 0], [2, 2], [0, 2]], dtype=float)
        inside = geography.points_in_rings(np.array([[1, 1], [3, 1], [1, -1]]), [square])
        assert inside.tolist() == [True, False, False]

    def test_basemap_covers_europe_and_france_label_point_is_inside(self):
        basemap = geography.load_basemap()
        assert {"FR", "DE", "ES", "IT", "GB", "PL", "NO"} <= set(basemap)
        point = np.array([geography.label_point("FR")])
        assert geography.points_in_rings(point, basemap["FR"]["rings"])[0]

    def test_mercator_round_trip(self):
        assert geography.inverse_mercator_y(geography.mercator_y(47.3)) == pytest.approx(47.3)


class TestService:
    def test_lazy_build_capture_id_and_elements(self, french_network):
        service = ContextMapService()
        assert service.get_map() is None and service.elements(["L_LYON_PARIS"]) == []
        service.capture(french_network)
        first = service.get_map()
        assert first is service.get_map()  # cached
        assert first.payload["capture_id"] == 1
        assert [e["id"] for e in service.elements(["L_LYON_PARIS", "NOPE"])] == ["L_LYON_PARIS"]
        service.capture(french_network)
        assert service.get_map().payload["capture_id"] == 2

    def test_capture_never_raises(self):
        broken = MagicMock()
        broken.get_voltage_levels.side_effect = RuntimeError("boom")
        service = ContextMapService()
        service.capture(broken)
        assert service.get_map() is None

    def test_layout_beside_the_network_file(self, tmp_path):
        net = tmp_path / "network.xiidm"
        net.write_text("")
        assert resolve_layout_path(None, str(net)) is None
        (tmp_path / "grid_layout.json").write_text("{}")
        assert resolve_layout_path(None, str(net)) == tmp_path / "grid_layout.json"
        assert resolve_layout_path("custom.json", str(net)).name == "custom.json"


class TestRoutes:
    @pytest.fixture
    def client(self, monkeypatch):
        from expert_backend import context_map_api
        from expert_backend.main import app
        service = ContextMapService()
        monkeypatch.setattr(context_map_api, "context_map_service", service)
        return TestClient(app), service

    def test_404_before_a_study_is_loaded(self, client):
        http, _ = client
        response = http.get("/api/context-map")
        assert response.status_code == 404
        assert response.json()["code"] == "NOT_FOUND"
        assert http.post("/api/context-map/elements", json={"element_ids": []}).status_code == 404

    def test_map_and_elements(self, client, french_network):
        http, service = client
        service.capture(french_network)
        response = http.get("/api/context-map", headers={"accept-encoding": "gzip"})
        assert response.status_code == 200
        assert response.headers.get("content-encoding") == "gzip"  # the basemap is heavy
        assert response.json()["mesh"] == "region"
        found = http.post("/api/context-map/elements", json={"element_ids": ["L_LYON_IT"]}).json()
        assert found["elements"][0]["zones"] == ["LYON", "IT"]

    def test_element_lookup_is_bounded(self, client, french_network):
        http, service = client
        service.capture(french_network)
        response = http.post("/api/context-map/elements", json={"element_ids": ["x"] * 501})
        assert response.status_code == 400
