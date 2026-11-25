# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0
# This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

"""The Context tab's network layers — Carte-Front's *liseré* and consignations.

* the **network outline** (Carte-Front ``fond._draw_network``): a thin
  pastel trace of the 400 kV and the 225 kV circuits, to place flows and
  outages on the real grid. Carte-Front rebuilds it from the sold layout (a
  segment per pair of linked substations, parallel circuits melted into
  one); here it comes from the network itself — every line between two
  georeferenced voltage levels of an extra-high-voltage class
  (``consignations.voltage_class``), parallel circuits melted too. It is
  heavy next to the rest of the map (thousands of segments) and optional,
  so it is served by its own route, once asked for;
* the **consignations** (``consignations.py``), a few dozen drawn between
  their two ends — a transformer, whose ends coincide, as a point. They
  ride in the map payload.

Both are expressed in the map's drawing frame (``geography.project``),
rounded to ~100 m for the wire.
"""
from __future__ import annotations

from expert_backend.services.context_map.consignations import voltage_class
from expert_backend.services.context_map.snapshot import NetworkSnapshot

#: Branch kinds the outline traces: the AC circuits between substations.
OUTLINE_KINDS = ("line", "tie_line")
#: Decimals kept on a coordinate (~100 m).
PRECISION = 3


def _rounded(point: tuple[float, float]) -> tuple[float, float]:
    return round(point[0], PRECISION), round(point[1], PRECISION)


def grid_outline(snap: NetworkSnapshot, vl_xy: dict[str, tuple[float, float]]) -> dict:
    """``{"segments": {"400 kV": [[x1, y1, x2, y2], …], "225 kV": […]}}``.

    One segment per pair of places, parallel circuits melted into it; a
    network whose voltage levels the map cannot place has none."""
    branches = snap.branches
    segments: dict[str, set[tuple[float, float, float, float]]] = {}
    if not branches.empty and snap.vl_nominal and vl_xy:
        kinds = branches["kind"] if "kind" in branches.columns else None
        for i, (vl1, vl2) in enumerate(zip(branches["vl1"], branches["vl2"])):
            if kinds is not None and kinds.iat[i] not in OUTLINE_KINDS:
                continue
            voltage = voltage_class(snap.vl_nominal.get(str(vl1)))
            if voltage is None or voltage != voltage_class(snap.vl_nominal.get(str(vl2))):
                continue
            a, b = vl_xy.get(str(vl1)), vl_xy.get(str(vl2))
            if a is None or b is None:
                continue
            a, b = sorted((_rounded(a), _rounded(b)))
            if a != b:
                segments.setdefault(voltage, set()).add((*a, *b))
    return {"segments": {voltage: [list(s) for s in sorted(found)]
                         for voltage, found in sorted(segments.items(), reverse=True)}}


def consignation_layer(snap: NetworkSnapshot, vl_xy: dict[str, tuple[float, float]]) -> dict:
    """The consigned circuits the map can place: ``items`` (``id``, ``name``,
    ``voltage``, ``kind``, ``points`` — the two ends — and the ends' ``vls``
    names) and ``total``, how many the situation holds."""
    items = []
    for element_id, row in snap.consignations.iterrows():
        a, b = vl_xy.get(row["vl1"]), vl_xy.get(row["vl2"])
        if a is None or b is None:
            continue
        items.append({
            "id": str(element_id),
            "name": snap.names.get(str(element_id), str(element_id)),
            "voltage": row["voltage"],
            "kind": row["kind"],
            "points": [list(_rounded(a)), list(_rounded(b))],
            "vls": [snap.names.get(row["vl1"], row["vl1"]), snap.names.get(row["vl2"], row["vl2"])],
        })
    return {"items": items, "total": len(snap.consignations)}
