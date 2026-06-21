# Rendering Optimizations for Large Grid NAD Visualization

## Overview

Co-Study4Grid renders pypowsybl Network Area Diagrams (NAD) for power grids with 11,000+ lines and 500+ voltage levels. At this scale, naive rendering causes multi-second tab switches, invisible line colors at zoom-out, and zoom lag/crashes. This document traces the critical rendering features, their rationale, and regression risks.

## Critical CSS Properties

### 1. `vector-effect: non-scaling-stroke` — Line Visibility & Zoom Performance

**Files:** `frontend/src/App.css`, `standalone_interface.html` (CSS section)

```css
.svg-container svg path,
.svg-container svg line,
.svg-container svg polyline,
.svg-container svg rect {
    vector-effect: non-scaling-stroke;
}
```

**What it does:** Keeps stroke widths at a constant screen-pixel size regardless of SVG viewBox zoom level.

**Why it's critical:**
- **Without it at full zoom-out:** Lines become sub-pixel width on large grids — native pypowsybl colors are invisible (the diagram appears as scattered dots)
- **Without it when zoomed in:** Strokes scale to hundreds of screen pixels, causing extremely expensive anti-aliased rendering → zoom lag and browser crashes
- **With it:** Strokes stay at ~1-2px screen width at any zoom level. Native pypowsybl line colors are always visible. Rendering cost is constant regardless of zoom.

**Regression history:** Removed in commit `6d03b24` ("Fix thick lines"), causing lines to lose visible colors and zoom to lag/crash. Restored in `df20d54`.

> **DO NOT REMOVE this CSS rule.** It is the single most impactful rendering property for large grids. pypowsybl SVGs include native colors on paths — this rule ensures they remain visible. If lines appear "too thick" at some zoom level, address it by adjusting individual stroke-width values, not by removing non-scaling-stroke.

### 2. `contain: layout style paint` — CSS Containment

**Files:** `frontend/src/App.css`, `standalone_interface.html`

```css
.svg-container {
    contain: layout style paint;
}
```

**What it does:** Tells the browser that layout/paint within `.svg-container` is independent of the rest of the page.

**Why it's critical:** During viewBox changes (zoom/pan) and tab switches, the browser would otherwise propagate style/layout recalculations to ancestor elements. Containment limits the scope of recalculation to the SVG subtree.

### 3. `text-hidden` Class — Text Culling on Large Grids

**Files:** `frontend/src/App.css`, `standalone_interface.html`

```css
.svg-container.text-hidden foreignObject,
.svg-container.text-hidden .nad-edge-infos,
.svg-container.text-hidden .nad-text-edges {
    display: none !important;
}
```

**What it does:** Hides thousands of text labels (foreignObject, edge info) when zoomed out on large grids. Text is too small to read at full zoom-out, and rendering it is expensive.

**When it activates:** Controlled by `usePanZoom` hook — text is hidden when the viewBox covers ≥55% of the original diagram size, shown when zoomed in to ≤45% (hysteresis prevents flicker near the boundary).

## Pan/Zoom Architecture (`usePanZoom`)

**Files:** `frontend/src/hooks/usePanZoom.ts`, `standalone_interface.html` (usePanZoom function)

### Design Principles

1. **Direct DOM manipulation during interaction** — viewBox changes go directly to the SVG element via `setAttribute`, bypassing React's render cycle entirely. React state is only updated when interaction ends (debounced).

2. **Cached SVG element reference** — `svgElRef.current` is set once when the diagram loads (`useLayoutEffect([initialViewBox])`), avoiding repeated `querySelector('svg')` calls during the hot path (wheel/drag events).

3. **Debounced React state sync** — `commitViewBox()` fires 150ms after the last wheel event, preventing React re-renders during rapid zoom.

4. **rAF-throttled drag** — Mouse move events are batched to at most one DOM update per display frame via `requestAnimationFrame`.

5. **Interaction-time paint culling** — while `.svg-interacting` is set (the gesture window), `App.css` drops the two most expensive paint element classes from the render tree: the HTML `<foreignObject>` voltage-level labels and the `.nad-edge-infos` flow values/arrows. They repaint once on settle. ~1.5–1.7x cheaper frames on the 5247-VL European grid, GPU-independent — this is the default. A CSS-transform GPU-compositing path (much smoother on GPU, but a regression under software/VDI rendering where every pan frame re-rasters new layer tiles) ships as the **off-by-default** "Smooth pan/zoom (GPU)" toggle (`utils/smoothPanZoom.ts`, read by `usePanZoom` at gesture start). Full write-up + benchmark: [`history/interaction-paint-culling.md`](history/interaction-paint-culling.md).

### Critical `useLayoutEffect` Hooks

```
┌─ useLayoutEffect([initialViewBox])
│  Cache svgElRef, apply text-hidden on large grids.
│  MUST have [initialViewBox] deps — without deps it runs every render,
│  blocking paint on every tab switch.
│
├─ useLayoutEffect([active])
│  When tab becomes active, apply current viewBox to SVG DOM BEFORE paint.
│  Prevents one frame of stale/default viewBox on tab switch.
│
└─ useLayoutEffect([activeTab]) — in App.tsx / standalone
   Tab synchronization: copies viewBox from previous tab to new tab
   before the browser paints, so the new tab shows the same zoom region.
```

> **Regression risk:** Changing any of these to `useEffect` will cause visible flicker on tab switch (one frame of wrong zoom state). Removing the `[initialViewBox]` dependency will cause all three `usePanZoom` instances to run `querySelector` on every React render, blocking paint for ~100-300ms on large grids.

## Tab-Switch Optimization

### Problem
On a France-scale grid (11,225 lines, ~500+ voltage levels), switching between N / N-1 / Action tabs was taking 1-3 seconds. The tab wouldn't appear until all decorations (highlights, voltage filter, delta visuals) finished running.

### Solution: Deferred Decorations

Highlights and voltage filters are deferred to the next animation frame on tab switch:

```
User clicks tab → React render → useLayoutEffect (viewBox sync)
→ Browser paints tab (SVG visible immediately)
→ requestAnimationFrame → apply highlights + voltage filter
```

**Implementation:**
- The highlight effect detects tab switches via `prevActiveTabRef`
- On tab switch: decorations are deferred via `requestAnimationFrame`
- On data change (same tab): decorations apply synchronously

**Stale tracking:** Inactive tabs are marked as "stale" in a `Set`. When switching to a stale tab, decorations re-apply in the deferred rAF callback.

### SVG Container Strategy

All three diagram containers (N, N-1, Action) stay mounted in the DOM with `visibility: hidden` / `z-index: -1` when inactive. This avoids destroying and recreating the SVG on every tab switch, preserving zoom state and avoiding expensive initial parse/render.

```jsx
<div style={{
    zIndex: activeTab === 'n' ? 10 : -1,
    visibility: activeTab === 'n' ? 'visible' : 'hidden',
}}>
```

## Highlight & Decoration Optimizations

### ID Map Cache (`getIdMap`)

**Files:** `frontend/src/utils/svgUtils.ts`, `standalone_interface.html`

Instead of `container.querySelector(`[id="${svgId}"]`)` (O(n) per call), a `Map<string, Element>` is built once per SVG and cached. Subsequent lookups are O(1). The cache is invalidated when the diagram changes.

### CTM Cache for Highlight Positioning

`getScreenCTM()` is cached per highlight pass instead of computed inside loops. The background layer's CTM is constant for all highlights in a single call, so caching it avoids redundant layout-forcing calls.

### Delta Visuals Guard

The `data-deltas-applied` attribute on the container tracks whether delta CSS classes have been applied. On cleanup, the expensive `querySelectorAll` scans only run when deltas were previously applied, skipping 4 full-tree scans when switching between Flows/Impacts mode and no deltas exist.

### Voltage Filter Early-Return

```javascript
if (minKv <= uniqueVoltages[0] && maxKv >= uniqueVoltages[uniqueVoltages.length - 1]) return;
```

When the voltage range slider covers all voltages (the default state), the filter skips iterating all nodes/edges — avoiding ~33,000 `style.display` writes on large grids.

## SVG Boost for Large Grids (`boostSvgForLargeGrid`)

**Files:** `frontend/src/utils/svgUtils.ts`, `standalone_interface.html`

For grids with ≥500 voltage levels and viewBox ratio > 3× the reference size (1250), text sizes, bus node radii, and edge info elements are scaled up proportionally so they're readable when zoomed in. The function:

1. Parses the SVG string with DOMParser
2. Scales font sizes, circle radii, and transform groups
3. Adds `data-large-grid` attribute (used by text-hidden CSS)
4. Serializes back to string

**Boost cache:** Results are cached in an LRU map (max 6 entries: N + N-1 + Action × 2 view modes) keyed by `length:vlCount:first200chars` to avoid redundant DOM parse/serialize on the same SVG.

## SVG DOM Recycling (`svgPatch`)

**Files:** `frontend/src/utils/svgPatch.ts`, `frontend/src/hooks/useDiagrams.ts`, `frontend/src/App.tsx`, `expert_backend/services/diagram_mixin.py`, `expert_backend/main.py`

### Problem

Before this work, switching to the N-1 tab or selecting a different action re-fetched the FULL pypowsybl NAD SVG every time. On the `bare_env_20240828T0100Z` reference grid (~10 k branches, ~12 MB SVG) this was:

- ~2–4 s of backend `get_network_area_diagram` work per click (the dominant cost),
- ~27 MB payload on the wire,
- ~250 ms of client-side `JSON.parse` + `DOMParser.parseFromString`,
- full re-layout of ~200 k DOM nodes.

The network topology is **byte-identical** across N, N-1, and most action variants when pypowsybl runs with `fixed_positions` — only a handful of elements actually change.

### Solution

Two new SVG-less endpoints ship only the per-branch delta needed to transform the N-state SVG DOM into N-1 / post-action. The frontend clones the already-mounted N-state `SVGSVGElement` and patches the clone in-place.

| Endpoint | When | Payload |
|---|---|---|
| `POST /api/contingency-diagram-patch` | N-1 tab fetch | `{disconnected_edges, absolute_flows, lines_overloaded, flow_deltas, asset_deltas, lf_*, ...}` — no SVG body |
| `POST /api/action-variant-diagram-patch` | Action click | Same shape, plus `vl_subtrees` (per-VL node subtree + affected edges) when bus counts change |

Client-side pipeline in `applyPatchToClone`:

1. **Splice per-VL subtrees** — for node-merging / splitting / coupling actions, the backend ships pypowsybl-native `<g id="nad-vl-*">` fragments (focused NAD at `depth=1`, rendered against the same `fixed_positions`). The client parses each fragment, rewrites the root `id` attribute to the main-diagram svgId (pypowsybl svgIds are positional — `nad-vl-0` in a focused sub vs. `nad-vl-42` in the main NAD), and splices via `replaceWith`. Same treatment for the affected branches' edge subtrees so their piercing geometry matches the new bus count.
2. **Mark disconnected edges dashed** — every branch whose `connected1 AND connected2` is false on the action variant gets the `.nad-disconnected` class (new CSS rule with `stroke-dasharray` + `vector-effect: non-scaling-stroke`). Covers the N-1 contingency plus any `disco_*` target; `reco_*` drops the class.
3. **Overwrite absolute flow labels** — backend ships `absolute_flows.p1/p2/q1/q2`, client rewrites each `edgeInfo1/2` text with the target-state value (backup in `data-patched-flow` distinct from the `data-original-text` owned by `applyDeltaVisuals`).

### Critical performance rule — id map

The flow-label loop touches ~2 × N edges (N ≈ 11 k on the reference grid). `clonedSvg.querySelector('[id=...]')` inside that loop is O(n_dom_nodes) per call ⇒ billions of comparisons ⇒ the browser tab locks up. Build the id map **once** with a single `querySelectorAll('[id]')`, then do O(1) `Map.get` lookups:

```ts
const idMap = buildSvgIdMap(clonedSvg);  // one O(D) scan
for (const edgeId in absolute_flows.p1) {
    const el = idMap.get(baseMetaIndex.edgesByEquipmentId.get(edgeId)?.edgeInfo1?.svgId);
    if (el) patchEdgeInfoText(el, formatFlowValue(...));
}
```

**Do not** call `querySelector` in the flow-label / edge-splice / disconnected-edges loops. Same O(E·D) browser-lock trap that earlier highlight passes had (and why `getIdMap` exists).

### Fresh viewBox identity per patch

`usePanZoom` caches the live `<svg>` element via `svgElRef` and only refreshes that ref on `useLayoutEffect([initialViewBox])`. If the patch path passes the **same** `originalViewBox` object reference across N → patched-N-1 transitions, the layout-effect never re-runs and `svgElRef` keeps pointing at the previous (now-detached) clone. Pan/zoom then writes `viewBox` on a detached element — no visible change, main thread saturates — "page not responding".

**Fix:** shallow-copy `originalViewBox` on every patch so each transition produces a fresh object reference. See `App.tsx` fetchN1 and `useDiagrams.ts` handleActionSelect.

### Blank-flash elimination + stale-response guard

Two large-grid-only hazards:

- **Blank flash.** Calling `setActionDiagram(null)` synchronously on action click, followed by `await api.getActionVariantDiagramPatch(...)`, broke React's automatic batching. The null commit fired on its own → `innerHTML = ''` → container blank for the ~200–500 ms the patch needed. **Fix:** keep the previous cloned DOM mounted through the patch window; only null the diagram on explicit deselect (`actionId === null`).
- **Stale patch response.** Rapid A → B clicks with A's patch still in flight used to let A's late response `setActionDiagram(A)` after B's had already rendered, reverting the user's selection. **Fix:** `latestActionSelectRef` tracks the latest click; every await rechecks it on resume and drops a mismatch silently. Same guard around the full-NAD fallback.

### Fallback matrix

| Situation | Path |
|---|---|
| Normal N-1 selection with N diagram loaded | **patch** (`/api/contingency-diagram-patch`) |
| N-1 selection during session reload | full (`/api/contingency-diagram`) — preserves save/load contract |
| N-1 selection before N SVG is mounted | full fallback |
| PST / redispatch / load-shedding / curtailment | **patch** |
| Line disconnect / reconnect (`disco_*` / `reco_*`) | **patch** (toggles the `nad-disconnected` class) |
| Node merging / splitting / coupling | **patch with VL-subtree splice** (pypowsybl-native focused NAD per affected VL) |
| VL-subtree extraction partial / raises | full fallback (`patchable: false, reason: "vl_topology_changed"`) |
| Patch endpoint throws | full fallback |

### Combined-action line targets

`getActionTargetLines` used to evaluate `isCouplingAction` on the **full** combined action ID/description. For `disco_X+coupling_Y` the presence of "coupling" in the string suppressed every line-target extraction — the disco line lost its pink halo AND its clickable action-card badge. Fixed by splitting on `+` and evaluating the coupling flag **per sub-part**; topology-based bus/line extraction also limited to non-combined actions (combined topologies merge bus changes from multiple sub-actions and can't be cleanly attributed).

### Measured savings

On `bare_env_20240828T0100Z`, contingency `ARGIAL71CANTE`, warm-median of 3:

| Endpoint | Cold | Warm | Payload |
|---|---|---|---|
| `/api/contingency-diagram` (full)         | 3.01 s | 2.39 s | 27.1 MB |
| `/api/contingency-diagram-patch` (new)    | 0.49 s | 0.50 s |  5.5 MB |
| **Δ** | **−83.8 %** | **−79.1 %** | **20.3 % of full** |

Raw numbers in `profiling_patch_results.json`, benchmark driver in `benchmarks/bench_n1_diagram_patch.py`. Historical detail in `docs/performance/history/svg-dom-recycling.md`.

## Regression Test Coverage

**File:** `frontend/src/utils/cssRegression.test.ts`

Automated tests verify that critical CSS rules are present in both `App.css` and `standalone_interface.html`:

| Test Category | What It Verifies |
|---|---|
| `non-scaling-stroke` | CSS rule present for path/line/polyline/rect |
| CSS containment | `contain: layout style paint` on `.svg-container` |
| `text-hidden` | `display: none` for foreignObject when class active |
| Highlight styles | `.nad-overloaded` (orange), `.nad-action-target` (yellow) |
| Delta visualization | Positive (orange) and negative (blue) delta styles |
| `usePanZoom` guards | `useLayoutEffect` deps correct, tab sync uses `useLayoutEffect` |
| Voltage filter | Early-return when range covers all voltages |
| Deferred highlights | `requestAnimationFrame` used on tab switch |
| Boost cache | `_boostCache` and `BOOST_CACHE_MAX` present |

**File:** `frontend/src/hooks/usePanZoom.test.tsx`

Tests verify:
- ViewBox sync on mount, activation, and diagram changes
- ViewBox preservation across active/inactive transitions
- Text visibility toggle on large grids (hidden at zoom-out, visible at zoom-in)
- No corruption after rapid tab switching

## Summary: Do's and Don'ts

| Do | Don't |
|---|---|
| Use `vector-effect: non-scaling-stroke` on SVG elements | Remove it to fix "thick lines" — adjust stroke-width instead |
| Use `useLayoutEffect` for viewBox sync | Change to `useEffect` — causes visible flicker |
| Defer decorations via `requestAnimationFrame` on tab switch | Apply highlights synchronously on tab switch |
| Cache `getScreenCTM()` and ID maps | Call `querySelector` or `getScreenCTM()` in loops |
| Keep all SVG containers mounted (visibility toggle) | Conditionally render/destroy SVG containers on tab switch |
| Short-circuit voltage filter when range covers all | Iterate all elements even when no filtering needed |
| Run `cssRegression.test.ts` after CSS changes | Skip tests after modifying App.css or standalone CSS |
| Build an id map once per `applyPatchToClone` call | Call `querySelector('[id=...]')` inside flow-label / edge-splice loops |
| Shallow-copy `originalViewBox` on every patch so `usePanZoom` refreshes its cached `svgElRef` | Share the same viewBox object reference across N → patched-N-1 swaps |
| Rewrite spliced `<g id="nad-vl-*">` root ids to the main-diagram svgId | Trust the focused sub-diagram's positional svgIds as-is |
| Keep the previous cloned DOM mounted through the patch-fetch window | `setActionDiagram(null)` synchronously on click before an `await` |
| Drop late patch responses via `latestActionSelectRef` | Let a stale response overwrite the current action selection |
| Evaluate `isCouplingAction` per `+`-split part on combined actions | Evaluate it on the full combined action ID (suppresses line-target extraction) |
