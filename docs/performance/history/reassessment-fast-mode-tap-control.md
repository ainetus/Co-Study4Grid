# Action assessment 6x too slow — the tap-changer voltage-control mode

## Context

On the full France grid (`bare_env_20240828T0100Z`, 11 225 lines / 6 835 VLs),
"Analyze & Suggest" after contingency `P.SAOL31RONCI` (overload
`BEON L31CPVAN`, 15 prioritized actions) spent ~40–90 s in the per-action
**reassessment** — the phase that re-simulates every prioritized action with
one AC load flow each (`expert_op4grid_recommender/utils/reassessment.py`).
Expectation was ~1.5 s/action.

Measured step-2 stage breakdown (from the streamed `result` event; warm caches):

| Stage | Field | Time |
|---|---|---|
| Step 1 (overload detect) | `step1_time` | ~2 s |
| Overflow graph | `overflow_graph_time` | ~0 s cached (25–50 s cold) |
| Action prediction (`recommender.recommend`) | `action_prediction_time` | ~4–9 s |
| **Action assessment (reassessment)** | `assessment_time` | **64–92 s** |
| Enrichment | `enrichment_time` | ~2–4 s |

Assessment dominated, and it *is* essentially all `reassess_prioritized_actions`
(the combined-pair superposition inside it is ~2 s for 105 pairs).

## What it was NOT

- **Parallelism.** The reassessment already runs parallel (10 workers on this
  20-core box). Forcing serial vs parallel:

  | Reassessment (15 actions) | time | per action |
  |---|---|---|
  | serial (1 worker) | 91 s | 6.1 s |
  | parallel (10 workers) | 64–76 s | 4.4–5.0 s |

  10-way parallelism buys only ~1.3x, because the parallel path clones the full
  118 MB pypowsybl network **per worker** (`save`/`load_from_binary_buffer` +
  `SimulationEnvironment` + obs) for only ~1.5 actions each — the clone tax
  dilutes the concurrency (same finding as
  [`analyze-suggest-2vcpu.md`](analyze-suggest-2vcpu.md), other direction).
  A single AC LF still costs ~6 s regardless.

- **Wasted `PREVIOUS_VALUES` → `DC_VALUES` retries.** Only 1 retry fired across
  ~30 LFs, so `_run_ac_with_init_fallback` was not the culprit.

- **Shunt control, phase-shifter regulation, reactive limits.** See below —
  zero or partial cost.

## Root cause — transformer tap-changer voltage-control mode

Isolating a single `run_ac` on the N-1 state and toggling one LF knob at a time
(`benchmarks/bench_load_flow_modes.py`, 20-core dev box):

| Config | time/LF | Newton iters | I on `BEON L31CPVAN` |
|---|---|---|---|
| **SLOW default** (incremental tap control) | **4.58 s** | 57 | 226.2 A |
| FAST-old (transformer + shunt ctrl OFF) | 0.39 s | 10 | 225.1 A |
| **FAST-new** (tap ctrl `AFTER_GENERATOR_VOLTAGE_CONTROL`) | **0.66 s** | 20 | 225.6 A |
| slow, **shunt** ctrl off only | 4.57 s | 57 | 226.2 A |
| slow, **transformer** ctrl off only | 0.39 s | 10 | 225.1 A |
| slow, reactive_limits off | 2.70 s | 31 | 226.0 A |
| slow, phase-shifter reg off | 4.63 s | 57 | 226.2 A |

**100 % of the slow/fast gap is `transformer_voltage_control_on`.** Shunt and
phase-shifter control cost nothing; reactive limits ~half. The provider default
runs the tap regulation as an **incremental** outer loop that needs 57 Newton
iterations to settle on this grid. Selecting the OpenLoadFlow provider param
`transformerVoltageControlMode=AFTER_GENERATOR_VOLTAGE_CONTROL` converges in
**20 iterations (~7x fewer)** for the **same current** (225.6 vs 226.2 A,
0.3 %) — it keeps tap regulation on, so it is *not* the accuracy loss of the old
fast mode (which disabled tap control entirely and shifted the current to
225.1 A).

## Fix — "fast mode" redefined to the after-generator config

Fast mode no longer disables tap/shunt control; it keeps them on and switches
the tap-changer outer loop to `AFTER_GENERATOR_VOLTAGE_CONTROL`.

**`expert_op4grid_recommender`**
- `pypowsybl_backend/network_manager.py` `run_load_flow(fast=True)`: sets
  `provider_parameters["transformerVoltageControlMode"] =
  "AFTER_GENERATOR_VOLTAGE_CONTROL"` instead of
  `transformer_voltage_control_on = False` / `shunt_..._on = False`.
- `config.py` `PYPOWSYBL_FAST_MODE` default `False → True`.

**`Co-Study4Grid`**
- `services/recommender_service.py` `_run_ac_with_fallback` (the diagram /
  contingency LF path — its own copy of the fast-mode logic) mirrors the same
  change; getattr fallback `False → True`.
- `services/simulation_mixin.py`: getattr fallback `False → True`.
- App already defaulted to fast (`main.py`, `config.default.json`,
  `hooks/useSettings.ts`).

Slow mode (`fast=False`) keeps the incremental loop as the max-fidelity
fallback. The `maxOuterLoopIterations: 100` bump becomes largely moot under
after-generator (it converges in ~20) but is harmless as a cap.

## Result — end-to-end (15-action reassessment)

| Reassessment (slow-mode config) | time | per action |
|---|---|---|
| incremental (before) | 91 s serial / 64–76 s parallel | 6.1 / 4.4 s |
| **after-generator (new fast, default)** | **17–19 s** | **1.2 s** |

Full step-2 wall dropped from ~144 s (cold) to ~35 s; correct overload still
detected; backend suite green (the one failing `test_overflow_html_dim_logic`
is pre-existing and unrelated to load flow).

## Precondition (unrelated but same session)

The grid must have a valid `grid_layout.json`. Without one, pypowsybl runs a
force layout on the France-scale grid: `/api/network-diagram` takes ~167 s and
returns a `NaN`-dimensioned (broken) SVG. Point `layout_path` at a real layout
whose keys cover the network's VLs (raw-Mercator-metre span ≈ 1.4–1.6 M — see
[`../../data/grid-layout-coordinate-scale.md`](../../data/grid-layout-coordinate-scale.md)).

## Reproduce

```bash
# Per-LF knob sweep (the root-cause table above):
python benchmarks/bench_load_flow_modes.py

# End-to-end step-1 → step-2 stage breakdown (assessment_time):
python benchmarks/bench_analyze_suggest.py --tier high            # French grid
python benchmarks/bench_analyze_suggest.py --tier high --serial   # force serial
```
