# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0
# This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

"""Power plants matched onto an untyped network — ``power_plants.json``.

A PyPSA-EUR bundle built from the OSM prebuilt network has one synthetic
generator per bus, untyped, all at the SAME set point (~16 MW). Its
``scripts/pypsa_eur/match_power_plants.py`` matches a public plant database
(powerplantmatching) onto those generators and writes, BESIDE the network
file, the installed capacity of each fuel type around every generator (plus
the nuclear sites). The network itself is untouched.

Typing that dispatch substation by substation cannot give a real mix: the
substation of a 5.7 GW nuclear plant produces the same 16 MW as a rural one
(France came out at 1.5 % nuclear). So the Context map types each ZONE's
untyped production with the typical output of the plants matched in it —
installed capacity × an average load factor per fuel type
(``CARRIER_LOAD_FACTOR``): France 72 % nuclear, Poland 56 % coal… The
network's own typing (``genreCvg`` / ``energySource``) always wins.
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from pathlib import Path

logger = logging.getLogger(__name__)

PLANTS_FILE_NAME = "power_plants.json"
SCHEMA = "costudy4grid-power-plants/1"

#: powerplantmatching fuel type → generation type (``aggregate.FILIERES``).
CARRIER_FILIERE = {
    "Nuclear": "nuclear", "Natural Gas": "gas", "Hard Coal": "coal", "Lignite": "coal",
    "Oil": "oil", "Hydro": "hydro", "Run-Of-River": "hydro", "Reservoir": "hydro",
    "Pumped Storage": "storage", "Wind": "wind", "Wind Onshore": "wind", "Wind Offshore": "wind",
    "Solar": "solar", "Solid Biomass": "biomass", "Biogas": "biomass", "Biomass": "biomass",
    "Waste": "biomass", "Battery": "storage", "Heat Storage": "storage",
    "Hydrogen Storage": "storage", "Mechanical Storage": "storage", "Storage": "storage",
    "Geothermal": "other", "Other": "other",
}
#: Average annual load factor per fuel type — orders of magnitude of
#: European fleets, enough to turn installed capacity into a typical
#: output mix (base load runs, peakers and storage mostly wait).
CARRIER_LOAD_FACTOR = {
    "Nuclear": 0.75, "Lignite": 0.55, "Hard Coal": 0.25, "Natural Gas": 0.30, "Oil": 0.05,
    "Hydro": 0.35, "Run-Of-River": 0.45, "Reservoir": 0.25, "Pumped Storage": 0.08,
    "Wind": 0.25, "Wind Onshore": 0.23, "Wind Offshore": 0.38, "Solar": 0.12,
    "Solid Biomass": 0.55, "Biogas": 0.55, "Biomass": 0.55, "Waste": 0.55, "Geothermal": 0.75,
    "Battery": 0.02, "Heat Storage": 0.02, "Hydrogen Storage": 0.02, "Mechanical Storage": 0.02,
    "Storage": 0.02, "Other": 0.30,
}
DEFAULT_LOAD_FACTOR = 0.30


@dataclass
class NuclearSite:
    """A matched nuclear plant: real site, installed capacity, its units."""

    name: str
    lon: float
    lat: float
    capacity: float
    units: list[tuple[str, float]] = field(default_factory=list)


@dataclass
class PlantMatching:
    """Per generator: the typical output (MW) of its matched plants by
    generation type, and its nuclear site; ``source`` credits the database."""

    expected: dict[str, dict[str, float]] = field(default_factory=dict)
    nuclear_sites: dict[str, NuclearSite] = field(default_factory=dict)
    source: dict = field(default_factory=dict)


def resolve_plants_path(network_path: str | None) -> Path | None:
    """``power_plants.json`` beside the network file, when there is one."""
    if not network_path:
        return None
    network = Path(network_path)
    candidate = (network if network.is_dir() else network.parent) / PLANTS_FILE_NAME
    return candidate if candidate.is_file() else None


def _expected(capacity: dict) -> dict[str, float]:
    """Typical output by generation type: capacity × load factor."""
    out: dict[str, float] = {}
    for carrier, mw in capacity.items():
        if isinstance(mw, (int, float)) and mw > 0:
            f = CARRIER_FILIERE.get(str(carrier), "other")
            out[f] = out.get(f, 0.0) + float(mw) * CARRIER_LOAD_FACTOR.get(str(carrier), DEFAULT_LOAD_FACTOR)
    return out


def load_plant_matching(path: Path | None) -> PlantMatching | None:
    """Parse ``power_plants.json``; ``None`` when absent or unreadable (the
    map then simply shows the network's own typing)."""
    if path is None:
        return None
    try:
        record = json.loads(Path(path).read_text(encoding="utf-8"))
        if record.get("schema") != SCHEMA:
            logger.warning("Context map: %s has schema %r, expected %r — ignored",
                           path, record.get("schema"), SCHEMA)
            return None
        matching = PlantMatching(source={k: record.get("source", {}).get(k)
                                         for k in ("name", "url", "licence")})
        for gen, entry in record.get("generators", {}).items():
            capacity = entry.get("capacity_mw", {})
            expected = _expected(capacity)
            if expected:
                matching.expected[gen] = expected
            site = entry.get("sites", {}).get("Nuclear")
            if isinstance(site, dict) and capacity.get("Nuclear", 0) > 0:
                units = [(str(n), float(mw)) for n, mw in site.get("units", []) if mw > 0]
                matching.nuclear_sites[gen] = NuclearSite(
                    str(site["name"]), float(site["lon"]), float(site["lat"]),
                    float(capacity["Nuclear"]), units)
        return matching
    except (OSError, ValueError, TypeError, AttributeError, KeyError):
        logger.warning("Context map: could not read %s — plants not matched", path, exc_info=True)
        return None
