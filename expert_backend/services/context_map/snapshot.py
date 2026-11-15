# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0
# This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

"""What the Context tab reads from the network — captured once, at load.

The capture runs right after ``network_service.load_network``, while
``/api/config`` still holds the network lock and BEFORE the NAD prefetch
thread starts switching variants: the flows read here are the ones the
file carries, consistently. It costs a handful of pypowsybl table reads
(~0.1 s on the 7 000-node French grid) and holds plain pandas tables
afterwards, so building the map never touches the shared ``Network``
again — no lock, no wait behind a NAD generation.

Region and generation-type tags are IIDM ``property`` elements, which
pypowsybl exposes as extra columns: ``regionCvg`` on substations,
``genreCvg`` on generators (Convergence classification, as Carte-Front
reads them). A PyPSA-EUR situation rebuilt on a real hour
(``scripts/pypsa_eur/build_situation.py``) tags its generators with their
fuel (``carrier``) and its nuclear units with their plant and site
(``plant``, ``plant_lon``, ``plant_lat``); its exchanges with what the grid
leaves out are FICTITIOUS loads tagged with the ``neighbour`` country.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

import pandas as pd

from expert_backend.services.context_map.plants import PlantMatching

logger = logging.getLogger(__name__)

#: Substation properties naming the region (first non-empty wins).
REGION_PROPERTIES = ("regionCvg",)
#: Generator property naming the generation type (Convergence).
GENRE_PROPERTY = "genreCvg"
#: Generator property naming the fuel (powerplantmatching's types).
CARRIER_PROPERTY = "carrier"
#: Load property naming the country a fictitious load exchanges with.
NEIGHBOUR_PROPERTY = "neighbour"


@dataclass
class NetworkSnapshot:
    """The network as the context map needs it — no pypowsybl object.

    ``branches`` (index = element id): ``name``, ``vl1``, ``vl2``, ``p1``,
    ``p2`` (MW, IIDM convention: positive when power LEAVES the bus into
    the branch; NaN when an end is open or the file carries no flow).
    ``generators`` / ``loads``: ``vl``, ``p`` (IIDM sign: a production is
    negative), ``target`` (``target_p`` / ``p0``, used when ``p`` is NaN)
    and, for generators, ``source`` (``energy_source``), ``genre``,
    ``carrier`` and ``max_p``. ``exchanges``: the FICTITIOUS loads that stand
    for an exchange with a ``neighbour`` the grid leaves out (``p`` > 0 =
    export) — kept out of ``loads``.
    """

    vl_substation: dict[str, str] = field(default_factory=dict)
    substation_country: dict[str, str] = field(default_factory=dict)
    substation_region: dict[str, str] = field(default_factory=dict)
    substation_lonlat: dict[str, tuple[float, float]] = field(default_factory=dict)
    branches: pd.DataFrame = field(default_factory=pd.DataFrame)
    generators: pd.DataFrame = field(default_factory=pd.DataFrame)
    loads: pd.DataFrame = field(default_factory=pd.DataFrame)
    exchanges: pd.DataFrame = field(default_factory=pd.DataFrame)
    injection_vl: dict[str, str] = field(default_factory=dict)
    names: dict[str, str] = field(default_factory=dict)
    case_date: str | None = None
    #: Nuclear units, connected or NOT (a stopped unit is drawn hollow):
    #: ``vl``, ``p`` / ``target`` (NaN / 0 when disconnected), ``max_p``.
    nuclear: pd.DataFrame = field(default_factory=pd.DataFrame)
    #: Plants matched onto the untyped generators (``power_plants.json``
    #: beside the network file — attached by the service, not read here).
    plants: PlantMatching | None = None
    #: The real hour a rebuilt situation reproduces (``situation.json``
    #: beside the network: date, dispatch, data sources) — by the service.
    situation: dict | None = None


def _col(df: pd.DataFrame, name: str, default: Any = float("nan")) -> pd.Series:
    """A column of ``df``, or a constant one when the table lacks it."""
    if name in df.columns:
        return df[name]
    return pd.Series(default, index=df.index)


def _connected(df: pd.DataFrame, *cols: str) -> pd.Series:
    """True where every named ``connected*`` column is True (missing = True)."""
    mask = pd.Series(True, index=df.index)
    for c in cols:
        if c in df.columns:
            mask &= df[c].fillna(False).astype(bool)
    return mask


def _substations(network: Any, snap: NetworkSnapshot) -> None:
    subs = network.get_substations(all_attributes=True)
    snap.substation_country = {
        str(k): str(v) for k, v in _col(subs, "country", "").fillna("").items()
    }
    for prop in REGION_PROPERTIES:
        if prop not in subs.columns:
            continue
        for sid, value in subs[prop].dropna().items():
            text = str(value).strip().upper()
            if text and str(sid) not in snap.substation_region:
                snap.substation_region[str(sid)] = text
    for sid, name in _col(subs, "name", "").fillna("").items():
        if name:
            snap.names[str(sid)] = str(name)


def _substation_positions(network: Any, snap: NetworkSnapshot) -> None:
    """``substationPosition`` extension → (lon, lat), when the file has it."""
    try:
        ext = network.get_extensions("substationPosition")
    except Exception:  # extension unknown to this pypowsybl build
        logger.debug("substationPosition extension unavailable", exc_info=True)
        return
    if ext is None or ext.empty or not {"latitude", "longitude"} <= set(ext.columns):
        return
    for sid, row in ext.iterrows():
        lat, lon = float(row["latitude"]), float(row["longitude"])
        if pd.notna(lat) and pd.notna(lon):
            snap.substation_lonlat[str(sid)] = (lon, lat)


def _two_ended(df: pd.DataFrame) -> pd.DataFrame:
    """Lines / transformers / tie lines as ``name, vl1, vl2, p1, p2``."""
    connected = _connected(df, "connected1", "connected2")
    out = pd.DataFrame({
        "name": _col(df, "name", "").fillna(""),
        "vl1": _col(df, "voltage_level1_id", ""),
        "vl2": _col(df, "voltage_level2_id", ""),
        "p1": pd.to_numeric(_col(df, "p1"), errors="coerce"),
        "p2": pd.to_numeric(_col(df, "p2"), errors="coerce"),
    }, index=df.index.astype(str))
    out.loc[~connected.to_numpy(), ["p1", "p2"]] = float("nan")
    return out


def _hvdc(network: Any) -> pd.DataFrame:
    """HVDC lines as two-ended branches between their converter stations.

    A converter's ``p`` is its AC-side injection (positive when it draws
    power from the AC network), so it reads like a branch end."""
    lines = network.get_hvdc_lines()
    if lines.empty:
        return pd.DataFrame(columns=["name", "vl1", "vl2", "p1", "p2"])
    stations = pd.concat([
        network.get_vsc_converter_stations(),
        network.get_lcc_converter_stations(),
    ])
    vl = _col(stations, "voltage_level_id", "")
    p = pd.to_numeric(_col(stations, "p"), errors="coerce")
    cs1 = _col(lines, "converter_station1_id", "")
    cs2 = _col(lines, "converter_station2_id", "")
    return pd.DataFrame({
        "name": _col(lines, "name", "").fillna(""),
        "vl1": cs1.map(vl), "vl2": cs2.map(vl),
        "p1": cs1.map(p), "p2": cs2.map(p),
    }, index=lines.index.astype(str))


def _injections(df: pd.DataFrame, target_col: str) -> pd.DataFrame:
    connected = _connected(df, "connected")
    out = pd.DataFrame({
        "vl": _col(df, "voltage_level_id", ""),
        "p": pd.to_numeric(_col(df, "p"), errors="coerce"),
        "target": pd.to_numeric(_col(df, target_col), errors="coerce"),
    }, index=df.index.astype(str))
    return out[connected.to_numpy()]


def _nuclear(gens: pd.DataFrame) -> pd.DataFrame:
    genre = _col(gens, GENRE_PROPERTY, "").fillna("").astype(str).str.upper()
    source = _col(gens, "energy_source", "").fillna("").astype(str).str.upper()
    units = gens[((genre == "NUCLEAIRE") | (source == "NUCLEAR")).to_numpy()]
    connected = _connected(units, "connected")
    plant = _col(units, "plant", "").fillna("").astype(str)
    return pd.DataFrame({
        "vl": _col(units, "voltage_level_id", ""),
        "p": pd.to_numeric(_col(units, "p"), errors="coerce").where(connected),
        "target": pd.to_numeric(_col(units, "target_p"), errors="coerce").where(connected, 0.0),
        "max_p": pd.to_numeric(_col(units, "max_p"), errors="coerce"),
        "name": _col(units, "name", "").fillna("").astype(str).where(plant != "", float("nan")),
        "site": plant.where(plant != "", float("nan")),
        "site_lon": pd.to_numeric(_col(units, "plant_lon"), errors="coerce"),
        "site_lat": pd.to_numeric(_col(units, "plant_lat"), errors="coerce"),
    }, index=units.index.astype(str))


def capture_snapshot(network: Any) -> NetworkSnapshot:
    """Read everything the context map needs off a freshly loaded network."""
    snap = NetworkSnapshot()
    case_date = getattr(network, "case_date", None)
    snap.case_date = case_date.isoformat() if isinstance(case_date, datetime) else None
    vls = network.get_voltage_levels()
    snap.vl_substation = {str(k): str(v) for k, v in _col(vls, "substation_id", "").items()}
    _substations(network, snap)
    _substation_positions(network, snap)

    branches = [_two_ended(network.get_lines()), _two_ended(network.get_2_windings_transformers())]
    tie_lines = network.get_tie_lines() if hasattr(network, "get_tie_lines") else pd.DataFrame()
    if not tie_lines.empty:
        branches.append(_two_ended(tie_lines))
    branches.append(_hvdc(network))
    branches = [b for b in branches if not b.empty]
    snap.branches = (pd.concat(branches) if branches
                     else pd.DataFrame(columns=["name", "vl1", "vl2", "p1", "p2"]))

    gens = network.get_generators(all_attributes=True)
    loads = network.get_loads(all_attributes=True)
    snap.generators = _injections(gens, "target_p")
    snap.generators["source"] = _col(gens, "energy_source", "").fillna("").astype(str)
    snap.generators["genre"] = _col(gens, GENRE_PROPERTY, "").fillna("").astype(str)
    snap.generators["carrier"] = _col(gens, CARRIER_PROPERTY, "").fillna("").astype(str)
    snap.generators["max_p"] = pd.to_numeric(_col(gens, "max_p"), errors="coerce")
    all_loads = _injections(loads, "p0")
    neighbour = _col(loads, NEIGHBOUR_PROPERTY, "").fillna("").astype(str).reindex(all_loads.index)
    exchange = ((_col(loads, "type", "").astype(str) == "FICTITIOUS").reindex(all_loads.index)
                & (neighbour != ""))
    snap.loads = all_loads[~exchange.to_numpy()]
    snap.exchanges = all_loads[exchange.to_numpy()].assign(neighbour=neighbour[exchange])
    snap.nuclear = _nuclear(gens)

    for df in (gens, loads):
        snap.injection_vl.update({str(k): str(v) for k, v in _col(df, "voltage_level_id", "").items()})
    for table in (snap.branches, vls, gens, loads):
        names = _col(table, "name", "").fillna("")
        snap.names.update({str(k): str(v) for k, v in names.items() if v})
    return snap
