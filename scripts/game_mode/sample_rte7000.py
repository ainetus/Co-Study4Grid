#!/usr/bin/env python3
# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# SPDX-License-Identifier: MPL-2.0
"""Sample N scenarios of a chosen difficulty from the RTE7000 France THT graded
scenario database (``data/rte7000_tht/scenarios.json``).

Difficulty is the expert recommender's solvability at the 95 % monitoring factor:
  easy   - a suggested UNITARY action resolves the overloads;
  medium - no unitary resolves, but a first-identified COMBINATION does;
  hard   - neither a unitary nor a first combination resolves.

The output is a ``GameStudy[]`` list (the exact shape the Game Mode UI / backend
consume), so it can be dropped straight into a session config. Dates stay hidden:
titles carry only month + weekday + hour-period, and grids live under opaque ids.

Usage:
    python3 scripts/game_mode/sample_rte7000.py --difficulty easy --n 5
    python3 scripts/game_mode/sample_rte7000.py --difficulty hard --n 3 --seed 7 \
        --out /tmp/session_studies.json
"""
import argparse
import json
import os
import random

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DB = os.path.join(REPO, "data", "rte7000_tht", "scenarios.json")
DIFFICULTIES = ("easy", "medium", "hard")


def load_db(path=DB):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def to_game_study(s):
    """Project a DB scenario onto the GameStudy fields the UI/backend use.

    The ``solution`` field (reference remediation) is intentionally dropped — it
    is analysis metadata the player must not see.
    """
    return {
        "id": s["id"],
        "label": s["label"],
        "networkPath": s["networkPath"],
        "actionFilePath": s["actionFilePath"],
        "contingencyElementId": s["contingencyElementId"],
        "contingencyLabel": s.get("contingencyLabel"),
        "baselineMaxLoadingPct": s.get("baselineMaxLoadingPct"),
        "description": (f"{s['title']}. Loss of {s['contingencyLabel']} drives a worst-case "
                        f"{s.get('baselineMaxLoadingPct')}% line loading. Bring every monitored "
                        f"line back under the 95% monitoring limit."),
    }


def sample(difficulty, n, seed=None, db_path=DB, spread_grids=True):
    """Return up to ``n`` GameStudy dicts of ``difficulty``, sampled without
    replacement. With ``spread_grids`` we round-robin over distinct grids first so
    a small sample covers different operating points rather than one grid."""
    if difficulty not in DIFFICULTIES:
        raise ValueError(f"difficulty must be one of {DIFFICULTIES}, got {difficulty!r}")
    db = load_db(db_path)
    pool = [s for s in db["scenarios"] if s["difficulty"] == difficulty]
    rng = random.Random(seed)
    rng.shuffle(pool)
    if spread_grids:
        by_grid = {}
        for s in pool:
            by_grid.setdefault(s["gridId"], []).append(s)
        ordered, grids = [], list(by_grid.values())
        while any(grids):
            for g in grids:
                if g:
                    ordered.append(g.pop())
        pool = ordered
    return [to_game_study(s) for s in pool[:n]]


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--difficulty", choices=DIFFICULTIES, required=True)
    ap.add_argument("--n", type=int, default=5, help="number of scenarios to sample")
    ap.add_argument("--seed", type=int, default=None, help="RNG seed for reproducible draws")
    ap.add_argument("--db", default=DB, help="path to scenarios.json")
    ap.add_argument("--out", default=None, help="write the GameStudy[] JSON here (default: stdout)")
    args = ap.parse_args()

    db = load_db(args.db)
    counts = db.get("counts", {})
    studies = sample(args.difficulty, args.n, seed=args.seed, db_path=args.db)
    payload = json.dumps(studies, indent=2, ensure_ascii=False)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(payload)
        print(f"wrote {len(studies)} '{args.difficulty}' scenario(s) -> {args.out} "
              f"(pool: {counts.get(args.difficulty, 0)})")
    else:
        print(payload)


if __name__ == "__main__":
    main()
