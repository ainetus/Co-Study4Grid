# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# SPDX-License-Identifier: MPL-2.0
"""Stage 1 of the France RTE Matpower game dataset: build one reconstructed
operating point per MATPOWER case into an opaque grid folder.

For each case: convert MATPOWER -> pypowsybl (REAL voltages), add CURRENT
limits, Q-calibrate + AC-settle to a converged base, geolocate onto a France
layout, and run the base-relative N-1 screen. Persists, RESUMABLY (each
artifact is skipped when already present):

    data/rte_matpower/grids/<opaqueId>/network.xiidm
    data/rte_matpower/grids/<opaqueId>/grid_layout.json
    data/rte_matpower/grids/<opaqueId>/n1_contingencies.json
    data/rte_matpower/mapping_private.json         (opaqueId -> real date, private)

Run:  python scripts/game_mode/matpower/build_network.py [caseName|all]
"""
from __future__ import annotations

import datetime
import hashlib
import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from current_limits import add_current_limits  # noqa: E402
from node_breaker import (  # noqa: E402
    rebuild_node_breaker, copy_current_limits, seed_voltages_from_network)
from actions import build_action_space  # noqa: E402
import geo as geo_mod  # noqa: E402

RECON_DIR = geo_mod.RECON_DIR
from grid_snapshot_reconstruct.matpower_parser import parse_case, write_mat  # noqa: E402
from grid_snapshot_reconstruct.reconstruct import (  # noqa: E402
    compute_q_calibration, apply_q_calibration, run_ac_analysis)
from grid_snapshot_reconstruct import tht_dataset as T  # noqa: E402
import pypowsybl as pp  # noqa: E402

REPO = Path(__file__).resolve().parents[3]
DATA = REPO / "data" / "rte_matpower"
GRIDS = DATA / "grids"

# Re-identified 2013 timestamps (from grid_snapshot_reconstruct/eval_ac_v7p.py).
INSTANTS = {
    "case6468rte": "2013-01-14T06:30",
    "case6470rte": "2013-01-18T00:30",
    "case6495rte": "2013-01-15T19:00",
    "case6515rte": "2013-01-18T19:00",
}
_PERIODS = [(6, "night"), (12, "morning"), (18, "afternoon"), (24, "evening")]


def opaque_id(case_name: str) -> str:
    return "grid_" + hashlib.sha1(case_name.encode()).hexdigest()[:8]


def period_title(iso: str) -> str:
    """month + weekday + hour-period, NO year (hidden-date convention)."""
    dt = datetime.datetime.fromisoformat(iso)
    hour_period = next(name for bound, name in _PERIODS if dt.hour < bound)
    return f"{dt.strftime('%B')} — {dt.strftime('%A')} {hour_period}"


def build_network(case_name: str, real_voltage: bool = True):
    case = parse_case(str(RECON_DIR / "data" / "matpower" / f"{case_name}.m"))
    import tempfile
    d = Path(tempfile.mkdtemp())
    mp = write_mat(case, d / f"{case_name}.mat")
    params = {"matpower.import.ignore-base-voltage": "false"} if real_voltage else {}
    net = pp.network.load(str(mp), parameters=params)
    n_lim = add_current_limits(net)
    try:
        apply_q_calibration(net, compute_q_calibration(case))
    except Exception as ex:  # noqa: BLE001
        print(f"  q-calibration skipped: {type(ex).__name__}: {str(ex)[:80]}")
    metrics = run_ac_analysis(net)
    return case, net, n_lim, metrics


def build_case(case_name: str) -> str:
    gid = opaque_id(case_name)
    out = GRIDS / gid
    out.mkdir(parents=True, exist_ok=True)
    net_path = out / "network.xiidm"
    layout_path = out / "grid_layout.json"
    n1_path = out / "n1_contingencies.json"
    if net_path.exists() and layout_path.exists() and n1_path.exists():
        print(f"[{case_name} -> {gid}] already built; skipping")
        return gid
    t0 = time.time()
    print(f"[{case_name} -> {gid}] building ...")
    case, net, n_lim, metrics = build_network(case_name)
    print(f"  network: converged={metrics.converged} limits={n_lim} in {time.time()-t0:.1f}s")

    sub_map_path = out / "rte_substation_map.json"
    bus_sub = ({int(k): v for k, v in json.loads(sub_map_path.read_text()).items()}
               if sub_map_path.exists() else {})
    if not layout_path.exists():
        ref = geo_mod.build_reference()
        bus_coord, src, stats, bus_sub = geo_mod.geolocate_case(case, ref)
        layout = geo_mod.layout_for_network(net, bus_coord)
        layout_path.write_text(json.dumps(layout))
        # Identity mapping -> real RTE substations, used to copy the real
        # busbar/coupler structure in the node-breaker rebuild. Private (it
        # de-anonymises the case), so it stays out of the player-facing bundle.
        sub_map_path.write_text(json.dumps(bus_sub, indent=1))
        print(f"  layout: {len(layout)} VLs positioned  stats={stats}  "
              f"rte-identified buses={len(bus_sub)}")

    if not net_path.exists():
        # Rebuild NODE_BREAKER so the recommender has topological (coupler /
        # node-splitting) levers — MATPOWER imports as BUS_BREAKER with no
        # switches. Preserves each substation's electrical node count exactly,
        # and copies the real RTE7000 busbar structure where the case's buses
        # were identity-matched to real substations.
        nb, nbus, n_rte = rebuild_node_breaker(net, bus_sub, geo_mod.reference_vl_structure())
        copy_current_limits(net, nb)
        seed_voltages_from_network(net, nb)
        m2 = run_ac_analysis(nb)
        print(f"  node-breaker: converged={m2.converged} RTE-structured VLs={n_rte} "
              f"buses={len(nb.get_buses())} (src {len(net.get_buses())})")
        net = nb
        (out / "actions.json").write_text(json.dumps(build_action_space(net)))
        net.save(str(net_path), format="XIIDM",
                 parameters={"iidm.export.xml.version": "1.14"})
        print(f"  saved {net_path.name} + actions.json")

    if not n1_path.exists():
        ts = time.time()
        settle = T.settle_state(net, "eps0.01")
        ant = T.antenna_analysis(net)
        res = T.screen_n1(net, settle.get("stage", "eps0.01"), antennas=ant, chunk_size=250)
        n1_path.write_text(json.dumps(res))
        conts = res.get("contingencies", [])
        non_ant = [c for c in conts if not c.get("antenna")]
        print(f"  scan: {len(non_ant)} non-antenna constraining "
              f"(of {res.get('total_contingencies_tested')} tested) in {time.time()-ts:.0f}s")

    _update_mapping(case_name, gid)
    print(f"[{case_name} -> {gid}] done in {time.time()-t0:.0f}s")
    return gid


def _update_mapping(case_name: str, gid: str):
    mp = DATA / "mapping_private.json"
    data = json.loads(mp.read_text()) if mp.exists() else {}
    iso = INSTANTS.get(case_name, "")
    data[gid] = {
        "case_label": case_name,
        "case_date": iso,
        "period_title": period_title(iso) if iso else case_name,
        "network_path": f"data/rte_matpower/grids/{gid}/network.xiidm",
    }
    mp.write_text(json.dumps(data, indent=2))


def main():
    which = sys.argv[1] if len(sys.argv) > 1 else "all"
    names = list(INSTANTS) if which == "all" else [which]
    for name in names:
        build_case(name)


if __name__ == "__main__":
    main()
