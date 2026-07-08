# Proposal — Decompose the "ceiling-rider" hot files

**Status:** Tracked for the next release (deferred target #4 from the
2026-06-18 code-quality revision — see
[`docs/architecture/code-quality-analysis.md`](../architecture/code-quality-analysis.md)
§19/§21).
**Date:** 2026-06-18
**Owner:** unassigned

## Why now

The code-quality gate tightened its size / complexity ceilings toward
the current maxima (analysis-doc §17 "module 1200→1150, function
250→240, component 1500→1450"; §19 scorecard). That locked in the
hard-won decompositions — but it also means several files now **ride**
their ceiling with little headroom. The next routine feature touching
one of them will trip CI, forcing an *emergency* split under deadline
pressure instead of a considered one.

This proposal traces the need and the investigation so the work can be
scheduled deliberately for the next release, target-by-target.

## Investigation — current margins (measured 2026-06-18)

Generated from `python scripts/code_quality_report.py`. "Margin" is
lines/CC remaining before the gate fails.

### Backend module size (ceiling 1150)

| Module | Lines | Margin | Note |
|--------|------:|-------:|------|
| `services/simulation_mixin.py` | **1110** | **+40** | tightest; *grew this session* (annotation imports) |
| `services/overflow_overlay.py` | 1055 | +95 | 924 lines are one exempt template f-string |
| `services/analysis_mixin.py` | 1010 | +140 | thin orchestrator, but dense |
| `main.py` | 967 | +183 | FastAPI route layer |
| `services/recommender_service.py` | 932 | +218 | state lifecycle hub |

### Backend function size (ceiling 240) / complexity (ceiling 38)

| Function | Lines | CC / nest | Margin | Note |
|----------|------:|:---------:|-------:|------|
| `recommenders/_service_integration.py::_run_analysis_step2_with_model` | **226** | — | **+14** | tightest function; the model-swap step2 path *(resolved 2026-07 D1: module deleted; the unified `analysis_mixin.run_analysis_step2` extracted `_run_step2_discovery` / `_enrich_step2_results` helpers)* |
| `services/simulation_mixin.py::simulate_manual_action` | 207 | — | +33 | |
| `services/diagram/action_patch.py::build_action_patch_payload` | 204 | — | +36 | |
| `services/recommender_service.py::update_config` | 191 | **CC 35** | +49 / **+3 CC** | tightest *complexity* |
| `services/network_service.py::get_element_names` | — | CC 33 | +5 CC | |
| `services/analysis_mixin.py::_narrow_context_to_selected_overloads` | — | CC 30 / **nest 7** | +1 nest | deep nesting |

### Frontend component size (ceiling 1450; `App.tsx` hub ceiling 2100)

| Component | Lines | Margin | Note |
|-----------|------:|-------:|------|
| `App.tsx` | 1982 | +118 | hub; decomposition already scoped (see below) |
| `components/VisualizationPanel.tsx` | **1407** | **+43** | tightest frontend file |
| `components/ActionFeed.tsx` | 1328 | +122 | already shed ActionCard / ActionSearchDropdown |
| `hooks/useDiagrams.ts` | 1221 | +229 | already shed useSldOverlay |
| `components/SldOverlay.tsx` | 1147 | +303 | |
| `components/ActionOverviewDiagram.tsx` | 1097 | +353 | |

## Decomposition candidates (per target)

Each is a **real concern to extract**, not a cosmetic line-shuffle. The
gate is the trigger, not the goal — extract along a seam that improves
readability, or leave it.

1. **`simulation_mixin.py` (1110/1150) — highest priority.**
   It is the "manual-action **+** superposition orchestrator" (two
   concerns on one `self`). Extract the **superposition** slice
   (`compute_superposition`, `_augment_superposition_result`,
   `_superposition_lines_overloaded`, `_ensure_pair_simulated`,
   `_build_combined_action_object`) into a `SuperpositionMixin` (or a
   `services/simulation/superposition.py` helper package, mirroring the
   PR #104 mixin→helper pattern). Restores ~150–200 lines of headroom.

2. **`overflow_overlay.py` (1055/1150) — high leverage, low risk.**
   924 of its lines are the `_build_overlay_block` template f-string
   (the injected `<style>` + `<script>`), already function-size-exempt.
   Move the template to **external asset files** (`overlay.css` /
   `overlay.js` read at runtime, the way `pinGlyph.js` is handled)
   instead of an inline f-string. This both drops the module well under
   the ceiling **and** retires a gate exemption.

3. **`_run_analysis_step2_with_model` (226/240) — tightest function.**
   ~~Extract the per-model graph-vs-discovery orchestration sub-steps
   into named helpers in `recommenders/_service_integration.py`.~~
   **Done (2026-07 D1)**: `_service_integration.py` was deleted; the
   single model-aware `analysis_mixin.run_analysis_step2` delegates to
   `_run_step2_discovery` / `_enrich_step2_results` helpers.

4. **`update_config` (CC 35) + `_narrow_context_to_selected_overloads`
   (CC 30 / nest 7).** Both are complexity, not size. `update_config`:
   extract per-section config application (`_apply_recommender_config`,
   `_apply_monitoring_config`, …) — drops CC and reads better.
   `_narrow_context…`: invert the deep nesting with guard clauses /
   an extracted inner loop.

5. **`VisualizationPanel.tsx` (1407/1450) — tightest frontend file.**
   Extract the inspect/search affordance (the `InspectSearchField`
   wiring is already a component — pull more of its host logic) or the
   per-tab toolbar row into a `VizTabBar` sub-component.

6. **`App.tsx` (1982/2100).** Already scoped: see the **"Deferred"**
   section of [`frontend/CLAUDE.md`](../../frontend/CLAUDE.md) —
   *Option 3* (`useSettingsOrchestration` / `useSaveLoadSession` /
   `useStateReset` hooks, ~400 lines out) and *Option 4* (AppContext).
   Option 3 is the recommended next step; Option 4 is explicitly **not**
   recommended (re-render surface area). Mind the parameter-threading
   cost flagged there.

7. **`ActionFeed.tsx` (1328/1450).** The inlined
   `handleSimulateUnsimulatedAction` NDJSON parser (~90 lines,
   duplicated from `useAnalysis`) is the documented extraction
   candidate → a shared `utils/ndjsonStream.ts` (also noted in
   frontend/CLAUDE.md "Deferred").

## Suggested order (by urgency = tightest margin)

1. `simulation_mixin.py` superposition split (+40 module margin, and it
   is actively growing).
2. `VisualizationPanel.tsx` (+43, frontend gate trigger).
3. `_run_analysis_step2_with_model` (+14 function margin).
4. `overflow_overlay.py` template-to-asset (high leverage, also retires
   an exemption).
5. `update_config` / `_narrow_context…` complexity (the CC/nest
   margins are +3 / +1).
6. `App.tsx` Option 3 + `ActionFeed` NDJSON extraction (more headroom;
   schedule when the boundary is stable).

## Acceptance criteria

- Each tackled target back under **~90 % of its ceiling** (real
  headroom, not a 1-line pass).
- **No behaviour change**: backend pytest + the four parity layers +
  the Vitest suite all green; `mypy` stays at 0; the offline backend
  suite stays byte-identical (the §1 regression-proof method).
- Where a template/exempt function is decomposed (target #2), **remove
  its entry from the gate's exemption allowlists** in
  `scripts/check_code_quality.py`.
- Update the relevant `CLAUDE.md` layout notes and add a dated delta to
  the analysis doc.

## Non-goals

- Do **not** extract purely to satisfy the gate. If a file has no clean
  seam, raise the question in review rather than manufacture an
  artificial sub-module.
- `App.tsx` Option 4 (AppContext) remains out of scope (see
  frontend/CLAUDE.md rationale).

## References

- Ceilings + exemptions: [`scripts/check_code_quality.py`](../../scripts/check_code_quality.py)
- Live metrics: `python scripts/code_quality_report.py`
- Decomposition history + this deferral: analysis-doc §§2–3, 10–13, 16,
  19, 21.
- Already-scoped frontend splits: [`frontend/CLAUDE.md`](../../frontend/CLAUDE.md)
  "App.tsx refactor history → Deferred".
