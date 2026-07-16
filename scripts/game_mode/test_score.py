# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0
# This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface.
"""Pytest guard for the in-repo Codabench scorer (D8).

Pins scripts/game_mode/scoring_program/score.py to the shared golden fixture
scripts/game_mode/scoring_golden.json. The frontend's scoring.test.ts asserts
the SAME fixture, so together the two lock cross-language numerical parity: a
change to either scorer that breaks parity fails one of the two suites.

Hermetic (no network, no grid data) — safe to run in CI from a fresh clone.
"""
import importlib.util
import json
import os

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
GOLDEN = os.path.join(HERE, "scoring_golden.json")
TOL = 1e-6


def _load_scorer():
    spec = importlib.util.spec_from_file_location(
        "score", os.path.join(HERE, "scoring_program", "score.py")
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture(scope="module")
def score():
    return _load_scorer()


@pytest.fixture(scope="module")
def golden():
    with open(GOLDEN, encoding="utf-8") as fh:
        return json.load(fh)


def _assert_close(got, exp, label):
    for key, expected in exp.items():
        actual = got[key]
        if isinstance(expected, bool):
            assert actual == expected, f"{label}.{key}: {actual} != {expected}"
        else:
            assert abs(actual - expected) < TOL, (
                f"{label}.{key}: {actual} != {expected}"
            )


def test_study_scores_match_golden(score, golden):
    assert golden["studies"], "golden fixture has no study cases"
    for case in golden["studies"]:
        got = score.score_study(case["input"])
        _assert_close(got, case["expected"], case["name"])


def test_session_scores_match_golden(score, golden):
    assert golden["sessions"], "golden fixture has no session cases"
    for case in golden["sessions"]:
        got = score.score_session(case["input"])
        _assert_close(got, case["expected"], case["name"])


def test_apply_reference_overrides_self_reported_numbers(score):
    # A player-reported "solved" run whose trusted reference says otherwise:
    # apply_reference must overlay the trusted numbers before scoring.
    session = {"studies": [{
        "studyId": "X", "label": "X", "finalMaxRho": 0.5, "solved": True,
        "baselineMaxRho": 1.5, "numActions": 1, "maxActions": 3,
        "timeLimitSeconds": 300, "durationMs": 30000,
    }]}
    reference = {"studies": [{"studyId": "X", "finalMaxRho": 1.4, "solved": False}]}
    score.apply_reference(session, reference)
    assert session["studies"][0]["finalMaxRho"] == 1.4
    assert session["studies"][0]["solved"] is False
    # Now the study is only partially remediated, not a full solve.
    assert score.score_study(session["studies"][0])["remediationFraction"] < 1.0


def test_apply_reference_is_noop_without_reference(score):
    session = {"studies": [{"studyId": "Y", "solved": True, "finalMaxRho": 0.9}]}
    before = json.dumps(session, sort_keys=True)
    score.apply_reference(session, None)
    assert json.dumps(session, sort_keys=True) == before
