# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0
# This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

"""Assembly of the Context-tab payload — the Carte-Front situation map.

Places every zone (RTE region at its pivot city, neighbour at its badge
anchor, country at its mainland centroid), frames the view (Carte-Front's
France frame on the region mesh, the zones' extent otherwise), and
projects everything — basemap, zones, transfers, voltage levels — into
the planar drawing frame (``geography.project``). The frontend only
draws: sizes (pies, arrows) follow Carte-Front's point scale relative to
the view width.

PREREQUISITE — a situation map compares zones on the ground: the network
must place at least ``MIN_ZONES`` of them on the basemap, i.e. its
substations carry their country (IIDM ``country``) — a grid spanning
countries, or French substations tagged with their RTE region
(``regionCvg``). Otherwise the payload only says why (``available``
False, ``unavailable_reason``) and the frontend shows no Context tab.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from expert_backend.services.context_map import geography
from expert_backend.services.context_map.aggregate import (
    FILIERES,
    Zoning,
    build_zoning,
    matched_fleets,
    net_exports,
    production_and_consumption,
    zone_transfers,
)
from expert_backend.services.context_map.georef import Georef, georeference
from expert_backend.services.context_map.nuclear import nuclear_layer
from expert_backend.services.context_map.snapshot import NetworkSnapshot

#: Margin around the zones of a country-mesh view (share of its span).
VIEW_PAD = 0.12
VIEW_MIN_SPAN_DEG = 6.0
#: Extra margin of the basemap beyond the view, so panning finds land.
BASEMAP_MARGIN = 0.6
#: Border-flow labels stacked under the badge (Carte-Front ``_VALUE_UNDER_BADGE``).
VALUE_UNDER_BADGE = {"BE"}
BORDER_RAD = 0.12
#: Label inset of a neighbour without a Carte-Front anchor, inside the view.
NEIGHBOR_INSET_DEG = 0.6
#: Zones a network must place on the ground to have a situation map.
MIN_ZONES = 2


@dataclass
class ContextMap:
    """The built map: the wire ``payload`` and what element lookups need."""

    payload: dict
    zoning: Zoning
    lat0: float
    vl_xy: dict[str, tuple[float, float]] = field(default_factory=dict)
    zone_xy: dict[str, tuple[float, float]] = field(default_factory=dict)


def _centroid(points: list[tuple[float, float]]) -> tuple[float, float] | None:
    if not points:
        return None
    arr = np.asarray(points, dtype=float)
    return float(arr[:, 0].mean()), float(arr[:, 1].mean())


def _zone_vl_points(zoning: Zoning, positions: dict[str, tuple[float, float]]
                    ) -> dict[str, list[tuple[float, float]]]:
    out: dict[str, list[tuple[float, float]]] = {}
    for vl, pos in positions.items():
        zone = zoning.vl_zone.get(vl)
        if zone is not None:
            out.setdefault(zone, []).append(pos)
    return out


def _clamp_into(pos: tuple[float, float], view: tuple[float, float, float, float],
                inset: float) -> tuple[float, float]:
    lon_min, lon_max, lat_min, lat_max = view
    return (min(max(pos[0], lon_min + inset), lon_max - inset),
            min(max(pos[1], lat_min + inset), lat_max - inset))


def _region_mesh_position(zone: str, kind: str, vl_points: dict) -> tuple[float, float] | None:
    if kind == "region":
        if zone in geography.REGION_POS:
            return geography.REGION_PIE_POS.get(zone, geography.REGION_POS[zone])
        return _centroid(vl_points.get(zone, []))
    if zone in geography.COUNTRY_BOX:
        return geography.COUNTRY_BOX[zone]
    point = geography.label_point(zone)
    return _clamp_into(point, geography.FRANCE_VIEW, NEIGHBOR_INSET_DEG) if point else None


def place_zones(zones: list[str], zoning: Zoning, georef: Georef
                ) -> dict[str, tuple[float, float]]:
    """(lon, lat) of every zone that can be placed on the ground."""
    vl_points = _zone_vl_points(zoning, georef.vl_lonlat)
    out: dict[str, tuple[float, float]] = {}
    for zone in zones:
        kind = zoning.kind(zone)
        if zoning.mesh == "region":
            pos = _region_mesh_position(zone, kind, vl_points)
        else:
            pos = geography.label_point(zone) or _centroid(vl_points.get(zone, []))
        if pos is not None:
            out[zone] = pos
    return out


def _view(zoning: Zoning, zone_pos: dict, georef: Georef) -> tuple[float, float, float, float]:
    """(lon_min, lon_max, lat_min, lat_max) the map opens on."""
    if zoning.mesh == "region" and zoning.home == "FR":
        return geography.FRANCE_VIEW
    pts = list(zone_pos.values())
    if georef.vl_lonlat:
        arr = np.asarray(list(georef.vl_lonlat.values()))
        lo, hi = np.percentile(arr, (1, 99), axis=0)
        pts += [(lo[0], lo[1]), (hi[0], hi[1])]
    arr = np.asarray(pts, dtype=float)
    (lon_min, lat_min), (lon_max, lat_max) = arr.min(axis=0), arr.max(axis=0)
    pad_lon = max((lon_max - lon_min) * VIEW_PAD, (VIEW_MIN_SPAN_DEG - (lon_max - lon_min)) / 2, 0.5)
    pad_lat = max((lat_max - lat_min) * VIEW_PAD, (VIEW_MIN_SPAN_DEG - (lat_max - lat_min)) / 2, 0.5)
    return lon_min - pad_lon, lon_max + pad_lon, lat_min - pad_lat, lat_max + pad_lat


def _basemap(view: tuple, lat0: float, active: set[str]) -> list[dict]:
    lon_min, lon_max, lat_min, lat_max = view
    m_lon, m_lat = (lon_max - lon_min) * BASEMAP_MARGIN, (lat_max - lat_min) * BASEMAP_MARGIN
    out = []
    for iso, country in geography.load_basemap().items():
        rings = [r for r in country["rings"]
                 if r[:, 0].max() >= lon_min - m_lon and r[:, 0].min() <= lon_max + m_lon
                 and r[:, 1].max() >= lat_min - m_lat and r[:, 1].min() <= lat_max + m_lat]
        if rings:
            out.append({"iso": iso, "name": country["name"], "active": iso in active,
                        "rings": [geography.project_ring(r, lat0) for r in rings]})
    out.sort(key=lambda c: c["active"])  # active territories drawn last, on top
    return out


def _zone_label(zone: str, zoning: Zoning) -> str:
    if zoning.kind(zone) == "region":
        return geography.REGION_LABEL.get(zone, zone.title())
    country = geography.load_basemap().get(zone)
    return country["name"] if country else zone


def _flow_entry(flow: dict, zoning: Zoning, zone_pos: dict, lat0: float,
                under_badge: dict[str, int]) -> dict:
    a, b = flow["from"], flow["to"]
    neighbor = next((z for z in (a, b) if zoning.kind(z) == "neighbor"), None)
    entry = dict(flow, kind="border" if neighbor else "inter_zone")
    if neighbor is None:
        rad = geography.region_rad(a, b) if zoning.mesh == "region" else geography.DEFAULT_INTER_REGION_RAD
        dlon, dlat = geography.region_label_offset(a, b) if zoning.mesh == "region" else (0.0, 0.0)
        mid = ((zone_pos[a][0] + zone_pos[b][0]) / 2 + dlon, (zone_pos[a][1] + zone_pos[b][1]) / 2 + dlat)
        return dict(entry, rad=rad, label=list(geography.project(*mid, lat0)))
    region = b if a == neighbor else a
    if neighbor in VALUE_UNDER_BADGE and neighbor in geography.COUNTRY_BOX:
        bx, by = geography.country_badge_pos(neighbor)
        rank = under_badge.get(neighbor, 0)
        under_badge[neighbor] = rank + 1
        label = (bx, by - 0.75 - 0.5 * rank)
    else:
        label = ((zone_pos[region][0] + zone_pos[neighbor][0]) / 2,
                 (zone_pos[region][1] + zone_pos[neighbor][1]) / 2)
    return dict(entry, rad=BORDER_RAD, label=list(geography.project(*label, lat0)),
                direction="import" if a == neighbor else "export")


def _zone_entries(zones: list[str], zoning: Zoning, zone_pos: dict, lat0: float,
                  production: dict, consumption: dict, exports: dict) -> list[dict]:
    out = []
    for zone in zones:
        mix = {f: round(production.get(zone, {}).get(f, 0.0), 1) for f in FILIERES
               if production.get(zone, {}).get(f, 0.0) > 0}
        entry = {
            "id": zone, "label": _zone_label(zone, zoning), "kind": zoning.kind(zone),
            "country": zoning.zone_country.get(zone, ""),
            "production": mix, "production_total": round(sum(mix.values()), 1),
            "consumption": round(consumption.get(zone, 0.0), 1),
            "net_export": round(exports.get(zone, 0.0), 1),
            "label_side": geography.REGION_LABEL_SIDE.get(zone, "below"),
            "placed": zone in zone_pos,
        }
        if zone in zone_pos:
            entry["x"], entry["y"] = geography.project(*zone_pos[zone], lat0)
        if entry["kind"] == "neighbor" and zoning.mesh == "region" and zone in geography.COUNTRY_BOX:
            entry["badge"] = list(geography.project(*geography.country_badge_pos(zone), lat0))
        out.append(entry)
    return out


def _country_labels(zoning: Zoning, lat0: float) -> list[dict]:
    """Neighbour names around France (region mesh), as Carte-Front writes them."""
    if zoning.mesh != "region":
        return []
    basemap = geography.load_basemap()
    out = []
    for iso, pos in geography.COUNTRY_NAME_POS.items():
        if iso in basemap:
            x, y = geography.project(*pos, lat0)
            out.append({"text": basemap[iso]["name"], "x": x, "y": y})
    return out


def unavailability(zones: list[str], zoning: Zoning, zone_pos: dict) -> str | None:
    """Why the network cannot have a situation map (see the module's
    PREREQUISITE), or ``None`` when it can."""
    placed = [z for z in zones if z in zone_pos and zoning.kind(z) != "neighbor"]
    if not placed:
        return ("its substations carry no country (IIDM `country`) the map can place on the "
                "ground")
    if len(placed) < MIN_ZONES:
        return (f"it covers a single zone ({_zone_label(placed[0], zoning)}): the map compares at "
                f"least {MIN_ZONES} — a grid spanning countries, or French substations tagged "
                "with their RTE region (`regionCvg`)")
    return None


def build_context_map(snap: NetworkSnapshot, layout: dict[str, tuple[float, float]]) -> ContextMap:
    """The Context-tab map of a captured network (see module)."""
    zoning = build_zoning(snap)
    production, consumption = production_and_consumption(snap, zoning)
    flows, flows_available = zone_transfers(snap, zoning)
    exports = net_exports(flows)
    zones = sorted(set(zoning.vl_zone.values()) | set(production) | set(consumption) | zoning.outside)
    georef = georeference(snap, zoning, layout)
    zone_pos = place_zones(zones, zoning, georef)
    reason = unavailability(zones, zoning, zone_pos)
    if reason:
        return ContextMap(payload={"available": False, "unavailable_reason": reason,
                                   "mesh": zoning.mesh, "case_date": snap.case_date},
                          zoning=zoning, lat0=0.0)
    frame = _frame(zones, zoning, georef, zone_pos)
    lat0 = frame.lat0

    under_badge: dict[str, int] = {}
    flow_entries = [_flow_entry(f, zoning, frame.zone_ll, lat0, under_badge)
                    for f in flows if f["from"] in frame.zone_ll and f["to"] in frame.zone_ll]
    zone_entries = _zone_entries(zones, zoning, frame.zone_ll, lat0,
                                 production, consumption, exports)
    inside = [z for z in zones if zoning.kind(z) != "neighbor"]
    # Home exports = what its neighbours receive, net — none without a
    # neighbour in the network (a home-only grid, e.g. the "France THT" game
    # grids): "0 MW" would read as a balanced day.
    neighbours = len(inside) < len(zones)
    home_export = (-sum(v for z, v in exports.items() if zoning.kind(z) == "neighbor")
                   if zoning.mesh == "region" and neighbours else None)
    payload = {
        "available": True,
        "mesh": zoning.mesh,
        "home": zoning.home,
        "frame": frame.kind,
        "bounds": frame.bounds,
        "georef": frame.georef_method,
        "flows_available": flows_available,
        "case_date": snap.case_date,
        "basemap": frame.basemap,
        "country_labels": _country_labels(zoning, lat0),
        "zones": zone_entries,
        "flows": flow_entries,
        # Carte-Front's nuclear units layer.
        "nuclear": nuclear_layer(snap, zoning, frame.vl_ll, lat0),
        # The database the untyped generators were typed from, when used
        # (credited on the map: CC BY).
        "plant_source": snap.plants.source if snap.plants and matched_fleets(snap, zoning) else None,
        # The real hour a rebuilt situation reproduces, with its sources.
        "situation": snap.situation,
        "totals": {
            "production": round(sum(sum(production.get(z, {}).values()) for z in inside), 1),
            "consumption": round(sum(consumption.get(z, 0.0) for z in inside), 1),
            "net_export": round(home_export, 1) if home_export is not None else None,
        },
    }
    return ContextMap(payload=payload, zoning=zoning, lat0=lat0,
                      vl_xy={vl: geography.project(*p, lat0) for vl, p in frame.vl_ll.items()},
                      zone_xy={z: geography.project(*p, lat0) for z, p in frame.zone_ll.items()})


@dataclass
class _Frame:
    """Where things are, as (lon, lat) pairs ``project`` turns into x, y."""

    kind: str
    lat0: float
    zone_ll: dict[str, tuple[float, float]]
    vl_ll: dict[str, tuple[float, float]]
    bounds: list[float]
    basemap: list[dict]
    georef_method: str | None


def _frame(zones: list[str], zoning: Zoning, georef: Georef, zone_ll: dict) -> _Frame:
    view = _view(zoning, zone_ll, georef)
    lat0 = geography.FRANCE_LAT0 if view == geography.FRANCE_VIEW else (view[2] + view[3]) / 2
    x0, _ = geography.project(view[0], 0.0, lat0)
    x1, _ = geography.project(view[1], 0.0, lat0)
    bounds = [x0, -view[3], x1 - x0, view[3] - view[2]]
    basemap = _basemap(view, lat0, {zoning.zone_country.get(z, "") for z in zones})
    return _Frame("geo", lat0, zone_ll, georef.vl_lonlat, bounds, basemap, georef.method)


def element_geometry(cmap: ContextMap, snap: NetworkSnapshot, element_id: str) -> dict | None:
    """Where a highlighted element sits on the map.

    A branch gives its two ends, an injection its voltage level. ``points``
    are the voltage-level positions (``None`` when the map has none: no
    georeference); ``zone_points`` the positions of the zones it touches,
    which the frontend falls back on."""
    if element_id in snap.branches.index:
        row = snap.branches.loc[element_id]
        if isinstance(row, type(snap.branches)):  # duplicated id across tables
            row = row.iloc[0]
        kind, vls = "branch", [str(row["vl1"]), str(row["vl2"])]
    elif element_id in snap.injection_vl:
        kind, vls = "injection", [snap.injection_vl[element_id]]
    else:
        return None
    zones = [cmap.zoning.vl_zone.get(vl) for vl in vls]
    points = [cmap.vl_xy.get(vl) for vl in vls]
    zone_points = [cmap.zone_xy.get(z) if z else None for z in zones]
    return {
        "id": element_id,
        "name": snap.names.get(element_id, element_id),
        "kind": kind,
        "zones": zones,
        "points": [list(p) for p in points] if all(p is not None for p in points) else None,
        "zone_points": [list(p) if p is not None else None for p in zone_points],
    }
