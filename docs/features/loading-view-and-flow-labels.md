# Loading view and readable flow labels

The network diagrams (N, N-1 and action tabs) read in two measures and two
states, and write their values in labels an operator can read at any zoom,
even on the 11 000-branch RTE grid.

| | **Flows** (absolute state) | **Impacts** (change vs the reference) |
|---|---|---|
| **MW** | active power at each branch end | ΔP vs N (N-1 tab) or vs N-1 (action tab) |
| **Loading %** | each end's current in % of its permanent limit | Δ loading, in percentage points |

The N tab is the reference the Impacts compare against, so it has no
Flows / Impacts toggle and always shows its absolute state. The SLD overlay
reads in the same view (§ "The SLD overlay").

## What the operator sees

### Toggles

- **`MW | Loading %`** above **`Flows | Impacts`**, stacked at the top right
  of each NAD tab (`components/FlowViewToggles.tsx`). Both are **per tab and
  per window**, like the view mode always was: a detached popup keeps its own
  pair (`useDiagramHighlights`: `viewModeForTab`, `flowMetricForTab`,
  `detachedViewModes`, `detachedFlowMetrics`). `viewModeForTab('n')` is always
  `'network'`, and a change for the N tab is ignored.
- **`🏷 Values`** beside `🏷 VL`, at the bottom left
  (`components/DiagramLabelToggles.tsx`). Off, no value label at all, for a
  lighter reading. The colours and the hover tooltip stay. One state for every
  tab and window, like the VL names (`branchLabels.showValues`).
- The top-right toggles and the legend keep clear of the **kV filter strip**
  on the right edge, whether folded (24 px) or open (62 px). The diagram area
  sets `--kv-filter-w` from the same CSS values as the strip (`App.css`,
  `--kv-filter-open-w` / `--kv-filter-closed-w`). A detached window has no
  strip, so the variable is unset there and the controls keep their 10 px
  margin.

### Colours

**Loading %** (`utils/svg/loadingVisuals.ts`, tokens `--signal-loading-*`)
colours each branch by its more loaded end:

| Loading | Branch |
|---|---|
| below 50 % (`LOADING_WATCH_THRESHOLD`) | grey, faded |
| 50 % → monitoring factor | 5 steps, pale yellow (`#fff176`) → orange (`#ff9326`) |
| ≥ monitoring factor (the overload scan's threshold) | vivid orange (`#ff6000`) |

**Impacts** reuse the flow-delta colours: orange up, blue down. Grey means
below 5 % of the largest change, the backend's `apply_threshold`.

**MW Flows** keeps pypowsybl's voltage colours on the lines.

### Labels (`components/BranchLabelLayer.tsx`, `utils/svg/branchLabels.ts`)

pypowsybl writes each flow value in user units beside its arrow. On a large
grid these values are specks until the operator zooms far in. The label layer
writes them instead, in 11–12 px pills over the diagram whatever the zoom.
pypowsybl's text is hidden: `.svg-container[data-branch-labels] .nad-edge-infos
text`. Its arrows stay.

- **Where.** A branch short on screen gets one label at its **middle**,
  showing its larger end. A branch at least `ENDS_MIN_PX` (180 px) long gets
  one label **per end**, beside pypowsybl's arrow, towards the middle. Zooming
  in therefore spreads a branch's single label into two.
- **Which.**
  - **Loading %**: only the coloured branches (≥ 50 %).
  - **Impacts**, MW or Loading %: only the significant changes, not the grey
    ones. The grey ones would crowd the reading; the hover still tells them.
  - **MW Flows**: a branch once it is `PLAIN_MIN_PX` (90 px) long on screen.
- **Order.** Coloured labels go first, by value: loading, then |change|.
  The others follow. No label overlaps another: they are placed greedily on a
  48 px collision grid, at most 1 500 per view.
- **Format.**
  - Loading: `%`, floored, so a branch never reads at the monitoring factor
    before its colour says so.
  - Changes: rounded, the sign alone telling up from down (`+40%`, `-58`).
  - MW: the end's value as pypowsybl prints it; the middle label shows the
    larger magnitude. pypowsybl groups the thousands (`-1,297`): the value is
    read through `parsePrintedNumber`, or a 1 297 MW flow would read `-1`.
  - The hover keeps a decimal.
- **Voltage colour.** Every label is **outlined in its line's voltage colour**
  (2.5 px), so the voltage still reads in Loading % and Impacts.
  - The colour is each half's `--nad-vl-color`, read once per voltage class
    from the mounted diagram, so it is the line's own.
  - A transformer's two ends each take their own colour.
  - A middle label takes the colour of the end it shows: the more loaded one
    in Loading %, the larger flow otherwise.
  - **MW Flows also writes the value in that colour**: its lines keep their
    voltage colours, the other views recolour them.
- **When.** The layout runs when the view settles: a viewBox change, the end
  of a gesture, a resize, a new view or diagram. It is hidden while a pan /
  zoom gesture runs (`data-gesture-proxy` or `svg-interacting` on the
  container). Because pypowsybl's text is hidden, the canvas gesture proxy
  draws no flow values on these tabs; it still draws the VL labels.

### Hover

Hovering within 8 px of a branch opens a tooltip with both of its ends:
voltage level, active power (MW) and loading (%). In Impacts it adds ΔP and
Δ loading. Parallel circuits drawn over each other (within 2 px more) are all
listed, the most loaded first, up to 4. The tooltip shows whatever the
`🏷 Values` toggle says.

There is no hit test of the diagram: the branches' segments are hashed on a
grid of user space (`BranchIndex`, built on the first hover), and each move is
a lookup. Nothing runs while a button is down or a gesture runs, or over a VL
disk / label, which keep their own hover.

### The SLD overlay (`utils/svg/sldFlowVisuals.ts`, `hooks/useSldFlowVisuals.ts`)

The voltage level's single line diagram follows the main window's toggles,
on whichever of its N / N-1 / action sub-tabs. The header says which:
`Loading %` (when on) beside `Flows` / `Impacts`. Its N sub-tab reads Flows,
like the N tab.

| | **Flows** | **Impacts** |
|---|---|---|
| **MW** | pypowsybl's own values | P and Q as their change (`Δ +12.3`), arrows turned to it |
| **Loading %** | each branch feeder: the loading of **the end it draws** | each branch feeder: the branch's change (`+12%`), as on the NAD |

In Loading %:
- **The end it draws.** pypowsybl's metadata gives each branch feeder's
  arrows a `side` (`ONE` / `TWO`): the feeder reads that end's loading. A
  transformer's side without a limit reads the other end's — in the 400 kV
  voltage level, a 400/225 kV transformer limited on its 225 kV side reads
  its loading, not a dash. Without a side (older metadata), the branch's.
- **Colours.** The feeder's cell takes the NAD's loading scale (grey below
  50 %, faded), its value a pill of that colour from 50 %, dark text in both
  themes. Impacts colour the value and the cell like the MW deltas, grey
  ones included: in a single voltage level they do not crowd the reading.
- **One figure per end.** The Q arrow and value are hidden; the P arrow
  stays, pointing the active power's way (a loading change has no
  direction, so Impacts do not turn it).
- **Loads and generators** have no limit: they keep their MW (and their MW
  change in Impacts — a load-shedding action shows its shed MW).
- A branch without a limit reads `—`, grey. An SLD without loading data
  (an older backend) stays in MW, and its header says so.

The painting runs in a layout effect, every render, self-gated: nothing is
redone while its inputs are the same objects and the DOM still shows it — a
reconciliation that wipes it (pan / zoom re-renders) is caught by a DOM
probe and repainted, before the browser paints. The target-topology preview
is never painted: its flows are stale and greyed.

## Data contract (backend)

Every NAD response carries the Loading view's data:

- `branch_loading: {branch_id: [end1 %, end2 %]}`. Each end's
  `|current|` is divided by **that end's** permanent limit. Rounded to 0.1 %.
  `null` marks an end without a limit.
- `loading_deltas: {branch_id: {delta, category}}`. The change of the larger
  end, in percentage points: vs N for the N-1 diagram, vs the contingency for
  an action. Categorised like the flow deltas (`apply_threshold`).

Both fields are in:
- the N diagram (`get_network_diagram`; `branch_loading` only), and the N
  SLD (`get_n_sld`);
- the N-1 diagram, full and patch: `get_contingency_diagram`,
  `_build_contingency_patch_payload`, through `_attach_loading_vs_base`;
- the action diagram, full and patch: `get_action_variant_diagram` through
  `_attach_action_loading`, and `build_action_patch_payload`, whose action
  loading is snapshotted before the variant switch like its flows;
- the N-1 and action SLDs (`get_contingency_sld`, `get_action_variant_sld`),
  through the same helpers. They are read grid-wide, so a branch's Impacts
  category is the NAD's, then narrowed to the voltage level's own branches
  (`_keep_sld_branches`: its `feeder_labels` of kind `branch`).

A change rounds to 0.1 point, like the loadings, so two equal states read
grey everywhere; `apply_threshold` greys a zero change even when nothing
changed at all (its threshold is then 0).

**Per-end limits** (`services/diagram/overloads.py`: `side_limits`,
`get_branch_loading`, `max_loading`):
- A **line's** ends share a voltage, so a limit given on one side holds for
  both.
- A **transformer's** do not. RTE grids limit most transformers on side 2
  only; their side-1 current, at another voltage, then has no loading
  (`[null, 109.1]` for CANTEY761). Dividing it by the side-2 limit would give
  a meaningless figure.

Reading the operational limits costs about 0.2 s on the RTE grid. The limits
do not change with the variant, so `DiagramMixin._side_limits_for` caches
them per network object (weak reference). A pass over the currents then
costs about 20–40 ms.

The frontend copies a patch's data fields onto the patched diagram through
`utils/svgPatch.ts`'s `patchDiagramFields`, shared by the N-1 and action
paths. A field the patch gains cannot reach one path and miss the other.

## Frontend pieces

| File | Role |
|---|---|
| `utils/svg/loadingVisuals.ts` | Branch colours of the Loading view (and of its Impacts, through `nad-delta-*`), the colour scale (`loadingClass`), the formatters, `resetFlowVisuals` (strips a decorated diagram's colours / rewritten labels from a clone) |
| `utils/svg/branchLabels.ts` | Pure: `readBranchGeometry` (paths, middles, arrows, printed MW, voltage colours), `buildLabelItems` (what each view says), `layoutLabels` (where, without overlap), `BranchIndex` (hover lookup), affine helpers |
| `components/BranchLabelLayer.tsx` | The overlay of one NAD tab: the layout on settle, hiding during gestures, the hover tooltip |
| `components/FlowViewToggles.tsx` | The stacked top-right toggles (no Flows / Impacts on the N tab) |
| `components/DiagramLabelToggles.tsx` | `🏷 VL` and `🏷 Values` |
| `hooks/useDiagramHighlights.ts` | View mode / metric state per tab and window, the branch colours pass (`applyFlowVisuals`), `branchLabels` (metadata indexes + the Values toggle) |
| `utils/svgPatch.ts` | `patchDiagramFields`; `cloneBaseSvg` resets the N tab's decoration before patching a clone |
| `utils/svg/sldFlowVisuals.ts` | The SLD's values in the view: MW Impacts, Loading % Flows / Impacts (`applySldFlowVisuals`, `clearSldFlowVisuals`, `hasSldFlowVisuals`) |
| `hooks/useSldFlowVisuals.ts` | Its self-gated layout effect in `SldOverlay`; `VisualizationPanel` hands the overlay the main window's metric |

Interaction events: `flow_metric_changed { metric, tab, scope }`,
`value_labels_toggled { show }`, and `view_mode_changed`, which is never
emitted for the N tab. See `interaction-logging.md`.

## Performance (RTE grid, 11 231 branches)

| Step | Cost |
|---|---|
| Geometry read, once per mounted diagram | about 50–150 ms |
| Label texts, per view change | 4–23 ms |
| Layout, per settle | 2–12 ms |
| Rendered labels | about 20–70 dezoomed, a few hundred zoomed |

Switching MW ↔ Loading % costs about 0.6 s. Nearly all of it is the
diagram's own recolouring (classes on 11 000 edges and the style recalc that
follows), not the label layer.

## Tests

- **Backend.**
  - `test_diagram_helpers.py`: per-end and per-side loading, `max_loading`,
    loading deltas.
  - `test_diagram_mixin.py`: the attach helpers, the limits cache, the N
    diagram and N-1 patch payloads, the three SLD payloads (narrowed to the
    voltage level's branches).
  - `test_action_patch_module.py`: the snapshot and the action patch payload.
- **Frontend.**
  - `loadingVisuals.test.ts`, `branchLabels.test.ts` (geometry, texts per view,
    placement, overlap, hover index, colours, thousands-grouped values).
  - `sldFlowVisuals.test.ts` (the SLD in each view: the feeder's end, the
    transformer fallback, pills, hidden Q, loads in MW, clearing);
    `SldOverlay.test.tsx` (it follows the toggles, the header) and
    `useSldOverlay.test.ts` (the data of each SLD).
  - `BranchLabelLayer.test.tsx` (labels, MW colours and outline, hover,
    gestures, Values off).
  - `DiagramLabelToggles.test.tsx`, `DiagramLegend.test.tsx`.
  - `useDiagramHighlights.test.ts` (metric routing, N tab without Impacts,
    Values toggle).
  - `VisualizationPanel.test.tsx` (toggles, kV strip offset).
  - `svgPatch.test.ts` (`patchDiagramFields`, the clone reset).
  - `specConformance.test.ts` and `scripts/check_standalone_parity.py` (the
    two new events).

## Limits and next levers

- **No labels during a gesture.** They come back on the settle. Following the
  gesture would mean transforming the overlay from usePanZoom's frames.
- **Voltage colours are read once per diagram.** A theme switch shows in the
  labels from the next diagram.
- **The SLD overlay follows the main window's toggles**, not a detached
  window's: it lives in the main window.
- **The MW ↔ Loading % switch** could skip rewriting the hidden pypowsybl
  texts (`applyLoadingVisuals` / `applyDeltaVisuals` still keep them in
  step, for clones and the bitmap mode).
