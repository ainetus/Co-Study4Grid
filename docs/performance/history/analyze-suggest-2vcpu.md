# Analyze & Suggest on a 2-vCPU Space — reassessment serial + payload slim

## Context

The Game Mode "first scenario" (Pyrenees `LANNEL61PRAGN`,
`relation_8423570-225`, on the medium/European
`pypsa_eur_eur220_225_380_400` grid) regressed from ~30 s to ~75 s on the
2-vCPU HuggingFace Space. The in-app execution-time breakdown showed:

| Stage | Reported |
|---|---|
| Step 1 (contingency simulation) | 1.84 s |
| Overflow analysis | 8.27 s |
| Action prediction | 2.72 s |
| **Action assessment (reassessment)** | **47.0 s** |
| Enrichment / post-process | 2.20 s |
| **Other (network / streaming)** | **12.8 s** |
| **Total (click → display)** | **74.8 s** |

Two culprits: a 47 s reassessment and a 12.8 s "Other". Both were measured
and fixed with `benchmarks/bench_analyze_suggest.py`, which drives the exact
`/api/config → step1 → step2` path via `TestClient` and decomposes "Other".

## 1. Reassessment: parallel → serial on a CPU-limited host

`utils/reassessment.py` (in `expert_op4grid_recommender`) parallelised the
per-action re-simulation across `min(10, os.cpu_count(), n_actions)` worker
threads, each cloning a **full private pypowsybl network**. The Space log read:

```
[Reassessment] 15 action(s) re-simulated on 10/16 core(s) (parallel).
[Timer] Reassessment took 48.5592s
```

`os.cpu_count()` reports the **host** core count (16), not the container's
2-vCPU allocation. So 10 worker threads over-subscribed 2 vCPUs *and* paid the
per-worker network-clone tax → far slower than serial.

**Fix** (`expert_op4grid_recommender`):

- `_effective_cpu_count()` — container-aware CPU detection: the min of
  `os.cpu_count()`, the scheduler affinity mask, and the **cgroup CPU quota**
  (`cpu.max` / `cpu.cfs_quota_us`). Returns 2 on the Space, not 16.
- `_reassessment_worker_count()` engages parallel only when it pays off,
  gated by two config knobs (env-overridable via `EXPERT_OP4GRID_*`):
  `REASSESSMENT_PARALLEL` (None=auto / True / False) and
  `REASSESSMENT_MIN_PARALLEL_CORES` (default 4). On ≤ 3 effective cores → serial.
- The Space `Dockerfile` also pins `EXPERT_OP4GRID_REASSESSMENT_PARALLEL=0` as a
  belt-and-suspenders guarantee independent of cgroup exposure.

`--compare` on a 4-core dev box shows parallel is **no faster than serial**
even there (assessment 14.27 s parallel vs 13.93 s serial) — the clone tax
cancels the concurrency — so on 2 vCPUs the ~10-worker pool was pure loss.
Expected Space assessment: ~47 s → ~15 s.

## 2. "Other (network / streaming)": a 29 MB payload

`bench_analyze_suggest.py` decomposes "Other" into discovery-overhead /
result-`sanitize_for_json` / transport. On the European case the step-2 result
payload was **29 MB** and `sanitize_for_json` alone took 2.57 s. The cause:
every combined-action pair carries `p_or_combined` / `p_ex_combined` — the
superposed per-branch active-power vectors, **one float per line of the grid**
(~6–8k) × ~100 pairs. The frontend reads **none** of them (`CombinedAction`
uses only betas / max_rho / rho_before / rho_after; session-reload rebuilds
them as `[]`).

**Fix** (`Co-Study4Grid`): `services/analysis/combined_pairs.py`
`slim_combined_actions_for_payload()` empties those two keys at the step-2 API
boundary (emptied, not deleted, so the shape matches a reloaded session).

## Result (European `eu-pyrenees`, serial, 4-core dev box)

| Metric | Before | After |
|---|---|---|
| Result payload | 29 269 KiB | **267 KiB** (−99 %) |
| `sanitize_for_json` | 2.57 s | **0.01 s** |
| Other (network / streaming) | 3.80 s | **0.51 s** |

(The residual 0.49 s of "Other" is now the expert rule-filter + recommender-input
build — real compute that runs inside the discovery call but outside the
reported prediction/assessment split.)

The payload shrink also slashes the real-browser transfer of the 29 MB body —
the dominant part of the 12.8 s "Other" the operator saw on the Space, which
`TestClient` (in-process) under-measures.

## Reproduce

```bash
git lfs pull   # the European network.xiidm ships as a Git-LFS zip
python benchmarks/bench_analyze_suggest.py --compare            # medium tier, first study
python benchmarks/bench_analyze_suggest.py --tier high --serial # French grid
```
