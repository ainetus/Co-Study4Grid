# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# SPDX-License-Identifier: MPL-2.0
"""Concurrency-ownership tests for the shared pypowsybl Network (D3, 2026-07).

Covers the three primitives introduced in
``expert_backend/services/service_lock.py`` + the service wiring:

- the re-entrant network lock (`@with_network_lock` /
  `@with_network_lock_stream`) serializing variant-switching entry points,
- the non-blocking study-mutation gate (`try_begin_study_mutation` →
  HTTP 409),
- the contingency-variant LRU on the shared Network.
"""
from __future__ import annotations

import threading
import time
from unittest.mock import MagicMock

from expert_backend.services.recommender_service import (
    MAX_CONTINGENCY_VARIANTS,
    RecommenderService,
)
from expert_backend.services.service_lock import (
    with_network_lock,
    with_network_lock_stream,
)


# ---------------------------------------------------------------------
# Service state wiring
# ---------------------------------------------------------------------

def test_service_has_concurrency_primitives():
    svc = RecommenderService()
    # RLock exposes _is_owned / acquire / release
    assert hasattr(svc._network_lock, "acquire")
    assert svc._study_gate.acquire(blocking=False) is True
    svc._study_gate.release()
    assert svc._prefetch_generation == 0
    assert svc._contingency_variant_lru == []


def test_network_lock_is_reentrant():
    svc = RecommenderService()
    with svc.network_lock():
        # Nested acquisition on the same thread must not deadlock.
        with svc.network_lock():
            assert True


# ---------------------------------------------------------------------
# Study-mutation gate
# ---------------------------------------------------------------------

def test_study_gate_rejects_second_concurrent_mutation():
    svc = RecommenderService()
    assert svc.try_begin_study_mutation("first") is True
    # A second claim while the first is in flight is rejected.
    assert svc.try_begin_study_mutation("second") is False
    svc.end_study_mutation()
    # After release, the gate is claimable again.
    assert svc.try_begin_study_mutation("third") is True
    svc.end_study_mutation()


def test_study_gate_release_can_cross_threads():
    """The gate is a plain Lock (not RLock) so a streaming mutation can
    acquire on the request thread and release from the threadpool thread
    that finishes the stream."""
    svc = RecommenderService()
    assert svc.try_begin_study_mutation("stream") is True

    released = threading.Event()

    def _release_from_other_thread():
        svc.end_study_mutation()
        released.set()

    t = threading.Thread(target=_release_from_other_thread)
    t.start()
    t.join(timeout=5)
    assert released.is_set()
    # Gate is free again.
    assert svc.try_begin_study_mutation("after") is True
    svc.end_study_mutation()


def test_end_study_mutation_without_begin_is_safe():
    svc = RecommenderService()
    # Releasing an unheld plain Lock would raise RuntimeError; the wrapper
    # swallows it so a double-finally can't 500 the request.
    svc.end_study_mutation()  # must not raise


# ---------------------------------------------------------------------
# Decorator behaviour
# ---------------------------------------------------------------------

class _LockHost:
    def __init__(self):
        self._network_lock = threading.RLock()
        self.calls = []

    @with_network_lock
    def do_work(self, tag):
        # The lock must be held for the whole body.
        assert self._network_lock.acquire(blocking=False) is True
        self._network_lock.release()
        self.calls.append(tag)
        return tag

    @with_network_lock_stream
    def stream_work(self, n):
        for i in range(n):
            yield i


def test_with_network_lock_serializes_sync_calls():
    host = _LockHost()
    order = []
    started = threading.Event()

    @with_network_lock
    def slow(self, tag):  # bound manually below
        order.append(("enter", tag))
        started.set()
        time.sleep(0.05)
        order.append(("exit", tag))

    # Bind slow onto the host instance surrogate.
    host_a = _LockHost()

    def worker(tag):
        slow(host_a, tag)

    t1 = threading.Thread(target=worker, args=("A",))
    t2 = threading.Thread(target=worker, args=("B",))
    t1.start()
    started.wait(timeout=1)
    t2.start()
    t1.join(timeout=2)
    t2.join(timeout=2)

    # The two critical sections must not interleave: every enter is
    # immediately followed by its own exit.
    assert order[0][0] == "enter"
    assert order[1] == ("exit", order[0][1])
    assert order[2][0] == "enter"
    assert order[3] == ("exit", order[2][1])


def test_with_network_lock_stream_yields_all_values():
    host = _LockHost()
    assert list(host.stream_work(4)) == [0, 1, 2, 3]


def test_with_network_lock_stream_releases_the_lock_between_steps():
    """The streaming decorator must hold the lock PER resumption, not across
    the whole generator — otherwise a long analysis stream would starve
    every diagram request for its full duration. After each `next()`
    returns, the lock must be released (not owned by this thread)."""
    host = _LockHost()
    it = iter(host.stream_work(3))
    for _ in range(3):
        next(it)
        # Between yields the lock is released — the RLock is not owned.
        assert host._network_lock._is_owned() is False


def test_decorators_noop_without_lock():
    """Bare hosts (no _network_lock) degrade to a direct call so isolated
    mixin tests keep working single-threaded."""

    class _NoLock:
        @with_network_lock
        def f(self):
            return "ok"

        @with_network_lock_stream
        def g(self):
            yield "a"
            yield "b"

    h = _NoLock()
    assert h.f() == "ok"
    assert list(h.g()) == ["a", "b"]


# ---------------------------------------------------------------------
# Contingency-variant LRU
# ---------------------------------------------------------------------

def _fake_network_with_variants():
    """A MagicMock network that tracks its variant set like pypowsybl."""
    net = MagicMock()
    net._variants = {"N_state_cached"}
    net._working = "InitialState"

    def get_variant_ids():
        return list(net._variants)

    def get_working_variant_id():
        return net._working

    def set_working_variant(v):
        net._working = v

    def remove_variant(v):
        net._variants.discard(v)

    net.get_variant_ids.side_effect = get_variant_ids
    net.get_working_variant_id.side_effect = get_working_variant_id
    net.set_working_variant.side_effect = set_working_variant
    net.remove_variant.side_effect = remove_variant
    return net


def test_variant_lru_evicts_beyond_cap():
    svc = RecommenderService()
    net = _fake_network_with_variants()

    # Simulate MAX+3 distinct contingency variants being touched.
    for i in range(MAX_CONTINGENCY_VARIANTS + 3):
        vid = f"contingency_state_C{i}"
        net._variants.add(vid)
        svc._lf_status_by_variant[vid] = {"converged": True, "lf_status": "CONVERGED"}
        svc._touch_contingency_variant(net, vid)

    # The LRU stays capped, and evicted variants were removed from the
    # Network + the LF-status cache.
    assert len(svc._contingency_variant_lru) == MAX_CONTINGENCY_VARIANTS
    assert net.remove_variant.call_count == 3
    for i in range(3):
        evicted = f"contingency_state_C{i}"
        assert evicted not in svc._contingency_variant_lru
        assert evicted not in svc._lf_status_by_variant
        assert evicted not in net._variants


def test_variant_lru_reorders_on_reuse():
    svc = RecommenderService()
    net = _fake_network_with_variants()

    # Fill exactly to the cap.
    for i in range(MAX_CONTINGENCY_VARIANTS):
        vid = f"contingency_state_C{i}"
        net._variants.add(vid)
        svc._touch_contingency_variant(net, vid)

    # Re-touch the oldest → it becomes most-recently-used.
    svc._touch_contingency_variant(net, "contingency_state_C0")
    # Add one more → the eviction victim is now C1 (not C0).
    net._variants.add("contingency_state_CX")
    svc._touch_contingency_variant(net, "contingency_state_CX")

    assert "contingency_state_C0" in svc._contingency_variant_lru
    assert "contingency_state_C1" not in svc._contingency_variant_lru


def test_variant_lru_never_evicts_working_or_returned_variant():
    svc = RecommenderService()
    net = _fake_network_with_variants()

    # Fill to the cap, then position the network ON the oldest variant.
    for i in range(MAX_CONTINGENCY_VARIANTS):
        vid = f"contingency_state_C{i}"
        net._variants.add(vid)
        svc._touch_contingency_variant(net, vid)
    net._working = "contingency_state_C0"

    # Touch a fresh variant → eviction must skip the currently-working C0.
    net._variants.add("contingency_state_CX")
    svc._touch_contingency_variant(net, "contingency_state_CX")

    assert "contingency_state_C0" in net._variants
    for call in net.remove_variant.call_args_list:
        assert call.args[0] != "contingency_state_C0"


def test_reset_clears_variant_lru():
    svc = RecommenderService()
    svc._contingency_variant_lru = ["contingency_state_C0", "contingency_state_C1"]
    svc.reset()
    assert svc._contingency_variant_lru == []


def test_reset_bumps_prefetch_generation():
    svc = RecommenderService()
    gen_before = svc._prefetch_generation
    svc.reset()
    assert svc._prefetch_generation > gen_before


# ---------------------------------------------------------------------
# NAD-prefetch generation staleness (the D3 lock-ordering fix core)
# ---------------------------------------------------------------------

def test_prefetch_async_stores_result_and_bumps_generation():
    from unittest.mock import patch

    svc = RecommenderService()
    gen0 = svc._prefetch_generation
    with patch.object(svc, "_get_base_network", return_value=MagicMock()), \
         patch.object(svc, "get_network_diagram", return_value={"svg": "FRESH"}):
        svc.prefetch_base_nad_async()
        result = svc.get_prefetched_base_nad(timeout=5)
    assert result == {"svg": "FRESH"}
    assert svc._prefetch_generation > gen0


def test_prefetch_worker_discards_result_when_generation_superseded():
    """A worker whose generation was bumped mid-compute (as `reset()` does)
    must DISCARD its result instead of poisoning the next study's cache —
    this is what replaced the deadlock-prone `join()` in `reset()`."""
    from unittest.mock import patch

    svc = RecommenderService()
    started = threading.Event()
    proceed = threading.Event()

    def _slow_diagram():
        started.set()
        proceed.wait(timeout=5)
        return {"svg": "STALE"}

    with patch.object(svc, "_get_base_network", return_value=MagicMock()), \
         patch.object(svc, "get_network_diagram", side_effect=_slow_diagram):
        svc.prefetch_base_nad_async()
        assert started.wait(timeout=5)          # worker is mid-compute
        svc._prefetch_generation += 1           # simulate reset()/newer prefetch
        proceed.set()
        svc.get_prefetched_base_nad(timeout=5)   # let the worker finish
    # Stale result discarded — the fresh study's cache stays clean.
    assert svc._prefetched_base_nad is None
