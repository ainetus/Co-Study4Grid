# Co-Study4Grid — Performance benchmarks

Consolidated micro-benchmarks that exercise the critical path of a
Load Study on the reference **PyPSA-EUR France 400 kV** grid
(~25 MB SVG, 6 835 VLs, 85 304 switches, 14 880 loads+generators,
55 104 operational-limit entries).

These scripts drive the same code paths as the web UI but without the
HTTP stack, so they can be re-run after a patch to catch regressions
before pushing.

## Prerequisites

```bash
# Same venv as the backend (`expert_backend`) — needs:
#   pypowsybl, expert_op4grid_recommender, pandas, numpy
export PATH="$HOME/.asdf/shims:$PATH"
python -c "import pypowsybl, expert_op4grid_recommender"
```

Override the reference grid / action file via env vars:

```bash
export BENCH_NETWORK_PATH=/path/to/grid_dir          # contains grid.xiidm + grid_layout.json
export BENCH_ACTION_FILE=/path/to/reduced_actions.json
export BENCH_CONTINGENCY=DISCO_NAME                  # only for bench_n1_diagram.py
```

## Scripts

| Script | What it measures | Where the patch history lives |
|---|---|---|
| `bench_load_study.py` | Full `/api/config` + 4 parallel XHRs round-trip (reset + load_network + update_config + 4 response helpers). Cumulative target of every patch on the branch. | `docs/performance/history/loading-parallel.md` |
| `bench_topology_cache.py` | Per-helper + full `NetworkTopologyCache(net)` init. Validates upstream vectorisation series (0.2.0.post3 → post8). | `docs/performance/history/vectorize-topology-cache.md`, `docs/performance/history/topology-cache-iter2.md` |
| `bench_voltage_level_queries.py` | `/api/voltage-levels`, `/api/nominal-voltages`, `get_monitored_elements`, `_get_switches_with_topology` narrow-attr wins. | `docs/performance/history/narrow-voltage-level-queries.md` |
| `bench_n1_diagram.py` | Full `get_n1_diagram(contingency)` cold + warm, per-sub-step breakdown. Validates the 3 N-1 fast-path patches. | `docs/performance/history/n1-diagram-fast-path.md` |
| `bench_nad_n_state.py` | `get_network_diagram()` cold + warm on the N-state. Captures NAD / SVG / Meta sub-timings from the `[RECO]` log lines. | `docs/performance/nad-profile-bare-env.md` |
| `bench_nad_toggles.py` | Matrix of `NadParameters` toggle combinations — quantifies per-flag impact on NAD gen + SVG size, surfaces the cost of `injections_added=True`. | `docs/performance/nad-profile-bare-env.md` |
| `bench_analyze_suggest.py` | **Full "Analyze & Suggest" for a Game Mode study** — drives `/api/config` → `step1` → `step2` (streaming NDJSON) through the FastAPI `TestClient` and prints the UI's execution-time breakdown (step1 / overflow / prediction / **assessment** / enrichment / **Other**), with "Other" decomposed into discovery-overhead / result `sanitize_for_json` / transport. `--serial` forces serial reassessment; `--compare` runs parallel-vs-serial. This is the case the 30 s → 75 s regression was reported on. | `docs/performance/history/analyze-suggest-2vcpu.md` |
| `run_all.py` | Drives every benchmark above sequentially. | — |

### `bench_analyze_suggest.py`

```bash
# The reported "this case, first scenario": Pyrenees LANNEL61PRAGN on the
# medium/European grid (its network.xiidm ships as a Git-LFS zip — run
# `git lfs pull` first, or use --tier high for the uncompressed French grid).
python benchmarks/bench_analyze_suggest.py                 # medium tier, first study
python benchmarks/bench_analyze_suggest.py --tier high     # French grid, first study
python benchmarks/bench_analyze_suggest.py --compare       # parallel vs serial, same case
```

Two levers this benchmark validates:

- **Per-action reassessment goes serial on a CPU-limited host.** The tail line
  reports `reassessment: serial|parallel — N worker(s) / M effective core(s)`.
  On a 2-vCPU host the recommender's container-aware detection picks serial;
  even on a 4-core dev box `--compare` shows parallel is no faster than serial
  (each worker clones a full network), so over-subscribing 2 vCPUs with ~10
  workers was the 47 s assessment in the regression.
- **The step-2 result payload no longer ships full-grid per-branch arrays.**
  Each combined-action pair used to carry `p_or_combined` / `p_ex_combined`
  (one float per line × ~100 pairs ≈ **29 MB** on the European grid); the
  frontend reads neither, so they are emptied at the API boundary. Watch
  `payload=… KiB` and the `result sanitize_for_json` sub-line drop
  (29 269 KiB / 2.57 s → 267 KiB / 0.01 s).

## Reference measurements

On a developer box with pypowsybl 1.14.0 + Python 3.12 + the full
PyPSA-EUR France 400 kV grid, current branch tip:

### `bench_load_study.py`

| Segment | Measured |
|---|---|
| `reset()` | ~0 ms |
| `load_network` | ~2 200 ms |
| `update_config` | ~5 900 ms |
| 4 response XHRs | ~330 ms |
| **Total** | **~8.5 s** |

This maps to ~8.8 s end-to-end wall-clock on Chrome DevTools traces —
see v18 row of `docs/performance/history/loading-parallel.md` (-63 % vs v6 baseline).

### `bench_voltage_level_queries.py`

| Endpoint | Before | After |
|---|---|---|
| `/api/voltage-levels` | 7.5 ms | 4.5 ms |
| `/api/nominal-voltages` | **144 ms** | **5.7 ms** (~25×) |
| `get_monitored_elements` | 265 ms | 175 ms |
| `_get_switches_with_topology` | 174 ms | 141 ms |

### `bench_n1_diagram.py` (contingency `ARGIAL71CANTE`)

| Call | Before | After |
|---|---|---|
| COLD (first view) | 18 125 ms | **4 159 ms** (-77 %) |
| WARM (repeat view) | 11 906 ms | **3 200 ms** (-73 %) |

## When to run them

- **Before pushing a perf patch** on the backend or on
  `expert_op4grid_recommender`: run the benchmark closest to the
  change and confirm no regression on the rest via `run_all.py`.
- **When a DevTools trace suggests slowdown**: map the hot span to
  one of the four scripts to isolate it from web-layer variance.
- **When upstream bumps** `expert_op4grid_recommender`: re-run
  `bench_topology_cache.py` + `bench_voltage_level_queries.py` to
  catch behavioural changes in pypowsybl / numpy / pandas upgrades.

## Notes

- These scripts import `expert_backend.services.*` directly, so they
  need to run inside the Co-Study4Grid venv.
- Each benchmark is idempotent — running one does not alter global
  state in a way that would affect the next (each call to
  `setup_service` resets the recommender).
- The scripts intentionally use real data paths rather than mocks:
  the goal is to measure the full pypowsybl + JNI + pandas stack.
  Unit tests in `expert_backend/tests/` cover the mock path.
