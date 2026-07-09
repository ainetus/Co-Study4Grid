# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0
# This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface.
"""Regenerate the shared scoring golden fixture (scripts/game_mode/scoring_golden.json).

The fixture is the cross-language parity contract for the Game Mode scorer: the
Python twin (scoring_program/score.py, via test_score.py) and the frontend
scorer (scoring.ts, via scoring.test.ts) both assert their output against it.

The INPUT studies below are hand-authored to cover the scorer branches (solved,
partial relief, no improvement, null-final, time/action-efficiency clamps); the
EXPECTED values are computed by score.py so the two never drift. Run this after a
deliberate scorer change, then review the diff and update scoring.ts to match.

    python scripts/game_mode/gen_scoring_golden.py
"""
import importlib.util
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
GOLDEN = os.path.join(HERE, "scoring_golden.json")


def _load_scorer():
    spec = importlib.util.spec_from_file_location(
        "score", os.path.join(HERE, "scoring_program", "score.py")
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# Hand-authored inputs covering every scorer branch.
STUDY_INPUTS = [
    ("solved-1action-fast",
     {"studyId": "A", "label": "A", "finalMaxRho": 0.8, "solved": True,
      "baselineMaxRho": 1.5, "numActions": 1, "maxActions": 3,
      "timeLimitSeconds": 300, "durationMs": 60000}),
    ("partial-2actions-mid",
     {"studyId": "B", "label": "B", "finalMaxRho": 1.2, "solved": False,
      "baselineMaxRho": 1.6, "numActions": 2, "maxActions": 3,
      "timeLimitSeconds": 300, "durationMs": 150000}),
    ("no-improvement-3actions",
     {"studyId": "C", "label": "C", "finalMaxRho": 1.7, "solved": False,
      "baselineMaxRho": 1.5, "numActions": 3, "maxActions": 3,
      "timeLimitSeconds": 300, "durationMs": 290000}),
    ("no-action-null-final",
     {"studyId": "D", "label": "D", "finalMaxRho": None, "solved": False,
      "baselineMaxRho": 1.5, "numActions": 0, "maxActions": 3,
      "timeLimitSeconds": 300, "durationMs": 300000}),
    ("solved-timedout-timeeff-clamp",
     {"studyId": "E", "label": "E", "finalMaxRho": 0.95, "solved": True,
      "baselineMaxRho": 1.3, "numActions": 3, "maxActions": 3,
      "timeLimitSeconds": 200, "durationMs": 250000}),
]

_STUDY_KEYS = ("physical", "actions", "time", "total", "remediationFraction", "solved")


def build_fixture(score):
    studies = []
    for name, inp in STUDY_INPUTS:
        r = score.score_study(inp)
        studies.append({"name": name, "input": inp,
                        "expected": {k: r[k] for k in _STUDY_KEYS}})
    sess_input = {"studies": [STUDY_INPUTS[0][1], STUDY_INPUTS[1][1]]}
    ss = score.score_session(sess_input)
    sessions = [{
        "name": "two-study-session",
        "input": sess_input,
        "expected": {"finalScore": ss["finalScore"],
                     "solvedCount": ss["solvedCount"],
                     "nStudies": ss["nStudies"]},
    }]
    return {
        "_comment": (
            "Shared cross-language parity fixture for the Game Mode scorer (D8). "
            "Both scripts/game_mode/scoring_program/score.py (via test_score.py) "
            "and frontend/src/game/scoring.ts (via scoring.test.ts) assert their "
            "output against these expected values, locking numerical parity. "
            "Regenerate with: python scripts/game_mode/gen_scoring_golden.py"
        ),
        "studies": studies,
        "sessions": sessions,
    }


def main():
    fixture = build_fixture(_load_scorer())
    with open(GOLDEN, "w", encoding="utf-8") as fh:
        json.dump(fixture, fh, indent=2)
        fh.write("\n")
    print(f"Wrote {GOLDEN}")


if __name__ == "__main__":
    main()
