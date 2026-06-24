# Reproducibility — P.SAOL31RONCI / BEON L31CPVAN overload

Canonical calibration case for the load-flow pipeline: tripping line
**`P.SAOL31RONCI`** overloads line **`BEON L31CPVAN`** (IST permanent
current limit **236 A**, side TWO). This note records the *reference*
values, the recipe that reproduces them, and how the live app's
**fast / slow** simulation modes relate to them.

Companion script: [`scripts/reproduce_ronci_overload.py`](../../scripts/reproduce_ronci_overload.py)
(`python scripts/reproduce_ronci_overload.py` → `ALL REFERENCES REPRODUCED`).
For the LF mechanics see [`architecture/simulation-pipeline.md`](simulation-pipeline.md)
and the lib's sister doc `Expert_op4grid_recommender/docs/architecture/simulation-pipeline.md`.

## TL;DR

| What you observe | Why |
|---|---|
| Two different "reference" numbers (96.1 % vs 98.75 %) | They are on **two different grids**. The reduced `config_small_grid` grid (93 VL) gives **98.75 %**; the full French grid (6835 VL) gives **96.1 %**. Same contingency, different network. |
| App shows 95.4 % on the full grid (fast mode) | *Fast* mode disables transformer + shunt voltage control. |
| Full grid N-1 **diverges / null flows** without fast mode | The diagram path's LF params (`create_olf_rte_parameter`) keep the **stock 20 `maxOuterLoopIterations`** cap. The French grid needs ~40–50 outer iterations after the trip → `MAX_ITERATION_REACHED`. Raise the cap to **100** and it converges (→ 95.84 %). |
| Exact reference (96.1 %, 226.78 A) | A pypowsybl **SecurityAnalysis** + the **`parameters_hades2`** bundle reproduces **96.08 %** (OpenLoadFlow). The last 0.02 % to 96.10 % is the real **Hades2** solver (`pypowsybl-rte`). The SA's extra +0.09 % over a plain `run_ac` is **`contingencyPropagation`** (breaker-level trip), *not* a load-flow parameter — see the decomposition below. |

## The reference values

The operator's reference JSON (keys `violations` / `limitReduction` /
`extensions.ActivePower` / `operator_strategy`) is a serialised pypowsybl
`SecurityAnalysis` result. BEON L31CPVAN, side TWO, against the 236 A limit
(pre-contingency active power is 13.493 MW in every case):

| Grid | State | current | loading | post active |
|---|---|---|---|---|
| reduced (93 VL, `config_small_grid`) | N-1 | 233.050 A | 98.75 % | 25.704 MW |
| full (6835 VL, `bare_env_20240828T0100Z`) | N-1 | 226.785 A | 96.10 % | 24.972 MW |
| full (6835 VL) | N-1 + open transformer `CHALOY631` | 226.634 A | 96.03 % | 24.947 MW |

`scripts/reproduce_ronci_overload.py` reproduces all three via the Hades2
SecurityAnalysis recipe to within **0.04 A** (the residual is OpenLoadFlow's
Hades2 emulation vs the actual Hades2 solver).

### The reference recipe (`parameters_hades2`)

```python
pp.loadflow.Parameters(
    use_reactive_limits=True,
    transformer_voltage_control_on=True,
    distributed_slack=False,                 # <- single slack (Hades2-style)
    twt_split_shunt_admittance=True,
    voltage_init_mode=DC_VALUES,
    provider_parameters={
        "slackDistributionFailureBehavior": "FAIL",
        "maxOuterLoopIterations": "30",
        "transformerVoltageControlMode": "AFTER_GENERATOR_VOLTAGE_CONTROL",
        "stateVectorScalingMode": "MAX_VOLTAGE_CHANGE",
        "transformerVoltageControlUseInitialTapPosition": "true",
        "generatorVoltageControlMinNominalVoltage": "120",
        "fictitiousGeneratorVoltageControlCheckMode": "FORCED",
        "mostMeshedSlackBusSelectorMaxNominalVoltagePercentile": "100",
    },
)
```

The CHALOY631 remedial action is reproduced by adding a SecurityAnalysis
operator strategy on top of the contingency:

```python
sa.add_terminals_connection_action("open_CHALOY631", "CHALOY631", opening=True)
sa.add_operator_strategy("strat_open_CHALOY631", "P.SAOL31RONCI",
                         ["open_CHALOY631"],
                         condition_type=pp.security.ConditionType.TRUE_CONDITION)
```

## Simulation modes on the full grid (and what each yields)

All rows below are BEON L31CPVAN, N-1 (`P.SAOL31RONCI` tripped), full grid,
pypowsybl 1.15. "Slow" = full transformer + shunt voltage control; "Fast" =
those two outer loops disabled.

| Recipe / mode | Converges? | loading | post MW | note |
|---|---|---|---|---|
| **Fast** (xfo/shunt VC off) | yes | **95.38 %** | 25.22 | what the live app shows today |
| **Slow, 20 outer iter** (stock OLF default) | **no — MAX_ITERATION → null flows** | — | — | the divergence the operator hit (pre-fix) |
| **Slow, 100 outer iter** (now the diagram-path default) | yes | **95.84 %** | 25.03 | the shipped fix |
| `parameters_hades2` LF params, terminal-only disconnect | yes | 95.99 % | 24.95 | LF params only, `run_ac` |
| `parameters_hades2` + `contingencyPropagation` (SecurityAnalysis) | yes | **96.08 %** | 24.97 | the reproducible reference (OpenLoadFlow) |
| **Hades2 provider** (`pypowsybl-rte`) | — | **96.10 %?** | 24.97 | the actual RTE reference solver — see below |

### Decomposition of the 95.84 % → 96.10 % gap (full grid, all factors verified)

The gap between the shipped slow-mode result and the reference is **three
small, independent effects** — and, importantly, **none of the last two is a
`run_ac` load-flow parameter**:

| Step | What changes | loading | Δ |
|---|---|---|---|
| `create_olf_rte` (+100 iter), terminal-only trip, OpenLoadFlow | baseline (shipped) | 95.84 % | — |
| → `parameters_hades2` **LF params** | the Hades2 voltage-control bundle: shunt + PST control **off**, most-meshed-over-all-VL slack, `AFTER_GENERATOR_VOLTAGE_CONTROL` / initial-tap / `MAX_VOLTAGE_CHANGE` tuning. **NOT** `distributed_slack` — toggling it True/False changes nothing on this grid (verified). | 95.99 % | +0.15 % |
| → `contingencyPropagation=true` (**contingency model**) | the SecurityAnalysis trips the line at **breaker level**: it propagates the disconnection through closed switches and opens the full electrical node (`P.SAOP3` node 6 / `RONCIP3` node 4), not just the line's two terminals. | 96.08 % | +0.09 % |
| → **real Hades2 solver** (`pypowsybl-rte`) | OpenLoadFlow's Hades2-*emulation* → the actual Hades2 Newton-Raphson engine. | 96.10 %? | +0.02 % |

1. **Outer-loop iteration cap (convergence, factor 0).** `create_olf_rte_parameter`
   (`make_env_utils`, the backend **diagram / overload** path) does **not** set
   `maxOuterLoopIterations`, so it inherited OpenLoadFlow's stock **20**. On the
   French grid the `IncrementalTransformerVoltageControl` outer loop needs
   ~40–50 iterations to settle after the trip → `MAX_ITERATION_REACHED` / null
   flows. The lib's `_create_default_lf_parameters` (grid2op **analysis** path)
   already uses **100** (lib `simulation-pipeline.md` §3.6). **Shipped fix:**
   `_run_ac_with_fallback` now forces 100.

2. **`contingencyPropagation` — the SA-vs-`run_ac` gap is *entirely* this.**
   With the *same* `parameters_hades2`, a pypowsybl `SecurityAnalysis` and a
   manual `run_ac` on a disconnected variant differ by exactly the SA provider
   parameter `contingencyPropagation` (default **true**):

   | mechanism | loading |
   |---|---|
   | SA, `contingencyPropagation=true` (default) | **96.08 %** (226.750 A) |
   | SA, `contingencyPropagation=false` | 95.98 % (226.522 A) |
   | `run_ac` on opened terminals / `remove_elements` | 95.98–95.99 % (226.52 A) |

   So this is a **contingency-modelling** choice internal to the SecurityAnalysis,
   **not** a load-flow parameter — there is no `lf.Parameters` knob that closes it.

   **Can the +0.1 % be replicated with a manual breaker trip? No (tested).** The
   line sits behind a breaker `P.SAO3RONCI.1 DJ_OC` at `P.SAOP3` (node 6↔7) and a
   load-break switch `RONCI3P.SAO.1 SRB.1_OC` at `RONCIP3` (node 4↔6). Opening
   **both** bay switches via `run_ac` (a clean breaker trip) gives **226.524 A /
   95.98 %** — i.e. *identical* to the app's current terminal-only
   `update_lines(connected1/2=False)` (226.527 A). So the app is **not**
   under-disconnecting. The SA's `contingencyPropagation=true` value (226.752 A) is
   only approached by opening the `RONCIP3` switch **alone** (226.730 A), which
   leaves the line **dangling and energised** at `P.SAOP3` (its shunt still
   injecting) — a physically invalid trip state, not a faithful model. No
   neighbouring load / generator / branch sits on the bay nodes, so propagation
   trips nothing extra. **Conclusion:** the +0.1 % is a SecurityAnalysis-internal
   numerical artefact of how the post-contingency `LfNetwork` is built, *not* a
   reproducible clean topology operation. The grid2op / `run_ac` value
   (95.98–95.99 %) is the physically-correct clean-trip result.

   To get the SA figure in the app you must therefore **run a SecurityAnalysis**
   for the contingency (which bakes in `contingencyPropagation`), not patch the
   disconnection. On this grid `n.disconnect("P.SAOL31RONCI")` returns `False`
   (no-op) anyway, so the backend's `_apply_contingency_element` already falls back
   to terminal-only `update_lines`.

3. **Hades2 provider (`pypowsybl-rte`).** The reference JSON was produced by
   RTE's **Hades2** solver. `pypowsybl-rte` registers a `Hades2` load-flow /
   security provider, but the **native Hades2 module must be installed and
   declared** in `~/.itools/config.yml` (a `hades2:` section pointing at its
   `homeDir`). Without it, `provider="Hades2"` raises
   `PyPowsyblError: hades2 module is absent of the platform config`. The figures
   in the "Hades2 provider" rows above are **to be filled in from a properly
   configured Hades2 run** — `parameters_hades2` is OpenLoadFlow's *emulation* of
   it and lands at 96.08 %, ~0.02 % shy of the 96.10 % reference.

   Installing `pypowsybl-rte` does **not** change anything for OpenLoadFlow:
   verified that the LF/SA **default provider stays `OpenLoadFlow`** (it only
   *adds* `Hades2` to the provider list), and the OpenLoadFlow figures are
   byte-identical with or without `pypowsybl-rte` (reduced N-1 233.04 A, full
   N-1 226.75 A, full + CHALOY631 226.60 A). So the reproduction script runs
   unchanged; only an actual configured Hades2 module would move the last
   ~0.02 %.

## How to reach the reference in the live app

| Goal | Change | Result |
|---|---|---|
| Stop the full-grid slow-mode divergence | **Shipped.** `recommender_service._run_ac_with_fallback` now forces `maxOuterLoopIterations=100` on the diagram-path params (the single choke point behind all `create_olf_rte_parameter()` call sites in `_get_n_variant` / `_get_contingency_variant` / `diagram_mixin`). Convergence-only; grids that already converged are unchanged, and the grid2op analysis path is untouched (the lib already uses 100). | Slow mode converges → **95.84 %** |
| Close most of the gap (LF params) | Swap the diagram-path params to `parameters_hades2` (the Hades2 voltage-control bundle). | **95.99 %** |
| Match the SecurityAnalysis reference (OpenLoadFlow) | `parameters_hades2` **and run the contingency through a `SecurityAnalysis`** (so `contingencyPropagation` applies). It is *not* reproducible by opening breakers in `run_ac` — a clean breaker trip equals the terminal-only value (tested, see factor 2). It needs the SA mechanism. | **96.08 %** |
| Match the RTE reference exactly (96.10 %) | Run the **Hades2 provider** (`pypowsybl-rte` + the native Hades2 module configured in `~/.itools/config.yml`). `parameters_hades2` is OpenLoadFlow's emulation of it. | **96.10 %** (TBC — see § factor 3) |

The small grid (`config_small_grid`) is deliberately **left as-is** — it is a
93-VL Dijon reduction whose post-contingency redistribution does not preserve
the full-grid flow (it reads 97.9 % live / 98.75 % under the Hades2 SA
reference). See the script header for the full rationale.

## Provenance

- Reference grid & recipe trace back to the recommender notebook
  `analyse_bare_grid_env.ipynb` (full grid `bare_env_20240828T0100Z`,
  `parameters_hades2`, `pp.security` SecurityAnalysis).
- pypowsybl **1.14** and **1.15** produce identical flows here — the LF
  version is **not** a factor. The factors are: the grid (reduced vs full),
  the outer-iteration cap (convergence), the Hades2 LF-parameter bundle, the
  `contingencyPropagation` contingency model, and finally the Hades2 vs
  OpenLoadFlow solver.
