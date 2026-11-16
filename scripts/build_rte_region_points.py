"""
build_rte_region_points.py
==========================
Reference points of the seven RTE regions, for the Context tab of a
France-only network whose substations carry no ``regionCvg`` (the PyPSA-EUR
France bundle): ``context_map/regions.py`` gives each of its substations the
region of the RTE substations its lines name (``CHOO2L72LONNY``), else
of the nearest reference ones.

The points are the substations of the France THT grids shipped in
``data/rte7000_tht`` — every one tagged with its region (``regionCvg``) — at
the place Carte-Front's calibration of the op4grid plan puts them
(``georef.op4grid_plan_lonlat``, ~30 km median error). The grids share their
substations; the first one met wins.

Usage
-----
    python scripts/build_rte_region_points.py
"""
from __future__ import annotations

import argparse
import base64
import gzip
import io
import json
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from expert_backend.services.context_map.georef import op4grid_plan_lonlat  # noqa: E402

GRIDS = ROOT / "data" / "rte7000_tht" / "grids"
OUT = ROOT / "expert_backend" / "services" / "context_map" / "resources" / "rte_region_points.json"
IIDM = "{http://www.powsybl.org/schema/iidm/1_"


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def substation_regions(xiidm: bytes) -> dict[str, tuple[str, list[str]]]:
    """``{substation: (region, [voltage levels])}`` of the substations that
    carry a ``regionCvg``."""
    out: dict[str, tuple[str, list[str]]] = {}
    for _, elem in ET.iterparse(io.BytesIO(xiidm), events=("end",)):
        if _local(elem.tag) != "substation":
            continue
        region = next((p.get("value") for p in elem if _local(p.tag) == "property"
                       and p.get("name") == "regionCvg"), None)
        vls = [v.get("id") for v in elem if _local(v.tag) == "voltageLevel"]
        if region and vls:
            out[elem.get("id")] = (region.strip().upper(), vls)
        elem.clear()
    return out


def region_points(grid_dirs: list[Path]) -> list[list]:
    """``[substation, lon, lat, region]`` per tagged substation laid out on
    the plan."""
    seen: dict[str, list] = {}
    for grid in grid_dirs:
        xiidm = gzip.decompress(base64.b64decode((grid / "network.xiidm.gz.b64").read_bytes()))
        layout = json.loads((grid / "grid_layout.json").read_text(encoding="utf-8"))
        for sid, (region, vls) in substation_regions(xiidm).items():
            xy = [layout[v] for v in vls if v in layout]
            if sid in seen or not xy:
                continue
            lon, lat = op4grid_plan_lonlat(np.array([np.mean(xy, axis=0)]))[0]
            seen[sid] = [sid, round(float(lon), 3), round(float(lat), 3), region]
    return [seen[s] for s in sorted(seen)]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--grids", type=Path, default=GRIDS)
    parser.add_argument("--out", type=Path, default=OUT)
    args = parser.parse_args()
    points = region_points(sorted(p for p in args.grids.iterdir() if p.is_dir()))
    record = {
        "source": "data/rte7000_tht (regionCvg), placed by Carte-Front's op4grid-plan calibration",
        "points": points,
    }
    args.out.write_text(json.dumps(record, separators=(",", ":")) + "\n", encoding="utf-8")
    regions: dict[str, int] = {}
    for _, _, _, r in points:
        regions[r] = regions.get(r, 0) + 1
    print(f"Wrote {args.out} — {len(points)} substations: {regions}")


if __name__ == "__main__":
    main()
