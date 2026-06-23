"""
separate_voltage_levels.py
===========================
Post-process a ``grid_layout.json`` so that the several voltage levels of a
single physical substation no longer share (almost) the same coordinate.

Why
---
PyPSA-EUR / OSM derived networks give each voltage bus of a substation its own
geographic coordinate, but the two buses of a station sit only tens of metres
apart. In raw-Mercator layout space that is ~30-50 user units — far below the
fixed ``r = 27.5`` pypowsybl VL-circle radius — so the disks overlap and the
2-winding-transformer glyph between them "explodes" outside the pair (its
windings are drawn at a constant ±50-unit offset from the edge midpoint, which
is larger than the tiny half-edge, so they land beyond the busnodes and read as
hollow "ghost" rings floating beside the station).

What this script does
---------------------
For every substation that hosts more than one voltage level:
  * the **highest-voltage** VL keeps its current position (the anchor);
  * every **lower-voltage** VL is displaced into the substation's neighbourhood
    by ``--separation`` units — sized so the rendered (frontend-boosted) disk
    clears the anchor's — in an *open* angular direction (the largest gap
    between the incident transmission lines), biased toward the side its own
    lines run so they fan out instead of wrapping back across the anchor. Two
    displaced levels of one substation are kept far enough apart to clear each
    other too.

The result: each VL gets its own non-overlapping disk, and the inter-voltage
transformer is drawn as a proper segment with its windings sitting *on* the
line between the two disks. The separation default tracks the frontend node
boost (``svgBoost.ts`` ``NODE_BOOST_CEILING``): a busnode is drawn at radius
``27.5 × boost``, so two disks need more than ``2 × 27.5 × boost`` between
centres — raise both knobs together if you change one.

Pure-geometry helpers (``angular_gaps``, ``choose_direction``,
``offset_magnitude``, ``separate_layout``) are import-safe and unit-tested in
``test_separate_voltage_levels.py``.

Usage
-----
    python scripts/pypsa_eur/separate_voltage_levels.py --network data/pypsa_eur_eur220_225_380_400
    python scripts/pypsa_eur/separate_voltage_levels.py --network <dir> --dry-run
"""

from __future__ import annotations

import argparse
import json
import logging
import math
import os
import shutil
import zipfile

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
log = logging.getLogger(__name__)

# ─── Geometry tuning ─────────────────────────────────────────────────────────
# pypowsybl emits the VL outer circle at a fixed r = 27.5 user units, but the
# frontend (utils/svg/svgBoost.ts) scales it up by up to NODE_BOOST_CEILING
# (= 60) on wide layouts so the disks are visible — a rendered diameter of
# ~2 × 27.5 × 60 ≈ 3 300 units. For the two voltage-level disks of one
# substation NOT to overlap on screen, their centres must therefore be more
# than one boosted diameter apart. We separate by that diameter plus a margin.
BOOST_CEILING = 60.0                       # keep in sync with svgBoost.ts NODE_BOOST_CEILING
BOOSTED_DIAMETER = 2 * 27.5 * BOOST_CEILING  # ≈ 3 300 user units
DEFAULT_SEPARATION = round(BOOSTED_DIAMETER * 1.3, 1)   # ≈ 4 290 — one diameter + 30 % visible gap
MIN_USABLE_GAP_RAD = math.radians(30.0)   # a direction is "open" only if its gap ≥ this


def _resolve_xiidm(network_dir: str) -> str:
    """Return a path to a readable ``network.xiidm`` (extracting the zip if needed)."""
    xiidm = os.path.join(network_dir, "network.xiidm")
    if os.path.isfile(xiidm):
        return xiidm
    zipped = xiidm + ".zip"
    if os.path.isfile(zipped):
        log.info("  Extracting %s …", os.path.basename(zipped))
        with zipfile.ZipFile(zipped) as zf:
            zf.extractall(network_dir)
        if os.path.isfile(xiidm):
            return xiidm
    raise FileNotFoundError(f"No network.xiidm (or .zip) in {network_dir}")


def angular_gaps(angles: list[float]) -> list[tuple[float, float]]:
    """Return ``[(bisector_angle, gap_size), …]`` for the gaps between sorted angles.

    ``angles`` are radians of the directions to incident neighbours. The result
    is sorted by gap size descending. With no angles, returns a single full
    circle gap pointing along +x.
    """
    if not angles:
        return [(0.0, 2 * math.pi)]
    a = sorted(angles)
    gaps: list[tuple[float, float]] = []
    n = len(a)
    for i in range(n):
        lo = a[i]
        hi = a[(i + 1) % n] + (2 * math.pi if i + 1 == n else 0.0)
        size = hi - lo
        bisector = math.atan2(math.sin((lo + hi) / 2), math.cos((lo + hi) / 2))
        gaps.append((bisector, size))
    gaps.sort(key=lambda g: g[1], reverse=True)
    return gaps


def _ang_dist(a: float, b: float) -> float:
    """Smallest absolute angular distance between two angles (radians)."""
    return abs(math.atan2(math.sin(a - b), math.cos(a - b)))


def _enforce_min_angle(dirs: list[float], min_angle: float) -> list[float]:
    """Spread directions so every pair is ≥ ``min_angle`` apart (relaxation passes).

    Keeps two displaced levels of one substation from landing close enough that
    their boosted disks would overlap *each other*. Exact for two directions;
    a good-enough relaxation for more.
    """
    if min_angle <= 0 or len(dirs) < 2:
        return dirs
    out = list(dirs)
    for _ in range(12):
        worst = None
        for i in range(len(out)):
            for j in range(i + 1, len(out)):
                d = _ang_dist(out[i], out[j])
                if worst is None or d < worst[0]:
                    worst = (d, i, j)
        if worst is None or worst[0] >= min_angle:
            break
        _, i, j = worst
        mean = math.atan2(math.sin(out[i]) + math.sin(out[j]),
                          math.cos(out[i]) + math.cos(out[j]))
        side = math.atan2(math.sin(out[i] - mean), math.cos(out[i] - mean))
        sign = 1.0 if side >= 0 else -1.0
        out[i] = mean + sign * min_angle / 2.0
        out[j] = mean - sign * min_angle / 2.0
    return [math.atan2(math.sin(a), math.cos(a)) for a in out]


def placement_directions(
    gaps: list[tuple[float, float]],
    own_dirs: list[float | None],
    min_angle: float = 0.0,
) -> list[float]:
    """Pick one *distinct* placement direction (radians) per lower-voltage level.

    ``own_dirs[i]`` is the mean direction of level *i*'s own lines (or ``None``).
    Each level is steered into an *open* gap (≥ ``MIN_USABLE_GAP_RAD`` and at
    least half the largest), preferring the one best aligned with its own lines
    so they fan out instead of wrapping over the anchor. When there are more
    levels than open gaps, they are fanned evenly across the largest gap so two
    levels never land on the same spot. ``min_angle`` (radians) guarantees a
    minimum angular separation between the chosen directions so two displaced
    levels of one substation never overlap each other.
    """
    n = len(own_dirs)
    if n == 0:
        return []
    if not gaps:
        return _enforce_min_angle(
            [d if d is not None else (2 * math.pi * k / n) for k, d in enumerate(own_dirs)],
            min_angle)

    largest = gaps[0][1]
    threshold = max(MIN_USABLE_GAP_RAD, 0.5 * largest)
    usable = [g for g in gaps if g[1] >= threshold] or [gaps[0]]

    if len(usable) >= n:
        chosen: list[float] = []
        avail = list(usable)
        for od in own_dirs:
            if od is None:
                pick = max(avail, key=lambda g: g[1])
            else:
                pick = min(avail, key=lambda g: _ang_dist(g[0], od))
            chosen.append(pick[0])
            avail.remove(pick)
        return _enforce_min_angle(chosen, min_angle)

    # more levels than open gaps → fan them across the largest gap, with a
    # margin so we never sit on the bounding lines.
    bisector, size = gaps[0]
    lo = bisector - size / 2.0
    margin = size * 0.15
    span = size - 2.0 * margin
    return _enforce_min_angle(
        [lo + margin + span * (k + 1) / (n + 1) for k in range(n)], min_angle)


def separate_layout(
    layout: dict[str, list[float]],
    vl_substation: dict[str, str],
    vl_nominal_v: dict[str, float],
    line_neighbours: dict[str, list[str]],
    separation: float = DEFAULT_SEPARATION,
) -> tuple[dict[str, list[float]], int]:
    """Return a new layout with co-located multi-voltage VLs separated.

    ``line_neighbours[vl]`` lists the *other* VLs reachable from ``vl`` over a
    transmission line (NOT the intra-substation transformer). Each lower-voltage
    level is pushed ``separation`` units from its anchor — chosen so its rendered
    (boosted) disk clears the anchor's. Coordinates of untouched VLs are copied
    verbatim. Returns ``(new_layout, n_moved)``.
    """
    # group VLs by substation
    by_sub: dict[str, list[str]] = {}
    for vl, sub in vl_substation.items():
        if vl in layout and sub:
            by_sub.setdefault(sub, []).append(vl)

    new_layout: dict[str, list[float]] = {k: list(v) for k, v in layout.items()}
    n_moved = 0

    # minimum angle between two displaced levels so their boosted disks (one
    # diameter ≈ BOOSTED_DIAMETER, both at radius `separation`) clear each other.
    ratio = min(1.0, BOOSTED_DIAMETER / (2.0 * separation))
    min_angle = min(math.pi, 2.0 * math.asin(ratio) * 1.3)

    for sub, vls in by_sub.items():
        if len(vls) < 2:
            continue
        anchor = max(vls, key=lambda v: (vl_nominal_v.get(v, 0.0), v))
        ax, ay = float(layout[anchor][0]), float(layout[anchor][1])

        # directions to every neighbour reached from ANY VL of this station
        # (skip neighbours that sit on top of us — e.g. the intra-station transfo)
        angles: list[float] = []
        for vl in vls:
            for nb in line_neighbours.get(vl, ()):
                if nb not in layout:
                    continue
                dx, dy = layout[nb][0] - ax, layout[nb][1] - ay
                if math.hypot(dx, dy) < 1.0:
                    continue
                angles.append(math.atan2(dy, dx))
        gaps = angular_gaps(angles)

        # move every non-anchor (lower-voltage) VL, highest first, into distinct gaps
        movers = sorted((v for v in vls if v != anchor),
                        key=lambda v: vl_nominal_v.get(v, 0.0), reverse=True)
        own_dirs: list[float | None] = []
        for vl in movers:
            dirs = []
            for nb in line_neighbours.get(vl, ()):
                if nb in layout:
                    dx, dy = layout[nb][0] - ax, layout[nb][1] - ay
                    if math.hypot(dx, dy) >= 1.0:
                        dirs.append(math.atan2(dy, dx))
            own_dirs.append(
                math.atan2(sum(math.sin(t) for t in dirs), sum(math.cos(t) for t in dirs))
                if dirs else None
            )

        for vl, theta in zip(movers, placement_directions(gaps, own_dirs, min_angle)):
            nx = ax + separation * math.cos(theta)
            ny = ay + separation * math.sin(theta)
            new_layout[vl] = [round(nx, 2), round(ny, 2)]
            n_moved += 1

    return new_layout, n_moved


def _build_topology(network):
    """Extract VL→substation, VL→nominalV and per-VL line neighbours from pypowsybl."""
    vls = network.get_voltage_levels()
    vl_substation = {vid: row["substation_id"] for vid, row in vls.iterrows()}
    vl_nominal_v = {vid: float(row["nominal_v"]) for vid, row in vls.iterrows()}

    line_neighbours: dict[str, list[str]] = {vid: [] for vid in vls.index}
    lines = network.get_lines()
    for _, row in lines.iterrows():
        a, b = row["voltage_level1_id"], row["voltage_level2_id"]
        if a in line_neighbours and b in line_neighbours:
            line_neighbours[a].append(b)
            line_neighbours[b].append(a)
    return vl_substation, vl_nominal_v, line_neighbours


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--network", required=True,
                        help="Network data directory (holds network.xiidm[.zip] + grid_layout.json)")
    parser.add_argument("--dry-run", action="store_true",
                        help="Compute and report, but do not write the new layout")
    parser.add_argument("--no-backup", action="store_true",
                        help="Skip writing grid_layout.json.bak.coloc")
    parser.add_argument("--separation", type=float, default=DEFAULT_SEPARATION,
                        help=(
                            "Units to push each lower-voltage level from its anchor. "
                            f"Default {DEFAULT_SEPARATION:.0f} ≈ one boosted disk diameter "
                            "(2 × 27.5 × svgBoost ceiling 60) + 10 %%, so the two disks "
                            "clear on screen. Raise it in lockstep if you raise the boost ceiling."
                        ))
    args = parser.parse_args()

    script_dir = os.path.dirname(os.path.abspath(__file__))
    base_dir = os.path.join(script_dir, "..", "..")
    net_dir = args.network if os.path.isabs(args.network) else os.path.join(base_dir, args.network)
    layout_path = os.path.join(net_dir, "grid_layout.json")
    if not os.path.isfile(layout_path):
        raise FileNotFoundError(f"grid_layout.json not found at {layout_path}")

    import pypowsybl.network as pn

    log.info("Loading network …")
    network = pn.load(_resolve_xiidm(net_dir))
    vl_substation, vl_nominal_v, line_neighbours = _build_topology(network)

    with open(layout_path) as f:
        layout = json.load(f)

    new_layout, n_moved = separate_layout(
        layout, vl_substation, vl_nominal_v, line_neighbours, separation=args.separation)
    log.info("Separated %d lower-voltage levels by %.0f units across multi-voltage substations.",
             n_moved, args.separation)

    # report min intra-substation distance after separation
    by_sub: dict[str, list[str]] = {}
    for vl, sub in vl_substation.items():
        if vl in new_layout and sub:
            by_sub.setdefault(sub, []).append(vl)
    worst = math.inf
    for vls in by_sub.values():
        for i in range(len(vls)):
            for j in range(i + 1, len(vls)):
                p, q = new_layout[vls[i]], new_layout[vls[j]]
                worst = min(worst, math.hypot(p[0] - q[0], p[1] - q[1]))
    if worst < math.inf:
        log.info("  Min intra-substation VL distance now: %.1f units (was ~34).", worst)

    if args.dry_run:
        log.info("Dry-run: not writing.")
        return
    if not args.no_backup:
        backup = layout_path + ".bak.coloc"
        if not os.path.exists(backup):
            shutil.copy2(layout_path, backup)
            log.info("  Backed up original to %s", os.path.basename(backup))
    with open(layout_path, "w") as f:
        json.dump(new_layout, f, indent=2)
    log.info("  Written: %s (%d entries)", layout_path, len(new_layout))


if __name__ == "__main__":
    main()
