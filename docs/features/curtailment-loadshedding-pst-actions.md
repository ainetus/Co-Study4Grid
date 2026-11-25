# Renewable Curtailment, Load Shedding, Redispatching & PST Actions — Implementation Status

This document describes the implementation of renewable curtailment, load shedding, **redispatching**, and **Phase Shifting Transformer (PST)** actions in Co-Study4Grid. It covers the power reduction format (`set_load_p`/`set_gen_p`) introduced in [Expert_op4grid_recommender PR #74](https://github.com/marota/Expert_op4grid_recommender/pull/74), as well as PST tap actions and their integration with the superposition estimation engine.

## 1. Action Format Evolution

### Legacy Format (bus disconnection)

The original implementation disconnected loads/generators from the grid by setting their bus to -1:

```python
# Load shedding
{"set_bus": {"loads_id": {"LOAD_1": -1}}}
# Topology: loads_bus = {"LOAD_1": -1}

# Renewable curtailment
{"set_bus": {"generators_id": {"WIND_1": -1}}}
# Topology: gens_bus = {"WIND_1": -1}
```

This completely disconnects the element, losing voltage support and reactive power.

### New Format (power reduction)

PR #74 introduces active power setpoint changes that keep elements electrically connected:

```python
# Load shedding — reduce load to target MW
{"set_load_p": {"LOAD_1": 0.0}}
# Topology: loads_p = {"LOAD_1": 0.0}

# Renewable curtailment — reduce generation to target MW
{"set_gen_p": {"WIND_1": 0.0}}
# Topology: gens_p = {"WIND_1": 0.0}
```

The target MW can be any value between 0 and the current production/consumption, enabling **partial** load shedding and curtailment (configurable MW slider — planned feature).

### New Metadata Fields

The recommender library now provides explicit metadata on power reduction actions:
- `target_p_MW`: The target power setpoint value
- `reduction_MW`: The actual amount of power reduced
- `mw_required`: The required MW reduction amount

## 2. Library Interface (expert_op4grid_recommender)

### Configuration
- `config.MIN_LOAD_SHEDDING` (int): Minimum number of load shedding actions to recommend.
- `config.MIN_RENEWABLE_CURTAILMENT_ACTIONS` (int): Minimum number of curtailment actions to recommend.
- `config.MIN_REDISPATCH` (int): Minimum number of redispatching actions to recommend.

### Action Classification
`ActionClassifier` classifies actions as:
- `"load_shedding"` / `"load_power_reduction"` — actions that reduce load consumption
- `"renewable_curtailment"` / `"gen_power_reduction"` / `"open_gen"` — actions that reduce renewable generation
- `"gen_redispatch"` — actions that raise or lower a dispatchable generator (signed `set_gen_p` delta)

### Recommendation Results
The analysis output includes:
- `action_scores["load_shedding"]` — scores and `mw_start` for load shedding actions
- `action_scores["renewable_curtailment"]` — scores and `mw_start` for curtailment actions

## 3. Backend Implementation

### Configuration (`main.py`)
- `ConfigRequest` includes `min_load_shedding: int` and `min_renewable_curtailment_actions: int`
- Propagated to `config.MIN_LOAD_SHEDDING` and `config.MIN_RENEWABLE_CURTAILMENT_ACTIONS`

### Network Service (`network_service.py`)
- `get_load_voltage_level(load_id)` — resolves load ID to its voltage level
- `get_generator_voltage_level(gen_id)` — resolves generator ID to its voltage level

### Recommender Service (`recommender_service.py`)

#### Action Enrichment (`_enrich_actions`)
Extracts topology fields from action objects, including both legacy and new fields:
```python
for field in ("lines_ex_bus", "lines_or_bus", "gens_bus", "loads_bus",
              "pst_tap", "substations", "switches", "loads_p", "gens_p"):
```

#### Load Shedding Details (`_compute_load_shedding_details`)
Detects affected loads from **both** formats:
1. Legacy: `loads_bus` entries with `bus == -1`
2. New: `loads_p` attribute on the action object, or `set_load_p` in action content

Returns `[{load_name, voltage_level_id, shedded_mw}]` computed by comparing N-1 and post-action observations.

#### Curtailment Details (`_compute_curtailment_details`)
Same dual-format detection for generators:
1. Legacy: `gens_bus` entries with `bus == -1`
2. New: `gens_p` attribute on the action object, or `set_gen_p` in action content

Returns `[{gen_name, voltage_level_id, curtailed_mw}]`. Only includes generators identified as renewable by `_is_renewable_gen()`.

#### MW Start Computation
`_mw_start_load_shedding()` and `_mw_start_curtailment()` check for both formats:
1. New format first: `content.set_load_p` / `content.set_gen_p`
2. Legacy fallback: `content.set_bus.loads_id` / `content.set_bus.generators_id` with `bus == -1`
3. Action ID pattern fallback: `load_shedding_<name>` / `curtail_<name>`

#### Dynamic Action Creation
When a user manually simulates `load_shedding_<name>` or `curtail_<name>`, the backend creates the action on-the-fly using the **new format**:
```python
# load_shedding_LOAD_1 → topology: {"loads_p": {"LOAD_1": 0.0}}
# curtail_WIND_1       → topology: {"gens_p": {"WIND_1": 0.0}}
```

#### Topology Reconstruction (`_build_action_entry_from_topology`)
Maps topology fields to action content:
- `loads_p` → `content.set_load_p`
- `gens_p` → `content.set_gen_p`
- Legacy `loads_bus` → `content.set_bus.loads_id` (unchanged)

## 4. Frontend Implementation

### Types (`types.ts`)
```typescript
interface ActionTopology {
    lines_ex_bus: Record<string, number>;
    lines_or_bus: Record<string, number>;
    gens_bus: Record<string, number>;
    loads_bus: Record<string, number>;
    pst_tap?: Record<string, unknown>;
    substations?: Record<string, unknown>;
    switches?: Record<string, unknown>;
    loads_p?: Record<string, number>;   // New power reduction
    gens_p?: Record<string, number>;    // New power reduction
}

interface LoadSheddingDetail {
    load_name: string;
    voltage_level_id: string | null;
    shedded_mw: number;
}

interface CurtailmentDetail {
    gen_name: string;
    voltage_level_id: string | null;
    curtailed_mw: number;
}
```

### Action Feed (`ActionFeed.tsx`)
- **Filtering**: `Load Shedding` and `Renewable Curtailment` checkbox filters in manual selection search
- **Score table**: Shows `MW Start` column (current load/generation MW before action)
- **Action cards**:
  - Load shedding details: amber background (`#fef3c7`), shows shedded MW and load name per load
  - Curtailment details: light blue background (`#e0f2fe`), shows curtailed MW and generator name
  - Clickable voltage level badges for navigation
- **Equipment badges**: Extracted from `loads_p`/`gens_p` in addition to `loads_bus`/`gens_bus`

### SVG Utilities (`svgUtils.ts`)
- Target detection accounts for `loads_p`/`gens_p` when determining affected equipment
- Line reconnection check excludes actions with `loads_p`/`gens_p` (not pure reconnections)

### Visualization Panel (`VisualizationPanel.tsx`)
- Target equipment IDs include elements from `loads_p`/`gens_p` for highlighting

### Session Persistence
- `sessionUtils.ts` serializes `action_topology` (including `loads_p`/`gens_p`) and `load_shedding_details`/`curtailment_details` in session snapshots
- Session restore reconstructs actions via `_build_action_entry_from_topology()` which handles both formats

## 5. Testing

### Backend (`expert_backend/tests/`)
- `test_power_reduction_format.py` — 23 tests covering all new format scenarios:
  - Detection of loads_p/gens_p in compute details functions
  - MW start extraction from set_load_p/set_gen_p
  - Topology-to-content mapping
  - Dynamic action creation with new format
  - Backwards compatibility with legacy format
- `test_renewable_curtailment.py` — curtailment detail computation and config updates
- `test_manual_action_enrichment.py` — enrichment with new topology format
- `test_dynamic_actions.py` — on-the-fly action creation
- `test_mw_start.py` — MW start computation for all action types
- `test_configurable_mw.py` — 8 tests for configurable MW reduction:
  - Partial load shedding with target_mw (setpoint = current - target, clamped >= 0)
  - Partial curtailment with target_mw
  - Full shedding/curtailment when target_mw is omitted
  - Clamping when target_mw exceeds current MW
  - Re-simulation of existing actions with updated target_mw
  - Content unchanged when target_mw is not provided on re-simulation

### Frontend (`frontend/src/`)
- `ActionFeed.test.tsx` — rendering of load shedding/curtailment details with both topology formats, Target MW input in score table, editable MW + re-simulate in action cards
- `svgUtils.test.ts` — target detection with loads_p/gens_p fields

## 6. Configurable MW Reduction

Users can choose how much MW to reduce when simulating load shedding or curtailment actions, enabling **partial** reductions instead of full disconnection.

### Semantics

- **Target MW** = the amount of MW to reduce (not the remaining setpoint)
- **Setpoint** = `current_mw - target_mw` (clamped to >= 0)
- When `target_mw` is omitted, full reduction is applied (setpoint = 0)

### API

`POST /api/simulate-manual-action` accepts an optional `target_mw` field:

```json
{
    "action_id": "load_shedding_LOAD_1",
    "disconnected_element": "LINE_X",
    "target_mw": 30.0
}
```

### Backend (`recommender_service.py`)

#### Dynamic Action Creation
When creating `load_shedding_<name>` or `curtail_<name>` actions on-the-fly:
1. Look up current MW from the N-1 observation (`obs_n1.load_p` / `obs_n1.gen_p`)
2. Compute `remaining = max(0, current_mw - target_mw)`
3. Use `remaining` as the setpoint in `loads_p` / `gens_p`

#### Re-simulation of Existing Actions
When `target_mw` is provided for an action already in `_dict_action`:
1. Update `set_load_p` or `set_gen_p` entries in the content with the new setpoint
2. The updated content is then used by `env.action_space()` for simulation

### Frontend (`ActionFeed.tsx`)

#### Score Table (Manual Selection)
- **Target MW column**: Shown for `load_shedding` and `renewable_curtailment` score table sections
- Input field: number input (0 to MW Start), pre-filled with placeholder = MW Start
- Clicking a row passes the entered `target_mw` to `simulateManualAction`

#### Action Card Detail Boxes
- **Reduction MW input**: Editable number field in load shedding (amber) and curtailment (blue) detail boxes
- **Re-simulate button**: Triggers `simulateManualAction` with the new `target_mw` value
- Default value: the total shedded/curtailed MW from the current simulation result
- The action card updates in-place with the new simulation results

## 7. Redispatching

Redispatching is the third member of the injection-action family. Like
curtailment it changes a generator's active-power setpoint through the
`set_gen_p` format and keeps the unit electrically connected — but where
curtailment only **reduces** renewable generation to a target MW,
redispatching raises **or** lowers a *dispatchable* generator by an
editable **signed** delta (default `±10 MW`, floored at 0).

### Action Format

```python
# Redispatch — set the generator to its current output ± a signed delta
{"set_gen_p": {"GEN_1": 110.0}}
# Topology: gens_p = {"GEN_1": 110.0}
```

The encoded value is the new production magnitude (pypowsybl
`target_p` convention, production-positive). A positive delta raises
the unit, a negative one lowers it; the resulting setpoint is never
below 0. Action IDs are prefixed `redispatch_`.

### Configuration

- `config.MIN_REDISPATCH` (int) — minimum number of redispatching
  actions to recommend (alongside `MIN_LOAD_SHEDDING` /
  `MIN_RENEWABLE_CURTAILMENT_ACTIONS`).
- `config.REDISPATCH_DEFAULT_DELTA_MW` — the default signed delta
  (`±10 MW`) used when the operator hasn't entered one.

### Setpoint computation

`compute_redispatch_setpoint(gen_name, delta_mw, obs_n1, default_delta_mw=10.0)`
(`services/simulation_helpers.py`) returns `max(0, current_mw + delta)`,
working in production-positive magnitude. Unlike
`compute_reduction_setpoint` (which *subtracts* a reduction from the
current output), it *adds* the signed delta. It falls back to the
default delta when no delta is supplied or the generator cannot be
located on the observation.

### Redispatch Details

`compute_redispatch_details` (`services/analysis/action_enrichment.py`)
attaches per-generator details to `redispatch_`-prefixed actions:
`{gen_name, voltage_level_id, delta_mw, target_mw, direction, ...}`,
where `delta_mw` is the signed change (`> 0` = raise, `< 0` = lower),
`target_mw` the resulting production magnitude, and `direction` either
`"up"` or `"down"`. The delta is computed against the encoded
`set_gen_p` target (not the post-load-flow output) so slack
redistribution can't mislead the operator about the intended increment.

### Frontend

Redispatching gets its own `'redispatch'` filter token, an
`ActionTypeIcon` up/down-arrow glyph, and an editable **signed**-delta
MW input + Re-simulate control (cloned from the curtailment editor but
allowing negative values).

## 8. Evacuation-Antenna Aggregates (recommender 0.3.4+)

expert_op4grid_recommender 0.3.4 turns on its evacuation-antenna levers by
default (`EVACUATION_ANTENNA_LEVERS`). An evacuation antenna is a part of the
grid tied to the constrained path through one node, whose production leaves
through that node. Its generators become curtailment / redispatch candidates
(`curtail_<gen>`, `redispatch_<gen>`, unchanged), and each antenna also gets
**one MW-sized option spread pro rata over its generators**:

| Id | Generators | Direction |
|----|------------|-----------|
| `curtail_<antenna_id>` | the antenna's renewables | lowered |
| `redispatch_<antenna_id>` | its dispatchable units | lowered upstream, raised downstream (within `Pmax`) |

Their id names the antenna (e.g. `curtail_EVAC_SOULLP4_1`), not a generator,
so — unlike every other dynamic action — they cannot be rebuilt from the id.
The generators and their new setpoints are in the score params,
`action_scores[<type>]["params"][<id>]`: `gen_names`, `target_p_MW` (a dict,
a float for the per-generator candidates), `evacuation_antenna_id`,
`substation` (the attachment node the change is sized on), `direction`
(redispatch).

### Backend (`services/antenna_aggregates.py`)

- **Simulation of an unprioritized aggregate** (score table, pin, search by
  id): `_create_dynamic_actions_if_needed` looks the id up in the last
  analysis' `action_scores` (`antenna_aggregate_params`) and builds the entry
  at the recommender's setpoints (`antenna_aggregate_entry`) — never a
  generator parsed out of the antenna id.
- **Description**: the library leaves it empty for the actions its discovery
  creates. `_enrich_actions` and the simulation paths fill it in the style of
  the per-generator actions: `Effacement antenne '<antenna>' ('<gen>', …)`,
  `Redispatch hausse|baisse antenne '<antenna>' (…)`.
- **MW at start**: `_compute_mw_start_for_scores` reads the generators from
  the params, so the score table's `MW Start` is the antenna's total
  production.
- **Edited MW is the action's total**, spread over its elements by
  `split_target_mw` (`simulation_helpers.py`) the way the recommender sizes
  the aggregate: by current production (curtailment, load shedding, lowering
  redispatch) or by headroom up to `obs.gen_pmax` (raising redispatch;
  production when `Pmax` is unknown). A single-element action takes the whole
  target, as before.

### Frontend (`utils/injectionActions.ts`)

- The action card shows **one** MW editor per injection family, named after
  all its elements (per-element MW in the tooltip), on the **total**
  (`totalReductionMw`, `redispatchTotal`: summed delta, headroom and bounds).
  It used to render one input per element, all bound to the same value.
- The score table and the Explore Pairs tab default their MW input to the
  same totals (they read the first element only).
- Simulating an aggregate before any card carries its topology sends its
  generators as `action_content` (`antennaAggregateContent`, read from the
  score params): after a session reload the backend no longer holds the
  analysis that proposed it.

The overflow graph draws the antennas themselves (expertop4grid 0.3.4: kept
in the reduced view, in ochre, with an *Evacuation antennas* viewer layer —
see [`interactive-overflow-analysis.md`](interactive-overflow-analysis.md)),
and the `result` event forwards the detected antennas as
`structural_antennas`.

## 9. PST (Phase Shifting Transformer) Actions

PST actions change the tap position of a phase-shifting transformer to redirect power flows and relieve overloads. Unlike topology actions (switching, coupling) or power reduction actions (curtailment, load shedding), PST actions modify a continuous parameter.

### Action Format

```python
# PST tap change
{"pst_tap": {".ARKA TD 661": 32}}
# Topology: pst_tap = {".ARKA TD 661": 32}
```

The tap value is an integer within the transformer's valid range (e.g., `[0..32]`).

### Action Classification

`ActionClassifier.identify_action_type()` returns `"pst"` or `"pst_tap"` for PST actions. The action ID convention is `pst_tap_<transformer_name>_inc<N>` (e.g., `pst_tap_.ARKA TD 661_inc2`).

### Configurable Tap Position

Users can manually adjust the target tap value when simulating PST actions, similar to configurable MW for load shedding/curtailment.

#### API

`POST /api/simulate-manual-action` accepts an optional `target_tap` field:

```json
{
    "action_id": "pst_tap_.ARKA TD 661_inc2",
    "disconnected_element": "LINE_X",
    "target_tap": 30
}
```

#### Backend (`recommender_service.py`)

When `target_tap` is provided:
1. The `content.pst_tap` dictionary is updated with the new tap value
2. The action entry in `_dict_action` is merged (preserving library keys)
3. Simulation runs with the updated tap position

#### Frontend

- **Action card**: Shows editable tap input with valid range `[0..max_tap]`
- **Re-simulate button**: Triggers re-simulation with updated `target_tap`
- **PST details**: Purple background (`#f3e8ff`), shows transformer name and tap value
- **Combined actions**: After re-simulation, refreshes all combined pair estimations involving this PST action

### PST Details Metadata

```python
# Backend returns:
{
    "pst_details": [
        {"pst_name": ".ARKA TD 661", "tap_position": 32, "low_tap": 0, "high_tap": 32, "tap_start": 24}
    ]
}
```

### Dynamic PST Action Creation

When a user manually simulates `pst_tap_<name>_inc<N>`, the backend:
1. Extracts the transformer name from the action ID
2. Looks up the current tap position from the N-1 observation
3. Computes `new_tap = current_tap + N` (clamped to valid range)
4. Creates topology: `{"pst_tap": {"<name>": new_tap}}`

## 10. PST Actions in Superposition Estimation

PST tap changes require special handling in the superposition theorem because they don't disconnect/reconnect elements. The standard no-op detection (comparing line status arrays) fails for PSTs.

### The `is_pst` Flag

When computing superposition for a pair that includes a PST action, the backend passes `act1_is_pst=True` or `act2_is_pst=True` to `compute_combined_pair_superposition()`. This tells the library to use **flow-based no-op detection** (comparing `p_or` deltas) instead of line-status comparison.

```python
# In compute_superposition():
act1_is_pst = _is_pst_action(action1_id)
act2_is_pst = _is_pst_action(action2_id)

result = compute_combined_pair_superposition(
    ...,
    act1_is_pst=act1_is_pst,
    act2_is_pst=act2_is_pst,
)
```

Detection heuristic (`_is_pst_action`):
- `ActionClassifier.identify_action_type()` returns `"pst"` or `"pst_tap"`
- OR the action ID contains `"pst_tap"` or `"pst_"`

### PST Element Identification Fallback

`_identify_action_elements()` may return empty line indices for PST actions (since they don't disconnect lines). The fallback extracts the transformer index from the `pst_tap` content in `_dict_action`:

```python
if len(line_idxs) == 0 and _is_pst_action(aid):
    pst_content = _dict_action.get(aid, {}).get("content", {}).get("pst_tap", {})
    for pst_name in pst_content:
        idx = name_line.index(pst_name)  # find index in env.name_line
        line_idxs = [idx]
```

### Re-simulation and Combined Pair Refresh

When a PST tap is re-simulated at a different position:
1. The PST action's observation is updated in `_last_result["prioritized_actions"]`
2. All combined pairs containing this PST action are re-estimated via `refreshCombinedEstimations()`
3. The superposition formula uses the updated observation for the new betas computation

## 11. Monitoring Consistency (Estimation vs Simulation)

The superposition estimation (`compute_superposition`) and the full simulation (`simulate_manual_action`) must use the **same set of monitored lines** for `max_rho` computation. Inconsistency leads to the estimation and simulation reporting different worst-case lines.

### Monitored Lines Definition

Both paths use a `care_mask` built identically:

1. **lines_we_care_about** — from analysis context or all lines (configurable)
2. **AND branches_with_limits** — lines with permanent thermal limits in pypowsybl (type=CURRENT, acceptable_duration=-1)
3. **EXCLUDE** pre-existing N-state overloads unless the action **worsens** them beyond a threshold (default 2%)
4. **FORCE-INCLUDE** `lines_overloaded_ids` — the N-1 overloaded lines under active monitoring

```
care_mask = (lines_we_care_about & branches_with_limits)
          & ~(pre_existing & not_worsened)
          | lines_overloaded_ids
```

### lines_overloaded_ids Priority

Both `compute_superposition` and `simulate_manual_action` use the same priority for determining `lines_overloaded_ids`:

1. **Analysis context** (`_analysis_context["lines_overloaded"]`) — set during step1 analysis, contains line names already filtered by monitoring parameters
2. **Recomputation fallback** — lines with `rho >= monitoring_factor` in N-1 state, filtered by `lines_we_care_about` AND `branches_with_limits`

### branches_with_limits Resolution

The `_get_monitoring_parameters()` method queries pypowsybl for permanent thermal limits:

```python
limits = network.get_operational_limits()
perm_limits = limits[(limits['type'] == 'CURRENT') & (limits['acceptable_duration'] == -1)]
branches_with_limits = set(perm_limits['element_id'].unique())
```

If this query fails (e.g., `'type'` column not found), the fallback includes ALL lines. This warning appears as:
```
Warning: Failed to identify branches with limits: 'type'
```

### Superposition Estimation Accuracy

The superposition formula `rho_combined = |(1-β₁-β₂)·ρ_N1 + β₁·ρ_act1 + β₂·ρ_act2|` is a **linear approximation** of the nonlinear power flow. Typical accuracy is within ~1-2% of the full simulation, but:

- Lines with loading driven by **nonlinear redistribution** (not direct action effect) may be under/overestimated
- When two lines have very close loading (e.g., 93.1% vs 93.6%), the ~1% estimation error can **flip the ranking** of which line appears as the worst
- The estimated `max_rho_line` may differ from the simulated one, even though both are within the accuracy band
- This is an inherent limitation of the linear superposition approach, not a code bug

**Example from real data:**

| Line | Estimated rho | Simulated rho | Error |
|------|--------------|---------------|-------|
| CANTEY761 | 93.6% | 92.8% | +0.8% (overestimate) |
| .BIESL61PRAGN | 93.1% | 94.4% | -1.3% (underestimate) |

Estimation picks CANTEY761 as worst; simulation picks .BIESL61PRAGN. Both are correct within the linear approximation error band.

## 12. Testing

### Backend (`expert_backend/tests/`)

#### Load Shedding & Curtailment Tests
- `test_power_reduction_format.py` — 23 tests for new format scenarios
- `test_renewable_curtailment.py` — curtailment detail computation
- `test_manual_action_enrichment.py` — enrichment with new topology format
- `test_dynamic_actions.py` — on-the-fly action creation
- `test_mw_start.py` — MW start computation for all action types
- `test_configurable_mw.py` — 8 tests for configurable MW reduction
- `test_antenna_aggregates.py` — evacuation-antenna aggregates: params
  lookup, descriptions, pro-rata `split_target_mw`, rebuild from the score
  params, MW at start, card description

#### PST & Superposition Tests
- `test_superposition_service.py` — PST flag passing, element identification fallback, dict_action merge preservation
- `test_superposition_accuracy.py` — estimation vs simulation discrepancy detection
- `test_superposition_filtering_regression.py` — heavily loaded lines not filtered from max_rho
- `test_superposition_monitoring_consistency.py` — 11 tests for monitoring alignment:
  - Lines without thermal limits excluded from max_rho (CIVAUY712 regression)
  - Fallback lines_overloaded_ids filtered by lines_we_care_about AND branches_with_limits
  - N-1 overloaded lines force-included despite pre-existing N-state overloads
  - Analysis context lines_overloaded takes priority over recomputation
  - Pre-existing N-state overloads excluded unless combined action worsens them
  - Pre-existing overloads included when worsened beyond threshold
  - All monitored lines eligible without N-state overloads
  - Global max scan across all monitored lines (no caching)
  - PST + switching pair monitors same lines as switching + switching
  - is_rho_reduction computed on overloaded lines
  - max_rho scaled by monitoring_factor

### Frontend (`frontend/src/`)
- `ActionFeed.test.tsx` — rendering of load shedding/curtailment/PST details
- `ActionCard.test.tsx` / `utils/injectionActions.test.ts` — one MW editor on
  the total of a multi-element action, summed redispatch headroom, aggregate
  content from the score params
- `CombinedActionsModal.test.tsx` — combined action pair computation modal
- `svgUtils.test.ts` — target detection with all topology formats
