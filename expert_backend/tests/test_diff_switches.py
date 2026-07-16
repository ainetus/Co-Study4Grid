# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0
"""Unit tests for the vectorised DiagramMixin._diff_switches (QW11).

The old implementation looped over ~85 k switches doing two `.loc` lookups
each; the vectorised version aligns the two `open` columns on the shared index
and compares in NumPy. These tests lock the semantics the old loop had:
only switches present in BOTH grids are considered, a change is reported as
`from_open` (contingency) → `to_open` (action), and unchanged / absent
switches are omitted.
"""
import pandas as pd

from expert_backend.services.recommender_service import RecommenderService


class _FakeNetwork:
    def __init__(self, switches_df):
        self._df = switches_df

    def get_switches(self):
        return self._df


def _switches(open_by_id):
    return pd.DataFrame({"open": list(open_by_id.values())}, index=list(open_by_id))


def test_none_action_snapshot_returns_empty():
    assert RecommenderService._diff_switches(None, _FakeNetwork(_switches({}))) == {}


def test_detects_open_and_close_transitions():
    action = _switches({"SW_A": True, "SW_B": False, "SW_C": True})
    cont = _FakeNetwork(_switches({"SW_A": False, "SW_B": True, "SW_C": True}))
    result = RecommenderService._diff_switches(action, cont)
    # SW_A: closed→open, SW_B: open→closed, SW_C: unchanged (omitted).
    assert result == {
        "SW_A": {"from_open": False, "to_open": True},
        "SW_B": {"from_open": True, "to_open": False},
    }


def test_switches_absent_from_contingency_are_skipped():
    action = _switches({"SW_A": True, "SW_ONLY_IN_ACTION": True})
    cont = _FakeNetwork(_switches({"SW_A": False}))
    result = RecommenderService._diff_switches(action, cont)
    assert result == {"SW_A": {"from_open": False, "to_open": True}}
    assert "SW_ONLY_IN_ACTION" not in result


def test_no_changes_returns_empty():
    action = _switches({"SW_A": True, "SW_B": False})
    cont = _FakeNetwork(_switches({"SW_A": True, "SW_B": False}))
    assert RecommenderService._diff_switches(action, cont) == {}


def test_failure_is_swallowed_to_empty():
    class _Boom:
        def get_switches(self):
            raise RuntimeError("boom")

    # Switches are informational — a failure must not break the SLD response.
    assert RecommenderService._diff_switches(_switches({"SW_A": True}), _Boom()) == {}
