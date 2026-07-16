# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0
# This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface.
"""Codabench scoring program — the in-repo Python twin of the frontend scorer.

This is the SINGLE authoritative Python implementation of the Game Mode score,
kept numerically identical to ``frontend/src/game/scoring.ts``. Both are pinned
to the shared golden fixture ``scripts/game_mode/scoring_golden.json``:
``scripts/game_mode/test_score.py`` (Python) and ``scoring.test.ts`` (frontend)
each assert their output against that one fixture, so a change to either scorer
that breaks cross-language parity fails a test.

Per study (0..100), mirroring scoring.ts::

    physical = 60 * remediationFraction
    actions  = 25 * remediationFraction * actionEfficiency
    time     = 15 * remediationFraction * timeEfficiency

Session score = mean of per-study totals.

Codabench entry points consumed by ``scripts/game_mode/e2e_game_session.py``:
``apply_reference(session, reference)`` and ``score_study(study)``.
"""

WEIGHTS = {"physical": 60, "actions": 25, "time": 15}


def _clamp01(x):
    return max(0.0, min(1.0, x))


def remediation_fraction(s):
    """Fraction of the overload removed. 1.0 == worst line back under 100 %."""
    final = s.get("finalMaxRho")
    if final is None:
        return 0.0
    if s.get("solved") or final < 1.0:
        return 1.0
    baseline = s.get("baselineMaxRho")
    if baseline is None or baseline <= 1.0:
        return 1.0 if s.get("solved") else 0.0
    # Linear credit for partial relief between baseline and the 100 % target.
    return _clamp01((baseline - final) / (baseline - 1.0))


def action_efficiency(s):
    """Rewards using fewer of the allowed actions."""
    num = s.get("numActions", 0)
    if num < 1:
        return 0.0
    span = max(1, s.get("maxActions", 1))
    return _clamp01(1 - (num - 1) / span)


def time_efficiency(s):
    """Rewards finishing well within the time limit."""
    limit_ms = s.get("timeLimitSeconds", 0) * 1000
    if limit_ms <= 0:
        return 0.0
    return _clamp01(1 - s.get("durationMs", 0) / limit_ms)


def score_study(s):
    frac = remediation_fraction(s)
    physical = WEIGHTS["physical"] * frac
    actions = WEIGHTS["actions"] * frac * action_efficiency(s)
    time = WEIGHTS["time"] * frac * time_efficiency(s)
    return {
        "studyId": s.get("studyId"),
        "label": s.get("label"),
        "physical": physical,
        "actions": actions,
        "time": time,
        "total": physical + actions + time,
        "remediationFraction": frac,
        "solved": bool(s.get("solved")),
    }


def score_session(session):
    per_study = [score_study(s) for s in session.get("studies", [])]
    n = len(per_study)
    final = sum(p["total"] for p in per_study) / n if n else 0.0
    return {
        "finalScore": final,
        "solvedCount": sum(1 for s in session.get("studies", []) if s.get("solved")),
        "nStudies": n,
        "perStudy": per_study,
    }


def apply_reference(session, reference):
    """Overlay trusted per-study reference values onto the self-reported session.

    The exported session log carries player-reported ``baselineMaxRho`` /
    ``finalMaxRho`` / ``solved``; a Codabench competition ships a trusted
    ``reference.json`` so the public ranking scores trusted numbers rather than
    self-reported ones. When ``reference`` is falsy (no reference data), this is
    a no-op and the self-reported numbers are scored as-is. Mutates ``session``
    in place and returns it.
    """
    if not reference:
        return session
    ref_by_id = {r.get("studyId"): r for r in reference.get("studies", [])}
    for s in session.get("studies", []):
        r = ref_by_id.get(s.get("studyId"))
        if not r:
            continue
        for key in ("baselineMaxRho", "finalMaxRho", "solved"):
            if key in r:
                s[key] = r[key]
    return session
