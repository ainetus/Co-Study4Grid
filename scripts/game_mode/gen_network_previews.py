# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0
"""Generate the Game Mode config-screen network preview maps.

Each difficulty tier plays on one grid; the landing page shows a small
geographic node map of that grid so a participant can see the network they
are about to work on before starting. This script renders every voltage
level's coordinate from a grid's ``grid_layout.json`` as a dot, coloured by
its nominal kV (parsed from the id suffix), into a compact, dependency-free
SVG committed under ``frontend/public/game/``.

Re-run after a grid's layout changes:

    python scripts/game_mode/gen_network_previews.py
"""
from __future__ import annotations

import json
import re
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_OUT_DIR = _REPO_ROOT / "frontend" / "public" / "game"

# (tier, layout path, output filename). Mirrors DIFFICULTY_TIERS in
# frontend/src/game/presets.ts.
_GRIDS = [
    ("medium", "data/pypsa_eur_eur220_225_380_400/grid_layout.json", "preview-medium.svg"),
    ("high", "data/pypsa_eur_fr225_400/grid_layout.json", "preview-high.svg"),
]

# Node colour by nominal kV — medium-luminance tones that read on both the
# light and dark config-screen cards (the SVG is shown as a themeless <img>).
_KV_COLORS = {
    220: "#2dd4bf",
    225: "#38bdf8",
    380: "#a78bfa",
    400: "#fb923c",
}
_OTHER_COLOR = "#94a3b8"

_WIDTH = 900
_PADDING = 24
_RADIUS = 2.3
_MAX_POINTS = 2600  # stride-sample denser grids so the asset stays small

_KV_RE = re.compile(r"-(\d{3})(?:\D|$)")


def _kv_of(node_id: str) -> int:
    m = _KV_RE.search(node_id)
    return int(m.group(1)) if m else 0


def _build_svg(layout: dict) -> str:
    points = [(coords[0], coords[1], _kv_of(node_id))
              for node_id, coords in layout.items()
              if isinstance(coords, (list, tuple)) and len(coords) >= 2]
    if not points:
        raise ValueError("layout has no usable coordinates")

    stride = max(1, len(points) // _MAX_POINTS)
    points = points[::stride]

    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    min_x, max_x = min(xs), max(xs)
    min_y, max_y = min(ys), max(ys)
    span_x = (max_x - min_x) or 1.0
    span_y = (max_y - min_y) or 1.0

    inner_w = _WIDTH - 2 * _PADDING
    inner_h = inner_w * (span_y / span_x)
    height = inner_h + 2 * _PADDING

    def project(x: float, y: float) -> tuple[float, float]:
        px = _PADDING + (x - min_x) / span_x * inner_w
        # Flip Y: layout is metres-up, SVG is pixels-down.
        py = _PADDING + (max_y - y) / span_y * inner_h
        return round(px, 1), round(py, 1)

    # Group by colour; draw ascending kV so the HV backbone lands on top.
    by_color: dict[str, list[tuple[float, float]]] = {}
    for x, y, kv in points:
        color = _KV_COLORS.get(kv, _OTHER_COLOR)
        by_color.setdefault(color, []).append(project(x, y))

    ordered = sorted(
        by_color.items(),
        key=lambda kc: next((kv for kv, c in _KV_COLORS.items() if c == kc[0]), 0),
    )

    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {_WIDTH} {round(height, 1)}" '
        f'role="img" aria-label="Network map" preserveAspectRatio="xMidYMid meet">'
    ]
    for color, pts in ordered:
        parts.append(f'<g fill="{color}" fill-opacity="0.82">')
        parts.append("".join(
            f'<circle cx="{px}" cy="{py}" r="{_RADIUS}"/>' for px, py in pts))
        parts.append("</g>")
    parts.append("</svg>")
    return "".join(parts)


def main() -> int:
    _OUT_DIR.mkdir(parents=True, exist_ok=True)
    for tier, layout_rel, out_name in _GRIDS:
        layout_path = _REPO_ROOT / layout_rel
        if not layout_path.is_file():
            print(f"skip {tier}: {layout_rel} missing")
            continue
        layout = json.loads(layout_path.read_text(encoding="utf-8"))
        svg = _build_svg(layout)
        out_path = _OUT_DIR / out_name
        out_path.write_text(svg, encoding="utf-8")
        print(f"{tier}: {len(layout)} nodes → {out_path.relative_to(_REPO_ROOT)} "
              f"({len(svg) // 1024} KB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
