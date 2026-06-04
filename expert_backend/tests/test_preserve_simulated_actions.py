# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0

"""Regression tests for ``_merge_preserved_simulated_actions``.

A Step-2 re-run (Analyze & Suggest) replaces ``_last_result`` with a fresh
discovery result. Any action the operator simulated by hand — interactive
SLD-edit ``user_topo_*`` maneuvers, manually-picked actions — would
otherwise vanish from ``_last_result``, so the diagram / SLD endpoints that
resolve an action through ``_require_action`` reject it with
"not found in last analysis result" even though the card is still live in
the frontend feed.
"""

from expert_backend.services.recommender_service import RecommenderService


def _svc():
    return RecommenderService()


def test_preserves_manual_action_not_in_new_results():
    svc = _svc()
    # Simulate a Step-2 result that just clobbered _last_result.
    svc._last_result = {"prioritized_actions": {"disco_LINE_A": {"observation": object()}}}
    prior = {
        "user_topo_PYMONP3_123": {"observation": object(), "description": "manual"},
        "disco_LINE_A": {"observation": object()},  # already refreshed
    }
    svc._merge_preserved_simulated_actions(prior)
    actions = svc._last_result["prioritized_actions"]
    # The manual action is carried over.
    assert "user_topo_PYMONP3_123" in actions
    assert actions["user_topo_PYMONP3_123"]["description"] == "manual"


def test_does_not_overwrite_refreshed_action():
    svc = _svc()
    fresh = {"observation": object(), "tag": "fresh"}
    svc._last_result = {"prioritized_actions": {"disco_LINE_A": fresh}}
    prior = {"disco_LINE_A": {"observation": object(), "tag": "stale"}}
    svc._merge_preserved_simulated_actions(prior)
    # The new suggestion wins — the stale prior entry must not clobber it.
    assert svc._last_result["prioritized_actions"]["disco_LINE_A"]["tag"] == "fresh"


def test_skips_entries_without_observation():
    svc = _svc()
    svc._last_result = {"prioritized_actions": {}}
    # An entry that was never actually simulated (no live observation /
    # resolvable variant) must NOT be re-attached — it can't drive a
    # diagram and would only mask the real "run analysis first" error.
    prior = {"phantom": {"description": "no obs"}}
    svc._merge_preserved_simulated_actions(prior)
    assert "phantom" not in svc._last_result["prioritized_actions"]


def test_noop_on_empty_prior():
    svc = _svc()
    svc._last_result = {"prioritized_actions": {"disco_LINE_A": {"observation": object()}}}
    svc._merge_preserved_simulated_actions({})
    assert list(svc._last_result["prioritized_actions"]) == ["disco_LINE_A"]


def test_creates_prioritized_actions_bucket_if_missing():
    svc = _svc()
    svc._last_result = {}
    prior = {"user_topo_X_1": {"observation": object()}}
    svc._merge_preserved_simulated_actions(prior)
    assert "user_topo_X_1" in svc._last_result["prioritized_actions"]
