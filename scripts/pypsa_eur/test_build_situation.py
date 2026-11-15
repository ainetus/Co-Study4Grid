"""
test_build_situation.py
=======================

Unit tests for ``build_situation.py`` (rebuild a bundle on a real hour) and
``fetch_energy_charts.py`` (the hour's observed data), on hand-built tables
and a four-bus node-breaker network: fuel types from the data's series,
balanced loads, the plant table and its missing capacity, the observed
dispatch, the exchanges the grid leaves out, marginal costs — and one
end-to-end build with its AC load flow.

Usage::

    pytest scripts/pypsa_eur/test_build_situation.py -v
"""
from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

HERE = Path(__file__).resolve().parent


def _load(name: str):
    spec = importlib.util.spec_from_file_location(name, HERE / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module  # dataclasses resolve their module's annotations
    spec.loader.exec_module(module)
    return module


bs = _load("build_situation")
fec = _load("fetch_energy_charts")

AT = "2025-01-14T08:00Z"


def _grid() -> "bs.Grid":
    buses = pd.DataFrame({
        "bus": ["fr_a-400", "fr_b-400", "de_c-380", "lt_d-400"],
        "country": ["FR", "FR", "DE", "LT"],
        "name": ["Alpha", "Bravo", "Charlie", "Delta"],
        "target_v": [400.0, 400.0, 380.0, 400.0],
        "key": [30.0, 10.0, 20.0, 5.0],
        "lon": [2.1, 4.8, 9.0, 23.0],
        "lat": [51.0, 45.0, 53.5, 54.5],
    }, index=["VL_fr_a-400", "VL_fr_b-400", "VL_de_c-380", "VL_lt_d-400"])
    return bs.Grid(buses=buses, ac_pairs={frozenset(("FR", "DE")), frozenset(("DE", "LT"))})


PLANTS = {
    "schema": "costudy4grid-power-plants/1",
    "generators": {
        "G_fr_a-400": {"capacity_mw": {"Nuclear": 2000.0},
                       "sites": {"Nuclear": {"name": "Plant", "lon": 2.13, "lat": 51.01,
                                             "units": [["Plant 1", 1000.0], ["Plant 2", 1000.0]]}}},
        "G_fr_b-400": {"capacity_mw": {"Natural Gas": 500.0, "Solar": 100.0},
                       "efficiency": {"Natural Gas": 0.55}},
        "G_de_c-380": {"capacity_mw": {"Lignite": 1500.0, "Wind Onshore": 300.0},
                       "efficiency": {"Lignite": 0.4}},
    },
}

OBSERVED = {
    "schema": "costudy4grid-observed-hour/1",
    "at_utc": AT,
    "source": {"name": "Energy-Charts (Fraunhofer ISE)", "url": "https://www.energy-charts.info",
               "licence": "CC BY 4.0"},
    "countries": {
        "FR": {"load": 2000.0, "flows": {"DE": -300.0, "GB": 100.0},
               "production": {"nuclear": 1600.0, "fossil_gas": 200.0, "solar": 50.0},
               "installed": {"nuclear": 2000.0, "fossil_gas": 500.0, "solar_ac": 400.0, "solar_dc": 500.0}},
        "DE": {"load": 1500.0, "flows": {"FR": 300.0, "LT": -50.0},
               "production": {"fossil_brown_coal_lignite": 1100.0, "wind_onshore": 100.0},
               "installed": {}},
        "LT": {"load": 1000.0, "flows": {"DE": 50.0}, "production": {}, "installed": {}},
    },
    "missing": {},
}


def _targets(grid=None, observed=None):
    grid = grid or _grid()
    table = bs.plant_table(grid, PLANTS)
    return grid, table, bs.country_targets(grid, observed or OBSERVED, table)


# ─────────────────────────────────────────────────────────────────────────────
# Observed data → per-country targets
# ─────────────────────────────────────────────────────────────────────────────


def test_series_summed_by_fuel_type():
    # Installed solar comes as AC and DC capacity: only the first counts.
    assert bs._codes({"solar_ac": 90.0, "solar_dc": 100.0}, 1.0) == {"SOL": 90.0}
    assert bs._codes({"solar_dc": 100.0}, 1.0) == {"SOL": 100.0}
    # Pumping is negative production of the same type; coal-derived gas is coal.
    codes = bs._codes({"hydro_pumped_storage": 500.0, "hydro_pumped_storage_consumption": -800.0,
                       "fossil_hard_coal": 10.0, "fossil_coal_derived_gas": 5.0, "load": 9e9}, 0.5)
    assert codes == {"PSP": -150.0, "COA": 7.5}


def test_balanced_load():
    # Production + net imports, when the reported load is close enough.
    assert bs.balanced_load(110.0, {"NUC": 100.0}, {"DE": 20.0}) == 120.0
    assert bs.balanced_load(200.0, {"NUC": 100.0}, {"DE": 20.0}) == 200.0
    assert bs.balanced_load(110.0, {"NUC": 100.0}, {}) == 110.0


def test_country_targets_observed_boundary_and_lacking():
    grid, _, targets = _targets()
    fr, de, lt = targets["FR"], targets["DE"], targets["LT"]
    assert fr.source == "observed" and fr.production == {"NUC": 1600.0, "GAS": 200.0, "SOL": 50.0}
    # 1 850 MW produced, 200 MW net exported: the load the hour serves.
    assert fr.load == 1650.0 and fr.reported_load == 2000.0
    assert de.load == 1450.0
    assert lt.source == "boundary" and lt.load == 0.0
    # A country the data lack: synthetic load at the observed level, its
    # production = load + what observed neighbours import from it.
    grid.buses.loc["VL_lt_d-400", "country"] = "PL"
    grid.ac_pairs = {frozenset(("FR", "DE")), frozenset(("DE", "PL"))}
    observed = json.loads(json.dumps(OBSERVED))
    observed["countries"]["DE"]["flows"] = {"FR": 300.0, "PL": 40.0}
    del observed["countries"]["LT"]
    _, _, targets = _targets(grid, observed)
    pl = targets["PL"]
    k = (2000.0 + 1500.0) / (30.0 + 10.0 + 20.0)
    assert pl.source == "fallback" and pl.load == pytest.approx(5.0 * k)
    assert sum(pl.production.values()) == pytest.approx(5.0 * k + 40.0)


def test_partial_coverage_scales_a_country():
    observed = json.loads(json.dumps(OBSERVED))
    observed["countries"]["DK"] = observed["countries"].pop("DE")
    grid = _grid()
    grid.buses.loc["VL_de_c-380", "country"] = "DK"
    grid.ac_pairs = {frozenset(("FR", "DK")), frozenset(("DK", "LT"))}
    _, _, targets = _targets(grid, observed)
    # Denmark is DK1 alone: its figures scaled, its load not rebalanced.
    assert targets["DK"].load == pytest.approx(1500.0 * bs.COVERAGE["DK"])
    assert targets["DK"].production["LIG"] == pytest.approx(1100.0 * bs.COVERAGE["DK"])


# ─────────────────────────────────────────────────────────────────────────────
# Plants and dispatch
# ─────────────────────────────────────────────────────────────────────────────


def test_plant_table():
    table = bs.plant_table(_grid(), PLANTS)
    # Nuclear unit by unit, with its plant and real site.
    unit = table.loc["G_fr_a-400_NUC1"]
    assert (unit["code"], unit["capacity"], unit["name"], unit["plant"]) == ("NUC", 1000.0, "Plant 1", "Plant")
    assert (unit["plant_lon"], unit["plant_lat"]) == (2.13, 51.01)
    # Every bus's own G_<bus> is its solar generator, even without a farm.
    assert table.loc["G_fr_b-400", "code"] == "SOL" and table.loc["G_fr_b-400", "capacity"] == 100.0
    assert table.loc["G_lt_d-400", "capacity"] == 0.0
    assert table.loc["G_fr_b-400_GAS", "efficiency"] == 0.55
    assert table.loc["G_de_c-380_LIG", "country"] == "DE"


def test_complete_capacity():
    grid, table, targets = _targets()
    targets["DE"].installed = {"LIG": 6000.0, "WON": 300.0}
    targets["DE"].production["OTH"] = 50.0
    # A type no plant carries spreads by load over the largest load buses
    # (here both French buses: at least FALLBACK_BUSES of them).
    targets["FR"].production["OTH"] = 380.0
    done = bs.complete_capacity(table, grid, targets)
    assert done.loc["G_fr_a-400_OTH", "capacity"] == pytest.approx(400.0 * 30 / 40)
    assert done.loc["G_fr_b-400_OTH", "capacity"] == pytest.approx(400.0 * 10 / 40)
    # Rooftop solar: 400 installed (AC) − 100 matched, spread by load key 30:10.
    assert done.loc["G_fr_a-400", "capacity"] == pytest.approx(225.0)
    assert done.loc["G_fr_b-400", "capacity"] == pytest.approx(100.0 + 75.0)
    # Matched lignite grows at most 3× (4 500), the rest (1 500) at the
    # largest load buses — here Germany's only one, on its existing plant.
    assert done.loc["G_de_c-380_LIG", "capacity"] == pytest.approx(6000.0)
    # A type no plant was matched for gets plants at the largest load buses.
    assert done.loc["G_de_c-380_OTH", "capacity"] == pytest.approx(50.0 / 0.95)
    # Nuclear units stay as they are.
    assert done.loc["G_fr_a-400_NUC2", "capacity"] == 1000.0


def test_observed_dispatch_shares_by_capacity():
    grid, table, targets = _targets()
    table = bs.complete_capacity(table, grid, targets)
    targets["FR"].production["PSP"] = -300.0
    table.loc["G_fr_b-400_PSP"] = dict(vl="VL_fr_b-400", code="PSP", capacity=200.0, efficiency=np.nan,
                                       name=None, plant=None, plant_lon=np.nan, plant_lat=np.nan,
                                       country="FR")
    p = bs.observed_dispatch(table, targets)
    assert p["G_fr_a-400_NUC1"] == p["G_fr_a-400_NUC2"] == pytest.approx(800.0)
    assert p["G_fr_b-400_GAS"] == pytest.approx(200.0)
    assert p["G_de_c-380_LIG"] == pytest.approx(1100.0)
    # Pumping draws power; observed beyond capacity stretches the capacity.
    assert p["G_fr_b-400_PSP"] == pytest.approx(-300.0)
    assert table.loc["G_fr_b-400_PSP", "capacity"] == pytest.approx(300.0 / 0.98)
    assert sum(p[table["code"] == "SOL"]) == pytest.approx(50.0)


def test_marginal_cost():
    gas = bs.marginal_cost("GAS", 0.6)
    assert gas == pytest.approx((40.0 + 70.0 * 0.202) / 0.6 + 3.0, abs=1e-3)
    # An unknown efficiency takes the type's default; old plants cost more.
    assert bs.marginal_cost("GAS", float("nan")) > gas
    assert bs.marginal_cost("NUC", float("nan")) == 10.0
    assert bs.marginal_cost("SOL", float("nan")) == 0.0


# ─────────────────────────────────────────────────────────────────────────────
# Exchanges
# ─────────────────────────────────────────────────────────────────────────────


def _links() -> pd.DataFrame:
    return pd.DataFrame([
        ("link/gb", 1000.0, "FR", "VL_fr_a-400", "GB", None),
        ("link/de-fr", 600.0, "DE", "VL_de_c-380", "FR", "VL_fr_b-400"),
    ], columns=["link", "p_nom", "c0", "vl0", "c1", "vl1"])


def test_external_injections():
    grid, _, targets = _targets()
    targets["FR"].flows = {"DE": -300.0, "GB": 1500.0, "TR": 20.0}
    ext = bs.external_injections(grid, targets, _links())
    by_id = ext["p0"].to_dict()
    # An HVDC link out of the grid: the import, capped at the link (1 GW),
    # as a negative (fictitious) load at its converter bus.
    assert by_id["X_GB_fr_a-400"] == -1000.0
    # FR–DE is an AC border: its exchange emerges from the load flow.
    assert not any(ext["neighbour"].eq("DE") & ext["country"].eq("FR"))
    # No connection known: at the bus nearest to the border.
    assert ext.loc["X_TR_de_c-380" if "X_TR_de_c-380" in ext.index else "X_TR_fr_b-400", "p0"] == -20.0
    # The boundary country feeds what its neighbours import from it.
    assert by_id["X_LT_lt_d-400"] == 50.0


def test_hvdc_border_between_two_grid_countries_is_paired():
    grid, _, targets = _targets()
    grid.ac_pairs = {frozenset(("DE", "LT"))}          # FR–DE: HVDC only
    targets["FR"].flows = {"DE": 400.0}
    targets["DE"].flows = {"FR": -400.0, "LT": -50.0}
    ext = bs.external_injections(grid, targets, _links())
    pair = ext[ext["how"] == "hvdc"]
    assert pair.set_index("country")["p0"].to_dict() == {"FR": -400.0, "DE": 400.0}


# ─────────────────────────────────────────────────────────────────────────────
# End to end on a four-bus node-breaker network
# ─────────────────────────────────────────────────────────────────────────────


def _bay(rows, vl, eid, node0, node):
    rows += [(f"{vl}_D_{eid}", vl, node0, node, "DISCONNECTOR", False),
             (f"{vl}_BK_{eid}", vl, node, node + 1, "BREAKER", False)]
    return node + 1


def _mini_network(path: Path) -> None:
    import pypowsybl as pp
    n = pp.network.create_empty("pypsa_eur_mini")
    buses = {"fr_a-400": ("FR", 400.0), "fr_b-400": ("FR", 400.0),
             "de_c-380": ("DE", 380.0), "lt_d-400": ("LT", 400.0)}
    n.create_substations(pd.DataFrame(index=[f"SS_{b}" for b in buses],
                                      data={"country": [c for c, _ in buses.values()]}))
    vls = [f"VL_{b}" for b in buses]
    n.create_voltage_levels(pd.DataFrame(index=vls, data={
        "substation_id": [f"SS_{b}" for b in buses], "topology_kind": "NODE_BREAKER",
        "nominal_v": [v for _, v in buses.values()], "name": [b.upper() for b in buses]}))
    n.create_busbar_sections(pd.DataFrame(index=[f"{vl}_BBS1" for vl in vls],
                                          data={"voltage_level_id": vls, "node": 0}))
    n.create_busbar_sections(pd.DataFrame(index=["VL_fr_a-400_BBS2"],
                                          data={"voltage_level_id": ["VL_fr_a-400"], "node": [1]}))
    switches, gens, loads, nxt = [], [], [], {}
    for b, (_, v) in buses.items():
        vl = f"VL_{b}"
        g = _bay(switches, vl, f"G_{b}", 0, 2)
        ld = _bay(switches, vl, f"L_{b}", 0, 4)
        gens.append((f"G_{b}", vl, g, 16.0, 0.0, 24.0, v, True))
        loads.append((f"L_{b}", vl, ld, 15.0, 1.5))
        nxt[vl] = 6
    lines = [("l1", "fr_a-400", "fr_b-400"), ("l2", "fr_b-400", "de_c-380"), ("l3", "de_c-380", "lt_d-400")]
    line_rows = []
    for lid, a, b in lines:
        ends = []
        for bus, side in ((a, "s1"), (b, "s2")):
            vl = f"VL_{bus}"
            ends.append((vl, _bay(switches, vl, f"{lid}_{side}", 0, nxt[vl])))
            nxt[vl] += 2
        line_rows.append((lid, ends[0][0], ends[0][1], ends[1][0], ends[1][1]))
    sw = pd.DataFrame(switches, columns=["id", "voltage_level_id", "node1", "node2", "kind", "open"])
    n.create_switches(sw.set_index("id"))
    n.create_generators(pd.DataFrame(gens, columns=["id", "voltage_level_id", "node", "target_p", "min_p",
                                                    "max_p", "target_v", "voltage_regulator_on"]).set_index("id"))
    n.create_loads(pd.DataFrame(loads, columns=["id", "voltage_level_id", "node", "p0", "q0"]).set_index("id"))
    n.create_lines(pd.DataFrame([(lid, vl1, n1, vl2, n2, 1.0, 10.0, 0.0, 0.0, 0.0, 0.0)
                                 for lid, vl1, n1, vl2, n2 in line_rows],
                                columns=["id", "voltage_level1_id", "node1", "voltage_level2_id", "node2",
                                         "r", "x", "g1", "b1", "g2", "b2"]).set_index("id"))
    n.create_operational_limits(pd.DataFrame(index=[f"{lid}_lim" for lid, *_ in lines], data={
        "element_id": [lid for lid, *_ in lines], "element_type": "LINE", "side": "ONE",
        "name": "permanent_limit", "type": "CURRENT", "value": 100.0, "acceptable_duration": -1}))
    n.save(str(path), format="XIIDM")


@pytest.fixture
def bundle(tmp_path: Path):
    pytest.importorskip("pypowsybl")
    b, osm = tmp_path / "bundle", tmp_path / "osm"
    b.mkdir()
    osm.mkdir()
    _mini_network(b / "network.xiidm")
    ids = ["fr_a-400", "fr_b-400", "de_c-380", "lt_d-400"]
    (b / "bus_id_mapping.json").write_text(json.dumps({i: i for i in ids}), encoding="utf-8")
    (b / "power_plants.json").write_text(json.dumps(PLANTS), encoding="utf-8")
    (osm / "buses.csv").write_text(
        "bus_id,voltage,dc,x,y,country\n"
        "fr_a-400,400,f,2.1,51.0,FR\nfr_b-400,400,f,4.8,45.0,FR\nde_c-380,380,f,9.0,53.5,DE\n"
        "lt_d-400,400,f,23.0,54.5,LT\ngb_x-400,400,f,1.0,51.2,GB\ndc_fr,320,t,2.1,51.0,FR\n"
        "dc_gb,320,t,1.0,51.2,GB\n", encoding="utf-8")
    (osm / "lines.csv").write_text("line_id,voltage,i_nom,circuits\nl1,400,2.58,1\nl2,400,2.58,2\nl3,380,1.29,1\n",
                                   encoding="utf-8")
    (osm / "links.csv").write_text("link_id,bus0,bus1,p_nom\nlink/gb,dc_fr,dc_gb,1000\n", encoding="utf-8")
    (osm / "converters.csv").write_text("converter_id,bus0,bus1\nc1,fr_a-400,dc_fr\nc2,gb_x-400,dc_gb\n",
                                        encoding="utf-8")
    observed = tmp_path / "observed.json"
    observed.write_text(json.dumps(OBSERVED), encoding="utf-8")
    return b, osm, observed, tmp_path / "situation"


def test_build_end_to_end(bundle):
    import pypowsybl as pp
    b, osm, observed, out = bundle
    summary = bs.build(b, observed, "observed", osm, out)
    assert summary["loadflow"]["status"] == "CONVERGED"
    assert abs(summary["loadflow"]["iterations"][-1]["slack_mw"]) < bs.SLACK_TOLERANCE_MW
    # Generation as observed, within what the balancing slack may still move.
    fr = summary["countries"]["FR"]
    assert fr["production_model_mw"]["NUC"] == pytest.approx(1600.0, abs=bs.SLACK_TOLERANCE_MW)
    assert summary["countries"]["DE"]["production_model_mw"]["LIG"] == pytest.approx(
        1100.0, abs=bs.SLACK_TOLERANCE_MW)
    # Every country's exchanges as observed: France exports 300 to Germany
    # over the AC line and imports 100 from Great Britain over its link.
    assert fr["net_export_model_mw"] == pytest.approx(200.0, abs=15.0)
    assert (out / "situation.json").is_file()
    text = (out / "network.xiidm").read_text(encoding="utf-8")
    assert 'caseDate="2025-01-14T08:00:00.000Z"' in text

    net = pp.network.load(str(out / "network.xiidm"))
    gens = net.get_generators(all_attributes=True)
    unit = gens.loc["G_fr_a-400_NUC1"]
    assert unit["energy_source"] == "NUCLEAR" and unit["plant"] == "Plant" and unit["name"] == "Plant 1"
    assert unit["target_p"] == pytest.approx(800.0)
    assert gens.loc["G_fr_b-400", "energy_source"] == "SOLAR"
    assert gens.loc["G_de_c-380_LIG", "carrier"] == "Lignite"
    loads = net.get_loads(all_attributes=True)
    assert loads.loc["X_GB_fr_a-400", "type"] == "FICTITIOUS"
    assert loads.loc["X_GB_fr_a-400", "p0"] == pytest.approx(-100.0)
    assert loads.loc["X_GB_fr_a-400", "neighbour"] == "GB"
    # New plants get a feeder bay on busbar 1 (and an open one to busbar 2).
    sw = net.get_switches(attributes=["open"])
    assert not sw.loc["VL_fr_a-400_BK_G_fr_a-400_NUC1", "open"]
    assert sw.loc["VL_fr_a-400_D2_G_fr_a-400_NUC1", "open"]
    # Line limits restart from the OSM ratings (I_nom × circuits).
    lim = net.get_operational_limits().reset_index().set_index("element_id")["value"]
    assert lim["l2"] == pytest.approx(5160.0) and lim["l3"] == pytest.approx(1290.0)


def test_cli_help():
    for script in ("build_situation.py", "fetch_energy_charts.py"):
        out = subprocess.run([sys.executable, str(HERE / script), "--help"],
                             capture_output=True, text=True, check=True)
        assert "--at" in out.stdout or "--dispatch" in out.stdout


# ─────────────────────────────────────────────────────────────────────────────
# fetch_energy_charts.py
# ─────────────────────────────────────────────────────────────────────────────


def _payload(rows):
    return {"data": [{"timestamp": ts, "values": v} for ts, v in rows]}


def test_hour_mean_averages_the_quarter_hours():
    at = fec.parse_instant("2025-07-01T11:00Z")
    rows = [("2025-07-01T13:00:00+02:00", {"solar": 100.0, "load": 10.0}),
            ("2025-07-01T13:15:00+02:00", {"solar": 200.0, "load": 30.0}),
            ("2025-07-01T14:00:00+02:00", {"solar": 999.0, "load": 999.0})]
    mean, n = fec._hour_mean(_payload(rows), at)
    assert n == 2 and mean == {"solar": 150.0, "load": 20.0}
    assert fec._hour_mean(None, at) == ({}, 0)


def test_installed_takes_the_last_full_year():
    at = datetime(2025, 7, 1, 11, tzinfo=timezone.utc)
    rows = [("2023-01-01T00:00:00+01:00", {"nuclear": 61.0}),
            ("2024-01-01T00:00:00+01:00", {"nuclear": 63.0, "solar_ac": 22.9}),
            ("2025-01-01T00:00:00+01:00", {"nuclear": 64.6})]
    assert fec._installed(_payload(rows), at) == ({"nuclear": 63000.0, "solar_ac": 22900.0}, 2024)


def test_fetch_country_prefers_totals_with_self_supply(monkeypatch):
    calls = []

    def fake_get(endpoint, **params):
        calls.append(endpoint)
        if endpoint == "total_power":
            return _payload([("2025-01-14T09:00:00+01:00",
                              {"load_incl_self_consumption": 80.0, "fossil_gas": 21.0, "residual_load": 1.0})])
        if endpoint == "cbpf":
            return _payload([("2025-01-14T09:00:00+01:00",
                              {"france": 0.5, "united_kingdom": -1.2, "sum": -0.7})])
        return {"data": []}

    monkeypatch.setattr(fec, "_get", fake_get)
    data = fec.fetch_country("DE", fec.parse_instant(AT))
    assert data["basis"] == "total" and data["load"] == 80.0
    assert data["production"] == {"fossil_gas": 21.0}
    assert data["flows"] == {"FR": 500.0, "GB": -1200.0}
    assert "public_power" not in calls
    # Albania is not covered: no call at all.
    calls.clear()
    assert fec.fetch_country("AL", fec.parse_instant(AT)) is None and calls == []


def test_network_countries(tmp_path):
    xml = ('<iidm:network><iidm:substation id="a" country="FR"/>'
           '<iidm:substation id="b" country="DE"/><iidm:substation id="c" country="FR"/></iidm:network>')
    plain = tmp_path / "network.xiidm"
    plain.write_text(xml, encoding="utf-8")
    assert fec.network_countries(plain) == ["DE", "FR"]
    with zipfile.ZipFile(tmp_path / "network.xiidm.zip", "w") as zf:
        zf.writestr("network.xiidm", xml)
    assert fec.network_countries(tmp_path / "network.xiidm.zip") == ["DE", "FR"]


# ─────────────────────────────────────────────────────────────────────────────
# dispatch_opf.py (PyPSA lives in its own environment)
# ─────────────────────────────────────────────────────────────────────────────


def test_opf_dispatch_respects_line_limits(tmp_path):
    pytest.importorskip("pypsa")
    opf = _load("dispatch_opf")
    p = tmp_path
    pd.DataFrame({"id": ["A", "B"], "v_nom": [400.0, 400.0]}).to_csv(p / "buses.csv", index=False)
    pd.DataFrame({"id": ["l"], "bus0": ["A"], "bus1": ["B"], "r": [1.0], "x": [10.0], "s_nom": [500.0]}
                 ).to_csv(p / "lines.csv", index=False)
    pd.DataFrame(columns=["id", "bus0", "bus1", "r", "x", "s_nom"]).to_csv(p / "transformers.csv", index=False)
    pd.DataFrame({"id": ["cheap", "dear"], "bus": ["A", "B"], "carrier": ["NUC", "GAS"],
                  "p_nom": [2000.0, 2000.0], "marginal_cost": [10.0, 90.0],
                  "p_min_pu": [0.0, 0.0], "p_max_pu": [1.0, 1.0]}).to_csv(p / "generators.csv", index=False)
    pd.DataFrame({"id": ["load"], "bus": ["B"], "p_set": [1000.0]}).to_csv(p / "loads.csv", index=False)
    (p / "meta.json").write_text(json.dumps({"s_max_pu": 0.7, "shedding_cost": 3000}), encoding="utf-8")
    summary = opf.solve(p, p / "dispatch.csv")
    dispatch = pd.read_csv(p / "dispatch.csv", index_col="id")["p"]
    # The cheap plant sends what the line takes (0.7 × 500), the rest is dear.
    assert dispatch["cheap"] == pytest.approx(350.0)
    assert dispatch["dear"] == pytest.approx(650.0)
    assert summary["shedding_mw"] == 0.0 and summary["binding_lines"] == 1
