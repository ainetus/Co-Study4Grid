# Action Overview Diagram

## Overview

The Remedial Action tab now hosts an **action-overview diagram** when no action card is selected. It renders the post-contingency (N-1) Network Area Diagram as a dimmed background and overlays **Google-Maps-style pins** — one per prioritised remedial action — anchored on the grid asset each action targets. The operator can see all suggested actions at a glance, single-click a pin to preview the full action card, or double-click to drill down into the action-variant network diagram.

Pins visually reflect the operator's triage decisions: **selected** (starred) actions are highlighted with a gold star above the pin, while **rejected** actions are dimmed with a red cross. **Simulated combined actions** (two unitary actions applied together) appear as a dedicated pin at the midpoint of a curved dashed connection linking the two constituent pins.

A compact **single-row header** above the diagram now exposes just the pin counter, the **Show unsimulated** checkbox, and the **Combined only** checkbox (PIN-SCOPED — restricts the overview to combined-action pins + their two constituents dimmed for context). The severity / action-type filters and the **Max-loading threshold** numeric input live in the shared sidebar `<ActionFilterRings>` strip (📍 – ring | ring | threshold), which the overview, the Action Feed, the Manual Selection modal, the Combine Actions modal and the Overflow Analysis iframe all read from. The wholesale relocation freed the overview banner from filter clutter and keeps every surface in lock-step on a single `ActionOverviewFilters` state owned by `App.tsx` — except `showCombinedOnly`, which is intentionally pin-only and never hides feed cards. See [Filtering](#filtering) below.

When **Show unsimulated** is enabled, scored-but-not-yet-simulated actions (those present in `result.action_scores` but absent from the simulated `actions` dict) are rendered as dimmed, dashed **un-simulated pins**. Hovering one reveals a score-metadata tooltip (type, score, rank-in-type, MW/tap start); double-clicking it kicks off the same manual-simulation code path the Manual Selection dropdown uses. See [Un-simulated action pin](#un-simulated-action-pin) below.

When any action card IS selected (either via the sidebar feed or by double-clicking a pin), the overview folds away and the existing action-variant diagram + highlights take over. The operator can return to the overview by clicking the deselect chip in the tab label ("Remedial Action: **\<action-id\> ✕**").

```
┌────────────────────────────────────────────────────────────────────────────┐
│  Tab bar                                                                   │
│  [Network (N)]  [Contingency (N-1)]  [Remedial action: overview]  [Overflow] │
├────────────────────────────────────────────────────────────────────────────┤
│  Sidebar: ⚡ Contingency | ⚠ Overloads | 📍 – ◉◉◉◉ | ▭▭▭▭▭▭▭ | 150 %     │
├────────────────────────────────────────────────────────────────────────────┤
│ 📍 7 (+3)   ☑ Show unsimulated   ☐ Combined only                          │
├────────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│   Background: N-1 NAD (dimmed)                                             │
│                                                                            │
│         ┌──────┐                                                           │
│      ★  │ 73%  │   ← green pin, selected (gold star)                      │
│         └──┬───┘                                                           │
│            │ points at line mid-point                                       │
│         ┌──────┐                                                           │
│      ✕  │ 99%  │   ← red pin, rejected (cross, dimmed)                    │
│         └──┬───┘                                                           │
│            │                                                               │
│         ┌╌╌╌╌╌╌┐                                                           │
│         │  ?   │    ← un-simulated pin (dashed, grey, opacity 0.5)        │
│         └╌╌┬╌╌╌┘                                                           │
│            │                                                               │
│        ╭───────────╮                                                       │
│     pin A ╌╌╌ + ╌╌╌ pin B   ← combined pin on curve                       │
│        ╰───────────╯                                                       │
│                                                                            │
│   Zoom: +  Fit  -                                                          │
│   🔍 Focus asset...                                                        │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘
```

---

## Visual stack

The SVG layers are ordered as follows (back to front):

| Layer | Content | Opacity | Purpose |
|---|---|---|---|
| 1. `.nad-overview-highlight-layer` | Clone of contingency + overloaded edges | 1.0 | Matches N-1 tab halos (yellow contingency, orange overloads) |
| 2. Original NAD content | All voltage-level nodes, edges, labels | 1.0 | The actual network diagram |
| 3. `.nad-overview-dim-rect` | White `<rect>` covering the entire viewBox | 0.65 | Dims the network + highlight halos so pins pop |
| 4. `.nad-action-overview-pins` | Teardrop pins + combined curves + un-simulated layer | 1.0 | Unitary pins, status symbols, combined curves + midpoint pins, dashed un-simulated previews |

Highlights are placed **behind** the NAD content (same background-layer pattern as the N-1 tab) so the halo peeks out around the line strokes. The dim rect sits on top of both, and pins ride above everything. Combined-action curves and un-simulated `.nad-action-overview-pin-unsimulated` glyphs also sit in the pin layer (above the dim rect) so they render vivid even against the dimmed NAD.

### Why a `<rect>` instead of `<g opacity>` or CSS opacity?

Earlier iterations tried two approaches that both failed on large grids (11k+ elements, ~43k SVG children):

1. **SVG transparency group** (`<g opacity="0.35">`): Forces Chrome to rasterise every child into an intermediate buffer before compositing — ~31s Layerize penalty.
2. **CSS per-child opacity** (`.nad-overview-dimmed > * { opacity: 0.35 }`): Each child element with `opacity < 1` creates its own stacking context — ~25s Layerize penalty.

The single white `<rect>` overlay (`opacity: 0.65`) achieves the same dim effect at zero compositing cost because the browser only needs to paint one extra element with no stacking contexts.

---

## Pin anatomy

### Unitary action pin

Each unitary pin is an SVG `<g>` with the following structure:

```
<g class="nad-action-overview-pin" transform="translate(x y)" data-action-id="..."
   opacity="0.55">                                       ← only if rejected
  <g class="nad-action-overview-pin-body" transform="scale(k)">
    <title>action id — description — max loading XX.X%</title>
    <path d="M ... A ... L 0 0 Z"  fill="..."  stroke="..." />  ← teardrop
    <circle cx="0" cy="..." r="..."  fill="#fff" fill-opacity="0.92" />  ← inner disc
    <text fill="#1f2937" font-weight="800">73%</text>            ← label
    <path d="M ... Z"  fill="#eab308" />                         ← star (selected only)
    <path d="M ... Z"  fill="#ef4444" />                         ← cross (rejected only)
  </g>
</g>
```

### Un-simulated action pin

Scored-but-not-yet-simulated actions — those present in `result.action_scores` but absent from the simulated `actions` dict — are rendered in a dedicated dimmed layer when the **Show unsimulated** filter toggle is enabled:

```
<g class="nad-action-overview-pin nad-action-overview-pin-unsimulated"
   transform="translate(x y)" data-action-id="..." data-unsimulated="true"
   opacity="0.5">
  <g class="nad-action-overview-pin-body" transform="scale(k)">
    <title>
      LINE_A — not yet simulated (double-click to run)
      Type: line_disconnection
      Score: 0.82 — rank 3 of 12 (max 0.95)
      MW start: 24.5 MW            ← only for LS / curtailment
      Tap start: 0 (range -8 … 8)  ← only for PST
    </title>
    <path d="..." fill="#c8cdd2" stroke="#6b7280" stroke-width="..."
          stroke-dasharray="..." />  ← dashed stroke distinguishes from simulated
    <circle ... fill="#fff" />       ← inner disc
    <text>?</text>                    ← placeholder label (no rho_after yet)
  </g>
</g>
```

Resolution: anchors go through `resolveActionAnchor` with a minimal `ActionDetail` stub, which falls back on edge/VL lookups keyed on the id alone — the same resolution the score table uses for line / coupling / PST actions. Items that cannot be resolved are silently skipped.

Behaviour:
- The pin body uses the **grey** severity palette (no `rho_after` is available).
- A **dashed stroke pattern** visually distinguishes them from solid-outline simulated pins.
- The whole group renders at `opacity: 0.5` so the eye immediately reads them as "not yet evaluated".
- Ids already present in the simulated `actions` dict are **skipped** so a given action never produces both a simulated and an un-simulated pin.
- A **single click** opens the standard `ActionCardPopover` preview (minimal since no card details exist yet).
- A **double click** invokes `onUnsimulatedPinDoubleClick` → `onSimulateUnsimulatedAction(actionId)` in `App.tsx` → same code path as Manual Selection in the ActionFeed dropdown. After the simulation completes the pin is re-coloured with its real severity (regression-guarded by `ActionOverviewDiagram.test.tsx`).

The score-info tooltip (`type`, `score`, `rankInType`, `countInType`, `maxScoreInType`, optional `mwStart` / `tapStart`) is wired by `App.tsx`, which flattens `result.action_scores` per type bucket, ranks within each bucket, and forwards the `UnsimulatedActionScoreInfo` map through `VisualizationPanel` → `ActionOverviewDiagram` → `buildUnsimulatedActionPins`. When no score info is available the tooltip falls back to `"<id> — not yet simulated (double-click to run)"`.

### Filter-dimmed constituent pin

When a combined action passes the category/threshold/action-type filter but one of its constituent unitary actions does not, the constituent pin is kept visible but **dimmed** so the combined pin's curve still has a visible endpoint to anchor on. It carries:

- `data-dimmed-by-filter="true"` attribute on the pin `<g>`,
- the **dimmed-severity fill** (`severityFillDimmed[severity]`, same palette as rejected pins),
- `opacity: 0.4` on the outer group (compared to 0.55 for rejected pins),
- no status symbol (neither star nor cross).

This "context-not-first-class-action" read is intentional: the operator sees the whole combined pair at a glance without being misled into thinking the constituents individually passed the filter.

### Combined action pin

Simulated combined actions (pair key containing `+` in the `actions` dict) are rendered as a curved connection between the two constituent unitary pins, with a dedicated pin at the curve midpoint:

```
<!-- Dashed curve from pin A to pin B -->
<path class="nad-combined-action-curve" d="M ... Q ... ..."
      stroke="#28a745" stroke-width="5" stroke-dasharray="..." />

<!-- Midpoint pin -->
<g class="nad-action-overview-pin nad-combined-action-pin" transform="translate(mx my)"
   data-action-id="actionA+actionB">
  <g class="nad-action-overview-pin-body" transform="scale(k)">
    <title>actionA + actionB — description — max loading XX.X%</title>
    <path d="..."  fill="#28a745" />           ← teardrop (severity colour)
    <circle ... fill="#fff" />                  ← inner disc
    <text>45%</text>                            ← label
    <circle fill="#28a745" stroke="white" />    ← "+" badge circle
    <text fill="white">+</text>                 ← "+" badge text
  </g>
</g>
```

The curve stroke width is read from the first edge path in the SVG (`.nad-edge-paths path`) so it matches the underlying network edges exactly. No dynamic rescaling is applied — curves live in SVG-space and scale naturally with the viewBox.

### Severity palette

Mirrors the `ActionCard` sidebar palette exactly:

| Severity | Fill colour | Highlighted (selected) | Dimmed (rejected) | Condition |
|---|---|---|---|---|
| green | `#28a745` | `#1e9e3a` | `#a3c9ab` | `max_rho ≤ monitoringFactor - 0.05` |
| orange | `#f0ad4e` | `#e89e20` | `#dcd0b8` | `monitoringFactor - 0.05 < max_rho ≤ monitoringFactor` |
| red | `#dc3545` | `#c82333` | `#d4a5ab` | `max_rho > monitoringFactor` |
| grey | `#9ca3af` | `#7b8a96` | `#c8cdd2` | Load-flow divergent or islanding detected |

The label text always uses dark slate `#1f2937` for contrast on both the white inner disc and the coloured teardrop.

### Selection / rejection status symbols

| Status | Visual treatment |
|---|---|
| **Selected** (starred) | Highlighted fill + gold border (`#eab308`) on teardrop + gold 5-pointed star above the bubble |
| **Rejected** | Dimmed fill + red cross (`#ef4444`) above the bubble + whole pin group at `opacity: 0.55` |
| **Neutral** | Standard severity fill, no symbol, full opacity |

Both symbols are rendered as `<path>` elements inside the `.nad-action-overview-pin-body` group, so they scale with the pin on zoom.

### Pin sizing

Base radius is read from the first VL circle in the SVG (`svg.querySelector('.nad-vl-nodes circle[r]').r`), so pins match voltage-level glyphs at normal zoom. A **screen-constant floor** (`PIN_MIN_SCREEN_RADIUS_PX = 22px`) is enforced: as the operator zooms out, `rescaleActionOverviewPins` upscales the `.nad-action-overview-pin-body` `scale()` transform so pins stay at least 22 screen pixels tall. An additional floor of 1/50th of the viewBox extent prevents pins from shrinking below a minimum proportion of the diagram.

The rescaler is driven by a `MutationObserver` on the SVG's `viewBox` attribute, rAF-throttled to avoid forced layouts during rapid wheel-zoom bursts (the source of the "Page ne répondant pas" lag on large grids).

### Pin anchor resolution

For each action, the anchor position is resolved in this order:

1. **Load shedding / curtailment / redispatch** → `voltage_level_id` from the first entry of `load_shedding_details`, `curtailment_details`, or (for redispatching) the generator's `voltage_level_id` from `redispatch_details` (direct VL node lookup, same pattern)
2. **Line / PST target** → mid-point of the edge's two node endpoints (via `getActionTargetLines`)
3. **Voltage-level target** → node (x, y) coordinate (via `getActionTargetVoltageLevels`)
4. **Fallback: `max_rho_line`** → mid-point of the line that carries the highest loading after the action

Actions whose asset cannot be located in the metadata are silently skipped.

### Overlapping pin fan-out

When multiple actions resolve to the same anchor position (e.g. two actions targeting the same line), pins are fanned out in a circle around the shared centre so each remains individually clickable. The offset radius is `1.2 × 30` SVG units — enough to expose each pin's clickable area without scattering them too far from the original anchor.

### Combined action detection

Simulated combined actions are identified by scanning the `actions` dict for keys containing `+` (e.g. `"disco_X+reco_Y"`). The key is split on `+` to locate the two constituent unitary pins. Only **simulated** pairs produce combined pins — estimation-only pairs from the superposition theorem (which live in `combined_actions` but not in `actions`) are not rendered on the overview.

The combined pin position is the midpoint of a quadratic Bezier curve whose control point is offset perpendicular to the line between the two constituent pins (30% of inter-pin distance).

---

## Filtering

Filtering state is captured in a single `ActionOverviewFilters` object owned by `App.tsx` and piped through `VisualizationPanel` into both `ActionOverviewDiagram` and `ActionFeed`. A card hidden in the feed is also hidden on the overview, and vice-versa.

```ts
interface ActionOverviewFilters {
    categories: Record<'green' | 'orange' | 'red' | 'grey', boolean>;
    threshold: number;            // ratio, e.g. 1.5 = 150 %
    showUnsimulated: boolean;
    actionType: 'all' | 'disco' | 'reco' | 'ls' | 'rc' | 'redispatch' | 'open' | 'close' | 'pst';
    /** Pin-only: hide everything except combined pins + constituents. */
    showCombinedOnly: boolean;
}
```

Default values: all four categories enabled, threshold `1.5`, `showUnsimulated: false`, `actionType: 'all'`, `showCombinedOnly: false`.

### Severity categories

Four toggles map 1:1 to the teardrop colour buckets:

| Chip | Colour | Meaning | Condition |
|---|---|---|---|
| Solves overload | green | `max_rho ≤ monitoringFactor - 0.05` | |
| Low margin | orange | `monitoringFactor - 0.05 < max_rho ≤ monitoringFactor` | |
| Still overloaded | red | `max_rho > monitoringFactor` | |
| Divergent / islanded | grey | `non_convergence || is_islanded \|\| max_rho == null` | |

Disabling a chip hides every pin in that bucket AND every sidebar card in that bucket. `All` and `None` bulk-apply to all four.

### Threshold spinner

A compact integer-percent number input (0–300 % step 1, stored as the fraction `1.0 = 100 %`) sits at the right end of the shared `<ActionFilterRings>` strip. The native spinner arrows are suppressed via inline `appearance: textfield` + a `::-webkit-inner-spin-button` rule in `App.css` so the column stays exactly three digits wide (real-world max-loading sits well under 200 %, never 1000 %); the leading ⚡ glyph that lived next to it was removed when ⚡ was promoted to the Contingency pictogram.

Any action whose **simulated** `max_rho` (or, when missing, the **estimated** `max_rho` reported by the recommender) is strictly greater than the threshold is hidden. The fallback precedence mirrors the severity bucket — both filters classify off the same value — so a row hides under the same conditions in the overview pins, the Action Feed cards, the Manual Selection score table and the Combine Actions Computed Pairs table (every surface routes through `rowPassesActionFilters` in `utils/actionTypes.ts`, or the equivalent inline check in `CombinedActionsModal.filteredComputedPairsList`). Actions with `max_rho == null` AND `estimated_max_rho == null` (divergent / islanded — all in the grey bucket) **bypass** the threshold so non-numeric outcomes remain visible whenever the grey category is enabled.

### Action-type chip row

Single-select chip row (`ALL / DISCO / RECO / LS / RC / OPEN / CLOSE / PST`) rendered by the shared `<ActionTypeFilterChips>` component. Behind the chip is the pure classifier `classifyActionType(actionId, description, scoreType)` in `utils/actionTypes.ts`, consulted by three UI surfaces (overview, feed, explore-pairs) to guarantee they never drift:

- The classifier's **coupling detector** (`isCouplingSignal`) checks id/type/description for `coupling`, `busbar`, `noeud`, `node_merging`, `node_splitting`, and the French `"du poste '<X>'"` marker.
- The earlier `"poste" + "ouverture"` rule was replaced in PR #105 after it mis-classified line-opening actions with descriptions like `"... DJ_OC dans le poste POSTE"`. The new signal, `/du poste\s+['"]/`, correctly targets the coupling phrasing only.
- A dedicated regression fixes a related issue where `"Ouverture … dans le poste"` was being routed to `open` instead of `disco`; the action-type commit `f356c2e` pins the expected bucket in `actionTypes.test.ts`.
- OPEN/CLOSE land in their buckets only when the coupling signal is also present — otherwise `ouverture` / `fermeture` descriptors route to DISCO / RECO.

For **combined-action pins**, the chip filter is satisfied if **either** constituent matches the active token (combined pairs are inherently multi-type, so requiring both would surprise the operator).

### Protected constituent pins

The pin-building memo runs in **three passes** so combined-action constituents are kept visible even when they individually fail the filter:

1. Build every unitary pin **unfiltered** (`buildActionOverviewPins` without the `overviewFilter` arg).
2. Build combined pins from the unfiltered set, then drop those that fail the category/threshold/action-type filter themselves.
3. Compute the `protectedIds` set = all unitary ids referenced by any surviving combined pin.
4. Re-filter the unitary pins: passing pins go through as-is; `protectedIds` entries that fail come through with `dimmedByFilter: true`; everything else is dropped.

This keeps the visual grammar intact: every combined-pair curve has two visible endpoints, and the operator sees the filter narrowing the view to "what matters under the current criteria" without breaking the topology of the combined pins that matter.

### Combined-only toggle (`showCombinedOnly`)

A pin-scoped checkbox in the filter header restricts the overview to **combined-action pins + their two constituents** (the constituents come through dimmed via the same `dimmedByFilter` flag the protected-constituent path uses). Solo unitary pins and every un-simulated pin disappear so the operator can focus on the recommender's multi-action remediations without scrolling past every standalone pin.

When `showCombinedOnly: true`:
- Combined pins still go through their own severity / threshold / action-type filter (a pair that fails its own filter is dropped, and so are its constituents — nothing protects them).
- Unitary pins are emitted **only** when their id is in `protectedIds` (i.e. constituent of at least one passing combined pin), and always with `dimmedByFilter: true`.
- The un-simulated pin layer (`buildUnsimulatedActionPins`) short-circuits to `[]` — un-simulated actions can never be in a computed pair.

The flag is **pin-only**: the sidebar `ActionFeed` does NOT consult it, so cards remain visible even when the overview is restricted to pairs (the feed already exposes its own combined / unitary toggles via the explore-pairs surface). This asymmetry is intentional — the toggle is a focusing aid for the network view, not a global filter.

The same flag drives the overflow-graph iframe via the shared `cs4g:filters` postMessage envelope; see `docs/features/interactive-overflow-analysis.md` §7 for the wire-format and round-trip contract.

### Shared predicate

`actionPassesOverviewFilter(details, monitoringFactor, categoryEnabled, threshold)` (exported from `utils/svgUtils.ts`) is the single predicate used by:

- `buildActionOverviewPins` (optional `overviewFilter` param, new in PR #105)
- `ActionOverviewDiagram.tsx` (the three-pass pin build above)
- `ActionFeed.tsx` (sidebar card filtering)

The action-type check (`matchesActionTypeFilter`) is applied on top of this shared predicate at each call site. This lock-step is the reason a card and a pin can never disagree about visibility.

### Interaction logging

Each filter adjustment emits an `overview_filter_changed` event with the `kind` (`category` / `categories_bulk` / `threshold` / `action_type` / `combined_only`) plus kind-specific payload (the `combined_only` variant carries `{ enabled: boolean }`). Toggling unsimulated fires `overview_unsimulated_toggled`, and simulating an un-simulated pin via double-click fires `overview_unsimulated_pin_simulated`. See `docs/features/interaction-logging.md` for the replay contract.

---

## Interactions

### Auto-zoom on open

When the overview becomes visible, it computes a **fit rectangle** that encloses:
- the contingency edge endpoints,
- all overloaded-line edge endpoints,
- every unitary pin position,
- every combined pin position,
- every **un-simulated pin position** (only contributes when `showUnsimulated` is on),

padded by 5% on each side. This rectangle is set as the initial `viewBox` via `usePanZoom` so the operator always opens on a meaningful frame.

The fit rectangle is recomputed when `(n1MetaIndex, contingency, overloadedLines, pins, combinedPins, unsimulatedPins)` changes, and re-asserted when the overview re-appears after a round-trip through the action drill-down view (tracked via `wasVisibleRef`).

### Pan, zoom, and inspect

The overview mounts its own `usePanZoom` instance (independent from the N-1 and action tabs):
- **Wheel zoom** + **drag pan**: handled by the hook's event listeners, active only when `visible && svgReady`.
- **Zoom +/−/Fit buttons**: rendered in the bottom-left control cluster. Fit restores the auto-fit rectangle and clears the `lastFocusedRef` so a subsequent asset focus works on the same id.
- **Inspect search field**: local to the overview. Typing / selecting an equipment id pans and zooms onto it via `computeEquipmentFitRect`. The focus is "consume-once" (mirrors `useDiagrams`'s `lastZoomState` pattern) so wheel-zoom after an asset focus does NOT snap back. The search matches an element by its **displayed name** (e.g. `LESQUIVE 400kV`) as well as its raw id, via `utils/inspectables.ts:filterInspectables(items, query, displayName?, limit)` — shared with every other inspect surface so they stay in lock-step.

### Single-click on a pin → card popover

A single click (deferred by 250ms to distinguish from double-click) opens a floating **ActionCardPopover** anchored near the pin. The popover renders the **same `ActionCard` component** the sidebar feed uses (see [Card sharing](#card-sharing) below).

Popover placement is computed by `utils/popoverPlacement.ts`:
- **Vertical**: below the pin if there's room, above if not (uses CSS `bottom` for above-placement so the bottom edge anchors at the pin regardless of popover height).
- **Horizontal**: left-aligned if pin is in the left viewport third, right-aligned if in the right third, centred otherwise. Always clamped to viewport edges.

Dismissed on: Escape, outside click, the ✕ button, card body click, or when `visible` flips false.

### Double-click on a pin → drill-down

A double-click (detected via the browser's click + dblclick sequence; the 250ms single-click timer is cancelled) calls `onActionSelect(actionId)`. This:

1. Closes any open popover.
2. Triggers the existing action-select flow in `useDiagrams` → fetches the action-variant NAD → folds the overview away.
3. Scrolls the sidebar feed to centre the matching card via `ActionFeed`'s `scrollIntoView({ block: 'center' })` effect.

### Returning to the overview

When the action-variant diagram is showing, the tab label reads **"Remedial Action: \<chip\>"** where `<chip>` is a pink clickable badge around the action id with a ✕ circle. Clicking the chip calls `onActionSelect(null)` and the overview re-opens with its last fit rectangle.

### Double-click on an un-simulated pin → manual simulation

Un-simulated pins (dashed, grey, dimmed) intercept the double-click gesture via `onUnsimulatedPinDoubleClick` before it reaches the standard `onPinDoubleClick` path. The callback fires `onSimulateUnsimulatedAction(actionId)` in the parent, which runs the exact same code path as the Manual Selection dropdown in the ActionFeed. The logger records `overview_unsimulated_pin_simulated`. Once the simulation completes, the action appears in the `actions` dict and the pin swaps out of the dimmed un-simulated layer into the standard severity palette on the next render — regression-guarded by `ActionOverviewDiagram.test.tsx` (pin re-colour after double-click → completion).

---

## Card sharing

Both the sidebar feed and the pin-click popover render the **same `ActionCard` component** from `components/ActionCard.tsx`. The popover-specific chrome (floating frame, close button, shadow, no-op stubs for re-simulate/edit controls) is encapsulated in `components/ActionCardPopover.tsx`, so adding or renaming a field on `ActionCard` only requires updating two call-sites (the feed render + the popover wrapper), never parallel implementations.

All text in the `ActionCard` uses a uniform **12px** font size for the title, description, and footer ("Loading after:", "Max loading:") so the card stays compact in both the sidebar feed and the popover.

---

## Files

| File | Responsibility |
|---|---|
| `components/ActionOverviewDiagram.tsx` | Main component: SVG injection, dim rect, highlights, pins, combined pins, un-simulated pins, filter header, pan/zoom, popover state |
| `components/ActionTypeFilterChips.tsx` | Shared single-select chip row (`ALL / DISCO / RECO / LS / RC / OPEN / CLOSE / PST`) used by overview, feed, and explore-pairs |
| `components/ActionCard.tsx` | Shared action card rendered in sidebar feed and pin-click popover (uniform 12px text) |
| `components/ActionCardPopover.tsx` | Shared floating ActionCard wrapper (chrome + no-op stubs) |
| `utils/svgUtils.ts` | Barrel re-exporting helpers from `utils/svg/*`: `buildActionOverviewPins`, `buildUnsimulatedActionPins`, `buildCombinedActionPins`, `actionPassesOverviewFilter`, `applyActionOverviewPins`, `applyActionOverviewHighlights`, `rescaleActionOverviewPins`, `computeActionOverviewFitRect`, `computeEquipmentFitRect` |
| `utils/svg/actionPinData.ts` | Pure data: severity palette, anchor resolution, unitary + un-simulated pin builders, overview filter predicate |
| `utils/svg/actionPinRender.ts` | DOM-mutating render layer: unitary / combined / un-simulated pin glyphs, rescaler, click listeners |
| `utils/actionTypes.ts` | Shared classifier: `classifyActionType`, `matchesActionTypeFilter`, `ACTION_TYPE_FILTER_TOKENS` |
| `utils/popoverPlacement.ts` | Pure helpers: `decidePopoverPlacement`, `computePopoverStyle` |
| `components/VisualizationPanel.tsx` | Mounts overview in the action tab's `DetachableTabHost`; forwards `overviewFilters`, `unsimulatedActionIds`, `unsimulatedActionInfo`, `onSimulateUnsimulatedAction`; renders the deselect chip in the tab label |
| `App.tsx` | Owns the `ActionOverviewFilters` state; computes `unsimulatedActionIds` + `unsimulatedActionInfo` from `result.action_scores` (type bucketing + rank within type); wires `n1MetaIndex`, `onActionSelect`, `onActionFavorite`, `onActionReject`, `selectedActionIds`, `rejectedActionIds`, `monitoringFactor`, and all of the above through to `VisualizationPanel` |
| `components/ActionFeed.tsx` | `scrollIntoView` effect on `selectedActionId` change; applies the shared `actionPassesOverviewFilter` + `matchesActionTypeFilter` so sidebar cards mirror overview visibility |
| `App.css` | `.nad-overview-dimmed`, `.nad-action-overview-pin`, `.nad-action-overview-pin-unsimulated`, `.nad-action-overview-container` styles |

---

## Test coverage

| Test file | Covers |
|---|---|
| `utils/svgUtils.test.ts` (barrel) + `utils/svg/actionPinData.test.ts` + `utils/svg/actionPinRender.test.ts` | Pin resolution, severity, label, palette, idempotence, click semantics, mousedown stopPropagation, no-outline, dark label text, **combined pair exclusion from unitary pins**, **load shedding / curtailment VL anchoring**, **overlapping pin fan-out**, **combined pin building (Bezier midpoint, severity, label, p1/p2, skip on missing constituent)**, **selected pin highlighting (gold star, highlighted fill, gold stroke)**, **rejected pin dimming (red cross, dimmed fill, 0.55 opacity)**, **neutral pin unmodified**, **combined pin rendering (curved path, edge stroke-width, "+" badge, severity fill)**, **curve not rescaled on zoom**, **`actionPassesOverviewFilter` category/threshold/null-max-rho edge cases**, **`buildUnsimulatedActionPins` resolution, dedup, tooltip variants (generic / score-enriched / MW-start / PST-tap-range / missing-id fallback)**, **overview filter pass-through on `buildActionOverviewPins` (`overviewFilter` param)**, highlight cloning + background-layer ordering, pin rescale + rAF throttle + viewBox-fraction floor, fit-rect geometry |
| `components/ActionOverviewDiagram.test.tsx` | SVG injection, dim rect, pins + palette, no-outline, anchor positions, double-click → onActionSelect, auto-fit, legend, pin count, visibility toggle, empty states, zoom +/−/Fit, inspect asset-focus + sticking regression, popover open/close/Escape/card-body-activate/placement (incl. viewport-clamping from PR #105's `d277597`), highlights ordering + refresh, pin rescale + rAF throttle, **filter header render (categories / All-None / threshold / unsimulated / action-type chips)**, **filter state propagation to pins (category hide / threshold cap / action-type chip)**, **protected constituent pins kept visible with `dimmedByFilter`**, **un-simulated pin rendering (dashed stroke, 0.5 opacity, `?` label)**, **un-simulated pin double-click → `onSimulateUnsimulatedAction`**, **un-simulated pin tooltip enrichment from score metadata**, **un-simulated pin re-colour after simulation completes** (commit `086e23e`) |
| `components/ActionTypeFilterChips.test.tsx` | Chip rendering, active state `aria-pressed`, click → `onChange`, custom token list override, test-id prefix forwarding |
| `utils/actionTypes.test.ts` | Classifier routing: `disco` / `reco` / `ls` / `rc` / `open` / `close` / `pst` / `unknown`; regression for `"Ouverture … dans le poste"` → `disco` (commit `f356c2e`); regression for description `"du poste 'X'"` → coupling bucket (commit `d479516`); `matchesActionTypeFilter` identity + `all` pass-through |
| `components/ActionCardPopover.test.tsx` | Shared ActionCard rendering, extraDataAttributes forwarding, custom testId, close ✕, stopPropagation, card-body activation, no-op stubs |
| `utils/popoverPlacement.test.ts` | Vertical + horizontal placement rules, top/bottom/left anchoring, viewport clamping, end-to-end corner cases |
| `components/VisualizationPanel.test.tsx` | Deselect chip render, click calls onActionSelect(null), Enter/Space keyboard, no chip when no action selected |
| `components/ActionFeed.test.tsx` | `scrollIntoView` on selection change; **shared-filter predicate pass-through**: cards hidden when category disabled / threshold exceeded / action-type chip mismatches, in lock-step with the overview |

---

## Performance notes

| Concern | Mitigation |
|---|---|
| SVG injection on large grids (>10k elements) | Pre-parsed via `DOMParser` in a `useMemo`, injected with `replaceChildren()` — zero double-parse |
| Dim layer compositing (Chrome Layerize) | Single `<rect>` overlay instead of `<g opacity>` wrapper or CSS per-child `opacity` — both alternatives force Chrome to create individual composite layers for every child element (~25-31s Layerize penalty on 11k-element NADs). The `<rect>` approach has zero stacking-context cost. |
| Highlight CTM reads | Batched: `cachedLayerCTM` is computed once per `applyActionOverviewHighlights` call, not per-clone |
| Pin rescale during wheel-zoom | `MutationObserver` + `requestAnimationFrame` throttle — at most one `getScreenCTM`-equivalent per frame. The rescaler now reads `viewBox` + `clientWidth` directly (pure math) instead of calling `getScreenCTM()` to avoid forced layouts entirely |
| Combined curve stroke width | Read once from the SVG edge paths at pin-apply time; no dynamic rescaling during zoom (curves scale naturally with the viewBox like all other SVG content) |
| ID-map lookups | `getIdMap` uses a `WeakMap` cache keyed on the container element, invalidated only when the SVG content changes |
| Filter re-compute on every slider tick | The three-pass pin build is memoised with fine-grained dependency keys (`categories`, `threshold`, `actionType`) so unrelated state updates (e.g. a pan gesture) don't rerun the combined-pin + protected-id computation |
| Un-simulated pin render ordering | The un-simulated layer is drawn AFTER combined + unitary pins in the same `DocumentFragment`, so a single DOM append still covers all three — no per-pin reflow |
