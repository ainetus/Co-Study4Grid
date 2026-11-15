# Real-app interaction audit harness (2026-11)

The `audit_*` files drive the **real app** (production build) through
Chrome's input pipeline and measure what the operator feels: time to the
first visual response, frame cadence, whether the map ends where the hand
went, and the freeze after the gesture. Findings and numbers:
[`docs/performance/large-grid-interaction-audit-2026-11.md`](../../docs/performance/large-grid-interaction-audit-2026-11.md).

| File | Role |
|---|---|
| `audit_drive.mjs` | Launches Chrome, clicks **Load Study**, opens the N tab, replays the scenario suite with `Input.dispatchMouseEvent` (fixed-clock input stream, no per-event await), optional Chrome trace of one scenario |
| `audit_instrument.js` | Injected before the app boots: per-frame rAF timestamps + visible diagram state, delivered input events, Long-Animation-Frame entries |
| `audit_exp_css.js` | CSS A/B flags applied by **deleting / replacing** rules in the live App.css sheet (so the selector-invalidation cost really disappears) |
| `audit_trace_breakdown.py` | Self time per pipeline stage on the renderer main thread, busy time of the other threads, per-frame split |
| `audit_summarize.py` | Median-over-reps table per scenario from one or more result files |
| `audit_results/` | The raw result files the audit tables were built from |
| `audit_prototype.patch` | Scratch prototypes measured by the audit (experiment flags, `proxy` / `canvas` gesture modes) — audit scaffolding, not a PR |

```bash
# 1. Serve a production build same-origin (from the repo root):
cd frontend && VITE_API_BASE_URL="" npx vite build && cd ..
COSTUDY4GRID_FRONTEND_DIST=$PWD/frontend/dist uvicorn expert_backend.main:app --port 8000
#    (config.json must point at the grid under test — e.g. the full
#     European pypsa_eur_eur220_225_380_400 bundle)

# 2. Run the suite (Node >= 22 for the global WebSocket):
cd benchmarks/interaction_paint
node audit_drive.mjs --hw gpu --mode off --reps 2 --out off.json
node audit_drive.mjs --hw sw  --mode off --reps 2 --out off_sw.json      # software raster (VDI stand-in)
node audit_drive.mjs --hw gpu --mode off --exp css-ptr-root,css-labels-tier --out css.json
node audit_drive.mjs --hw gpu --mode off --scenarios zoom_in_burst --trace zoom_in_burst --out t.json
python3 audit_trace_breakdown.py t.zoom_in_burst.trace.json
python3 audit_summarize.py off.json off_sw.json css.json
```

`--hw gpu` launches headless Chrome with `--use-angle=gl --enable-gpu
--ignore-gpu-blocklist` (hardware raster + GPU compositing; check the `gpu`
field of the result file), `--hw sw` adds `--disable-gpu`. `--mode` sets the
`cs4g-smooth-pan-zoom` preference (`off` / `gpu` / `bitmap` / `canvas`;
`canvas` is the production gesture proxy since 2026-11-15, see the audit's
§8). The JS experiment flags (`halo-bg`, `drag-flush`, `settle-confirm`,
`ctm-first`, `wheel-delta`, `drag-meet`, `settle400`) and the `proxy` mode
only exist in a build with `audit_prototype.patch` applied (on the commit the
audit was written against).

A canvas-mode "visual update" is a proxy frame: each one starts with a
background `fillRect` on `canvas.nad-canvas-proxy`, which the instrumentation
counts. Since a drag only starts the proxy once the pointer travels, "first
frame" is the first *moved* frame on that path, and "catch-up" includes the
deliberate 400 ms settle pause before the live SVG is baked. Wheel "done" assumes the symmetric
1.1-per-notch zoom shipped with that change; the audit's §2–§4 tables were
computed against the old 0.9-per-notch zoom-in.
