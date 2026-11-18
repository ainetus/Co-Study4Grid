# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0

"""Complete a fixed NAD layout for the network it draws.

A ``grid_layout.json`` is often older than the network it is drawn for. On a
2026 France snapshot the 2024 RTE layout misses 60 of the 5,888 voltage
levels and gives a single point to 244 others, in 104 groups (a substation's
voltage levels, border nodes). Given such ``fixed_positions``, pypowsybl's
GEOGRAPHICAL layout places the missing voltage levels on its own scale
(~1.4 M units away from the grid) or at NaN, and one NaN node turns the root
viewBox into ``NaN NaN NaN NaN``. A branch between two voltage levels at one
point is drawn as a loop under overlapping disks and labels, or with NaN
coordinates (and stripped).

``complete_layout`` fixes both before pypowsybl sees the layout, keeping
voltage levels ``spacing`` apart: one disk diameter as the frontend draws it
(the ``svgBoost.ts`` node boost) plus 30 %, the convention of
``scripts/pypsa_eur/separate_voltage_levels.py``.

1. A missing voltage level goes ``spacing`` away from the mean of its
   positioned same-substation voltage levels, else of its positioned
   electrical neighbours (lines, 2- and 3-winding transformers, tie lines,
   HVDC lines), in a direction hashed from its id. Passes repeat while they
   place something, so a chain of new voltage levels hangs off the grid one
   hop at a time. Isolated voltage levels are parked inside the grid's
   bottom-left corner.
2. Voltage levels sharing a point are spread: the highest voltage keeps the
   point, the others go round it, evenly spaced, the first one towards its
   own electrical neighbours.

See ``docs/data/grid-layout-coordinate-scale.md``.
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

# The disk the frontend draws for a voltage level: pypowsybl's r = 27.5 times
# the node boost svgBoost.ts derives from the diagram's extent and voltage-level
# count. The boost constants mirror svgBoost.ts (test_layout_completion.py
# checks them against it), as separate_voltage_levels.py does.
DISK_RADIUS = 27.5
SPACING_MARGIN = 1.3  # one disk diameter + 30 % gap
_BOOST_MIN_VL_COUNT = 500
_BOOST_REFERENCE_SIZE = 1250.0
_BOOST_THRESHOLD = 3.0
_NODE_BOOST_FLOOR = 1.0
_NODE_BOOST_OFFSET = 1.5
_NODE_BOOST_GAIN = 10 / 3
_NODE_BOOST_CEILING = 60.0
_VL_DENSITY_REFERENCE = 6e-10

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
    """Return ``df_layout`` with every voltage level of ``network`` at a point of its own.

    ``df_layout`` is indexed by voltage-level id with ``x`` / ``y`` columns
    (``layout_cache.load_layout``); a row with a non-finite coordinate counts
    as missing and is dropped. Rows for voltage levels outside the network are
    kept as they are. ``df_layout`` itself is returned when no voltage level
    of the network is missing or shares its point, or when it positions none
    of them (a layout for another grid: there is no scale to complete it on).
    """
    import pandas as pd

    vls = network.get_voltage_levels(attributes=["substation_id", "nominal_v"])
    positions = _finite_positions(df_layout)
    missing = sorted(vl for vl in vls.index if vl not in positions)
    grid = [positions[vl] for vl in vls.index if vl in positions]
    if not missing and len(set(grid)) == len(grid):
        return df_layout
    if not grid:
        logger.warning(
            "Warning: the layout positions none of the network's %d voltage "
            "levels; leaving their placement to pypowsybl.", len(vls),
        )
        return df_layout

    spacing = _spacing(grid, len(vls))
    adjacency = _adjacency(network)
    substation_of = {
        vl: sub for vl, sub in vls["substation_id"].items() if isinstance(sub, str) and sub
    }
    placed, rule = _place_from_anchors(missing, positions, substation_of, adjacency, spacing)
    isolated = [vl for vl in missing if vl not in placed]
    placed.update(_park(isolated, grid, spacing))
    known = {**positions, **placed}
    voltages = pd.to_numeric(vls["nominal_v"], errors="coerce")
    nominal_v = {vl: float(v) for vl, v in voltages.items() if math.isfinite(v)}
    spread = _spread_colocated(vls.index, known, nominal_v, adjacency, spacing)

    if missing:
        counts = Counter(rule.values())
        logger.info(
            "[RECO] Layout completion: %d voltage level(s) missing from the layout; "
            "placed %d by substation, %d by electrical neighbours, parked %d isolated.",
            len(missing), counts["substation"], counts["neighbours"], len(isolated),
        )
    if isolated:
        logger.info("[RECO] Isolated voltage levels parked: %s", isolated)
    if spread:
        logger.info(
            "[RECO] Layout completion: spread %d voltage level(s) sharing a point "
            "with another, %.0f units apart.", len(spread), spacing,
        )

    completed = pd.DataFrame.from_dict({**known, **spread}, orient="index", columns=["x", "y"])
    completed.index.name = df_layout.index.name
    return completed


def node_boost(width: float, height: float, vl_count: int) -> float:
    """svgBoost.ts's node boost for a diagram of that extent and voltage-level count."""
    if vl_count < _BOOST_MIN_VL_COUNT:
        return 1.0
    ratio = max(width, height) / _BOOST_REFERENCE_SIZE
    if ratio <= _BOOST_THRESHOLD:
        return 1.0
    boost = math.sqrt(ratio / _BOOST_THRESHOLD)
    density = vl_count / max(1.0, width * height)
    suppress = math.sqrt(max(1.0, density / _VL_DENSITY_REFERENCE))
    raw = (boost - _NODE_BOOST_OFFSET) * _NODE_BOOST_GAIN + 1.0
    return max(_NODE_BOOST_FLOOR, min(_NODE_BOOST_CEILING, raw / suppress))


def _spacing(grid: list[Position], vl_count: int) -> float:
    """One frontend disk diameter + 30 % for a diagram spanning ``grid``."""
    xs = [p[0] for p in grid]
    ys = [p[1] for p in grid]
    boost = node_boost(max(xs) - min(xs), max(ys) - min(ys), vl_count)
    return 2 * DISK_RADIUS * boost * SPACING_MARGIN


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


def _hashed_angle(vl: str) -> float:
    """A direction that is a stable hash of ``vl``."""
    return (zlib.crc32(vl.encode("utf-8")) % 3600) / 3600 * 2 * math.pi


def _place_from_anchors(
    missing: list[str],
    positions: dict[str, Position],
    substation_of: dict[str, str],
    adjacency: dict[str, set[str]],
    spacing: float,
) -> tuple[dict[str, Position], dict[str, str]]:
    """Place each missing voltage level ``spacing`` away from its anchors' mean.

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
            angle = _hashed_angle(vl)
            known[vl] = placed[vl] = (
                sum(a[0] for a in anchors) / len(anchors) + spacing * math.cos(angle),
                sum(a[1] for a in anchors) / len(anchors) + spacing * math.sin(angle),
            )
            rule[vl] = how
        left = [vl for vl in todo if vl not in placed]
        if len(left) == len(todo):
            break
        todo = left
    return placed, rule


def _park(isolated: list[str], grid: list[Position], spacing: float) -> dict[str, Position]:
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
    per_row = max(1, int((x1 - x0) // spacing) - 1)
    return {
        vl: (x0 + spacing * (1 + k % per_row), bottom - spacing * (1 + k // per_row))
        for k, vl in enumerate(isolated)
    }


def _spread_colocated(
    vl_ids: Iterable[str],
    known: dict[str, Position],
    nominal_v: dict[str, float],
    adjacency: dict[str, set[str]],
    spacing: float,
) -> dict[str, Position]:
    """Move the voltage levels that share a point; returns their new positions.

    The highest voltage (then the smallest id) keeps the point. The others go
    on a ``spacing``-radius circle round it, evenly spaced, starting towards
    the first one's electrical neighbours, so a pair fans out along its own
    lines.
    """
    groups: dict[Position, list[str]] = defaultdict(list)
    for vl in vl_ids:
        if vl in known:
            groups[known[vl]].append(vl)
    moved: dict[str, Position] = {}
    for point, members in groups.items():
        if len(members) < 2:
            continue
        _, *others = sorted(members, key=lambda vl: (-nominal_v.get(vl, 0.0), vl))
        start = _heading(others[0], point, known, adjacency)
        for k, vl in enumerate(others):
            angle = start + 2 * math.pi * k / len(others)
            moved[vl] = (point[0] + spacing * math.cos(angle), point[1] + spacing * math.sin(angle))
    return moved


def _heading(vl: str, point: Position, known: dict[str, Position], adjacency: dict[str, set[str]]) -> float:
    """Direction from ``point`` to ``vl``'s neighbours away from it, else hashed from ``vl``."""
    away = [known[o] for o in adjacency.get(vl, ()) if o in known and known[o] != point]
    if not away:
        return _hashed_angle(vl)
    return math.atan2(
        sum(p[1] for p in away) / len(away) - point[1],
        sum(p[0] for p in away) / len(away) - point[0],
    )


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
