# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# SPDX-License-Identifier: MPL-2.0
"""Geolocate an anonymised MATPOWER French grid onto a France map.

The MATPOWER RTE cases carry no names or coordinates. We recover an
approximate France layout by:

  1. matching each case's 400 kV postes to real RTE substations via the
     ``grid_snapshot_reconstruct`` Rosetta electrical-distance percolation,
     against a NAMED THT reference snapshot (Co-Study4Grid's committed
     ``grid_5384e039`` = hiver_pic_2021, whose VL ids ARE real RTE names);
  2. chaining matched substations to their France coordinates in the
     reconstruct repo's ``grid_layout_rte.json`` (Lambert-II planar layout);
  3. placing 225 kV buses on the reference's REAL 225 kV substation
     positions (bucketed by parent 400 kV substation) so local geography
     looks like a real grid, and propagating the rest along the graph.

Requires the sibling ``grid_snapshot_reconstruct`` repo (path via the
``RECON_DIR`` env var, default the sibling checkout) for ``rosetta_regional``
and ``grid_layout_rte.json``.
"""
from __future__ import annotations

import base64
import collections
import gzip
import json
import os
import sys
import tempfile
from pathlib import Path

import numpy as np
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import shortest_path
import pypowsybl as pp

RECON_DIR = Path(os.environ.get("RECON_DIR", "/Users/antoine/Dev/Grid_snapshot_reconstruct"))
if str(RECON_DIR) not in sys.path:
    sys.path.insert(0, str(RECON_DIR))

from grid_snapshot_reconstruct import rosetta_regional as R  # noqa: E402
from grid_snapshot_reconstruct.matpower_parser import BASE_KV  # noqa: E402

REPO = Path(__file__).resolve().parents[3]
# Named THT reference: Co-Study4Grid's committed hiver_pic_2021 snapshot.
REFERENCE_GRID = REPO / "data" / "rte7000_tht" / "grids" / "grid_5384e039" / "network.xiidm.gz.b64"
LAYOUT_RTE = RECON_DIR / "data" / "grid_layout_rte.json"


def _decode_reference() -> str:
    """Decode the committed reference snapshot to a temp xiidm; return path."""
    raw = gzip.decompress(base64.b64decode(REFERENCE_GRID.read_bytes()))
    out = Path(tempfile.gettempdir()) / "matpower_geo_ref2021.xiidm"
    out.write_bytes(raw)
    return str(out)


def build_reference() -> dict:
    """Prepare the 2021 named reference: 400 kV substation graph (DP21),
    coordinates, and per-parent 225 kV real positions."""
    net = pp.network.load(_decode_reference())
    vls = net.get_voltage_levels()
    layout = json.loads(LAYOUT_RTE.read_text())
    nom = {v: float(vls.loc[v, "nominal_v"]) for v in vls.index}
    vl400 = [v for v in vls.index if abs(nom[v] - 380.0) < 1.0]
    vl225 = [v for v in vls.index if 200.0 <= nom[v] < 380.0]
    sub_of = lambda v: v[:5]  # noqa: E731  (RTE VL id: <5-char site><P><kV digit>)
    subs = sorted({sub_of(v) for v in vl400})
    sidx = {s: i for i, s in enumerate(subs)}
    coord400 = {}
    for v in vl400:
        if v in layout:
            coord400.setdefault(sub_of(v), layout[v])
    lines = net.get_lines()
    vl400_set = set(vl400)
    emap: dict[tuple[int, int], float] = {}
    for _, row in lines.iterrows():
        v1, v2 = row["voltage_level1_id"], row["voltage_level2_id"]
        if v1 in vl400_set and v2 in vl400_set:
            s1, s2 = sub_of(v1), sub_of(v2)
            if s1 == s2:
                continue
            k = (min(sidx[s1], sidx[s2]), max(sidx[s1], sidx[s2]))
            emap[k] = min(emap.get(k, np.inf), max(abs(float(row["x"])), 0.01))
    n = len(subs)
    rows = [k[0] for k in emap] + [k[1] for k in emap]
    cols = [k[1] for k in emap] + [k[0] for k in emap]
    ws = list(emap.values()) * 2
    dp21 = shortest_path(coo_matrix((ws, (rows, cols)), shape=(n, n)).tocsr(), directed=False)
    coord225 = {}
    for v in vl225:
        if v in layout:
            coord225.setdefault(sub_of(v), layout[v])
    r400 = list(coord400.items())
    by_parent: dict[str, list] = collections.defaultdict(list)
    for _s225, c in coord225.items():
        parent = min(r400, key=lambda sc: (sc[1][0] - c[0]) ** 2 + (sc[1][1] - c[1]) ** 2)[0]
        by_parent[parent].append(c)
    return dict(subs=subs, sidx=sidx, coord400=coord400, dp21=dp21, by_parent=by_parent)


def reference_vl_structure() -> dict:
    """Real RTE7000 substation topology, for replication on identity-mapped
    MATPOWER buses: ``{substation_code: {rounded_kv: n_busbar_sections}}``.

    Read from the same committed named snapshot the Rosetta match runs against,
    so a bus matched to substation S at 380 kV gets S's real 380 kV busbar count.
    """
    net = pp.network.load(_decode_reference())
    vls = net.get_voltage_levels()
    counts: dict = collections.Counter(net.get_busbar_sections()["voltage_level_id"])
    struct: dict = collections.defaultdict(dict)
    for vl in vls.index:
        n = counts.get(vl, 0)
        if n:
            struct[vl[:5]][int(round(float(vls.loc[vl, "nominal_v"])))] = n
    return dict(struct)


def geolocate_case(case, ref: dict, seed: int = 0):
    """Return (bus_id -> [x, y], provenance dict, stats) for a MatpowerCase."""
    subs, sidx, dp21 = ref["subs"], ref["sidx"], ref["dp21"]
    coord400, by_parent = ref["coord400"], ref["by_parent"]
    kv = {int(b): float(v) for b, v in zip(case.bus[:, 0], case.bus[:, BASE_KV])}
    b400, bidx, adj = R.case_graph_400(case)
    dmat = shortest_path(adj, directed=False)
    plab, reps = R.contract_postes(dmat)
    dp13 = dmat[np.ix_(reps, reps)]
    adj_all = R.full_adjacency(case)
    sites = R.nuclear_sites(case, bidx, plab, kv, adj_all)
    grav = max((p for p, s in sites.items() if s.count("900") >= 5),
               key=lambda p: sites[p].count("900"))
    seeds = {grav: sidx["GRAV5"]}
    for p in [p for p, s in sites.items() if "1500" in s]:
        seeds[p] = sidx["CHOO1"] if dp13[grav, p] < 140 else sidx["CIVAU"]
    matched, loose, alpha = R.percolate(dp13, dp21, seeds)
    poste_sub, poste_src = {}, {}
    for p, j in matched.items():
        poste_sub[p] = subs[j]
        poste_src[p] = "strict"
    for p, (j, _e) in loose.items():
        poste_sub.setdefault(p, subs[j])
        poste_src.setdefault(p, "loose")

    rng = np.random.default_rng(seed)

    def jit(c, s):
        return [c[0] + float(rng.normal(0, s)), c[1] + float(rng.normal(0, s))]

    bus_coord, src = {}, {}
    bus_par = {}
    for b, i in bidx.items():
        p = int(plab[i])
        s = poste_sub.get(p)
        if s and s in coord400:
            bus_coord[b] = jit(coord400[s], 2500.0)
            bus_par[b] = s
            src[b] = poste_src[p]
    par = dict(bus_par)
    frontier = list(par)
    seen = set(frontier)
    while frontier:
        nxt = []
        for b in frontier:
            for v in adj_all[b]:
                if v not in seen:
                    seen.add(v)
                    par[v] = par[b]
                    nxt.append(v)
        frontier = nxt
    ctr: dict[str, int] = collections.defaultdict(int)
    for b in case.bus[:, 0].astype(int):
        if b in bus_coord or kv.get(b, 0) < 200 or kv.get(b, 0) >= 380:
            continue
        s = par.get(b)
        bucket = by_parent.get(s) if s else None
        if bucket:
            c = bucket[ctr[s] % len(bucket)]
            ctr[s] += 1
            bus_coord[b] = jit(c, 2500.0)
            src[b] = "ref225"
        elif s and s in coord400:
            bus_coord[b] = jit(coord400[s], 12000.0)
            src[b] = "near400"
    frontier = list(bus_coord)
    seen = set(frontier)
    while frontier:
        nxt = []
        for b in frontier:
            for v in adj_all[b]:
                if v not in seen:
                    seen.add(v)
                    if v not in bus_coord:
                        bus_coord[v] = jit(bus_coord[b], 3000.0)
                        src[v] = "propagated"
                    nxt.append(v)
        frontier = nxt
    stats = dict(alpha=alpha, matched=len(matched), loose=len(loose), postes=len(reps))
    # Identity mapping (NOT merely positional): matpower 400 kV bus -> real RTE
    # substation code, with the percolation confidence. Only these buses are
    # genuinely identified; 'ref225'/'near400'/'propagated' buses are placed at
    # plausible coordinates but carry no identity.
    bus_sub = {b: {"substation": s, "confidence": src[b]}
               for b, s in bus_par.items() if src.get(b) in ("strict", "loose")}
    return bus_coord, src, stats, bus_sub


def layout_for_network(net, bus_coord: dict) -> dict:
    """Map bus ids -> synthetic pypowsybl VL ids ('VL-<busid>') -> [x, y]."""
    layout = {}
    for vid in net.get_voltage_levels().index:
        try:
            bid = int(str(vid).split("-")[-1])
        except ValueError:
            continue
        if bid in bus_coord:
            layout[vid] = bus_coord[bid]
    return layout
