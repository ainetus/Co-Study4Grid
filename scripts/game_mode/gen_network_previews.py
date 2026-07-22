# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0
"""Generate the Game Mode config-screen network preview maps.

Each difficulty tier plays on one grid; the landing page shows a small map of
that grid so a participant can see the network they are about to work on. This
renders the same thing the app's "Network (N)" NAD shows fully zoomed out —
voltage levels positioned from ``grid_layout.json`` with the lines between them
drawn as edges, the >= 350 kV backbone red and everything below green — into a
compact, dependency-free SVG committed under ``frontend/public/game/``.

The line topology (which two voltage levels each line/transformer connects) is
read straight from ``network.xiidm`` — no pypowsybl needed, just the
``voltageLevelId1`` / ``voltageLevelId2`` attributes. When the network file is
absent (e.g. a grid whose ``network.xiidm.zip`` is an un-smudged Git-LFS
pointer in this checkout), the map degrades to a node-only scatter, and running
this again where the file IS present upgrades it to the full edge map.

Re-run after a grid's layout / network changes (and on any host that has the
network files smudged — the Space Docker build extracts them):

    python scripts/game_mode/gen_network_previews.py
"""
from __future__ import annotations

import base64
import gzip
import json
import re
import zipfile
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_OUT_DIR = _REPO_ROOT / "frontend" / "public" / "game"

# (tier, grid directory, output filename). Mirrors DIFFICULTY_TIERS in
# frontend/src/game/presets.ts.
_GRIDS = [
    ("medium", "data/pypsa_eur_eur220_225_380_400", "preview-medium.svg"),
    ("high", "data/pypsa_eur_fr225_400", "preview-high.svg"),
    # All 4 France THT grids share the RTE7000 topology, so one preview map
    # (from any of them) represents the whole family.
    ("tht", "data/rte7000_tht/grids/grid_e4e81e29", "preview-tht.svg"),
]

# Voltage colouring: the >= 350 kV backbone (380 / 400 kV) is red, everything
# below (220 / 225 kV) is green. The two shades are the Okabe-Ito "vermillion"
# and "bluish green" — a warm/cool pair chosen so red-green colour-blind
# viewers can still tell them apart (they separate on the blue channel and
# lightness, not only the red-green axis), and both sit at a medium luminance
# that reads on the light AND dark config-screen card (the SVG is a themeless
# <img>).
_HV_THRESHOLD_KV = 350
_HV_COLOR = "#d55e00"  # >= 350 kV — "red"
_LV_COLOR = "#009e73"  # < 350 kV — "green"

_WIDTH = 900
_PADDING = 24
_NODE_RADIUS = 1.6
_EDGE_WIDTH = 1.6
_MAX_NODES = 2600  # stride-sample nodes in the fallback (no-edge) scatter

_KV_RE = re.compile(r"-(\d{3})(?:\D|$)")
_BRANCH_TAG_RE = re.compile(r"<(?:\w+:)?(?:line|twoWindingsTransformer)\b([^>]*)>")
_V1_RE = re.compile(r'voltageLevelId1="([^"]+)"')
_V2_RE = re.compile(r'voltageLevelId2="([^"]+)"')


def _kv_of(node_id: str) -> int:
    m = _KV_RE.search(node_id)
    return int(m.group(1)) if m else 0


def _color_of(kv: int) -> str:
    return _HV_COLOR if kv >= _HV_THRESHOLD_KV else _LV_COLOR


def _draw_order(color: str) -> int:
    """Draw the LV (green) layer first so the HV (red) backbone sits on top."""
    return 1 if color == _HV_COLOR else 0


def _load_network_xml(grid_dir: Path) -> str | None:
    """Network XIIDM text, or None when it isn't available in this checkout."""
    direct = grid_dir / "network.xiidm"
    if direct.is_file():
        return direct.read_text(encoding="utf-8", errors="replace")
    zipped = grid_dir / "network.xiidm.zip"
    if zipped.is_file():
        # An un-smudged Git-LFS pointer is a tiny text file — not a real zip.
        if zipped.read_bytes()[:40].startswith(b"version https://git-lfs"):
            return None
        try:
            with zipfile.ZipFile(zipped) as zf:
                name = next((n for n in zf.namelist() if n.endswith(".xiidm")), None)
                if name:
                    return zf.read(name).decode("utf-8", errors="replace")
        except zipfile.BadZipFile:
            return None
    # France THT grids ship compressed + text-encoded as network.xiidm.gz.b64.
    b64 = grid_dir / "network.xiidm.gz.b64"
    if b64.is_file():
        try:
            return gzip.decompress(base64.b64decode(b64.read_bytes())).decode("utf-8", errors="replace")
        except (ValueError, OSError):
            return None
    return None


def _edges(xml: str) -> list[tuple[str, str]]:
    """(voltageLevelId1, voltageLevelId2) for every line + 2-winding transformer."""
    out: list[tuple[str, str]] = []
    for m in _BRANCH_TAG_RE.finditer(xml):
        attrs = m.group(1)
        a, b = _V1_RE.search(attrs), _V2_RE.search(attrs)
        if a and b and a.group(1) != b.group(1):
            out.append((a.group(1), b.group(1)))
    return out


def _projector(layout: dict):
    xs = [c[0] for c in layout.values() if isinstance(c, (list, tuple)) and len(c) >= 2]
    ys = [c[1] for c in layout.values() if isinstance(c, (list, tuple)) and len(c) >= 2]
    min_x, max_x, min_y, max_y = min(xs), max(xs), min(ys), max(ys)
    span_x = (max_x - min_x) or 1.0
    span_y = (max_y - min_y) or 1.0
    inner_w = _WIDTH - 2 * _PADDING
    inner_h = inner_w * (span_y / span_x)
    height = inner_h + 2 * _PADDING

    def project(node_id: str):
        coords = layout.get(node_id)
        if not (isinstance(coords, (list, tuple)) and len(coords) >= 2):
            return None
        x, y = coords[0], coords[1]
        px = _PADDING + (x - min_x) / span_x * inner_w
        # The layout's y already increases SOUTHWARD (north = smaller y — LILLE
        # sits at a large negative y, TOULOUSE at a large positive one), which
        # is the same sense as the screen's y-down axis, so map it directly. A
        # flip here would render the network upside down.
        py = _PADDING + (y - min_y) / span_y * inner_h
        return round(px, 1), round(py, 1)

    return project, height


def _svg_header(height: float) -> str:
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {_WIDTH} {round(height, 1)}" '
        f'role="img" aria-label="Network map" preserveAspectRatio="xMidYMid meet">'
    )


def _build_edge_map(layout: dict, edges: list[tuple[str, str]]) -> str:
    project, height = _projector(layout)

    # Group edges by colour (max kV of the two endpoints → HV backbone on top).
    # The edges carry the whole structure — no separate node layer, which would
    # roughly double the file for no visible gain (the endpoints are where the
    # lines already meet).
    edge_paths: dict[str, list[str]] = {}
    connected: set[str] = set()
    for vl1, vl2 in edges:
        p1, p2 = project(vl1), project(vl2)
        if p1 is None or p2 is None:
            continue
        connected.add(vl1)
        connected.add(vl2)
        color = _color_of(max(_kv_of(vl1), _kv_of(vl2)))
        edge_paths.setdefault(color, []).append(f"M{p1[0]} {p1[1]}L{p2[0]} {p2[1]}")

    # Only VLs with no line at all get a dot (so islanded substations don't
    # vanish); everything else is implied by its edges.
    orphan_pts: dict[str, list[tuple[float, float]]] = {}
    for node_id in layout:
        if node_id in connected:
            continue
        p = project(node_id)
        if p is None:
            continue
        orphan_pts.setdefault(_color_of(_kv_of(node_id)), []).append(p)

    parts = [_svg_header(height)]
    for color, segs in sorted(edge_paths.items(), key=lambda kc: _draw_order(kc[0])):
        parts.append(
            f'<path d="{"".join(segs)}" fill="none" stroke="{color}" '
            f'stroke-width="{_EDGE_WIDTH}" stroke-opacity="0.85" '
            f'stroke-linecap="round" stroke-linejoin="round"/>'
        )
    for color, pts in sorted(orphan_pts.items(), key=lambda kc: _draw_order(kc[0])):
        parts.append(f'<g fill="{color}" fill-opacity="0.9">')
        parts.append("".join(f'<circle cx="{x}" cy="{y}" r="{_NODE_RADIUS}"/>' for x, y in pts))
        parts.append("</g>")
    parts.append("</svg>")
    return "".join(parts)


def _build_node_scatter(layout: dict) -> str:
    """Fallback when the network topology isn't available: nodes only."""
    project, height = _projector(layout)
    ids = list(layout)
    stride = max(1, len(ids) // _MAX_NODES)
    by_color: dict[str, list[tuple[float, float]]] = {}
    for node_id in ids[::stride]:
        p = project(node_id)
        if p is None:
            continue
        by_color.setdefault(_color_of(_kv_of(node_id)), []).append(p)

    parts = [_svg_header(height)]
    for color, pts in sorted(by_color.items(), key=lambda kc: _draw_order(kc[0])):
        parts.append(f'<g fill="{color}" fill-opacity="0.82">')
        parts.append("".join(f'<circle cx="{x}" cy="{y}" r="2.3"/>' for x, y in pts))
        parts.append("</g>")
    parts.append("</svg>")
    return "".join(parts)


def main() -> int:
    _OUT_DIR.mkdir(parents=True, exist_ok=True)
    for tier, grid_rel, out_name in _GRIDS:
        grid_dir = _REPO_ROOT / grid_rel
        layout_path = grid_dir / "grid_layout.json"
        if not layout_path.is_file():
            print(f"skip {tier}: {grid_rel}/grid_layout.json missing")
            continue
        layout = json.loads(layout_path.read_text(encoding="utf-8"))
        out_path = _OUT_DIR / out_name
        xml = _load_network_xml(grid_dir)
        if xml:
            edges = _edges(xml)
            svg = _build_edge_map(layout, edges)
            out_path.write_text(svg, encoding="utf-8")
            print(f"{tier}: {len(layout)} nodes → {out_path.relative_to(_REPO_ROOT)} "
                  f"[edge map, {len(edges)} lines, {len(svg) // 1024} KB]")
        elif out_path.is_file():
            # Network file is an un-smudged LFS pointer here. Never downgrade a
            # committed edge map to a node scatter — re-run on a host where
            # network.xiidm is smudged to (re)generate the real edge map.
            print(f"{tier}: network file unavailable (LFS) — keeping existing "
                  f"{out_path.relative_to(_REPO_ROOT)}")
        else:
            svg = _build_node_scatter(layout)
            out_path.write_text(svg, encoding="utf-8")
            print(f"{tier}: {len(layout)} nodes → {out_path.relative_to(_REPO_ROOT)} "
                  f"[node scatter fallback — network file unavailable, {len(svg) // 1024} KB]")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
