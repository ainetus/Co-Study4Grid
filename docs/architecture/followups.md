# Tracked follow-ups (in-repo issue log)

GitHub Issues are disabled on `marota/Co-Study4Grid`, so deferred work
that would otherwise be a GitHub issue is tracked here. Each entry is a
self-contained "issue": context, what's deferred and why, and a suggested
approach. Close an entry by deleting it (and noting the resolving commit
in the relevant doc).

---

## FU-1 — Split the deeply-coupled `useDiagrams` core

**Status:** open · **Area:** frontend / refactor / tech-debt · **Opened:** 2026-07-08

### Context

Deep revision **D4** ("relieve the two frontend hubs", see
[`2026-07-full-repo-review.md`](2026-07-full-repo-review.md) Part V + theme
T5) has landed stages 1–3:

- **D4a/D4b** — `hooks/useManualSimulation.ts` extracted from `App.tsx`
  (2048 → 1795 lines; `APP_TSX_MAX` ratcheted 2100 → 1850).
- **D4c** — the two *decoupled* `useDiagrams` domains are now sub-hooks
  composed behind the byte-identical `DiagramsState` facade:
  `hooks/useOverflowLayout.ts` + `hooks/useActionDiagramCache.ts`
  (useDiagrams 1210 → 1145).
- **D4d + follow-ups** — the exploded `VisualizationPanel` / `ActionFeed`
  props consolidated into cohesive state-object props.

### What's deferred (and why)

The remaining `useDiagrams` **core** was intentionally left in place:

- `handleActionSelect` (~240 lines)
- `zoomToElement` (~130 lines)
- the **DOM-mutating voltage-filter** state + `applyVoltageFilter` + its
  effect (~130 lines)
- the auto-zoom effect

These are tightly coupled to the container refs, metadata indices, the
three diagrams, `activeTab`, and to **each other via effect ordering**.
Extracting them into per-domain sub-hooks moves where those effects
register in the hook order, which changes DOM-mutation timing that
**`tsc` cannot verify** — the "load-bearing instantiation order" the
review flagged. A wrong split surfaces as a silent visual/interaction
regression (stale highlights, wrong zoom target, the voltage filter
leaving elements hidden), not a type or test error — so it needs
behavioural coverage in place first.

### Suggested approach

1. Extract `useVoltageFilter` **first** and in isolation — it is the most
   cohesive chunk. Call it at the *same position* in the hook body so its
   effect keeps its current registration order relative to the auto-zoom +
   id-map-invalidation effects; pass the container refs / metaIndexes /
   diagrams / `activeTab` as inputs; keep the `DiagramsState` facade
   unchanged (`nominalVoltageMap` / `uniqueVoltages` / `voltageRange` +
   setters).
2. Add a **behavioural** regression test (not just render) that exercises
   the voltage filter hiding/showing elements across a range change and a
   tab switch, so the effect-timing contract is locked before/after.
3. Only then consider `handleActionSelect` / `zoomToElement`, which are
   larger and more coupled.

Facade-preserving throughout, so consumers/tests stay untouched — the risk
is purely internal effect ordering, hence the extra behavioural coverage.

### References

- `frontend/src/hooks/useDiagrams.ts`
- The shipped decoupled sub-hooks: `frontend/src/hooks/useOverflowLayout.ts`,
  `frontend/src/hooks/useActionDiagramCache.ts`

---

## FU-2 — Physically replay the exported Game Mode session log

**Status:** landed (tooling + hermetic coverage; real-grid reference runs in the
e2e lane) · **Area:** game-mode / benchmark / trust · **Opened:** 2026-07-09 ·
**Resolved:** 2026-07-09

> **Resolution.** `scripts/game_mode/e2e_game_session.py` now has a
> `--replay <session.json>` mode: for each recorded study it re-drives the real
> backend (config → step1 → step2), re-derives the trusted `finalMaxRho` /
> `solved` from the log's recorded `actionsChosen` (falling back to
> `/api/simulate-manual-action` for an action no longer in the prioritized set),
> writes a trusted `reference.json` in the `apply_reference()` shape, and flags
> any study whose replayed numbers diverge from the self-reported ones beyond a
> `--tolerance` (tamper / drift detection; non-zero exit on divergence). The
> replay *machinery* is guarded hermetically by `scripts/game_mode/test_replay.py`
> (fake backend client — runs in CI from a fresh clone). What still requires the
> real FR/EUR grid bundle is *generating* the trusted reference for the public
> ranking, which stays an on-demand e2e-lane activity by design (same dependency
> the e2e harness already carries). The original write-up is kept below for
> context.

### Context

Deep revision **D8** (reproducible data & benchmark supply chain) landed four of
its five sub-tasks (see [`2026-07-full-repo-review.md`](2026-07-full-repo-review.md)
Part V, D8): the layout-scale fix + `separate_voltage_levels` wired into
`build_pipeline.py`, the bundle provenance manifest, the hermetic pipeline slice
in CI, and the in-repo Codabench `score.py` pinned to the frontend scorer by a
shared golden fixture.

### What's deferred (and why)

The fifth sub-task — **make the exported session log physically replayable** — is
left open. The public ranking currently scores **self-reported** per-study
`baselineMaxRho` / `finalMaxRho` / `solved` from the exported
`GameSessionLog`; `apply_reference()` in `score.py` can overlay trusted numbers,
but there is no in-repo tool that *derives* those trusted numbers by re-driving
the backend with the log's recorded `actionsChosen`.

It was deferred rather than half-built because it is only meaningfully
verifiable against a **running backend + a real grid bundle** (the same
dependency the e2e harness carries), which the unit-test lanes don't have — so a
partial implementation couldn't be guarded by a test and would rot.

### Suggested approach

1. Add a `--replay <session.json>` mode to
   `scripts/game_mode/e2e_game_session.py` (it already contains the play/score
   machinery): for each study, load the referenced contingency, apply the log's
   recorded `actionsChosen`, and recompute `finalMaxRho` / `solved`.
2. Emit a trusted `reference.json` in the shape `apply_reference()` consumes, so
   the scorer ranks replayed numbers, not self-reported ones.
3. Flag any study whose replayed `finalMaxRho` diverges from the reported value
   beyond a tolerance (tamper / drift detection).
4. Cover it with a hermetic fixture replay on the small test grid (the FR/EUR
   tiers stay in the real-backend e2e lane).

### References

- `scripts/game_mode/e2e_game_session.py` (`play_study` — the replay machinery)
- `scripts/game_mode/scoring_program/score.py` (`apply_reference`)
- `frontend/src/game/types.ts` (`GameSessionLog` / `ChosenActionRecord`)

---

## FU-3 — Memoize the per-study N-state flow / asset snapshot (QW12)

**Status:** open · **Area:** backend / perf · **Opened:** 2026-07-09

### Context

`DiagramMixin.get_contingency_diagram_patch` (≈ line 396–402) and
`_attach_flow_deltas_vs_base` (≈ line 859–863) both re-derive the **N-state**
base flow / asset snapshot the same way: pin the base network on
`self._get_n_variant()`, then call `get_network_flows()` + `get_asset_flows()`
and restore the variant. The N-state variant is a clean, immutable baseline for
the duration of a study (remedial actions run on separate variants), so this
snapshot is invariant per study and is recomputed on every contingency-patch and
action-variant delta call.

### What's deferred (and why)

Caching the snapshot on the service (`self._n_state_flows` / `self._n_state_assets`,
cleared in `reset()` alongside `_n_state_currents`) is the natural fix, but
`recommender_service.py` is at **exactly its 1150-line module ceiling** — adding
the two init + two reset lines cleanly would breach the code-quality gate, and
squeezing them in with semicolon-joined one-liners degrades the hub file the gate
protects. It is `do_with_care`: a missed invalidation would silently corrupt flow
deltas across studies (the class of bug `docs/features/state-reset-and-confirmation-dialogs.md`
exists to prevent), so it should not be rushed under ceiling pressure. The load
flow itself is already cached per variant, so the win is bounded to the repeated
DataFrame extraction (~100–400 ms/call on the 5 k-VL grid) — real but modest.

### Suggested approach

1. First reclaim ceiling headroom in `recommender_service.py` (extract a small
   cohesive block, e.g. the config-globals push, into a helper) so the two cache
   fields fit within 1150 without hacks.
2. Add `_n_state_flows` / `_n_state_assets` to `__init__` **and** `reset()`
   (same group as `_n_state_currents`), plus the reset-completeness sweep in
   `test_reset_completeness.py` will then require them automatically.
3. Add a `_get_n_state_flow_snapshot()` helper on `DiagramMixin` that lazily
   computes + memoizes both, and route both call sites through it.
4. Document the new caches in `docs/features/state-reset-and-confirmation-dialogs.md`.

### References

- `expert_backend/services/diagram_mixin.py` (`get_contingency_diagram_patch`,
  `_attach_flow_deltas_vs_base`, `_get_network_flows` / `_get_asset_flows`)
- `expert_backend/services/recommender_service.py` (`__init__` / `reset`,
  `_n_state_currents` — the QW17 sibling cache to group with)
- `expert_backend/tests/test_reset_completeness.py` (the sweep that will guard it)

---

## FU-4 — Emit a patch payload from `/api/simulate-and-variant-diagram` (QW13)

**Status:** open · **Area:** backend + frontend / perf · **Opened:** 2026-07-09

### Context

`/api/simulate-and-variant-diagram` streams `{type:"metrics"}` then
`{type:"diagram"}` with a **full** action-variant NAD SVG. The DOM-recycling fast
path (PR #108) already lets the frontend clone the mounted N-state SVG and patch
per-branch deltas for `/api/action-variant-diagram` via
`/api/action-variant-diagram-patch`, avoiding a multi-MB re-download. The combined
simulate-and-variant stream does not yet participate in that fast path.

### What's deferred (and why)

Making the stream emit an optional `{type:"patch"}` event (when the target SVG is
patchable against the mounted N-state clone) touches the backend endpoint **and
all three frontend stream consumers** that read this NDJSON, plus the
`svgPatch.ts` apply path and its fallback. It is `do_with_care`: a wrong
patchability decision produces a *visually* wrong diagram (stale branch colours /
missing VL subtree) that neither `tsc` nor the current tests catch — the same
class of silent regression FU-1 flags. It needs behavioural coverage of the
patch-vs-full branch before it ships, so it is not a drop-in quick win.

### Suggested approach

1. Reuse `services/diagram/action_patch.py` (the existing
   `/api/action-variant-diagram-patch` pipeline) to compute a patch payload inside
   the combined endpoint; emit `{type:"patch", ...}` **instead of**
   `{type:"diagram"}` only when the snapshot is patchable, else fall back to the
   full diagram event unchanged.
2. Teach the three stream consumers (search `simulate-and-variant` /
   `parseNdjsonStream` usages) to route a `patch` event through
   `applyPatchToClone`, with the full-diagram event as the untouched fallback.
3. Add a Vitest case asserting the patch branch reuses the mounted N-state clone
   and the fallback still renders on an unpatchable payload.

### References

- `expert_backend/main.py` (`/api/simulate-and-variant-diagram`)
- `expert_backend/services/diagram/action_patch.py`
- `frontend/src/utils/svgPatch.ts` (`applyPatchToClone`),
  `frontend/src/utils/ndjsonStream.ts` (the shared reader)
