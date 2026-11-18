# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0

"""Complete a fixed NAD layout with the voltage levels it does not position.

A ``grid_layout.json`` is often older than the network it is drawn for: the
2024 RTE layout misses 60 of the 5,888 voltage levels of a 2026 France
snapshot. Given such ``fixed_positions``, pypowsybl's GEOGRAPHICAL layout
places the missing voltage levels on its own scale (~1.4 M units away from
the grid) or at NaN, and a single NaN node turns the root viewBox into
``NaN NaN NaN NaN``.

``complete_layout`` gives every missing voltage level a position on the
layout's own scale before pypowsybl sees it: the mean of its positioned
same-substation voltage levels, else of its positioned electrical neighbours
(lines, 2- and 3-winding transformers, tie lines, HVDC lines), plus a small
deterministic offset so no two voltage levels share a position (pypowsybl
draws a zero-length edge with NaN coordinates). Passes repeat while they
place something, so a chain of new voltage levels hangs off the grid one hop
at a time. Isolated voltage levels are parked along the bottom edge of the
grid's extent. See ``docs/data/grid-layout-coordinate-scale.md``.
"""
from __future__ import annotations

import logging
import math
import zlib
from collections import Counter, defaultdict
from typing import TYPE_CHECKING, Any, Callable, Iterable

if TYPE_CHECKING:
    import pandas as pd

logger = logging.getLogger(__name__)

Position = tuple[float, float]

# Offset of a placed voltage level from its anchors' mean, as a share of the
# grid's extent: ~1,600 units on the RTE layout (1.6 M units across France),
# the order of the gap between neighbouring substations there.
OFFSET_FRACTION = 1e-3

# Branch tables tying voltage levels together, with the columns naming them.
_BRANCH_TABLES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("get_lines", ("voltage_level1_id", "voltage_level2_id")),
    ("get_2_windings_transformers", ("voltage_level1_id", "voltage_level2_id")),
    ("get_3_windings_transformers",
     ("voltage_level1_id", "voltage_level2_id", "voltage_level3_id")),
)


def network_fingerprint(network: Any) -> tuple[Any, int, int]:
    """Identify ``network`` by its voltage levels, which the completion follows.

    Copies of one network (the per-worker reassessment copies the action
    diagrams are drawn on) share the fingerprint, hence one completion.
    """
    vl_ids = tuple(network.get_voltage_levels(attributes=[]).index)
    return (getattr(network, "id", None), len(vl_ids), hash(vl_ids))


def complete_layout_cached(
    df_layout: pd.DataFrame,
    network: Any,
    get_cache: Callable[[], Any],
    set_cache: Callable[[Any], None],
) -> pd.DataFrame:
    """``complete_layout``, cached per (layout file version, network).

    The cache holds ``(df_layout, fingerprint, completed)``. ``df_layout`` is
    the ``(path, mtime)``-cached frame of ``layout_cache.load_layout``, so its
    identity stands for the layout file version; the network is matched by
    ``network_fingerprint``. Never raises: on failure the raw layout is
    returned and pypowsybl places the missing voltage levels itself.
    """
    try:
        key = network_fingerprint(network)
        cached = get_cache()
        if cached is not None and cached[0] is df_layout and cached[1] == key:
            return cached[2]
        completed = complete_layout(df_layout, network)
    except Exception as e:
        logger.warning("Warning: Could not complete the layout: %s", e)
        return df_layout
    set_cache((df_layout, key, completed))
    return completed


def complete_layout(df_layout: pd.DataFrame, network: Any) -> pd.DataFrame:
    """Return ``df_layout`` with a row for every voltage level of ``network`` it misses.

    ``df_layout`` is indexed by voltage-level id with ``x`` / ``y`` columns
    (``layout_cache.load_layout``); a row with a non-finite coordinate counts
    as missing and is dropped. ``df_layout`` itself is returned when nothing
    is missing, or when it positions none of the network's voltage levels (a
    layout for another grid: there is no scale to complete it on).
    """
    import pandas as pd

    vls = network.get_voltage_levels(attributes=["substation_id"])
    positions = _finite_positions(df_layout)
    missing = sorted(vl for vl in vls.index if vl not in positions)
    if not missing:
        return df_layout
    grid = [positions[vl] for vl in vls.index if vl in positions]
    if not grid:
        logger.warning(
            "Warning: the layout positions none of the network's %d voltage "
            "levels; leaving their placement to pypowsybl.", len(vls),
        )
        return df_layout

    radius = _offset_radius(grid)
    substation_of = {
        vl: sub for vl, sub in vls["substation_id"].items() if isinstance(sub, str) and sub
    }
    placed, rule = _place_from_anchors(
        missing, positions, substation_of, _adjacency(network), radius,
    )
    isolated = [vl for vl in missing if vl not in placed]
    placed.update(_park(isolated, grid, radius))

    counts = Counter(rule.values())
    logger.info(
        "[RECO] Layout completion: %d voltage level(s) missing from the layout; "
        "placed %d by substation, %d by electrical neighbours, parked %d isolated.",
        len(missing), counts["substation"], counts["neighbours"], len(isolated),
    )
    if isolated:
        logger.info("[RECO] Isolated voltage levels parked: %s", isolated)

    completed = pd.DataFrame.from_dict({**positions, **placed}, orient="index", columns=["x", "y"])
    completed.index.name = df_layout.index.name
    return completed


def _finite_positions(df_layout: pd.DataFrame) -> dict[str, Position]:
    """``{id: (x, y)}`` for the layout rows with finite coordinates."""
    import pandas as pd

    xs = pd.to_numeric(df_layout["x"], errors="coerce")
    ys = pd.to_numeric(df_layout["y"], errors="coerce")
    return {
        vl: (float(x), float(y))
        for vl, x, y in zip(df_layout.index, xs, ys)
        if math.isfinite(x) and math.isfinite(y)
    }


def _offset_radius(grid: list[Position]) -> float:
    """``OFFSET_FRACTION`` of the grid's extent (1.0 for a single point)."""
    xs = [p[0] for p in grid]
    ys = [p[1] for p in grid]
    span = max(max(xs) - min(xs), max(ys) - min(ys))
    return span * OFFSET_FRACTION if span > 0 else 1.0


def _offset(vl: str, radius: float) -> Position:
    """A ``radius``-long offset whose angle is a stable hash of ``vl``."""
    angle = (zlib.crc32(vl.encode("utf-8")) % 3600) / 3600 * 2 * math.pi
    return radius * math.cos(angle), radius * math.sin(angle)


def _place_from_anchors(
    missing: list[str],
    positions: dict[str, Position],
    substation_of: dict[str, str],
    adjacency: dict[str, set[str]],
    radius: float,
) -> tuple[dict[str, Position], dict[str, str]]:
    """Place each missing voltage level at its anchors' mean plus an offset.

    Anchors are the positioned voltage levels of its substation, else its
    positioned electrical neighbours. A voltage level placed in a pass is an
    anchor for the ones after it, so the passes walk outwards from the grid;
    they stop once a pass places nothing. Returns the placements and the rule
    (``"substation"`` / ``"neighbours"``) that placed each one.
    """
    members: dict[str, list[str]] = defaultdict(list)
    for vl, substation in substation_of.items():
        members[substation].append(vl)
    known = dict(positions)
    placed: dict[str, Position] = {}
    rule: dict[str, str] = {}
    todo = list(missing)
    while todo:
        for vl in todo:
            siblings = members.get(substation_of.get(vl, ""), [])
            anchors, how = [known[o] for o in siblings if o != vl and o in known], "substation"
            if not anchors:
                anchors, how = [known[o] for o in adjacency.get(vl, ()) if o in known], "neighbours"
            if not anchors:
                continue
            dx, dy = _offset(vl, radius)
            known[vl] = placed[vl] = (
                sum(a[0] for a in anchors) / len(anchors) + dx,
                sum(a[1] for a in anchors) / len(anchors) + dy,
            )
            rule[vl] = how
        left = [vl for vl in todo if vl not in placed]
        if len(left) == len(todo):
            break
        todo = left
    return placed, rule


def _park(isolated: list[str], grid: list[Position], radius: float) -> dict[str, Position]:
    """Line the isolated voltage levels up inside the grid's bottom-left corner.

    Left to pypowsybl they land near its own origin, far from the grid, and
    stretch the diagram (or at NaN). Here they stay inside the extent, one
    step in from the corner, wrapping upwards once a row is full.
    """
    if not isolated:
        return {}
    x0 = min(p[0] for p in grid)
    x1 = max(p[0] for p in grid)
    bottom = max(p[1] for p in grid)
    step = 2 * radius
    per_row = max(1, int((x1 - x0) // step) - 1)
    return {
        vl: (x0 + step * (1 + k % per_row), bottom - step * (1 + k // per_row))
        for k, vl in enumerate(isolated)
    }


def _adjacency(network: Any) -> dict[str, set[str]]:
    """Voltage level → voltage levels it shares a branch or an HVDC line with."""
    adjacency: dict[str, set[str]] = defaultdict(set)
    for getter, columns in _BRANCH_TABLES:
        for ends in _rows(network, getter, [columns]):
            _link(adjacency, ends)
    # A tie line joins two boundary (ex-dangling) lines, one per voltage level.
    boundary_vl = _column(network, ("get_boundary_lines", "get_dangling_lines"), "voltage_level_id")
    tie_columns = [("boundary_line1_id", "boundary_line2_id"), ("dangling_line1_id", "dangling_line2_id")]
    for ends in _rows(network, "get_tie_lines", tie_columns):
        _link(adjacency, [boundary_vl.get(end) for end in ends])
    station_vl = {
        **_column(network, ("get_vsc_converter_stations",), "voltage_level_id"),
        **_column(network, ("get_lcc_converter_stations",), "voltage_level_id"),
    }
    for ends in _rows(network, "get_hvdc_lines", [("converter_station1_id", "converter_station2_id")]):
        _link(adjacency, [station_vl.get(end) for end in ends])
    return adjacency


def _link(adjacency: dict[str, set[str]], ends: Iterable[Any]) -> None:
    """Make every pair of the (valid, distinct) voltage levels in ``ends`` adjacent."""
    vls = [vl for vl in ends if isinstance(vl, str) and vl]
    for a in vls:
        adjacency[a].update(b for b in vls if b != a)


def _rows(network: Any, getter: str, column_sets: Iterable[tuple[str, ...]]) -> list[tuple[Any, ...]]:
    """Rows of ``network.<getter>()`` over the first column set the table has."""
    for columns in column_sets:
        try:
            table = getattr(network, getter)(attributes=list(columns))
        except Exception as e:  # table or column absent from this pypowsybl / network
            logger.debug("Layout completion: %s%s unavailable: %s", getter, columns, e)
            continue
        return list(zip(*(table[c] for c in columns)))
    return []


def _column(network: Any, getters: Iterable[str], column: str) -> dict[Any, Any]:
    """``{id: column value}`` from the first of ``getters`` the network supports."""
    for getter in getters:
        try:
            table = getattr(network, getter)(attributes=[column])
        except Exception as e:  # e.g. get_boundary_lines before pypowsybl 1.16
            logger.debug("Layout completion: %s[%s] unavailable: %s", getter, column, e)
            continue
        return dict(zip(table.index, table[column]))
    return {}
