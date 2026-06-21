# Pan/zoom fluidity — empirical evaluation of the "Smooth pan/zoom (GPU)" toggle

Grid: **pypsa_eur_eur220_225_380_400** (5247 VL / 8205 branches; real pypowsybl NAD
9.1 MB, ~99k–104k DOM nodes). Hardware: **Apple M4 Pro (Metal), Chrome 149, 120 Hz, dpr=1**.
Metric: **median rAF frame interval during a sustained 2.5 s gesture** (lower = smoother;
8.3 ms = 120 fps = idle ceiling). 100% "dropped" = never reaches the 120 Hz budget.

Harness: `bench_fluidity.html` driven over CDP (`cdp_driver.mjs`) in a Chrome launched
with anti-throttle flags so an occluded window still renders at full speed. The real-app
end-to-end numbers come from driving the actual `usePanZoom` handlers + the real Settings
toggle (`app_toggle_driver.mjs`, `app_n1_driver.mjs`).

## Results

| Measurement | gesture | plain (no cull) | **cull = toggle OFF** | **gpu transform = toggle ON** | toggle gain |
|---|---|---|---|---|---|
| Synthetic NAD (isolated) | pan | 91.7 | 58.3 | 49.8 | 1.17× |
| Synthetic NAD (isolated) | zoom | 108.6 | 65.0 | 49.6 | 1.31× |
| **Real pypowsybl NAD (isolated)** | pan | 100.0 | 58.0 | 41.9 | 1.38× |
| **Real pypowsybl NAD (isolated)** | zoom | 126.7 (p95 1008!) | 65.1 | 43.3 | 1.50× |
| **Real app, N tab (live usePanZoom)** | pan | — | 60.1 | 50.0 | 1.20× |
| **Real app, N tab (live usePanZoom)** | zoom | — | 75.0 | 50.1 | 1.50× |
| **Real app, N-1/Contingency tab** | pan | — | 82.6 | 58.4 | 1.41× |
| **Real app, N-1/Contingency tab** | zoom | — | 83.9 | 66.7 | 1.26× |

(N-1/action share the identical render path — `MemoizedSvgContainer` + `usePanZoom` +
`.svg-interacting`; the action tab differs only by a few highlight elements, so its
fluidity equals N/N-1.)

### Verdict on the toggle
- The toggle delivers a **real but modest ~1.2–1.5×** over the default. All four arms still
  drop **100% of frames** — even ON, pan/zoom sit at **~15–24 fps**, never near 60/120.
- **Why it's small (proven):** a pure ±2 px CSS translate of the `will-change`'d `<svg>` layer
  is *still* ~42–48 ms/frame (`micro_translate`). Chrome **re-rasterizes the ~100k-node vector
  SVG on every transform** → `will-change:transform` never yields a reusable GPU texture, so
  the gesture only saves the viewBox-attribute recompute + non-scaling-stroke re-eval.

## What WOULD make it fluid (proven)
**Rasterize the NAD to a `<canvas>` once at gesture start, transform the bitmap per frame,
bake back to viewBox on settle:** **8.3 ms = 120 fps, 0 dropped frames** — on both the
synthetic and the real NAD. That is **~6× over the toggle** and **~7–8× over the default**,
and it composites cheaply even on software/VDI (the case the GPU toggle deliberately skips).

### The catch (verified in code, Phase C)
The bitmap is rasterized via `new Image()`, which renders the SVG in isolation → **App.css
class-based styling is dropped**. On the **N-1 / action** tabs that means overload halos,
the contingency glow, and flow-delta colors **vanish** (they come from
`.nad-overloaded`/`.nad-contingency-highlight`/`.nad-action-target`/`.nad-delta-*` rules,
not inline attributes — `highlights.ts`). The N tab is bare, which is exactly why the
8.3 ms held there. → A production bitmap mode must **inline the highlight/delta computed
styles into the clone** before serializing, and fix cursor-anchored wheel-zoom (the
`getScreenCTM()` source moves from the live SVG to the canvas).

## Recommendations (ranked)
1. **(big bet) Bitmap-snapshot mode** as a 3rd `usePanZoom` mode (`'off' | 'gpu' | 'bitmap'`),
   opt-in/default-OFF. Prereqs: inline halo/delta styles into the clone (fixes N-1/action
   fidelity), strip `<foreignObject>` (canvas taint — bench already does), dpr-scale the
   canvas, fix wheel-zoom CTM. Effort L–XL. Reference impl: `bench_fluidity.html`
   `snapshotCanvas`/`runBitmap`.
2. **(quick win — REJECTED after measurement) Drop `vector-effect:non-scaling-stroke` during
   `.svg-interacting`.** Phase C measured ~1.15× on the *synthetic* NAD, but a direct A/B on the
   **real** pypowsybl NAD (`__runNss` arm, vector-effect verified flipping `none`↔`non-scaling-stroke`)
   gave **1.00× — zero gain — on both GPU and software rendering** (`--disable-gpu`): pan 50/50 ms,
   zoom 58.3/58.3 ms. The real bottleneck is pure SVG raster; the stroke recompute is negligible.
   **Not shipped** — ~60 lines of CSS + a halo/delta protection block for a measured no-op. The
   synthetic 1.15× did not transfer. [IMPLEMENTED then reverted.]
3. **(SHIPPED) `commitViewBox` equality guard** (`usePanZoom.ts`) — free, avoids a settle-frame
   React re-render when the viewBox nets back unchanged (the ~100k nodes are outside React's vdom
   via `React.memo`+`replaceChildren`, so it's a tiny App-level saving, not a fps mover).
4. **(SHIPPED, hygiene) Clear `will-change` promptly** on settle in `endInteraction`
   (smooth-mode only); does NOT shorten the 150 ms wheel debounce. Drops a promoted multi-MB
   compositor layer between gestures. 0 fps, pure hygiene.
5. **Reject:** geometry-count culling (≤1.15×, some regress; `content-visibility:auto` is
   0.89×; `.nad-edge` selectors don't even match the real grid) and a full canvas/WebGL
   rewrite (same 8.3 ms ceiling at XL effort + breaks svgPatch/inspect/SLD/highlights).
