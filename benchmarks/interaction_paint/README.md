# Interaction paint benchmark (pan/zoom fluidity)

A browser-driven micro-benchmark for the **frontend** pan/zoom paint cost
on a large Network Area Diagram. Unlike the Python benchmarks in the parent
directory (which measure the backend critical path), this one measures what
the browser actually repaints per frame while the operator pans/zooms.

It needs **no pypowsybl backend**: `generate_nad.mjs` synthesises a
structurally-faithful NAD straight from a grid's real `grid_layout.json`
(voltage-level coordinates), reproducing the paint workload — polyline
strokes, bus circles, edge-info flow `<text>` + arrows, and the expensive
HTML `<foreignObject>` voltage-level labels — at the true scale of the grid.

## What it shows

The cost (per painted frame) of a viewBox pan/zoom **with vs without** the
interaction-time culling rule (`.svg-interacting` in
`frontend/src/App.css`). See
[`docs/performance/history/interaction-paint-culling.md`](../../docs/performance/history/interaction-paint-culling.md)
for the analysis and headline numbers.

## Requirements

- Node ≥ 18.
- A local Playwright install reachable from `frontend/`
  (`cd frontend && npm i -D playwright`).
- A Chromium/Chrome binary. The benchmark defaults to the Playwright build
  at `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`; override with
  `PW_CHROME=/path/to/chrome`.

> Not wired into CI: the Playwright browser-download host is outside the
> CI network egress allowlist, so the browser must already be present.

## Run

```bash
cd benchmarks/interaction_paint

# 1. Build the synthetic NAD from a committed grid layout
#    (default grid: pypsa_eur_eur220_225_380_400 — 5247 voltage levels)
node generate_nad.mjs
#    or pick another grid that has data/<grid>/grid_layout.json:
# node generate_nad.mjs pypsa_eur_fr225_400

# 2. Benchmark plain vs culled pan/zoom (interleaved, 6 reps)
PW_CHROME=/path/to/chrome node bench_pan_zoom.mjs
```

Output (example, headless software-GL — relative numbers, not absolute fps):

```
pan      plain  mean 290.1ms  median 297.6ms  p95 407.3ms
pan      cull   mean 188.2ms  median 183.8ms  p95 244ms
         => culling speedup: mean 1.5x   median 1.6x
```

## Caveats

- **Headless = software rendering** (SwiftShader, no GPU). Absolute frame
  times are far higher than on a real GPU desktop; only the *relative*
  plain-vs-cull comparison is meaningful here. On GPU the culling win is
  expected to be larger (the CPU-side `<foreignObject>` raster dominates
  the residual cost relatively more).
- Always interleave A/B (this script does): back-to-back passes over the
  same viewBoxes reuse warm raster tiles and overstate the speedup.
