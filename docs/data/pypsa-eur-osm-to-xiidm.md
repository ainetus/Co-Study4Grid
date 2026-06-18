# PyPSA-Eur OSM to XIIDM Conversion Pipeline



This document captures the full investigation, implementation, pitfalls, and results of converting the PyPSA-Eur OpenStreetMap power grid dataset into a pypowsybl-compatible XIIDM network file for use in Co-Study4Grid.



## Objective



Build a **non-anonymized** XIIDM network of the French 400 kV transmission grid with real geographical coordinates, real OSM substation/circuit names, operational limits calibrated for realistic N-1 overloads, and a double-busbar topology with coupling breaker actions — all ready for contingency analysis in Co-Study4Grid.



## Data Source



**Zenodo Record 18619025** — PyPSA-Eur OSM network components (raw CSV exports from OpenStreetMap).



Downloaded files (stored in `data/pypsa_eur_osm/`):



| File | Size | Records | Key columns |

|------|------|---------|-------------|

| `buses.csv` | 805 KB | 6 863 | voltage, dc, symbol, under_construction, x (lon), y (lat), country |

| `lines.csv` | 19.8 MB | 9 162 | bus0, bus1, r, x, b, s_nom, i_nom, circuits, v_nom, geometry |

| `transformers.csv` | 122 KB | 878 | bus0, bus1, s_nom |

| `links.csv` | 323 KB | — | (HVDC links, not used) |

| `converters.csv` | 9 KB | — | (AC/DC converters, not used) |



**CSV parsing note**: `lines.csv` and `transformers.csv` require `quotechar="'"` because the `geometry` column contains LINESTRING coordinates with embedded commas.



## Pipeline Overview



The pipeline is a chain of sub-scripts under `scripts/pypsa_eur/`, orchestrated by `build_pipeline.py`. `fetch_osm_names.py` is a cached one-time data preparation step; the other four run sequentially to build and finalize the network.



0. **`scripts/pypsa_eur/build_pipeline.py`** — End-to-end orchestrator; chains the five steps below and supports `--from-step`, `--steps`, `--skip-osm`, `--voltages`

1. **`scripts/pypsa_eur/fetch_osm_names.py`** — Fetches real RTE substation and circuit names from the Overpass API (cached)

2. **`scripts/pypsa_eur/convert_pypsa_to_xiidm.py`** — Builds the XIIDM from OSM CSVs with names, initial limits, and metadata (actions, grid_layout, mappings)

3. **`scripts/pypsa_eur/calibrate_thermal_limits.py`** — Recalibrates per-line thermal limits via AC security analysis so the N-1 peak is capped near 130% and ≥2% of contingencies overload

4. **`scripts/pypsa_eur/add_detailed_topology.py`** — Introduces double-busbar topology with coupling breakers at major substations + appends coupler actions

5. **`scripts/pypsa_eur/generate_n1_overloads.py`** — Produces the final `n1_overload_contingencies.json` report via `pp.security`



*(Legacy)* `scripts/pypsa_eur/add_limits_and_overloads.py` was an earlier single-pass calibration entry point; it's superseded by steps 2+3 above but remains available.



```

Overpass API (one-time)

    │

    ▼

fetch_osm_names.py

    │  Query OSM for ref:FR:RTE, ref:FR:RTE_nom, name tags

    │  Cache → data/pypsa_eur_fr400/osm_names.json

    │

    ▼

Raw CSVs (Zenodo) + osm_names.json

    │

    ▼

convert_pypsa_to_xiidm.py

    │  Step 1:  Load OSM names cache

    │  Step 2:  Filter → FR 380/400kV AC, main connected component

    │  Step 3:  Connected component verification (NetworkX)

    │  Step 4:  Build → substations, VLs, buses (node-breaker topology)

    │  Step 5:  Add generators + loads (geographic dispatch: SE gen → NW load)

    │  Step 6:  Add lines with impedances + raw OSM current limits

    │  Step 7:  Add 2-winding transformers

    │  Step 8:  Export → network.xiidm (with raw limits)

    │           Run AC loadflow → calibrate limits (rank-based 20-65% loading)

    │           N-1 verification pass → cap overloads at 130%

    │           Re-export XIIDM with calibrated limits

    │  Step 9:  Write grid_layout.json (Mercator projection, NAD-scaled)

    │  Step 10: Write bus_id_mapping.json

    │  Step 11: Generate actions.json (disco actions with content/set_bus)

    │           Write line_id_names.json

    │

    ▼

add_detailed_topology.py

    │  Step 1: Load network.xiidm (with calibrated limits)

    │  Step 2: Identify VLs with ≥4 branches (99 substations)

    │  Step 3: Create second busbar + coupling breaker per eligible VL

    │  Step 4: Dispatch branches round-robin across busbars

    │  Step 5: Generate coupling breaker actions → merge into actions.json

    │  Step 6: Re-export network.xiidm (final)

    │

    ▼

Output: data/pypsa_eur_fr400/

    ├── network.xiidm             (~1 MB, 99 coupling breakers)

    ├── grid.xiidm                (copy of network.xiidm)

    ├── grid_layout.json          (~11 KB, 192 VL entries)

    ├── actions.json              (~206 KB, 897 actions)

    ├── bus_id_mapping.json       (~9 KB)

    ├── osm_names.json            (~217 KB, substation + circuit names)

    ├── line_id_names.json        (~21 KB, line ID → display name)

    ├── vl_next_node.json         (~6 KB, node counter state for topology script)

    ├── n1_overload_contingencies.json  (~16 KB, pre-computed N-1 results)

    ├── network.m                 (MATPOWER export, informational)

    └── network_nad.svg           (~430 KB, full NAD preview)

```



> **Shipped compressed (0.8.0).** For the large France 225/400 kV grid
> the generated `network.xiidm` is committed **compressed** as
> `network.xiidm.zip` via Git LFS (the HuggingFace Space git endpoint
> requires LFS for binaries). `network_service` auto-decompresses it on
> load, so consumers point the network path at the `.xiidm` (or the
> `.zip`) and it Just Works — see
> [`../backend/README.md`](../backend/README.md) (`_resolve_network_file`
> / `_extract_network_zip`).



### How to run



```bash

# Recommended: run the full orchestrator (reproduces data/pypsa_eur_fr225_400)

python scripts/pypsa_eur/build_pipeline.py --voltages 225,400

```

The orchestrator chains five sub-scripts. Each can also be run standalone:

```bash

# Step 1 (optional, cached): fetch OSM names → data/pypsa_eur_osm/osm_names.json

python scripts/pypsa_eur/fetch_osm_names.py --voltages 225,400



# Step 2: OSM CSV → XIIDM + initial limits + metadata

python scripts/pypsa_eur/convert_pypsa_to_xiidm.py --voltages 225,400 --skip-n1



# Step 3: recalibrate thermal limits so N-1 peak ~= 130% and >=2% overloading contingencies

python scripts/pypsa_eur/calibrate_thermal_limits.py --network data/pypsa_eur_fr225_400



# Step 4: add double-busbar topology + coupling breaker actions

python scripts/pypsa_eur/add_detailed_topology.py --network data/pypsa_eur_fr225_400 --voltages 225,400



# Step 5: final N-1 overload report

python scripts/pypsa_eur/generate_n1_overloads.py --network data/pypsa_eur_fr225_400

```

The orchestrator accepts `--from-step N`, `--steps 3,4,5`, `--skip-osm`, and `--voltages 400` for other presets.



### Running tests



```bash

# Full pipeline test suite (97 tests)

venv_expert_assist_py310/bin/python -m pytest scripts/pypsa_eur/test_pipeline.py -v



# Grid layout tests (19 tests)

venv_expert_assist_py310/bin/python -m pytest scripts/pypsa_eur/test_grid_layout.py -v



# N-1 calibration tests

venv_expert_assist_py310/bin/python -m pytest scripts/pypsa_eur/test_n1_calibration.py -v

```



## OSM Names (`fetch_osm_names.py`)



### Motivation



The raw PyPSA-EUR CSVs use opaque OSM identifiers like `way/426020732` and `relation/5995927` for buses and lines. French transmission operators use RTE substation codes (e.g., "BOUTRE", "CHARPENAY") and circuit names (e.g., "Avelin - Weppes 1"). These real names make the UI far more usable.



### Implementation



The script queries the **Overpass API** for all OSM objects referenced by the French 400 kV network, extracting:



- `ref:FR:RTE` — RTE substation code (e.g., "BOUTRE")

- `ref:FR:RTE_nom` — full RTE name

- `name` — OSM human-readable name (e.g., "Poste de Boutre")

- `power` — object type (substation, circuit, line)



Results are cached in `osm_names.json` with the structure:



```json

{

  "substations": {

    "way/100087916": {"name": "BOUTRE", "ref_rte": "BOUTRE", "power": "substation"},

    ...

  },

  "circuits": {

    "relation/6221844": {"name": "Avelin - Weppes 1", "ref_rte": "AVELIL71WEPPE", "power": "circuit"},

    ...

  }

}

```



The script includes rate limiting (1 request/second) and caching — re-running skips already-fetched IDs unless `--force` is passed.



### Coverage



Out of 192 substations: ~175 have real RTE names from OSM.

Out of 398 lines: ~381 have real circuit names from OSM. The remaining 17 lines have only raw OSM identifiers (e.g., `way/426020732-400`).



### Fallback display names for unnamed lines



For the 17 lines without real OSM names, two fallback mechanisms produce readable names:



1. **At XIIDM generation time** (`convert_pypsa_to_xiidm.py`): `_line_name()` constructs a composite name from the voltage-level endpoint names, e.g., "CHARPENAY — ST-VULBAS-EST". This name is written into the XIIDM `name` attribute.



2. **At runtime in the backend** (`network_service.get_element_names()`): detects raw OSM patterns (`way/...` or `relation/...`) in the pypowsybl name field and builds a composite from VL endpoint names, stripping voltage suffixes (e.g., "CHARPENAY 400kV" → "CHARPENAY"). This ensures the UI always shows human-readable names.



## Conversion Details



### Filtering (Step 2 of convert script)



Starting from 6 863 European buses, we filter to:



- `country == "FR"` (France only)

- `voltage in [380, 400]` (EHV transmission level)

- `dc == "f"` (AC only, no HVDC)

- `under_construction == "f"`



Lines are kept only if both endpoints pass the bus filter. Transformers are similarly filtered.



After filtering: **192 buses, 398 lines, 2 transformers**.



### Connected Component (Step 3)



A NetworkX graph verifies connectivity. The main connected component retains all 192 buses (no islands in this particular subset).



### IIDM Topology Model (Step 4)



The network uses **node-breaker topology**. Each equipment connects to a busbar section (node 0) via a disconnector + breaker chain:



```

[Busbar section, node 0] — DISCONNECTOR — BREAKER — [equipment node]

```



This is essential for the double-busbar extension in `add_detailed_topology.py`, which adds a second busbar section and rewires disconnectors.



**Critical constraint**: IIDM 2-winding transformers require both voltage levels to be in the **same substation**. The script builds a `bus_to_ss` mapping that merges transformer-connected buses into shared substations. Without this, pypowsybl raises: `"both voltage ids must be on the same substation"`.



Naming conventions:



- Substation: `SS_{safe_id(osm_bus_id)}` with `name` from OSM (e.g., "BOUTRE")

- Voltage level: `VL_{safe_id(osm_bus_id)}` with `name` from OSM + voltage suffix (e.g., "BOUTRE 400kV")

- Busbar section: `BBS_{safe_id(osm_bus_id)}_0`

- Generator: `G_{safe_id(osm_bus_id)}`

- Load: `L_{safe_id(osm_bus_id)}`

- Line: `{safe_id(osm_line_id)}` (with `_N` suffix for duplicates), `name` from OSM circuit name

- Transformer: `T_{safe_id(osm_trafo_id)}` with `name` from endpoint substations (e.g., "BOUTRE - MANOSQUE")



where `safe_id()` replaces non-alphanumeric characters with underscores.



### Generators and Loads (Step 5)



One generator and one load per bus with a **geographic dispatch** pattern:



- **Generation** concentrated in **south-east France** (Rhone valley / nuclear corridor), degree-weighted distribution

- **Load** concentrated in **north-west France** (Paris / Brittany), degree-weighted distribution

- Total generation ~85 GW, total load ~75 GW (slack absorbs the difference)

- All 192 generators have `voltage_regulator_on = True` for AC convergence



### Line Impedances (Step 6)



Physical parameters come directly from OSM data:



- `r` = resistance (Ohm), divided by number of circuits, floored at 1e-4

- `x` = reactance (Ohm), divided by number of circuits, floored at 1e-3

- `b` = susceptance (S), multiplied by number of circuits, split equally to b1/b2

- `g1 = g2 = 0`



These are in physical units (Ohm/S), not per-unit — pypowsybl handles the conversion internally.



Raw OSM current limits (`i_nom` in kA, scaled by number of circuits) are set as permanent operational limits at creation time via `create_operational_limits()`.



### Grid Layout (Step 9)



`grid_layout.json` stores **Mercator-projected coordinates** for each voltage level, keyed by VL ID (`"VL_{safe_id}"`).



The projection uses WGS-84 → Web Mercator with Y-axis negation (so north is up), then rescales to a target width of ~8 000 units to match pypowsybl's force-layout scale where circle radii and text are readable.



This enables geographical NAD rendering via `NadParameters(layout_type=GEOGRAPHICAL)` with `fixed_positions`.



## Operational Limits and Overload Scenario



### Why limits matter



Without operational limits in the XIIDM, Co-Study4Grid cannot detect overloads during N-1 contingency analysis. The OSM dataset provides `i_nom` (thermal current rating in kA) for each line, but using raw ratings (2 580 A for 400 kV lines) results in very low loading (~5-30%) because the synthetic load scenario, even at 75 GW, produces flows well below real thermal limits.



### Limit calibration strategy (rank-based distribution)



Instead of uniform loading, the pipeline produces a **realistic spread of N-state loadings**:



1. Run AC loadflow → get N-state current per line

2. Sort lines by flow (highest to lowest)

3. Assign target loadings using a rank-based power-law distribution:

   - Heaviest corridors: ~60-65% loading

   - Lightly loaded lines: ~20-30% loading

   - Smooth curve: `target = 0.65 - (0.65 - 0.20) * (rank_normalized ^ 0.6)`

4. Per-line deterministic jitter (±5%) seeded by line ID hash ensures reproducibility

5. Set `limit = flow / target_loading` for each line (floor: 100 A)

6. **N-1 verification pass**: run all 398 contingencies, bump limits on any line exceeding 130% in any N-1 state (typically only 3 lines need adjustment)

7. Re-write limits into the XIIDM XML via direct lxml manipulation (since `update_operational_limits()` cannot modify the `value` field)



### Loading distribution results



**N-state**: min=9%, median=35%, max=65%, 83% of lines at ≤50%



**N-1**: P50=65%, P90=86%, P99=128%, max=128.5%



21 out of 398 contingencies produce overloads in the 100-130% range — realistic for a transmission grid where most contingencies are handled by design margins and only a few corridors are tight.



### Limit creation API



```python

# Limits are created at line creation time (one entry per line, side ONE)

limit_entries = []

for lid, i_nom_a in line_i_nom.items():

    limit_entries.append({

        "element_id": lid,

        "element_type": "LINE",

        "side": "ONE",

        "name": "permanent_limit",

        "type": "CURRENT",

        "value": i_nom_a,

        "acceptable_duration": -1,

    })

limits_df = pd.DataFrame(limit_entries).set_index(unique_id_column)

network.create_operational_limits(limits_df)

```



**Important**: `update_operational_limits()` cannot modify the `value` field (raises `"Series 'name' is not modifiable"`). The calibration pass therefore modifies limits by editing the XIIDM XML directly with lxml.



### N-1 contingency reference data



`data/pypsa_eur_fr400/n1_overload_contingencies.json` contains all contingencies producing overloads, with per-line details:



- `tripped_line` — the line disconnected as the N-1 contingency

- `tripped_vl1`, `tripped_vl2` — voltage levels at each end

- `max_loading_pct` — peak loading observed anywhere

- `most_loaded_line` — the line with peak loading

- `n_overloaded_lines` — count of lines exceeding 100%

- `overloaded_lines[]` — list with `line_id`, `loading_pct`, `current_a`, `limit_a`



This file can be used to directly replay interesting contingencies in Co-Study4Grid without re-running the full N-1 scan.



## Actions File



`actions.json` contains two types of actions:



### 1. Disconnection actions (400 total)



One `disco_*` action per line (398) and transformer (2). Each includes a `content.set_bus` field required by `expert_op4grid_recommender` for simulation and scoring:



```json

{

  "disco_way_426020732-400": {

    "description": "Disconnection of line 'CHARPENAY — ST-VULBAS-EST' (CHARPENAY 400kV — ST-VULBAS-EST 400kV)",

    "description_unitaire": "Ouverture de la ligne 'CHARPENAY — ST-VULBAS-EST'",

    "content": {

      "set_bus": {

        "lines_or_id": {"way_426020732-400": -1},

        "lines_ex_id": {"way_426020732-400": -1}

      }

    }

  }

}

```



**Note on `content.set_bus`**: This field is critical for the `expert_op4grid_recommender` scoring pipeline. Without it, the library's `LazyActionDict` cannot compute the action's electrical effect, and all disconnection scores return 0.0. The `-1` value means "disconnect" (remove from bus).



### 2. Coupling breaker actions (99 total)



One `open_coupler_*` action per eligible voltage level:



```json

{

  "open_coupler_VL_way_24020601-400": {

    "description": "Opening coupling breaker in substation 'CHARPENAY' (15 branches → split into 2 nodes)",

    "description_unitaire": "Ouverture du couplage 'VL_way_24020601-400_COUPL' dans le poste 'CHARPENAY'",

    "switches": {

      "VL_way_24020601-400_COUPL": true

    },

    "VoltageLevelId": "VL_way_24020601-400"

  }

}

```



**Total: 897 actions** (400 disconnection + 398 alternate disconnections + 99 coupling breaker openings).



## Detailed Topology (Double-Busbar)



### Motivation



The base network uses node-breaker topology with one busbar section per voltage level. This limits the action space to line disconnections only. Real transmission substations have multiple busbars connected by coupling breakers. Opening a coupling breaker splits a substation into two electrical nodes, redistributing power flows — a key remedial action for grid operators.



### Eligibility criterion



A substation receives a double-busbar layout if it has **≥4 branches** (lines + transformers) connected to it. This threshold ensures that splitting the substation produces a meaningful two-node topology with at least 2 branches on each side.



In the France 400 kV network: **99 out of 192 substations** are eligible, ranging from 4 to 15 branches.



### Implementation (`add_detailed_topology.py`)



For each eligible voltage level:



1. **Second busbar section**: A new busbar section `BBS_{safe_id}_1` (node 1) is created alongside the existing `BBS_{safe_id}_0` (node 0).



2. **Coupling device**: A disconnector-breaker-disconnector chain connects the two busbar sections: `BBS_0(node 0) — DISCO — BK(coupler) — DISCO — BBS_1(node 1)`. The breaker is **closed by default**, so in the initial N-state both busbars form a single electrical node.



3. **Branch dispatch**: Each equipment gets **two disconnectors** (one to each busbar) and one breaker. Only one disconnector is closed (the one connecting to the assigned busbar). Branches are distributed round-robin across busbars. For a VL with 10 branches, each busbar gets 5.



4. **Action generation**: An `open_coupler_{VL_id}` action with `"switches": {"VL_id_COUPL": true}` is merged into `actions.json`.



### Verification



After adding the detailed topology:



- **AC loadflow converges** with coupling breakers closed (identical to the single-bus solution)

- **Opening any coupling breaker** creates a second electrical bus and AC loadflow still converges

- The `NetworkTopologyCache` (Union-Find) correctly computes `set_bus` assignments when processing these switch actions



### Topology statistics



| Metric | Value |

|--------|-------|

| Substations with double busbars | 99 |

| Substations with single bus | 93 |

| Total coupling breakers | 99 |

| Branches on bus 1 (per eligible VL) | ⌈N/2⌉ |

| Branches on bus 2 (per eligible VL) | ⌊N/2⌋ |



## Co-Study4Grid Integration



### Config file



`config_pypsa_eur_fr400.json`:



```json

{

    "network_path": ".../data/pypsa_eur_fr400/network.xiidm",

    "action_file_path": ".../data/pypsa_eur_fr400/actions.json",

    "layout_path": ".../data/pypsa_eur_fr400/grid_layout.json",

    "output_folder_path": ".../sessions",

    "pypowsybl_fast_mode": true

}

```



### Backend display name resolution



The backend provides human-readable names for all network elements via `network_service.get_element_names()`:



1. Reads the `name` column from pypowsybl's line and transformer DataFrames

2. For lines with real OSM names: uses them directly

3. For lines with raw OSM identifiers (matching `^(way|relation)[/_]`): constructs a composite from voltage-level endpoint names, stripping voltage suffixes (e.g., "CHARPENAY 400kV" → "CHARPENAY"), producing "CHARPENAY — ST-VULBAS-EST"

4. Returns a `nameMap: {element_id: display_name}` to the frontend



The frontend uses a `displayName()` callback that looks up element IDs in this map, falling back to the raw ID.



### Verified capabilities



All backend features work with this network:



- Network loading via `POST /api/config`

- Branch listing via `GET /api/branches` (400 disconnectable elements, with display names)

- AC loadflow convergence (both N-state and all N-1 states)

- NAD geographical diagram generation (~430 KB SVG with real coordinates)

- SLD generation for individual voltage levels

- N-1 contingency simulation with overload detection

- Remedial action scoring (both coupling breaker and disconnection actions)

- Contingency display name shown in the UI below the selection input



## Testing



### Pipeline tests (`scripts/pypsa_eur/test_pipeline.py`)



97 tests covering the full pipeline end-to-end:



- **Helper function unit tests**: `safe_id()`, name resolution, coordinate projection

- **Source CSV validation**: file existence, column presence, record counts

- **Output file structure**: all expected files present with correct sizes

- **XIIDM network structure**: bus counts, line counts, transformer counts, switch counts

- **OSM names coverage**: percentage of substations/lines with real names

- **Actions**: correct count, format (disco actions have `content.set_bus`, couplers have `switches`)

- **Double-busbar topology**: eligible VL count, busbar section counts, coupling breaker presence

- **Operational limits**: all lines have limits, values within expected ranges

- **Loadflow**: AC convergence in N-state, voltage levels within bounds

- **N-1 contingencies**: overload counts, severity range (100-130%)

- **Cross-file consistency**: action IDs match line IDs, layout covers all VLs



### Grid layout tests (`scripts/pypsa_eur/test_grid_layout.py`)



19 tests for `grid_layout.json`:



- VL key format (`VL_` prefix), coverage of all 192 buses

- Coordinate ranges (Mercator bounds for metropolitan France)

- Geographic orientation (west/east, north/south consistency)

- Projection correctness (no extreme distortion)



## Key Pitfalls and Lessons Learned



### 1. MATPOWER import is binary-only



pypowsybl's MATPOWER importer only reads **binary `.mat` files** (MATLAB 5.0 format), not text `.m` files. This forced the pivot from "export to MATPOWER then import" to building the network directly via pypowsybl's `create_*` API.



### 2. DataFrame `id` must be the index



All pypowsybl `create_*` methods expect the element `id` as the DataFrame **index**, not as a regular column. Passing it as a column raises: `"Data of column 'id' has the wrong type, expected string"`.



### 3. Transformer substation constraint



IIDM requires both voltage levels of a 2-winding transformer to be in the **same substation**. The conversion script must merge transformer-connected buses into shared substations before creating voltage levels.



### 4. `substation_id` is not a transformer column



When creating transformers via `create_2_windings_transformers()`, do **not** include `substation_id` in the DataFrame — it's inferred from the voltage level IDs. Including it raises `"No column named substation_id"`.



### 5. AC loadflow needs distributed voltage regulation



A single slack generator cannot maintain voltage across 192 buses. All generators must have `voltage_regulator_on = True` and `distributed_slack = True` for AC convergence.



### 6. Operational limits are immutable after creation



`update_operational_limits()` cannot change the `value` field. To adjust limits after the initial creation, edit the XIIDM XML directly with lxml.



### 7. `get_operational_limits()` returns a MultiIndex DataFrame



The returned DataFrame has a 5-level MultiIndex: `(element_id, side, type, acceptable_duration, group_name)`. To look up a limit by element ID, use `idx[0]` on each row's index tuple.



### 8. NAD layout_type is a NadParameters attribute



`layout_type` is a parameter of `NadParameters()`, not of `get_network_area_diagram()`. Pass it as:

```python

nad_params = pp.network.NadParameters(layout_type=pp.network.NadLayoutType.GEOGRAPHICAL)

svg = network.get_network_area_diagram(nad_parameters=nad_params, fixed_positions=pos_df)

```



The returned object is an `Svg` type, not a string — use `str(svg)` to get the SVG content.



### 9. CSV quoting for geometry columns



`lines.csv` contains a `geometry` column with LINESTRING coordinates that include commas. Without `quotechar="'"`, pandas reports `"Expected 31 fields in line 3, saw 179"`.



### 10. pypowsybl expects kV, not V



Voltage level nominal voltages must be passed in **kV** (e.g., 400.0), not in V (e.g., 400000.0). Passing values in V silently creates a network with wrong per-unit bases, causing loadflow issues.



### 11. Node-breaker topology requires explicit node allocation



In node-breaker topology, each equipment connection needs its own node. The script maintains a `vl_next_node` counter per voltage level to allocate unique node IDs. This counter is saved to `vl_next_node.json` so `add_detailed_topology.py` can continue allocating nodes without conflicts.



### 12. Disco actions need `content.set_bus` for scoring



The `expert_op4grid_recommender` library's `LazyActionDict` computes `set_bus` from `switches` for coupler actions, but for disconnection actions (which have no switches), it relies on a `content.set_bus` field being present in the action definition. Without this field, all disconnection scores return 0.0 because the library cannot simulate the action's electrical effect.



## Scaling Notes



This pipeline processes the **France 400 kV** subset (192 buses, 398 lines). To scale:



- **More voltage levels**: Remove the `TARGET_VOLTAGES` filter to include 225 kV, 150 kV, etc.

- **More countries**: Change `TARGET_COUNTRY` or accept multiple countries.

- **Full European grid**: Remove country filter entirely (6 863 buses, 9 162 lines).

- **Load scenario tuning**: Adjust the geographic dispatch coefficients or use real load data from ENTSO-E transparency platform.



The main constraint is AC loadflow convergence — larger networks with more generators and non-trivial dispatch are harder to converge. Consider starting with DC loadflow for initial validation, then tuning for AC.