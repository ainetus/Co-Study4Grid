# Large-Grid NAD Rendering: LoD Strategies (History + Current Plan)

Consolidated record of the Network Area Diagram (NAD) rendering
investigations for large grids (France 10k+ branches, ~13 MB SVG).
Supersedes three prior docs:

- `nad_optimization.md` — original strategy comparison (discarded)
- `network_rendering_profiling_recommendations.md` — Phase 3 revised proposal
- `spatial_lod_architecture_proposal.md` — critique + architecture revision

Status (2026-04-20): **no automatic LoD swap is implemented**. The
shipped wins instead came from payload compression, DOM culling via
CSS, and eliminating redundant SVG parses. Layer-A "CSS zoom tiers"
and "Focus Mode" enhancements remain proposed.

---

## Problem

Full-grid NAD for France is ~13 MB of SVG with ~100k DOM nodes. This
hurts three things:

1. **Transport** — 13 MB over the wire per diagram fetch.
2. **DOM rendering** — React reconciliation + browser paint on 100k
   nodes freezes the main thread for 1.8–2.2 s.
3. **Pan/zoom interactivity** — every frame repaints the whole tree.

## Strategies Investigated

| # | Strategy | Verdict | Notes |
|---|----------|---------|-------|
| 1 | Voltage-bound filtering (drop < 63 kV / < 90 kV) | ❌ Discarded | Only ~11 % payload cut; risk of hiding weak critical elements. |
| 2 | Backend BBox-scoped NAD regeneration on zoom ("Strategy 3") | ❌ Reverted | 13 MB → 240 KB (50×) but: highlight inconsistency, layout jumps between macro/micro, multi-tab sync debt. |
| 3 | Tiled Canvas/WebGL client renderer | 💡 Deferred | ~98 % payload cut, preserves highlighting, but no pypowsybl canvas renderer exists — major effort. |
| 4 | Dual-SVG macro/micro DOM swap with `react-zoom-pan-pinch` | ❌ Rejected at design | Doubles DOM during transition; also assumed wrong zoom library (app uses custom `usePanZoom` viewBox hook). |
| 5 | GZip on diagram endpoints | ✅ Shipped | See `docs/performance/history/per-endpoint-gzip.md`. 28 MB → ~2.5 MB per endpoint. |
| 6 | `display:none` on inactive SVG tabs | ✅ Shipped | See `docs/performance/history/svg-tab-unmount.md`. 600k → 200k live DOM nodes. |
| 7 | Eliminate double-parse in `boostSvgForLargeGrid` | ✅ Shipped (part of perf PR) | Return DOM node instead of re-serializing → ~1.3–1.6 s saved. |
| 8 | CSS zoom tiers (`data-zoom-tier` driven visibility) — Layer A below | 🟡 Proposed | Zero-latency, works with existing `usePanZoom`. |
| 9 | User-triggered Focus Mode on `/api/focused-diagram` — Layer B below | 🟡 Proposed | Endpoint already exists at `main.py`; only UX missing. |
| 10 | Viewport DOM culling hook (`useViewportCuller`) | 🟡 Proposed | Mirrors existing voltage-filter pattern in `useDiagrams.ts`. |

---

## Why Backend BBox-Scoped LoD Keeps Getting Rejected

The original spatial-LoD proposal was critiqued and rejected for
reasons specific to this codebase:

1. **Wrong zoom library assumption.** The app does **not** use
   `react-zoom-pan-pinch` for NAD. It uses a custom
   `frontend/src/hooks/usePanZoom.ts` that writes the SVG `viewBox`
   attribute directly via refs, bypassing React. Coordinate space is
   SVG viewBox, not CSS transform.
2. **Three independent variant states** (N, N-1, Action) each hold
   their own SVG + flow deltas + overload lists. A BBox request would
   need to regenerate all three or accept tab-to-tab mismatch.
3. **Coordinate instability** — `get_network_area_diagram(VL-subset)`
   produces a completely different layout than the full-grid
   diagram. Seamless macro↔micro DOM swap is impossible without
   visible jumping.
4. **Highlight metadata is simulation-derived**, not SVG-derived.
   Overload / contingency / action-target highlights come from
   network simulation output. Mapping them across partial/full views
   was the root cause of the Strategy-2 revert.
5. **SVG post-processing pipeline would need to re-run** on every
   swap (see `utils/svgUtils.ts`):
   `boostSvgForLargeGrid`, `buildMetadataIndex`, `getIdMap`,
   `applyOverloadedHighlights`, `applyActionTargetHighlights`,
   `applyDeltaVisuals`, `applyContingencyHighlights`.
   On 500+ VL grids this pipeline is measurable (there is a 5 s
   timeout guard).
6. **Dual-SVG DOM during transition doubles** the very node count
   the optimization exists to reduce.
7. **`depth=0` produces disconnected islands** (VLs only, no
   connecting edges) — unusable for operators needing flow context.
8. **`grid_layout.json` is optional.** `_load_layout()` returns
   `None` when absent; many datasets ship without a precomputed
   layout.
9. **SLD overlay sits on top of the NAD** — swapping the NAD
   invalidates the overlay's coordinate frame.
10. **N-1 variant isn't "milliseconds"** — the N-1 path runs a full
    AC load-flow with DC fallback (see `recommender_service.py`).

---

## Current Recommended Plan (Not Yet Implemented)

Two complementary layers that work **with** the existing pipelines,
not against them.

### Layer A — Client-Side CSS Visibility Tiers (0.5–1 day)

Add a `data-zoom-tier` attribute on the SVG container, set from
inside `usePanZoom` based on the viewBox-to-original ratio. CSS
rules show/hide element classes per tier.

```ts
// usePanZoom.ts, after each applyViewBox()
const ratio = currentVb.w / originalVb.w;
const tier = ratio > 0.5 ? 'overview' : ratio > 0.15 ? 'region' : 'detail';
container.setAttribute('data-zoom-tier', tier);
```

```css
[data-zoom-tier="overview"] .nad-edge-infos,
[data-zoom-tier="overview"] .nad-label-nodes foreignObject,
[data-zoom-tier="overview"] .nad-text-edges { display: none; }

[data-zoom-tier="region"] .nad-label-nodes foreignObject { display: none; }
```

| Tier | viewBox ratio | Shows |
|------|---------------|-------|
| `overview` | `> 0.5` | Nodes + edges + legend only |
| `region` | `0.15 … 0.5` | Above + edge-info text, bus labels |
| `detail` | `≤ 0.15` | Everything |

**Why this fits the codebase**

- Single DOM attribute write; no React re-render.
- `display:none` elements drop from the paint tree; DOM tree is
  untouched, so highlight/metadata/id maps stay valid.
- Works identically for N / N-1 / Action variants.
- Degrades gracefully without `grid_layout.json`.

### Layer B — Explicit "Focus Mode" on `/api/focused-diagram`

The backend endpoint already exists (see the API table in the root
`CLAUDE.md`). It resolves an element ID to VL IDs and generates a
sub-diagram with configurable `depth`. Frontend work needed:

- `useDiagrams` state: `focusedDiagram`, `enterFocusMode(elementId)`,
  `exitFocusMode()`.
- Toolbar button or right-click context menu in
  `components/VisualizationPanel.tsx`.
- Optional: BBox→VL-ID resolver on the backend for region-focus
  (not element-focus):

  ```python
  # recommender_service.py
  def get_vl_ids_in_bbox(self, x_min, x_max, y_min, y_max):
      df = self._load_layout()
      if df is None:
          return None
      visible = df[
          (df['x'] >= x_min) & (df['x'] <= x_max) &
          (df['y'] >= y_min) & (df['y'] <= y_max)
      ]
      return visible.index.tolist() if len(visible) > 0 else None
  ```
- Client cache keyed by `(variant, sorted VL IDs)` for back-nav.

**Key difference from the rejected BBox auto-fetch**: user triggers
it, so no coordinate sync is required mid-pan; the focused diagram
opens as a separate tab rather than replacing the main NAD.

### Layer C — Optional `useViewportCuller` (3–5 days)

Only if Layer A is insufficient. Adapts the existing voltage-filter
pattern in `useDiagrams.ts` (`applyVoltageFilter` iterates
`nodesByEquipmentId` / `edgesByEquipmentId` and toggles
`el.style.display`) to viewport culling keyed off `viewBox`. Debounce
~200 ms and only enable above a zoom threshold.

---

## Shipped Wins (Baseline Before Any LoD)

| Change | File | Saved |
|--------|------|-------|
| Per-endpoint gzip | `expert_backend/main.py` | 13 MB → ~1.3 MB wire |
| `display:none` inactive tabs | `frontend/src/components/MemoizedSvgContainer.tsx` | 600k → 200k live DOM nodes |
| Eliminate SVG double-parse in `boostSvgForLargeGrid` | `frontend/src/utils/svgUtils.ts` | ~1.3–1.6 s main thread |
| N-1 flow/delta vectorization | `expert_backend/services/diagram_mixin.py` | 13× (flow) / 47× (delta) / 1.1k× (care mask) |

See `docs/performance/history/` for the per-change writeups.

## Profiling Baseline (Before Shipped Wins)

| Step | Time |
|------|------|
| `POST /api/config` (cold) | ~9.0 s |
| `GET /api/network-diagram` (base NAD) | ~5.4 s |
| `POST /api/contingency-diagram` | ~5.1 s |
| `boostSvgForLargeGrid` (6835 VLs) | ~389–464 ms |
| DOM injection (base) | ~118 ms |
| DOM injection (N-1) | ~369 ms |
| Main-thread freeze on SVG swap | 1.8–2.2 s |

---

## References

- `docs/performance/rendering-optimization-plan.md` — shipped CSS /
  vector-effect tricks, regression guards.
- `docs/performance/performance-profiling.md` — full profiling
  benchmark table.
- `docs/performance/history/` — per-change PR writeups.
- `frontend/src/hooks/usePanZoom.ts`,
  `frontend/src/hooks/useDiagrams.ts`,
  `frontend/src/utils/svgUtils.ts` — extension points for Layers A/B/C.
- `expert_backend/main.py` — `/api/focused-diagram`,
  `/api/action-variant-focused-diagram` endpoints.
