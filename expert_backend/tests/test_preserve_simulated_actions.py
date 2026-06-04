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


# ---------------------------------------------------------------------------
# Registration & resilient lookup
# ---------------------------------------------------------------------------


def test_register_action_result_registers_even_with_info_exception():
    """A non-fatal pypowsybl warning on info_action must NOT drop the
    action from _last_result['prioritized_actions']. The non_convergence
    field already carries the warning to the frontend; gating
    registration on the exception flag silently produced 400s on the
    next /api/action-variant-sld call because the live action card had
    no backing entry.
    """
    svc = _svc()
    svc._dict_action = {}
    info_action = {"exception": ["non-fatal: variant unchanged"]}
    obs = object()
    svc._register_action_result(
        "user_topo_PYMONP3_123",
        {"observation": obs, "description": "manual"},
        info_action,
        obs,
    )
    actions = svc._last_result["prioritized_actions"]
    assert "user_topo_PYMONP3_123" in actions
    assert actions["user_topo_PYMONP3_123"]["observation"] is obs


def test_register_action_result_skips_when_obs_is_none():
    svc = _svc()
    svc._dict_action = {}
    svc._register_action_result(
        "user_topo_X",
        {"observation": None},
        {"exception": None},
        None,
    )
    # No prior _last_result existed, and the obs is missing — must remain
    # untouched (or empty if created).
    assert svc._last_result is None or not svc._last_result.get(
        "prioritized_actions", {}
    ).get("user_topo_X")


def test_require_action_promotes_from_dict_action_when_missing():
    """``_require_action`` must promote a hand-simulated action from
    ``_dict_action`` (where it is always merged) to
    ``_last_result['prioritized_actions']`` when the latter doesn't have
    it — defensive recovery for the operator's live SLD action card.
    """
    svc = _svc()
    svc._last_result = {"prioritized_actions": {}}
    obs = object()
    svc._dict_action = {
        "user_topo_MORBRP6_456": {
            "observation": obs,
            "description": "manual",
        }
    }
    actions = svc._require_action("user_topo_MORBRP6_456")
    assert "user_topo_MORBRP6_456" in actions
    assert actions["user_topo_MORBRP6_456"]["observation"] is obs


def test_require_action_still_raises_for_truly_unknown_action():
    svc = _svc()
    svc._last_result = {"prioritized_actions": {}}
    svc._dict_action = {}
    import pytest
    from expert_backend.services.diagram_mixin import ActionResultUnavailableError
    with pytest.raises(ActionResultUnavailableError):
        svc._require_action("totally_unknown_xyz")
