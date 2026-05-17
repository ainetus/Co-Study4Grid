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
| `demo_replay.spec.ts` | **Runner.** Walks the scenario, drives gestures with Playwright, asserts invariants on the live DOM, then diffs the captured `interactionLogger` log against the golden trace. |
| `playwright.config.ts` | Shared with the existing `e2e_parity.spec.ts`; no changes needed. |
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

## Prerequisites (one-time)

1. **Expose the interaction logger on `window`.**
   The runner reads `window.__interactionLogger` to compare against the
   golden trace. Today the `interactionLogger` singleton in
   `frontend/src/utils/interactionLogger.ts:67` is module-scoped only.
   Land this one-liner in `frontend/src/main.tsx` (or via a `useEffect`
   in `App.tsx`):

   ```ts
   if (import.meta.env.DEV || import.meta.env.VITE_EXPOSE_LOGGER) {
       (window as unknown as { __interactionLogger: typeof interactionLogger }).__interactionLogger
           = interactionLogger;
   }
   ```

   Without this, log-capture returns `[]` and the golden-trace assertion
   in the last test case becomes a no-op (the DOM-invariant assertions
   still run).

2. **Land the missing `data-testid` hooks** that `demo_scenario.ts` flags
   as `TODO(testid)`. Each is a ~1-line edit:
   - `NoticesPanel.tsx` — `data-testid="notice-action-dict"`,
     `data-testid="notice-threshold"`, `data-testid="notices-pill"`.
   - `SidebarSummary.tsx` — `data-testid="sidebar-summary-contingency"`,
     `data-testid="sidebar-summary-overload-rho"`.
   - `DiagramLegend.tsx` — `data-testid="diagram-legend"`.
   - `SldOverlay.tsx` — `data-testid="sld-overlay"`.
   - `ActionOverviewDiagram.tsx` — `data-pin-state="simulated|unsimulated|combined"`
     on each pin `<g>` (today only `data-action-id` is present, see
     line 826).

3. **(Optional) Run against the real backend.**
   Set `COSTUDY4GRID_REAL_BACKEND=1` and start
   `uvicorn expert_backend.main:app --port 8000` separately. The spec
   then skips the `page.route` mock layer. **Not yet implemented** —
   the env-var branch in `registerMockBackend()` is currently empty.
   Wiring it requires a `globalSetup` that does
   `POST /api/config { network_path: bare_env_small_grid_test/... }`
   before the first test.

## What the scaffold does today

| Checkpoint | Gesture wired | Invariants wired | Notes |
|------------|:---:|:---:|---|
| Étape 1 — Charger | ✓ | partial | Notices testids missing |
| Étape 2 — Contingence | ✓ | ✓ | |
| Étape 3 — Impact view | ✓ | ✓ | |
| Étape 4 — First guess | — | data-only | Need stable id for the COUCHP6 pre-played action |
| Étape 5 — Asset zoom | — | — | Need stable selector for asset chip in card |
| Étape 6 — Impact action | — | — | Composable from `toggleViewMode` |
| Étape 7 — Detach | — | partial | Real popup automation; or skip per `interaction-logging.md` |
| Étape 8 — Analyze | ✓ | ✓ | |
| Étape 8b — Overflow layers | — | — | Cross-iframe postMessage; deferred |
| Étape 8c — Display | — | ✓ | Trivial once analyze is reused |
| Étape 9 — Explore | — | partial | |
| Étape 10 — Overview pins | — | partial | |
| Étape 11 — MW re-simulate | — | partial | `data-testid="resimulate-${id}"` already there |
| Étape 12 — Combine | partial | partial | Modal opens; pair-pick UI selectors needed |
| Étape 13 — Save | ✓ | — | |

`✓` = fully wired today, `partial` = partial (some sub-asserts missing),
`—` = stub (test.fixme placeholder or TODO comment).

## Layers of visual verification (recap)

| Layer | Implemented here | Cost | Catches |
|-------|:---:|:---:|---|
| **A — Structural invariants** (count, visible, class, attribute) | ✓ via `Invariant` | very low | 90 % of UI regressions (missing halo, lost pin, broken filter) |
| **B — Normalised SVG snapshots** | — (planned) | low | Diagram-rendering drift |
| **C — Pixel diff (targeted)** | — (planned) | high | Theme / token / font regressions |
| **D — Meta-invariants** (no empty text, no console errors) | — (planned) | low | Catastrophic mis-renders |

Layer A is in the scenario file. Layers B-D will live in companion specs
(`demo_visual_snapshots.spec.ts`, `demo_meta_invariants.spec.ts`) once
A is fully wired.

## CI wiring

To add to `.github/workflows/parity.yml`:

```yaml
  - run: cd frontend && npm ci && npm run build
  - run: cd scripts/parity_e2e && npm ci
  - run: cd scripts/parity_e2e && npx playwright install --with-deps chromium
  - run: cd scripts/parity_e2e && npx playwright test demo_replay.spec.ts
```

Total expected cost once fully wired: ≤ 90 s (matches the existing
`e2e_parity.spec.ts` budget).

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
