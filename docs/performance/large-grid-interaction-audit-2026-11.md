# Large-network interaction audit — full European grid (2026-11)

**Status:** audit + measured prototypes. No product change ships with this
document; the prototypes live in
[`benchmarks/interaction_paint/audit_prototype.patch`](../../benchmarks/interaction_paint/audit_prototype.patch).
**Grid:** `pypsa_eur_eur220_225_380_400` — 5,247 voltage levels, 7,853
branches. N-state NAD after `processSvg`: **9.9 MB, 98,960 DOM nodes**.
**Question:** how fluid are zoom-in / zoom-out and navigation across the
network today, why, and what would make them fluid.

This revisits the June 2026 work
([`history/interaction-paint-culling.md`](history/interaction-paint-culling.md),
[`FLUIDITY_FINDINGS.md`](../../benchmarks/interaction_paint/FLUIDITY_FINDINGS.md)),
which was measured on an Apple M4 Pro with synthetic DOM events and concluded
that the residual cost was "pure SVG raster". Driving the **real app** with
**real input events** on a mainstream Intel laptop gives a different picture:
the cost is overwhelmingly **main-thread Blink work** (style recalculation,
SVG layout, layerization) that scales with the size of the DOM, it is
concentrated at gesture boundaries, one regression landed after the June
measurements, and five behavioural bugs in the gesture code make the map
lag behind — or stop short of — the operator's hand.

## TL;DR

- **Today the European NAD is not interactive on a mainstream Intel laptop**
  (i7-13700H, Iris Xe). Default mode: 4–5 fps while zooming, 1–4 fps while
  panning, **0.4–0.8 s before the map reacts**, and a 0.15–0.5 s freeze after
  each zoom. The opt-in `gpu` and `bitmap` modes do not change that here
  (`bitmap` is often worse: up to 1.9 s before the first frame).
- **When frames are slower than the input, the gesture code loses input.**
  Zoom bursts reach ~55 % of the requested zoom (coalesced wheel events count
  as one notch), drags lose their end, the map slides 22 % slower than the
  cursor (letterbox scale), and every drag selects text. Pans ended at
  31–76 % of the hand's travel. Five small bugs (B1–B5).
- **The cost is main-thread Blink work that scales with the 99k-node DOM —
  not raster** (the default path is exactly as slow with the GPU turned
  off). Per zoom frame: ~150 ms of SVG layout plus ~90 ms of full-tree
  restyle caused by the zoom-adaptive halo width (added 2026-06-20, after
  the June measurements); 0.4–0.9 s at each gesture boundary for the
  culling toggle. The June study (M4 Pro, synthetic events, steady-state
  frames only) could not see the boundaries, the lost input or the
  regression.
- **Bugs + quick wins (≈ a day)**: every gesture lands where the hand went
  (`done` 0.31–0.76 → 1.00), first feedback roughly halves, pans get ~2.5–3×
  and zooms ~2× more frames (3–9 fps panning, 8–16 fps zooming). Better,
  still not fluid: each frame still re-lays out the whole SVG.
- **A gesture proxy makes it fluid.** Drawing a light canvas stand-in during
  the gesture (268 grouped paths, cached overview) and baking the live SVG
  once on settle gives, on the same laptop: **first feedback 9–30 ms,
  31–53 fps on zooms, full-extent pans and cross-Europe navigation, every
  gesture complete** — 7–35× the default frame rate and 15–60× faster
  first feedback. It holds up **without any GPU** (software raster, the VDI
  case: 25–54 fps, 6–34 ms first feedback), which removes the reason June
  kept compositing tricks out of the default path. Remaining: ~20 fps for
  pans at region zoom, and a one-off 0.25–0.45 s bake of the live SVG after
  a zoom, which only a smaller live DOM (viewport-limited flows / labels)
  removes.

---

## 1. Method

### Test case

| | |
|---|---|
| Grid | `pypsa_eur_eur220_225_380_400` (full European 220–400 kV, the bundle `config_pypsa_eur_225_400.json` points at) |
| Size | 5,247 voltage levels, 7,853 branches |
| N-state NAD | 9.9 MB serialized after `processSvg`, **98,960 DOM nodes**: 29,490 `g`, 20,953 `polyline`, 15,706 `path`, 15,706 `text`, 6,607 `circle`, 1 `foreignObject` holding 10,495 HTML `div` labels |
| By layer | `.nad-edge-infos` 47,118 · `.nad-branch-edges` 25,599 · `.nad-vl-nodes` 10,494 · `.nad-text-nodes` 10,495 · `.nad-text-edges` 5,247 |
| App build | production `vite build` of the working tree (2026-11-15), served same-origin by an isolated backend |

### Hardware

A mainstream engineering laptop rather than the Apple M4 Pro of the June study:
Intel Core i7-13700H, Intel Iris Xe (Raptor Lake-P) iGPU, 32 GB, Linux 6.8,
Chrome 144, 1920×1080 viewport at dpr 1, 60 Hz. NAD panel: 1439 × 886 px.

Two raster configurations:
- **GPU**: hardware raster + GPU compositing on the Iris Xe (ANGLE/OpenGL,
  verified through `SystemInfo.getInfo`).
- **Software**: `--disable-gpu` (SwiftShader), standing in for the
  VDI / remote-desktop / GPU-blocklisted control-room sessions.

### Harness — what changed vs. June

The June harness dispatched synthetic DOM events from a `requestAnimationFrame`
loop for 2.5 s of continuous back-and-forth zooming at full extent. It measured
the steady-state cost of a frame in the middle of a long gesture, but by
construction it could not see:

1. the **gesture start** (the `.svg-interacting` class toggle was paid once, at
   the first event);
2. the **settle** (nothing was measured after the last event);
3. **input queueing / coalescing** (synthetic events run synchronously, there
   is no OS input stream behind a busy main thread);
4. whether the diagram **ends where the hand went** (only frame intervals
   were recorded);
5. zoom levels other than full extent (the in/out alternation kept the view
   near the overview tier).

The new driver (`benchmarks/interaction_paint/audit_drive.mjs`) loads the
study through the UI (`Load Study`), opens the N tab, and replays scripted
gestures through **`Input.dispatchMouseEvent`** — the same browser-side input
router a physical mouse uses, so wheel/mousemove coalescing and the
main-thread input queue behave as for an operator. Events are fired on a
fixed clock without awaiting acknowledgements, like a real input stream.

In-page instrumentation (`audit_instrument.js`, injected before the app boots)
records, only during a measurement window: every rAF timestamp, the visible
diagram state per frame (viewBox, CSS transform, bitmap canvas, proxy viewBox,
`.svg-interacting`, zoom tier), the input events actually delivered, and
Long-Animation-Frame entries (script vs style/layout/paint split). Selected
scenarios are also captured as Chrome traces and broken down per pipeline
stage (`audit_trace_breakdown.py`).

### Scenarios

| Scenario | Gesture |
|---|---|
| `zoom_in_burst` | 16 wheel notches, 40 ms apart, from full extent (fast spin) |
| `zoom_out_burst` | 20 notches out, 40 ms apart, from deep zoom (~12 % width) |
| `zoom_in_smooth` | 24 events, 16 ms apart (trackpad-like) |
| `zoom_in_notches` | 6 notches, 300 ms apart (deliberate notch-by-notch zoom) |
| `pan_overview` / `pan_region` / `pan_detail` | 1 s drag, 30–40 % of the panel, at full extent / ~35 % / ~12 % width |
| `navigate_region` | 4 successive 700 ms drags across Europe at ~35 % width, 180 ms re-grab pauses |
| `unzoom_click` | click **Unzoom** from deep zoom |
| `inspect_jump` | type a voltage-level id in the Inspect field (zoom-to-element) |
| `tab_return_n` | switch to the Context tab, then back to the N tab |

### Metrics

- **first frame** — ms from the first input to the first frame that shows a
  change (the operator's "did it react?" latency).
- **fps / p50 / p90 / max** — main-thread frame cadence during the gesture
  (for the notch-by-notch zoom this includes the idle frames between notches,
  so read its first-frame and freeze columns instead).
- **upd/s** — frames per second that actually changed the picture.
- **done** — how much of the requested gesture the diagram ended up showing
  (1.00 = the map followed the hand; pans compare pixel travel, zooms the
  log of the width ratio).
- **freeze after** — the longest frame after the last input: the frame that
  restores flows and labels (default path) or bakes the live SVG (proxies).
- **input → painted** — for one-shot actions (Unzoom, Inspect, tab switch):
  from the input to the first painted frame showing the result.

The per-frame probe was made O(1) after the first wave (a `:scope > svg`
query had cost ~5–10 ms per frame on this DOM); first-wave numbers are only
used for the `gpu` / `bitmap` baselines, whose frames take 150–700 ms.
Each configuration was run twice (`--reps 2`, medians reported) unless
stated; scenario order is identical across configurations.

---

## 2. Baseline — what the operator gets today

GPU raster, production build, median of 2 repetitions. Each cell is
**time to first visual feedback · frame rate during the gesture · `done`**
(how much of the requested gesture the diagram finally shows; 1.00 = the
map followed the hand). `gpu` / `bitmap` share the default's pan and wheel
code, so their `done` is the same (not recorded in that wave).

| Scenario | default (`off`) | `gpu` mode | `bitmap` mode |
|---|---|---|---|
| Zoom-in burst (16 notches) | 430 ms · 4.5 fps · 0.53 | 514 ms · 6.4 fps | 496 ms · 3.3 fps |
| Zoom-out burst (20 notches) | 484 ms · 5.0 fps · 0.55 | 624 ms · 6.7 fps | 1787 ms · 4.0 fps |
| Smooth zoom-in (trackpad-like) | 424 ms · 4.6 fps · 0.54 | 538 ms · 6.0 fps | 494 ms · 4.2 fps |
| Notch-by-notch zoom (300 ms apart) | 396 ms · 3.4 fps · 1.00 | 544 ms · 6.1 fps | 1886 ms · 1.8 fps |
| Pan at full extent | 389 ms · 3.9 fps · 0.69 | 529 ms · 4.3 fps | 431 ms · 2.9 fps |
| Pan at region zoom (~35 %) | 531 ms · 2.5 fps · 0.69 | 592 ms · 4.4 fps | 589 ms · 1.2 fps |
| Pan at detail zoom (~12 %) | 555 ms · 2.4 fps · 0.73 | 642 ms · 4.1 fps | 678 ms · 1.3 fps |
| Navigate across Europe (4 drags) | 556 ms · 0.9 fps · 0.47 | 555 ms · 1.2 fps | 746 ms · 0.9 fps |
| Unzoom button | 336 ms | – | – |
| Inspect → zoom to element | 376 ms | – | – |
| Return to the N tab | 408 ms | – | – |

Three independent measurement waves of the default mode agree on the time
to first feedback (within ~10 % for most scenarios) and on the frame rate;
the table shows the last one. `done` for pans varies more from run to run
(0.31–0.76) because it depends on how the input batches happen to coalesce
behind the slow frames. Zoom gestures also leave a
**post-gesture freeze** — the frame that restores flows and labels — of
0.15–0.5 s (longest frame after the last input).

**Reading.** On a mainstream Intel laptop the European NAD is not
interactive in any of the three shipped modes: 1–7 fps, 0.4–1.9 s before the
map reacts to the hand, and — because frames are slower than the input —
zoom bursts reach only ~55 % of the requested zoom and pans 31–76 % of the
hand's travel. The opt-in modes, which measured 1.2–1.5× (`gpu`) and ~3×
(`bitmap`, real app) on the M4 Pro in June, give at most ~1.5× here, and
`bitmap` is often *worse* than the default (up to 1.9 s median before the
first frame).

---

## 3. Where the time goes (trace breakdown)

Chrome trace of `zoom_in_burst` in the default mode (16 notches from full
extent), renderer main thread, self time by stage:

| Stage | Self time | Notes |
|---|---|---|
| `Document::recalcStyle` | 1,552 ms (×11) | full-tree style recalculation |
| `LocalFrameView::performLayout` | 1,279 ms (×13) | SVG layout |
| `PaintArtifactCompositor::Update` | 248 ms | layerization |
| `PrePaint` | 242 ms | |
| `Paint` | 239 ms | |
| SVG text layout (`SvgTextLayoutAlgorithm`, `FindSvgTextChunks`, `ShapeText…`) | ≈ 430 ms (×≈100k each) | the 15,706 flow `<text>` re-laid out whenever they come back |
| `Document::rebuildLayoutTree` | 114 ms (×4) | culled subtrees detached / re-attached |
| `HitTest` | 109 ms (×17) | per wheel event, on ~99k nodes |

The GPU process was busy only ≈ 515 ms over the same 5 s window and the
compositor thread ≈ 135 ms: **raster is not the bottleneck on this machine;
the renderer main thread is.**

Per frame:

| Frame | Duration | Split |
|---|---|---|
| wheel handler (first event) | 249 ms | forced style recalc 233 ms (`getScreenCTM()` right after the class toggle) |
| first gesture frame | 474 ms | style 315, paint 63, layout 62, prepaint 30 |
| steady frame, zoom ratio > 0.5 | 300–346 ms | layout 144–171, **style 84–99**, prepaint 30, paint 26–32, layerize 13–24 |
| steady frame, zoom ratio ≤ 0.5 | 234–251 ms | layout 151–176, prepaint 28–42, paint 27, layerize 15–16 (no style) |
| settle frame (culling released) | **885 ms** | layout 319, style 291, paint 170, layerize 85, prepaint 53, commit 43, hit-test 43 |

### Root causes

**RC1 — every viewBox write re-lays out the whole SVG (≈ 150–175 ms/frame).**
Changing the root `viewBox` changes the CTM of every shape, and Blink lays
them all out again — ≈ 22k branch polylines and bus / winding circles stay
visible during a gesture even with flows and labels culled. Under
`vector-effect: non-scaling-stroke` (needed so 5-unit strokes stay visible at
a 4.4 M-unit-wide viewBox) each shape's stroke geometry depends on the
screen CTM, so none of it can be reused. (Removing non-scaling-stroke was
measured as a no-op in June, on a machine where raster dominated; it was not
re-tested here because without it the network vanishes at full extent.)
This is intrinsic to "pan/zoom = rewrite the viewBox of a 99k-node SVG".

**RC2 — the zoom-adaptive halo width restyles the whole tree on every zoom
frame (≈ 85–100 ms/frame).** `usePanZoom.applyViewBox` writes
`--nad-halo-w` on the container. A custom property is inherited, so changing
it invalidates the computed style of all ~99k descendants, although only the
handful of halo clones in `#nad-background-layer` read it. Above a zoom
ratio of 0.5 the rounded width changes on almost every frame. This landed on
2026-06-20 (`d6e7c19`), after the June fluidity measurements — a regression
nobody measured.

**RC3 — gesture start is a full-tree restyle plus a layout-tree teardown
(≈ 0.4–0.8 s before the first visual feedback).** Adding `.svg-interacting`
on the container (a) matches `.svg-interacting svg * { pointer-events: none }`
— a universal descendant rule, so every node is restyled — and (b) sets
`display: none` on the flow, label and label-connector layers, detaching up
to ~63k nodes (47,118 + 10,495 + 5,247) from the layout tree.
The wheel handler then calls `getScreenCTM()`, which forces that whole
recalculation synchronously inside the handler (233–345 ms), and the next
frame pays the rest (tier attribute, halo var, layout).

**RC4 — the settle is the single most expensive frame (≈ 0.35–0.9 s).**
Releasing the culling re-attaches the 47k flow nodes and the 5,247 HTML
labels: style for all of them, SVG text layout of the 15,706 flow values at
the new scale (Blink lays SVG text out at the on-screen font size, so a scale
change means re-shaping every string), then paint. Nothing can be done by the
operator during this freeze; a follow-up gesture queues behind it.

**RC5 — when frames are slower than the 150 ms wheel debounce, the culling
flips mid-gesture.** The settle timer fires between two queued batches of
wheel events, so the gesture pays a full RC4 settle *and* a new RC3 start in
the middle (observed in most default-mode bursts and pans: 1–2 flips per
gesture, each worth 0.5–1 s of main thread).

**RC6 — drags lose their end when frames are slow (correctness bug).**
`handleMouseMove` only records the cursor and schedules a rAF;
`handleMouseUp` *cancels* that pending rAF. Under load the last coalesced
mousemove and the mouseup are delivered in the same task, so the pending
delta is discarded. In the default runs, single 1 s pans ended at
**0.31–0.76** of the hand's travel and the four-drag navigation at **≈ 0.5**;
with this fix alone every pan reached 0.78 — the remaining 22 % is RC6c.

**RC6b — wheel zoom ignores the delta magnitude (correctness bug).**
`handleWheel` multiplies by 0.9 / 1.1 per *event* (`e.deltaY > 0 ? 1.1 : 0.9`).
Behind a busy main thread Chrome coalesces queued wheel events and sums
their deltas, so three notches arrive as one event with `deltaY = 300` and
zoom like one: a 16-notch spin reached only **55 %** of the requested zoom
(log scale). The same rule makes trackpads (many small deltas) zoom 10 % per
tiny event — far too fast.

**RC6c — drag-pan ignores the `xMidYMid meet` letterbox (correctness bug).**
The drag converts pixels to user units with `vb.w / screenWidth`. pypowsybl
emits `preserveAspectRatio="xMidYMid meet"`, so when the panel is wider than
the diagram (here 1.62 vs 1.26) one screen pixel is `vb.h / screenHeight`
user units: the map slides **22 % slower than the cursor** and the grabbed
point drifts from under the hand on every drag, at every zoom level and in
every mode (wheel zoom is unaffected — it anchors through the CTM).

**RC6d — a drag-pan selects text.** `usePanZoom` does not prevent the
default action of `mousedown`, and nothing sets `user-select: none` on the
diagram, so every drag runs Chrome's selection controller over the flow
`<text>` and the HTML labels (`MouseEventManager::handleMouseDraggedEvent`
233 ms over one 1 s pan in the `gpu`-mode trace, then `commitPendingSelection`
on every following frame while the selection lives). Dragging *across an
existing selection* can also start a native drag-and-drop instead of a pan:
in the first proxy-mode runs (labels and flows are not hidden there, so a
drag often starts on text) several pans stopped receiving `mousemove` /
`mouseup` after the first event and never ended. With `user-select: none` on
the diagram the stuck gestures disappeared in every later run.

**RC7 — the VL labels are never culled by the zoom tiers.** The tier rules
target `.nad-vl-nodes foreignObject`, but this pypowsybl build emits the
labels as one root-level `foreignObject.nad-text-nodes` with 10,495 HTML
`div`s. At full extent, all 5,247 labels are laid out and painted although
they are unreadable, and every overview settle restores them.

**RC8 — the opt-in modes do not escape RC1–RC4 on this machine.**
- `gpu`: the transform itself is cheap, but gesture start/settle still toggle
  the culling (RC3/RC4) and `beginInteraction` reads `getBoundingClientRect()`
  right after the class toggle (forced 305 ms in the `mousedown` handler).
  Its pan trace is dominated by the culling (style 342 ms, layout-tree
  rebuild 188 ms, SVG layout 377 ms at start/settle) and by the drag
  selection of RC6d, not by raster: the GPU process was busy 28 ms over the
  whole 2.7 s window.
- `bitmap`: Chrome cannot `createImageBitmap()` an SVG blob (verified: Chrome
  144 throws `InvalidStateError: The source image could not be decoded`), so
  `rasterizeMarkupToCanvas` always falls back to `new Image()`, which parses,
  lays out and rasters the ~9 MB snapshot **on the main thread**, in an
  isolated SVG document. Meanwhile the gesture runs on the slow viewBox path,
  and the culling toggle still applies: first feedback took 0.4–3.1 s in
  `bitmap` mode here. `bitmapSnapshot.ts` and the frontend `CLAUDE.md` still
  describe the decode as off-main-thread.

### Secondary findings (navigation around the diagram)

- **Inspect typing costs ≈ 160 ms per input event.** The `input` handler
  (LoAF `DIV.oninput` 158 ms) updates `inspectQuery`, which lives in
  App-level state, so each character re-renders the orchestration hub and
  re-runs `filterInspectables` over ≈ 13k ids (two `toUpperCase()` each).
  Typing a name feels laggy on this laptop before any zoom happens. Keeping
  the query local to `InspectSearchField` (commit on select / exact match)
  or deferring the filter with `useDeferredValue` would decouple typing from
  the App render.
- **Zoom-to-element and Unzoom are single full repaints (≈ 0.4 s by
  default; Unzoom ≈ 0.23 s with the overview label fix).**
  They are one-shot viewBox jumps, so they pay one RC1 frame (plus the RC4
  label/flow layout at the destination). They are not animated, which is
  good for cost but disorienting at continental scale: the operator loses
  the context of where the element is. With the proxy available, a short
  animated fly-to (overview → target, ~300 ms on the proxy, single bake at
  the end) becomes affordable.
- **Major GCs cost ~130 ms** (`V8.GC_MARK_COMPACTOR` 133 ms in the notch
  trace, mostly embedder tracing of the DOM wrappers): another cost that
  scales with the live DOM and lands at random inside gestures.
- `zoomToElement` looks the target up with
  `container.querySelector('[id="…"]')` — an attribute selector, so a scan of
  the 99k-node tree instead of the id-map lookup the rest of the pipeline
  uses (`getIdMap`). Small, but it sits on the jump's critical path.

---

## 4. Experiments

Every candidate was A/B-tested in the real app. CSS changes were applied at
runtime by **deleting / replacing** the App.css rules through CSSOM (not by
overriding them, so the selector-invalidation cost really goes away); JS
changes sit behind `localStorage` flags in a scratch build
(`audit_prototype.patch`). Same hardware, same scenarios, GPU raster unless
stated.

### 4.1 Bug fixes + quick wins on the default path

Flags: `drag-flush` (B1), `wheel-delta` (B2), `drag-meet` (B3),
`settle-confirm` (B4), `css-no-select` (B5), `halo-bg` (Q1),
`css-ptr-root` (Q2), `ctm-first` (Q3), `css-labels-tier` (Q4).

| Scenario | default | bugs + quick wins |
|---|---|---|
| Zoom-in burst (16 notches) | 430 ms · 4.5 fps · 0.53 | 264 ms · 8.9 fps · 0.90 |
| Zoom-out burst (20 notches) | 484 ms · 5.0 fps · 0.55 | 320 ms · 16.0 fps · 1.00 |
| Smooth zoom-in (trackpad-like) | 424 ms · 4.6 fps · 0.54 | 235 ms · 8.1 fps · 0.90 |
| Notch-by-notch zoom (300 ms apart) | 396 ms · 3.4 fps · 1.00 | 238 ms · 36.8 fps · 0.90 |
| Pan at full extent | 389 ms · 3.9 fps · 0.69 | 196 ms · 8.8 fps · 1.00 |
| Pan at region zoom (~35 %) | 531 ms · 2.5 fps · 0.69 | 400 ms · 6.3 fps · 1.00 |
| Pan at detail zoom (~12 %) | 555 ms · 2.4 fps · 0.73 | 426 ms · 5.8 fps · 1.00 |
| Navigate across Europe (4 drags) | 556 ms · 0.9 fps · 0.47 | 411 ms · 3.0 fps · 1.00 |
| Unzoom button | 336 ms | 234 ms |
| Inspect → zoom to element | 376 ms | 548 ms |
| Return to the N tab | 408 ms | 350 ms |

What the fixes buy, and what they cannot:

- **Outcome.** With B1–B5 every gesture ends where the hand went (`done`
  1.00 for pans and navigation, 0.90–1.00 for zooms) instead of 0.31–0.76.
  That is the biggest *perceived* change: the map follows the cursor.
- **Responsiveness.** Time to first feedback roughly halves on zooms
  (~425–485 → ~235–320 ms) and drops by up to half on pans (~390–555 →
  ~195–425 ms): Q1–Q3 take the forced restyle out of the wheel handler and
  the per-frame halo restyle out of the overview range, and B5 removes the
  drag selection work. Pans get ~2.5–3× more frames, zooms ~2×. **Unzoom**
  drops from ~340–405 to ~235 ms because the full-extent view no longer lays
  out 5,247 unreadable labels (Q4); returning to the N tab from ~410 to
  ~350 ms.
- **Trace check.** In the zoom trace with the quick wins, the steady frames
  above zoom ratio 0.5 contain **no style recalculation at all** (vs 84–99 ms
  per frame without Q1), and the settle frame drops from 885 to 607 ms. What
  is left per frame is ≈ 190 ms of SVG layout (112–132 ms), pre-paint,
  paint and layerization.
- **Still not fluid.** Pans run at 3–9 fps and zooms at 8–16 fps: a frame
  still rewrites the root viewBox, so Blink re-lays out every shape (RC1,
  ≈ 85 ms of layout per region-zoom pan frame in the trace), and the culling
  toggle still detaches / re-attaches the flow and label layers at both ends
  of each gesture. Inspect → zoom-to-element did not move (0.4–0.55 s, noisy:
  the React input handler alone varies 6–260 ms).

### 4.2 Gesture proxies — stop touching the 99k-node SVG during a gesture

The idea: during a gesture, show a **light stand-in** of the network on top
of the live diagram and move *that*; leave the 99k-node SVG completely
untouched (no class toggle, no culling, no viewBox write, no restyle), and
bake the final viewBox onto it **once**, on settle, behind the stand-in. The
stand-in is hidden two frames later, after the live SVG has painted (the
same no-ghost trick as the bitmap mode). It is rebuilt on idle when the live
SVG's highlight classes change — the MutationObserver the bitmap mode already
has. Edge-info flows and VL labels are left out of the stand-in, exactly as
the gesture culls them today; halos (`#nad-background-layer`) are kept, so
N-1 / Action highlights stay visible during the gesture.

Two stand-ins were prototyped:

1. **Vector proxy** (`utils/svg/vectorProxy.ts`, mode `proxy`): a light
   `<svg>` where every branch half-edge and every bus / winding circle is
   merged into one `<path>` per CSS class group and 8×8 grid cell
   (**268 paths instead of 98,960 nodes**, built in ~50–120 ms on idle). It
   keeps pypowsybl's classes and nesting, so pypowsybl's own `<style>` and
   the App.css rules (colours, `non-scaling-stroke`, theme) paint it exactly
   like the live diagram. Two lessons on the way:
   - one path per class group (6 paths) left the main thread idle but made
     **GPU raster** the bottleneck (~50 ms of GPU-process work per frame):
     every raster tile re-tessellates the whole network-wide path. Splitting
     into grid cells lets tiles and the cull rect skip what they don't show;
   - the proxy must sit on **its own compositing layer**
     (`will-change: transform`), otherwise every proxy frame re-rasters the
     occluded live-SVG tiles underneath.
   It still repaints through Blink, and every repaint re-runs
   `PaintArtifactCompositor::Update` over the **whole document's** paint
   chunks — including the ~20k transformed groups of the live SVG —
   ≈ 67 ms per frame at region zoom (trace). That caps it at ~10 fps once
   flows and labels are displayed on the live SVG.
2. **Canvas proxy** (`utils/svg/canvasProxy.ts`, mode `canvas`): the same
   grouped geometry as `Path2D` objects, colours / widths resolved once from
   the live diagram's computed styles, drawn with Canvas 2D under the
   `xMidYMid meet` transform (non-scaling stroke emulated by
   `lineWidth / scale`, off-screen cells culled). A canvas redraw only
   invalidates the canvas' own layer — no Blink paint, no layerization of
   the live SVG. Near full extent (≤ ~1.3× zoom) it blits a cached render of
   the whole network made once on idle instead of re-stroking 20k segments.

Same scenarios, same laptop (GPU raster); both proxies run with the bug fixes, `user-select: none`, the label tier fix, `css-text-geo` (no effect, §4.4) and a 400 ms settle.

| Scenario | default | bugs + quick wins | SVG proxy | canvas proxy |
|---|---|---|---|---|
| Zoom-in burst (16 notches) | 430 ms · 4.5 fps · 0.53 | 264 ms · 8.9 fps · 0.90 | 27 ms · 40.8 fps · 0.90 | 27 ms · 31.5 fps · 0.90 |
| Zoom-out burst (20 notches) | 484 ms · 5.0 fps · 0.55 | 320 ms · 16.0 fps · 1.00 | 25 ms · 16.4 fps · 1.00 | 28 ms · 41.7 fps · 1.00 |
| Smooth zoom-in (trackpad-like) | 424 ms · 4.6 fps · 0.54 | 235 ms · 8.1 fps · 0.90 | 23 ms · 29.4 fps · 0.90 | 30 ms · 35.0 fps · 0.90 |
| Notch-by-notch zoom (300 ms apart) | 396 ms · 3.4 fps · 1.00 | 238 ms · 36.8 fps · 0.90 | 24 ms · 54.0 fps · 0.90 | 28 ms · 53.0 fps · 0.90 |
| Pan at full extent | 389 ms · 3.9 fps · 0.69 | 196 ms · 8.8 fps · 1.00 | 12 ms · 36.2 fps · 1.00 | 12 ms · 52.6 fps · 1.00 |
| Pan at region zoom (~35 %) | 531 ms · 2.5 fps · 0.69 | 400 ms · 6.3 fps · 1.00 | 161 ms · 8.7 fps · 1.00 | 16 ms · 20.3 fps · 1.00 |
| Pan at detail zoom (~12 %) | 555 ms · 2.4 fps · 0.73 | 426 ms · 5.8 fps · 1.00 | 10 ms · 11.2 fps · 1.00 | 9 ms · 33.5 fps · 1.00 |
| Navigate across Europe (4 drags) | 556 ms · 0.9 fps · 0.47 | 411 ms · 3.0 fps · 1.00 | 8 ms · 9.1 fps · 1.00 | 12 ms · 31.6 fps · 1.00 |
| Unzoom button | 336 ms | 234 ms | 236 ms | 230 ms |
| Inspect → zoom to element | 376 ms | 548 ms | 476 ms | 410 ms |
| Return to the N tab | 408 ms | 350 ms | 360 ms | 355 ms |

Frame-time detail for the canvas proxy (the freeze after is the longest frame after the last input — the one-off bake of the live SVG):

| Scenario | p50 / p90 / max frame | picture updates /s | freeze after |
|---|---|---|---|
| Zoom-in burst | 33 / 50 / 58 ms | 27.4 | 408 ms |
| Zoom-out burst | 17 / 33 / 108 ms | 24.7 | 242 ms |
| Smooth zoom-in | 25 / 42 / 50 ms | 35.6 | 442 ms |
| Pan at full extent | 17 / 17 / 117 ms | 50.3 | 42 ms |
| Pan at region zoom | 33 / 50 / 200 ms | 19.7 | 150 ms |
| Pan at detail zoom | 17 / 33 / 183 ms | 31.7 | 100 ms |
| Navigate across Europe | 17 / 58 / 200 ms | 29.0 | 100 ms |

Reading the proxy results:

- **Responsiveness is solved**: the first frame of every gesture lands in
  9–30 ms (vs 400–800 ms), because nothing heavy happens at gesture start —
  no class toggle, no restyle, no culling; the stand-in is prebuilt on idle
  (268 items, ~50–120 ms, off any gesture).
- **Frame rate**: the canvas proxy runs 31–53 fps on zooms, full-extent pans
  and cross-Europe navigation, 34 fps at detail zoom; region-zoom pans are
  its weakest case at ~20 fps (the densest part of the network is stroked
  every frame once the overview cache no longer applies). The SVG proxy is
  competitive at full extent but drops to ~10 fps as soon as flows and
  labels are displayed on the live SVG behind it (document-wide
  layerization, see above) — the canvas variant is the one to build on.
- **Every gesture ends where the hand went** (`done` 1.00; 0.90 for zoom-in
  bursts is "complete" too: the prototype uses a symmetric `1.1^Δ` step,
  whose zoom-in notch is 0.909 instead of today's 0.9 reference).
- **What remains is the bake.** The single viewBox write on the live SVG at
  settle still costs ~0.25–0.45 s after a zoom (the longest frame after the
  last input: one full style / layout / paint of the live SVG at the new
  scale, flows and labels included), less after a pan. It no longer sits on
  the gesture's path — the proxy stays up until the live SVG has painted —
  but a new gesture started inside that window waits for it. Tier 3 in §6 is
  about that cost.
- Unzoom / Inspect / tab return are one-shot viewBox jumps or a tab switch:
  the proxy does not apply to them (yet), so they keep the default cost
  minus the quick wins.
- **Visual fidelity.** Screenshots of the live diagram (with the gesture's
  culling applied) and of the canvas proxy at the same viewBox, at full
  extent, region and detail zoom, show the same geometry and colours. The
  only differences were the paint order of the bus dots and the line caps;
  both were aligned with pypowsybl in `audit_prototype.patch` after the
  measurements (drawing order and caps only; not re-measured).

### 4.3 Software raster (VDI / remote desktop stand-in)

The June study kept the viewBox-repaint path as the default because a
CSS-transform layer re-rasterised catastrophically without a GPU. Same
scenarios with `--disable-gpu` (software raster + software compositing —
the VDI / remote-desktop / GPU-blocklisted case), median of 2 repetitions
(1 for the quick wins, SVG proxy and `bitmap`):

| Scenario | default | bugs + quick wins | `bitmap` mode | SVG proxy | canvas proxy |
|---|---|---|---|---|---|
| Zoom-in burst (16 notches) | 458 ms · 5.3 fps · 0.56 | 286 ms · 8.7 fps · 0.90 | 416 ms · 4.2 fps · 0.56 | 31 ms · 58.5 fps · 0.90 | 24 ms · 48.8 fps · 0.90 |
| Zoom-out burst (20 notches) | 440 ms · 6.8 fps · 0.55 | 324 ms · 5.9 fps · 1.00 | 455 ms · 7.7 fps · 0.55 | 24 ms · 20.3 fps · 1.00 | 26 ms · 43.5 fps · 1.00 |
| Smooth zoom-in (trackpad-like) | 444 ms · 4.3 fps · 0.54 | 268 ms · 8.0 fps · 0.90 | 392 ms · 4.8 fps · 0.50 | 34 ms · 42.9 fps · 0.90 | 20 ms · 42.3 fps · 0.90 |
| Notch-by-notch zoom (300 ms apart) | 419 ms · 4.4 fps · 0.92 | 223 ms · 11.6 fps · 0.90 | 829 ms · 6.6 fps · 1.00 | 20 ms · 57.5 fps · 0.90 | 34 ms · 52.8 fps · 0.90 |
| Pan at full extent | 394 ms · 3.8 fps · 0.70 | 186 ms · 8.8 fps · 1.00 | 402 ms · 3.6 fps · 0.76 | 8 ms · 38.0 fps · 1.00 | 6 ms · 53.5 fps · 1.00 |
| Pan at region zoom (~35 %) | 516 ms · 2.5 fps · 0.69 | 409 ms · 6.1 fps · 1.00 | 529 ms · 2.4 fps · 0.70 | 13 ms · 9.6 fps · 1.00 | 8 ms · 24.9 fps · 1.00 |
| Pan at detail zoom (~12 %) | 596 ms · 2.1 fps · 0.74 | 394 ms · 6.1 fps · 1.00 | 1443 ms · 1.2 fps · 0.75 | 10 ms · 11.4 fps · 1.00 | 8 ms · 43.3 fps · 1.00 |
| Navigate across Europe (4 drags) | 566 ms · 0.9 fps · 0.38 | 414 ms · 3.8 fps · 1.00 | 587 ms · 0.9 fps · 0.50 | 3 ms · 9.6 fps · 1.00 | 13 ms · 35.7 fps · 1.00 |
| Unzoom button | 345 ms | 213 ms | 352 ms | 217 ms | 228 ms |
| Inspect → zoom to element | 438 ms | 414 ms | 354 ms | 406 ms | 413 ms |
| Return to the N tab | 460 ms | 333 ms | 569 ms | 375 ms | 438 ms |

Reading:

- **The default path is no slower without a GPU** (zoom 4–7 fps, pans 1–4
  fps, 0.4–0.6 s to first feedback — the same as with hardware raster):
  the frame budget goes to main-thread style / layout / layerization, which
  software raster does not touch. That is the strongest evidence that raster
  is not the bottleneck on this class of machine.
- **The canvas proxy holds up without a GPU — it is even slightly faster**:
  42–49 fps on zooms, 54 fps at full extent, 43 fps at detail zoom, 36 fps
  across Europe, ~25 fps for region pans, 6–34 ms to first feedback. A
  Canvas 2D redraw of 268 grouped paths is cheap for Skia's CPU rasterizer,
  and with software compositing there is no GPU tessellation of long
  strokes. The concern that led June to reject compositing tricks for
  VDI sessions (re-rasterising a huge vector layer in software) does not
  apply: the canvas holds a few hundred paths, not the 99k-node diagram.
- The quick wins, the SVG proxy and `bitmap` behave in software as they do
  with the GPU (one repetition each, see the table).

### 4.4 Other levers

- **Tab switching — keep inactive tabs laid out (`tab-cv`, one repetition).**
  Inactive SVG tabs are `display: none`, so coming back to N re-attaches and
  re-lays out the 99k nodes: ≈ 425 ms by default, ≈ 350 ms with the quick
  wins. Hiding them with `content-visibility: hidden` instead (the subtree
  keeps its layout but is skipped by style / layout / paint while hidden)
  brings the return to N down to **150 ms**, with pans unaffected (5.9 vs
  6.3 fps). Caveat before shipping: inactive tabs keep their layout objects
  (memory), and this scenario only had the N diagram loaded — it must be
  re-measured with the N-1 and Action diagrams present (three ~99k-node
  trees), the case that motivated the June `display: none` change
  ([`history/svg-tab-unmount.md`](history/svg-tab-unmount.md)). Unlike
  `visibility: hidden`, `content-visibility: hidden` does not make every
  layout walk the hidden trees, so the June regression should not return —
  but that is to be verified, not assumed.
- **`text-rendering: geometricPrecision` on the flow `<text>`
  (`css-text-geo`, one repetition): no measurable effect.** The idea was
  that Blink would stop re-shaping the 15,706 flow values at every scale
  change; the post-zoom freeze stayed at 0.43–0.45 s and frame rates moved
  within run-to-run noise. Not recommended without a trace showing the
  text-layout cost actually goes away.
- **Rejected / not pursued.** The `gpu` and `bitmap` modes (above); removing
  `non-scaling-stroke` (the network vanishes at full extent, and it would
  only address part of RC1); geometry-count culling and `content-visibility`
  on SVG children (rejected in June; nothing here changes that analysis).

## 5. What the June study got right, and what it could not see

| June conclusion (M4 Pro, synthetic events) | Now (i7-13700H / Iris Xe, real input) |
|---|---|
| Per-frame cost is "pure SVG raster"; removing `non-scaling-stroke` is a no-op | On this machine the GPU process is busy ~10 % of a zoom gesture; the renderer main thread ~95 %, and turning the GPU off entirely (software raster) leaves the default path exactly as slow (§4.3). The cost is style + SVG layout + layerization — CPU-bound Blink work that scales with the node count. On a fast-CPU / strong-GPU Mac the balance shifts toward raster; on a mainstream Intel laptop like this one it does not. |
| Interaction culling: ~1.5–1.7× | True for the mid-gesture frame, but it moves cost to the gesture boundaries: the class toggle restyles every node and detaches up to ~63k nodes at start, re-attaches and re-lays out all text at the end (0.4–0.9 s each here) — which is where most of the time of a short gesture goes (§3). |
| GPU transform mode: 1.2–1.5×, rejected as default | Confirmed small (≤ 1.5×); the boundaries (RC3/RC4) and the drag selection (RC6d) dominate, not the transform. |
| Bitmap mode: ~3× in the real app (16.7 ms frames), 120 fps in isolation — the "big bet" | Not reproducible here: `createImageBitmap(svgBlob)` throws in Chrome 144, so the snapshot is decoded on the main thread through `new Image()` and gestures run on the slow fallback meanwhile: 0.4–3.1 s to first feedback in `bitmap` mode here. The frontend `CLAUDE.md` still describes the decode as off-thread. |
| Measurement lesson: interleave A/B passes (raster caches) | Still valid. Two more lessons from this audit: measure **gesture boundaries and outcome** (where the map ended up), not only the steady frame interval; and keep the probe O(1) — a `:scope > svg` query per frame cost ~10 ms on this DOM and had to be removed from the instrumentation. |

The zoom-adaptive halo width (`d6e7c19`, 2026-06-20) was added after the June
measurements and was never re-measured on the large grid: it adds ≈ 85–100 ms
of full-tree restyle to every zoom frame in the overview range (RC2), second
only to the SVG layout itself.

---

## 6. Recommendations (ranked)

### Tier 0 — correctness bugs: ship first (hours, no visual change)

| # | Fix | Where | Evidence |
|---|---|---|---|
| B1 | On `mouseup`, **apply** the pending drag delta instead of cancelling its rAF | `usePanZoom` `handleMouseUp` | RC6: lost drag ends (navigation `done` ≈ 0.5) |
| B2 | Honour the wheel **delta magnitude** (`1.1 ** (Δpx / notch)`, clamped, `deltaMode`-aware, notch size learnt from the device) | `usePanZoom` `handleWheel` | RC6b: zoom bursts reach 0.55 of the requested zoom; trackpads zoom 10 % per tiny event |
| B3 | Drag scale = `max(vb.w / W, vb.h / H)` — the `xMidYMid meet` letterbox | `usePanZoom` drag rAF | RC6c: the map slides 22 % slower than the cursor in a 1.62-aspect panel |
| B4 | Confirm the wheel settle on the next frame (no settle while queued wheel events are pending) | wheel debounce timer | RC5: culling flips mid-gesture; each flip costs a settle plus a new start (0.5–1 s) |
| B5 | `user-select: none` on `.svg-container` (or `preventDefault()` on the pan `mousedown`) | `App.css` / `usePanZoom` | RC6d: every drag runs the selection controller; drags over a selection can start drag-and-drop |

Each needs a unit test in `usePanZoom.test.tsx` (fake rAF / coalesced wheel
deltas / a letterboxed container) — they are exactly the cases the suite
does not cover today.

### Tier 1 — quick wins on the current rendering path (≈ 1 day)

| # | Fix | Effect measured (§4.1) |
|---|---|---|
| Q1 | Write `--nad-halo-w` on `#nad-background-layer` (seed it when the layer is created), not on the container | removes the ≈ 85–100 ms full-tree restyle per zoom frame above ratio 0.5 |
| Q2 | `.svg-interacting > svg { pointer-events: none }` (inherited) instead of `.svg-interacting svg * {…}` | the gesture-start restyle no longer matches every node |
| Q3 | Read CTM / bounding rect **before** toggling `.svg-interacting` (`handleWheel`, `beginInteraction`, `beginBitmapInteraction`) | no forced synchronous restyle inside input handlers |
| Q4 | Tier rules that match this pypowsybl's label DOM (`foreignObject.nad-text-nodes`, `.nad-text-edges`) at the overview tier | 5,247 unreadable HTML labels no longer laid out / painted at full extent; cheaper overview settles, tab switches and first display |
| Q5 | Correct the bitmap-mode docs/comments (decode is on the main thread in Chrome) and stop advertising it as the "big bet" | — |

Tier 0 + Tier 1 together are what §4.1 measures. Every gesture completes,
pans get ~2.5–3× and zooms ~2× more frames and the time to first feedback
roughly halves, but they **cannot** make the default path fluid: every frame
still re-lays out the whole SVG (RC1).

### Tier 2 — make gestures independent of the DOM size (days)

| # | Change | Effect measured (§4.2–4.3) |
|---|---|---|
| A1 | **Canvas gesture proxy** as the default renderer during pan / zoom (prototype `canvas` mode): grouped `Path2D` per class × grid cell, computed colours, overview cache, live SVG baked once on settle | first feedback 9–30 ms, 31–53 fps (≈ 20 fps for region-zoom pans), every gesture complete — §4.2 |
| A2 | Retire `bitmap` (main-thread decode, blank borders, blur) and `gpu` (no gain on Intel) once A1 lands | fewer code paths |
| A3 | Longer settle debounce on the proxy path (400 ms) so notch-by-notch zooming stays on the proxy; animated fly-to for Inspect / Unzoom on the proxy, one bake at the end | context kept at continental scale, no extra settles |
| A4 | Keep inactive SVG tabs laid out but unrendered (`content-visibility: hidden`) instead of `display: none` | return to the N tab 350 → 150 ms (§4.4); re-measure memory and frame cost with N-1 + Action loaded first |
| A5 | Move the canvas drawing to a Worker (`OffscreenCanvas`) if VDI sessions need more | gesture frames off the main thread entirely |

Implementation notes for A1: build the proxy on idle and on the existing
MutationObserver (highlight changes); rebuild on theme change and container
resize; keep it out of the bitmap / svgPatch pipelines (it reads the live
SVG, never writes it); hide it on tab switch / detach; the overview cache
must be rendered with stroke widths exact at full extent (strokes thicken
when the cache is magnified, hence the ~1.3× cap).

### Tier 3 — shrink what a settle has to lay out (larger, not prototyped)

After A1 the only remaining hitch is the single bake of the live SVG when the
gesture ends (≈ 0.25–0.45 s after a zoom here: one full style / layout /
paint of the live SVG at the new scale, flows and labels included). It is no
longer on the gesture's path, but a gesture started during it waits. These
items are proposals, not measured:

| # | Change |
|---|---|
| S1 | Viewport-limited flows and labels at region / detail zoom (display only the `.nad-edge-infos` groups and label boxes inside the viewport + margin, recomputed at settle — the old "Layer C", now cheap because it runs once per gesture) |
| S2 | Fewer transformed groups in the live SVG (bake the per-VL / per-flow `translate·scale` into coordinates at ingest): fewer paint chunks, cheaper layerization for every frame of every mode |
| S3 | Inspect query local to `InspectSearchField` (or `useDeferredValue`) so typing doesn't re-render the App on each keystroke |

---

## 7. Reproduce

Harness: `benchmarks/interaction_paint/audit_*`, documented in
[`benchmarks/interaction_paint/AUDIT_HARNESS.md`](../../benchmarks/interaction_paint/AUDIT_HARNESS.md).
Raw result files behind every table, and the per-stage breakdown of every
trace quoted here: `benchmarks/interaction_paint/audit_results/`.

```bash
# Serve a production build same-origin; config.json must point at the grid.
cd frontend && VITE_API_BASE_URL="" npx vite build && cd ..
COSTUDY4GRID_FRONTEND_DIST=$PWD/frontend/dist uvicorn expert_backend.main:app --port 8000

cd benchmarks/interaction_paint            # Node >= 22
node audit_drive.mjs --hw gpu --mode off --reps 2 --out off.json
node audit_drive.mjs --hw sw  --mode off --reps 2 --out off_sw.json
node audit_drive.mjs --hw gpu --mode off --scenarios zoom_in_burst --trace zoom_in_burst --out t.json
python3 audit_trace_breakdown.py t.zoom_in_burst.trace.json
python3 audit_summarize.py off.json off_sw.json
```

Prototypes: `git apply benchmarks/interaction_paint/audit_prototype.patch`
adds the experiment flags (`localStorage['cs4g-exp']`, comma separated:
`halo-bg`, `drag-flush`, `settle-confirm`, `ctm-first`, `wheel-delta`,
`drag-meet`, `settle400`, `proxy-layer`, `canvas-cache`, `tab-cv`) and the
`proxy` / `canvas` values of `cs4g-smooth-pan-zoom`; pass them with
`--exp` / `--mode`. The patch is **audit scaffolding, not a PR**: the flags
are read once at module load, the proxies have no unit tests, and the
`tab-cv` hunk targets `VisualizationPanel.tsx` as of 2026-11-15.

Caveats: headless Chrome on one laptop (60 Hz, dpr 1); absolute numbers move
with the CPU, the relative ordering held across every repetition. The driver
sends `deltaY = ±100` per notch; physical devices differ (per-notch deltas
vary by OS and mouse, trackpads send many small deltas), so a production B2
should normalise against the notch size actually observed rather than a
hard-coded 100.
