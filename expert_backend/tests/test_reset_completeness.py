# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0
"""Automated reset()-completeness invariant (QW17).

The review found per-study caches that ``reset()`` forgot to clear, leaking a
previous grid's state into the next study (the historical ``_layout_cache``
regression, plus ``_n_state_currents`` / ``_last_action_path`` found here). This
test sweeps EVERY instance attribute a fresh ``RecommenderService`` sets and
asserts ``reset()`` restores each per-study field to its ``__init__`` default —
so a new cache added to ``__init__`` but not ``reset()`` fails here, without a
human having to remember to update a hand-maintained list.
"""
from expert_backend.services.recommender_service import RecommenderService

# Infrastructure that intentionally SURVIVES reset() — the concurrency
# primitives (the lock guards the reset itself), the prefetch generation
# counter (reset BUMPS it to invalidate in-flight workers), and the prefetch
# thread/event handles (drained, not value-compared).
PERMANENT_FIELDS = {
    "_network_lock",
    "_study_gate",
    "_prefetch_generation",
    "_prefetched_base_nad_thread",
    "_prefetched_base_nad_event",
}

# Only value-typed defaults can be compared for equality after reset().
_COMPARABLE = (type(None), list, dict, str, int, float, bool, tuple)


def test_reset_restores_every_per_study_default():
    defaults = dict(vars(RecommenderService()))

    svc = RecommenderService()
    poked = {}
    for key, default in defaults.items():
        if key in PERMANENT_FIELDS or not isinstance(default, _COMPARABLE):
            continue
        # A sentinel distinct from every default value.
        setattr(svc, key, "__LEAKED__")
        poked[key] = default

    svc.reset()

    leaked = {
        key: getattr(svc, key)
        for key, default in poked.items()
        if getattr(svc, key) != default
    }
    assert not leaked, (
        "reset() left per-study fields at study-specific values (add them to "
        f"reset()): {sorted(leaked)}"
    )


def test_reset_clears_the_two_known_leaks():
    # Direct regression guards for the fields QW17 fixed.
    svc = RecommenderService()
    svc._n_state_currents = {"LINE_1": 1.0}
    svc._last_action_path = "/some/actions.json"
    svc.reset()
    assert svc._n_state_currents is None
    assert svc._last_action_path is None


def test_fresh_and_reset_instances_agree_on_per_study_fields():
    fresh = RecommenderService()
    other = RecommenderService()
    other.reset()
    for key, default in vars(fresh).items():
        if key in PERMANENT_FIELDS or not isinstance(default, _COMPARABLE):
            continue
        assert getattr(other, key) == default, f"{key} differs after reset()"
