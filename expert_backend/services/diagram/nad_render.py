# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0

"""NAD generation primitive — pure function over pypowsybl objects.

Takes a positioned network + NadParameters + optional VL focus and
returns ``{"svg", "metadata"}``. Post-processes the SVG to strip any
element that still carries a ``NaN`` attribute (a node pypowsybl could
not place — prevents rendering crashes downstream), and recomputes the
root ``viewBox`` / ``width`` / ``height`` from the finite nodes when
such a node made them NaN.
"""
from __future__ import annotations

import json
import logging
import math
import time
from typing import Any

logger = logging.getLogger(__name__)

# pypowsybl's default ``SvgParameters.diagramPadding``, for metadata without it.
_DEFAULT_PADDING = 200.0
_ROOT_SIZE_ATTRIBUTES = ("viewBox", "width", "height")


def _strip_nan_elements(svg: str, metadata: str | None = None) -> str:
    """Remove any SVG element whose attributes contain the literal ``"NaN"``.

    The root ``<svg>`` stays: when its ``viewBox`` / ``width`` / ``height``
    are NaN they are recomputed from the finite nodes of ``metadata`` (the
    NAD metadata JSON) — see ``_repair_root_size``. Silent no-op on parse
    errors.
    """
    if "NaN" not in svg:
        return svg
    try:
        from lxml import etree
        parser = etree.XMLParser(recover=True, huge_tree=True)
        root = etree.fromstring(svg.encode("utf-8"), parser=parser)

        to_remove = [el for el in root.iter()
                     if el is not root and any("NaN" in str(val) for val in el.attrib.values())]
        for el in to_remove:
            parent = el.getparent()
            if parent is not None:
                parent.remove(el)

        logger.info("[RECO] NaN-stripping complete: removed %d elements.", len(to_remove))
        if any("NaN" in (root.get(name) or "") for name in _ROOT_SIZE_ATTRIBUTES):
            _repair_root_size(root, metadata, {el.get("id") for el in to_remove if el.get("id")})
        return etree.tostring(root, encoding="unicode")
    except Exception as e:
        logger.warning("Warning: Failed to strip NaN from SVG: %s", e)
        return svg


def _repair_root_size(root: Any, metadata: str | None, stripped_ids: set[str]) -> None:
    """Recompute the root ``viewBox`` / ``width`` / ``height`` as pypowsybl does.

    pypowsybl bounds every node and text node, pads the box by
    ``svgParameters.diagramPadding`` and sizes the SVG by its
    ``sizeConstraint``; one NaN node makes all of it NaN. The metadata still
    lists that node — at (0, 0) — so the nodes whose element was stripped
    are left out. Leaves the root untouched when no finite node remains.
    """
    try:
        meta = json.loads(metadata) if metadata else {}
    except ValueError:
        meta = {}
    svg_params = meta.get("svgParameters") or {}
    view_box = _finite_view_box(meta, svg_params, stripped_ids)
    if view_box is None:
        logger.warning("Warning: NaN root viewBox kept, no finite node to bound.")
        return
    x, y, w, h = view_box
    root.set("viewBox", f"{x:.2f} {y:.2f} {w:.2f} {h:.2f}")
    if root.get("width") is not None or root.get("height") is not None:
        scale = _size_scale(svg_params, w, h)
        root.set("width", f"{w * scale:.2f}")
        root.set("height", f"{h * scale:.2f}")
    logger.info("[RECO] NaN root viewBox recomputed from the finite nodes: %s", root.get("viewBox"))


def _finite_view_box(
    meta: dict, svg_params: dict, excluded_ids: set[str],
) -> tuple[float, float, float, float] | None:
    """Padded bounding box of the finite nodes + their text nodes, or ``None``."""
    nodes: dict[Any, tuple[float, float]] = {}
    for node in meta.get("nodes") or ():
        x, y = _finite(node.get("x")), _finite(node.get("y"))
        if node.get("svgId") not in excluded_ids and math.isfinite(x) and math.isfinite(y):
            nodes[node.get("svgId")] = (x, y)
    points = list(nodes.values())
    for text in meta.get("textNodes") or ():
        anchor = nodes.get(text.get("vlNode"))
        dx, dy = _finite(text.get("shiftX")), _finite(text.get("shiftY"))
        if anchor is not None and math.isfinite(dx) and math.isfinite(dy):
            points.append((anchor[0] + dx, anchor[1] + dy))
    if not points:
        return None
    padding = svg_params.get("diagramPadding") or {}
    left, top, right, bottom = (
        _finite(padding.get(side), _DEFAULT_PADDING) for side in ("left", "top", "right", "bottom")
    )
    min_x, max_x = min(p[0] for p in points), max(p[0] for p in points)
    min_y, max_y = min(p[1] for p in points), max(p[1] for p in points)
    return (
        min_x - left,
        min_y - top,
        max(max_x - min_x + left + right, 1.0),
        max(max_y - min_y + top + bottom, 1.0),
    )


def _size_scale(svg_params: dict, width: float, height: float) -> float:
    """pypowsybl's user-unit → SVG-size scale for the ``sizeConstraint``."""
    constraint = svg_params.get("sizeConstraint")
    if constraint == "FIXED_WIDTH":
        return _finite(svg_params.get("fixedWidth"), width) / width
    if constraint == "FIXED_HEIGHT":
        return _finite(svg_params.get("fixedHeight"), height) / height
    if constraint == "FIXED_SCALE":
        return _finite(svg_params.get("fixedScale"), 1.0)
    return 1.0


def _finite(value: Any, default: float = math.nan) -> float:
    """``value`` as a finite float, else ``default``."""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return number if math.isfinite(number) else default


def generate_diagram(
    network: Any,
    df_layout: Any = None,
    nad_parameters: Any = None,
    voltage_level_ids: list[str] | None = None,
    depth: int = 0,
) -> dict:
    """Generate a NAD for ``network`` and return ``{"svg", "metadata"}``.

    ``df_layout`` is the pre-loaded ``grid_layout`` DataFrame (pass
    ``None`` to let pypowsybl auto-layout). ``voltage_level_ids`` +
    ``depth`` produce a focused sub-diagram; omit for the full grid.
    """
    from pypowsybl_jupyter.util import _get_svg_metadata, _get_svg_string

    logger.info("[RECO] Generating diagram (VLs=%s, depth=%d)...", voltage_level_ids, depth)
    t0 = time.time()

    kwargs: dict = {"nad_parameters": nad_parameters}
    if df_layout is not None:
        kwargs["fixed_positions"] = df_layout
    if voltage_level_ids is not None:
        kwargs["voltage_level_ids"] = voltage_level_ids
        kwargs["depth"] = depth

    diagram = network.get_network_area_diagram(**kwargs)
    t1 = time.time()

    svg = _get_svg_string(diagram)
    t2 = time.time()

    meta = _get_svg_metadata(diagram)
    t3 = time.time()

    logger.info(
        "[RECO] Diagram generated: NAD %.2fs, SVG %.2fs, Meta %.2fs (SVG length=%d)",
        t1 - t0, t2 - t1, t3 - t2, len(svg),
    )

    svg = _strip_nan_elements(svg, meta)
    return {"svg": svg, "metadata": meta}
