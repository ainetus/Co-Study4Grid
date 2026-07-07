#!/usr/bin/env python3
# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0

"""Full "Analyze & Suggest" benchmark for a Game Mode study.

Drives the exact code path the Game Mode UI runs for one study —
``POST /api/config`` → ``/api/run-analysis-step1`` → ``/api/run-analysis-step2``
(streaming NDJSON) — through the FastAPI ``TestClient`` (in-process, no port),
and reports the **same per-stage breakdown the UI shows** in its
"Execution time breakdown" tooltip:

    Step 1 (contingency simulation) ... step1_time
    Overflow analysis ................. overflow_graph_time
    Action prediction ................. action_prediction_time
    Action assessment ................. assessment_time   (per-action reassessment)
    Enrichment / post-process ......... enrichment_time
    Other (network / streaming) ....... wall − sum(the five above)
    Total (wall-clock, click → display) wall

Unlike the UI, it further **decomposes "Other"** into the server-side pieces
that fall outside the reported stages (discovery overhead = expert-rule filter
+ input building; result-payload ``sanitize_for_json``; NDJSON size), so a
regression there can be attributed instead of hiding in a single bucket.

This is the case the perf work targets: the Game "first scenario" run that
regressed from ~30 s to ~75 s on the 2-vCPU HuggingFace Space. Use it to:

- confirm the per-action reassessment goes **serial** on a CPU-limited host
  (``--serial`` forces it; the tail line reports workers / effective cores);
- compare parallel vs serial assessment (``--compare``);
- watch the "Other" residual after a serialization / filtering change.

Usage (from the repo root, backend venv active)::

    python benchmarks/bench_analyze_suggest.py                 # medium tier, first study
    python benchmarks/bench_analyze_suggest.py --tier high     # French grid, first study
    python benchmarks/bench_analyze_suggest.py --study s3      # a specific study id
    python benchmarks/bench_analyze_suggest.py --serial        # force serial reassessment
    python benchmarks/bench_analyze_suggest.py --compare       # parallel vs serial, same case

Path overrides (when the study's grid is not on disk — e.g. the medium/European
grid ships as a Git-LFS ``network.xiidm.zip`` that must be pulled first)::

    BENCH_NETWORK_PATH=data/pypsa_eur_fr225_400/network.xiidm \\
    BENCH_ACTION_FILE=data/pypsa_eur_fr225_400/actions.json \\
    BENCH_LAYOUT=data/pypsa_eur_fr225_400/grid_layout.json \\
    BENCH_CONTINGENCY=way_109818602-225 \\
    python benchmarks/bench_analyze_suggest.py
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path
from typing import Any

_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

# ---------------------------------------------------------------------------
# Study presets — a Python mirror of the two tiers in
# `frontend/src/game/presets.ts` (kept in sync). The default is the medium
# tier's FIRST study, matching the Game Config screen's default and the case
# the perf regression was reported on. The medium/European grid ships as a
# Git-LFS zip; if it is not pulled, pass --tier high (the French grid ships
# uncompressed) or set the BENCH_* path overrides.
# ---------------------------------------------------------------------------
_EUR = {
    "network": "data/pypsa_eur_eur220_225_380_400/network.xiidm",
    "actions": "data/pypsa_eur_eur220_225_380_400/actions.json",
    "layout": "data/pypsa_eur_eur220_225_380_400/grid_layout.json",
}
_FR = {
    "network": "data/pypsa_eur_fr225_400/network.xiidm",
    "actions": "data/pypsa_eur_fr225_400/actions.json",
    "layout": "data/pypsa_eur_fr225_400/grid_layout.json",
}

TIERS: dict[str, dict[str, Any]] = {
    "medium": {
        "paths": _EUR,
        "studies": [
            {"id": "eu-pyrenees", "label": "Pyrenees 225 kV — LANNEL61PRAGN",
             "contingency": "relation_8423570-225"},
            {"id": "eu-italy", "label": "Campania 380 kV — Santa Sofia",
             "contingency": "relation_13164355-380"},
            {"id": "eu-spain", "label": "Hinojosa 400 kV double line",
             "contingency": "way_170479605-400"},
        ],
    },
    "high": {
        "paths": _FR,
        "studies": [
            {"id": "s1", "label": "Toulouse 225 kV — Saint-Orens - Verfeil",
             "contingency": "way_109818602-225"},
            {"id": "s2", "label": "Biancon 225 kV — way/121500507",
             "contingency": "way_121500507-225"},
            {"id": "s3", "label": "Valence 225 kV — B.MONL61VALE8",
             "contingency": "relation_6028666_c-225"},
            {"id": "s4", "label": "Breuil 225 kV — BREUIL63CHAST",
             "contingency": "relation_8307566_d-225"},
            {"id": "s5", "label": "way/1463717755 225 kV",
             "contingency": "way_1463717755-225"},
            {"id": "s6", "label": "Échalas 225 kV — Échalas - Le Soleil",
             "contingency": "way_130969307-225"},
            {"id": "s7", "label": "Génissiat 400 kV — Cornier - Génissiat",
             "contingency": "merged_way_100497456-400_1"},
            {"id": "s8", "label": "Villejust 225 kV — Liers - Villejust",
             "contingency": "way_204035714-225"},
        ],
    },
}

# Recommender config mirrors config.default.json (the bundled first-run
# settings the HuggingFace Space boots with).
CONFIG_MINIMA = {
    "min_line_reconnections": 2.0,
    "min_close_coupling": 3.0,
    "min_open_coupling": 2.0,
    "min_line_disconnections": 3.0,
    "min_pst": 1.0,
    "min_load_shedding": 2.0,
    "min_renewable_curtailment_actions": 2,
    "min_redispatch": 2,
    "n_prioritized_actions": 15,
    "monitoring_factor": 0.95,
    "pre_existing_overload_threshold": 0.02,
    "ignore_reconnections": False,
    "pypowsybl_fast_mode": True,
}


def _resolve_case(args) -> tuple[dict, dict]:
    """Return ``(paths, study)`` after applying tier/study selection + env
    overrides."""
    tier = TIERS[args.tier]
    paths = dict(tier["paths"])
    studies = tier["studies"]
    if args.study:
        match = [s for s in studies if s["id"] == args.study]
        if not match:
            raise SystemExit(
                f"study '{args.study}' not in tier '{args.tier}'. "
                f"Available: {', '.join(s['id'] for s in studies)}"
            )
        study = dict(match[0])
    else:
        study = dict(studies[0])

    # Env overrides let the benchmark run when a study's grid is not on disk.
    paths["network"] = os.environ.get("BENCH_NETWORK_PATH", paths["network"])
    paths["actions"] = os.environ.get("BENCH_ACTION_FILE", paths["actions"])
    paths["layout"] = os.environ.get("BENCH_LAYOUT", paths["layout"])
    study["contingency"] = os.environ.get("BENCH_CONTINGENCY", study["contingency"])
    return paths, study


class _Instrument:
    """Monkeypatches that attribute the server-side share of "Other".

    - ``sanitize_for_json`` (result-payload coercion at the NDJSON yield)
    - ``run_analysis_step2_discovery`` wall time (so the discovery overhead —
      expert-rule filter + recommender-input build, which is NOT part of the
      reported prediction / assessment split — can be isolated).
    """

    def __init__(self):
        self.sanitize_s = 0.0
        self.discovery_wall_s = 0.0
        self._patches = []

    def __enter__(self):
        # The model-aware step2 generator lives on AnalysisMixin (explicit
        # composition since the 2026-07 D1 revision), so both patches
        # target the analysis_mixin module namespace.
        from expert_backend.services import analysis_mixin as am
        si = am

        orig_sanitize = si.sanitize_for_json

        def timed_sanitize(obj):
            t0 = time.perf_counter()
            try:
                return orig_sanitize(obj)
            finally:
                self.sanitize_s += time.perf_counter() - t0

        orig_disc = am.run_analysis_step2_discovery

        def timed_discovery(*a, **kw):
            t0 = time.perf_counter()
            try:
                return orig_disc(*a, **kw)
            finally:
                self.discovery_wall_s += time.perf_counter() - t0

        si.sanitize_for_json = timed_sanitize
        am.run_analysis_step2_discovery = timed_discovery
        self._patches = [
            (si, "sanitize_for_json", orig_sanitize),
            (am, "run_analysis_step2_discovery", orig_disc),
        ]
        return self

    def __exit__(self, *exc):
        for mod, name, orig in self._patches:
            setattr(mod, name, orig)
        return False


def run_once(client, paths, study, reset_between=True) -> dict:
    """Drive config→step1→step2 for one study; return a metrics dict."""
    cfg = {
        "network_path": paths["network"],
        "action_file_path": paths["actions"],
        "layout_path": paths["layout"],
        "model": "expert",
        "compute_overflow_graph": True,
        **CONFIG_MINIMA,
    }
    t_cfg = time.perf_counter()
    r = client.post("/api/config", json=cfg)
    r.raise_for_status()
    t_cfg = time.perf_counter() - t_cfg

    contingency = study["contingency"]
    t_s1 = time.perf_counter()
    r = client.post("/api/run-analysis-step1",
                    json={"disconnected_elements": [contingency]})
    r.raise_for_status()
    t_s1 = time.perf_counter() - t_s1
    step1 = r.json()
    overloads = step1.get("lines_overloaded", [])
    if not (step1.get("can_proceed") and overloads):
        return {"error": f"no actionable overload (can_proceed={step1.get('can_proceed')}, "
                         f"{len(overloads)} overload(s))"}

    with _Instrument() as inst:
        t_s2 = time.perf_counter()
        r = client.post("/api/run-analysis-step2",
                        json={"selected_overloads": overloads, "all_overloads": overloads})
        r.raise_for_status()
        payload_text = r.text
        t_s2 = time.perf_counter() - t_s2

    result = {}
    for line in payload_text.splitlines():
        line = line.strip()
        if not line:
            continue
        ev = json.loads(line)
        if ev.get("type") == "result":
            result = ev
        elif ev.get("type") == "error":
            return {"error": ev.get("message")}

    # Per-stage timings reported by the backend (the UI tooltip buckets).
    step1_t = result.get("step1_time") or 0.0
    overflow_t = result.get("overflow_graph_time") or 0.0
    prediction_t = result.get("action_prediction_time") or 0.0
    assessment_t = result.get("assessment_time") or 0.0
    enrichment_t = result.get("enrichment_time") or 0.0
    backend_sum = step1_t + overflow_t + prediction_t + assessment_t + enrichment_t

    # Wall-clock "click → display" proxy: step1 + step2 request wall time.
    wall = t_s1 + t_s2
    other = max(0.0, wall - backend_sum)
    discovery_overhead = max(0.0, inst.discovery_wall_s - prediction_t - assessment_t)

    reassess = result.get("reassessment_parallelism")
    if reassess is None:
        from expert_backend.services.recommender_service import recommender_service
        reassess = (getattr(recommender_service, "_last_result", None) or {}).get(
            "reassessment_parallelism")

    return {
        "n_actions": len(result.get("actions", {})),
        "n_overloads": len(overloads),
        "payload_bytes": len(payload_text),
        "t_config": t_cfg,
        "t_step1_http": t_s1,
        "t_step2_http": t_s2,
        "wall": wall,
        "step1": step1_t,
        "overflow": overflow_t,
        "prediction": prediction_t,
        "assessment": assessment_t,
        "enrichment": enrichment_t,
        "backend_sum": backend_sum,
        "other": other,
        "other_discovery_overhead": discovery_overhead,
        "other_sanitize": inst.sanitize_s,
        "other_residual": max(0.0, other - discovery_overhead - inst.sanitize_s),
        "reassessment": reassess,
    }


def _fmt(s: float) -> str:
    return f"{s:6.2f}s"


def _print_breakdown(m: dict, title: str) -> None:
    if "error" in m:
        print(f"\n{title}: SKIPPED — {m['error']}")
        return
    total = m["wall"]

    def pct(x):
        return f"{100 * x / total:4.0f}%" if total else "   -"
    print(f"\n=== {title} ===")
    print(f"  actions={m['n_actions']}  overloads={m['n_overloads']}  "
          f"payload={m['payload_bytes'] / 1024:.0f} KiB  config-load={_fmt(m['t_config'])}")
    print(f"  {'Step 1 (contingency simulation)':<34} {_fmt(m['step1'])}  {pct(m['step1'])}")
    print(f"  {'Overflow analysis':<34} {_fmt(m['overflow'])}  {pct(m['overflow'])}")
    print(f"  {'Action prediction':<34} {_fmt(m['prediction'])}  {pct(m['prediction'])}")
    print(f"  {'Action assessment (reassessment)':<34} {_fmt(m['assessment'])}  {pct(m['assessment'])}")
    print(f"  {'Enrichment / post-process':<34} {_fmt(m['enrichment'])}  {pct(m['enrichment'])}")
    print(f"  {'Other (network / streaming)':<34} {_fmt(m['other'])}  {pct(m['other'])}")
    print(f"    ├─ {'discovery overhead (filter+inputs)':<29} {_fmt(m['other_discovery_overhead'])}")
    print(f"    ├─ {'result sanitize_for_json':<29} {_fmt(m['other_sanitize'])}")
    print(f"    └─ {'transport / frontend residual':<29} {_fmt(m['other_residual'])}")
    print(f"  {'─' * 46}")
    print(f"  {'Total (wall-clock, click → display)':<34} {_fmt(total)}")
    if m.get("reassessment"):
        ra = m["reassessment"]
        mode = "parallel" if ra.get("parallel") else "serial"
        print(f"  reassessment: {mode} — {ra.get('workers')} worker(s) / "
              f"{ra.get('cores_available')} effective core(s), "
              f"{ra.get('n_actions')} action(s)")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--tier", choices=list(TIERS), default="medium",
                    help="difficulty tier (default: medium = European grid)")
    ap.add_argument("--study", default=None,
                    help="study id within the tier (default: first study)")
    ap.add_argument("--reps", type=int, default=1,
                    help="repetitions (median reported); a fresh config load per rep")
    ap.add_argument("--serial", action="store_true",
                    help="force serial per-action reassessment (EXPERT_OP4GRID_REASSESSMENT_PARALLEL=0)")
    ap.add_argument("--compare", action="store_true",
                    help="run the same case twice — parallel then serial — and print both")
    args = ap.parse_args()

    os.chdir(_REPO_ROOT)
    from fastapi.testclient import TestClient

    from expert_backend.main import app
    from expert_op4grid_recommender import config as eo_config

    paths, study = _resolve_case(args)
    net_ok = Path(paths["network"]).is_file() and Path(paths["network"]).stat().st_size > 1024
    print(f"Case: tier={args.tier} study={study['id']} ({study['label']})")
    print(f"  network={paths['network']}  contingency={study['contingency']}")
    if not net_ok:
        print(f"\nWARNING: {paths['network']} is missing or a Git-LFS pointer.\n"
              f"  Pull LFS (git lfs pull) or use --tier high / the BENCH_* path overrides.")

    def _run(force_serial: bool, label: str) -> dict:
        eo_config.REASSESSMENT_PARALLEL = False if force_serial else None
        samples = []
        with TestClient(app) as client:
            for _ in range(max(1, args.reps)):
                samples.append(run_once(client, paths, study))
        ok = [s for s in samples if "error" not in s]
        if not ok:
            return samples[0]
        ok.sort(key=lambda s: s["wall"])
        return ok[len(ok) // 2]  # median by wall-clock

    if args.compare:
        _print_breakdown(_run(False, "parallel"), "PARALLEL (auto)")
        _print_breakdown(_run(True, "serial"), "SERIAL (forced)")
    else:
        _print_breakdown(_run(args.serial, "run"),
                         f"{'SERIAL (forced)' if args.serial else 'AUTO'}")


if __name__ == "__main__":
    main()
