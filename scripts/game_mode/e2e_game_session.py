#!/usr/bin/env python3
# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# SPDX-License-Identifier: MPL-2.0
"""End-to-end Game Mode check: drive the real backend, produce a game session
log, and score it with the Codabench scoring program.

This mirrors what the Co-Study4Grid Game Mode UI does for each study, but from
Python against the live FastAPI app (via TestClient — no port needed):

    POST /api/config            (load network + action catalogue)
    POST /api/run-analysis-step1 (detect the N-1 overloads)
    POST /api/run-analysis-step2 (stream prioritized remedial actions)

It then plays a simple "greedy operator": pick the (≤ maxActions) actions with
the lowest resulting max-rho, assemble a `game_session.json` in the exact schema
the UI exports, and run the Codabench scorer on it.

Usage:
    python3 scripts/game_mode/e2e_game_session.py
    python3 scripts/game_mode/e2e_game_session.py --max-studies 1 --out /tmp/sess.json
    python3 scripts/game_mode/e2e_game_session.py --grid small
"""
import argparse
import importlib.util
import json
import os
import sys
import time

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DEFAULT_SCORER = os.path.expanduser(
    "~/Dev/codabench/competitions/costudy4grid_game/scoring_program/score.py"
)
DEFAULT_REFERENCE = os.path.expanduser(
    "~/Dev/codabench/competitions/costudy4grid_game/reference_data/reference.json"
)

# Official preset studies (subset of frontend/src/game/presets.ts).
FR_NETWORK = "data/pypsa_eur_fr225_400/network.xiidm"
FR_ACTIONS = "data/pypsa_eur_fr225_400/actions.json"
FR_LAYOUT = "data/pypsa_eur_fr225_400/grid_layout.json"
# Curated solvable contingencies (can_proceed=True under the expert model) —
# kept in sync with frontend/src/game/presets.ts and the Codabench reference.
PRESET_STUDIES = [
    {"id": "s1", "label": "Toulouse 225 kV — Saint-Orens - Verfeil",
     "contingencyElementId": "way_109818602-225", "contingencyLabel": "Saint-Orens - Verfeil"},
    {"id": "s2", "label": "Biancon 225 kV — way/121500507",
     "contingencyElementId": "way_121500507-225", "contingencyLabel": "way/121500507"},
    {"id": "s3", "label": "Valence 225 kV — B.MONL61VALE8",
     "contingencyElementId": "relation_6028666_c-225", "contingencyLabel": "B.MONL61VALE8"},
    {"id": "s4", "label": "Breuil 225 kV — BREUIL63CHAST",
     "contingencyElementId": "relation_8307566_d-225", "contingencyLabel": "BREUIL63CHAST"},
    {"id": "s5", "label": "way/1463717755 225 kV",
     "contingencyElementId": "way_1463717755-225", "contingencyLabel": "way/1463717755"},
    {"id": "s6", "label": "Échalas 225 kV — Échalas - Le Soleil",
     "contingencyElementId": "way_130969307-225", "contingencyLabel": "Échalas - Le Soleil"},
    {"id": "s7", "label": "Génissiat 400 kV — Cornier - Génissiat",
     "contingencyElementId": "merged_way_100497456-400_1", "contingencyLabel": "Cornier - Génissiat"},
    {"id": "s8", "label": "Villejust 225 kV — Liers - Villejust",
     "contingencyElementId": "way_204035714-225", "contingencyLabel": "Liers - Villejust"},
]


def load_scorer(path):
    if not os.path.isfile(path):
        return None
    spec = importlib.util.spec_from_file_location("score", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def parse_ndjson(text):
    for line in text.splitlines():
        line = line.strip()
        if line:
            yield json.loads(line)


def play_study(client, study, network, actions, layout, time_limit, max_actions):
    """Drive config→step1→step2 for one study and return a GameStudyResult."""
    t0 = time.time()
    cfg = {
        "network_path": network,
        "action_file_path": actions,
        "layout_path": layout,
        "n_prioritized_actions": 10,
        "pypowsybl_fast_mode": True,
        "model": "expert",
        "compute_overflow_graph": True,
    }
    r = client.post("/api/config", json=cfg)
    r.raise_for_status()

    contingency = study["contingencyElementId"]
    r = client.post("/api/run-analysis-step1", json={"disconnected_elements": [contingency]})
    r.raise_for_status()
    step1 = r.json()
    overloads = step1.get("lines_overloaded", [])
    print(f"  step1: {len(overloads)} overload(s), can_proceed={step1.get('can_proceed')}")

    chosen = []
    baseline_max_rho = None
    final_max_rho = None
    if step1.get("can_proceed") and overloads:
        r = client.post("/api/run-analysis-step2", json={
            "selected_overloads": overloads, "all_overloads": overloads,
        })
        r.raise_for_status()
        actions_dict = {}
        for event in parse_ndjson(r.text):
            if event.get("type") == "result":
                actions_dict = event.get("actions", {})
            elif event.get("type") == "error":
                print(f"  step2 error: {event.get('message')}")
        print(f"  step2: {len(actions_dict)} prioritized action(s)")

        # Baseline worst loading: max rho_before across any action.
        for data in actions_dict.values():
            rb = data.get("rho_before") or []
            if rb:
                m = max(rb)
                baseline_max_rho = m if baseline_max_rho is None else max(baseline_max_rho, m)

        # Greedy "player": pick up to max_actions actions with the lowest
        # resulting max_rho (best remediation first).
        ranked = sorted(
            ((aid, d) for aid, d in actions_dict.items() if d.get("max_rho") is not None),
            key=lambda kv: kv[1]["max_rho"],
        )
        for aid, d in ranked[:max_actions]:
            after = d.get("lines_overloaded_after") or []
            mr = d.get("max_rho")
            solved = mr is not None and mr < 1.0 and len(after) == 0
            chosen.append({
                "actionId": aid,
                "description": d.get("description_unitaire"),
                "maxRho": mr,
                "linesOverloadedAfter": after,
                "solved": solved,
            })
            final_max_rho = mr if final_max_rho is None else min(final_max_rho, mr)

    duration_ms = int((time.time() - t0) * 1000)
    solved = final_max_rho is not None and final_max_rho < 1.0
    started = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(t0))
    return {
        "studyId": study["id"],
        "label": study["label"],
        "contingencyElementId": contingency,
        "contingencyLabel": study.get("contingencyLabel"),
        "startedAt": started + ".000Z",
        "endedAt": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + ".000Z",
        "durationMs": duration_ms,
        "timedOut": duration_ms > time_limit * 1000,
        "timeLimitSeconds": time_limit,
        "maxActions": max_actions,
        "actionsChosen": chosen,
        "numActions": len(chosen),
        "baselineMaxRho": baseline_max_rho,
        "finalMaxRho": final_max_rho,
        "solved": solved,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--grid", choices=["fr", "small"], default="fr")
    ap.add_argument("--max-studies", type=int, default=1)
    ap.add_argument("--max-actions", type=int, default=3)
    ap.add_argument("--time-limit", type=int, default=300)
    ap.add_argument("--out", default=os.path.join(REPO, "test-results", "e2e_game_session.json"))
    ap.add_argument("--scorer", default=DEFAULT_SCORER)
    args = ap.parse_args()

    os.chdir(REPO)
    sys.path.insert(0, REPO)
    from fastapi.testclient import TestClient
    from expert_backend.main import app

    if args.grid == "fr":
        network, actions, layout = FR_NETWORK, FR_ACTIONS, FR_LAYOUT
        studies = PRESET_STUDIES[: args.max_studies]
    else:
        network = "data/bare_env_small_grid_test/grid.xiidm"
        actions = "data/action_space/reduced_model_actions_test.json"
        layout = ""
        studies = [{"id": "small1", "label": "Small grid test", "contingencyElementId": "", "contingencyLabel": ""}]
        studies = studies[: args.max_studies]

    results = []
    with TestClient(app) as client:
        for i, study in enumerate(studies):
            print(f"[{i + 1}/{len(studies)}] {study['label']}")
            results.append(play_study(
                client, study, network, actions, layout,
                args.time_limit, args.max_actions,
            ))

    session = {
        "schemaVersion": "1.0",
        "sessionName": "E2E backend-driven session",
        "player": "e2e-greedy-bot",
        "startedAt": results[0]["startedAt"] if results else "",
        "endedAt": results[-1]["endedAt"] if results else "",
        "config": {"timerSeconds": args.time_limit, "maxActions": args.max_actions,
                   "nStudies": len(results)},
        "studies": results,
    }

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(session, fh, indent=2)
    print(f"\nWrote session log -> {args.out}")

    # Score it with the Codabench scoring program.
    scorer = load_scorer(args.scorer)
    if scorer is None:
        print(f"(scorer not found at {args.scorer} — skipping scoring)")
        return
    reference = None
    if os.path.isfile(DEFAULT_REFERENCE):
        with open(DEFAULT_REFERENCE, encoding="utf-8") as fh:
            reference = json.load(fh)
    scorer.apply_reference(session, reference)
    per_study = [scorer.score_study(s) for s in session["studies"]]
    n = len(per_study)
    final = sum(p["total"] for p in per_study) / n if n else 0.0
    solved = sum(1 for s in session["studies"] if s["solved"])
    print("=== Codabench score ===")
    print(json.dumps({
        "final_score": round(final, 4),
        "solved_count": solved,
        "n_studies": n,
        "per_study": [{"studyId": p["studyId"], "total": round(p["total"], 2),
                       "solved": p["solved"]} for p in per_study],
    }, indent=2))


if __name__ == "__main__":
    main()
