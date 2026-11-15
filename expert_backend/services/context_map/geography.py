# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0
# This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

"""Geography of the Context tab — ported from Carte-Front.

Everything the context map needs to place itself on the ground, with no
dependency on the Carte-Front / ``xiidm_snapshot_io`` packages:

* the BASEMAP — Natural Earth country outlines (public domain), exterior
  rings only: the 50 m polygons Carte-Front draws for France and its ten
  neighbours, 110 m elsewhere in Europe. Built once into
  ``resources/europe_countries.geojson``;
* the RTE REGIONS — Carte-Front has no region polygons: it places each
  region at its pivot city, nudges some pies once production is drawn
  (``REGION_PIE_POS``) and puts some labels beside their pie;
* the NEIGHBOUR BADGES — border crossing point and badge anchor of the
  seven countries Carte-Front draws around France.

Coordinates are (lon, lat) degrees. ``project`` maps them to the planar
frame the frontend draws in: equirectangular, ``x = lon·cos(lat0)``,
``y = −lat`` (SVG y grows downward) — the projection Carte-Front gets
from its axes aspect ratio.
"""
from __future__ import annotations

import json
import math
from functools import lru_cache
from pathlib import Path

import numpy as np

BASEMAP_PATH = Path(__file__).resolve().parent / "resources" / "europe_countries.geojson"

#: Carte-Front's France frame (``EMPRISE_FRANCE``) and its reference latitude.
FRANCE_VIEW: tuple[float, float, float, float] = (-5.9, 10.9, 40.9, 52.0)
FRANCE_LAT0 = 46.6

#: Pivot city of each RTE region (lon, lat).
REGION_POS: dict[str, tuple[float, float]] = {
    "LILLE": (3.06, 50.63),
    "PARIS": (2.35, 48.85),
    "NANCY": (6.18, 48.69),
    "NANTES": (-1.55, 47.22),
    "LYON": (4.84, 45.76),
    "TOULOUSE": (1.44, 43.60),
    "MARSEILLE": (5.37, 43.30),
}

REGION_LABEL: dict[str, str] = {
    "LILLE": "Lille — North",
    "PARIS": "Paris region",
    "NANCY": "Nancy — East",
    "NANTES": "Nantes — West",
    "LYON": "Lyon",
    "TOULOUSE": "Toulouse — South-West",
    "MARSEILLE": "Marseille — Mediterranean",
}

#: Pie position when production pies are drawn (local readability tweaks).
REGION_PIE_POS: dict[str, tuple[float, float]] = {
    "LILLE": (3.06, 50.22),
    "PARIS": (2.35, 48.62),
    "MARSEILLE": (5.37, 44.02),
}

#: Side of the pie the region label sits on (default: below).
REGION_LABEL_SIDE: dict[str, str] = {
    "LILLE": "above",
    "LYON": "left",
    "PARIS": "left",
    "TOULOUSE": "left",
}

#: Curvature of some inter-region arrows, for their canonical orientation.
INTER_REGION_RAD: dict[tuple[str, str], float] = {
    ("PARIS", "LILLE"): 0.0,
    ("MARSEILLE", "LYON"): -0.55,
}
DEFAULT_INTER_REGION_RAD = 0.16

#: Offset (dlon, dlat) of the MW label of some inter-region arrows.
INTER_REGION_LABEL_OFFSET: dict[tuple[str, str], tuple[float, float]] = {
    ("MARSEILLE", "LYON"): (0.50, 0.04),
}

#: Border crossing point (lon, lat) — start / end of the border arrows.
BORDER_POINT: dict[str, tuple[float, float]] = {
    "GB": (1.7, 50.95),
    "BE": (3.55, 50.45),
    "LU": (6.10, 49.45),
    "DE": (7.75, 48.90),
    "CH": (6.60, 46.30),
    "IT": (7.00, 45.10),
    "ES": (0.70, 42.75),
}

#: Anchor of the aggregated border arrows / origin of country → region arrows.
COUNTRY_BOX: dict[str, tuple[float, float]] = {
    "GB": (-1.4, 50.85),
    "BE": (4.55, 51.25),
    "LU": (6.55, 49.95),
    "DE": (9.10, 49.30),
    "CH": (8.25, 46.65),
    "IT": (8.55, 44.55),
    "ES": (0.25, 41.70),
}

#: Outward shift of the total badge, clear of the arrow ends at the anchor.
COUNTRY_BOX_SHIFT: dict[str, tuple[float, float]] = {
    "GB": (-0.3, 0.45),
    "BE": (0.05, 0.5),
    "LU": (0.55, 0.25),
    "DE": (0.75, 0.1),
    "CH": (0.75, -0.2),
    "IT": (0.75, -0.35),
    "ES": (-0.2, -0.55),
}

#: Country name position around France (lon, lat).
COUNTRY_NAME_POS: dict[str, tuple[float, float]] = {
    "GB": (-2.6, 51.4),
    "BE": (4.55, 50.95),
    "LU": (6.13, 49.80),
    "DE": (9.40, 49.95),
    "CH": (8.30, 46.95),
    "IT": (8.90, 44.85),
    "ES": (-1.8, 42.15),
}


def region_rad(region_from: str, region_to: str) -> float:
    """Arrow curvature for an oriented inter-region link (sign flips with it)."""
    if (region_from, region_to) in INTER_REGION_RAD:
        return INTER_REGION_RAD[(region_from, region_to)]
    if (region_to, region_from) in INTER_REGION_RAD:
        return -INTER_REGION_RAD[(region_to, region_from)]
    return DEFAULT_INTER_REGION_RAD


def region_label_offset(region_from: str, region_to: str) -> tuple[float, float]:
    """MW-label offset (dlon, dlat) for an oriented inter-region link."""
    if (region_from, region_to) in INTER_REGION_LABEL_OFFSET:
        return INTER_REGION_LABEL_OFFSET[(region_from, region_to)]
    if (region_to, region_from) in INTER_REGION_LABEL_OFFSET:
        dx, dy = INTER_REGION_LABEL_OFFSET[(region_to, region_from)]
        return -dx, -dy
    return 0.0, 0.0


def country_badge_pos(country: str) -> tuple[float, float]:
    """Badge position of a neighbour: its anchor shifted outward."""
    x, y = COUNTRY_BOX[country]
    dx, dy = COUNTRY_BOX_SHIFT.get(country, (0.0, 0.0))
    return x + dx, y + dy


# --- Basemap -----------------------------------------------------------------


@lru_cache(maxsize=1)
def load_basemap() -> dict[str, dict]:
    """``{iso2: {"name", "rings": [N×2 lon/lat arrays]}}`` (memoised)."""
    with open(BASEMAP_PATH, encoding="utf-8") as fh:
        raw = json.load(fh)
    out: dict[str, dict] = {}
    for feat in raw["features"]:
        props = feat["properties"]
        rings = [np.asarray(poly[0], dtype=float) for poly in feat["geometry"]["coordinates"] if poly]
        out[props["iso"]] = {"name": props["name"], "rings": rings}
    return out


def ring_area_centroid(ring: np.ndarray) -> tuple[float, float, float]:
    """``(|area|, cx, cy)`` of a closed ring (shoelace, lon/lat units)."""
    x, y = ring[:, 0], ring[:, 1]
    xs, ys = np.roll(x, -1), np.roll(y, -1)
    cross = x * ys - xs * y
    area = cross.sum() / 2.0
    if abs(area) < 1e-12:
        return 0.0, float(x.mean()), float(y.mean())
    cx = ((x + xs) * cross).sum() / (6.0 * area)
    cy = ((y + ys) * cross).sum() / (6.0 * area)
    return abs(float(area)), float(cx), float(cy)


def main_ring(iso: str) -> np.ndarray | None:
    """The largest ring of a country — its mainland."""
    country = load_basemap().get(iso)
    if not country or not country["rings"]:
        return None
    return max(country["rings"], key=lambda r: ring_area_centroid(r)[0])


def label_point(iso: str) -> tuple[float, float] | None:
    """Where a country's symbol sits: the centroid of its mainland."""
    ring = main_ring(iso)
    if ring is None:
        return None
    _, cx, cy = ring_area_centroid(ring)
    return cx, cy


def points_in_rings(points: np.ndarray, rings: list[np.ndarray]) -> np.ndarray:
    """Boolean mask of ``points`` (N×2) inside any of ``rings`` (even-odd)."""
    inside = np.zeros(len(points), dtype=bool)
    if len(points) == 0:
        return inside
    px, py = points[:, 0][:, None], points[:, 1][:, None]
    for ring in rings:
        x1, y1 = ring[:, 0][None, :], ring[:, 1][None, :]
        x2, y2 = np.roll(ring[:, 0], -1)[None, :], np.roll(ring[:, 1], -1)[None, :]
        straddles = (y1 > py) != (y2 > py)
        with np.errstate(divide="ignore", invalid="ignore"):
            x_cross = x1 + (py - y1) * (x2 - x1) / (y2 - y1)
        crossings = np.count_nonzero(straddles & (px < x_cross), axis=1)
        inside |= (crossings % 2) == 1
    return inside


# --- Projection --------------------------------------------------------------


def project(lon: float, lat: float, lat0: float) -> tuple[float, float]:
    """(lon, lat) → drawing frame (equirectangular, SVG y downward)."""
    return lon * math.cos(math.radians(lat0)), -lat


def project_ring(ring: np.ndarray, lat0: float) -> list[list[float]]:
    """A lon/lat ring in the drawing frame, rounded for the wire."""
    k = math.cos(math.radians(lat0))
    return [[round(float(x) * k, 3), round(-float(y), 3)] for x, y in ring]


def mercator_y(lat_deg: np.ndarray | float) -> np.ndarray | float:
    """Web-Mercator ordinate (radians units) of a latitude in degrees."""
    return np.log(np.tan(np.pi / 4 + np.radians(lat_deg) / 2))


def inverse_mercator_y(y: np.ndarray | float) -> np.ndarray | float:
    """Latitude in degrees of a Web-Mercator ordinate (radians units)."""
    return np.degrees(2 * np.arctan(np.exp(y)) - np.pi / 2)
