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
