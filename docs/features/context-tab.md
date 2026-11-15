# Context tab — the situation map

The **Context** tab is the leftmost visualization tab. It shows the loaded
study as a *situation map* in the style of **Carte-Front** (the congestion-front
map built in another package): production mix and consumption per zone, the
transfers between zones and the exchanges with neighbouring countries — without
the congestion-front layer. Its code is **ported** into Co-Study4Grid: there is
no dependency on Carte-Front nor on `xiidm_snapshot_io`.

It opens first after every study load because it is **much faster than the
state diagrams**: on the 7 000-node French grid (PtFige + RTE op4grid layout)
the map shows **~2.7 s** after *Load Study*, while the N-state NAD lands at
~16 s.

Once a contingency is set and its overloads identified, the map draws them in
Co-Study's halo colours — **yellow** (`--signal-contingency`) for the
contingency, **orange** (`--signal-overload`) for the overloads — so both read
the same way as on the N-1 diagram. A contingency and an overload on twin
circuits (the same two substations) would cover each other: such lines are
drawn side by side, leaving and rejoining their shared substations
(`separateCoincident` in `contextMapGeometry.ts`), the contingency in the
middle and on top. On the N-1 diagram the contingency halo is the widest and
lies beneath the others, so an overload halo on its twin leaves a yellow band
visible.

## Prerequisite — when the tab appears

A situation map compares zones on the ground. The tab appears only when the
network places **at least two zones** on the European basemap
(`builder.MIN_ZONES`):

- its substations carry their **country** (IIDM `country`, ISO code) — a grid
  spanning countries (the pan-European PyPSA grid: 29 countries); or
- in France, its substations carry their **RTE region** (`regionCvg`
  property — a *PtFige*, the France THT game grids: 12 regions).

A network that cannot (no country codes — `bare_env_small_grid_test`; a
single zone — a France-only grid without regions such as `pypsa_eur_fr225_400`
or the France EHV Matpower cases) gets no Context tab: `GET /api/context-map`
answers `{"available": false, "unavailable_reason": "…"}`, the frontend hides
the tab (and leaves it if it was open), and the sidebar **Notices** pill says
why (*No Context tab for this network*). While a study loads, the tab shows
*Loading the situation map…* until the backend has answered.

The rest is optional: flows in the file draw the transfers (else a warning),
generation types (`genreCvg`, a `carrier` tag, else `energySource`) the mix,
a `substationPosition` extension or the study's `grid_layout.json` the exact
place of the studied elements (else they are drawn between their zones).

## A contingency opens here first

When the operator commits a contingency and the study has a Context tab
(`useContingencyFetch`, `contextFirst`):

1. the **Context** tab opens — not the N-1 tab — with the contingency in
   yellow, framed automatically (`ContextMapView`: unless the operator moved
   the map since);
2. once the N-1 computation names the overloads, they appear in orange with
   their **loading after the contingency written beside each line** (an orange
   pill, e.g. *112 %*, placed clear of its line). Hovering the pill names the
   line and gives its loading before → after the contingency, and the
   threshold it is judged against (the monitoring factor: a line counts as
   overloaded from 95 % of its limit by default); the sidebar's percentages
   tell the same before → after on hover. The map frames them with the
   contingency;
3. the **N-1 tab glows** (a pulsing orange halo, `.tab-attention` in
   `App.css`; static under `prefers-reduced-motion`) to invite the next step,
   until the operator opens it (`useDiagrams.n1Attention`).

Without a Context tab the contingency opens on the N-1 tab, as before. A
reloaded session keeps its own tab.

## What is drawn

| Layer | Carte-Front source | Notes |
|-------|--------------------|-------|
| Basemap | `geometry.load_geometries` + `europe_neighbors.geojson` | Natural Earth outlines (public domain): Carte-Front's 50 m polygons for France and its ten neighbours, 110 m for the rest of Europe. Countries present in the study are drawn in the pale "home" fill, the others dark. |
| Pies | `camemberts._draw_pies` | Area ∝ production (`_PROD_REF_MW = 19 000`, 0.5–1.5 in diameter), sliced by generation type in `FILIERE_COLORS` order, from the top, clockwise. |
| Consumption ring | idem | Dashed violet ring on the same area scale — it overflows the pie of a net importer. |
| Zone label | idem | Name, production, consumption (violet); side per region (`REGION_LABEL_SIDE`). |
| Inter-zone arrows | `fleches._draw_inter_region_flows` | Blue, width ∝ √(MW / max), `arc3` curvature (`INTER_REGION_RAD`), stopped at the pie edge. |
| Border arrows | `fleches._draw_country_region_flows` | Dashed, teal (export) / orange (import), region ↔ neighbour anchor (`COUNTRY_BOX`). |
| Neighbour badges | `etiquettes._label_box` | "Exports / Imports / Balanced" + the home country's net exchange with that neighbour. |
| Nuclear units | `couches._draw_nuclear` | One dot per unit on a small ring around its plant, filled by output level (amber → orange-red ramp), hollow when stopped (< 1 MW); dashed outline per plant, hover for its units. Hideable from the legend. |
| Highlights | — (Co-Study) | Contingency + overloads, dark casing under the signal colour, each overload's loading in an orange pill beside its line, an attention ring around them, auto-framing and a *Zoom to contingency* button. |

Every drawn transfer carries its value. On the country mesh the value sits
halfway along the visible arrow (two close countries would otherwise put it
under a pie), and a dense map (> 12 pies) writes it smaller.

Symbols are sized in Carte-Front **points** on its 649-pt map axes
(`utils/contextMapGeometry.ts`) and keep that size on screen as the operator
zooms (wheel / drag / double-click to reset), like Carte-Front's zoomed views.

The **situation card** sits top-left: case date, production with the national
**mix bar** (one segment per generation type, its share written on it from 7 %
up, MW on hover), consumption and net exports; the contingency card stacks
under it. The **legend** sits bottom-left (Carte-Front's production legend):
generation-type colours, consumption ring, arrows, nuclear units.

## Mesh: regions, else countries

`services/context_map/aggregate.build_zoning`:

- **Region mesh** when (most) French substations carry the IIDM property
  `regionCvg` (the Convergence region, as in a *PtFige*): a French substation
  belongs to its region, a foreign one to its **country** (its own
  `regionCvg`, e.g. `ESPAGNE`, is ignored — Carte-Front's rule). The seven RTE
  regions sit at their pivot city (`REGION_POS`, with the `REGION_PIE_POS`
  tweaks); neighbours become badges. Transfers between two foreign countries
  are not drawn.
- **Country mesh** otherwise — e.g. a European PyPSA-EUR grid: every
  substation in its country, each country a pie at its mainland centroid.

Per zone (`aggregate.production_and_consumption`, `zone_transfers`):

- **production** by generation type: `genreCvg` (NUCLEAIRE, GAZ, CHARBON,
  FIOUL, TURBINAGE, POMPAGE, EOLIEN, PHOTOVOLTAIQUE — plus the reconstructed
  RTE7000 spellings FUEL → oil, CCG → gas, STEP → storage, AUTRE → other),
  else the IIDM `energySource` (NUCLEAR, THERMAL → gas, HYDRO, WIND, SOLAR),
  else *other*. A network with no typed generator at all gets no mix bar
  ("Generation types are not given in this network") and grey pies;
  `p` (IIDM sign: production < 0), falling back on `target_p`;
- **consumption**: loads `p` (else `p0`), plus generators drawing power (pumps);
- **transfers**: every branch whose ends lie in two zones — lines,
  two-winding transformers, tie lines, HVDC (converter stations' AC-side `p`)
  — contributes `(p1 − p2) / 2` (losses cancel); summed per zone pair,
  oriented, kept above 1 MW (`_SEUIL_MW`).

## Nuclear units

`services/context_map/nuclear.py`, Carte-Front's `nuclear` module on a
network: units are the generators typed nuclear (`genreCvg` NUCLEAIRE, else
`energySource` NUCLEAR), **connected or not** (a stopped unit is drawn hollow).

- **Plant**: the RTE substation code (`RTE_SITE_PLANT` — gathers the units a
  model splits across substations, e.g. Cattenom's four), else the substation
  name (a plant name in it). Plants sit at their **real coordinates**
  (`PLANT_LONLAT`, the 18 French plants, plus Fessenheim — closed in 2020 but
  present in the older snapshots behind the RTE7000 grids) — Carte-Front's choice, the op4grid
  plan being ~30 km off; an unknown plant falls back on its voltage levels'
  georeferenced position, or is left out.
- **Level**: `P / maxP`, unit by unit (Carte-Front, reading a day without Pmax,
  scales on the day's strongest unit; a situation file has `maxP`). A unit
  runs from 1 MW; a disconnected unit is stopped whatever its set point; an
  unsolved file falls back on `target_p`.
- On the region mesh only the home country's units are drawn.

On the real PtFige of 2026-01-10: 18 plants, 57 units (as Carte-Front's
referential), 49 running.

## Matched power plants (untyped networks)

A PyPSA-EUR bundle's generators are synthetic — one per bus, untyped
(`energySource` OTHER), all at the same ~16 MW set point, the substation of
a 5.7 GW nuclear plant included. When a **`power_plants.json`** sits beside
the network file (`scripts/pypsa_eur/match_power_plants.py`, pipeline step 7
— see `docs/data/pypsa-eur-osm-to-xiidm.md`), `services/context_map/plants.py`
reads it at capture and types the situation's production:

- **by zone, not by substation**: typing each substation's 16 MW by its own
  plants cannot give a real mix (France came out at 1.5 % nuclear, every
  nuclear site weighing as much as a rural substation). Each zone's untyped
  production is typed AS A WHOLE by the **typical output of the plants matched
  in it** — installed capacity × an average load factor per fuel type
  (`CARRIER_LOAD_FACTOR`: nuclear 0.75, lignite 0.55, gas 0.30, hydro 0.35,
  wind 0.25, solar 0.12, storage ≤ 0.08…; `aggregate.matched_fleets`). On the
  European game grid: France 72 % nuclear, Germany 35 % wind / 28 % coal,
  Poland 56 % coal, Switzerland 62 % hydro / 30 % nuclear; Europe 25 %
  nuclear, 19 % gas, 17 % wind, 13 % hydro, 13 % coal, 7 % solar. Pie sizes,
  flows and totals stay the network's; a zone with no matched plant stays
  *other*; the network's own typing (`genreCvg` / `energySource`) always wins;
- **nuclear plants unit by unit**, on their real site, at their **real
  capacity** (powerplantmatching lists units: Gravelines 1–6, 951 MW each).
  A plant's output is its share of its zone's nuclear slice, split over its
  units by capacity — the dots add up to the pie. The tooltip says
  *Estimated output*. The level is low (Gravelines ~19 %) because the network's
  France produces 17 GW in all (Europe 75 GW), well under a real day;
- the situation card credits the database (powerplantmatching, CC BY 4.0).

## Typed networks (a real hour rebuilt on a grid)

A network that carries its own plants — one generator per (bus, fuel) with
real outputs, e.g. a PyPSA-EUR grid rebuilt on an observed hour — needs no
estimate: the map reads it as it is.

- **types** from each generator's `carrier` property (powerplantmatching's
  fuel names, `CARRIER_FILIERE`), between `genreCvg` and `energySource`:
  lignite is coal, run-of-river hydro, onshore wind wind…;
- **nuclear units** at their real output, grouped by their `plant` property
  and drawn on its real site (`plant_lon` / `plant_lat`) — no *Estimated
  output*;
- **exchanges with countries the grid leaves out** (Great Britain, Norway,
  Sweden, Turkey…) — FICTITIOUS loads tagged `neighbour` — are not
  consumption: they become transfers towards a **neighbour badge** named
  after its country (placed at its label point); an HVDC link between two
  countries of the grid (one such load at each end) counts once, from its
  exporting end;
- a `situation.json` beside the network (`situation.py`, schema
  `costudy4grid-situation/1`) gives the hour, its dispatch (`observed`, or a
  PyPSA `opf`) and its data sources: the situation card says *Real hour,
  observed dispatch* (or *optimal dispatch (PyPSA)*) and credits them.

## Where the studied elements are

The contingency / overloads need the position of their voltage levels.
`services/context_map/georef.py`, in order:

1. the IIDM **`substationPosition`** extension (exact lon/lat);
2. the study's **`grid_layout.json`**, georeferenced:
   - a layout in the **RTE op4grid plan** frame goes through Carte-Front's own
     calibration of that plan (`OP4GRID_PLAN_AFFINE` — affine fitted on the
     French outline and 18 nuclear sites, ~30 km median error: the plan is a
     drawing, not a survey). The frame is recognised by the voltage levels
     landing inside their countries;
   - any other layout is fitted as a Web-Mercator-like drawing: one isotropic
     scale + translation, first by aligning the home country's robust box with
     its mainland outline, then refined against the outlines (scale snapped to
     1/R for a Mercator-metre layout such as PyPSA-EUR — **~1 km** off at
     nuclear sites; translation = centre of the plateau putting the most levels
     inside their own country). A network that does not fill its country
     (scales disagree) or lands outside it is rejected.
3. nothing: the element is drawn **between the zones it touches** (or as a ring
   around its zone).

When fewer than two zones can be placed on the ground, there is no map at all
(see *Prerequisite*).

## Why it is fast

- `/api/config` calls `context_map_service.capture()` right after
  `network_service.load_network()`, **inside** the network lock and **before**
  the NAD prefetch starts switching variants: a handful of pypowsybl table reads
  (~0.2 s on the French grid) into plain pandas tables, so the flows read are
  the file's, consistently.
- `GET /api/context-map` builds the map from that snapshot (no `Network`
  access, no lock, ~0.1 s — 0.2 s with a PyPSA layout fit) and caches it until
  the next capture. Payload ~100 kB, gzipped to ~25 kB.
- The frontend does not wait for `/api/config` to answer: `api.updateConfig`
  emits a study-load signal (`utils/studyLoadSignal.ts`) and `useContextMap`
  polls the map meanwhile, accepting it only once its **`capture_id`** differs
  from the map on screen (the backend keeps serving the previous study's map
  until its reset). `useSettings.studyGeneration`, bumped by
  `applyConfigResponse`, confirms it afterwards (a no-op when already shown).
- Element geometry (`POST /api/context-map/elements`) is fetched lazily for the
  contingency + overloads and cached per study.

## Contract

| Endpoint | Returns |
|----------|---------|
| `GET /api/context-map` | `ContextMapData` (`types.ts`): `available` (`true`), `mesh`, `home`, `frame`, `bounds` `[x, y, w, h]`, `georef`, `flows_available`, `case_date`, `capture_id`, `basemap`, `country_labels`, `zones`, `flows`, `nuclear`, `plant_source` (the plant database credited when matched types are used, else `null`), `situation` (`{at_utc, dispatch, sources}` of a rebuilt real hour, else `null`), `totals`. Every position is already projected (`x = lon·cos(lat0)`, `y = −lat`). A network without the prerequisite gets `ContextMapUnavailable`: `{available: false, unavailable_reason, mesh, case_date, capture_id}`. 404 before a study is loaded. |
| `POST /api/context-map/elements` `{element_ids}` | `{elements: ContextMapElement[]}` — `points` (voltage-level positions, `null` without georeference), `zone_points`, `zones`, `kind`, `name`. At most 500 ids. |

Overloads come from the same source and selection filter as the N-1 tab's
orange halos (`computeN1OverloadHighlights`); their loading (ρ) comes from
`n1Diagram.lines_overloaded_rho`, and their loading before the contingency
from `n1Diagram.lines_overloaded_rho_before` (the N currents cached with the
N diagram over the permanent limits, `overloads.get_n_state_loading`; `null`
where unknown).

## Files

| Side | File |
|------|------|
| Backend | `expert_backend/services/context_map/` — `snapshot.py` (capture), `aggregate.py` (mesh + balances), `nuclear.py` (units layer), `plants.py` (`power_plants.json` matching), `situation.py` (`situation.json` of a rebuilt hour), `georef.py`, `geography.py` (ported constants, basemap, projection), `builder.py` (payload), `service.py` (singleton), `resources/europe_countries.geojson` |
| Backend | `expert_backend/context_map_api.py` (routes), `main.py` (`/api/config` capture) |
| Frontend | `hooks/useContextMap.ts`, `components/ContextMapView.tsx` (container, pan/zoom, cards), `components/ContextMapLayers.tsx` (SVG layers), `utils/contextMapGeometry.ts`, `utils/studyLoadSignal.ts`, `styles/tokens.ts` (`contextMapPalette`, `contextFiliereColors`) |
| Tests | `expert_backend/tests/test_context_map.py`, `scripts/pypsa_eur/test_match_power_plants.py`, `useContextMap.test.ts`, `ContextMapView.test.tsx`, `contextMapGeometry.test.ts`, `VisualizationPanel.test.tsx` |

## Game Mode grids

| Grid | Map |
|------|-----|
| Pan-European PyPSA (`pypsa_eur_eur220_225_380_400`, "Medium") | 29-country mesh (Mercator layout fit), every transfer labelled. The network's generators are synthetic and untyped (the OSM source is grid-only); **`power_plants.json`** beside it types them by the real plants matched to each substation (see below). 38 nuclear plants (97 units) on their real sites. |
| France THT (`rte7000_tht`) | RTE region mesh (op4grid plan), full mix, 19 nuclear plants (Fessenheim included). No foreign substation: no net-export line. |
| France EHV (`rte_matpower`) | No `regionCvg`: a single zone (France) — no Context tab (see *Prerequisite*). |

## Limits / follow-ups

- A France-only network **without** `regionCvg` (e.g. the bundled PyPSA
  `fr225_400`) has a single zone, hence no Context tab. Inferring RTE regions
  from geography would need region outlines, which Carte-Front does not carry.
- The tab is not detachable.
- The *Net exports* line needs a neighbour in the network: a home-only grid
  shows none.
- Flows are the network file's (N state as loaded); a file without computed
  flows draws no transfers (the summary says so).
