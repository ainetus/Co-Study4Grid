"""
build_situation.py
==================
Rebuild a PyPSA-EUR bundle's operating point on a REAL hour.

The converted network carries a synthetic situation: 75 GW of load spread
over its buses by connectivity, one untyped 16 MW generator per bus. This
step replaces it with a real hour, keeping the grid itself — topology,
names, limits, actions — untouched:

  1. LOADS — each country's observed load (``fetch_energy_charts.py``)
     spread over its buses with the synthetic load's own key (connectivity).
  2. PLANTS — one generator per (bus, fuel type) for the plants matched by
     ``match_power_plants.py`` (``power_plants.json``), nuclear unit by unit.
     Installed capacity the database misses is added: rooftop solar spread
     by load onto each bus's own ``G_<bus>``, which becomes its solar
     generator; the other types by scaling their matched plants up, then over
     the country's largest load buses.
  3. DISPATCH — ``observed``: each country's observed production of each
     fuel type, shared over its plants of that type by capacity. ``opf``: an
     optimal dispatch solved with PyPSA on the same grid
     (``dispatch_opf.py``).
  4. EXCHANGES with what the bundle leaves out (Great Britain, the Nordics,
     Turkey…) and over its HVDC-only borders become fixed injections —
     fictitious loads ``X_<country>_<bus>`` — at the converter buses, from
     the observed physical flows.
  5. AC load flow (OpenLoadFlow, RTE parameters); loads are trimmed so the
     slack only covers the grid's own losses, and the flows are written to
     the file. ``caseDate`` becomes the hour; each line's permanent limit
     restarts from its OSM rating (√3·U·I_nom·circuits, ``--limits osm``)
     for ``calibrate_thermal_limits.py`` to adjust.

Countries the data source lacks (Albania, Ukraine…) keep the synthetic
load scaled to the observed level, produce it plus their exchanges with
their observed neighbours, with the typical mix of their matched plants.
Denmark is modelled from DK1 alone (DK2 is Nordic-synchronous).

Writes ``<out>/network.xiidm`` and ``<out>/situation.json`` (per-country
observed vs model figures).

Usage
-----
    python scripts/pypsa_eur/build_situation.py \\
        --bundle data/pypsa_eur_eur220_225_380_400 \\
        --observed data/pypsa_eur_eur220_225_380_400/situations/energy_charts_2025-01-14T0800Z.json \\
        --dispatch observed --osm-dir data/pypsa_eur_osm \\
        --out data/pypsa_eur_eur220_225_380_400/situations/2025-01-14_0800Z_observed
"""
from __future__ import annotations

import argparse
import json
import logging
import math
import re
import zipfile
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
log = logging.getLogger(__name__)

BASE_DIR = Path(__file__).resolve().parent.parent.parent
SCHEMA = "costudy4grid-situation/1"

#: Model fuel types: code → (``carrier`` property, IIDM energySource,
#: powerplantmatching carriers it gathers).
CARRIERS: dict[str, tuple[str, str, tuple[str, ...]]] = {
    "NUC": ("Nuclear", "NUCLEAR", ("Nuclear",)),
    "LIG": ("Lignite", "THERMAL", ("Lignite",)),
    "COA": ("Hard Coal", "THERMAL", ("Hard Coal",)),
    "GAS": ("Natural Gas", "THERMAL", ("Natural Gas",)),
    "OIL": ("Oil", "THERMAL", ("Oil",)),
    "ROR": ("Run-Of-River", "HYDRO", ("Run-Of-River", "Hydro")),
    "HYD": ("Reservoir", "HYDRO", ("Reservoir",)),
    "PSP": ("Pumped Storage", "HYDRO", ("Pumped Storage",)),
    "WON": ("Wind Onshore", "WIND", ("Wind Onshore", "Wind")),
    "WOF": ("Wind Offshore", "WIND", ("Wind Offshore",)),
    "SOL": ("Solar", "SOLAR", ("Solar",)),
    "BIO": ("Biomass", "THERMAL", ("Solid Biomass", "Biogas")),
    "WST": ("Waste", "THERMAL", ("Waste",)),
    "STO": ("Storage", "OTHER", ("Battery", "Heat Storage", "Hydrogen Storage", "Mechanical Storage")),
    "OTH": ("Other", "OTHER", ("Geothermal", "Other")),
}
PPM_CODE = {ppm: code for code, (_, _, ppms) in CARRIERS.items() for ppm in ppms}
#: Energy-Charts production (and installed-capacity) series → fuel type.
SERIES_CODE = {
    "nuclear": "NUC", "fossil_brown_coal_lignite": "LIG", "fossil_hard_coal": "COA",
    "fossil_coal_derived_gas": "COA", "fossil_gas": "GAS", "fossil_oil": "OIL",
    "fossil_oil_shale": "OIL", "fossil_peat": "OTH",
    "hydro_run_of_river": "ROR", "hydro_water_reservoir": "HYD",
    "hydro_pumped_storage": "PSP", "hydro_pumped_storage_consumption": "PSP",
    "wind_onshore": "WON", "wind_offshore": "WOF",
    "solar": "SOL", "solar_ac": "SOL", "solar_dc": "SOL",
    "biomass": "BIO", "waste": "WST", "geothermal": "OTH", "others": "OTH", "marine": "OTH",
    "renewable_other": "OTH", "non_renewable_other": "OTH",
    "battery_storage": "STO", "battery_storage_consumption": "STO",
}
#: Fuel types that can draw power (pumping, charging).
BIDIRECTIONAL = ("PSP", "STO")
#: Typical load factor: the mix of a country the data source lacks.
TYPICAL_LF = {
    "NUC": 0.75, "LIG": 0.55, "COA": 0.25, "GAS": 0.30, "OIL": 0.05, "ROR": 0.45, "HYD": 0.25,
    "PSP": 0.0, "WON": 0.23, "WOF": 0.38, "SOL": 0.12, "BIO": 0.55, "WST": 0.55, "STO": 0.0,
    "OTH": 0.30,
}
#: Share of a partly modelled country inside the bundle: Denmark is DK1
#: alone (DK2 is synchronous with the Nordic grid, outside the bundle).
COVERAGE = {"DK": 0.6}
#: Countries reduced to a border bus: only their exchanges are modelled.
BOUNDARY_ONLY = ("LT",)
#: Where exchanges with areas outside the OSM data come in (lon, lat).
BORDER_POINTS = {
    "TR": (26.5, 41.7), "MA": (-5.6, 36.0), "MT": (14.6, 36.8), "BY": (24.0, 53.5),
    "RU": (21.0, 54.7), "UA": (24.5, 49.5), "MD": (28.5, 47.0), "GB": (1.5, 51.0),
    "NO": (8.0, 57.5), "SE": (12.5, 55.8), "IE": (-6.0, 53.3),
}
#: Capacity no matched plant can carry is spread, by load, over this share
#: of a country's buses — its largest load buses, at least ``FALLBACK_BUSES``
#: (the production a country reports untyped, 13.7 GW of Dutch "others" at
#: a July noon, lands on a dozen buses, not three).
FALLBACK_SHARE = 0.2
FALLBACK_BUSES = 3
#: Matched plants grow at most this much to reach the installed capacity.
MAX_SCALE_UP = 3.0
#: Types that are mostly small and embedded (rooftop solar, onto each bus's
#: own ``G_<bus>``): their unmatched capacity is spread by load over EVERY
#: bus of the country.
EMBEDDED = ("SOL",)
TAN_PHI = 0.1
#: Slack the balancing loop accepts (MW).
SLACK_TOLERANCE_MW = 20.0
BALANCE_ITERATIONS = 6

# Optimal dispatch (``--dispatch opf``) ---------------------------------------
#: 2025 fuel price (€/MWh thermal), CO₂ intensity (t/MWh thermal) and
#: variable O&M (€/MWh): a plant's marginal cost over its efficiency.
FUEL = {
    "GAS": (40.0, 0.202, 3.0), "COA": (12.0, 0.336, 4.0), "LIG": (5.0, 0.407, 5.0),
    "OIL": (45.0, 0.267, 3.0), "BIO": (25.0, 0.0, 5.0), "WST": (0.0, 0.10, 5.0),
}
CO2_EUR_PER_T = 70.0
DEFAULT_EFFICIENCY = {"GAS": 0.50, "COA": 0.38, "LIG": 0.35, "OIL": 0.35, "BIO": 0.30, "WST": 0.25}
#: Marginal cost of the types that burn no bought fuel (€/MWh); reservoir
#: hydro at a water value, storage at the value of the energy it shifts
#: (pumping earns it: storage pumps or charges as observed, unless congested).
FLAT_COST = {"NUC": 10.0, "HYD": 70.0, "OTH": 80.0, "ROR": 0.0, "WON": 0.0, "WOF": 0.0, "SOL": 0.0,
             "PSP": 50.0, "STO": 50.0}
#: Types the optimiser dispatches freely (planned outages aside); the others
#: run at most at the hour's observed output.
DISPATCHABLE = ("GAS", "COA", "LIG", "OIL")
THERMAL_AVAILABILITY = 0.9
#: PyPSA-Eur's line loading cap, room for N-1.
S_MAX_PU = 0.7
SHEDDING_COST = 3000.0
#: Rating of a line the OSM data give none for (MVA, by kV).
DEFAULT_S_NOM = {220: 500.0, 225: 500.0, 380: 1700.0, 400: 1700.0}


def safe_id(raw: str) -> str:
    """OSM id → IIDM id fragment (``convert_pypsa_to_xiidm.safe_id``)."""
    return re.sub(r"[^A-Za-z0-9_\-\.]", "_", raw)


# ─────────────────────────────────────────────────────────────────────────────
# Inputs
# ─────────────────────────────────────────────────────────────────────────────


@dataclass
class Grid:
    """The bundle's buses (one voltage level each) and their synthetic injections."""

    buses: pd.DataFrame  # index vl: bus, country, name, target_v, key, lon, lat
    ac_pairs: set[frozenset] = field(default_factory=set)

    def of(self, country: str) -> pd.DataFrame:
        return self.buses[self.buses["country"] == country]


def read_grid(net, mapping: dict[str, str], osm_buses: pd.DataFrame | None) -> Grid:
    """Buses from the network: country, name, voltage target, synthetic-load key."""
    vls = net.get_voltage_levels(attributes=["substation_id", "name"])
    subs = net.get_substations(attributes=["country"])
    gens = net.get_generators(attributes=["voltage_level_id", "target_v"])
    loads = net.get_loads(attributes=["voltage_level_id", "p0"])
    synthetic = gens[gens.index.to_numpy() == ("G_" + gens["voltage_level_id"].str[3:]).to_numpy()]
    buses = pd.DataFrame({
        "bus": vls.index.str[3:],
        "country": vls["substation_id"].map(subs["country"]).fillna("").astype(str),
        "name": vls["name"].fillna(pd.Series(vls.index, index=vls.index)),
    }, index=vls.index)
    buses = buses[buses.index.str.startswith("VL_")]
    buses["target_v"] = synthetic.set_index("voltage_level_id")["target_v"].reindex(buses.index)
    key = loads.groupby("voltage_level_id")["p0"].sum()
    buses["key"] = key.reindex(buses.index).fillna(0.0).clip(lower=0.0)
    if osm_buses is not None:
        osm_ids = buses["bus"].map(mapping)
        buses["lon"] = osm_ids.map(osm_buses["x"]).astype(float)
        buses["lat"] = osm_ids.map(osm_buses["y"]).astype(float)
    lines = net.get_lines(attributes=["voltage_level1_id", "voltage_level2_id"])
    c1 = lines["voltage_level1_id"].map(buses["country"])
    c2 = lines["voltage_level2_id"].map(buses["country"])
    pairs = {frozenset((a, b)) for a, b in zip(c1, c2) if isinstance(a, str) and isinstance(b, str) and a != b}
    return Grid(buses=buses, ac_pairs=pairs)


def read_observed(path: Path) -> dict:
    record = json.loads(Path(path).read_text(encoding="utf-8"))
    if record.get("schema") != "costudy4grid-observed-hour/1":
        raise ValueError(f"{path}: not an observed-hour file")
    return record


#: Variants of one quantity a country may report side by side: only the
#: first present counts (installed solar comes as AC and DC capacity).
ALTERNATIVES = (("solar_ac", "solar", "solar_dc"),)


def _codes(series: dict, scale: float) -> dict[str, float]:
    """Energy-Charts series (MW) summed by fuel type."""
    skip = set()
    for variants in ALTERNATIVES:
        present = [v for v in variants if isinstance(series.get(v), (int, float))]
        skip.update(present[1:])
    out: dict[str, float] = {}
    for key, mw in series.items():
        code = SERIES_CODE.get(key)
        if code is not None and key not in skip and isinstance(mw, (int, float)):
            out[code] = out.get(code, 0.0) + float(mw) * scale
    return out


# ─────────────────────────────────────────────────────────────────────────────
# Targets per country
# ─────────────────────────────────────────────────────────────────────────────


@dataclass
class Target:
    """What one country must consume and produce in the situation."""

    load: float = 0.0
    production: dict[str, float] = field(default_factory=dict)
    installed: dict[str, float] = field(default_factory=dict)
    flows: dict[str, float] = field(default_factory=dict)  # + = import, MW
    source: str = "observed"  # observed | fallback | boundary
    reported_load: float | None = None


#: A balanced load further than this from the reported one is not trusted.
BALANCE_TOLERANCE = 0.2


def balanced_load(load: float, production: dict[str, float], flows: dict[str, float]) -> float:
    """The load the hour's own production and physical imports serve.

    The figures of one country rarely close (unreported self-supply, small
    units…): consuming exactly what is produced and imported keeps every
    country's exchanges at their observed level once the flows are solved."""
    if not flows:
        return load
    balanced = sum(production.values()) + sum(flows.values())
    return balanced if abs(balanced - load) <= BALANCE_TOLERANCE * load else load


def country_targets(grid: Grid, observed: dict, plants: pd.DataFrame) -> dict[str, Target]:
    """Observed load and production per country; a lacking country is filled
    in from its synthetic load and its observed neighbours' exchanges."""
    data = observed["countries"]
    countries = sorted(c for c in grid.buses["country"].unique() if c)
    synthetic = grid.buses.groupby("country")["key"].sum()
    seen = [c for c in countries if c in data and c not in BOUNDARY_ONLY]
    k = (sum(data[c]["load"] * COVERAGE.get(c, 1.0) for c in seen)
         / max(1e-9, float(synthetic.reindex(seen).sum())))
    targets: dict[str, Target] = {}
    for c in countries:
        if c in BOUNDARY_ONLY:
            targets[c] = Target(source="boundary", flows=dict(data.get(c, {}).get("flows", {})))
            continue
        if c in data:
            d, s = data[c], COVERAGE.get(c, 1.0)
            production = _codes(d["production"], s)
            flows = dict(d.get("flows", {}))
            load = float(d["load"]) * s
            if c not in COVERAGE:
                load = balanced_load(load, production, flows)
            targets[c] = Target(load=load, production=production,
                                installed=_codes(d.get("installed", {}), s), flows=flows,
                                reported_load=float(d["load"]) * s)
            continue
        # Lacking: the synthetic load at the observed level; production covers
        # it plus the exchanges its observed neighbours report with it.
        load = float(synthetic.get(c, 0.0)) * k
        export = sum(data[n]["flows"][c] for n in data
                     if c in data[n].get("flows", {}) and frozenset((c, n)) in grid.ac_pairs)
        total = max(0.0, load + export)
        fleet = plants[plants["country"] == c]
        typical = (fleet["capacity"] * fleet["code"].map(TYPICAL_LF).fillna(0.3)).groupby(fleet["code"]).sum()
        mix = (typical / typical.sum()) if typical.sum() > 0 else pd.Series({"OTH": 1.0})
        targets[c] = Target(load=load, production={code: total * float(w) for code, w in mix.items()},
                            source="fallback")
        log.info("  %s: no data — load %.0f MW (synthetic × %.2f), production %.0f MW", c, load, k, total)
    return targets


# ─────────────────────────────────────────────────────────────────────────────
# Plants: one generator per (bus, fuel type), nuclear unit by unit
# ─────────────────────────────────────────────────────────────────────────────


COLUMNS = ["id", "vl", "code", "capacity", "efficiency", "name", "plant", "plant_lon", "plant_lat"]


def plant_table(grid: Grid, record: dict) -> pd.DataFrame:
    """Matched capacity as generator rows: ``id``, ``vl``, ``country``,
    ``code``, ``capacity``, ``efficiency``, ``name``, and for a nuclear unit
    its ``plant`` and the plant's real site (``plant_lon``, ``plant_lat``).
    Each bus's ``G_<bus>`` is its solar generator (a row even without
    matched solar)."""
    rows = []
    vl_of = {f"G_{b}": vl for vl, b in grid.buses["bus"].items()}
    for gen, entry in record.get("generators", {}).items():
        vl = vl_of.get(gen)
        if vl is None:
            continue
        bus = gen[2:]
        by_code: dict[str, float] = {}
        eff_num: dict[str, float] = {}
        eff_den: dict[str, float] = {}
        for ppm, mw in entry.get("capacity_mw", {}).items():
            code = PPM_CODE.get(ppm, "OTH")
            by_code[code] = by_code.get(code, 0.0) + float(mw)
            eff = entry.get("efficiency", {}).get(ppm)
            if eff:
                eff_num[code] = eff_num.get(code, 0.0) + eff * float(mw)
                eff_den[code] = eff_den.get(code, 0.0) + float(mw)
        site = entry.get("sites", {}).get("Nuclear")
        for code, mw in by_code.items():
            eff = eff_num[code] / eff_den[code] if eff_den.get(code) else np.nan
            if code == "NUC" and site and site.get("units"):
                for i, (unit, cap) in enumerate(site["units"], start=1):
                    rows.append((f"G_{bus}_NUC{i}", vl, "NUC", float(cap), np.nan, str(unit),
                                 site["name"], site.get("lon", np.nan), site.get("lat", np.nan)))
            elif code == "SOL":
                rows.append((gen, vl, "SOL", mw, np.nan, None, None, np.nan, np.nan))
            else:
                rows.append((f"G_{bus}_{code}", vl, code, mw, eff, None, None, np.nan, np.nan))
    table = pd.DataFrame(rows, columns=COLUMNS)
    solar = set(table.loc[table["code"] == "SOL", "id"])
    missing = [(f"G_{b}", vl, "SOL", 0.0, np.nan, None, None, np.nan, np.nan)
               for vl, b in grid.buses["bus"].items() if f"G_{b}" not in solar]
    table = pd.concat([table, pd.DataFrame(missing, columns=COLUMNS)], ignore_index=True)
    table["country"] = table["vl"].map(grid.buses["country"])
    return table.set_index("id")


def _top_buses(grid: Grid, country: str, n: int) -> list[str]:
    return grid.of(country).sort_values("key", ascending=False).index[:n].tolist()


def _spread(grid: Grid, country: str, everywhere: bool) -> pd.Series:
    """Load-key shares over a country's buses (or its largest load buses)."""
    buses = grid.of(country)
    if not everywhere:
        n = max(FALLBACK_BUSES, int(math.ceil(FALLBACK_SHARE * len(buses))))
        buses = buses.loc[_top_buses(grid, country, n)]
    key = buses["key"]
    return key / key.sum() if key.sum() > 0 else key * 0 + 1.0 / max(1, len(key))


def complete_capacity(table: pd.DataFrame, grid: Grid, targets: dict[str, Target]) -> pd.DataFrame:
    """Add the installed capacity the database misses: embedded types
    (rooftop solar onto each bus's own ``G_<bus>``, untyped production) spread
    by load over every bus; other types scale their matched plants up (at
    most ``MAX_SCALE_UP`` times), the rest — or all of a type no plant was
    matched for — spread by load over the country's largest load buses."""
    table = table.copy()
    extra = []
    for c, t in targets.items():
        if t.source == "boundary":
            continue
        rows = table["country"] == c
        for code in set(t.installed) | set(t.production):
            if code == "NUC":
                continue
            installed = max(t.installed.get(code, 0.0), abs(t.production.get(code, 0.0)) / 0.95)
            mine = rows & (table["code"] == code)
            matched = float(table.loc[mine, "capacity"].sum())
            if installed <= matched or installed <= 0:
                continue
            if code == "SOL":
                share = _spread(grid, c, everywhere=True)
                gens = "G_" + grid.buses.loc[share.index, "bus"]
                table.loc[gens.to_numpy(), "capacity"] += (installed - matched) * share.to_numpy()
                continue
            rest = installed
            if matched > 0 and code not in EMBEDDED:
                factor = min(MAX_SCALE_UP, installed / matched)
                table.loc[mine, "capacity"] *= factor
                rest = installed - matched * factor
            elif matched > 0:
                rest = installed - matched
            if rest > 1.0:
                for vl, w in _spread(grid, c, everywhere=code in EMBEDDED).items():
                    if rest * w < 0.5:
                        continue
                    bus = grid.buses.at[vl, "bus"]
                    extra.append((f"G_{bus}_{code}", vl, code, rest * float(w),
                                  np.nan, None, None, np.nan, np.nan, c))
    if extra:
        add = pd.DataFrame(extra, columns=COLUMNS + ["country"]).set_index("id")
        first = {col: "first" for col in add.columns if col != "capacity"}
        add = add.groupby(level=0).agg({**first, "capacity": "sum"})
        known = add.index.isin(table.index)
        table.loc[add.index[known], "capacity"] += add.loc[known, "capacity"]
        table = pd.concat([table, add[~known]])
    return table


def observed_dispatch(table: pd.DataFrame, targets: dict[str, Target]) -> pd.Series:
    """Each country's production of each type shared by capacity (a plant
    can draw power for pumping or charging); capacities stretched where the
    observed output exceeds them."""
    target_p = pd.Series(0.0, index=table.index)
    for c, t in targets.items():
        for code, mw in t.production.items():
            mine = (table["country"] == c) & (table["code"] == code)
            cap = float(table.loc[mine, "capacity"].sum())
            if cap <= 0:
                if abs(mw) > 1.0:
                    log.warning("  %s %s: %.0f MW observed but no plant to carry it", c, code, mw)
                continue
            if abs(mw) > 0.98 * cap:
                table.loc[mine, "capacity"] *= abs(mw) / (0.98 * cap)
                cap = float(table.loc[mine, "capacity"].sum())
            target_p[mine] = mw * table.loc[mine, "capacity"] / cap
    return target_p


# ─────────────────────────────────────────────────────────────────────────────
# Optimal dispatch: a PyPSA problem solved in its own environment
# ─────────────────────────────────────────────────────────────────────────────


def marginal_cost(code: str, efficiency: float) -> float:
    """€/MWh: fuel and CO₂ over the plant's efficiency, plus variable O&M."""
    if code in FUEL:
        price, co2, vom = FUEL[code]
        eff = efficiency if efficiency == efficiency and efficiency > 0 else DEFAULT_EFFICIENCY[code]
        return round((price + CO2_EUR_PER_T * co2) / eff + vom, 3)
    return FLAT_COST.get(code, 50.0)


def _line_ratings(osm_dir: Path) -> dict[str, float]:
    """OSM thermal rating per line, √3·U·I_nom·circuits (MVA), by IIDM id."""
    lines = pd.read_csv(osm_dir / "lines.csv", usecols=["line_id", "voltage", "i_nom", "circuits"],
                        quotechar="'")
    s = (math.sqrt(3) * lines["voltage"] * lines["i_nom"]
         * lines["circuits"].fillna(1).clip(lower=1))
    return {safe_id(i): float(v) for i, v in zip(lines["line_id"], s) if v == v and v > 0}


def opf_problem(net, grid: Grid, table: pd.DataFrame, observed_p: pd.Series, loads: pd.Series,
                external: pd.DataFrame, osm_dir: Path, folder: Path) -> None:
    """Export the hour as a PyPSA problem (``dispatch_opf.py``'s input)."""
    folder.mkdir(parents=True, exist_ok=True)
    vls = net.get_voltage_levels(attributes=["nominal_v"])
    pd.DataFrame({"id": grid.buses.index, "v_nom": vls["nominal_v"].reindex(grid.buses.index)}
                 ).to_csv(folder / "buses.csv", index=False)

    ratings = _line_ratings(osm_dir)
    lines = net.get_lines(attributes=["voltage_level1_id", "voltage_level2_id", "r", "x",
                                      "connected1", "connected2"])
    lines = lines[lines["connected1"] & lines["connected2"]]
    kv = lines["voltage_level1_id"].map(vls["nominal_v"]).round().astype(int)
    s_nom = [ratings.get(i, ratings.get(re.sub(r"_\d+$", "", i), DEFAULT_S_NOM.get(k, 1000.0)))
             for i, k in zip(lines.index, kv)]
    pd.DataFrame({"id": lines.index, "bus0": lines["voltage_level1_id"], "bus1": lines["voltage_level2_id"],
                  "r": lines["r"].clip(lower=0.0), "x": lines["x"].clip(lower=1e-3), "s_nom": s_nom}
                 ).to_csv(folder / "lines.csv", index=False)

    tr = net.get_2_windings_transformers(attributes=["voltage_level1_id", "voltage_level2_id", "r", "x",
                                                     "rated_u2", "rated_s", "connected1", "connected2"])
    tr = tr[tr["connected1"] & tr["connected2"]]
    s_tr = tr["rated_s"].where(tr["rated_s"] > 0, 1000.0)
    z_base = tr["rated_u2"] ** 2 / s_tr
    pd.DataFrame({"id": tr.index, "bus0": tr["voltage_level1_id"], "bus1": tr["voltage_level2_id"],
                  "r": (tr["r"] / z_base).clip(lower=0.0), "x": (tr["x"] / z_base).clip(lower=1e-4),
                  "s_nom": s_tr}).to_csv(folder / "transformers.csv", index=False)

    g = table[table["capacity"] > 0]
    obs_pu = (observed_p.reindex(g.index).fillna(0.0) / g["capacity"]).clip(-1.0, 1.0)
    free = g["code"].isin(DISPATCHABLE)
    # Between zero and the observed output (a pump between zero and its
    # observed draw); dispatchable thermal up to its availability.
    p_max = np.where(free, THERMAL_AVAILABILITY, np.maximum(obs_pu, 0.0))
    p_min = np.minimum(obs_pu, 0.0)
    pd.DataFrame({
        "id": g.index, "bus": g["vl"], "carrier": g["code"], "p_nom": g["capacity"].round(3),
        "marginal_cost": [marginal_cost(k, e) for k, e in zip(g["code"], g["efficiency"])],
        "p_min_pu": np.round(p_min, 6), "p_max_pu": np.round(p_max, 6),
    }).to_csv(folder / "generators.csv", index=False)

    demand = pd.DataFrame({"id": "L_" + grid.buses["bus"], "bus": grid.buses.index,
                           "p_set": loads.reindex(grid.buses.index).fillna(0.0).round(3)})
    exchanges = pd.DataFrame({"id": external.index, "bus": external["vl"], "p_set": external["p0"].round(3)})
    pd.concat([demand, exchanges]).to_csv(folder / "loads.csv", index=False)
    (folder / "meta.json").write_text(json.dumps({"s_max_pu": S_MAX_PU, "shedding_cost": SHEDDING_COST}),
                                      encoding="utf-8")


def opf_dispatch(folder: Path, python: str) -> tuple[pd.Series, dict]:
    """Solve the exported problem with PyPSA in ``python``'s environment."""
    import subprocess
    out = folder / "dispatch.csv"
    subprocess.run([python, str(Path(__file__).with_name("dispatch_opf.py")),
                    "--problem", str(folder), "--out", str(out)], check=True)
    summary = json.loads(out.with_suffix(".json").read_text(encoding="utf-8"))
    return pd.read_csv(out, index_col="id")["p"], summary


# ─────────────────────────────────────────────────────────────────────────────
# Exchanges with what the bundle leaves out
# ─────────────────────────────────────────────────────────────────────────────


def hvdc_landings(osm_dir: Path, mapping: dict[str, str], grid: Grid) -> pd.DataFrame:
    """HVDC links crossing a border, with the bundle bus each end lands on:
    ``link``, ``p_nom``, ``c0``, ``vl0``, ``c1``, ``vl1`` (``vl`` NaN when that
    end's country is outside the bundle)."""
    q = {"quotechar": "'"}
    buses = pd.read_csv(osm_dir / "buses.csv", index_col=0, usecols=["bus_id", "dc", "x", "y", "country"], **q)
    links = pd.read_csv(osm_dir / "links.csv", usecols=["link_id", "bus0", "bus1", "p_nom"], **q)
    conv = pd.read_csv(osm_dir / "converters.csv", usecols=["bus0", "bus1"], **q)
    ac_of: dict[str, str] = {}
    for a, b in zip(conv["bus0"], conv["bus1"]):
        for dc, ac in ((a, b), (b, a)):
            if dc in buses.index and str(buses.at[dc, "dc"]) == "t":
                ac_of.setdefault(dc, ac)
    vl_of = {osm: f"VL_{s}" for s, osm in mapping.items()}
    countries = set(grid.buses["country"])
    rows = []
    for _, link in links.iterrows():
        ends = []
        for dc in (link["bus0"], link["bus1"]):
            ac = ac_of.get(dc, dc)
            country = str(buses.at[ac, "country"]) if ac in buses.index else "?"
            vl = vl_of.get(ac)
            if vl is None and country in countries and ac in buses.index:
                vl = _nearest(grid, country, float(buses.at[ac, "x"]), float(buses.at[ac, "y"]))
            ends.append((country, vl))
        if ends[0][0] != ends[1][0]:
            rows.append((link["link_id"], float(link["p_nom"]), ends[0][0], ends[0][1], ends[1][0], ends[1][1]))
    return pd.DataFrame(rows, columns=["link", "p_nom", "c0", "vl0", "c1", "vl1"])


def _nearest(grid: Grid, country: str, lon: float, lat: float) -> str | None:
    cand = grid.of(country)
    if cand.empty or "lon" not in cand:
        return None
    d = ((cand["lon"] - lon) * math.cos(math.radians(lat))) ** 2 + (cand["lat"] - lat) ** 2
    return str(d.idxmin())


def external_injections(grid: Grid, targets: dict[str, Target], links: pd.DataFrame) -> pd.DataFrame:
    """Fixed injections for every observed exchange the bundle's AC grid does
    not carry: ``id``, ``vl``, ``country``, ``neighbour``, ``p0`` (MW, + = export,
    a fictitious load)."""
    rows: list[tuple[str, str, str, float, str]] = []
    modelled = set(targets)
    done: set[frozenset] = set()

    def add(c: str, vl: str | None, n: str, export: float, how: str) -> None:
        if vl is not None and abs(export) >= 1.0:
            rows.append((vl, c, n, export, how))

    for c, t in targets.items():
        if t.source == "boundary":
            # The rest of the country feeds what its modelled neighbours
            # report importing from it over the AC lines the bundle keeps.
            for n in modelled:
                if frozenset((c, n)) in grid.ac_pairs:
                    imp_n = targets[n].flows.get(c)
                    if imp_n is not None:
                        add(c, _top_buses(grid, c, 1)[0], c, -imp_n, "boundary")
            continue
        for n, imp in t.flows.items():
            pair = frozenset((c, n))
            if n == c or pair in grid.ac_pairs or pair in done:
                continue
            fwd = links[(links["c0"] == c) & (links["c1"] == n)]
            bwd = links[(links["c1"] == c) & (links["c0"] == n)]
            mine = pd.concat([fwd[["vl0", "p_nom"]].set_axis(["vl", "p_nom"], axis=1),
                              bwd[["vl1", "p_nom"]].set_axis(["vl", "p_nom"], axis=1)]).dropna()
            theirs = pd.concat([fwd[["vl1", "p_nom"]].set_axis(["vl", "p_nom"], axis=1),
                                bwd[["vl0", "p_nom"]].set_axis(["vl", "p_nom"], axis=1)]).dropna()
            if not mine.empty:
                cap = float(mine["p_nom"].sum())
                flow = max(-cap, min(cap, imp))
                for vl, p in zip(mine["vl"], mine["p_nom"]):
                    add(c, vl, n, -flow * p / cap, "hvdc")
                if n in targets and not theirs.empty and targets[n].source != "boundary":
                    done.add(pair)
                    for vl, p in zip(theirs["vl"], theirs["p_nom"]):
                        add(n, vl, c, flow * p / float(theirs["p_nom"].sum()), "hvdc")
                continue
            point = BORDER_POINTS.get(n)
            vl = _nearest(grid, c, *point) if point else None
            add(c, vl or _top_buses(grid, c, 1)[0], n, -imp, "border")
    out = pd.DataFrame(rows, columns=["vl", "country", "neighbour", "p0", "how"])
    out = out.groupby(["vl", "country", "neighbour", "how"], as_index=False)["p0"].sum()
    out.index = [f"X_{n}_{vl[3:]}" for n, vl in zip(out["neighbour"], out["vl"])]
    return out


# ─────────────────────────────────────────────────────────────────────────────
# Writing the network
# ─────────────────────────────────────────────────────────────────────────────


def _node_tops(net) -> dict[str, int]:
    sw = net.get_switches(attributes=["voltage_level_id", "node1", "node2"])
    return sw.groupby("voltage_level_id")[["node1", "node2"]].max().max(axis=1).astype(int).to_dict()


def _bays(ids: list[str], vls: list[str], tops: dict[str, int]) -> tuple[list[int], pd.DataFrame]:
    """A feeder bay per element, as the bundle builds them: disconnector to
    busbar 1 (closed), breaker, disconnector to busbar 2 (open)."""
    nodes, rows = [], []
    for eid, vl in zip(ids, vls):
        top = tops.get(vl, 15)
        mid, end = top + 1, top + 2
        tops[vl] = end
        nodes.append(end)
        rows += [(f"{vl}_D_{eid}", vl, 0, mid, "DISCONNECTOR", False, f"D {eid[:25]}"),
                 (f"{vl}_BK_{eid}", vl, mid, end, "BREAKER", False, f"BK {eid[:24]}"),
                 (f"{vl}_D2_{eid}", vl, 1, mid, "DISCONNECTOR", True, f"D2 {eid[:24]}")]
    sw = pd.DataFrame(rows, columns=["id", "voltage_level_id", "node1", "node2", "kind", "open", "name"])
    return nodes, sw.set_index("id")


def write_injections(net, grid: Grid, table: pd.DataFrame, target_p: pd.Series,
                     loads: pd.Series, external: pd.DataFrame) -> None:
    """Loads, the solar ``G_<bus>``, new plant generators and exchanges."""
    bbs = net.get_busbar_sections(attributes=["voltage_level_id"])
    double = set(bbs.groupby("voltage_level_id").size().loc[lambda s: s >= 2].index)
    load_ids = "L_" + grid.buses["bus"]
    p0 = loads.reindex(grid.buses.index).fillna(0.0).to_numpy()
    net.update_loads(pd.DataFrame({"p0": p0, "q0": p0 * TAN_PHI}, index=pd.Index(load_ids, name="id")))

    names = grid.buses["name"]
    is_new = ~table.index.isin(net.get_generators(attributes=[]).index)
    table = table.assign(target_p=target_p.reindex(table.index).fillna(0.0))
    table["max_p"] = np.maximum(table["capacity"], table["target_p"].abs())
    table["min_p"] = np.where(table["code"].isin(BIDIRECTIONAL), -table["max_p"], 0.0)
    labels = table["code"].map(lambda k: CARRIERS[k][0])
    table["label"] = np.where(table["name"].notna(), table["name"],
                              table["vl"].map(names).astype(str) + " " + labels)

    old = table[~is_new]
    net.update_generators(pd.DataFrame({
        "energy_source": old["code"].map(lambda k: CARRIERS[k][1]),
        "target_p": old["target_p"], "min_p": old["min_p"], "max_p": old["max_p"],
        "name": old["label"],
    }, index=pd.Index(old.index, name="id")))

    new = table[is_new]
    tops = _node_tops(net)
    nodes, sw = _bays(new.index.tolist(), new["vl"].tolist(), tops)
    single = ~sw["voltage_level_id"].isin(double) & sw.index.str.contains("_D2_")
    net.create_switches(sw[~single])
    net.create_generators(pd.DataFrame({
        "voltage_level_id": new["vl"], "node": nodes,
        "energy_source": new["code"].map(lambda k: CARRIERS[k][1]),
        "target_p": new["target_p"], "min_p": new["min_p"], "max_p": new["max_p"],
        "target_v": new["vl"].map(grid.buses["target_v"]).fillna(400.0),
        "target_q": 0.0, "voltage_regulator_on": True, "name": new["label"],
    }, index=new.index))
    props = pd.DataFrame({"carrier": labels}, index=pd.Index(table.index, name="id"))
    net.add_elements_properties(props)
    sited = table[table["plant"].notna()]
    if len(sited):
        net.add_elements_properties(pd.DataFrame({
            "plant": sited["plant"].astype(str),
            "plant_lon": sited["plant_lon"].map(lambda v: f"{v:.5f}"),
            "plant_lat": sited["plant_lat"].map(lambda v: f"{v:.5f}"),
        }, index=pd.Index(sited.index, name="id")))

    if len(external):
        nodes, sw = _bays(external.index.tolist(), external["vl"].tolist(), tops)
        single = ~sw["voltage_level_id"].isin(double) & sw.index.str.contains("_D2_")
        net.create_switches(sw[~single])
        net.create_loads(pd.DataFrame({
            "voltage_level_id": external["vl"], "node": nodes, "p0": external["p0"], "q0": 0.0,
            "type": "FICTITIOUS",
            "name": [f"Exchange with {n}" for n in external["neighbour"]],
        }, index=external.index))
        net.add_elements_properties(pd.DataFrame({"neighbour": external["neighbour"]},
                                                 index=pd.Index(external.index, name="id")))


def _lf_parameters():
    """The RTE OpenLoadFlow parameters the app runs with, when installed."""
    try:
        from expert_op4grid_recommender.utils.make_env_utils import create_olf_rte_parameter
        return create_olf_rte_parameter()
    except ImportError:
        import pypowsybl as pp
        return pp.loadflow.Parameters(distributed_slack=True)


def balance(net, grid: Grid) -> dict:
    """AC load flow, trimming the (non-fictitious) loads until the distributed
    slack only covers the grid's losses: generation stays as dispatched."""
    import pypowsybl as pp
    params = _lf_parameters()
    load_ids = pd.Index("L_" + grid.buses["bus"], name="id")
    history = []
    for it in range(BALANCE_ITERATIONS):
        result = pp.loadflow.run_ac(net, parameters=params)
        status = result[0].status.name
        gens = net.get_generators(attributes=["target_p", "p", "connected"])
        gens = gens[gens["connected"]]
        slack = float((-gens["p"]).sum() - gens["target_p"].sum())
        history.append({"iteration": it, "status": status, "slack_mw": round(slack, 1)})
        log.info("  load flow %d: %s, slack %.0f MW", it, status, slack)
        if status != "CONVERGED" or abs(slack) < SLACK_TOLERANCE_MW:
            break
        p0 = net.get_loads(attributes=["p0"]).loc[load_ids, "p0"]
        total = float(p0.sum())
        f = 1.0 - slack / total
        net.update_loads(pd.DataFrame({"p0": p0 * f, "q0": p0 * f * TAN_PHI}, index=load_ids))
    loads = net.get_loads(attributes=["p", "type"])
    gens = net.get_generators(attributes=["p"])
    losses = float((-gens["p"]).sum() - loads["p"].sum())
    return {"status": history[-1]["status"], "iterations": history, "losses_mw": round(losses, 1)}


def set_case_date(path: Path, at_utc: str) -> None:
    """Stamp the hour on the file (pypowsybl offers no setter)."""
    text = path.read_text(encoding="utf-8")
    stamp = at_utc.replace("Z", ":00.000Z")
    text = re.sub(r'caseDate="[^"]*"', f'caseDate="{stamp}"', text, count=1)
    path.write_text(text, encoding="utf-8")


def osm_current_limits(osm_dir: Path) -> dict[str, float]:
    """Each line's OSM thermal rating as a permanent current limit (A):
    I_nom × circuits, as the conversion first sets it."""
    lines = pd.read_csv(osm_dir / "lines.csv", usecols=["line_id", "i_nom", "circuits"], quotechar="'")
    amps = lines["i_nom"] * 1000.0 * lines["circuits"].fillna(1).clip(lower=1)
    return {safe_id(i): float(a) for i, a in zip(lines["line_id"], amps) if a == a and a > 0}


def reset_limits(net, path: Path, osm_dir: Path) -> int:
    """Restart every line's limit from its OSM rating (the synthetic
    situation's limits were calibrated on flows five times smaller)."""
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "calibrate_thermal_limits", Path(__file__).with_name("calibrate_thermal_limits.py"))
    calibrate = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(calibrate)
    ratings = osm_current_limits(osm_dir)
    limits = {}
    for lid in net.get_lines(attributes=[]).index:
        amps = ratings.get(lid, ratings.get(re.sub(r"_\d+$", "", lid)))
        if amps:
            limits[lid] = amps
    calibrate._patch_xiidm_limits(path, path, limits)
    return len(limits)


# ─────────────────────────────────────────────────────────────────────────────
# Report
# ─────────────────────────────────────────────────────────────────────────────


def report(net, grid: Grid, targets: dict[str, Target], table: pd.DataFrame,
           external: pd.DataFrame, observed: dict, dispatch: str, lf: dict) -> dict:
    gens = net.get_generators(attributes=["voltage_level_id", "p"])
    gens["country"] = gens["voltage_level_id"].map(grid.buses["country"])
    gens["code"] = table["code"].reindex(gens.index)
    loads = net.get_loads(attributes=["voltage_level_id", "p", "type"])
    loads["country"] = loads["voltage_level_id"].map(grid.buses["country"])
    lines = net.get_lines(attributes=["voltage_level1_id", "voltage_level2_id", "p1", "p2"])
    c1 = lines["voltage_level1_id"].map(grid.buses["country"])
    c2 = lines["voltage_level2_id"].map(grid.buses["country"])
    cross = c1 != c2
    flow = (lines["p1"] - lines["p2"]) / 2.0
    exports: dict[str, float] = {}
    for a, b, f in zip(c1[cross], c2[cross], flow[cross]):
        exports[a] = exports.get(a, 0.0) + f
        exports[b] = exports.get(b, 0.0) - f
    ext = external.groupby("country")["p0"].sum() if len(external) else pd.Series(dtype=float)
    countries = {}
    for c, t in sorted(targets.items()):
        mine = gens[gens["country"] == c]
        prod = (-mine["p"]).groupby(mine["code"]).sum()
        real_loads = loads[(loads["country"] == c) & (loads["type"] != "FICTITIOUS")]
        obs_flows = observed["countries"].get(c, {}).get("flows", {})
        countries[c] = {
            "source": t.source,
            "load_observed_mw": round(t.reported_load if t.reported_load is not None else t.load, 1),
            "load_balanced_mw": round(t.load, 1),
            "load_model_mw": round(float(real_loads["p"].sum()), 1),
            "production_observed_mw": {k: round(v, 1) for k, v in sorted(t.production.items()) if abs(v) >= 0.5},
            "production_model_mw": {k: round(float(v), 1) for k, v in prod.sort_index().items() if abs(v) >= 0.5},
            "net_export_observed_mw": round(-sum(obs_flows.values()), 1) if obs_flows else None,
            "net_export_model_mw": round(exports.get(c, 0.0) + float(ext.get(c, 0.0)), 1),
        }
    return {
        "schema": SCHEMA,
        "at_utc": observed["at_utc"],
        "dispatch": dispatch,
        "sources": [observed["source"], {"name": "powerplantmatching", "licence": "CC BY 4.0",
                                         "url": "https://github.com/PyPSA/powerplantmatching"}],
        "missing_countries": observed.get("missing", {}),
        "loadflow": lf,
        "totals": {
            "load_mw": round(float(loads.loc[loads["type"] != "FICTITIOUS", "p"].sum()), 1),
            "production_mw": round(float((-gens["p"]).clip(lower=0).sum()), 1),
            "external_export_mw": round(float(external["p0"].sum()) if len(external) else 0.0, 1),
            "generators": int(len(table)),
            "external_injections": int(len(external)),
        },
        "countries": countries,
        "external": [{"id": i, "bus": r.vl, "country": r.country, "neighbour": r.neighbour,
                      "export_mw": round(float(r.p0), 1), "kind": r.how}
                     for i, r in external.iterrows()],
    }


# ─────────────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────────────


def _network_path(bundle: Path, network: Path | None, workdir: Path) -> Path:
    if network is not None:
        return network
    plain = bundle / "network.xiidm"
    if plain.is_file():
        return plain
    packed = bundle / "network.xiidm.zip"
    with zipfile.ZipFile(packed) as zf:
        name = next(n for n in zf.namelist() if n.endswith(".xiidm"))
        zf.extract(name, workdir)
    return workdir / name


def build(bundle: Path, observed_path: Path, dispatch: str, osm_dir: Path, out: Path,
          network: Path | None = None, opf_python: str | None = None, limits: str = "osm") -> dict:
    import pypowsybl as pp
    out.mkdir(parents=True, exist_ok=True)
    observed = read_observed(observed_path)
    mapping = json.loads((bundle / "bus_id_mapping.json").read_text(encoding="utf-8"))
    record = json.loads((bundle / "power_plants.json").read_text(encoding="utf-8"))
    osm_buses = pd.read_csv(osm_dir / "buses.csv", index_col=0, usecols=["bus_id", "x", "y"],
                            quotechar="'")
    net = pp.network.load(str(_network_path(bundle, network, out)))
    grid = read_grid(net, mapping, osm_buses)
    log.info("Bundle: %d buses, %d countries", len(grid.buses), grid.buses["country"].nunique())

    table = plant_table(grid, record)
    targets = country_targets(grid, observed, table)
    table = complete_capacity(table, grid, targets)
    external = external_injections(grid, targets, hvdc_landings(osm_dir, mapping, grid))
    loads = pd.Series(0.0, index=grid.buses.index)
    for c, t in targets.items():
        key = grid.of(c)["key"]
        if t.load > 0 and key.sum() > 0:
            loads[key.index] = t.load * key / key.sum()

    target_p = observed_dispatch(table, targets)
    opf = None
    if dispatch == "opf":
        import sys
        problem = out / "opf_problem"
        opf_problem(net, grid, table, target_p, loads, external, osm_dir, problem)
        target_p, opf = opf_dispatch(problem, opf_python or sys.executable)
    elif dispatch != "observed":
        raise ValueError(f"unknown dispatch {dispatch!r}")
    log.info("Dispatch %s: %.0f MW for %.0f MW of load, %d generators",
             dispatch, float(target_p.clip(lower=0).sum()), float(loads.sum()), len(table))

    write_injections(net, grid, table, target_p, loads, external)
    lf = balance(net, grid)
    path = out / "network.xiidm"
    net.save(str(path), format="XIIDM")
    set_case_date(path, observed["at_utc"])
    summary = report(net, grid, targets, table, external, observed, dispatch, lf)
    if limits == "osm":
        summary["limits"] = {"base": "osm", "lines": reset_limits(net, path, osm_dir)}
    if opf is not None:
        summary["opf"] = opf
    (out / "situation.json").write_text(json.dumps(summary, indent=1, ensure_ascii=False) + "\n",
                                        encoding="utf-8")
    log.info("Wrote %s (load %.0f MW, production %.0f MW, losses %.0f MW)", path,
             summary["totals"]["load_mw"], summary["totals"]["production_mw"], lf["losses_mw"])
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--bundle", required=True, type=Path,
                        help="Bundle directory (bus_id_mapping.json, power_plants.json, network).")
    parser.add_argument("--network", type=Path, default=None,
                        help="Network file to start from (default: the bundle's).")
    parser.add_argument("--observed", required=True, type=Path,
                        help="Observed hour (fetch_energy_charts.py output).")
    parser.add_argument("--dispatch", choices=("observed", "opf"), default="observed")
    parser.add_argument("--osm-dir", type=Path, default=BASE_DIR / "data" / "pypsa_eur_osm",
                        help="OSM CSVs the bundle was built from (HVDC links, coordinates).")
    parser.add_argument("--out", required=True, type=Path, help="Output directory.")
    parser.add_argument("--opf-python", default=None,
                        help="Python with pypsa + highspy for --dispatch opf (default: this one).")
    parser.add_argument("--limits", choices=("osm", "keep"), default="osm",
                        help="Line limits: restart from the OSM ratings (default) or keep the bundle's.")
    args = parser.parse_args()
    build(args.bundle, args.observed, args.dispatch, args.osm_dir, args.out, args.network,
          args.opf_python, args.limits)


if __name__ == "__main__":
    main()
