# Demo-scenario replay — Layer 3c

A scenario-driven E2E spec that translates the manual `Fiche_demo_CoStudy4Grid`
into an automated regression net on `config_small_grid`. Complements the
existing four parity layers (static / session-fidelity / gesture-sequence /
invariants) by binding the demo's **storyline** to **structural invariants**
on the live DOM.

## Files in this folder

| File | Role |
|------|------|
| `fixtures/demo_small_grid_log.golden.json` | **Golden trace.** Curated `interaction_log.json` from a real demo run on `config_small_grid`. 48 events (raw capture was 79; trimming rationale in `_meta.normalizations`). Re-capture by playing the demo and overwriting this file. |
| `fixtures/demo_scenario.ts` | **Fiche-as-data.** Each checkpoint maps one paragraph of the fiche → expected events + structural invariants. **This is the file non-developers edit** to extend coverage. |
| `demo_replay.spec.ts` | **Layer A — structural invariants.** Walks the scenario, drives gestures with Playwright, asserts invariants on the live DOM, then diffs the captured `interactionLogger` log against the golden trace. |
| `demo_visual_snapshots.spec.ts` | **Layer B — normalised SVG/HTML snapshots.** Captures 3 stable surfaces (action card, overview map, combine modal) and diffs against text goldens under `__snapshots__/`. Scrubs auto-ids + rounds float coords + sorts attributes so the diffs stay readable. |
| `demo_meta_invariants.spec.ts` | **Layer D — meta-invariants.** Cheap, broad sanity checks: no console errors, no empty visible text, no `undefined/null/NaN` ids, no degenerate viewBox, pin-count consistency. |
| `playwright.config.ts` | Shared; `testMatch` now picks up `demo_*.spec.ts` alongside the existing `*parity.spec.ts`. |
| `package.json` | Shared with the existing parity spec. |

## How the three layers interact

```
  Fiche markdown                Scenario (data)              Runner (code)
  =================             ==================           ===============
  Étape 2 — Jouer       ─────►  events: [                    addContingencyAndApply()
  une contingence                  contingency_element_added, ─┐
                                   contingency_applied         │ Playwright
                                ]                              │ gesture
                                invariants: [               ◄──┘
                                   .nad-contingency-target × 1,
                                   .nad-overloaded ≥ 1,         <── DOM assertion
                                   sidebar-summary-contingency  <── visible
                                ]                       
                                                              <── log capture +
                                                                  golden diff
```

The runner does NOT know what "étape 2" means semantically — it only knows
how to dispatch a gesture (e.g. `addContingencyAndApply`) and how to assert
an invariant (CSS selector + count/visible/class). Adding a fiche step
means adding rows to `demo_scenario.ts` and, occasionally, a new dispatcher
in the runner.

## Running locally

```bash
# One-time
cd frontend && npm install && npm run build && cd ..
cd scripts/parity_e2e && npm install && npx playwright install chromium

# Run the demo replay only
npx playwright test demo_replay.spec.ts

# Run a single act
npx playwright test demo_replay.spec.ts -g "Acte 1"

# Headed mode (for debugging visual invariants)
npx playwright test demo_replay.spec.ts --headed
```

## Prerequisites (landed)

1. **Interaction logger bridge** (`main.tsx`) — exposes
   `window.__interactionLogger` in dev / `VITE_EXPOSE_LOGGER` builds so
   Playwright can call `getLog()`. Production builds are unaffected;
   Vite tree-shakes the bridge away.

2. **`data-testid` hooks** landed across the 5 components the demo
   scenario relies on:
   - `main.tsx` — logger bridge.
   - `SidebarSummary.tsx` — `sidebar-summary-contingency`, `sidebar-summary-overloads`.
   - `SldOverlay.tsx` — `sld-overlay` + `data-vl-name=${vl}`.
   - `AppSidebar.tsx` — `contingency-trigger` on the Trigger button.
   - `VisualizationPanel.tsx` — `tab-button-${id}`, `tab-detach-${id}`,
     `data-tab-active="true|false"` on each tab.
   - `ActionFeed.tsx` — `analyze-suggest`, `display-prioritized-actions`.
   - `ActionCard.tsx` — `favorite-${id}`, `reject-${id}` on the rail buttons.

3. **Real backend mode** (now landed): set `COSTUDY4GRID_REAL_BACKEND=1`.
   The mock-route layer short-circuits and `playwright.global-setup.ts`
   POSTs `/api/config` with the small_grid paths so subsequent specs
   hit a pre-loaded state. Two flavours:

   ```bash
   # (a) Run uvicorn yourself, point Playwright at it (default).
   uvicorn expert_backend.main:app --port 8000 &
   COSTUDY4GRID_REAL_BACKEND=1 npx playwright test

   # (b) Let Playwright spawn + teardown uvicorn for you.
   COSTUDY4GRID_REAL_BACKEND=1 \
   COSTUDY4GRID_SPAWN_BACKEND=1 \
   npx playwright test
   ```

   Override the backend URL with `COSTUDY4GRID_BACKEND_URL=http://host:port`
   when running against a non-default address. The global-setup waits
   up to 60 s for `/api/user-config` to respond before failing.

## Numerical contract: pytest companion

Étape D of the test plan lives at
`expert_backend/tests/test_demo_scenario_small_grid.py`. It mirrors
the numerical assertions the demo trace embeds (1 overload detected,
10 prioritised actions including disco_BEON / node_merging_PYMONP3 /
load_shedding_BEON3, two superposition pairs converging to
the recorded rho values) — directly against the real backend via
FastAPI's `TestClient`. Skipped when the small_grid data is missing
or when the conftest mock layer is active.

```bash
# Run the demo-numerical suite (slow — loads the real network).
pytest expert_backend/tests/test_demo_scenario_small_grid.py -m slow

# Or run a single assertion:
pytest expert_backend/tests/test_demo_scenario_small_grid.py::TestDemoScenarioSmallGrid::test_compute_superposition_matches_golden_trace
```

Tolerances on the superposition pairs (`COMBINED_PAIR_*` constants
in the test file) are 1% absolute on `simulated_max_rho` — loose
enough to absorb minor loadflow drift, tight enough to catch a real
regression. Re-tune by re-running the demo and copying the new
`simulated_max_rho` values from the saved `interaction_log.json`.

## What the scaffold does today

| Checkpoint | Gesture wired | Invariants wired | Notes |
|------------|:---:|:---:|---|
| Étape 1 — Charger | ✓ | ✓ | |
| Étape 2 — Contingence | ✓ | ✓ | |
| Étape 3 — Impact view | ✓ | ✓ | |
| Étape 4 — First guess | ✓ | ✓ | Mock backend returns an `open_coupling_COUCHP6_uuid` candidate from `/api/actions` for the dropdown. |
| Étape 5 — Asset zoom | ✓ | ✓ | SLD open is driven by `dblclick` on the mock VL node. |
| Étape 6 — Impact action | ✓ | — | Composable from `toggleViewMode`; no DOM invariant. |
| Étape 7 — Detach | ✓ | ✓ | Real popup automation is best-effort: the gesture is logged even if Chromium blocks the popup. |
| Étape 8 — Analyze | ✓ | ✓ | |
| Étape 8b — Overflow layers | ✓ | ✓ | Driven via `simulateOverflowIframeGestures` — postMessages the 6 `cs4g:*` envelopes directly to the parent `window`. Validates the message → log pipeline; iframe-side rendering is not exercised (covered by alphaDeesp's own tests). |
| Étape 8c — Display | ✓ | ✓ | |
| Étape 9 — Explore | ✓ | ✓ | |
| Étape 10 — Overview pins | ✓ | ✓ | |
| Étape 11 — MW re-simulate | ✓ | ✓ | |
| Étape 12 — Combine | ✓ | ✓ | Pair-pick UI is exercised through the modal body; superposition mock returns the recorded rho values from `COMBINED_PAIR_EXPECTED_RHO`. |
| Étape 13 — Save | ✓ | — | |

`✓` = wired in the runner today, `—` = deferred (rationale in the
Notes column).

## Layers of visual verification (recap)

| Layer | Implemented here | Cost | Catches |
|-------|:---:|:---:|---|
| **A — Structural invariants** (count, visible, class, attribute) | ✓ `demo_replay.spec.ts` | very low | 90 % of UI regressions (missing halo, lost pin, broken filter) |
| **B — Normalised SVG/HTML snapshots** | ✓ `demo_visual_snapshots.spec.ts` | low | Diagram-rendering drift, lost attribute, renamed class |
| **C — Pixel diff (targeted)** | — (not planned for now) | high | Theme / token / font regressions — already gated by the design-token rule in `check_code_quality.py` |
| **D — Meta-invariants** (no empty text, no console errors, valid ids) | ✓ `demo_meta_invariants.spec.ts` | low | Catastrophic mis-renders |

Layer C remains deliberately out of scope — the design-token gate in
`check_code_quality.py` already locks down the visual contract for
colours/spacing/radius, and pixel diffs on pypowsybl NADs are
prohibitively noisy. If a specific surface ever needs pixel-level
guarantees (e.g. the printed legend in a PR-screenshot deliverable),
extend `demo_visual_snapshots.spec.ts` with `toHaveScreenshot()` on a
viewport-frozen locator.

## CI wiring (landed)

`.github/workflows/parity.yml` now ships two Playwright jobs:

| Job | When | What it runs | Cost |
|-----|------|--------------|------|
| `demo-meta-invariants` | every push/PR | `demo_meta_invariants.spec.ts` only | ~ 1.5 min |
| `layer3b-behavioural-e2e` | nightly + PRs with `e2e` label | ALL specs (`e2e_parity` + 3 demo specs) | ~ 3 min |

The fast lane runs on every commit because the meta-invariants
catch console errors and undefined-id leaks at low cost — bugs no
static check can see. The full lane stays gated to keep the
per-commit CI minutes bounded.

## OS-agnostic snapshots

`playwright.config.ts` sets:

```ts
snapshotPathTemplate: '{testFilePath}-snapshots/{arg}{ext}',
```

This drops the default `{-projectName}{-platform}` suffix. Rationale:
the snapshots in `demo_visual_snapshots.spec.ts` are **text-serialised
+ normalised DOM/SVG** — they carry no antialias, no font rendering,
no pixel data. The same baseline holds on macOS (dev), Linux (CI) and
Windows. Per-channel separation (chromium vs firefox) would matter
only if we add a non-chromium project, which we don't.

If you regenerate the baselines, the resulting files are
`<surface>.txt` (no suffix) — commit them as-is. Existing baselines
generated with the default template (e.g. `<surface>-chromium-darwin.txt`)
need to be renamed or regenerated once after this config change:

```bash
cd scripts/parity_e2e
rm -rf demo_visual_snapshots.spec.ts-snapshots/
npx playwright test demo_visual_snapshots.spec.ts --update-snapshots
git add demo_visual_snapshots.spec.ts-snapshots/
```

## Recapturing the golden trace

When the demo evolves (new fiche steps, new analysis output, new actions
on small_grid), re-record:

```
1. Start backend with small_grid config + frontend dev server.
2. Play the fiche end-to-end.
3. Click Save Results.
4. Copy `<output_folder>/.../interaction_log.json` →
   `scripts/parity_e2e/fixtures/demo_small_grid_log.golden.json`.
5. Re-run the normalization (scrub absolute paths, trim startup noise,
   re-number seq). Today this is manual; a small `normalize_log.py`
   script is a natural follow-up.
6. Re-run `npx playwright test demo_replay.spec.ts` and update any
   numeric tolerances in `COMBINED_PAIR_EXPECTED_RHO` if the recommender
   has drifted within band.
```

## Why no pixel diffs in this spec?

Three reasons, documented for posterity:

1. **The NAD is 12 MB and viewport-dependent.** Pan/zoom + antialias
   variance produce 100s of noise pixels per run. Diff threshold
   tuning becomes a full-time job.
2. **Design-token regressions are already gated** by the
   `check_code_quality.py` zero-hex-literals rule (root `CLAUDE.md`
   §Design tokens).
3. **Structural invariants catch the bugs operators notice** — a halo
   that disappears, a pin that stops rendering, a legend that vanishes
   — without coupling the test to a specific render of those shapes.

Layer C will land for 3-4 stable surfaces (legend, action card, combine
modal, overview at a frozen viewBox) in a follow-up spec.
