# Concurrency ownership for the shared pypowsybl Network (D3, 2026-07)

Deep revision **D3** from
[`2026-07-full-repo-review.md`](2026-07-full-repo-review.md). Closes
cross-cutting theme **T3** ("concurrency debt meeting a new deployment
reality").

## The problem

The backend's central bet — module-level singletons + a single shared
`pypowsybl.network.Network` that every code path variant-switches — was
designed for a **single-user, single-flight** desktop deployment, and
that assumption was explicitly documented
([`docs/performance/history/grid2op-shared-network.md`](../performance/history/grid2op-shared-network.md)).
Three developments invalidated it:

1. FastAPI runs the `def` (sync) endpoints on a **threadpool**, so two
   HTTP requests genuinely execute in parallel.
2. The frontend fires `Promise.all` batches and detached-tab refreshes —
   several diagram requests land at once.
3. The 0.8.0 HuggingFace Space adds concurrent **visitors** sharing one
   process (module-level singletons).

The shared `Network` is variant-switched by ~13 entry points. Every
switch is individually paired with a `finally`-restore, but two
concurrent switches on the same handle interleave — one request reads
flows from the variant another request just switched away from. One path
(`diagram_mixin._get_contingency_flows`) didn't even have the
`finally`-restore, so an exception there left the shared handle stuck on
a contingency variant, silently corrupting every later read.

## The fix — three primitives

All in [`expert_backend/services/service_lock.py`](../../expert_backend/services/service_lock.py)
+ the wiring on `RecommenderService`.

### 1. A re-entrant service network lock

`self._network_lock` (a `threading.RLock`) serializes every entry point
that variant-switches the shared Network:

- **Sync** entry points wear `@with_network_lock` — they hold the lock
  for the whole body.
- **Streaming** entry points (`run_analysis`) wear
  `@with_network_lock_stream` — the lock is held **per resumption**
  (each phase between two `yield`s is internally variant-consistent, so
  releasing at yield points is safe and keeps a long phase from starving
  diagram requests any longer than that one phase).

Decorated entry points (13):

| Mixin | Methods |
|---|---|
| `DiagramMixin` | `get_network_diagram`, `get_contingency_diagram`, `get_action_variant_diagram`, `get_contingency_diagram_patch`, `get_action_variant_diagram_patch`, `get_n_sld`, `get_contingency_sld`, `get_action_variant_sld`, `get_topology_preview_sld` |
| `AnalysisMixin` | `run_analysis_step1`, `run_analysis` (stream) |
| `SimulationMixin` | `simulate_manual_action`, `compute_superposition` |

`compute_superposition` → `simulate_manual_action` is a nested locked
call on the same thread — the RLock is re-entrant, so it doesn't
deadlock.

**Thread-affinity subtlety.** Starlette iterates a sync streaming
generator via `iterate_in_threadpool`, which may run each `next()` on a
*different* worker thread. An `RLock` must be released by the thread
that acquired it, so a naive `with lock: yield from ...` would break.
`_LockPerStepIterator` acquires and releases **inside a single
`__next__` call** — which always runs on one thread — instead.

`/api/config` holds the lock across the whole `reset() → load_network()
→ update_config()` sequence (via the `network_lock()` context manager)
so no diagram request can interleave between the reset and the reload.

### 2. A study-mutation busy gate → HTTP 409

Study-level operations — `/api/config`, `run-analysis-step1`,
`run-analysis-step2`, the legacy `run-analysis` stream — each take
seconds and mutate the shared singleton state wholesale. Queueing a
second one behind the first is worse than refusing it, so
`try_begin_study_mutation()` is a **non-blocking** claim that maps a
conflict to **HTTP 409** ("another study operation is already in
progress"). It's a plain `threading.Lock` (not an RLock) because a
streaming mutation acquires it on the request thread and releases it —
in the generator's `finally` — from whatever threadpool thread finishes
the stream.

Read-only diagram/SLD requests are NOT gated: they only need the
network lock (serialize), not the busy gate (refuse).

### 3. Bounded variant + observation lifecycle

Cached contingency variants previously grew without bound within a
session (one per contingency ever viewed), each costing pypowsybl-side
memory proportional to the grid. `_touch_contingency_variant` keeps an
LRU of at most `MAX_CONTINGENCY_VARIANTS` (8) contingency variants on
the shared Network beyond the N baseline; eviction calls
`remove_variant` and drops the matching `_lf_status_by_variant` entry.
Re-viewing an evicted contingency transparently re-clones and re-runs
its AC load flow. The LRU never evicts the N baseline, the variant being
returned to the caller, or the one the Network is currently positioned
on.

## Lock-ordering vs the NAD-prefetch drain

The old `reset()` **joined** the in-flight NAD-prefetch thread
(`join(timeout=60)`) to stop it leaking its result into the next study.
With the network lock in place that join becomes a **deadlock risk**:
the prefetch worker now takes the same `_network_lock` around its whole
body, so a caller that holds the lock (e.g. `/api/config`) and then
tries to join the worker would wait 60 s for a worker that is itself
blocked on the very lock the caller holds.

The join is replaced by a monotonic **`_prefetch_generation` counter**:
`reset()` and every new prefetch bump it, and a worker whose captured
generation is stale (checked under the lock, before and after its
compute) discards its result instead of poisoning the next study's
cache. Mutual exclusion is already guaranteed by lock ownership; the
counter only handles staleness. `_drain_pending_base_nad_prefetch()` is
therefore a **no-op when the service lock is present** and falls back to
the historical join only for bare-mixin test hosts that never ran
`RecommenderService.__init__` (no lock).

## What is NOT changed

- **Endpoints / frontend**: behaviour is identical for a single user;
  the 409 is only reachable under genuine concurrency.
- **`run_analysis_step2`** runs on the grid2op env's own network
  instance, not the shared `_base_network`, so it takes the study gate
  (it IS a study mutation) but not the network lock.
- **Bare-mixin tests**: the decorators and the drain degrade to no-ops
  when `_network_lock` is absent, so isolated mixin tests keep running
  single-threaded unchanged.

## Tests

- [`test_service_concurrency.py`](../../expert_backend/tests/test_service_concurrency.py)
  — lock re-entrancy, cross-thread gate release, decorator
  serialization, the streaming decorator's **per-`next()` lock release**
  (a long stream must not hold the lock across yields) + no-op fallback,
  the variant LRU (eviction, reuse reorder, never-evict-working, reset
  clears it), and the NAD-prefetch **generation-staleness discard** — a
  worker whose generation was superseded mid-compute (as `reset()` does)
  drops its result instead of poisoning the next study's cache (the
  behaviour that replaced the deadlock-prone `join()`).
- `test_api_endpoints.py::TestStudyMutationBusyGate` — the 409 contract
  on config / step-1 / step-2 and gate release on success, error, and
  after a stream drains.
