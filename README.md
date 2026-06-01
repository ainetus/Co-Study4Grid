# Co-Study4Grid

**Co-Study4Grid** is a full-stack web application for **power grid contingency analysis and remedial action search**. It provides an interactive interface on top of the [`expert_op4grid_recommender`](https://github.com/marota/Expert_op4grid_recommender) library, letting grid operators simulate element disconnections, visualize and analyze network overflows, and explore prioritized remedial actions — topology changes, PST tap adjustments, renewable curtailment, and load shedding — individually or combined.It adopts the supportive framework mindset from AI4RealNet European project, empowering and supporting the user in developping its expertise rather than automating it.

The remedial action recommender is **pluggable**: pick the expert rule-based system, a random
baseline, or any third-party model like a learnt model — from the **Settings → Recommender** tab
or the model dropdown right above the **Analyze & Suggest** button. Swapping
the model takes effect on the next run with no study reload, and a **Clear**
button lets the operator wipe un-triaged suggestions and re-run with a
different model. See [Plug Your Own Recommendation Model](#plug-your-own-recommendation-model)
to extend it.

![License: MPL 2.0](https://img.shields.io/badge/license-MPL--2.0-blue)
![Release](https://img.shields.io/badge/release-0.7.5-green)

---

## Key Features

### Contingency analysis & remediation

<table>
<tr>
<td valign="top">

- **Two-step N-1 workflow**: detect overloads first (`run-analysis-step1`), let the operator pick which ones to resolve, then stream suggestions (`run-analysis-step2`). The legacy one-shot `run-analysis` endpoint is still exposed for backward compatibility.
- **Pluggable recommendation models**: select Expert / Random / RandomOverflow
  from the Settings dropdown **or** the model selector above the Analyze &
  Suggest button, or plug in a third-party model. A model swap is pushed to
  the backend through the lightweight `POST /api/recommender-model` endpoint
  (no study reload), and the overflow-graph build is cached by an input
  signature so re-running with a different model re-executes only the
  discovery step. After a run, the model that produced the suggestions is
  reminded below the Suggested Actions tab header with a confirmation-gated
  **Clear** button to wipe un-triaged suggestions before re-running. The
  pipeline dispatches via the `RecommenderModel` contract; the UI hides
  parameters the active model doesn't consume. See
  [Plug Your Own Recommendation Model](#plug-your-own-recommendation-model).
- **AC/DC fallback**: analysis runs on the AC load flow and transparently falls back to DC when AC fails to converge.
- **Prioritized action feed** with search, filter, star / reject, and per-action metadata — severity, MW deltas, rho after action, impacted overloaded lines.
- **Manual action simulation** from the score table, including a *"Make a first guess"* shortcut when no suggestion is loaded.
- **Combined actions** (PR #62 family): evaluate pairs of actions via a fast **superposition (beta-coefficient) estimation** or a full exact simulation, through the *Computed Pairs* / *Explore Pairs* modal. See [`docs/features/combined-actions.md`](docs/features/combined-actions.md).
- **Full remedial action catalog**:
  - Topological switches and bus reconfiguration
  - **Phase Shifting Transformer (PST)** tap adjustment with tap-start / target columns, re-simulation, and superposition fallback (PR #78)
  - **Renewable curtailment** and **load shedding** via the `set_load_p` / `set_gen_p` power-reduction format, with configurable MW reduction (PR #72, #73). See [`docs/features/curtailment-loadshedding-pst-actions.md`](docs/features/curtailment-loadshedding-pst-actions.md).
  </td>
<td valign="top" width="200">

<a href="docs/images/readme/ActionRecommenderFeed.png"><img src="docs/images/readme/ActionRecommenderFeed.png" alt="Suggested Actions feed" width="300"></a>
  <sub><b>Suggested Actions feed</b> — ranked cards with severity badges (green = solves overload, yellow = low margin, red = still overloaded), per-action max-loading %, target chip, and star / reject controls. The header shows the active contingency, the live N-1 overload, and the recommender that produced the suggestions.</sub>
</td>
</tr>
</table>

### Visualization
- **Four synchronized tabs** — *Network N*, *Contingency N-1*, *Remedial Action*, *Overflow Analysis* — rendered as pypowsybl Network-Area Diagrams (NAD) with flow-delta overlays. A **Flow ↔ Impacts** view-mode switch on every NAD recolours the branches by post-contingency Δ-rho (orange = newly more loaded, blue = offloaded, grey = unchanged), so the operator reads *cause* of the constraint, not just loading.
- **Interactive overflow analysis** (PRs #116, #122–#127): the legacy static PDF is replaced by a same-origin HTML viewer with a layer-toggle sidebar (Constrained path, Red-loop, Overloads, Hubs, Reconnectable, Production / Consumption nodes, flow polarities), a hierarchical ↔ geographic layout switch backed by a per-study cache, and a double-click → SLD drill-down on any node. Stackable filters answer the operator's reading of *"if I block my constraint, where does the flow re-report itself?"* directly on the graph. See [`docs/features/interactive-overflow-analysis.md`](docs/features/interactive-overflow-analysis.md).
- **Action pin overview** (PR #105 + #116): the post-contingency NAD doubles as a Google-Maps-style overview where every remedial action becomes a coloured pin anchored on the grid asset it targets. Pins reflect triage decisions (gold star = selected, red cross = rejected, dashed-curve = simulated combined pair, dimmed-dashed `?` = scored-but-unsimulated). The same pin overlay is mirrored on top of the interactive overflow viewer, kept in lock-step via `postMessage` so a single-click anywhere previews the action card and a double-click drills into the SLD or kicks off a manual simulation. See [`docs/features/action-overview-diagram.md`](docs/features/action-overview-diagram.md).
- **Single-Line Diagrams (SLD)** for voltage levels in N, N-1, and post-action states, with persistent highlight of impacted switches and coupling breakers (PR #63).
- **Robust highlighting**: contingencies, overloads and impacted assets are drawn as clone-based halos that survive pan, zoom, SLD overlay, and action-target dimming.
- **Auto-zoom** on contingency, newly overloaded line, or action target; pinned sticky feed summary and overload-click to jump to the N-1 tab (PR #88).
- **Zoom-tier level-of-detail** (PR #76): labels, nodes and flow arrows are dynamically boosted proportional to `sqrt(diagramSize / referenceSize)`, so large grids remain legible at any zoom.
- **Voltage-level names toggle** (PR #118): a `🏷 VL` chip flips visibility of the pypowsybl VL labels with a native `<title>` tooltip fallback so cluttered grids stay readable.

<table>
  <tr>
    <td align="center" width="50%"><a href="docs/images/readme/Innovations/ImpactMode.png"><img src="docs/images/readme/Innovations/ImpactMode.png" alt="Impacts view"></a><br><sub><b>Impacts view</b> — Δ-rho coloring (orange / blue / grey) reveals where the contingency propagates, not just where loading is high.</sub></td>
    <td align="center" width="50%"><a href="docs/images/readme/Innovations/GraphAnalyseInterpretable.png"><img src="docs/images/readme/Innovations/GraphAnalyseInterpretable.png" alt="Interpretable overflow graph"></a><br><sub><b>Interpretable overflow graph</b> — stackable layer filters show the constrained path and the flow-redistribution root cause.</sub></td>
  </tr>
  <tr>
    <td align="center" width="50%"><a href="docs/images/readme/Innovations/ActionOverviewPins.png"><img src="docs/images/readme/Innovations/ActionOverviewPins.png" alt="Action pin overview"></a><br><sub><b>Action pin overview</b> — every remedial action becomes a coloured pin on the augmented network.</sub></td>
    <td align="center" width="50%"><a href="docs/images/readme/Innovations/CarteActionInteractive.png"><img src="docs/images/readme/Innovations/CarteActionInteractive.png" alt="SLD popover over the network"></a><br><sub><b>SLD popover over the network</b> — drill into a substation's switches without leaving the NAD context.</sub></td>
  </tr>
</table>

### Efficient interactions
Co-Study4Grid is built around the operator's ability to triage hundreds of remedial actions quickly. The UI is wired so a single click, a chip, or a keystroke replaces a multi-step menu walk.

- **Synchronized filter chips** (PRs #105 / #109 / #116 / #129): one `ActionOverviewFilters` state — severity categories (Solves / Low margin / Still overloaded / Divergent-or-islanded), max-loading threshold slider, `Show unsimulated` toggle, and action-type chips (DISCO / RECO / LS / RC / OPEN / CLOSE / PST) — drives the Action Feed sidebar, the Action Overview pin layer, **and** the overflow-graph pin overlay simultaneously. Hide a card in any view, it disappears from the others.
- **Click-to-inspect with auto-zoom + impacted-asset halos**: clicking an `ActionCard` in the sidebar feed (or a pin via its popover) selects the action, fetches its post-action NAD, **auto-zooms onto the action target and the lines it affects**, and paints clone-based halos on every impacted asset (action target, contingency, newly overloaded / relieved lines, action-induced topology changes). The same auto-fit logic runs on contingency selection and on overload-row clicks in the sidebar — no manual pan/zoom needed to check whether a candidate action lands where the operator expects.
- **Pin-driven workflow**: single-click a pin → `ActionCardPopover` opens anchored on the pin (no tab switch); double-click → drills into the SLD overlay for that voltage level; double-click an unsimulated pin → kicks off a manual simulation through `simulate_manual_action`. Same gesture grammar on the Action Overview NAD, the overflow viewer, and the Action Feed cards.
- **Simulate any action on demand** — from three surfaces: (1) the **action-score table** in the *Manual Selection* dropdown (every scored-but-not-yet-simulated action becomes a one-click `Simulate` row, with editable target setpoints for load-shedding / curtailment / PST and a *"Make a first guess"* shortcut when no analysis is loaded yet); (2) the **un-simulated pin layer** on both the Action Overview NAD and the overflow viewer (dimmed dashed pins, double-click triggers the same code path); (3) any **manual action ID** typed into the dropdown's free-text field. Reconnection (`reco_*`) and load-shedding / curtailment / PST actions are auto-built on the fly when missing from the dictionary, so the operator can compose mixed disconnect + reconnect studies without editing the action JSON.
- **Combined-action explorer** (PRs #62, #114): the *Computed Pairs* / *Explore Pairs* modal proposes pairs sorted by predicted `target_max_rho`, runs fast superposition first, and offers a one-click full simulation when the operator wants ground truth — load shedding and curtailment can mix freely with topology actions. The estimation-vs-simulation columns sit side by side, so the operator can sweep the modal to find the best pair and validate the superposition prediction with a single click.
- **Inspect search field** (PR #116) on every viz tab: type any branch / VL / load / generator ID and the view auto-focuses + halos the asset, with focused sub-diagrams a click away.
- **Detachable tabs** (PR #86): pop any visualization tab into a second browser window for dual-monitor studies, with per-window pan/zoom, tie/untie, and automatic reattach. The detached window inherits the same filter and pin state.
- **Tiered notice system + diagram legend** (PR #122): the sidebar `Notices` pill ranks issues by severity (info / warning / critical) and the new `DiagramLegend` sits inside the Visualization panel so colour codes are always one glance away — no scrolling through docs to recall what a halo means.
- **Progressive-disclosure ActionCard** (PR #121): severity icons drive a glanceable card summary; topology / load-shed / curtailment details collapse by default and expand on demand, so a feed of 50 actions still fits one screen.
- **Replay-ready interaction log**: every click, chip toggle, simulation, save, and reload is recorded with correlation IDs in `interaction_log.json`, suitable for both deterministic browser-automation replay and UI benchmarking. Full schema in [Sessions & replay](#sessions--replay) below.

<table>
  <tr>
    <td align="center" width="33%"><a href="docs/images/readme/Innovations/MakeAFirstGuess.png"><img src="docs/images/readme/Innovations/MakeAFirstGuess.png" alt="Make a first guess"></a><br><sub><b>Make a first guess</b> — the UI invites the operator's hypothesis before the recommender runs.</sub></td>
    <td align="center" width="33%"><a href="docs/images/readme/Innovations/ModaleScore.png"><img src="docs/images/readme/Innovations/ModaleScore.png" alt="Scored Actions table"></a><br><sub><b>Scored actions table</b> — ranking, editable setpoints (LS / RC / PST) and on-demand simulation per row.</sub></td>
    <td align="center" width="33%"><a href="docs/images/readme/Innovations/ModaleCombinaisons.png"><img src="docs/images/readme/Innovations/ModaleCombinaisons.png" alt="Action combinations modal"></a><br><sub><b>Action combinations</b> — superposition estimates vs full simulation, side by side.</sub></td>
  </tr>
</table>

### Sessions & replay
- **Save Results** / **Reload Session**: export the complete analysis state (config, contingency, **active recommender model**, actions with status tags, combined pairs, overflow PDF, loading ratios) to a timestamped session folder. See [`docs/features/save-results.md`](docs/features/save-results.md).
- **Replay-ready interaction log**: every UI interaction is written to `interaction_log.json` as a self-contained, timestamped event with correlation IDs for async completions — suitable for deterministic browser-automation replay. See [`docs/features/interaction-logging.md`](docs/features/interaction-logging.md).
- **Persistent user config**: paths, recommender parameters and UI preferences persist across sessions through a user-writable config file outside the repo (PR #59).
- **Confirmation dialogs** before destructive state resets (switching network, applying settings on an active study) so operators never lose work by accident.

### Frontend engineering
- **React 19 + TypeScript 5.9 + Vite 7**, strict mode (`noUnusedLocals`, `noUnusedParameters`).
- **Phase 1 refactor** (PR #74): `App.tsx` reduced from ~2100 lines to a pure state-orchestration hub; UI split into focused presentational components under `components/` and `components/modals/`.
- **Phase 2 hook extraction** (PR #109): `useContingencyFetch` (svgPatch fast-path + `/api/contingency-diagram` fallback) and `useDiagramHighlights` (per-tab SVG highlight pipeline) extracted out of `App.tsx`; sidebar moved into dedicated `AppSidebar` / `SidebarSummary` / `StatusToasts` components.
- **SVG DOM recycling** (PR #108): `utils/svgPatch.ts` clones the mounted N-state SVG and patches only per-branch deltas on N-1 / action tab switches — **~80 % faster** tab switching on the ~12 MB French NAD (full benches in [`CHANGELOG.md`](CHANGELOG.md) 0.6.5).
- **Code-quality gate** (PR #104): CI enforces zero `print()` / bare except / `any` / `@ts-ignore`, module-size ceilings, and publishes a full Markdown metrics report to each run's workflow summary.
- **React ErrorBoundary** wrapping the app root (PR #82) to contain crashes.
- **Vitest + React Testing Library** unit tests co-located as `*.test.tsx` — ~1000 specs.
- **Auto-generated single-file UI** (`frontend/dist-standalone/standalone.html` via `npm run build:standalone`, PR #101) mirroring every feature of the React app, for zero-install demos. The legacy hand-maintained `standalone_interface.html` has been decommissioned.

---

## European-Wide Studies in Practice

Co-Study4Grid is grid-agnostic: any pypowsybl-readable `.xiidm` network
with a `grid_layout.json` companion drops in. The three studies below
were captured on the same dataset — the
`pypsa_eur_eur220_225_380_400` environment, a full pan-European 220 /
225 / 380 / 400 kV network derived from the PyPSA-EUR pipeline (see
[`scripts/pypsa_eur/`](scripts/pypsa_eur/)). Each contingency lights
up a different region — the French / Spanish Pyrenean border, Spain's
inland 400 kV backbone, and Italy's Campania 220 kV ring — and each
exercises a different facet of the workflow. They are reproducible
end-to-end: load the `pypsa_eur_eur220_225_380_400` study, set the
contingency to the value below, click **Analyze & Suggest**.

### What the interface shows

Across every study, the same panels are at work:

- **Top bar** — network path input, **Load Study** / **Save Results** /
  **Reload Session** controls; the **Notices** pill in the top-left
  surfaces tier-ranked issues (info / warning / critical) tied to the
  current study.
- **Sidebar** —
  - **Contingency selector** and a sticky summary strip listing the
    applied disconnections, the detected N-1 overloads (clickable to
    zoom on the offending line) and the active monitoring ratio.
  - The **Analyze & Suggest** trigger, with an *Additional lines to
    prevent flow increase* picker right above it and a **Model**
    dropdown (Expert / Random / RandomOverflow / any plug-in model).
  - The **Suggested Actions** feed — colour-coded severity badges
    (Solves overload / Low margin / Still overloaded / Divergent or
    islanded), per-action max-loading %, target substation chip, and a
    star/reject pair on each card. Below the tab header, the model
    that produced the suggestions is reminded — *"Suggestions produced
    by &lt;model&gt;"* — alongside a confirmation-gated **Clear**
    button that wipes the un-triaged suggestions (keeping starred /
    rejected / manually-added decisions) so the operator can re-run
    with a different recommender.
- **Visualization panel** — four synchronized tabs (*Network N*,
  *Contingency N-1*, *Remedial Action*, *Overflow Analysis*) rendered
  as pypowsybl NADs with flow-delta overlays, halos on impacted
  assets, and an **Inspect** field at the bottom for direct
  asset-focus + halo.
- **Overflow Analysis tab** — the interactive HTML viewer with a
  layer-toggle sidebar (Constrained path, Red-loop, Overloads, Low
  margin, Hubs, Consumption nodes, flow polarities), a *Hierarchical*
  ↔ *Geo* layout switch and a *Pins* overlay that mirrors the action
  pins of the Action Overview onto the overflow graph.

### Pyrenean border (France / Spain) — `LANNEL61PRAGN`

![France / Spain border study](docs/images/readme/study-pyrenees-france-spain.jpg)

A 225 kV interconnect on the French side trips and re-routes flow
toward the Spanish side, triggering contingency LANNEL61PRAGN leads to an overload on
`MARSIL61PRAGN` at 106.1 % (over a 95% monitoring factor). The recommender returns four
disconnection candidates centred on the Spanish substations
(Sabiñánigo, Hernani, Itxaso) — every card carries the green *Solves
overload* badge. The right pane illustrates the **interactive
overflow analysis** running in *Hierarchical* mode: the layer panel
exposes the Constrained-path, Red-loop, Overloads, Low-margin, Hubs
and Consumption-node layers; the Flow Redispatch values give the
positive / negative dispatch count on the constrained path; the stats
strip at the bottom reports 93 nodes / 110 edges for the dispatch
graph. The two views stay in lock-step: a click on a pin on either
side opens the same `ActionCardPopover`.

### Spain (400 kV) — `virtual_way_170479579_0-400 — virtual_way_170479590_0-400`

![Spain N-K 400 kV study near Hinojosa](docs/images/readme/study-spain-hinojosa.png)

This is an double line study: from the two parallel 400 kV
branches, one is triggered as a contingency virtual_way_170479579_0-400 — virtual_way_170479590_0-400
and the other virtual_way_170479579_0-400 — virtual_way_170479590_0-400 gets overloaded around *Subestación de
Hinojosa*. The contingency strip shows both disconnections as
chips; the single remaining N-1 overload reaches 102.2 % on the same
corridor. Eighteen disconnection / coupler-opening candidates come
back from the Expert model — all green — illustrating how dense the
remediation space gets when the operator hunts for relief paths on a
400 kV backbone. The auto-zoom places the highlighted contingency
(orange dashed line) and the impacted assets at the centre of the
network diagram, and the sticky N-1 overload chip lets the operator jump back to
the offending corridor with one click.

### Italy (220 kV Campania) — `Santa Sofia — Montecorvino`

![Italian Campania study around Brusciano-Nola](docs/images/readme/study-italy-brusciano-nola.png)

A single 220 kV line trips between *Santa Sofia* and *Montecorvino*,
overloading the Brusciano-Nola corridor at 100.1 % (over a 95% monitoring factor). The 18 suggested
actions span every action class the platform handles — *Load
shedding* on Frattamaggiore and Acerra-Maddaloni loads, *Coupler
opening* on Avezza 220 kV (note the French description rendered
verbatim from the action dictionary: *"Ouverture du couplage
'VL_way_132701980-220_COUPL' dans le poste 'Avezza 220kV'"*),
*Disconnection* on the Montecorvino–Laino axis — and the severity
badges blend the three colour codes side by side: green *Solves
overload*, yellow *Solved – low margin*, red *Still overloaded*. The
overlapping red / green / yellow pins on the NAD reflect the
operator's triage in progress: starred, rejected and unsimulated
actions render with distinct glyphs that survive zoom, pan, and the
*Filter* chips.

### Reproducing the three studies

```bash
# Backend
python -m expert_backend.main

# Frontend
cd frontend && npm run dev
```

1. **Settings → Paths**: point *Network Path* to
   `data/pypsa_eur_eur220_225_380_400/network.xiidm` (and the matching
   `grid_layout.json` / action-dictionary file).
2. Click **Load Study**.
3. Type one of the contingency identifiers from the table below into
   the **Select Contingency** field — autocompletion will match.

| Region                        | Contingency identifier                                              |
|-------------------------------|---------------------------------------------------------------------|
| France / Spain (Pyrenees)     | `LANNEL61PRAGN`                                                     |
| Italy (Campania, 220 kV)      | `Santa Sofia — Montecorvino`                                        |
| Spain (Hinojosa, 400 kV, N-K) | `virtual_way_170479579_0-400 — virtual_way_170479590_0-400`         |

4. Press **Analyze & Suggest**, optionally change the recommender via
   the model dropdown right above the button.

The same gesture grammar applies in every region: the platform makes
no assumption on TSO, voltage level, action vocabulary, or the
language of the action descriptions — every panel and every shortcut
adapts to whatever the loaded dataset declares.

---

## Performance Highlights

Measured on the full French grid (`bare_env_20240828T0100Z`, ~10k
branches, ~12 MB NAD SVG) with `scripts/profile_diagram_perf.py` and
the backend micro-benches under `benchmarks/`. Full write-ups in
[`docs/performance/history/`](docs/performance/history/) and
[`CHANGELOG.md`](CHANGELOG.md).

### 0.7.0 — interactive overflow viewer + European-wide grid

* **Interactive overflow analysis tab** (PRs #116, #122–#127): the
  static overflow PDF is replaced by a same-origin HTML viewer with a
  layer-toggle sidebar (Constrained path / Red-loop / Overloads /
  Hubs / Reconnectable / Production / Consumption / flow polarities),
  hierarchical ↔ geographic layout switch, action-pin overlay synced
  with the Action Overview, and double-click → SLD drilldown.
* **PyPSA-EUR European-wide grid** (PRs #112, #117): full pipeline
  for generating XIIDM grids from PyPSA-EUR data with calibrated
  thermal limits and a fr225_400 dataset.
* **Design-token migration** (PR #120): centralised
  `src/styles/tokens.{css,ts}` palette enforced by the code-quality
  gate (zero hex literals outside the token files).

### 0.6.5 — SVG DOM recycling (PR #108)

| Endpoint | Cold | Warm (median of 3) | Payload |
|---|---|---|---|
| `/api/contingency-diagram` (full)      | 3.01 s | 2.39 s | 27.1 MB |
| `/api/contingency-diagram-patch` (new) | 0.49 s | 0.50 s |  5.5 MB |
| **Δ** | **−83.8 %** | **−79.1 %** | 20.3 % of full |

Mirrored on `/api/action-variant-diagram-patch` with dashed-class
toggling for `disco_*` / `reco_*` and VL-subtree splicing for
coupling / node-merging / node-splitting actions.

### 0.5.0 — vectorisation + observation caching

| Metric                              | Before   | After   | Speed-up   |
|-------------------------------------|----------|---------|------------|
| `care_mask` / overload detection    | 12.17 s  | 0.01 s  | **~1,100×** |
| Branch flow extraction              | 0.82 s   | 0.06 s  | **~13×**    |
| Flow delta computation              | 0.47 s   | 0.01 s  | **~47×**    |
| `get_obs()` call overhead           | 0.65 s   | 0.01 s  | **~65×**    |
| **Total manual-action simulation**  | ~16.5 s  | ~4.0 s  | **~4×**     |
| Base diagram rendering              | ~7.2 s   | ~3.5 s  | **~2×**     |
| N-1 contingency analysis            | ~19.8 s  | ~12.9 s | ~1.5×       |

**How it was achieved**:
- Vectorized the `care_mask` loop, flow extraction and delta computation with NumPy.
- Observation caching in the manual-action loop (eliminates redundant `get_obs()` refetches).
- Pre-built `SimulationEnvironment` and `dict_action` reused across steps.
- `lxml`-based NaN stripping + gzip compression for large SVG payloads (PR #70).
- `display:none` on inactive SVG tabs cuts live DOM from ~600 k to ~200 k nodes (PRs #99, #102).
- Frontend: throttled datalist rendering, zoom guard, level-of-detail tiers, and stable portal target for detached tabs to avoid unmount/remount cascades.

---

## Plug Your Own Recommendation Model

The analysis pipeline does NOT hardcode the expert system. It dispatches to
any class implementing the `RecommenderModel` ABC from
[`expert_op4grid_recommender.models.base`](https://github.com/marota/Expert_op4grid_recommender/blob/main/expert_op4grid_recommender/models/base.py).
Three models ship out of the box; you can add your own with a few lines of code.

### Built-in models

| Name              | Label                              | Requires overflow graph | Best for                                                                                |
|-------------------|------------------------------------|-------------------------|-----------------------------------------------------------------------------------------|
| `expert`          | Expert system                      | Yes                     | Default — rule-based discovery + scoring on every action type.                          |
| `random`          | Random                             | No                      | Sanity-check baseline. Samples uniformly from the action dictionary, augmented with synthetic reconnection / load-shedding / curtailment actions. |
| `random_overflow` | Random (post overflow analysis)    | Yes                     | "Is the overflow analysis useful?" baseline. Samples uniformly inside the expert-reduced action space (rule filter + overflow paths + network existence). |

The model is selected from a dropdown populated dynamically by
`GET /api/models` — available **both** in the **Settings → Recommender** tab
and as a compact selector directly above the **Analyze & Suggest** button so
the operator can swap model and re-run without opening Settings. Changing
either dropdown pushes the choice to the running backend through
`POST /api/recommender-model` (a lightweight swap — no network reload, no
action-dictionary rebuild), so the next analysis run uses it. The parameter
inputs below the Settings dropdown follow the model's `params_spec()`: each
recommender declares which knobs the operator can tune, and the UI hides the
rest. The `Compute Overflow Graph (step 1)` toggle is locked-on for models
with `requires_overflow_graph=true` and editable for the others (opt-in).

After a run, the model that produced the suggestions is reminded below the
Suggested Actions tab header — *"Suggestions produced by &lt;model&gt;"* —
alongside a confirmation-gated **Clear** button. Clear wipes only the
recommender suggestions the operator has not triaged (un-starred, un-rejected,
not manually added); starred / rejected / manually-added actions are kept. The
overflow-graph build is cached by an input signature
`(contingency, selected_overloads, all_overloads, monitor_deselected,
additional_lines_to_cut)`, so re-running with only the model changed reuses
the cached graph and re-executes just the discovery step.

### Three-layer filter chain for sampling models

If your model samples within the overflow-graph-reduced action space (like
`random_overflow`), three filters are stacked before sampling, each
conservative on internal failure (returns the input list unchanged so a
single bug never silently empties the pool):

1. **Expert rule filter** — `inputs.filtered_candidate_actions` populated
   by `_run_expert_action_filter`. Available whenever the overflow graph
   is in context.
2. **Overflow path filter** — `restrict_to_overflow_paths(...)` from
   `expert_backend/recommenders/overflow_path_filter.py`. Narrows to
   actions touching the dispatch / constrained / loop / hub paths.
3. **Network existence filter** —
   `filter_to_existing_network_elements(...)` from
   `expert_backend/recommenders/network_existence.py`. Drops actions
   whose `VoltageLevelId` / `set_bus.lines_*_id` references an element
   that doesn't exist on the loaded network.

See
[`expert_backend/recommenders/random_overflow.py`](expert_backend/recommenders/random_overflow.py)
for the canonical chained example.

### Writing your own model

Three steps, no further wiring needed.

#### 1. Implement the contract

In any Python package importable by the backend:

```python
from expert_op4grid_recommender.models.base import (
    RecommenderModel, RecommenderInputs, RecommenderOutput, ParamSpec,
)

class MyMLPolicy(RecommenderModel):
    name = "ml_policy"                    # registry key
    label = "ML policy v3"                # UI label
    requires_overflow_graph = True        # set False if step-2 graph is unneeded

    @classmethod
    def params_spec(cls):
        return [
            ParamSpec("n_prioritized_actions", "N Actions", "int",
                      default=5, min=1, max=20),
            ParamSpec("temperature", "Sampling temperature", "float",
                      default=0.7, min=0.0, max=2.0),
        ]

    def recommend(self, inputs: RecommenderInputs, params: dict) -> RecommenderOutput:
        # Available on `inputs` (DTO docs in the library):
        #   obs / obs_defaut                         N and N-K observations
        #   network / network_defaut                 paired pypowsybl Networks
        #   lines_defaut                             N-K contingency lines
        #   lines_overloaded_names + _ids + _rho     constrained lines (post N-K)
        #   lines_overloaded_ids_kept                kept after island guard
        #   pre_existing_rho                         N-state rho of pre-existing overloads
        #   dict_action                              full action dictionary
        #   env                                      simulation environment
        #   filtered_candidate_actions               expert-rule-filtered action IDs
        #                                            (populated whenever the
        #                                            overflow graph is available —
        #                                            either because your model
        #                                            required it OR the operator
        #                                            opted in)
        #   overflow_graph / distribution_graph      alphaDeesp artefacts
        #   overflow_sim / hubs / node_name_mapping
        my_picks = pick_actions_with_ml(inputs, params)
        return RecommenderOutput(
            prioritized_actions=my_picks,    # {action_id: action_object}
            action_scores={},                # free-form; UI is OK with empty
        )
```

The reassessment phase (rho-before / rho-after / `max_rho` / simulated
observation / non-convergence reason / combined-pair superposition) runs
automatically on whatever your `recommend()` returns. Action cards in the
UI look identical to the expert's.

#### 2. Register it

Decorate with `@register` at import time:

```python
from expert_backend.recommenders.registry import register

@register
class MyMLPolicy(RecommenderModel):
    ...
```

For a third-party package, make sure it's imported by the backend before
`GET /api/models` is hit — the typical pattern is to import it from
`expert_backend/recommenders/__init__.py`, or via your own backend startup
hook. The decorator pattern works either way.

#### 3. That's it

The frontend picks up your model automatically:

- `GET /api/models` lists it,
- both the **Settings → Recommender** dropdown and the model selector above
  the **Analyze & Suggest** button show it,
- the parameter inputs render dynamically from `params_spec()`,
- the `Compute Overflow Graph` toggle is locked-on or editable based on
  `requires_overflow_graph`,
- the analysis pipeline calls your `recommend()` via
  `run_analysis_step2_discovery`,
- saved sessions persist the active model under `analysis.active_model`
  so reloaded studies show which recommender produced the suggestions.

### Reference

- **Library-side contract** (`RecommenderModel` ABC, DTO field list, reusable
  pipeline phases): [`marota/Expert_op4grid_recommender` — README §Pluggable Recommendation Models](https://github.com/marota/Expert_op4grid_recommender#pluggable-recommendation-models)
  and [`docs/recommender_models.md`](https://github.com/marota/Expert_op4grid_recommender/blob/main/docs/recommender_models.md).
- **App-side integration + filter chain + step-by-step guide**:
  [`docs/backend/recommender_models.md`](docs/backend/recommender_models.md).
- **Backend overview** (mixin architecture, data flow, conventions):
  [`docs/backend/README.md`](docs/backend/README.md).
- **Canonical examples**:
  [`expert_backend/recommenders/random_basic.py`](expert_backend/recommenders/random_basic.py),
  [`expert_backend/recommenders/random_overflow.py`](expert_backend/recommenders/random_overflow.py).

---

## Architecture

Co-Study4Grid is a monorepo with a **Python FastAPI backend** and a **React + TypeScript frontend**.

```
Co-Study4Grid/
├── expert_backend/              # FastAPI backend (Python)
│   ├── main.py                  # API endpoints and app configuration
│   ├── recommenders/            # Pluggable model registry + canonical examples
│   │   ├── registry.py              # register / build / list_models
│   │   ├── random_basic.py          # RandomRecommender
│   │   ├── random_overflow.py       # RandomOverflowRecommender
│   │   ├── overflow_path_filter.py  # Layer 2 of the sampling filter chain
│   │   ├── network_existence.py     # Layer 3 of the sampling filter chain
│   │   └── _service_integration.py  # Patches RecommenderService
│   │                                # (model selection + dispatch)
│   └── services/
│       ├── network_service.py       # Network loading and queries (pypowsybl)
│       ├── recommender_service.py   # Analysis orchestration, PDF/SVG generation
│       ├── diagram_mixin.py  +  diagram/    # NAD/SLD orchestrator + 7 helpers
│       ├── analysis_mixin.py +  analysis/   # Two-step analysis + 5 helpers
│       │                                    # (incl. overflow_geo_transform — 0.7.0)
│       ├── simulation_mixin.py + simulation_helpers.py  # Manual + combined actions
│       ├── overflow_overlay.py      # Interactive overflow viewer overlay (0.7.0)
│       └── sanitize.py              # NumPy → native-Python JSON coercion
├── frontend/                    # React + TypeScript + Vite frontend
│   ├── dist-standalone/             # Auto-generated single-file UI bundle
│   │                                # (npm run build:standalone)
│   └── src/
│       ├── App.tsx                  # State orchestration hub (~1400 lines)
│       ├── api.ts                   # Axios HTTP client
│       ├── types.ts                 # Shared TypeScript interfaces
│       ├── styles/                  # Design-token palette: tokens.{css,ts}
│       │                            # (single source of truth, gate-enforced)
│       ├── hooks/                   # useSettings / useAnalysis / useDiagrams /
│       │                            # useContingencyFetch / useDiagramHighlights /
│       │                            # useOverflowIframe / …
│       ├── utils/                   # svgUtils (barrel) + svg/* submodules,
│       │                            # svgPatch, actionTypes, sessionUtils,
│       │                            # interactionLogger, mergeAnalysisResult, …
│       └── components/              # Header, ActionFeed, VisualizationPanel,
│                                    # OverloadPanel, CombinedActionsModal,
│                                    # AppSidebar, SidebarSummary, StatusToasts,
│                                    # NoticesPanel, DiagramLegend,
│                                    # ActionTypeFilterChips, modals/, …
├── standalone_interface_legacy.html # DECOMMISSIONED frozen snapshot (do not edit)
├── docs/                        # features/, performance/, architecture/,
│                                # proposals/, data/  +  backend/ (README.md,
│                                # recommender_models.md)
├── benchmarks/                  # Offline micro-benches (warm / cold timings)
├── scripts/                     # Parity + quality gates + PyPSA-EUR pipeline
└── Overflow_Graph/              # Generated PDF output directory (created at runtime)
```

See [`CLAUDE.md`](CLAUDE.md) for a deep dive into the architecture and conventions.

---

## Prerequisites

- **Python 3.10+** with:
  - [`pypowsybl`](https://pypowsybl.readthedocs.io/)
  - [`expert_op4grid_recommender`](https://github.com/marota/Expert_op4grid_recommender)
  - [`grid2op`](https://grid2op.readthedocs.io/), [`pandapower`](https://pandapower.readthedocs.io/), [`lightsim2grid`](https://lightsim2grid.readthedocs.io/)
- **Node.js 18+** and npm

## Getting Started

### 1. Install backend dependencies

```bash
pip install -r expert_backend/requirements.txt
pip install -r overrides.txt
```

> `pypowsybl` and `expert_op4grid_recommender` must already be installed in your Python environment.

### 2. Start the backend

```bash
python -m expert_backend.main
# or
uvicorn expert_backend.main:app --host 0.0.0.0 --port 8000
```

The API server starts on `http://localhost:8000`.

### 3. Install and start the frontend

```bash
cd frontend
npm install
npm run dev
```

Open the Vite dev-server URL shown in the terminal (typically `http://localhost:5173`).

### 4. Use the application

1. Open **Settings → Paths** and set the network directory (containing `.xiidm` files), the action definition JSON, and optionally an output folder for saved sessions.
2. Open **Settings → Recommender** and pick which recommendation model to run
   (Expert by default). The parameter inputs below the dropdown render
   dynamically from the active model's `params_spec()`. The model can also be
   swapped later from the selector above the Analyze & Suggest button.
3. Click **Load Study** to load the network.
4. Pick a disconnectable element (line or transformer) from the searchable dropdown — the N-1 diagram is fetched with overloads highlighted automatically.
5. Click **Analyze & Suggest** (two-step flow): select which overloads to resolve, then watch the action feed stream in.
6. Inspect prioritized actions, simulate manual ones, or open the **Combine** modal to explore action pairs.
7. To try a different recommender, hit **Clear** under the Suggested Actions tab header (keeps your starred / rejected / manually-added actions), pick a model in the dropdown above Analyze & Suggest, and re-run.
8. Detach any visualization tab (`⧉`) onto a second screen for dual-monitor studies.
9. Hit **Save Results** to export the full session (including the active recommender model under `analysis.active_model`); **Reload Session** restores it exactly, without re-simulating anything.

---

## API Reference

### Configuration & session
| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/api/user-config` | Read persisted user configuration |
| `POST` | `/api/user-config` | Persist user configuration (paths, recommender params) |
| `GET`  | `/api/config-file-path` | Get the current user config file path |
| `POST` | `/api/config-file-path` | Set a custom user config file path |
| `POST` | `/api/config` | Load network + set all recommender parameters (incl. `model` and `compute_overflow_graph`) |
| `GET`  | `/api/models` | List registered recommendation models with their `params_spec()` and capability flags |
| `POST` | `/api/recommender-model` | Lightweight swap of the active recommender model (no network reload) — fired by the model dropdowns in Settings and above Analyze & Suggest |
| `GET`  | `/api/pick-path` | Open the native OS file / directory picker |
| `POST` | `/api/save-session` | Save a session folder (JSON snapshot + PDF + interaction log; includes `analysis.active_model`) |
| `GET`  | `/api/list-sessions` | List saved session folders |
| `POST` | `/api/load-session` | Load a session JSON and restore PDFs |
| `POST` | `/api/restore-analysis-context` | Restore the backend analysis context from a saved session |

### Network introspection
| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/api/branches` | List disconnectable elements (lines + 2-winding transformers) |
| `GET`  | `/api/voltage-levels` | List voltage levels in the network |
| `GET`  | `/api/nominal-voltages` | Map voltage level IDs to nominal voltages (kV) |
| `GET`  | `/api/element-voltage-levels` | Resolve an equipment ID to its voltage level IDs |
| `GET`  | `/api/voltage-level-substations` | Map voltage level IDs to their parent substation IDs |
| `GET`  | `/api/actions` | Return all available action IDs and descriptions |

### Analysis
| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/run-analysis` | Legacy one-shot N-1 analysis (streaming NDJSON) |
| `POST` | `/api/run-analysis-step1` | Two-step flow — step 1: detect overloads |
| `POST` | `/api/run-analysis-step2` | Two-step flow — step 2: resolve with the active recommender model (streaming NDJSON; `result` event includes `active_model` + `compute_overflow_graph`) |
| `POST` | `/api/simulate-manual-action` | Simulate a specific action against a contingency |
| `POST` | `/api/compute-superposition` | Compute the combined effect of two actions (superposition) |

### Diagrams
| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/api/network-diagram` | Get the N-state network SVG (NAD) |
| `POST` | `/api/contingency-diagram` | Get the post-contingency N-1 diagram with flow deltas |
| `POST` | `/api/contingency-diagram-patch` | Per-branch delta (SVG-less) for DOM-recycling fast path (PR #108) |
| `POST` | `/api/action-variant-diagram` | Diagram after applying a remedial action |
| `POST` | `/api/action-variant-diagram-patch` | Per-branch delta + VL-subtree splice for action DOM recycling |
| `POST` | `/api/focused-diagram` | Sub-diagram focused on an element with configurable depth |
| `POST` | `/api/action-variant-focused-diagram` | Focused NAD for a specific VL in post-action state |
| `POST` | `/api/n-sld` | Single Line Diagram for a voltage level in N state |
| `POST` | `/api/contingency-sld` | SLD in N-1 state with flow deltas |
| `POST` | `/api/action-variant-sld` | SLD in post-action state |
| `POST` | `/api/simulate-and-variant-diagram` | NDJSON stream: `{type:"metrics"}` then `{type:"diagram"}` so sidebar updates ahead of the SVG |
| `POST` | `/api/regenerate-overflow-graph` | Toggle the overflow graph between hierarchical and geo layout (per-study cache, 0.7.0) |
| `GET`  | `/results/pdf/{filename}` | Serve overflow viewer files (interactive HTML by default, PDF on legacy installs) |

---

## Tech Stack

### Backend
- **FastAPI** + **Uvicorn** — web framework and ASGI server
- **pypowsybl** — network loading, load flow simulation, and diagram generation
- **expert_op4grid_recommender** — domain-specific grid action recommender system
- **NumPy**, **pandas**, **lxml** — vectorized pipeline and SVG post-processing

### Frontend
- **React 19** with **TypeScript 5.9**
- **Vite 7** — build tool and dev server
- **axios** — HTTP client
- **react-select** — searchable dropdown for branch selection
- **react-zoom-pan-pinch** — pan/zoom for SVG visualizations
- **vite-plugin-singlefile** — auto-generated single-file standalone bundle
- **Vitest** + **React Testing Library** — unit tests (~1000 specs)

---

## Development

### Build & lint

```bash
cd frontend
npm run build      # TypeScript compilation + Vite production build
npm run lint       # ESLint v9+ flat config
npm run preview    # Preview production build
```

### Tests

Backend unit tests (pytest, runs without `pypowsybl` /
`expert_op4grid_recommender` thanks to the `conftest.py` mock
layer — see [`expert_backend/tests/CLAUDE.md`](expert_backend/tests/CLAUDE.md)):

```bash
pytest                                   # Full backend suite
pytest expert_backend/tests/test_mw_start.py   # Single file
pytest -k "TestSuperposition"            # Pattern
```

Frontend unit tests (Vitest + React Testing Library):

```bash
cd frontend && npm run test
```

Code-quality gate (CI-enforced, PR #104):

```bash
python scripts/check_code_quality.py                 # Exit non-zero on regression
python scripts/code_quality_report.py --summary      # Local Markdown report
```

Ad-hoc integration / profiling scripts (require a running backend
and real data paths):

```bash
python expert_backend/test_backend.py                # Config + branches + analysis
python scripts/profile_diagram_perf.py               # NAD rendering profiler
python scripts/pypsa_eur/test_pipeline.py            # PyPSA-EUR end-to-end smoke test
pytest scripts/pypsa_eur                             # PyPSA-EUR pipeline unit tests
```

---

## Standalone Interface

The single-file standalone UI is **auto-generated** from the React
source tree (PR #101). Build it with:

```bash
cd frontend && npm run build:standalone
```

The output is `frontend/dist-standalone/standalone.html` — a ~1 MB
self-contained HTML with React + CSS inlined via
`vite-plugin-singlefile`. Open it directly in a browser (pointed at
a running backend). It mirrors every feature of the React app —
detachable tabs, SLD highlights, combined actions, PST / curtailment
/ load-shedding cards, interaction logging, zoom-tier level of
detail, SVG DOM recycling — with no build step for consumers.

The legacy hand-maintained `standalone_interface.html` has been
decommissioned and renamed to `standalone_interface_legacy.html`
(committed as a frozen snapshot, do NOT edit). UI changes land only
in `frontend/src/` — the auto-generated bundle inherits them on the
next `npm run build:standalone`.

Parity between the React source and the bundle is guarded by four
layers of automated checks (`scripts/check_standalone_parity.py`,
`scripts/check_session_fidelity.py`,
`scripts/check_gesture_sequence.py`, `scripts/check_invariants.py`)
— see [`frontend/PARITY_AUDIT.md`](frontend/PARITY_AUDIT.md).

---

## Data Formats

- **Network files**: `.xiidm` (loaded by pypowsybl)
- **Action definitions**: `.json` mapping action IDs to descriptions, supporting topology, PST, `set_load_p`, and `set_gen_p` formats
- **Network layouts**: `grid_layout.json` with node-ID → `[x, y]` coordinates
- **Generated outputs**: PDF overflow graphs in `Overflow_Graph/`
- **Session folder**: `costudy4grid_session_<contingency>_<timestamp>/` containing `session.json`, `interaction_log.json`, and an overflow PDF copy. `session.json` includes `analysis.active_model` (the recommender that produced the suggestions) and `analysis.compute_overflow_graph` (whether step-2 graph ran).

---

## Changelog

See [`CHANGELOG.md`](CHANGELOG.md) for the list of changes per release. The current release is **0.7.5**.

---

## License

Copyright 2025–2026 RTE France
RTE: <http://www.rte-france.com>

This Source Code is subject to the terms of the Mozilla Public License (MPL) v2, also available [here](https://www.mozilla.org/en-US/MPL/2.0/).
