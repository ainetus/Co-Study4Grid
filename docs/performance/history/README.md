# Performance — Shipped & Rejected Retrospectives

One file per backend/frontend performance change, with
before/after numbers, patch diffs, and (where applicable) the
corresponding upstream pypowsybl / grid2op commit or the reason it
was rejected.

The active-reference perf docs (not retrospectives) live one level
up in [`../`](..): `rendering-optimization-plan.md`,
`performance-profiling.md`, `nad-profile-bare-env.md`,
`walkthrough-network-rendering-profiling.md`.

## Summary

See [`pr-perf-optimization-summary.md`](pr-perf-optimization-summary.md)
for the rolled-up PR summary — vectorization (care mask 1.1k×, flow
13×, delta 47×), observation caching (65×), 4× total speedup on
manual-action simulation.

## Shipped — Backend

| File | Topic |
|------|-------|
| [`vectorize-topology-cache.md`](vectorize-topology-cache.md) | `NetworkTopologyCache`: iterrows → numpy. Upstream 0.2.0.post4. |
| [`topology-cache-iter2.md`](topology-cache-iter2.md) | Iter 2: raw numpy groupby + GEOGRAPHICAL / DC_VALUES patches. post5. |
| [`narrow-voltage-level-queries.md`](narrow-voltage-level-queries.md) | Drop unused `kind` attribute; narrow `/api/voltage-levels`. |
| [`shared-network.md`](shared-network.md) | Share `Network` instance between `network_service` and `recommender_service`. post1. |
| [`grid2op-shared-network.md`](grid2op-shared-network.md) | Inject `Network` into grid2op to skip a 3rd parse on large grids. |
| [`skip-initial-obs.md`](skip-initial-obs.md) | Skip unused `env.get_obs()` in `/api/config` (−4.6 s). post3. |
| [`initial-lf-dc-init.md`](initial-lf-dc-init.md) | Skip failed PREVIOUS_VALUES LF; use DC_VALUES directly. post7. |
| [`detect-non-reconnectable-fast-path.md`](detect-non-reconnectable-fast-path.md) | Fix fast-path condition that was never triggering. |
| [`nad-prefetch.md`](nad-prefetch.md) | Spawn NAD generation in parallel during `/api/config` (−6 s crit). |
| [`nad-prefetch-earlier-spawn.md`](nad-prefetch-earlier-spawn.md) | Move NAD prefetch earlier in `update_config`. |
| [`per-endpoint-gzip.md`](per-endpoint-gzip.md) | Gzip on diagram endpoints (28 MB → ~2.5 MB). |
| [`combined-action-endpoint.md`](combined-action-endpoint.md) | Stream `/api/simulate-and-variant-diagram` NDJSON. |
| [`n1-diagram-fast-path.md`](n1-diagram-fast-path.md) | Vectorize flow extraction (13×), delta (47×), asset queries (1.1k×). |
| [`loading-parallel.md`](loading-parallel.md) | Parallelize `/api/branches`, `/api/voltage-levels`, `/api/nominal-voltages`. |

## Shipped — Frontend

| File | Topic |
|------|-------|
| [`svg-tab-unmount.md`](svg-tab-unmount.md) | `visibility:hidden` → `display:none` on inactive SVG tabs (600k → 200k live nodes). |
| [`interaction-paint-culling.md`](interaction-paint-culling.md) | Cull `<foreignObject>` labels + edge-infos during active pan/zoom (`.svg-interacting`): ~1.5–1.7x cheaper frames. Rejects the CSS-transform compositing trick (software/VDI regression). |

## Rejected / Experimental

| File | Why |
|------|-----|
| [`isolated-nad-worker-rejected.md`](isolated-nad-worker-rejected.md) | Isolating NAD worker with a separate Network instance made things worse (+1.7 s). |
| [`concurrent-variants.md`](concurrent-variants.md) | Java-side lock contention on shared `Network`; fix abandoned, main-thread vs worker split retained. |
