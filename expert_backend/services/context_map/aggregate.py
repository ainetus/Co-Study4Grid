# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0
# This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

"""Zones and their balances — the Carte-Front aggregation, on a network.

MESH. Carte-Front shows a situation at the RTE-region mesh: a French
substation belongs to its ``regionCvg``, a foreign one to its country
code. Co-Study keeps that rule whenever the network tags (most of) its
French substations with a region, and otherwise falls back to the
COUNTRY mesh — every substation in its country — which is what a
European network such as PyPSA-EUR offers.

BALANCES, per zone: production by generation type (``genreCvg``, else
the fuel a PyPSA-EUR situation tags (``carrier``), else the IIDM
``energySource`` — Carte-Front's ``filieres``), consumption (loads, plus
generators running as pumps), and the net transfer between every pair of
zones over the branches that cross their boundary — plus the exchanges a
situation models as fixed injections (HVDC links, countries the grid
leaves out), drawn towards that neighbour.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from expert_backend.services.context_map.plants import CARRIER_FILIERE
from expert_backend.services.context_map.snapshot import NetworkSnapshot

HOME_COUNTRY = "FR"
UNKNOWN_ZONE = "?"
#: Share of French substations that must carry a region for the region mesh.
REGION_MESH_MIN_SHARE = 0.5
#: Transfers below this (MW) are not drawn (Carte-Front ``_SEUIL_MW``).
FLOW_THRESHOLD_MW = 1.0

#: Generation types, in Carte-Front's pie order (``FILIERE_COLORS``).
FILIERES = ("nuclear", "gas", "coal", "oil", "hydro", "wind", "solar",
            "biomass", "storage", "other")
#: ``genreCvg`` (Convergence) → generation type. The second row holds the
#: spellings of the reconstructed RTE7000 grids (Game Mode "France THT"):
#: without them their oil units would fall back on ``energySource`` THERMAL
#: and read as gas.
GENRE_FILIERE = {
    "NUCLEAIRE": "nuclear", "GAZ": "gas", "CHARBON": "coal", "FIOUL": "oil",
    "TURBINAGE": "hydro", "POMPAGE": "storage", "EOLIEN": "wind",
    "PHOTOVOLTAIQUE": "solar",
    "FUEL": "oil", "CCG": "gas", "STEP": "storage", "AUTRE": "other",
}
#: IIDM ``energySource`` → generation type, when ``genreCvg`` is missing.
SOURCE_FILIERE = {
    "NUCLEAR": "nuclear", "THERMAL": "gas", "HYDRO": "hydro", "WIND": "wind",
    "SOLAR": "solar",
}


@dataclass
class Zoning:
    """Which zone each voltage level belongs to, at the chosen mesh.

    ``home``: the country the map is drawn around (Carte-Front's France
    frame): the one whose regions are drawn, or France when the network
    covers it alone. ``zone_country``: the country of every zone."""

    mesh: str
    home: str | None
    vl_zone: dict[str, str] = field(default_factory=dict)
    zone_country: dict[str, str] = field(default_factory=dict)
    #: Countries the grid leaves out but exchanges with (fixed injections).
    outside: set[str] = field(default_factory=set)

    def kind(self, zone: str) -> str:
        """``region`` (inside home), ``neighbor`` (around it, or outside the
        grid) or ``country``."""
        if zone in self.outside:
            return "neighbor"
        if self.mesh != "region":
            return "country"
        return "region" if self.zone_country.get(zone) == self.home else "neighbor"


def build_zoning(snap: NetworkSnapshot) -> Zoning:
    """Pick the mesh and assign every voltage level to its zone."""
    home_subs = [s for s, c in snap.substation_country.items() if c == HOME_COUNTRY]
    tagged = sum(1 for s in home_subs if s in snap.substation_region)
    region_mesh = bool(home_subs) and tagged >= REGION_MESH_MIN_SHARE * len(home_subs)
    # France alone without regions (a PyPSA-EUR France bundle) is one zone,
    # still drawn around France: its neighbours, when a rebuilt situation
    # exchanges with them, at their badges.
    home_only = {c for c in snap.substation_country.values() if c} == {HOME_COUNTRY}
    zoning = Zoning(mesh="region" if region_mesh else "country",
                    home=HOME_COUNTRY if region_mesh or home_only else None)
    sub_zone: dict[str, str] = {}
    for sid, country in snap.substation_country.items():
        if region_mesh and country == HOME_COUNTRY:
            zone = snap.substation_region.get(sid) or HOME_COUNTRY
        else:
            zone = country or UNKNOWN_ZONE
        sub_zone[sid] = zone
        zoning.zone_country.setdefault(zone, country or "")
    zoning.vl_zone = {vl: sub_zone.get(sid, UNKNOWN_ZONE) for vl, sid in snap.vl_substation.items()}
    if not snap.exchanges.empty:
        known = set(zoning.vl_zone.values())
        zoning.outside = {n for n in snap.exchanges["neighbour"] if n and n not in known}
        for n in zoning.outside:
            zoning.zone_country.setdefault(n, n)
    return zoning


def _active_power(df: pd.DataFrame) -> pd.Series:
    """``p`` where the file carries it, else the set point (sign-matched)."""
    return df["p"].where(df["p"].notna(), df["target"])


def network_filiere(gens: pd.DataFrame) -> pd.Series:
    """Each generator's type as the network gives it — ``genreCvg``, else
    its ``carrier``, else ``energySource`` — NaN when it gives none."""
    by_genre = gens["genre"].str.upper().map(GENRE_FILIERE)
    if "carrier" in gens:
        by_carrier = gens["carrier"].map(CARRIER_FILIERE)
        by_genre = by_genre.where(by_genre.notna(), by_carrier)
    by_source = gens["source"].str.upper().map(SOURCE_FILIERE)
    return by_genre.where(by_genre.notna(), by_source)


def _gen_output(gens: pd.DataFrame) -> pd.Series:
    """A generator's ``p`` (IIDM: production < 0), else its set point."""
    return gens["p"].where(gens["p"].notna(), -gens["target"])


@dataclass
class MatchedFleet:
    """A zone's untyped production and the typical output (MW by type) of
    the plants matched in it (``plants.py``)."""

    untyped_mw: float = 0.0
    expected: dict[str, float] = field(default_factory=dict)

    @property
    def scale(self) -> float:
        """Situation MW per typical-output MW: shares the zone's production
        out over its matched fleet."""
        total = sum(self.expected.values())
        return self.untyped_mw / total if total > 0 else 0.0


def matched_fleets(snap: NetworkSnapshot, zoning: Zoning) -> dict[str, MatchedFleet]:
    """The zones whose untyped production the matched plants type.

    A synthetic network gives every bus the same set point, so typing it bus
    by bus cannot give a real mix (a 5.7 GW nuclear site's bus produces as
    much as a rural one): the zone's untyped production is typed AS A WHOLE
    by its fleet's typical output. The network's own typing always wins."""
    expected = snap.plants.expected if snap.plants else {}
    gens = snap.generators
    if not expected or gens.empty:
        return {}
    untyped = network_filiere(gens).isna()
    zone = gens["vl"].map(zoning.vl_zone).fillna(UNKNOWN_ZONE)
    fleets: dict[str, MatchedFleet] = {}
    for gen in gens.index[untyped & gens.index.isin(list(expected))]:
        fleet = fleets.setdefault(zone[gen], MatchedFleet())
        for f, mw in expected[gen].items():
            fleet.expected[f] = fleet.expected.get(f, 0.0) + mw
    production = (-_gen_output(gens)).clip(lower=0.0)
    for z, fleet in fleets.items():
        fleet.untyped_mw = float(production[untyped & (zone == z)].sum())
    return fleets


def production_and_consumption(snap: NetworkSnapshot, zoning: Zoning
                               ) -> tuple[dict[str, dict[str, float]], dict[str, float]]:
    """``({zone: {filiere: MW}}, {zone: MW})`` — production by type, consumption.

    A generator's ``p`` is negative when it produces (IIDM); one that
    draws power (a pump) counts as consumption. A missing ``p`` falls back
    on ``target_p`` (production, positive) / ``p0`` (load). The untyped
    production of a zone with matched plants is typed by its fleet
    (``matched_fleets``)."""
    production: dict[str, dict[str, float]] = {}
    consumption: dict[str, float] = {}
    gens = snap.generators
    if not gens.empty:
        p = _gen_output(gens)
        typed = network_filiere(gens)
        zone = gens["vl"].map(zoning.vl_zone).fillna(UNKNOWN_ZONE)
        frame = pd.DataFrame({"zone": zone, "filiere": typed.fillna("other"),
                              "prod": (-p).clip(lower=0.0), "pump": p.clip(lower=0.0)})
        fleets = matched_fleets(snap, zoning)
        # Untyped production of a zone with matched plants: typed below.
        frame.loc[typed.isna() & zone.isin(list(fleets)), "prod"] = 0.0
        for (z, f), mw in frame.groupby(["zone", "filiere"])["prod"].sum().items():
            if mw > 0:
                production.setdefault(z, {})[f] = float(mw)
        for z, fleet in fleets.items():
            for f, mw in fleet.expected.items():
                if mw * fleet.scale > 0:
                    mix = production.setdefault(z, {})
                    mix[f] = mix.get(f, 0.0) + mw * fleet.scale
        for z, mw in frame.groupby("zone")["pump"].sum().items():
            if mw > 0:
                consumption[z] = consumption.get(z, 0.0) + float(mw)
    loads = snap.loads
    if not loads.empty:
        zone = loads["vl"].map(zoning.vl_zone).fillna(UNKNOWN_ZONE)
        for z, mw in _active_power(loads).fillna(0.0).groupby(zone).sum().items():
            consumption[z] = consumption.get(z, 0.0) + float(mw)
    return production, consumption


def _branch_transfers(snap: NetworkSnapshot, zoning: Zoning) -> pd.DataFrame:
    """One row per zone-crossing branch: ``a``, ``b`` (sorted zones) and the
    transfer ``t`` from ``a`` to ``b`` (MW, NaN without flows)."""
    b = snap.branches
    if b.empty:
        return pd.DataFrame(columns=["a", "b", "t"])
    z1 = b["vl1"].map(zoning.vl_zone)
    z2 = b["vl2"].map(zoning.vl_zone)
    crossing = z1.notna() & z2.notna() & (z1 != z2)
    b, z1, z2 = b[crossing], z1[crossing], z2[crossing]
    # Mean of both ends cancels the losses; one finite end is enough.
    t = pd.concat([b["p1"], -b["p2"]], axis=1).mean(axis=1, skipna=True)
    forward = z1 < z2
    return pd.DataFrame({
        "a": np.where(forward, z1, z2),
        "b": np.where(forward, z2, z1),
        "t": np.where(forward, t, -t),
    }, index=b.index)


def _exchange_transfers(snap: NetworkSnapshot, zoning: Zoning) -> pd.DataFrame:
    """The fixed exchanges (FICTITIOUS loads tagged with a ``neighbour``) as
    transfers ``a``, ``b``, ``t``. An HVDC link between two zones of the
    grid is one load at each end: only its exporting end counts."""
    ex = snap.exchanges
    if ex.empty:
        return pd.DataFrame(columns=["a", "b", "t"])
    zone = ex["vl"].map(zoning.vl_zone)
    t = _active_power(ex)
    keep = zone.notna() & (zone != ex["neighbour"]) & (ex["neighbour"].isin(zoning.outside) | (t > 0))
    zone, nb, t = zone[keep], ex["neighbour"][keep], t[keep]
    forward = zone < nb
    return pd.DataFrame({
        "a": np.where(forward, zone, nb),
        "b": np.where(forward, nb, zone),
        "t": np.where(forward, t, -t),
    }, index=zone.index)


def zone_transfers(snap: NetworkSnapshot, zoning: Zoning) -> tuple[list[dict], bool]:
    """Net transfer between every pair of adjacent zones.

    Returns ``(flows, flows_available)``; each flow is oriented in its
    direction (``from`` → ``to``, ``mw`` ≥ 0) with ``circuits``, the number
    of branches over which it passes. On the region mesh, a transfer
    between two foreign countries is left out, as on Carte-Front."""
    parts = [r for r in (_branch_transfers(snap, zoning), _exchange_transfers(snap, zoning)) if not r.empty]
    rows = pd.concat(parts) if parts else pd.DataFrame(columns=["a", "b", "t"])
    b = snap.branches
    available = bool(not b.empty and (b["p1"].notna() | b["p2"].notna()).any())
    flows: list[dict] = []
    if rows.empty:
        return flows, available
    grouped = rows.groupby(["a", "b"])["t"]
    circuits = grouped.size()
    for (a, b), net in grouped.sum(min_count=1).items():
        if zoning.kind(a) == "neighbor" and zoning.kind(b) == "neighbor":
            continue
        if pd.isna(net) or abs(net) < FLOW_THRESHOLD_MW:
            continue
        src, dst = (a, b) if net >= 0 else (b, a)
        flows.append({"from": src, "to": dst, "mw": float(abs(net)),
                      "circuits": int(circuits[(a, b)])})
    flows.sort(key=lambda f: -f["mw"])
    return flows, available


def net_exports(flows: list[dict]) -> dict[str, float]:
    """Net export of every zone over the drawn transfers (MW, + = exports)."""
    out: dict[str, float] = {}
    for f in flows:
        out[f["from"]] = out.get(f["from"], 0.0) + f["mw"]
        out[f["to"]] = out.get(f["to"], 0.0) - f["mw"]
    return out
