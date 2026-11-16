# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0
# This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

"""RTE regions of a France-only network that does not carry them.

Carte-Front draws France at the RTE-region mesh, from each substation's
``regionCvg``. A France-only network without it — the PyPSA-EUR France
bundle and its real-hour rebuilds — gets them from RTE's own tags:
``resources/rte_region_points.json``, the substations of the France THT
grids with their ``regionCvg`` and their place on the ground
(``scripts/build_rte_region_points.py``). A French substation takes:

1. the region of the RTE substations its lines NAME — an RTE line code
   (``CHOO2L72LONNY``: Chooz – Lonny) names the substations at its two ends,
   each end taking the one nearer to it; several lines vote. RTE's regions
   are its own, not administrative ones (Nogent-sur-Seine is LILLE's,
   Belleville LYON's): a name gets such a site right where geography
   cannot;
2. else the region most of the ``NEIGHBOURS`` nearest RTE substations
   share (the nearest of the tied ones), so one reference point the
   op4grid plan misplaces (~30 km) does not pull a substation across a
   boundary on its own.
"""
from __future__ import annotations

import json
import math
import re
from collections import Counter, defaultdict
from functools import lru_cache
from pathlib import Path

import numpy as np

from expert_backend.services.context_map.aggregate import HOME_COUNTRY, Zoning
from expert_backend.services.context_map.georef import Georef
from expert_backend.services.context_map.snapshot import NetworkSnapshot

REFERENCE_PATH = Path(__file__).resolve().parent / "resources" / "rte_region_points.json"
#: Reference substations that vote for a substation's region.
NEIGHBOURS = 5
#: An RTE line code: substation (5 characters, padded), "L", circuit,
#: voltage index, substation.
LINE_CODE = re.compile(r"^(.{5})L\d[0-7](.{1,5})$")
#: Equirectangular shrink of longitudes, at the latitude of France.
LON_SHRINK = math.cos(math.radians(46.6))


@lru_cache(maxsize=1)
def load_reference() -> tuple[dict[str, int], np.ndarray, tuple[str, ...]]:
    """The reference substations: index by id, (lon, lat) rows, regions."""
    with open(REFERENCE_PATH, encoding="utf-8") as fh:
        points = json.load(fh)["points"]
    return ({p[0]: i for i, p in enumerate(points)},
            np.array([p[1:3] for p in points], dtype=float),
            tuple(p[3] for p in points))


def _d2(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Squared equirectangular distances (degrees) — rows of ``a`` × ``b``."""
    return (((a[:, None, 0] - b[None, :, 0]) * LON_SHRINK) ** 2
            + (a[:, None, 1] - b[None, :, 1]) ** 2)


def _votes_by_name(snap: NetworkSnapshot, position: dict[str, np.ndarray],
                   index: dict[str, int], ref: np.ndarray,
                   regions: tuple[str, ...]) -> dict[str, Counter]:
    """Each substation's regions as named by the RTE codes of its lines."""
    votes: dict[str, Counter] = defaultdict(Counter)
    for name, vl1, vl2 in zip(snap.branches.get("name", ()), snap.branches.get("vl1", ()),
                              snap.branches.get("vl2", ())):
        match = LINE_CODE.match(str(name or ""))
        if match is None:
            continue
        a, b = index.get(match.group(1).strip()), index.get(match.group(2).strip())
        s1, s2 = snap.vl_substation.get(str(vl1)), snap.vl_substation.get(str(vl2))
        if a is None or b is None or s1 not in position or s2 not in position:
            continue
        codes, ends = [a, b], [str(s1), str(s2)]
        d = _d2(np.array([position[s] for s in ends]), ref[codes])
        if d[0, 1] + d[1, 0] < d[0, 0] + d[1, 1]:
            codes.reverse()
        for sid, code in zip(ends, codes):
            votes[sid][regions[code]] += 1
    return votes


def infer_regions(snap: NetworkSnapshot, zoning: Zoning, georef: Georef) -> dict[str, str]:
    """``{substation: region}`` for the French substations of a France-only
    network (country mesh around France) that carry no region and that the
    georeference places — ``{}`` for any other network."""
    if zoning.mesh != "country" or zoning.home != HOME_COUNTRY or not georef.vl_lonlat:
        return {}
    placed: dict[str, list[tuple[float, float]]] = defaultdict(list)
    for vl, sid in snap.vl_substation.items():
        if (vl in georef.vl_lonlat and snap.substation_country.get(sid) == HOME_COUNTRY
                and sid not in snap.substation_region):
            placed[sid].append(georef.vl_lonlat[vl])
    if not placed:
        return {}
    index, ref, regions = load_reference()
    position = {sid: np.mean(pts, axis=0) for sid, pts in placed.items()}
    by_name = _votes_by_name(snap, position, index, ref, regions)
    ids = sorted(placed)
    k = min(NEIGHBOURS, len(regions))
    nearest = np.argsort(_d2(np.array([position[s] for s in ids]), ref), axis=1)[:, :k]
    out: dict[str, str] = {}
    for sid, row in zip(ids, nearest):
        votes = by_name.get(sid) or Counter(regions[i] for i in row)
        top = max(votes.values())
        tied = [r for r, n in votes.items() if n == top]
        # A tie goes to the nearest RTE substation's region among the tied.
        out[sid] = next((regions[i] for i in row if regions[i] in tied), tied[0])
    return out
