# Canvas gesture proxy — fluid pan / zoom on large grids

**Status:** the default pan/zoom mode since 2026-11-15 (`'canvas'`, Settings →
Configurations → *Pan/zoom rendering* → "Canvas proxy (default)").
**Code:** [`utils/svg/canvasProxy.ts`](../../frontend/src/utils/svg/canvasProxy.ts)
(the proxy and its controller), [`hooks/usePanZoom.ts`](../../frontend/src/hooks/usePanZoom.ts)
(gesture wiring), [`utils/smoothPanZoom.ts`](../../frontend/src/utils/smoothPanZoom.ts)
(the mode), [`utils/svg/vlInteractions.ts`](../../frontend/src/utils/svg/vlInteractions.ts)
(proxy-aware hover / click).
**Background:** [the November 2026 interaction audit](large-grid-interaction-audit-2026-11.md)
— why the classic path is slow (§2–3), the prototype (§4.2), the production
follow-up (§8). **Harness:** [`benchmarks/interaction_paint/AUDIT_HARNESS.md`](../../benchmarks/interaction_paint/AUDIT_HARNESS.md).

This is the reference for the mechanism: what it does, what it costs, the
rules it follows and the measurements behind each, its limits, and how to
measure it again. Every number comes from the full European grid
(`pypsa_eur_eur220_225_380_400`: 5,247 voltage levels, 7,853 branches; NAD
9.9 MB, 98,960 DOM nodes) on an i7-13700H laptop with an Intel Iris Xe iGPU,
Chrome headless driven with real input events, 1920×1080 viewport, diagram
panel 1439×886 CSS px, dpr 1.

---

## 1. What the operator gets

- During a wheel zoom or a drag on the N, N-1 and Action tabs (and their
  detached windows), a light canvas copy of the network replaces the live
  SVG: lines, buses, transformer windings and the overload / action /
  contingency halos, in their computed colours. Flow values and arrows, VL
  labels and legends are not drawn.
- The live diagram catches up **once, 400 ms after the last wheel notch or
  mouse release**; flow values and labels reappear then. A drag or a wheel
  notch inside those 400 ms continues on the proxy.
- A plain click (VL select, double-click → SLD) never shows the proxy.
  While the proxy covers the map, hover tooltips and clicks are ignored: the
  live SVG underneath is still at the gesture's start view, so it would
  resolve the wrong voltage level.
- Programmatic jumps — Inspect, Unzoom, zoom buttons, tab sync, tied tabs —
  are applied to the live SVG directly, as before.
- The Action overview keeps the classic path: its pins and dimming are what
  that view is for, and the proxy does not draw them.
- Settings offer *Canvas proxy* (default), *Classic* (per-frame repaint +
  culling), *GPU transform* and *Bitmap snapshot*. The choice is stored per
  browser origin (`localStorage['cs4g-smooth-pan-zoom']`); an explicit choice,
  including *Classic*, survives the default change.

## 2. Results

Median of 2 repetitions; cells are **first feedback · fps · done** (done =
share of the requested gesture the view ended up showing), jumps are
input → painted. *SW* = software raster (`--disable-gpu`, the VDI /
remote-desktop stand-in). "Default" is the `'off'` (*Classic*) mode; on this
branch it carries the gesture fixes (audit B1–B3, B5). The *main* columns are
the audit's §2 baseline runs (the audited tree, whose pan / zoom code is
`main`'s); wheel "done" targets the symmetric 1.1-per-notch zoom (the *main*
columns used 0.9, the old zoom-in step). Raw files in
`benchmarks/interaction_paint/audit_results/`: `final_gpu_off.json`,
`final2_gpu_canvas.json`, `final2_sw_canvas.json`.

| Scenario | main · default | this PR · default | this PR · canvas | main · default (SW) | this PR · canvas (SW) |
|---|---|---|---|---|---|
| Zoom-in burst (16 notches) | 430 ms · 4.5 fps · 0.53 | 464 ms · 4.2 fps · 0.99 | 52 ms · 42.0 fps · 1.00 | 458 ms · 5.3 fps · 0.56 | 46 ms · 54.8 fps · 1.00 |
| Zoom-out burst (20 notches) | 484 ms · 5.0 fps · 0.55 | 556 ms · 4.4 fps · 1.00 | 56 ms · 53.1 fps · 1.00 | 440 ms · 6.8 fps · 0.55 | 58 ms · 55.8 fps · 1.00 |
| Smooth zoom-in (trackpad-like) | 424 ms · 4.6 fps · 0.54 | 572 ms · 4.3 fps · 0.99 | 43 ms · 41.8 fps · 1.00 | 444 ms · 4.3 fps · 0.54 | 44 ms · 57.8 fps · 1.00 |
| Notch-by-notch zoom (300 ms apart) | 396 ms · 3.4 fps · 1.00 | 452 ms · 3.7 fps · 0.99 | 44 ms · 56.5 fps · 1.00 | 419 ms · 4.4 fps · 0.92 | 62 ms · 56.5 fps · 1.00 |
| Pan at full extent | 389 ms · 3.9 fps · 0.69 | 414 ms · 5.4 fps · 1.00 | 24 ms · 60.0 fps · 1.00 | 394 ms · 3.8 fps · 0.70 | 43 ms · 60.0 fps · 1.00 |
| Pan at region zoom (~35 %) | 531 ms · 2.5 fps · 0.69 | 734 ms · 3.8 fps · 1.00 | 93 ms · 30.2 fps · 1.00 | 516 ms · 2.5 fps · 0.69 | 123 ms · 40.3 fps · 1.00 |
| Pan at detail zoom (~12 %) | 555 ms · 2.4 fps · 0.73 | 524 ms · 5.0 fps · 1.00 | 106 ms · 51.4 fps · 1.00 | 596 ms · 2.1 fps · 0.74 | 124 ms · 53.3 fps · 1.00 |
| Navigate across Europe (4 drags) | 556 ms · 0.9 fps · 0.47 | 505 ms · 2.2 fps · 1.00 | 97 ms · 49.2 fps · 1.00 | 566 ms · 0.9 fps · 0.38 | 101 ms · 49.6 fps · 1.00 |
| Unzoom button | 336 ms | 392 ms | 374 ms | 345 ms | 416 ms |
| Inspect → zoom to element | 376 ms | 472 ms | 547 ms | 438 ms | 524 ms |

- **Every gesture is fluid, with or without a GPU**: zooms at 42–57 fps
  (55–58 in software raster), pans at full extent at 60 fps, a multi-drag
  navigation at ~49 fps, and region-zoom pans — the heaviest frames, with the
  most paths in view — at 30 fps on the Iris Xe and 40 in software.
- **Every gesture lands where the hand stops** (done 1.00; the classic path
  reached 0.47–0.74 on bursts and pans before the gesture fixes).
- **First feedback**: 24–62 ms for zooms and full-extent pans. Drags at region
  / detail zoom take ~95–125 ms to their first *moved* frame: the press and the
  first move hit-test the live SVG before the pointer capture applies (§7.1).
- **Jumps are unchanged.** Their columns above track machine load, which
  drifted between the baseline and these runs; measured back to back under the
  same conditions (median of 3, `audit_results/jumps_*.json`), Unzoom /
  Inspect take 316 / 496 ms on `main`, 342 / 468 ms on the classic path of
  this branch and 344 / 440 ms in canvas mode.
- Run-to-run spread on the same build is about ±10–15 % in fps (region pans
  read 27.6, 34.4 and 30.2 fps on three runs of the same gesture code): compare
  variants back to back.

### How it got there

The prototype (audit §4.2) toggled the canvas's `display`. Rebuilt as
production code, it first stalled on region-zoom pans; each row is a fix,
measured on the same harness (GPU; `audit_results/canvas_step*.json`, trace
breakdowns in `audit_results/canvas_trace_breakdowns.txt`):

| Step | Region pan: first · fps · p90 · max frame | Navigation (4 drags): first · fps · max frame |
|---|---|---|
| 1. Canvas shown / hidden with `display` | 81 ms · 1.7 fps · 683 · 1167 ms | – |
| 2. … with `opacity` instead | 94 ms · 20.5 fps · 58 · 392 ms | 116 ms · 18.6 fps · 1433 ms |
| 3. … plus `will-change: opacity` | 88 ms · 18.8 fps · 42 · 475 ms | 6 ms · 18.8 fps · 1392 ms |
| 4. Never restyled, pointer capture, settle on a pause, drag starts on travel | 112 ms · 27.6 fps · 33 · 308 ms | 80 ms · 50.6 fps · 67 ms |
| 5. Same code, full matrix | 91 ms · 34.4 fps · 33 · 83 ms | 70 ms · 47.9 fps · 100 ms |
| 6. Final: zoom-following halos, debounced rebuilds | 93 ms · 30.2 fps · 42 · 133 ms | 97 ms · 49.2 fps · 183 ms |

Steps 1–3 drew the proxy on `mousedown`, which the harness counted as the
first visual update although nothing had moved; from step 4 on, "first" is
the first *moved* frame.

## 3. How it works

### 3.1 Building the proxy (on idle)

`buildCanvasProxy(live, container, extent, options)` reads the live NAD once:

1. **Layers.** `#nad-background-layer` (the highlight clones / halos) plus the
   network groups `.nad-vl-nodes`, `.nad-branch-edges`, `.nad-3wt-edges`,
   `.nad-3wt-nodes`, `.nad-injections`, in their DOM order (= pypowsybl's paint
   order). `.nad-edge-infos` (flow values, arrows) and the labels are skipped.
2. **Shapes.** `polyline`, `polygon`, `line`, `circle`, `ellipse`, `rect`,
   `path`, mapped into root user space through their composed `transform`s
   (`parseTransform`). Elements hidden inline (the voltage filter's
   `display: none`, `visibility`) are skipped; highlight clones that re-assert
   `visibility: visible` are kept.
3. **Styles.** `getComputedStyle` once per style key — layer, tag, class,
   inline style, parent class and style, transform scale. Fill, stroke,
   opacities, width, dash and `vector-effect: non-scaling-stroke` are kept.
4. **Groups.** One `Path2D` per style key × cell of an 8×8 grid over the
   diagram extent, with its bounding box for culling: the 98,960 nodes
   collapse into ~270 draw items (counted on the prototype, which grouped the
   same way).
5. **Halos.** Shapes inside `.nad-overloaded`, `.nad-action-target` and
   `.nad-contingency-highlight` carry a `zoomWidth`: their computed width over
   the `--nad-halo-w` they inherit (1.7 for the contingency halo, which App.css
   draws wider so an overload on its twin circuit leaves it visible; 1 for the
   others). At draw time their width is that factor × `computeHaloWidthPx(vb)`
   — the value usePanZoom gives the live `--nad-halo-w` (24 px zoomed in →
   50 px at full extent).
6. **Background.** The container's background colour (else the body's, else
   white) — frames paint it first so they fully cover the live SVG.
7. **Overview cache** (`prepare()`). The whole network rendered once into an
   offscreen canvas of 2× the panel × dpr (≤ 8 MP), with non-scaling strokes
   baked at their full-extent widths. Frames blit it while it is at least
   1/0.65 times denser than the screen (near full extent), and stroke the
   vectors beyond. The cache is keyed by panel size and dpr: after a resize,
   frames use vectors until the next idle `prepare()` re-bakes it.

A full build, cache included, costs **84–145 ms** on the European grid. It
runs in an idle callback (`requestIdleCallback`, 2 s timeout; `setTimeout`
200 ms where unavailable) and never during a gesture, except when a gesture
starts while the proxy is stale and the idle build has not run yet — then it
is built synchronously at that gesture's start.

### 3.2 During a gesture

- **Wheel**: the first event calls `startGesture()` → `canvasProxy.begin()`,
  which makes sure a current proxy exists, marks it showing and sets
  `data-gesture-proxy` on the container. Each animation frame computes the new
  viewBox (cursor-anchored, with an analytic cursor → user mapping since the
  live SVG keeps its base viewBox) and calls `canvasProxy.frame(vb)`.
- **Drag**: the press only records the start point. The gesture starts at the
  first move that travels — `startGesture()`, then `setPointerCapture` on the
  container — and each frame applies the travel since the last one, scaled
  with the `xMidYMid meet` letterbox (`max(vb.w / W, vb.h / H)` user units per
  px).
- **`frame(vb)` draws**: background fill, then either the cache blit or every
  group whose box meets the view, stroking non-scaling widths as
  `width × dpr / scale` and halos at `computeHaloWidthPx(vb)`.
- **Nothing else changes**: no class on the container (`.svg-interacting` is
  the classic path's), no viewBox write, no style change on the canvas.

### 3.3 The settle

The gesture settles **400 ms after the last input** (`CANVAS_SETTLE_MS`), for
the wheel and — unlike the classic path — for drags too: a mouse release
re-arms the same timer. A new press or wheel notch inside the pause continues
the gesture on the proxy; a press takes over a pending settle (it settles on
its own release). Then `endInteraction()`:

1. writes the live viewBox **once** (skipped if the view did not move — a
   full relayout for nothing), updates the zoom tier and `--nad-halo-w`, and
   commits the React state;
2. calls `canvasProxy.settle()`, which clears the canvas two animation frames
   later, once the live SVG's repaint has landed, and removes
   `data-gesture-proxy`.

A programmatic `setViewBox` (Inspect, Unzoom, tab sync) ends a canvas gesture
at once: the canvas is cleared and the jump applied to the live SVG.

### 3.4 Staying in sync

- **Diagram changes** — a `MutationObserver` on the live SVG (class and
  inline-style attributes, child lists; the root's own attributes ignored, as
  the gesture modes write them) marks the proxy stale and rebuilds it on idle
  once the SVG has been quiet for **600 ms** (`REBUILD_DEBOUNCE_MS`):
  highlights, deltas, the voltage filter, the Inspect highlight.
- **Theme** — a `data-theme` change on `<html>` does the same (colours are
  resolved at build).
- **Panel size** — a `ResizeObserver` on the container re-fits the canvas and
  re-bakes the overview cache on idle.
- **Lifecycle** — a new diagram, or the tab becoming inactive, disposes the
  proxy (canvas removed, timers cleared). A generation token drops idle builds
  queued before a dispose; a stale proxy is never swapped in the middle of a
  gesture (it is still a faithful stand-in until the gesture ends).
- **Windows** — every timer and animation frame uses the container's owner
  window, so a detached tab works in its popup.

### 3.5 Fallbacks

`begin()` returns false, and the gesture takes the classic path, when there is
no live diagram, no `Path2D` (jsdom), no 2D context, or the build throws. A
build that threw is not retried for the same diagram until it changes. The
Action overview opts out with `usePanZoom(…, { gestureProxy: false })`.

### 3.6 Contracts with the rest of the app

| Contract | Where | Why |
|---|---|---|
| `data-gesture-proxy` on the container while the proxy covers it (`GESTURE_PROXY_ATTR`) | `canvasProxy.ts` → `vlInteractions.ts` | The live SVG underneath is at the gesture's start viewBox: hover / presses would resolve the wrong VL, so `vlInteractions` ignores them. No CSS reads the attribute, so setting it restyles nothing. |
| VLs resolved on `mousedown`, not on `click` | `vlInteractions.ts` | Pointer capture (like `.svg-interacting`) retargets the `click` to the container. |
| `gestureProxy: false` | `ActionOverviewDiagram.tsx` | Pins and dimming are not drawn by the proxy. |
| `canvas.nad-canvas-proxy` (`aria-hidden`, absolute at 0,0 of `.svg-container`, whose `contain: layout` makes it the containing block) | `canvasProxy.ts` | The harness counts proxy frames by the background `fillRect` on that canvas. |
| `user-select: none` on `.svg-container` | `App.css` | A drag no longer runs text selection or starts a drag-and-drop. |

## 4. Rules, and the measurements behind them

1. **Never restyle the canvas once it is mounted.** It stays composited
   (`will-change: transform`), click-through (`pointer-events: none`), shown by
   drawing an opaque frame and hidden by clearing to transparent. At region
   zoom, any style change on it costs a full layerization of the page
   (`PaintArtifactCompositor::Update`):

   | Change on the canvas (probe `flip`) | Main thread | Raster |
   |---|---|---|
   | Content only (draw / clear) | none | none |
   | `opacity` flip | Layerize 46–61 ms, + Paint 36–51 ms without `will-change: opacity` | – |
   | `pointer-events` flip | Paint 42–51 ms + Layerize 45–52 ms | – |
   | `transform` to / from off-screen | Layerize 74–110 ms | the SVG layer, 924–959 ms |
   | `display` toggle (the prototype's way) | commits blocked 2.35 s (`WaitForCommitCompletion`) | the root layer holding the SVG, ~2.9 s |

   The cost is proportional to the page's paint chunks — the 98,960-node SVG —
   not to the canvas.
2. **Click-through canvas + pointer capture on the first move.** Without
   capture, every drag mousemove hit-tests the live SVG underneath: 41 hit
   tests, 772 ms over a 30-move drag; 9 hit tests, 186 ms with capture.
   Rejected: capturing on `pointerdown` saves one more hit test (~20–40 ms at
   the drag start) but retargets every click in the container — fine for
   `vlInteractions`, a trap for anything clickable added there later;
   `preventDefault()` on `mousedown` removes Blink's drag-selection hit test
   (~20 ms) but stops a click on the map from moving the focus.
3. **Settle on a pause, drags included (400 ms).** Writing the live viewBox
   makes Chrome re-raster the visible SVG tiles (~0.94 s at region zoom on the
   Iris Xe), and no later commit can land before that raster is done: a drag
   started meanwhile waited up to 1.18 s for its first frame. With the pause,
   a navigation made of successive drags stays on the proxy: 18.8 → 49–51 fps,
   max frame 1.4 s → 67–183 ms.
4. **A drag starts on travel.** A plain click draws nothing and writes
   nothing; `vlInteractions` still gets its `mousedown`.
5. **Debounce rebuilds (600 ms).** Run on the next idle period, the ~0.1 s
   rebuild after an Inspect highlight competed with the jump's own frames (an
   82–87 ms idle callback showed up among them). Debounced, it runs at
   +607–712 ms, after the jump's viewBox write (+7–13 ms) and its paint. An Inspect jump mutates one class in the
   SVG; nothing else in the app churns it (highlights no longer re-run on
   every settle).
6. **Halos follow the zoom.** A proxy built at full extent (50 px halos) drew
   them twice as thick as the live SVG at region zoom (24 px) — and the
   overload / contingency halos are what operators track.
7. **Ignore input while the proxy is up.** During the pause after a wheel
   zoom, the live SVG still holds the old view: a click there would select
   whatever VL was under the cursor *before* the zoom.
8. **Bake the overview cache on idle only, keyed by panel size.** Re-baking
   mid-gesture would stall a frame (it renders the whole network); a
   stale-size cache would draw wrong stroke widths.

Wheel input (all modes): one wheel event may carry several coalesced notches
when the main thread is busy, so the zoom follows the delta magnitude
(`wheelZoomFactor`: 1.1 per 100 px, at least one notch from 40 px, at most 10
per event, `deltaMode` lines / pages converted). A fixed 10 % per event lost
up to half of a fast zoom.

## 5. Time budget

| Phase | Cost (European grid) | Notes |
|---|---|---|
| Proxy build, overview cache included | 84–145 ms | idle callback; synchronous only if a gesture starts on a stale proxy |
| Frame near full extent (cache blit) | < 16.7 ms | 60 fps, GPU and software |
| Frame at detail zoom (~12 % of the extent) | ~19 ms | 51–53 fps |
| Frame at region zoom (~35 %) | ~33 ms GPU, ~25 ms software | 30 / 40 fps — the most paths in view |
| Zoom frames | 42–57 fps GPU, 55–58 software | |
| First feedback, wheel | 43–56 ms GPU, 44–62 ms software | |
| First feedback, drag at full extent | 24 ms GPU, 43 ms software | |
| First feedback, drag at region / detail zoom | 93–106 ms GPU, 123–124 ms software | press hit test ~21 ms + first-move hit test ~20 ms + drag-selection check ~21 ms, then the frame. Since `vlInteractions` waits for a click before hit-testing the paint stack (`docs/features/vl-disk-interactions.md`), a press off a disk no longer pays a ~33 ms `elementsFromPoint`: one hit test fewer at a drag start (`drag-hits`: 6 → 5 over 2 ms, 161 → 114 ms) and first feedback 40–60 ms sooner, interleaved against `main` under load (region 148 → 98 ms, detail 144 → 84 ms, navigation 139 → 88 ms, median of 3) |
| Settle bake, main thread (region zoom) | ~0.25–0.3 s | layout ~106 ms, paint 52–120 ms, layerize 66–73 ms |
| Settle re-raster (region zoom) | ~0.94 s GPU raster | off the main thread, but later commits wait for it |
| Inspect / Unzoom jump | 440–496 / 316–344 ms | same as the classic path |
| Hover over the live SVG | 20–40 ms per mousemove | every mode — not a proxy cost |
| Wheel burst, 12 notches | 4 expensive hit tests, 125–154 ms in total | 0 ms if the canvas were hit-testable (§7.1) |

## 6. Tunables

| Constant | Value | File | Trades |
|---|---|---|---|
| `CANVAS_SETTLE_MS` | 400 ms | `usePanZoom.ts` | longer: fewer bakes between gestures, labels back later |
| `WHEEL_SETTLE_MS` | 150 ms | `usePanZoom.ts` | the classic path's wheel debounce |
| `WHEEL_ZOOM_STEP`, `WHEEL_NOTCH_PX`, `WHEEL_NOTCH_MIN_PX` | 1.1, 100 px, 40 px | `usePanZoom.ts` | zoom per notch; notch size; smallest delta counted as a whole notch |
| `REBUILD_DEBOUNCE_MS` | 600 ms | `canvasProxy.ts` | shorter: fresher proxy, rebuild may land in a jump's frame |
| `GRID` | 8 (8×8 cells) | `canvasProxy.ts` | finer: better culling, more draw calls |
| `CACHE_MAX_PIXELS` | 8 MP | `canvasProxy.ts` | memory vs overview sharpness |
| `CACHE_MAX_MAGNIFICATION` | 0.65 | `canvasProxy.ts` | how far from full extent the blit is used (strokes thicken as it is magnified) |
| `HALO_MIN_PX` / `HALO_MAX_PX` | 24 / 50 px | `usePanZoom.ts` | halo widths, live and proxy |

## 7. Known limits and next levers

1. **Hit-testing the live SVG.** ~20–40 ms per hit test at region zoom, in
   every mode: hovering the map, the start of every drag (§5), and 4 of the
   14 hit tests of a 12-notch wheel burst (125–154 ms in total, 0 ms with a
   hit-testable canvas — but making the canvas hit-testable per gesture costs
   a restyle of ~100 ms). Lever: make only VL nodes and label boxes
   hit-testable (`pointer-events: none` on the edges, edge infos and halos by
   default), so a hit test walks a fraction of the tree. Expected: first
   feedback under 50 ms on every drag, cheaper hover. Measure with the
   `drag-hits` and `wheel-hits` probes.
2. **The settle bake** (~0.3 s of main thread + ~0.94 s re-raster at region
   zoom). A gesture started within ~1 s of a settle still waits for it. Levers:
   audit Q1 (`--nad-halo-w` on the background layer: no full-tree restyle when
   the halo width changes), Q4 (tier rules that hide the HTML labels at the
   overview), S1 (viewport-limited flow values and labels), S2 (bake the
   per-VL `translate·scale` into coordinates: fewer paint chunks, cheaper
   layerization for every frame of every mode).
3. **Labels and flow values on the proxy** at detail zoom (text on the
   canvas), so the pause shows less pop-in.
4. **Fly-to for Inspect / Unzoom on the proxy** (audit A3): animate the jump on
   the canvas and bake once at the end.
5. **Incremental rebuild**: patch the groups a highlight change touches
   instead of a ~0.1 s full rebuild.
6. **Frames off the main thread** (audit A5): an `OffscreenCanvas` in a worker
   for VDI sessions.
7. **Wheel notch size**: B2 uses a fixed 100 px notch; on a device with
   smaller notches, coalesced events still under-count. Learn it from the first
   events.
8. **Retire `gpu` and `bitmap`** (audit A2) once the canvas mode has run on
   operator machines for a while.

## 8. Measuring it

Production build, served same-origin from a backend on its own port — here
:8001, never the operator's :8000 / :5173 — as in `AUDIT_HARNESS.md`:

```bash
cd benchmarks/interaction_paint
APP=http://127.0.0.1:8001/
# Full matrix, canvas mode, GPU then software raster, and the classic path.
node audit_drive.mjs --url $APP --hw gpu --mode canvas --reps 2 --out canvas_gpu.json
node audit_drive.mjs --url $APP --hw sw  --mode canvas --reps 2 --out canvas_sw.json
node audit_drive.mjs --url $APP --hw gpu --mode off    --reps 2 --out classic_gpu.json
python3 audit_compact.py "canvas=canvas_gpu.json" "canvas SW=canvas_sw.json" "classic=classic_gpu.json"

# A kept session for the probes (the app stays loaded in headless Chrome on :9351).
DETACH=1 node audit_drive.mjs --url $APP --hw gpu --mode canvas --scenarios none --keep 1 --port 9351 --out session.json
node audit_probe.mjs flip        # style flips on the canvas (add --display for the 3 s toggle)
node audit_probe.mjs drag-hits   # hit tests at a drag start, with / without capture
node audit_probe.mjs wheel-hits  # hit tests during a wheel burst
node audit_probe.mjs rebuild     # rebuild timing vs an Inspect jump, SVG mutations
node audit_probe.mjs detached    # a drag in a detached window
node audit_probe.mjs layers      # composited layers during a gesture
```

Things that bit:

- **Load drift.** The operator's backend and other sessions share the CPU;
  jump timings moved 100–200 ms between a morning and an afternoon run.
  Compare variants back to back in one sitting (`--scenarios unzoom_click,inspect_jump --reps 3`).
- **"First" semantics.** A canvas-mode visual update is a proxy frame (its
  background `fillRect`); a drag's first one is the first *moved* frame.
  "Catch-up" includes the deliberate 400 ms pause.
- **Zoom "done"** assumes the symmetric 1.1-per-notch zoom; builds before
  2026-11-15 zoomed in by 0.9 per notch.
- **Fresh worktrees** hold Git LFS pointers for `*.zip` (the European
  `network.xiidm.zip` is 132 bytes): point the config at a checkout with the
  real files, or run `git lfs pull`.
- **Traces** of a full gesture are 10–40 MB: trace one scenario at a time
  (`--trace pan_region`) and read them with `audit_trace_breakdown.py`.

Reference probe output (2026-11-15, final build, region zoom):

```text
layers      during a canvas gesture: root layer (#document) holds the SVG; the canvas
            has its own layers (reasons WillChangeTransform, Canvas)
flip        content only: nothing; opacity: Paint 36–51 + Layerize 46–47 ms;
            pointer-events: Paint 51 + Layerize 45–47 ms;
            translate: Layerize 74–110 ms + RasterTask 959 ms
drag-hits   as built: 6 hit tests > 2 ms (165 ms); capture on pointerdown: 5 (114 ms);
            preventDefault on mousedown: 5 (131 ms), no drag-selection check
wheel-hits  click-through canvas: 14 hit tests (154 ms, 4 over 2 ms); hit-testable: 14 (0 ms)
rebuild     viewBox written at +7–10 ms; rebuild at +607–610 ms (90–145 ms); 1 class mutation
detached    proxy drawn in the popup; live viewBox unchanged mid-drag; baked after the pause
```

## 9. Tests

- `utils/svg/canvasProxy.test.ts` (22) — transform parsing; grouping, hidden
  and non-network elements, transforms, paint order, non-scaling and
  zoom-following halo widths, culling, background cover, overview cache (blit
  vs vectors, re-bake on resize, never mid-draw); controller: draw to show /
  clear to hide two frames after the settle, never restyles the canvas, a new
  gesture cancels a pending settle, debounced rebuild and dispose, cache
  re-bake on idle after a resize, fallbacks (no diagram, no `Path2D`, no 2D
  context, a build that throws is not retried).
- `hooks/usePanZoom.test.tsx` — `wheelZoomFactor`; drag-end flush and
  letterbox drag scale; a press owning a pending wheel settle; canvas mode:
  one bake after the pause, chained drags, a click draws nothing, wheel zoom,
  the opt-out surface, a programmatic jump. The other cases pin the classic
  path.
- `utils/svg/vlInteractions.test.ts` — hover and clicks ignored while the
  proxy is up.
- `utils/smoothPanZoom.test.ts` — the default (`'canvas'`), explicit choices
  kept (including `'off'`), legacy storage, persistence.
