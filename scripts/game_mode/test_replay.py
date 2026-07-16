# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0
# This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface.
"""Hermetic guard for the Game Mode session-log replay (FU-2).

Exercises the replay MACHINERY in scripts/game_mode/e2e_game_session.py —
action lookup, fallback to /api/simulate-manual-action, min-rho aggregation,
divergence detection, and the reference.json shape — against a FAKE backend
client returning canned responses. No FastAPI, pypowsybl, or grid data, so it
runs in CI from a fresh clone. The real-backend replay stays in the e2e lane
(`e2e_game_session.py --replay <session.json>`).
"""
import importlib.util
import json
import os

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))


def _load_e2e():
    spec = importlib.util.spec_from_file_location(
        "e2e_game_session", os.path.join(HERE, "e2e_game_session.py")
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _load_scorer():
    spec = importlib.util.spec_from_file_location(
        "score", os.path.join(HERE, "scoring_program", "score.py")
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture(scope="module")
def e2e():
    return _load_e2e()


@pytest.fixture(scope="module")
def score():
    return _load_scorer()


class FakeResponse:
    def __init__(self, *, json_body=None, text="", status_code=200):
        self._json = json_body
        self.text = text
        self.status_code = status_code

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def json(self):
        return self._json


class FakeClient:
    """Canned backend: one N-1 with two prioritized actions.

    - ``a_solve``  → max_rho 0.85, no residual overloads (a full solve)
    - ``a_partial``→ max_rho 1.10, one residual overload
    - ``a_manual`` → NOT in the step-2 set; only reachable via the
      /api/simulate-manual-action fallback (returns max_rho 0.95).
    Any other simulate target 404s (missing action).
    """

    STEP2_ACTIONS = {
        "a_solve": {
            "description_unitaire": "Solve action",
            "rho_before": [1.4, 1.2], "max_rho": 0.85, "lines_overloaded_after": [],
        },
        "a_partial": {
            "description_unitaire": "Partial action",
            "rho_before": [1.4, 1.2], "max_rho": 1.10, "lines_overloaded_after": ["L9"],
        },
    }

    def __init__(self):
        self.calls = []

    def post(self, url, json=None):  # noqa: A002 - mirror requests' kwarg name
        self.calls.append(url)
        if url == "/api/config":
            return FakeResponse(json_body={"ok": True})
        if url == "/api/run-analysis-step1":
            return FakeResponse(json_body={
                "lines_overloaded": ["L9", "L12"], "can_proceed": True,
            })
        if url == "/api/run-analysis-step2":
            ndjson = "\n".join([
                json_dumps({"type": "pdf", "pdf_url": "x"}),
                json_dumps({"type": "result", "actions": self.STEP2_ACTIONS}),
            ])
            return FakeResponse(text=ndjson)
        if url == "/api/simulate-manual-action":
            aid = json.get("action_id")
            if aid == "a_manual":
                return FakeResponse(json_body={
                    "max_rho": 0.95, "lines_overloaded_after": [],
                })
            return FakeResponse(json_body={"detail": "unknown"}, status_code=404)
        raise AssertionError(f"unexpected url {url}")


def json_dumps(obj):
    return json.dumps(obj)


def _recorded(action_ids, *, final, baseline=1.4, solved=True):
    return {
        "studyId": "s1", "label": "Study 1",
        "contingencyElementId": "ctg1", "contingencyLabel": "Ctg 1",
        "actionsChosen": [{"actionId": a, "maxRho": None, "solved": False} for a in action_ids],
        "numActions": len(action_ids),
        "baselineMaxRho": baseline, "finalMaxRho": final, "solved": solved,
    }


def test_replay_matches_faithful_report(e2e):
    # Player reported the solve action's true number → replay agrees.
    recorded = _recorded(["a_solve"], final=0.85, baseline=1.4, solved=True)
    ref, div = e2e.replay_study(FakeClient(), recorded, "net", "act", "", 0.05)
    assert ref == {
        "studyId": "s1", "baselineMaxRho": 1.4, "finalMaxRho": 0.85, "solved": True,
    }
    assert div["ok"] is True
    assert div["fields"]["finalMaxRho"]["match"] is True
    assert div["missingActions"] == []


def test_replay_takes_best_of_multiple_actions(e2e):
    # Both actions chosen: trusted finalMaxRho is the MIN (best remediation).
    recorded = _recorded(["a_partial", "a_solve"], final=0.85, solved=True)
    ref, div = e2e.replay_study(FakeClient(), recorded, "net", "act", "", 0.05)
    assert ref["finalMaxRho"] == 0.85
    assert ref["solved"] is True
    assert div["ok"] is True


def test_replay_flags_inflated_self_report(e2e):
    # Player claims 0.80 but the only chosen action truly yields 1.10 → diverges,
    # and the trusted solve flag flips to False.
    recorded = _recorded(["a_partial"], final=0.80, baseline=1.4, solved=True)
    ref, div = e2e.replay_study(FakeClient(), recorded, "net", "act", "", 0.05)
    assert ref["finalMaxRho"] == 1.10
    assert ref["solved"] is False
    assert div["ok"] is False
    assert div["fields"]["finalMaxRho"]["match"] is False
    assert div["fields"]["solved"]["match"] is False


def test_replay_falls_back_to_manual_simulation(e2e):
    # a_manual is not in the step-2 set → replay_action must reach for
    # /api/simulate-manual-action and still derive a trusted number.
    client = FakeClient()
    recorded = _recorded(["a_manual"], final=0.95, solved=True)
    ref, div = e2e.replay_study(client, recorded, "net", "act", "", 0.05)
    assert ref["finalMaxRho"] == 0.95
    assert "/api/simulate-manual-action" in client.calls
    assert div["ok"] is True
    assert div["missingActions"] == []


def test_replay_reports_unreproducible_action(e2e):
    # An action the backend can neither prioritize nor simulate is flagged
    # missing and forces a divergence even if the numbers happen to align.
    recorded = _recorded(["ghost"], final=None, baseline=1.4, solved=False)
    ref, div = e2e.replay_study(FakeClient(), recorded, "net", "act", "", 0.05)
    assert ref["finalMaxRho"] is None
    assert div["missingActions"] == ["ghost"]
    assert div["ok"] is False


def test_replay_within_tolerance_is_ok(e2e):
    # Reported 0.88 vs replayed 0.85 — inside the 0.05 tolerance band.
    recorded = _recorded(["a_solve"], final=0.88, baseline=1.42, solved=True)
    ref, div = e2e.replay_study(FakeClient(), recorded, "net", "act", "", 0.05)
    assert div["fields"]["finalMaxRho"]["match"] is True
    assert div["fields"]["baselineMaxRho"]["match"] is True
    assert div["ok"] is True


def test_reference_entry_feeds_apply_reference(e2e, score):
    # The reference.json the replay emits must be consumable by the scorer's
    # apply_reference(), overriding the self-reported numbers end to end.
    recorded = _recorded(["a_partial"], final=0.5, baseline=1.4, solved=True)
    ref_entry, _ = e2e.replay_study(FakeClient(), recorded, "net", "act", "", 0.05)
    session = {"studies": [dict(recorded, numActions=1, maxActions=3,
                                timeLimitSeconds=300, durationMs=30000)]}
    score.apply_reference(session, {"studies": [ref_entry]})
    # Trusted numbers now scored: the inflated "solved" self-report is corrected.
    assert session["studies"][0]["finalMaxRho"] == 1.10
    assert session["studies"][0]["solved"] is False
    assert score.score_study(session["studies"][0])["remediationFraction"] < 1.0


def test_replay_session_aggregates_divergences(e2e):
    session = {"studies": [
        _recorded(["a_solve"], final=0.85, solved=True),
        dict(_recorded(["a_partial"], final=0.80, solved=True), studyId="s2"),
    ]}
    reference, divergences = e2e.replay_session(
        FakeClient(), session, "net", "act", "", 0.05,
    )
    assert len(reference["studies"]) == 2
    assert [d["ok"] for d in divergences] == [True, False]
    # reference is serialisable (it is written to disk as reference.json).
    assert json.loads(json.dumps(reference))["studies"][0]["studyId"] == "s1"
