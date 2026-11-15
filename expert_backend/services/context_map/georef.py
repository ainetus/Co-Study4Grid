# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0
# This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

"""Where each voltage level is on the ground — for the elements the Context
tab highlights (the contingency and its overloads).

Two sources, in order:

1. the ``substationPosition`` IIDM extension — exact (lon, lat);
2. the study's ``grid_layout.json``, GEOREFERENCED. Co-Study layouts are
   Web-Mercator-like drawings: PyPSA-EUR writes raw Mercator metres,
   centred and y-down; the RTE op4grid plan is "Mercator-type, scaled and
   translated" — Carte-Front's affine calibration of it has two axis
   scales that agree once the Mercator stretch is accounted for. So the
   layout maps onto (lon, Mercator y) through ONE isotropic scale and a
   translation. A first guess aligns the robust bounding box of the home
   country's voltage levels with that country's mainland outline; it is
   then refined against the outlines themselves: the scale snaps to 1/R
   on a layout in Mercator metres (PyPSA-EUR — the box overestimates it,
   stations stop short of the coast), else the largest scale that keeps
   the levels inside wins; the translation is the centre of the plateau
   of shifts putting the most voltage levels inside THEIR OWN country.
   Measured on the bundled PyPSA grids: ~1 km off at nuclear sites. On
   the RTE op4grid plan — a drawing, not a survey — ~50 km; so a layout
   in THAT frame uses Carte-Front's own calibration of it instead
   (``OP4GRID_PLAN_AFFINE``, control points, 32 km), recognised by putting
   its levels inside their countries (any other frame lands far off).

   A fit is kept only when plausible: the two axis scales the boxes imply
   agree (a partial network does not fill its country — its box would be
   stretched), and most voltage levels land inside their country.

Neither available → no position; the frontend then draws a highlighted
element between the zones it touches.
"""
from __future__ import annotations

import json
import logging
import math
from collections import Counter
from dataclasses import dataclass, field, replace
from pathlib import Path

import numpy as np

from expert_backend.services.context_map import geography
from expert_backend.services.context_map.aggregate import Zoning
from expert_backend.services.context_map.snapshot import NetworkSnapshot

logger = logging.getLogger(__name__)

#: Share of voltage levels the extension must place to be used.
POSITION_COVERAGE_MIN = 0.5
#: Largest disagreement between the x and y scales of a layout fit.
SCALE_RATIO_MAX = 1.6
#: Share of home voltage levels that must land inside the home country.
INSIDE_SHARE_MIN = 0.6
#: Robust bounding box of the layout points (percentiles).
BOX_PERCENTILES = (0.5, 99.5)
#: Points tested for the inside share (subsample, for speed).
INSIDE_SAMPLE = 600
MIN_HOME_POINTS = 10
#: Web-Mercator sphere radius; a fit this close to 1/R is snapped to it.
MERCATOR_RADIUS_M = 6378137.0
MERCATOR_SNAP = 0.25
#: Scale factors tried on a non-Mercator layout, and the share they may lose.
SCALE_FACTORS = (0.9, 0.94, 0.97, 1.0)
SCALE_TOLERANCE = 0.01
#: Carte-Front's calibration of the RTE op4grid plan (``grid_xy_to_lonlat``):
#: an affine fitted on the French outline AND 18 nuclear sites — 32 km median
#: error, about the floor for a plan that is a drawing (±20 % local scale).
#: Rows: lon, lat = a·x + b·y + c.
OP4GRID_PLAN_AFFINE = (
    (1.2305947682095055e-05, 1.8140905570590275e-06, -0.776492776044032),
    (1.1326631091208319e-06, -8.588505194381964e-06, 27.29216498521166),
)
#: Translation search: grid steps (share of the home span), plateau slack.
TRANSLATION_STEPS = (0.02, 0.006)
PLATEAU_TOLERANCE = 0.004


@dataclass
class Georef:
    """``vl_lonlat``: (lon, lat) per voltage level; ``method`` says how."""

    method: str | None = None
    vl_lonlat: dict[str, tuple[float, float]] = field(default_factory=dict)
    quality: float | None = None


def load_layout_points(path: str | Path | None) -> dict[str, tuple[float, float]]:
    """``{vl_id: (x, y)}`` from a ``grid_layout.json``; ``{}`` when unusable."""
    if not path:
        return {}
    try:
        with open(path, encoding="utf-8") as fh:
            raw = json.load(fh)
    except (OSError, ValueError):
        logger.warning("Context map: layout %s unreadable", path)
        return {}
    out: dict[str, tuple[float, float]] = {}
    for key, xy in raw.items():
        if isinstance(xy, (list, tuple)) and len(xy) == 2 and None not in xy:
            out[str(key)] = (float(xy[0]), float(xy[1]))
    return out


def from_substation_positions(snap: NetworkSnapshot) -> Georef | None:
    """The ``substationPosition`` extension, when it places enough levels."""
    placed = {vl: snap.substation_lonlat[sid] for vl, sid in snap.vl_substation.items()
              if sid in snap.substation_lonlat}
    if not snap.vl_substation or len(placed) < POSITION_COVERAGE_MIN * len(snap.vl_substation):
        return None
    return Georef(method="substation_position", vl_lonlat=placed, quality=1.0)


def _home_country(vls: list[str], snap: NetworkSnapshot, zoning: Zoning) -> str | None:
    """The country with the most laid-out voltage levels that has an outline."""
    counts = Counter(zoning.zone_country.get(zoning.vl_zone.get(vl, ""), "") for vl in vls)
    for country, _ in counts.most_common():
        if country and geography.main_ring(country) is not None:
            return country
    return None


@dataclass(frozen=True)
class _Fit:
    """layout (x, y) → (lon rad, Mercator y): ``lon = lon_c + s·(x − x_c)``,
    ``my = my_c + y_sign·s·(y − y_c)``."""

    s: float
    x_c: float
    y_c: float
    lon_c: float
    my_c: float
    y_sign: float = -1.0  # y-down drawings (pypowsybl, op4grid)
    mercator: bool = False

    def lonlat(self, pts: np.ndarray) -> np.ndarray:
        lon = np.degrees(self.lon_c + self.s * (pts[:, 0] - self.x_c))
        lat = geography.inverse_mercator_y(self.my_c + self.y_sign * self.s * (pts[:, 1] - self.y_c))
        return np.column_stack([lon, lat])


def _initial_fit(home_pts: np.ndarray, home: str) -> _Fit | None:
    """Align the robust box of the home levels with the home mainland."""
    (x_lo, y_lo), (x_hi, y_hi) = np.percentile(home_pts, BOX_PERCENTILES, axis=0)
    if x_hi <= x_lo or y_hi <= y_lo:
        return None
    ring = geography.main_ring(home)
    if ring is None:
        return None
    lon_lo, lon_hi = np.radians(ring[:, 0].min()), np.radians(ring[:, 0].max())
    my_lo, my_hi = float(geography.mercator_y(ring[:, 1].min())), float(geography.mercator_y(ring[:, 1].max()))
    sx, sy = (lon_hi - lon_lo) / (x_hi - x_lo), (my_hi - my_lo) / (y_hi - y_lo)
    if max(sx, sy) / min(sx, sy) > SCALE_RATIO_MAX:
        return None
    s = math.sqrt(sx * sy)
    # A layout in Web-Mercator metres (PyPSA-EUR) has a KNOWN scale: the
    # box only estimates it, and overestimates it — stations stop short of
    # the coastline the outline reaches.
    mercator = abs(s * MERCATOR_RADIUS_M - 1.0) < MERCATOR_SNAP
    return _Fit(s=1.0 / MERCATOR_RADIUS_M if mercator else s,
                x_c=(x_lo + x_hi) / 2, y_c=(y_lo + y_hi) / 2,
                lon_c=(lon_lo + lon_hi) / 2, my_c=(my_lo + my_hi) / 2, mercator=mercator)


class _Containment:
    """Share of a sample of levels that a fit puts inside their own country."""

    def __init__(self, pts: np.ndarray, owners: list[str]):
        basemap = geography.load_basemap()
        keep = [i for i, c in enumerate(owners) if c in basemap]
        if len(keep) > INSIDE_SAMPLE:
            keep = [keep[i] for i in np.linspace(0, len(keep) - 1, INSIDE_SAMPLE).astype(int)]
        self.pts = pts[keep]
        owned = np.array([owners[i] for i in keep])
        self.groups = [(np.flatnonzero(owned == c), basemap[c]["rings"]) for c in set(owned)]

    def share_lonlat(self, lonlat: np.ndarray) -> float:
        """Share inside for the sample's (lon, lat), in ``self.pts`` order."""
        if len(self.pts) == 0:
            return 0.0
        inside = sum(int(geography.points_in_rings(lonlat[idx], rings).sum())
                     for idx, rings in self.groups)
        return inside / len(self.pts)

    def share(self, fit: _Fit) -> float:
        return self.share_lonlat(fit.lonlat(self.pts))


def op4grid_plan_lonlat(pts: np.ndarray) -> np.ndarray:
    """(lon, lat) of RTE op4grid-plan points (Carte-Front ``grid_xy_to_lonlat``)."""
    (al, bl, cl), (aa, ba, ca) = OP4GRID_PLAN_AFFINE
    return np.column_stack([al * pts[:, 0] + bl * pts[:, 1] + cl,
                            aa * pts[:, 0] + ba * pts[:, 1] + ca])


def _best_translation(fit: _Fit, check: _Containment, span: float) -> tuple[_Fit, float]:
    """Centre of the plateau of translations that fit the most levels inside
    their country — coarse then fine (``TRANSLATION_STEPS`` of the span)."""
    best_share = check.share(fit)
    for step in TRANSLATION_STEPS:
        offsets = np.arange(-2, 3) * step * span
        scored = [(check.share(replace(fit, lon_c=fit.lon_c + dx, my_c=fit.my_c + dy)), dx, dy)
                  for dx in offsets for dy in offsets]
        top = max(s for s, _, _ in scored)
        plateau = [(dx, dy) for s, dx, dy in scored if s >= top - PLATEAU_TOLERANCE]
        dx, dy = np.mean(plateau, axis=0)
        fit = replace(fit, lon_c=fit.lon_c + dx, my_c=fit.my_c + dy)
        best_share = check.share(fit)
    return fit, best_share


def _refine(fit: _Fit, check: _Containment, span: float) -> tuple[_Fit, float]:
    """Orientation, scale (unless Mercator) and translation of a first fit."""
    fit = max((replace(fit, y_sign=sign) for sign in (-1.0, 1.0)), key=check.share)
    scales = (1.0,) if fit.mercator else SCALE_FACTORS
    candidates = [_best_translation(replace(fit, s=fit.s * k), check, span) for k in scales]
    top = max(share for _, share in candidates)
    # The LARGEST scale that keeps (almost) everything inside: shrinking the
    # network always fits it better, so the plain maximum would favour it.
    return max((c for c in candidates if c[1] >= top - SCALE_TOLERANCE), key=lambda c: c[0].s)


def fit_layout(layout: dict[str, tuple[float, float]], snap: NetworkSnapshot,
               zoning: Zoning) -> Georef | None:
    """Georeference ``layout`` on the country outlines (see module)."""
    vls = [vl for vl in layout if vl in zoning.vl_zone]
    home = _home_country(vls, snap, zoning)
    if home is None:
        return None
    owners = [zoning.zone_country.get(zoning.vl_zone[vl], "") for vl in vls]
    pts = np.array([layout[vl] for vl in vls])
    home_pts = pts[np.array(owners) == home]
    if len(home_pts) < MIN_HOME_POINTS:
        return None
    check = _Containment(pts, owners)
    # A layout in the op4grid plan frame uses Carte-Front's calibration: its
    # control points beat any outline fit on a distorted drawing. Another
    # frame through that affine lands far off (a Mercator layout in Africa),
    # so plausibility alone recognises the plan.
    share = check.share_lonlat(op4grid_plan_lonlat(check.pts))
    if share >= INSIDE_SHARE_MIN:
        method, lonlat = "op4grid_plan", op4grid_plan_lonlat(pts)
    else:
        fit = _initial_fit(home_pts, home)
        if fit is None:
            return None
        fit, share = _refine(fit, check, float(np.ptp(home_pts[:, 0])) * fit.s)
        method, lonlat = "layout", fit.lonlat(pts)
    if share < INSIDE_SHARE_MIN:
        logger.info("Context map: layout fit rejected (%.0f%% inside)", 100 * share)
        return None
    return Georef(method=method, quality=share,
                  vl_lonlat={vl: (float(lo), float(la)) for vl, (lo, la) in zip(vls, lonlat)})


def georeference(snap: NetworkSnapshot, zoning: Zoning,
                 layout: dict[str, tuple[float, float]]) -> Georef:
    """Best available (lon, lat) per voltage level — possibly none."""
    return (from_substation_positions(snap)
            or (fit_layout(layout, snap, zoning) if layout else None)
            or Georef())
