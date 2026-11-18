# Grid-layout coordinate scale

> **TL;DR**: `grid_layout.json` MUST be in raw Mercator metres (span ≈ 1.4–1.6 M for the French grid). Pypowsybl emits VL outer circles at a *fixed* `r = 27.5` user-space units; if the layout span gets squashed to e.g. 8 000, then 27.5 stops being negligible and every neighbour overlaps the rendered circle. This document explains the math and records the 2026-05-08 fix.

## Symptom

On `pypsa_eur_fr225_400` the Network (N) tab rendered as an unreadable dark blob in dense urban regions (Paris, Lyon, Lille). VL circles visibly overlapped one another even at maximum zoom-in. Branch lines, flow arrows, and labels were all crammed inside the blob. Frontend SVG post-processing (svgBoost) could mitigate but never fully clear the overlap.

## Diagnosis

Pypowsybl's NAD generator (powsybl-network-area-diagram) emits each VL bus node as a `<circle r="27.5">` in **user-space SVG coordinates**, regardless of the surrounding layout scale. Other glyph sizes are similarly fixed (line stroke 5, arrow 10×10, edge-info font 20). The viewBox→screen transform applies uniformly to all of them, so the *relative* size of nodes vs inter-node distance is determined entirely by the on-disk coordinate scale.

We compared two layout files for the French grid:

| Layout                                  | Source                       | Entries | x-span (units) | Median nearest-neighbour | Median NN ÷ r=27.5 |
|-----------------------------------------|------------------------------|---------|----------------|--------------------------|--------------------|
| Operator reference (RTE study format)   | Internal RTE export          | 18 141  | 1 643 372      | 1 776                    | **64.6 ×**         |
| Pre-fix `regenerate_grid_layout.py`     | OSM → Mercator, `÷ 8000/x_range`| 1 196 | 8 000          | 26                       | **0.95 ×**         |

A median NN of 0.95 × r means *adjacent VL circles overlap by definition* — the circle's diameter is roughly the distance between its centre and the next centre over. There is no clipping, alpha, or zoom tweak that can recover whitespace from this geometry.

The operator file's 65 × ratio is comfortable: the next neighbour sits 65 r away, leaving > 100 × visual whitespace per node. That is the geometry pypowsybl was designed for.

## Where the rescale came from

`scripts/pypsa_eur/regenerate_grid_layout.py` (originally cribbed from Step 9 of `convert_pypsa_to_xiidm.py`) projected raw `(lon, lat)` to Web Mercator, then rescaled every coordinate by `8000 / (max_x − min_x)` to fit a fixed 8 000-unit target width. The constant `TARGET_WIDTH = 8000` was inherited from the conversion pipeline. It made smaller test grids look "right-sized" at hand-curated `viewBox`es but broke for any production-scale dataset.

> **D8 (2026-07-09):** the *source* of the constant — `convert_pypsa_to_xiidm.py`'s `step_write_metadata` — still carried the same `TARGET_WIDTH = 8_000` rescale, so a pipeline rebuild silently re-emitted the forbidden layout. It now writes `grid_layout.json` in raw Mercator metres directly (re-centred, no rescale), matching `regenerate_grid_layout.py`'s default. `test_grid_layout.py::test_coordinate_spans_in_reasonable_range` was corrected from the stale `[5000, 20000]` assertion (which encoded the forbidden scale) to the raw-metres regime.

## Fix (2026-05-08)

`regenerate_grid_layout.py`:

* Default behaviour now **writes raw Mercator metres** (centred on the bounding-box midpoint). For the French grid this gives `x_span ≈ 1.4 M`, matching the operator reference scale.
* The `--target-width N` flag is preserved for backward compatibility but defaults to `None`. When set below 500 000 the script logs a warning explaining the readability-vs-rescale trade-off.
* The regeneration prints a `median NN / r` ratio at the end so you can see at a glance whether the output will read cleanly.

Both bundled layouts were regenerated:

| Bundle                         | Old span  | New span         | Old median NN/r | New median NN/r |
|--------------------------------|-----------|------------------|-----------------|-----------------|
| `data/pypsa_eur_fr225_400/`    | 8 000     | 1 401 015        | 0.95 ×          | **166.8 ×**     |
| `data/pypsa_eur_fr400/`        | 8 000     | 1 307 946        | varied          | **1 090 ×**     |

(The fr400 ratio is unusually high because that dataset only carries 400 kV transmission VLs — 190 entries spread across the same physical area — so neighbours are kilometres apart.)

The pre-fix files are kept as `grid_layout.json.bak.8000width` siblings so the rescale can be reverted with a single `cp` if a downstream consumer turns out to depend on the old span.

## How to regenerate

```bash
# Default (recommended): raw Mercator metres
python scripts/pypsa_eur/regenerate_grid_layout.py --network data/pypsa_eur_fr225_400

# Legacy: rescale to 8 000-unit width (NOT recommended for dense grids)
python scripts/pypsa_eur/regenerate_grid_layout.py --network data/pypsa_eur_fr225_400 --target-width 8000
```

## Regression guards

* `scripts/pypsa_eur/test_regenerate_grid_layout.py::TestCoordinateSanity::test_x_span_matches_france_mercator` asserts the on-disk span is in the operator-clean range [1.3 M, 1.7 M].
* The test docstring explains the failure mode if someone reverts the script.

## Why this also retires the svgBoost band-aids

The branch's earlier work (`utils/svg/svgBoost.ts`) added several frontend SVG transforms — node-circle shrinking, edge-info downscale, polyline kink-drop, line-extension to the new circle edge, and flow-indicator projection. All of them were trying to compensate for the squashed coordinate scale. With the layout fixed at the source, those transforms are no-ops on the operator-clean default (median NN/r = 65–166 ×, well above the threshold the boost code triggers on). The boost code can stay as a safety net for any caller that *intentionally* uses a small `--target-width`, but the canonical path no longer needs it.

## Voltage levels the layout misses (2026-11)

A layout is drawn for one version of the network, and the network keeps
changing. The 2024 RTE operator layout (`bare_env_20240828T0100Z`, 18 141
entries) misses 60 of the 5 888 voltage levels of a 2026-05-06 France
snapshot.

### What pypowsybl does with them

Given `fixed_positions` that skip a voltage level, the GEOGRAPHICAL NAD
layout places it itself, on its own scale. On that snapshot 56 of them
landed ~1.4 M units away from the grid (y ≈ −0.21 … −0.25 M, against −1.6 … −2.9 M
for the grid), one (HURTEP1) near the origin, and three isolated ones
(CORB7P1, E.HUCP1, F.BISP1) at NaN. One NaN node is enough to make
pypowsybl's bounding box NaN: the root `<svg>` comes out with
`width="NaN" height="NaN" viewBox="NaN NaN NaN NaN"`. The metadata JSON
still lists that node, at (0, 0). `_strip_nan_elements` removed the NaN
elements but could not remove the root.

In the frontend, the NaN viewBox gave a NaN diagram size to `svgBoost`, so
no node boost (microscopic substations) and `NaNpx` VL fonts; a NaN halo
width (`computeHaloWidthPx`), so `--nad-halo-w` became invalid and the
overload / action halos vanished; and a zoom to a voltage level (a VL chip
on an action card) centred on the wrong substation.

### Fix — three layers

1. **Layout completion** (`expert_backend/services/diagram/layout_completion.py`,
   called by `DiagramMixin._load_layout_for`). Before pypowsybl sees the
   layout, each missing voltage level gets a position on the layout's own
   scale: the mean of its positioned same-substation voltage levels, else
   of its positioned electrical neighbours (lines, 2- and 3-winding
   transformers, tie lines, HVDC lines), plus a deterministic offset (angle
   from a CRC32 of the id, radius 0.1 % of the grid's extent: ~1 600 units
   on the RTE layout) so no two voltage levels share a position. Passes
   repeat while they place something, so a chain of new voltage levels
   hangs off the grid one hop at a time. Isolated voltage levels are parked
   inside the bottom-left corner of the grid's extent, two radii apart. A
   layout row with a non-finite coordinate counts as missing. The result is
   cached on `_completed_layout_cache`, keyed by the layout frame (one per
   file path + mtime) and a network fingerprint (network id + voltage-level
   ids), so the per-worker network copies the action diagrams are drawn on
   share one entry; `reset()` clears it. On the snapshot: 23 placed by
   substation, 33 by neighbours, 4 isolated parked; 79 ms once, then ~5 ms
   per diagram for the fingerprint. The root viewBox comes out finite,
   `-137870 -2916920 1643872 1304459`.
2. **Root repair** (`nad_render._strip_nan_elements` → `_repair_root_size`).
   When the root still carries NaN — a network drawn without a layout, or a
   node the completion could not help — its `viewBox` / `width` / `height`
   are recomputed the way pypowsybl computes them: the bounding box of the
   metadata nodes and their text nodes (node + shift), leaving out the nodes
   whose SVG element was stripped (their metadata says (0, 0)), padded by
   `svgParameters.diagramPadding` and sized by its `sizeConstraint`. On a
   finite diagram this matches pypowsybl's own root to the metadata's 0.01
   rounding.
3. **Frontend safety net** (`frontend/src/utils/svg/svgBoost.ts`,
   `frontend/src/hooks/usePanZoom.ts`). `parseViewBox` rejects a viewBox
   with a non-finite field or a non-positive size; `processSvg` then falls
   back to the content extent (the voltage-level node translations, padded
   by 200), writes it on the root and drops a NaN `width` / `height`. The
   boost skips a non-finite diagram size, and `computeHaloWidthPx` returns
   the thin width for a non-finite zoom ratio.

Still stripped, and unrelated to completion: a branch between two voltage
levels that the layout itself puts at the very same position is a
zero-length edge, which pypowsybl draws with NaN coordinates (8 lines and
transformers on the snapshot).

Regression guards: `expert_backend/tests/test_layout_completion.py`
(including a real-pypowsybl IEEE 14 drawing), `TestNanRootRepair` in
`expert_backend/tests/test_diagram_helpers.py` (checked against pypowsybl's
own root), `TestLoadLayoutFor` in `expert_backend/tests/test_diagram_mixin.py`,
the "non-finite root viewBox" block of
`frontend/src/utils/svg/svgBoost.test.ts` and the `computeHaloWidthPx`
block of `frontend/src/hooks/usePanZoom.test.tsx`.

## Cross-references

* `scripts/pypsa_eur/regenerate_grid_layout.py` — module docstring carries the same math summary.
* `CHANGELOG.md` — `[Unreleased]` "Fixed" section.
* `frontend/src/utils/svg/svgBoost.ts` — frontend mitigations that the layout fix retires.
* [`voltage-level-separation.md`](voltage-level-separation.md) — the follow-on fix for substations whose **several voltage levels** share one location; run `separate_voltage_levels.py` *after* any regeneration here.
