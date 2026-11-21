"""
test_match_power_plants.py
==========================

Unit tests for ``match_power_plants.py`` on a hand-built bundle: three
French buses (two co-located at different voltages), one Belgian bus, and
a handful of plants that exercise every rule — nearest bus of the plant's
OWN country, highest voltage among co-located buses, the distance cap, the
capacity / commissioning / retirement filters, pumped-storage hydro split
out, and the nuclear site recorded for the map.

Usage::

    pytest scripts/pypsa_eur/test_match_power_plants.py -v
"""
from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest

SCRIPT_PATH = Path(__file__).resolve().parent / "match_power_plants.py"
_spec = importlib.util.spec_from_file_location("match_power_plants", SCRIPT_PATH)
mpp = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(mpp)

HEADER = '<?xml version="1.0"?>\n<iidm:network xmlns:iidm="x" id="n" caseDate="2026-04-29T15:12:00Z">\n'

BUSES = """bus_id,voltage,x,y,country
relation/1-400,400,2.13,51.01,FR
relation/1-225,225,2.131,51.011,FR
way/2-225,225,4.76,44.90,FR
relation/3-380,380,4.30,51.20,BE
"""

PLANTS = """id,Name,Fueltype,Technology,Country,Capacity,lat,lon,DateIn,DateOut
0,Gravelines,Nuclear,Steam Turbine,France,5460,51.0156,2.1361,1980,
1,Dunkerque solar,Solar,PV,France,12,51.02,2.20,2015,
2,Rooftop,Solar,PV,France,0.2,51.01,2.13,2020,
3,Old coal,Hard Coal,Steam Turbine,France,600,51.00,2.12,1970,2021
4,Future gas,Natural Gas,CCGT,France,400,51.00,2.12,2029,
5,Grand'Maison,Hydro,Pumped Storage,France,1800,45.10,5.10,1987,
6,Far offshore,Wind,Offshore,France,500,52.50,1.00,2023,
7,Doel,Nuclear,Steam Turbine,Belgium,2900,51.32,4.26,1975,
8,Cruas,Nuclear,Steam Turbine,France,3600,44.63,4.76,1984,
"""


@pytest.fixture
def bundle(tmp_path: Path) -> tuple[Path, Path, Path]:
    net = tmp_path / "bundle"
    osm = tmp_path / "osm"
    net.mkdir()
    osm.mkdir()
    (osm / "buses.csv").write_text(BUSES, encoding="utf-8")
    mapping = {mpp.safe_id(b): b for b in ("relation/1-400", "relation/1-225", "way/2-225", "relation/3-380")}
    (net / "bus_id_mapping.json").write_text(json.dumps(mapping), encoding="utf-8")
    (net / "network.xiidm").write_text(HEADER + "</iidm:network>\n", encoding="utf-8")
    plants = tmp_path / "powerplants.csv"
    plants.write_text(PLANTS, encoding="utf-8")
    return net, plants, osm


def test_case_year_from_plain_and_zipped_network(bundle, tmp_path):
    net, _, _ = bundle
    assert mpp.case_year(net) == 2026
    zipped = tmp_path / "zipped"
    zipped.mkdir()
    with zipfile.ZipFile(zipped / "network.xiidm.zip", "w") as zf:
        zf.writestr("network.xiidm", HEADER)
    assert mpp.case_year(zipped) == 2026
    # An un-smudged Git-LFS pointer is not a zip: no year, no crash.
    pointer = tmp_path / "pointer"
    pointer.mkdir()
    (pointer / "network.xiidm.zip").write_text("version https://git-lfs.github.com/spec/v1\n")
    assert mpp.case_year(pointer) is None


def test_matching_rules(bundle):
    net, plants, osm = bundle
    record = mpp.run(net, plants, osm)
    gens = record["generators"]
    # Gravelines + the solar farm: nearest substation, its 400 kV level
    # (co-located with the 225 kV one); the rooftop unit (< 1 MW), the coal
    # plant retired in 2021 and the gas plant commissioned in 2029 are out.
    # The offshore farm, ~170 km out at sea, lands on the nearest coast
    # (offshore farms get OFFSHORE_MAX_DISTANCE_KM, beyond the 60 km cap).
    assert gens["G_relation_1-400"]["capacity_mw"] == {"Nuclear": 5460.0, "Solar": 12.0,
                                                       "Wind Offshore": 500.0}
    assert gens["G_relation_1-400"]["sites"] == {"Nuclear": {
        "name": "Gravelines", "lon": 2.1361, "lat": 51.0156, "units": [["Gravelines", 5460.0]]}}
    assert mpp.site_name("Chinon B 2") == "Chinon B" and mpp.site_name("Cofrentes") == "Cofrentes"
    assert "G_relation_1-225" not in gens
    # Pumped-storage hydro is its own carrier; Cruas lands on the only
    # other French bus, both within the 60 km cap.
    assert gens["G_way_2-225"]["capacity_mw"] == {"Nuclear": 3600.0, "Pumped Storage": 1800.0}
    # Doel stays in Belgium even though a French bus is nearer to nothing.
    assert gens["G_relation_3-380"]["capacity_mw"] == {"Nuclear": 2900.0}
    assert record["summary"]["plants_matched"] == 6
    assert record["summary"]["plants_in_grid_countries"] == 6
    assert record["summary"]["generators_with_plants"] == 3
    assert record["params"]["year"] == 2026
    assert record["source"]["licence"] == "CC BY 4.0" and len(record["source"]["sha256"]) == 64
    on_disk = json.loads((net / mpp.OUTPUT_NAME).read_text(encoding="utf-8"))
    assert on_disk == record


def test_nuclear_site_gathers_its_units(bundle):
    net, plants, osm = bundle
    # powerplantmatching lists a plant unit by unit: one site, its units in
    # natural order, at their capacity-weighted centre.
    units = ("10,Paluel 10,Nuclear,Steam Turbine,France,1000,51.00,2.10,1985,\n"
             "11,Paluel 2,Nuclear,Steam Turbine,France,3000,51.04,2.14,1985,\n")
    plants.write_text(PLANTS.replace("0,Gravelines,Nuclear,Steam Turbine,France,5460,51.0156,2.1361,1980,\n", "")
                      + units, encoding="utf-8")
    site = mpp.run(net, plants, osm)["generators"]["G_relation_1-400"]["sites"]["Nuclear"]
    assert site["name"] == "Paluel"
    assert site["units"] == [["Paluel 2", 3000.0], ["Paluel 10", 1000.0]]
    assert (site["lon"], site["lat"]) == pytest.approx((2.13, 51.03))


def test_plants_follow_their_country(bundle):
    net, plants, osm = bundle
    # A Belgian plant right on the French substation still goes to Belgium.
    extra = "9,Border CCGT,Natural Gas,CCGT,Belgium,800,51.01,2.13,2010,\n"
    plants.write_text(PLANTS + extra, encoding="utf-8")
    gens = mpp.run(net, plants, osm, max_km=500)["generators"]
    assert gens["G_relation_3-380"]["capacity_mw"] == {"Nuclear": 2900.0, "Natural Gas": 800.0}
    assert "Natural Gas" not in gens["G_relation_1-400"]["capacity_mw"]


def test_distance_cap_and_year_override(bundle):
    net, plants, osm = bundle
    # In 2020 the coal plant still runs, the offshore farm (2023) does not yet.
    gens = mpp.run(net, plants, osm, year=2020, max_km=500)["generators"]
    assert gens["G_relation_1-400"]["capacity_mw"]["Hard Coal"] == 600.0
    assert "Wind Offshore" not in gens["G_relation_1-400"]["capacity_mw"]
    # An onshore plant as far out stays unmatched under the 60 km cap.
    far = "9,Far onshore,Wind,Onshore,France,300,52.50,1.00,2015,\n"
    plants.write_text(PLANTS + far, encoding="utf-8")
    gens = mpp.run(net, plants, osm)["generators"]
    assert "Wind Onshore" not in gens["G_relation_1-400"]["capacity_mw"]
    assert gens["G_relation_1-400"]["capacity_mw"]["Wind Offshore"] == 500.0


def test_carriers_split_by_technology():
    # Real-time data tell run-of-river from reservoir hydro and onshore from
    # offshore wind: so does the matching.
    assert mpp.carrier_of("Hydro", "Run-Of-River") == "Run-Of-River"
    assert mpp.carrier_of("Hydro", "Reservoir") == "Reservoir"
    assert mpp.carrier_of("Hydro", "Pumped Storage") == "Pumped Storage"
    assert mpp.carrier_of("Hydro", "") == "Run-Of-River"
    assert mpp.carrier_of("Wind", "Offshore") == "Wind Offshore"
    assert mpp.carrier_of("Wind", "Onshore") == "Wind Onshore"
    assert mpp.carrier_of("Wind", "") == "Wind Onshore"
    assert mpp.carrier_of("Nuclear", "Steam Turbine") == "Nuclear"


def test_thermal_efficiency_recorded(bundle):
    net, plants, osm = bundle
    # The database's figure when it has one, else an estimate that rises
    # with the commissioning year (a modern CCGT beats an old one); none for
    # carriers without a merit order.
    assert mpp.efficiency_of("Natural Gas", "CCGT", 2015.0, 0.58) == 0.58
    assert mpp.efficiency_of("Natural Gas", "CCGT", 2015.0, float("nan")) == 0.62
    assert mpp.efficiency_of("Natural Gas", "CCGT", 1985.0, float("nan")) == pytest.approx(0.525)
    assert mpp.efficiency_of("Natural Gas", "OCGT", 2015.0, float("nan")) == mpp.OPEN_CYCLE_EFFICIENCY
    assert mpp.efficiency_of("Nuclear", "Steam Turbine", 1980.0, 0.33) != mpp.efficiency_of(
        "Nuclear", "Steam Turbine", 1980.0, 0.33)  # NaN
    extra = ("9,New CCGT,Natural Gas,CCGT,Belgium,800,51.32,4.26,2015,\n"
             "10,Old CCGT,Natural Gas,CCGT,Belgium,200,51.32,4.26,1985,\n")
    plants.write_text(PLANTS + extra, encoding="utf-8")
    gen = mpp.run(net, plants, osm)["generators"]["G_relation_3-380"]
    assert gen["capacity_mw"]["Natural Gas"] == 1000.0
    # Capacity-weighted: 0.8 × 0.62 + 0.2 × 0.525.
    assert gen["efficiency"] == {"Natural Gas": pytest.approx(0.601, abs=1e-3)}


def test_eic_codes_recorded(bundle):
    net, plants, osm = bundle
    # The database's ENTSO-E codes, per carrier, for the plants it has them for.
    eic = {"Gravelines": "\"{'17W100P100P0213S', '17W100P100P0214Q'}\"",
           "Grand'Maison": "\"{'17W100P100P02756'}\""}
    lines = PLANTS.strip().split("\n")
    plants.write_text("\n".join([lines[0] + ",EIC"] + [
        line + "," + eic.get(line.split(",")[1], "set()") for line in lines[1:]]) + "\n", encoding="utf-8")
    gens = mpp.run(net, plants, osm)["generators"]
    assert gens["G_relation_1-400"]["eic"] == {
        "Nuclear": [["Gravelines", 5460.0, ["17W100P100P0213S", "17W100P100P0214Q"]]]}
    assert gens["G_way_2-225"]["eic"] == {"Pumped Storage": [["Grand'Maison", 1800.0, ["17W100P100P02756"]]]}
    assert "eic" not in gens["G_relation_3-380"]
    # A code may end in a hyphen; an empty set or a missing cell holds none.
    assert mpp.eic_codes("{'49W000000000061-'}") == ("49W000000000061-",)
    assert mpp.eic_codes("set()") == () and mpp.eic_codes(float("nan")) == ()


def test_cli_help():
    out = subprocess.run([sys.executable, str(SCRIPT_PATH), "--help"],
                         capture_output=True, text=True, check=True)
    assert "--plants" in out.stdout and "--max-distance-km" in out.stdout
