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
feu = _load("fetch_entsoe_units")

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


def _coded_plants() -> dict:
    """PLANTS with the ENTSO-E codes ``match_power_plants.py`` records."""
    record = json.loads(json.dumps(PLANTS))
    gens = record["generators"]
    gens["G_fr_a-400"]["capacity_mw"]["Natural Gas"] = 100.0
    gens["G_fr_a-400"]["eic"] = {"Nuclear": [["Plant 1", 1000.0, ["U_N1"]], ["Plant 2", 1000.0, ["U_N2"]]],
                                 "Natural Gas": [["Gas B", 100.0, ["U_TWO"]]]}
    gens["G_fr_b-400"]["eic"] = {"Natural Gas": [["Gas A", 300.0, ["U_GAS", "U_TWO"]]],
                                 "Solar": [["Farm", 100.0, ["U_ODD"]]]}
    gens["G_de_c-380"]["eic"] = {"Lignite": [["Lig", 1500.0, ["U_LIG", "U_FR"]]]}
    return record


def _unit(eic: str, kind: str, mw: float) -> dict:
    return {"eic": eic, "name": eic, "type": kind, "mw": mw, "parts": []}


UNITS = {
    "schema": "costudy4grid-unit-hour/1",
    "at_utc": AT,
    "source": {"name": "ENTSO-E Transparency Platform", "url": "https://transparency.entsoe.eu"},
    "countries": {
        "FR": {"areas": ["10YFR-RTE------C"], "units": [
            _unit("U_N1", "B14", 990.0), _unit("U_N2", "B14", -30.0), _unit("U_GAS", "B04", 150.0),
            _unit("U_TWO", "B04", 80.0), _unit("U_ODD", "B04", 60.0), _unit("U_FR", "B02", 50.0)]},
        "DE": {"areas": ["10YDE-VE-------2"], "units": [_unit("U_LIG", "B02", 700.0)]},
    },
    "missing": {},
}


def _write_units(path: Path, record: dict = UNITS) -> Path:
    path.write_text(json.dumps(record), encoding="utf-8")
    return path


def _metered(tmp_path: Path):
    grid = _grid()
    record = _coded_plants()
    table = bs.plant_table(grid, record)
    units, source = bs.read_units(_write_units(tmp_path / "units.json"), AT)
    return grid, table, bs.metered_plants(table, record, units, grid), source


def test_metered_plants_link_units_by_code(tmp_path):
    grid, table, metered, source = _metered(tmp_path)
    assert source["name"] == "ENTSO-E Transparency Platform"
    m = metered.set_index("plant")
    # A reactor by its unit's name; a stopped one draws its auxiliaries.
    assert m.loc["Plant 1", ["row", "p"]].tolist() == ["G_fr_a-400_NUC1", 990.0]
    assert m.loc["Plant 2", "p"] == -30.0
    # A code listed on two generators (U_TWO) places nothing, nor a unit of a
    # type its plant lacks (a gas unit on a solar farm), nor one of another
    # country (U_FR on a German plant).
    assert m.loc["Gas A", ["row", "p", "units"]].tolist() == ["G_fr_b-400_GAS", 150.0, 1]
    assert "Gas B" not in m.index and "Farm" not in m.index
    assert m.loc["Lig", ["row", "p", "units"]].tolist() == ["G_de_c-380_LIG", 700.0, 1]
    # Denmark is DK1 alone: its national units are left to the shared dispatch.
    grid.buses.loc["VL_de_c-380", "country"] = "DK"
    units = bs.read_units(_write_units(tmp_path / "dk.json", {**UNITS, "countries": {
        "DK": {"areas": [], "units": [_unit("U_LIG", "B02", 700.0)]}}}), AT)[0]
    assert bs.metered_plants(table.assign(country=table["vl"].map(grid.buses["country"])),
                             _coded_plants(), units, grid).empty
    with pytest.raises(ValueError, match="not 2025-01-14T08:00Z"):
        bs.read_units(_write_units(tmp_path / "other.json", {**UNITS, "at_utc": "2025-07-01T11:00Z"}), AT)


def test_one_code_for_several_reactors_is_shared_on_their_site(tmp_path):
    # Paks: one code for the whole plant, recorded on its first unit only.
    grid = _grid()
    record = _coded_plants()
    record["generators"]["G_fr_a-400"]["eic"]["Nuclear"] = [["Plant 1", 1000.0, ["U_SITE"]]]
    table = bs.plant_table(grid, record)
    hour = {**UNITS, "countries": {"FR": {"areas": [], "units": [_unit("U_SITE", "B14", 1800.0)]}}}
    units = bs.read_units(_write_units(tmp_path / "site.json", hour), AT)[0]
    m = bs.metered_plants(table, record, units, grid).set_index("row")["p"]
    assert m.to_dict() == {"G_fr_a-400_NUC1": 900.0, "G_fr_a-400_NUC2": 900.0}


def test_share_fills_free_capacity_then_headroom():
    cap = pd.Series({"a": 1000.0, "b": 500.0, "c": 100.0})
    known = pd.Series({"a": 400.0, "b": 0.0, "c": 0.0})   # a measured at 400 MW
    free = pd.Series({"a": 0.0, "b": 500.0, "c": 100.0})  # b and c unmeasured
    # The rest of the type over the capacity no unit measures, by capacity…
    assert bs._share(known, free, cap, 700.0, False).tolist() == pytest.approx([400.0, 250.0, 50.0])
    # …up to 98 % of it; beyond, over the measured plant's headroom…
    assert bs._share(known, free, cap, 1400.0, False).tolist() == pytest.approx([812.0, 490.0, 98.0])
    # …and beyond all room, by capacity (the caller stretches it).
    assert bs._share(known, free, cap, 2000.0, False).sum() == pytest.approx(2000.0)


def test_observed_dispatch_keeps_measured_outputs(tmp_path):
    grid, table, metered, _ = _metered(tmp_path)
    targets = bs.country_targets(grid, OBSERVED, table)
    targets["FR"].production["NUC"] = 1000.0
    p = bs.observed_dispatch(table, targets, metered)
    # The measured reactor carries the country's nuclear; the stopped one stays off.
    assert p["G_fr_a-400_NUC1"] == pytest.approx(1000.0)
    assert p["G_fr_a-400_NUC2"] == 0.0
    # Gas: 150 MW measured on Gas A, the other 50 MW over the 300 MW no unit
    # measures — 200 MW beside Gas A, 100 MW at the other bus.
    assert p["G_fr_b-400_GAS"] == pytest.approx(150.0 + 50.0 * 200 / 300)
    assert p["G_fr_a-400_GAS"] == pytest.approx(50.0 * 100 / 300)
    # Lignite measured whole: its 700 MW scaled onto the 1 100 Germany reports;
    # units measuring more than the country reports scaled down onto it.
    assert p["G_de_c-380_LIG"] == pytest.approx(1100.0)
    targets["DE"].production["LIG"] = 500.0
    assert bs.observed_dispatch(table, targets, metered)["G_de_c-380_LIG"] == pytest.approx(500.0)


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


def _france_alone() -> "bs.Grid":
    """France on its own: no AC neighbour in the bundle."""
    buses = _grid().buses.loc[["VL_fr_a-400", "VL_fr_b-400"]]
    return bs.Grid(buses=buses, ac_pairs=set())


def _osm(tmp_path: Path, buses: str, lines: str = "", links: str = "", converters: str = "") -> Path:
    osm = tmp_path / "osm"
    osm.mkdir()
    (osm / "buses.csv").write_text("bus_id,voltage,dc,x,y,country\n" + buses, encoding="utf-8")
    (osm / "lines.csv").write_text("line_id,bus0,bus1,voltage,i_nom,circuits\n" + lines, encoding="utf-8")
    (osm / "links.csv").write_text("link_id,bus0,bus1,p_nom\n" + links, encoding="utf-8")
    (osm / "converters.csv").write_text("converter_id,bus0,bus1\n" + converters, encoding="utf-8")
    return osm


def test_cut_ties_land_where_the_bundle_cut_them(tmp_path):
    osm = _osm(tmp_path, buses=(
        "fr_a-400,400,f,2.1,51.0,FR\nfr_b-400,400,f,4.8,45.0,FR\nfr_v-380,380,f,4.85,45.05,FR\n"
        "fr_w-150,150,f,4.8,45.1,FR\nbe_x-400,400,f,3.0,51.5,BE\nit_y-380,380,f,7.0,45.0,IT\n"
        "ch_z-150,150,f,6.0,46.0,CH\n"), lines=(
        "t/be,fr_a-400,be_x-400,400,2.58,2\n"     # lands on a bundle bus
        "t/it,it_y-380,fr_v-380,380,2.58,\n"      # its French end is no bundle bus: the nearest
        "t/ch,fr_w-150,ch_z-150,150,1.0,1\n"      # not at the bundle's voltages
        "l/in,fr_a-400,fr_b-400,400,2.58,1\n"))   # inside the bundle
    grid = _france_alone()
    # A 225 kV bus right by the Italian line's French end.
    grid.buses = pd.concat([grid.buses, pd.DataFrame(
        {"bus": ["fr_c-225"], "country": ["FR"], "name": ["Coco"], "target_v": [225.0], "key": [1.0],
         "lon": [4.851], "lat": [45.051]}, index=["VL_fr_c-225"])])
    grid.buses["kv"] = [400.0, 400.0, 225.0]
    mapping = {"fr_a-400": "fr_a-400", "fr_b-400": "fr_b-400", "fr_c-225": "fr_c-225"}
    ties = bs.cut_ties(osm, mapping, grid, {225.0, 400.0}).set_index("line")
    assert ties["neighbour"].to_dict() == {"t_be": "BE", "t_it": "IT"}
    # The 380 kV line lands on the nearest 400 kV bus, not on the closer 225 kV one.
    assert ties["vl"].to_dict() == {"t_be": "VL_fr_a-400", "t_it": "VL_fr_b-400"}
    assert ties.loc["t_be", "s_nom"] == pytest.approx(3 ** 0.5 * 400 * 2.58 * 2)
    assert ties.loc["t_it", "s_nom"] == pytest.approx(3 ** 0.5 * 380 * 2.58)


def test_an_island_converter_lands_nowhere(tmp_path):
    osm = _osm(tmp_path, buses=(
        "fr_a-400,400,f,2.1,51.0,FR\nfr_b-400,400,f,4.8,45.0,FR\ngb_x-400,400,f,1.0,51.2,GB\n"
        "co_ac,200,f,9.45,42.53,FR\nit_ac-380,380,f,9.0,44.0,IT\n"
        "dc_fr,320,t,2.1,51.0,FR\ndc_gb,320,t,1.0,51.2,GB\ndc_co,200,t,9.45,42.53,FR\n"
        "dc_it,200,t,9.0,44.0,IT\n"),
        links="link/gb,dc_fr,dc_gb,1000\nlink/sacoi,dc_co,dc_it,300\n",
        converters="c1,fr_a-400,dc_fr\nc2,gb_x-400,dc_gb\nc3,co_ac,dc_co\nc4,it_ac-380,dc_it\n")
    mapping = {"fr_a-400": "fr_a-400", "fr_b-400": "fr_b-400"}
    links = bs.hvdc_landings(osm, mapping, _france_alone()).set_index("link")
    assert links.loc["link/gb", "vl0"] == "VL_fr_a-400"
    # Corsica's converter lies far off the mainland grid: no landing.
    assert links.loc["link/sacoi", "vl0"] is None


def test_a_country_alone_exchanges_where_its_cut_lines_land():
    grid = _france_alone()
    targets = {"FR": bs.Target(load=2000.0, flows={"BE": 1000.0, "IT": -600.0, "GB": 300.0})}
    ties = pd.DataFrame([("t_be1", "FR", "BE", "VL_fr_a-400", 1500.0),
                         ("t_be2", "FR", "BE", "VL_fr_b-400", 500.0),
                         ("t_it", "FR", "IT", "VL_fr_b-400", 3000.0)],
                        columns=["line", "country", "neighbour", "vl", "s_nom"])
    links = pd.DataFrame([("link/gb", 1000.0, "FR", "VL_fr_a-400", "GB", None),
                          ("link/it", 1000.0, "FR", "VL_fr_a-400", "IT", None)],
                         columns=["link", "p_nom", "c0", "vl0", "c1", "vl1"])
    ext = bs.external_injections(grid, targets, links, ties)
    p0 = ext["p0"].round(1).to_dict()
    # An AC border: the import spread over the cut lines by rating.
    assert p0["X_BE_fr_a-400"] == -750.0 and p0["X_BE_fr_b-400"] == -250.0
    # AC lines and an HVDC link on one border share the export by capacity.
    assert p0["X_IT_fr_b-400"] == 450.0 and p0["X_IT_fr_a-400"] == 150.0
    assert ext.loc["X_IT_fr_a-400", "how"] == "hvdc" and ext.loc["X_IT_fr_b-400", "how"] == "tie"
    # No AC line to Great Britain: its link only, as before.
    assert p0["X_GB_fr_a-400"] == -300.0
    # A converter and a cut line on one bus make one load.
    ties.loc[2, "vl"] = "VL_fr_a-400"
    ext = bs.external_injections(grid, targets, links, ties)
    assert ext.loc["X_IT_fr_a-400", "p0"] == pytest.approx(600.0)
    assert ext.loc["X_IT_fr_a-400", "how"] == "hvdc+tie"
    # A country with an AC neighbour in the bundle keeps its converters.
    _, _, kept = _targets()
    kept["FR"].flows = {"DE": -300.0, "GB": 300.0}
    assert "tie" not in set(bs.external_injections(_grid(), kept, links, ties)["how"])


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
    (osm / "lines.csv").write_text("line_id,bus0,bus1,voltage,i_nom,circuits\nl1,fr_a-400,fr_b-400,400,2.58,1\n"
                                   "l2,fr_b-400,de_c-380,400,2.58,2\nl3,de_c-380,lt_d-400,380,1.29,1\n",
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


def test_build_with_unit_outputs(bundle):
    b, osm, observed, out = bundle
    (b / "power_plants.json").write_text(json.dumps(_coded_plants()), encoding="utf-8")
    hour = json.loads(json.dumps(UNITS))
    hour["countries"]["FR"]["units"][:2] = [_unit("U_N1", "B14", 1000.0), _unit("U_N2", "B14", 600.0)]
    summary = bs.build(b, observed, "observed", osm, out, units_path=_write_units(out.parent / "u.json", hour))
    # Each reactor at its own output, not both at the country's 80 %.
    assert summary["countries"]["FR"]["production_metered_mw"]["NUC"] == 1600.0
    assert summary["units"]["units_placed"] == 4
    assert [s["name"] for s in summary["sources"]][1] == "ENTSO-E Transparency Platform"
    import pypowsybl as pp
    gens = pp.network.load(str(out / "network.xiidm")).get_generators(attributes=["target_p"])
    assert gens.loc["G_fr_a-400_NUC1", "target_p"] == pytest.approx(1000.0)
    assert gens.loc["G_fr_a-400_NUC2", "target_p"] == pytest.approx(600.0)


def test_cli_help():
    for script in ("build_situation.py", "fetch_energy_charts.py", "fetch_entsoe_units.py"):
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


# ─────────────────────────────────────────────────────────────────────────────
# fetch_entsoe_units.py
# ─────────────────────────────────────────────────────────────────────────────


def _series(side: str, eic: str, start: str, end: str, step: str, points: dict[int, float]) -> str:
    pts = "".join(f"<Point><position>{k}</position><quantity>{v}</quantity></Point>" for k, v in points.items())
    return (f"<TimeSeries><{side}BiddingZone_Domain.mRID codingScheme='A01'>Z</{side}BiddingZone_Domain.mRID>"
            f"<registeredResource.mRID codingScheme='A01'>{eic}</registeredResource.mRID>"
            "<curveType>A03</curveType><MktPSRType><psrType>B10</psrType><PowerSystemResources>"
            f"<mRID codingScheme='A01'>{eic}_G</mRID><name>{eic} 1</name></PowerSystemResources></MktPSRType>"
            f"<Period><timeInterval><start>{start}</start><end>{end}</end></timeInterval>"
            f"<resolution>{step}</resolution>{pts}</Period></TimeSeries>")


A73 = ("<GL_MarketDocument xmlns='urn:iec62325.351:tc57wg16:451-6:generationloaddocument:3:0'>"
       # 07:00–09:00 by quarter hours, a block holding until the next point:
       # 100, 100, 300, 300 over the hour from 08:00 — 200 MW.
       + _series("in", "P1", "2025-01-14T07:00Z", "2025-01-14T09:00Z", "PT15M", {1: 999, 5: 100, 7: 300})
       # Its pumping, hourly: 40 MW drawn.
       + _series("out", "P1", "2025-01-14T08:00Z", "2025-01-14T09:00Z", "PT60M", {1: 40})
       # A unit the hour has no value for.
       + _series("in", "P2", "2025-01-14T07:00Z", "2025-01-14T08:00Z", "PT60M", {1: 50})
       + "</GL_MarketDocument>")


def test_parse_units_holds_blocks_and_nets_consumption():
    units = feu.parse_units(A73.encode(), feu.parse_instant(AT))
    assert units == [{"eic": "P1", "name": "P1 1", "type": "B10", "mw": 160.0, "parts": ["P1_G"]}]


def test_parse_units_falls_back_on_the_generation_unit():
    # A series may name its generation unit alone (a Polish one does).
    bare = _series("in", "P3", "2025-01-14T08:00Z", "2025-01-14T09:00Z", "PT60M", {1: 70}).replace(
        "<registeredResource.mRID codingScheme='A01'>P3</registeredResource.mRID>", "")
    doc = ("<GL_MarketDocument xmlns='urn:iec62325.351:tc57wg16:451-6:generationloaddocument:3:0'>"
           + bare + "</GL_MarketDocument>")
    assert [(u["eic"], u["mw"]) for u in feu.parse_units(doc.encode(), feu.parse_instant(AT))] == [("P3_G", 70.0)]


def test_fetch_units_country_gathers_its_control_areas(monkeypatch):
    calls = []

    def fake_get(token, **params):
        calls.append((token, params["in_Domain"], params["periodStart"], params["periodEnd"]))
        return A73.encode() if params["in_Domain"] == "10YDE-RWENET---I" else b"<Acknowledgement/>"

    monkeypatch.setattr(feu, "_get", fake_get)
    data = feu.fetch_country("tok", "DE", feu.parse_instant(AT))
    assert [c[1] for c in calls] == list(feu.CONTROL_AREAS["DE"])
    assert calls[0][2:] == ("202501140800", "202501140900")
    assert [u["eic"] for u in data["units"]] == ["P1"]
    assert feu.fetch_country("tok", "GB", feu.parse_instant(AT)) is None


def test_entsoe_token_travels_in_a_header(monkeypatch, tmp_path):
    seen = {}

    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def read(self):
            return b"<doc/>"

    def fake_urlopen(request, timeout):
        seen["url"], seen["headers"] = request.full_url, dict(request.header_items())
        return Response()

    monkeypatch.setattr(feu.urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setattr(feu, "PAUSE_S", 0.0)
    assert feu._get("secret-token", documentType="A73", in_Domain="X") == b"<doc/>"
    assert "secret-token" not in seen["url"] and "documentType=A73" in seen["url"]
    assert "secret-token" in seen["headers"].values()
    (tmp_path / "token.txt").write_text(" abc \n", encoding="utf-8")
    assert feu.read_token(tmp_path / "token.txt") == "abc"
    monkeypatch.setenv(feu.TOKEN_ENV, "xyz")
    assert feu.read_token(None) == "xyz"
    monkeypatch.delenv(feu.TOKEN_ENV)
    with pytest.raises(SystemExit):
        feu.read_token(None)


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
