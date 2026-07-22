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

## Cross-references

* `scripts/pypsa_eur/regenerate_grid_layout.py` — module docstring carries the same math summary.
* `CHANGELOG.md` — `[Unreleased]` "Fixed" section.
* `frontend/src/utils/svg/svgBoost.ts` — frontend mitigations that the layout fix retires.
* [`voltage-level-separation.md`](voltage-level-separation.md) — the follow-on fix for substations whose **several voltage levels** share one location; run `separate_voltage_levels.py` *after* any regeneration here.
