# Real-app interaction audit harness (2026-11)

The `audit_*` files drive the **real app** (production build) through
Chrome's input pipeline and measure what the operator feels: time to the
first visual response, frame cadence, whether the map ends where the hand
went, and the freeze after the gesture. Findings and numbers:
[`docs/performance/large-grid-interaction-audit-2026-11.md`](../../docs/performance/large-grid-interaction-audit-2026-11.md);
the canvas gesture proxy that came out of it (the default pan/zoom mode) is
documented, with its time budget and the probes below, in
[`docs/performance/canvas-gesture-proxy.md`](../../docs/performance/canvas-gesture-proxy.md).

| File | Role |
|---|---|
| `audit_drive.mjs` | Launches Chrome, clicks **Load Study**, opens the N tab, replays the scenario suite with `Input.dispatchMouseEvent` (fixed-clock input stream, no per-event await), optional Chrome trace of one scenario |
| `audit_instrument.js` | Injected before the app boots: per-frame rAF timestamps + visible diagram state, delivered input events, Long-Animation-Frame entries |
| `audit_exp_css.js` | CSS A/B flags applied by **deleting / replacing** rules in the live App.css sheet (so the selector-invalidation cost really disappears) |
| `audit_trace_breakdown.py` | Self time per pipeline stage on the renderer main thread, busy time of the other threads, per-frame split |
| `audit_summarize.py` | Median-over-reps table per scenario from one or more result files |
| `audit_compact.py` | One row per scenario, one column per run (`label=file.json …`): *first feedback · fps · done*, jumps as input → painted |
| `audit_probe.mjs` | Targeted probes on a kept session: style flips on the proxy canvas, hit tests at a drag start / in a wheel burst, rebuild timing around an Inspect jump, a drag in a detached window, composited layers |
| `audit_results/` | The raw result files the audit tables were built from (see *Result files* below) |
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
`canvas` is the production gesture proxy, the app's default since
2026-11-15). `--url` points at the app (default `http://127.0.0.1:8000/`):
serve the build under test on its own port and pass it, rather than
measuring whatever backend is running on :8000. The JS experiment flags (`halo-bg`, `drag-flush`, `settle-confirm`,
`ctm-first`, `wheel-delta`, `drag-meet`, `settle400`) and the `proxy` mode
only exist in a build with `audit_prototype.patch` applied (on the commit the
audit was written against).

A canvas-mode "visual update" is a proxy frame: each one starts with a
background `fillRect` on `canvas.nad-canvas-proxy`, which the instrumentation
counts. Since a drag only starts the proxy once the pointer travels, "first
frame" is the first *moved* frame on that path, and "catch-up" includes the
deliberate 400 ms settle pause before the live SVG is baked. Wheel "done"
assumes the symmetric 1.1-per-notch zoom shipped with that change; the
audit's §2–§4 tables were computed against the old 0.9-per-notch zoom-in.

## Probes (kept session)

```bash
# Keep the app loaded in headless Chrome (CDP on :9351) after the run:
DETACH=1 node audit_drive.mjs --url http://127.0.0.1:8001/ --hw gpu --mode canvas --scenarios none --keep 1 --port 9351 --out session.json
node audit_probe.mjs flip         # cost of each style change on the proxy canvas (--display adds the 3 s toggle)
node audit_probe.mjs drag-hits    # hit tests at a drag start: as built / capture on pointerdown / preventDefault
node audit_probe.mjs wheel-hits   # hit tests in a 12-notch burst: click-through vs hit-testable canvas
node audit_probe.mjs rebuild      # proxy rebuild vs an Inspect jump; SVG mutations per jump
node audit_probe.mjs detached     # a canvas-mode drag in a detached window
node audit_probe.mjs layers       # composited layers before / during a gesture
node audit_probe.mjs reveal       # when labels / flow values are on screen after a gesture (--trace: the bake's split)
node audit_probe.mjs fidelity --out-dir shots   # proxy frame vs settled live SVG, pixel diff + PNGs
```

`reveal` zooms to region / detail / reading zoom (and drags at reading
zoom) and times, from the last input: the last proxy frame (and whether it
drew the text), the settle (live viewBox written), the canvas clear, and the
first frame after it — when the live SVG is on screen, since the clear's
commit waits for the bake's re-raster. `fidelity` takes a screenshot of the
settled diagram, then one of the proxy at the same view (press, 1 px out and
back, screenshot, then a real move before the release: a release where the
press was is a click, and a click on a label opens its SLD over the diagram).

The `pan_deep` and `zoom_in_deep` scenarios work at reading zoom (~4 % of
the extent: labels and flow values ~10 px), where the proxy draws text.

The probes inject styles and listeners and remove them; restart the session
for a clean state between runs. Reference outputs (2026-11-15) are in
`canvas-gesture-proxy.md` §8. Stop the session's Chrome when done (it keeps
running detached).

## Result files

| Files | What |
|---|---|
| `exp*_*.json`, `base_*.json`, `check_*.json`, `trace_breakdowns.txt` | The audit runs (§2–§4), on the audited tree and the prototype patch |
| `canvas_step1_display_toggle.json` … `canvas_step5_{gpu,sw}.json` | The production canvas mode, one file per fix (audit §8, reference doc §2 "How it got there"); steps 1–3 counted the proxy appearing on `mousedown` as the first update |
| `canvas_trace_breakdowns.txt` | Trace breakdowns of steps 1–4 (the display-toggle stall, the opacity flip, will-change, the final design) |
| `final_gpu_off.json`, `final2_gpu_canvas.json`, `final2_sw_canvas.json` | The final matrix: classic path with the gesture fixes, canvas GPU, canvas software raster |
| `jumps_main_off.json`, `jumps_branch_off.json`, `jumps_branch_canvas.json` | Unzoom / Inspect measured back to back on `main` and on the branch (classic, canvas) |
| `text_il_main.json`, `text_il_branch.json` | Flow values and labels on the proxy (reference doc §2, §3.4): the interleaved A/B against `main`, one result per run |
| `text_reveal.txt`, `text_fidelity.md`, `text_on_proxy_reading_zoom.png` | The `reveal` and `fidelity` probes on both builds (and the intermediate variants), the side-by-side frames at reading zoom |

## Pitfalls

- **Machine load drifts** (an operator backend, other sessions): jump timings
  moved 100–200 ms between a morning and an afternoon run. Compare variants
  back to back in one sitting.
- **Fresh git worktrees hold Git LFS pointers** for `*.zip`: the European
  `network.xiidm.zip` is then 132 bytes. Point the config at a checkout with
  the real files, or run `git lfs pull`.
- **Traces are 10–40 MB per gesture**: trace one scenario at a time.
- **Interleave A/B runs when the load moves.** On a busy evening two
  back-to-back blocks of the same build moved by 10–30 %: keep a session per
  build (two backends, two `--port`s) and alternate them scenario by scenario
  with `--attach 1 --keep 1 --scenarios <one> --reps 1`, flipping the order
  every repetition.
- **A region-zoom pan can start inside the previous bake's re-raster**
  (~1–1.4 s on the Iris Xe under load): the harness waits 1.2 s after the
  pre-zoom, and the interval the raster blocked counts as the gesture's first
  frame (a 0.7–1.1 s "max frame", fps down to 15–18). It hits every build
  alike — compare A/B runs made back to back.
- **`pkill -f '--remote-debugging-port=…'` kills its own shell** (the pattern
  is in its command line): use `pkill -f '[r]emote-debugging-port=9351'`.
