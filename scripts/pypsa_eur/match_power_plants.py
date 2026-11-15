"""
match_power_plants.py
=====================
Tag the generators of a PyPSA-EUR bundle with the real power plants around
them — WITHOUT touching the network.

The OSM prebuilt network the pipeline starts from (Zenodo 18619025) is
grid-only: ``convert_pypsa_to_xiidm.py`` gives every bus one synthetic
generator ``G_<bus>``, untyped (``energySource`` OTHER), all at the same set
point. This step matches a public power-plant database onto those
generators and writes the result BESIDE the network, as
``power_plants.json``: network, flows, limits, N-1 list and actions stay
exactly as they are. The Context tab reads it to slice each generator's
production by the types of the plants matched to its bus.

Matching rule — each operating plant goes to the NEAREST bus of its own
country (equirectangular distance, at most ``--max-distance-km``; offshore
wind farms, far out at sea, up to ``OFFSHORE_MAX_DISTANCE_KM``); among
buses co-located within ``COLOCATED_KM`` of that nearest one, the highest
voltage wins (a plant feeds a substation's top level). Plants below
``--min-capacity`` MW (rooftop solar…), retired before the case year or
commissioned after it are left out.

Input database: powerplantmatching's ``powerplants.csv``
(https://github.com/PyPSA/powerplantmatching — data CC BY 4.0, Gotzens et
al. 2019, doi:10.1016/j.esr.2018.11.004), the one PyPSA-Eur itself uses.

Output (``power_plants.json``)::

    {"schema": "costudy4grid-power-plants/1",
     "source": {name, url, licence, citation, sha256},
     "params": {...}, "summary": {...},
     "generators": {"G_<bus>": {"capacity_mw": {"Nuclear": 5706.0, ...},
                                "efficiency": {"Natural Gas": 0.56, ...},
                                "sites": {"Nuclear": {"name": "Gravelines", "lon": …, "lat": …,
                                                      "units": [["Gravelines 1", 951.0], …]}}}}}

``capacity_mw`` keys are powerplantmatching fuel types, with hydro split by
technology (``Run-Of-River``, ``Reservoir``, ``Pumped Storage``) and wind by
site (``Wind Onshore``, ``Wind Offshore``) — the types real-time production
data tell apart. ``efficiency`` is the capacity-weighted efficiency of the
thermal plants (the database's own figure, else one estimated from the
technology and commissioning year): the merit order of an optimal dispatch.
``sites`` places the carriers the map draws on their real site (nuclear):
the plant, its units' capacity-weighted centre and its units.

Usage:
    python scripts/pypsa_eur/match_power_plants.py \\
        --network data/pypsa_eur_eur220_225_380_400 \\
        --plants /path/to/powerplants.csv \\
        [--osm-dir data/pypsa_eur_osm]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import logging
import math
import re
import zipfile
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.spatial import cKDTree

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
log = logging.getLogger(__name__)

BASE_DIR = Path(__file__).resolve().parent.parent.parent
OUTPUT_NAME = "power_plants.json"
SCHEMA = "costudy4grid-power-plants/1"

MIN_CAPACITY_MW = 1.0
MAX_DISTANCE_KM = 60.0
#: Offshore farms sit far out at sea and land on the nearest coast.
OFFSHORE_MAX_DISTANCE_KM = 250.0
#: Buses this close to the nearest one count as the same substation.
COLOCATED_KM = 1.0
#: Candidate buses examined per plant (the co-located set is small).
NEAREST_CANDIDATES = 8
EARTH_RADIUS_KM = 6371.0
#: Carriers whose largest plant is recorded with its site (drawn there).
SITE_CARRIERS = ("Nuclear",)
#: Thermal carriers whose efficiency is recorded (an optimal dispatch's
#: merit order), with the estimate used when the database gives none:
#: (base efficiency, gain per commissioning year after REF_YEAR, ceiling).
EFFICIENCY_MODEL = {
    "Natural Gas": (0.45, 0.005, 0.62),
    "Hard Coal": (0.33, 0.003, 0.46),
    "Lignite": (0.30, 0.003, 0.43),
    "Oil": (0.33, 0.002, 0.40),
    "Solid Biomass": (0.28, 0.002, 0.35),
    "Biogas": (0.35, 0.002, 0.42),
    "Waste": (0.22, 0.002, 0.28),
}
#: Gas turbines and engines run open-cycle: no CCGT gain.
OPEN_CYCLE = ("OCGT", "Combustion Engine")
OPEN_CYCLE_EFFICIENCY = 0.36
REF_YEAR = 1970

SOURCE = {
    "name": "powerplantmatching",
    "url": "https://github.com/PyPSA/powerplantmatching",
    "licence": "CC BY 4.0",
    "citation": ("F. Gotzens, H. Heinrichs, J. Hörsch, F. Hofmann, \"Performing energy "
                 "modelling exercises in a transparent way - The issue of data quality in "
                 "power plant databases\", Energy Strategy Reviews 23 (2019) 1-12, "
                 "doi:10.1016/j.esr.2018.11.004"),
}

#: powerplantmatching country names → the ISO codes of the OSM buses.
COUNTRY_ISO = {
    "Albania": "AL", "Austria": "AT", "Belgium": "BE", "Bosnia and Herzegovina": "BA",
    "Bulgaria": "BG", "Croatia": "HR", "Czechia": "CZ", "Denmark": "DK", "Estonia": "EE",
    "Finland": "FI", "France": "FR", "Germany": "DE", "Greece": "GR", "Hungary": "HU",
    "Ireland": "IE", "Italy": "IT", "Kosovo": "XK", "Latvia": "LV", "Lithuania": "LT",
    "Luxembourg": "LU", "Moldova": "MD", "Montenegro": "ME", "Netherlands": "NL",
    "North Macedonia": "MK", "Norway": "NO", "Poland": "PL", "Portugal": "PT",
    "Romania": "RO", "Serbia": "RS", "Slovakia": "SK", "Slovenia": "SI", "Spain": "ES",
    "Sweden": "SE", "Switzerland": "CH", "Ukraine": "UA", "United Kingdom": "GB",
}


def safe_id(raw: str) -> str:
    """OSM bus id → IIDM id fragment (``convert_pypsa_to_xiidm.safe_id``)."""
    return re.sub(r"[^A-Za-z0-9_\-\.]", "_", raw)


def case_year(network_dir: Path) -> int | None:
    """Year of the network's ``caseDate`` (read off the file header)."""
    head = ""
    plain = network_dir / "network.xiidm"
    packed = network_dir / "network.xiidm.zip"
    if plain.is_file():
        with open(plain, "r", encoding="utf-8", errors="ignore") as fh:
            head = fh.read(4096)
    elif packed.is_file() and zipfile.is_zipfile(packed):
        with zipfile.ZipFile(packed) as zf:
            name = next((n for n in zf.namelist() if n.endswith(".xiidm")), None)
            if name:
                with zf.open(name) as fh:
                    head = fh.read(4096).decode("utf-8", errors="ignore")
    match = re.search(r'caseDate="(\d{4})-', head)
    return int(match.group(1)) if match else None


def load_buses(network_dir: Path, osm_dir: Path) -> pd.DataFrame:
    """The bundle's buses: ``generator``, ``country``, ``voltage``, ``lon``, ``lat``."""
    mapping = json.loads((network_dir / "bus_id_mapping.json").read_text(encoding="utf-8"))
    raw = pd.read_csv(osm_dir / "buses.csv", index_col=0,
                      usecols=["bus_id", "voltage", "x", "y", "country"])
    known = [b for b in mapping.values() if b in raw.index]
    if len(known) < len(mapping):
        log.warning("  %d bundle buses missing from %s", len(mapping) - len(known), osm_dir / "buses.csv")
    buses = raw.loc[known]
    return pd.DataFrame({
        "generator": [f"G_{safe_id(b)}" for b in known],
        "country": buses["country"].astype(str).to_numpy(),
        "voltage": pd.to_numeric(buses["voltage"], errors="coerce").fillna(0.0).to_numpy(),
        "lon": buses["x"].astype(float).to_numpy(),
        "lat": buses["y"].astype(float).to_numpy(),
    })


def carrier_of(fueltype: str, technology: str) -> str:
    """powerplantmatching fuel type; hydro split by technology (an unknown
    one counts as run-of-river, mostly small plants) and wind by site."""
    if fueltype == "Hydro":
        return technology if technology in ("Pumped Storage", "Reservoir") else "Run-Of-River"
    if fueltype == "Wind":
        return "Wind Offshore" if technology == "Offshore" else "Wind Onshore"
    return fueltype or "Other"


def efficiency_of(carrier: str, technology: str, date_in: float, known: float) -> float:
    """The database's efficiency, else one estimated from the technology and
    commissioning year (NaN for a carrier without a merit order)."""
    if carrier not in EFFICIENCY_MODEL:
        return float("nan")
    if known == known and 0.1 < known < 0.7:
        return float(known)
    if carrier == "Natural Gas" and technology in OPEN_CYCLE:
        return OPEN_CYCLE_EFFICIENCY
    base, gain, ceiling = EFFICIENCY_MODEL[carrier]
    year = date_in if date_in == date_in else 1990.0
    return round(min(ceiling, base + gain * max(0.0, year - REF_YEAR)), 3)


def load_plants(path: Path, year: int | None, min_capacity: float) -> pd.DataFrame:
    """Operating plants of at least ``min_capacity`` MW, with a country code."""
    cols = ["Name", "Fueltype", "Technology", "Country", "Capacity", "Efficiency",
            "lat", "lon", "DateIn", "DateOut"]
    pp = pd.read_csv(path, usecols=lambda c: c in cols)
    pp = pp.dropna(subset=["lat", "lon", "Capacity"])
    keep = pp["Capacity"] >= min_capacity
    if year is not None:
        for col, retired in (("DateOut", lambda d: d < year), ("DateIn", lambda d: d > year)):
            if col in pp.columns:
                keep &= ~retired(pd.to_numeric(pp[col], errors="coerce"))
    pp = pp[keep]
    technology = pp["Technology"].fillna("").astype(str)
    carriers = [carrier_of(str(f), t) for f, t in zip(pp["Fueltype"].fillna("Other"), technology)]
    date_in = pd.to_numeric(pp.get("DateIn"), errors="coerce") if "DateIn" in pp else np.nan
    known = pd.to_numeric(pp.get("Efficiency"), errors="coerce") if "Efficiency" in pp else np.nan
    return pd.DataFrame({
        "name": pp["Name"].fillna("").astype(str),
        "carrier": carriers,
        "iso": pp["Country"].map(COUNTRY_ISO),
        "capacity": pp["Capacity"].astype(float),
        "efficiency": [efficiency_of(c, t, d, k) for c, t, d, k in zip(
            carriers, technology, pd.Series(date_in, index=pp.index).to_numpy(),
            pd.Series(known, index=pp.index).to_numpy())],
        "lon": pp["lon"].astype(float),
        "lat": pp["lat"].astype(float),
    }).reset_index(drop=True)


def _km(lon: np.ndarray, lat: np.ndarray, lat0: float) -> np.ndarray:
    """Equirectangular projection (km) around ``lat0`` — fine within a country."""
    k = math.pi / 180.0 * EARTH_RADIUS_KM
    return np.column_stack([lon * k * math.cos(math.radians(lat0)), lat * k])


def match(plants: pd.DataFrame, buses: pd.DataFrame, max_km: float) -> pd.DataFrame:
    """Each plant's bus (``generator``) and distance; unmatched plants dropped."""
    out = []
    for iso, group in plants.groupby("iso"):
        cand = buses[buses["country"] == iso].reset_index(drop=True)
        if cand.empty:
            continue
        lat0 = float(cand["lat"].mean())
        tree = cKDTree(_km(cand["lon"].to_numpy(), cand["lat"].to_numpy(), lat0))
        k = min(NEAREST_CANDIDATES, len(cand))
        dist, idx = tree.query(_km(group["lon"].to_numpy(), group["lat"].to_numpy(), lat0), k=k)
        dist, idx = dist.reshape(len(group), k), idx.reshape(len(group), k)
        volts = cand["voltage"].to_numpy()[idx]
        # Co-located with the nearest (same substation): highest voltage first.
        near = dist <= dist[:, :1] + COLOCATED_KM
        best = np.argmax(np.where(near, volts, -np.inf), axis=1)
        rows = np.arange(len(group))
        out.append(group.assign(generator=cand["generator"].to_numpy()[idx[rows, best]],
                                distance_km=dist[rows, best]))
    if not out:
        return plants.iloc[0:0].assign(generator=[], distance_km=[])
    matched = pd.concat(out)
    limit = np.where(matched["carrier"] == "Wind Offshore", max(max_km, OFFSHORE_MAX_DISTANCE_KM), max_km)
    return matched[matched["distance_km"] <= limit]


def build_record(matched: pd.DataFrame) -> dict[str, dict]:
    """``{generator: {"capacity_mw": {carrier: MW}, "sites": {...}}}``."""
    generators: dict[str, dict] = {}
    capacity = matched.groupby(["generator", "carrier"])["capacity"].sum()
    for (gen, carrier), mw in capacity.items():
        generators.setdefault(gen, {"capacity_mw": {}})["capacity_mw"][carrier] = round(float(mw), 1)
    if "efficiency" in matched:
        rated = matched[matched["efficiency"].notna()]
        weighted = (rated["efficiency"] * rated["capacity"]).groupby(
            [rated["generator"], rated["carrier"]]).sum() / rated.groupby(
            ["generator", "carrier"])["capacity"].sum()
        for (gen, carrier), eff in weighted.items():
            generators[gen].setdefault("efficiency", {})[carrier] = round(float(eff), 3)
    for carrier in SITE_CARRIERS:
        sited = matched[matched["carrier"] == carrier].sort_values("capacity", ascending=False)
        for gen, units in sited.groupby("generator", sort=False):
            # powerplantmatching lists nuclear plants unit by unit ("Gravelines 1"
            # … "Gravelines 6"): the site is the plant, at its units' centre.
            w = units["capacity"] / units["capacity"].sum()
            generators[gen].setdefault("sites", {})[carrier] = {
                "name": site_name(units["name"].iloc[0]),
                "lon": round(float((units["lon"] * w).sum()), 5),
                "lat": round(float((units["lat"] * w).sum()), 5),
                "units": sorted(([str(n), round(float(c), 1)] for n, c in zip(units["name"], units["capacity"])),
                                key=lambda u: _natural(u[0])),
            }
    return dict(sorted(generators.items()))


def _natural(text: str) -> list:
    """Sort key putting "Unit 2" before "Unit 10"."""
    return [int(t) if t.isdigit() else t for t in re.split(r"(\d+)", text)]


def site_name(unit: str) -> str:
    """A plant's name from one of its units': "Chinon B 2" → "Chinon B"."""
    return re.sub(r"\s+\d+$", "", unit.strip()) or unit


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def run(network_dir: Path, plants_path: Path, osm_dir: Path, year: int | None = None,
        min_capacity: float = MIN_CAPACITY_MW, max_km: float = MAX_DISTANCE_KM) -> dict:
    """Match, write ``power_plants.json`` into the bundle, return the record."""
    year = year if year is not None else case_year(network_dir)
    if year is None:
        log.warning("  No caseDate readable in %s and no --year: plants kept whatever their dates",
                    network_dir)
    buses = load_buses(network_dir, osm_dir)
    plants = load_plants(plants_path, year, min_capacity)
    in_grid = plants[plants["iso"].isin(set(buses["country"]))]
    matched = match(in_grid, buses, max_km)
    generators = build_record(matched)
    record = {
        "schema": SCHEMA,
        "source": dict(SOURCE, sha256=_sha256(plants_path)),
        "params": {"year": year, "min_capacity_mw": min_capacity, "max_distance_km": max_km,
                   "colocated_km": COLOCATED_KM},
        "summary": {
            "plants_in_grid_countries": int(len(in_grid)),
            "plants_matched": int(len(matched)),
            "capacity_matched_mw": round(float(matched["capacity"].sum()), 1),
            "capacity_share_matched": round(float(matched["capacity"].sum() / in_grid["capacity"].sum()), 3)
            if len(in_grid) else 0.0,
            "generators": int(len(buses)),
            "generators_with_plants": len(generators),
        },
        "generators": generators,
    }
    out = network_dir / OUTPUT_NAME
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(record, fh, ensure_ascii=False, separators=(",", ":"))
        fh.write("\n")
    s = record["summary"]
    log.info("  %d / %d plants matched (%.0f %% of their MW) onto %d / %d generators → %s",
             s["plants_matched"], s["plants_in_grid_countries"], 100 * s["capacity_share_matched"],
             s["generators_with_plants"], s["generators"], out)
    return record


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[1],
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--network", required=True, help="Bundle directory (data/pypsa_eur_…).")
    parser.add_argument("--plants", required=True, help="powerplantmatching powerplants.csv.")
    parser.add_argument("--osm-dir", default=str(BASE_DIR / "data" / "pypsa_eur_osm"),
                        help="Directory of the OSM buses.csv the bundle was built from.")
    parser.add_argument("--year", type=int, default=None,
                        help="Operating year (default: the network's caseDate year).")
    parser.add_argument("--min-capacity", type=float, default=MIN_CAPACITY_MW,
                        help=f"Smallest plant kept, MW (default {MIN_CAPACITY_MW:g}).")
    parser.add_argument("--max-distance-km", type=float, default=MAX_DISTANCE_KM,
                        help=f"Farthest plant-to-bus match, km (default {MAX_DISTANCE_KM:g}).")
    args = parser.parse_args()
    network_dir = Path(args.network)
    if not network_dir.is_absolute():
        network_dir = BASE_DIR / network_dir
    run(network_dir, Path(args.plants), Path(args.osm_dir), args.year,
        args.min_capacity, args.max_distance_km)


if __name__ == "__main__":
    main()
