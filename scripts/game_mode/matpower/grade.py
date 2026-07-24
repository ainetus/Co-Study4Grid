# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# SPDX-License-Identifier: MPL-2.0
"""Stage 2 of the France RTE Matpower game dataset: difficulty-grade the
non-antenna constraining N-1 contingencies of a built grid, driving the
Co-Study4Grid recommender offline.

RESUMABLE: each graded scenario is appended to ``graded.jsonl`` as it is
computed; a re-run skips contingencies already present, so a machine restart
continues where it stopped.

Difficulty (mirrors RTE7000 THT):
  easy   - a suggested unitary action resolves every contingency-attributable
           overload;
  medium - no unitary resolves, but a first-identified superposition pair does;
  hard   - neither.

Per the Co-Study4Grid N-overload rule, base overloads NOT worsened by the
contingency are not counted for resolution (base-relative).

Run:  python scripts/game_mode/matpower/grade.py <gridId> [--limit N] [--time]
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from expert_backend.main import ConfigRequest  # noqa: E402
from expert_backend.services.network_service import network_service  # noqa: E402
from expert_backend.services.recommender_service import recommender_service  # noqa: E402

REPO = Path(__file__).resolve().parents[3]
DATA = REPO / "data" / "rte_matpower"

# Matpower networks are bus-branch: no couplers/node topology, so the action
# space is line disconnection + injection actions. Coupling minima -> 0.
CONFIG_MINIMA = dict(
    min_line_reconnections=0.0, min_close_coupling=0.0, min_open_coupling=0.0,
    min_line_disconnections=3.0, min_pst=1.0, min_load_shedding=2.0,
    min_renewable_curtailment_actions=2, min_redispatch=2,
    n_prioritized_actions=15, monitoring_factor=0.95,
    pre_existing_overload_threshold=0.02, ignore_reconnections=False,
    pypowsybl_fast_mode=True,
)


def configure(grid_dir: Path):
    actions = grid_dir / "actions.json"
    if not actions.exists():
        actions.write_text("{}")  # backend auto-generates disco_* per line
    cfg = ConfigRequest(
        network_path=str(grid_dir / "network.xiidm"),
        action_file_path=str(actions),
        layout_path=str(grid_dir / "grid_layout.json"),
        **CONFIG_MINIMA,
    )
    recommender_service.reset()
    network_service.load_network(cfg.network_path)
    recommender_service.update_config(cfg)


def _step2_result(events):
    """Drain the step2 iterator; return the 'result' event payload."""
    out = {}
    for ev in events:
        if isinstance(ev, dict) and ev.get("type") == "result":
            out = ev
    return out


def _resolves(after_lines, new_overloads: set) -> bool:
    """An action resolves iff no contingency-attributable overload remains
    (base overloads it doesn't touch are ignored — the N-overload rule)."""
    return len(set(after_lines or []) & new_overloads) == 0


def _classify(step2: dict, new_overloads: set) -> tuple[str, dict]:
    actions = step2.get("actions") or {}
    combined = step2.get("combined_actions") or {}
    best_unitary = None
    for aid, a in actions.items():
        if a.get("non_convergence"):
            continue
        if _resolves(a.get("lines_overloaded_after"), new_overloads):
            return "easy", {"kind": "unitary", "action": aid,
                            "max_rho": a.get("max_rho")}
        if best_unitary is None or (a.get("max_rho", 9e9) < best_unitary[1]):
            best_unitary = (aid, a.get("max_rho", 9e9))
    for pid, p in combined.items():
        if p.get("is_islanded") or p.get("non_convergence"):
            continue
        if _resolves(p.get("lines_overloaded_after"), new_overloads) or \
                (p.get("is_rho_reduction") and float(p.get("max_rho", 9e9)) <= 1.0):
            return "medium", {"kind": "pair", "action": pid,
                              "max_rho": p.get("max_rho")}
    return "hard", {"kind": "none", "best_unitary": best_unitary,
                    "n_actions": len(actions), "n_pairs": len(combined)}


def grade_contingency(cont: dict) -> dict:
    cid = cont.get("tripped_line") or cont.get("contingency_id")
    rec = dict(contingency_id=cid)
    t0 = time.time()
    try:
        step1 = recommender_service.run_analysis_step1([cid])
    except Exception as ex:  # noqa: BLE001
        rec.update(difficulty="non_converged", error=f"step1:{type(ex).__name__}",
                   t_step1=round(time.time() - t0, 2))
        return rec
    t_s1 = time.time() - t0
    overloads = step1.get("lines_overloaded", []) or []
    can_proceed = bool(step1.get("can_proceed"))
    rec.update(n_overloads=len(overloads), can_proceed=can_proceed, t_step1=round(t_s1, 2))
    if not can_proceed or not overloads:
        rec["difficulty"] = "trivial"
        return rec
    t1 = time.time()
    try:
        res = _step2_result(recommender_service.run_analysis_step2(overloads, overloads))
    except Exception as ex:  # noqa: BLE001
        rec.update(difficulty="non_converged", error=f"step2:{type(ex).__name__}",
                   t_step2=round(time.time() - t1, 2))
        return rec
    rec["t_step2"] = round(time.time() - t1, 2)
    rec["n_actions"] = len(res.get("actions") or {})
    difficulty, solution = _classify(res, set(overloads))
    rec["difficulty"] = difficulty
    rec["solution"] = solution
    return rec


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("grid")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--time", action="store_true", help="timing dump, don't persist")
    args = ap.parse_args()
    grid_dir = DATA / "grids" / args.grid
    n1 = json.loads((grid_dir / "n1_contingencies.json").read_text())
    conts = [c for c in n1.get("contingencies", []) if not c.get("antenna")]
    if args.limit:
        conts = conts[: args.limit]
    print(f"[grade] {args.grid}: {len(conts)} non-antenna constraining contingencies")
    configure(grid_dir)
    print("[grade] recommender configured OK")
    graded_path = grid_dir / "graded.jsonl"
    done = set()
    if graded_path.exists() and not args.time:
        for line in graded_path.read_text().splitlines():
            if line.strip():
                done.add(json.loads(line)["contingency_id"])
    t0 = time.time()
    for i, cont in enumerate(conts):
        cid = cont.get("tripped_line") or cont.get("contingency_id")
        if cid in done:
            continue
        rec = grade_contingency(cont)
        if not args.time:
            with graded_path.open("a") as f:
                f.write(json.dumps(rec) + "\n")
        print(f"  [{i+1}/{len(conts)}] {cid}: {rec}")
    print(f"[grade] {len(conts)} contingencies in {time.time()-t0:.0f}s "
          f"({(time.time()-t0)/max(1,len(conts)):.1f}s each)")


if __name__ == "__main__":
    main()
