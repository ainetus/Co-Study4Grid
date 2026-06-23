# Separating co-located voltage levels in `grid_layout.json`

## The problem

PyPSA-EUR / OSM derived networks model a physical substation as **several
voltage-level (VL) buses** — e.g. a 400 kV and a 225 kV bus at the same site.
Each bus carries its own OSM coordinate, but the two are only tens of metres
apart, so in raw-Mercator layout space they land **~30–50 user units apart**.

Two rendering facts turn that into a visible defect on the Network Area
Diagram (NAD):

1. **Fixed VL-circle radius.** pypowsybl always draws the VL bus disk at
   `r = 27.5` user units, and the frontend
   ([`utils/svg/svgBoost.ts`](../../frontend/src/utils/svg/svgBoost.ts))
   *scales it up* on wide layouts so it is visible at the diagram's extent —
   on the continent-scale grids the boost reached **~110×**, a rendered
   diameter of ~6 040 units. Two buses 40 units apart therefore overlapped
   almost completely.

2. **Transformer glyph geometry.** pypowsybl draws the inter-voltage
   transformer as two winding circles placed at a *constant* ±50-unit offset
   from the edge midpoint. When the two VLs are ~40 units apart that offset is
   larger than the half-edge, so the windings are flung *outside* the bus
   pair and read as hollow "ghost" rings floating beside the substation. See
   the rendering forensics in the project history.

The net effect (before the fix): the two voltage levels of a substation looked
like a single blob with a stray ring next to it.

## The two-part fix

### 1. Cap the node boost (frontend)

[`svgBoost.ts`](../../frontend/src/utils/svg/svgBoost.ts) `NODE_BOOST_CEILING`
was lowered **250 → 60**.

- The continent-scale layouts (`eur*`) computed a ~110× boost **purely because
  their viewBox is ~3× wider** than the France grids, while the physical
  substation spacing is unchanged. That blew the disks up past the median
  inter-substation distance, so even *adjacent* stations merged.
- `60` is the largest boost we have confirmed legible — the value
  `fr225_400` already computes. Capping there:
  - leaves **every France grid untouched** (`fr225_400` ≈ 59.7, `fr400` is
    < 500 VLs so boost is off at 1.0 — both ≤ 60);
  - halves the European disks to a **~3 280-unit diameter**.

### 2. Separate the buses (layout)

[`scripts/pypsa_eur/separate_voltage_levels.py`](../../scripts/pypsa_eur/separate_voltage_levels.py)
post-processes `grid_layout.json`:

- the **highest-voltage** VL of each substation keeps its position (the anchor);
- every **lower-voltage** VL is pushed into the substation's neighbourhood by
  `--separation` units, in the **largest open angular gap** between the
  incident transmission lines (so the move clears existing lines), **biased
  toward the side that level's own lines run** (so they fan out instead of
  wrapping back over the anchor);
- two displaced levels of one substation are kept ≥ one boosted diameter apart
  from **each other** too (a minimum-angle guarantee for 3-level stations).

**The separation is derived per network, not hardcoded.** `separate_voltage_levels.py`
mirrors the `svgBoost.ts` node-boost math (`frontend_node_boost`) to compute the
on-screen disk diameter for the target layout, then separates by
`diameter × 1.3` (one diameter + 30 % visible gap). So a continent-scale grid
gets ~4 290 units, the France 225/400 grid ~4 266, and a boost-off grid would
get just over one *native* diameter. `--separation N` overrides the auto value.

> **Keep in sync:** `BOOST_CEILING` and the boost constants in
> `separate_voltage_levels.py` mirror `NODE_BOOST_CEILING` (and the rest of the
> formula) in `svgBoost.ts`. If you change the frontend boost, the separation
> auto-tracks it — but the mirrored constants must be updated together.

## Results

Run against every multi-voltage PyPSA-EUR layout:

| Network | VLs | boost (→ disk Ø) | sep | moved | min intra-station VL dist (before → after) |
|---|---:|---|---:|---:|---|
| `pypsa_eur_eur220_225_380_400` | 5247 | 60 (3300) | 4290 | 666 | 34 → 4213 |
| `pypsa_eur_eur380_400` | 1922 | 60 (3300) | 4290 | 27 | ~45 → 4290 |
| `pypsa_eur_fr225_400` | 1196 | 60 (3281) | 4266 | 129 | ~40 → 4266 |
| `pypsa_eur_fr400` | 190 | 1.0 (off) | — | 0 | single-voltage — nothing to separate |

In every case the global geography is preserved (only co-located buses move;
the median nearest-neighbour distance is unchanged) and **zero** VL pairs
remain closer than one boosted disk diameter.

## Usage

```bash
# Auto separation (recommended): scaled to the layout's boosted disk size.
python scripts/pypsa_eur/separate_voltage_levels.py --network data/pypsa_eur_fr225_400

# Preview without writing:
python scripts/pypsa_eur/separate_voltage_levels.py --network data/pypsa_eur_fr225_400 --dry-run

# Manual override (e.g. if you raised the boost ceiling):
python scripts/pypsa_eur/separate_voltage_levels.py --network <dir> --separation 6000
```

The script writes a one-time backup `grid_layout.json.bak.coloc` (the original
co-located positions) unless `--no-backup` is passed.

> **Pipeline order.** `regenerate_grid_layout.py` rewrites `grid_layout.json`
> from the raw OSM coordinates and therefore *re-collocates* the buses. Always
> run `separate_voltage_levels.py` **after** any layout regeneration. See
> [`grid-layout-coordinate-scale.md`](grid-layout-coordinate-scale.md) for the
> coordinate-scale contract the regeneration must honour first.

## Tests

- `scripts/pypsa_eur/test_separate_voltage_levels.py` — pure-geometry unit
  tests: angular gaps, placement directions (distinct + min-angle), the
  `frontend_node_boost` mirror (small/dense/France/European/ceiling cases),
  `auto_separation` scaling, and an end-to-end `separate_layout` check that the
  anchor stays put and the lower level clears one boosted diameter.
- `frontend/src/utils/svg/svgBoost.test.ts` — guards the `60×` ceiling
  (European clamp, ceiling on enormous grids, density-suppress passthrough).

## Cross-references

- [`frontend/src/utils/svg/svgBoost.ts`](../../frontend/src/utils/svg/svgBoost.ts) — node-boost math + the `60×` ceiling.
- [`scripts/pypsa_eur/separate_voltage_levels.py`](../../scripts/pypsa_eur/separate_voltage_levels.py) — the separation script (module docstring carries the same summary).
- [`grid-layout-coordinate-scale.md`](grid-layout-coordinate-scale.md) — why the layout must be raw Mercator metres in the first place.
