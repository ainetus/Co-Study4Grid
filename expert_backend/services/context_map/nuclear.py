# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0
# This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

"""Nuclear units layer — Carte-Front's ``_draw_nuclear``, on a network.

One dot per unit, on a small ring around its PLANT, filled by its output
level; a stopped unit is a hollow dot; each plant is circled by a light
dashed outline. Carte-Front's choices, kept:

* plants sit at their REAL coordinates (``PLANT_LONLAT``, public facts): the
  op4grid plan is a drawing (~30 km off), and a plant known to the metre
  should not land in the sea;
* units a model splits across several substations (Cattenom across four)
  are gathered under their plant (``RTE_SITE_PLANT``);
* a unit runs when ``|P| ≥ 1 MW``.

One difference: Carte-Front reads a day of measurements without Pmax, so it
scales every unit to the day's strongest output. A situation file carries
each unit's ``maxP``: the level here is ``P / maxP``, unit by unit.

Units are generators typed nuclear (``genreCvg`` NUCLEAIRE, else
``energySource`` NUCLEAR), plus — on an untyped network with matched
plants (``plants.py``) — the real units of each matched nuclear plant, on
its real site, at their real capacity and their share of the zone's
typed nuclear production. A typed unit names its plant and site in its
``plant`` / ``plant_lon`` / ``plant_lat`` properties when the network has
them (a PyPSA-EUR situation rebuilt on a real hour); otherwise its plant
outside the table is placed at its voltage level's georeferenced
position, or left out. On the region mesh only the home country's units
are drawn, as on Carte-Front.
"""
from __future__ import annotations

import math
import re
import unicodedata

import numpy as np
import pandas as pd

from expert_backend.services.context_map import geography
from expert_backend.services.context_map.aggregate import (
    UNKNOWN_ZONE,
    Zoning,
    matched_fleets,
    network_filiere,
)
from expert_backend.services.context_map.snapshot import NetworkSnapshot

#: Real coordinates (lon, lat) of the French nuclear plants (Carte-Front
#: ``nuclear.PLANT_LONLAT``), plus Fessenheim — closed in 2020, still in the
#: older snapshots the reconstructed RTE7000 grids are built from.
PLANT_LONLAT: dict[str, tuple[float, float]] = {
    "Belleville": (2.8753, 47.5097),
    "Blayais": (-0.6931, 45.2558),
    "Bugey": (5.2708, 45.7986),
    "Cattenom": (6.2181, 49.4158),
    "Chinon": (0.1706, 47.2306),
    "Chooz": (4.7892, 50.0900),
    "Civaux": (0.6531, 46.4572),
    "Cruas": (4.7564, 44.6331),
    "Dampierre": (2.5167, 47.7331),
    "Fessenheim": (7.5631, 47.9031),
    "Flamanville": (-1.8817, 49.5361),
    "Golfech": (0.8453, 44.1064),
    "Gravelines": (2.1361, 51.0156),
    "Nogent": (3.5181, 48.5153),
    "Paluel": (0.6353, 49.8581),
    "Penly": (1.2119, 49.9761),
    "Saint-Alban": (4.7550, 45.4044),
    "Saint-Laurent": (1.5786, 47.7200),
    "Tricastin": (4.7322, 44.3297),
}

#: RTE substation code → plant, for the codes that do not spell the plant
#: (Carte-Front's unit referential, reduced to its sites).
RTE_SITE_PLANT: dict[str, str] = {
    "BVIL7": "Belleville", "BVILX": "Belleville", "BLAYA": "Blayais", "BUGEY": "Bugey",
    "CATG1": "Cattenom", "CATG2": "Cattenom", "CATG3": "Cattenom", "CATG4": "Cattenom",
    "CHIN2": "Chinon", "CHINX": "Chinon", "CHOO1": "Chooz", "CHOO2": "Chooz",
    "CIVAU": "Civaux", "CRUA5": "Cruas", "D.BUR": "Dampierre", "D.BUX": "Dampierre",
    "FESS5": "Fessenheim", "FLAMA": "Flamanville", "GOLF5": "Golfech", "GRAV5": "Gravelines",
    "N.SE1": "Nogent", "N.SE2": "Nogent", "PALUE": "Paluel", "PENLY": "Penly",
    "SSAL7": "Saint-Alban", "SSEA2": "Saint-Laurent", "TRICA": "Tricastin",
}

RUNNING_THRESHOLD_MW = 1.0
#: Margin (degrees of latitude) of a plant outline around its units.
GROUP_MARGIN_DEG = 0.045


def _folded(text: str) -> str:
    """Upper-case letters only, accents dropped: "Saint-Alban" → "SAINTALBAN"."""
    plain = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    return re.sub(r"[^A-Z]", "", plain.upper())


_PLANT_BY_FOLDED = {_folded(p): p for p in PLANT_LONLAT}


def plant_of(substation: str, name: str) -> str | None:
    """The plant a substation belongs to: by RTE code, else by its name."""
    if substation in RTE_SITE_PLANT:
        return RTE_SITE_PLANT[substation]
    folded = _folded(name)
    return next((p for key, p in _PLANT_BY_FOLDED.items() if key and key in folded), None)


def ring_offsets(count: int, lat0: float) -> list[tuple[float, float]]:
    """(dlon, dlat) spreading ``count`` co-located units on a small ring —
    Carte-Front ``_ring_offsets`` (~4.5 km for six units, round on screen)."""
    if count <= 1:
        return [(0.0, 0.0)]
    radius = 0.022 + 0.005 * count
    aspect = 1.0 / math.cos(math.radians(lat0))
    return [(radius * aspect * math.cos(2 * math.pi * i / count - math.pi / 2),
             radius * math.sin(2 * math.pi * i / count - math.pi / 2)) for i in range(count)]


def _matched_units(snap: NetworkSnapshot, zoning: Zoning) -> pd.DataFrame:
    """The units of the nuclear plants matched onto untyped generators
    (``plants.py``), on the plant's real site, each at its real capacity.

    A plant's output is its share of its zone's typed production
    (``matched_fleets``: the zone's untyped MW over its fleet's typical
    output), split over its units by capacity — so the dots add up to the
    pie's nuclear slice."""
    plants = snap.plants
    sites = plants.nuclear_sites if plants else {}
    gens = snap.generators
    if plants is None or not sites or gens.empty:
        return pd.DataFrame()
    fleets = matched_fleets(snap, zoning)
    untyped = network_filiere(gens).isna()
    rows, index = [], []
    for gen, site in sites.items():
        if gen not in gens.index or not untyped[gen]:
            continue
        vl = gens.at[gen, "vl"]
        fleet = fleets.get(zoning.vl_zone.get(vl, UNKNOWN_ZONE))
        if fleet is None:
            continue
        output = plants.expected[gen].get("nuclear", 0.0) * fleet.scale
        for k, (unit, capacity) in enumerate(site.units or [(site.name, site.capacity)], start=1):
            mw = output * capacity / site.capacity
            index.append(f"{gen}#{k}")
            rows.append({"vl": vl, "p": -mw, "target": mw, "max_p": capacity, "name": unit,
                         "site": site.name, "site_lon": site.lon, "site_lat": site.lat,
                         "estimated": True})
    return pd.DataFrame(rows, index=index)


def _units(snap: NetworkSnapshot, zoning: Zoning) -> pd.DataFrame:
    """Nuclear units to draw, with their plant (or substation) and output."""
    parts = [u for u in (snap.nuclear, _matched_units(snap, zoning)) if not u.empty]
    if not parts:
        return pd.DataFrame()
    units = pd.concat(parts)
    for col in ("name", "site", "site_lon", "site_lat"):
        if col not in units.columns:
            units[col] = float("nan")
    units["estimated"] = units["estimated"].fillna(False).astype(bool) if "estimated" in units else False
    units = units.assign(substation=units["vl"].map(snap.vl_substation),
                         zone=units["vl"].map(zoning.vl_zone))
    if zoning.mesh == "region":
        units = units[units["zone"].map(zoning.zone_country) == zoning.home]
    power = units["p"].where(units["p"].notna(), -units["target"]).abs()
    plants = [site if isinstance(site, str) and site else plant_of(str(s), snap.names.get(str(s), ""))
              for site, s in zip(units["site"], units["substation"])]
    return units.assign(power=power.fillna(0.0), plant=plants)


def _anchor(group: pd.DataFrame, plant: str | None, vl_lonlat: dict) -> tuple[float, float] | None:
    """A matched plant's own site, else the known plant, else its levels."""
    sited = group.dropna(subset=["site_lon", "site_lat"])
    if not sited.empty:
        return float(sited["site_lon"].mean()), float(sited["site_lat"].mean())
    if plant in PLANT_LONLAT:
        return PLANT_LONLAT[plant]
    points = [vl_lonlat[vl] for vl in group["vl"] if vl in vl_lonlat]
    return tuple(np.mean(points, axis=0)) if points else None


def _level(power: float, pmax: float, fallback: float) -> float:
    scale = pmax if pmax == pmax and pmax > 0 else fallback
    return float(min(max(power / scale, 0.0), 1.0)) if scale > 0 else 0.0


def nuclear_layer(snap: NetworkSnapshot, zoning: Zoning,
                  vl_lonlat: dict[str, tuple[float, float]], lat0: float) -> dict:
    """``{"plants": [...], "units": [...]}`` projected for the drawing frame."""
    units = _units(snap, zoning)
    out: dict = {"plants": [], "units": []}
    if units.empty:
        return out
    strongest = float(units["power"].max())
    keys = units["plant"].where(units["plant"].notna(), units["substation"])
    for key, group in units.groupby(keys, sort=True):
        plant = group["plant"].iloc[0]
        anchor = _anchor(group, plant, vl_lonlat)
        if anchor is None:
            continue
        group = group.sort_index()
        positions = [(anchor[0] + dlon, anchor[1] + dlat)
                     for dlon, dlat in ring_offsets(len(group), lat0)]
        running = group["power"] >= RUNNING_THRESHOLD_MW
        for (uid, row), pos, runs in zip(group.iterrows(), positions, running):
            x, y = geography.project(*pos, lat0)
            out["units"].append({
                "id": uid, "name": row["name"] if isinstance(row["name"], str) else None,
                "plant": str(key), "x": x, "y": y, "running": bool(runs),
                "p": round(float(row["power"]), 1) if runs else 0.0,
                "pmax": round(float(row["max_p"]), 1) if row["max_p"] == row["max_p"] else None,
                "level": _level(float(row["power"]), float(row["max_p"]), strongest) if runs else 0.0,
            })
        cx, cy = np.mean(positions, axis=0)
        aspect = 1.0 / math.cos(math.radians(lat0))
        r = max(math.hypot((px - cx) / aspect, py - cy) for px, py in positions) + GROUP_MARGIN_DEG
        x, y = geography.project(cx, cy, lat0)
        label = plant or snap.names.get(str(key), str(key))
        out["plants"].append({
            "id": str(key), "name": label, "x": x, "y": y, "r": r, "units": len(group),
            "running": int(running.sum()), "production": round(float(group["power"][running].sum()), 1),
            "capacity": round(float(group["max_p"].fillna(0.0).sum()), 1),
            # Matched from a plant database onto an untyped network: its
            # output is an estimate (its share of the zone's production).
            "matched": bool(group["estimated"].any()),
        })
    return out
