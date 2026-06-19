# Interaction-time paint culling for large-grid pan/zoom

**Status:** shipped (frontend, CSS-only). **Grid:** `pypsa_eur_eur220_225_380_400`
(5247 voltage levels, 8205 branches, ~7.3 MB NAD, ~100k DOM nodes).

## Problem

Pan/zoom on the N / N-1 / Action network diagrams feels sluggish on the
large European grid. `usePanZoom` already bypasses React during a gesture
(viewBox is written straight to the DOM via `setAttribute`, batched
through `requestAnimationFrame`, with pointer-events disabled and a
zoom-tier LOD that hides labels at full zoom-out). Despite that, every
viewBox change still forces the browser to **repaint the whole visible
vector tree**, and on a grid this size that is hundreds of milliseconds
per frame — well short of a smooth 60 fps.

## Two candidate approaches

### A. CSS-transform GPU compositing (investigated, NOT shipped)

The textbook fix for "smooth pan/zoom of a huge SVG" is to stop rewriting
`viewBox` during the gesture and instead apply a compositor-only CSS
`transform` (`translate`/`scale`) to the `<svg>` element, baking the
transform back into the viewBox only on settle. With a GPU the browser
rasterises the layer once and then just moves/scales it — near-free.

We implemented the exact `xMidYMid meet` ↔ transform math and benchmarked
it. **In a GPU-less environment it is a severe regression**, because every
pan frame scrolls new content into view that must be re-rasterised, and
software rasterisation of a 7 MB layer is catastrophic:

| gesture | viewBox repaint | CSS-transform | ratio |
|---|---|---|---|
| pan     | 296 ms/frame | **3215 ms/frame** | **0.09x** |
| zoom-in | 388 ms/frame | 395 ms (median 219) | ~1x, with multi-second re-raster spikes |

This matters for Co-Study4Grid's audience: control-room / TSO operators
frequently run inside **VDI, remote-desktop or GPU-blocklisted corporate
browsers**, where compositing falls back to software and this approach
would make the tool far worse, not better. It was therefore rejected as
the default. It remains a viable **opt-in** for GPU-accelerated desktops
— see "GPU follow-up" below — but needs validation on real hardware,
which the headless CI/benchmark environment cannot provide.

### B. Interaction-time paint culling (shipped)

Instead of changing *how* a frame is presented, shrink *what* each frame
has to paint. On this NAD the per-frame cost is dominated by two element
classes:

1. **HTML voltage-level labels** — `<foreignObject>`, by a wide margin the
   most expensive SVG paint primitive (it is a CPU-rasterised HTML subtree).
2. **Edge-info flow values + direction arrows** (`.nad-edge-infos`).

Both are unreadable mid-gesture anyway. So while a gesture is active we
drop them from the render tree. `usePanZoom` already toggles the
`.svg-interacting` class on the container at gesture start/settle (it was
added for the pointer-events optimisation), so this is **pure CSS** — no
hook logic change:

```css
.svg-container.svg-interacting .nad-edge-infos,
.svg-container.svg-interacting .nad-text-nodes,
.svg-container.svg-interacting foreignObject.nad-text-nodes,
.svg-container.svg-interacting .nad-vl-nodes foreignObject,
.svg-container.svg-interacting .nad-label-nodes foreignObject,
.svg-container.svg-interacting .nad-label-nodes,
.svg-container.svg-interacting .nad-label-box,
.svg-container.svg-interacting .nad-text-edges {
    display: none !important;
}
```

On settle the class is removed and the labels repaint once at the resting
viewBox. This is the standard "declutter while panning" pattern (maps do
it) and applies automatically to all four pan/zoom surfaces (N, N-1,
Action, and the Action-overview map) because they share `usePanZoom` and
the `.svg-container` class. The overview's action pins are `<text>`/
`<path>`, not labels, so they stay visible during the gesture.

It is **GPU-independent**: it reduces the work of the plain viewBox repaint
path itself, so it holds up in exactly the software-rendered sessions where
approach A fails.

## Results

Measured with an interleaved A/B headless benchmark (real Chromium,
software GL, `--run-all-compositor-stages-before-draw`; metric =
time-to-painted-frame via double-`requestAnimationFrame`; plain and culled
runs alternated across 6 reps to cancel raster-cache ordering effects):

| gesture | plain (mean/median) | culled (mean/median) | speedup |
|---|---|---|---|
| pan     | 290 / 298 ms | 188 / 184 ms | **~1.5x** |
| zoom-in | 378 / 383 ms | 226 / 228 ms | **~1.7x** |

A modest but consistent and zero-risk win. The relative gain is expected
to be **larger on GPU hardware**, where polyline rasterisation is offloaded
to the GPU and the CPU-side `<foreignObject>` raster dominates the residual
cost relatively more.

### Measurement caveat (caching artifact)

An earlier, non-interleaved version of the benchmark reported ~19x (pan)
and ~6x (zoom). That was an **artifact**: measuring the culled pass
immediately after the un-culled pass over the *same* viewBoxes let it reuse
warm raster tiles, collapsing the culled frame time to ~16 ms. Interleaving
the two passes removed the bias and gave the honest ~1.5–1.7x above. Lesson:
always interleave A/B browser-paint measurements — raster caches make
back-to-back passes unfair.

A third lever — `shape-rendering/text-rendering: optimizeSpeed` during the
gesture (disable anti-aliasing on the residual vector raster) — was tested
and gave no improvement (0.95–0.98x), so it was not adopted.

## Implementation

- `frontend/src/App.css` — the `.svg-interacting` culling block (only change
  to the product).
- `frontend/src/uxConsistency.test.tsx` — regression guard that the rule
  stays in `App.css`.
- No change to `usePanZoom.ts`: the `.svg-interacting` class lifecycle (set
  on wheel/mousedown, cleared on the 150 ms wheel-settle / mouseup) already
  brackets exactly the gesture window.

## Reproduce

`benchmarks/interaction_paint/` builds a structurally-faithful NAD from the
real `grid_layout.json` (no pypowsybl backend needed) and drives a headless
Chromium:

```bash
cd benchmarks/interaction_paint
node generate_nad.mjs                 # -> nad.svg (+ nad.stats.json) from data/<grid>
PW_CHROME=/path/to/chrome node bench_pan_zoom.mjs
```

Requires a local Playwright + Chromium (not wired into CI — the browser
download host is outside the CI egress allowlist). See its README.

## GPU follow-up (deferred)

Approach A (transform compositing) is the only path to genuinely smooth
(~60 fps) pan/zoom on this grid size, but only with GPU compositing. A safe
way to offer it: an **off-by-default** "Smooth pan/zoom (GPU)" setting that
swaps the per-frame `applyViewBox` for the transform path, leaving the
culling default untouched for software/VDI sessions. It needs tuning and
validation on real GPU hardware (raster-scale / `will-change` management,
re-raster hitch during zoom bursts), which the headless benchmark
environment cannot do — hence deferred rather than shipped.
