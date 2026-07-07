# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0
"""Concurrency ownership for the shared pypowsybl ``Network`` (D3, 2026-07).

The backend's central bet — module-level singletons + a single shared
``Network`` that every code path variant-switches — was designed for a
single-user, single-flight desktop deployment. That assumption no
longer holds: FastAPI runs sync endpoints on a threadpool, the frontend
fires ``Promise.all`` batches and detached-tab refreshes, and the
HuggingFace Space adds genuinely concurrent visitors. Two primitives
restore ownership:

1. :func:`with_network_lock` / :func:`with_network_lock_stream` — a
   service-level re-entrant lock (``self._network_lock``) that
   serializes every entry point that switches variants on the shared
   Network. Sync methods hold it for their whole body; streaming
   generators hold it **per resumption** (each phase between two
   ``yield``\\ s is internally variant-consistent — every switch is
   paired with a finally-restore — so releasing at yield points is
   safe, and it keeps a long discovery phase from starving diagram
   requests any longer than that one phase).

   Thread-affinity note: Starlette iterates sync streaming generators
   via ``iterate_in_threadpool``, which may run **each** ``next()`` on
   a different worker thread. An ``RLock`` must be released by the
   thread that acquired it, so a naive ``with lock: yield from ...``
   would break — the per-step iterator below acquires and releases
   inside a single ``__next__`` call, which always runs on one thread.

2. A **busy gate** for study-level mutations (``/api/config``, step-1,
   step-2, the legacy analysis stream) — a non-blocking
   ``try_begin_study_mutation`` that maps to **HTTP 409** instead of
   queueing a second multi-second mutation behind the first. The gate
   is a plain ``threading.Lock`` (not an RLock) because a streaming
   mutation acquires it on the request thread and releases it from
   whatever threadpool thread finishes the stream.

Lock-ordering vs the NAD-prefetch drain: entry points hold the network
lock while calling ``_drain_pending_base_nad_prefetch()``, and the
prefetch worker itself takes the same lock around its whole body — so
the drain MUST NOT join while the lock is active (the worker may be
blocked waiting on the very lock the joiner holds → 60 s stall). With
the lock in place, mutual exclusion is already guaranteed by lock
ownership, and stale results across ``reset()`` are discarded by the
``_prefetch_generation`` counter instead of by joining. See
``RecommenderService._drain_pending_base_nad_prefetch``.
"""
from __future__ import annotations

import functools
import logging
from collections.abc import Callable, Iterator
from typing import Any

logger = logging.getLogger(__name__)


def _resolve_lock(instance: Any) -> Any:
    """The service lock, or None for bare-mixin test hosts that never ran
    ``RecommenderService.__init__`` — the decorators degrade to no-ops
    there so isolated mixin tests keep working single-threaded."""
    return getattr(instance, "_network_lock", None)


def with_network_lock(fn: Callable) -> Callable:
    """Serialize a sync entry point on the service network lock.

    Re-entrant: nested decorated calls on the same thread (e.g.
    ``compute_superposition`` → ``simulate_manual_action``) are fine.
    """
    @functools.wraps(fn)
    def wrapper(self: Any, *args: Any, **kwargs: Any) -> Any:
        lock = _resolve_lock(self)
        if lock is None:
            return fn(self, *args, **kwargs)
        with lock:
            return fn(self, *args, **kwargs)
    return wrapper


class _LockPerStepIterator:
    """Iterator adapter that holds ``lock`` for each ``next()`` resumption.

    Acquire and release happen inside one ``__next__`` call — i.e. on a
    single thread — which is what makes an RLock safe even though
    Starlette may run successive ``next()`` calls on different
    threadpool threads.
    """

    __slots__ = ("_inner", "_lock")

    def __init__(self, inner: Iterator, lock: Any) -> None:
        self._inner = inner
        self._lock = lock

    def __iter__(self) -> "_LockPerStepIterator":
        return self

    def __next__(self) -> Any:
        with self._lock:
            return next(self._inner)

    def close(self) -> None:
        # Generator cleanup may run finally-blocks that touch the
        # network — take the lock for those too.
        with self._lock:
            close = getattr(self._inner, "close", None)
            if close is not None:
                close()

    def throw(self, *exc_info: Any) -> Any:
        with self._lock:
            return self._inner.throw(*exc_info)  # type: ignore[attr-defined]


def with_network_lock_stream(fn: Callable) -> Callable:
    """Serialize a generator entry point on the service network lock,
    one resumption at a time (see module docstring)."""
    @functools.wraps(fn)
    def wrapper(self: Any, *args: Any, **kwargs: Any) -> Any:
        inner = fn(self, *args, **kwargs)
        lock = _resolve_lock(self)
        if lock is None:
            return inner
        return _LockPerStepIterator(inner, lock)
    return wrapper
