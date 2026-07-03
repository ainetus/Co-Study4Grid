# Voltage-level disk interactions (NAD)

The voltage-level (VL) disks drawn by pypowsybl on the Network Area
Diagram are directly interactive on every NAD tab — **Network (N)**,
**Contingency** and **Remedial Action**. Three gestures are wired onto
each disk:

| Gesture | Effect |
|---------|--------|
| **Hover** | Shows the VL name in a small floating tooltip — but only while the on-diagram VL labels are hidden (the `🏷 VL` toggle). When the labels are visible the name is already drawn, so the tooltip stays out of the way. |
| **Single-click (disk)** | Selects the VL: fills the bottom-left **Inspect** field with the VL id, auto-zooms / highlights it, and surfaces the `📄 SLD` shortcut — exactly as typing the name into the Inspect box would. |
| **Single-click (name box)** | Opens the VL's Single Line Diagram overlay directly — the name label next to the disk is a second, larger click target for the SLD. |
| **Double-click (disk or name box)** | Opens the VL's Single Line Diagram overlay (the same entry point as the `📄 SLD` button / `onVlOpen`). |

This is the disk-driven complement to the **Inspect** search field: the
field finds an asset by name; the disk finds it by pointing at it.

### The whole disk is a target, even under a branch

A branch is often drawn ON TOP of a VL disk, which would otherwise steal
the pointer hit-test from the disk beneath it. The handlers resolve this:
when the direct hit-test lands on something that is not a VL (an occluding
edge, or empty space), they fall back to `document.elementsFromPoint` and
take the **first VL disk / name box in the paint stack** under the cursor.
So the disk is interactive across its whole area regardless of what is
painted over it. The fallback only runs on discrete pointer events
(`mousedown` / hover-while-labels-hidden), never per frame, so the
performance contract below is unchanged.

### The name box is resolved through the metadata

pypowsybl renders each VL name as a `<div class="nad-label-box" id="…">`
inside a root-level `<foreignObject class="nad-text-nodes">`. The box `id`
is the NAD metadata **text-node** svgId, which the metadata index
(`metaIndex.textNodesBySvgId`, built from `metadata.textNodes` via each
entry's `vlNode` link / `equipmentId`) maps to the same VL `NodeMeta` the
disk resolves to. A delegated handler climbs from the click target to the
first ancestor whose `id` is a known disk **or** text-node svgId.

## Where it lives

- **`frontend/src/utils/svg/vlInteractions.ts`** — `attachVlInteractions(container, metaIndex, handlers)`.
  The whole behaviour is one function returning a teardown.
- **`frontend/src/App.tsx`** — a single effect binds the three NAD
  containers, mapping each gesture to the existing handlers:
  - `onSelect(vlId)` → `handleInspectQueryChangeFor(tab, vlId)` (drives
    the per-tab Inspect query + auto-zoom in `useDiagrams`). Fired by a
    single-click on the **disk**.
  - `onOpenSld(vlId)` → `handleVlOpen(vlId)` → `useSldOverlay.handleVlDoubleClick`.
    Fired by a **double-click** on the disk / name box **and** by a
    single-click on the **name box**.
  The callbacks are held in refs (`vlSelectRef` / `vlOpenSldRef` /
  `vlDisplayNameRef`) so the listeners re-bind **only** when a diagram
  or its metadata index changes — never on an unrelated render, which
  would needlessly tear down the listeners and cancel an in-flight
  single-click timer.
- **`frontend/src/App.css`** — `.svg-container .nad-vl-nodes, .svg-container
  .nad-label-box { cursor: pointer }` is the (static) pointer-cursor
  affordance on both the disk and the name box.

`onSelect` / `onOpenSld` reuse pre-existing interaction events
(`inspect_query_changed`, `sld_overlay_opened`), so the replay log stays
complete with no new event types.

## How a disk is resolved

pypowsybl renders each VL under `<g class="nad-vl-nodes">` as a group
`<g id="{svgId}"><circle r="27.5"/>…</g>`. The diagram metadata index
(`metaIndex.nodesBySvgId`) maps that `svgId` to the VL's `equipmentId`
(the VL id used everywhere else — `voltageLevels`, the SLD endpoints, the
zoom-to-element lookup). A delegated handler climbs from the event target
up to the first ancestor whose `id` is a known node `svgId`, yielding the
VL.

## Performance contract (do not regress)

Pan/zoom fluidity is the hard constraint — the NAD can carry ~5 000 VLs /
~100 k DOM nodes. The design is built around touching nothing per frame:

- **Event delegation.** A fixed handful of listeners on the container
  (`mouseover`, `mouseout`, `mousedown`, `click`, `dblclick`), never one
  per node. A 5 000-VL grid costs the same to wire as a 5-VL one.
- **No `mousemove` / no per-frame work.** The tooltip is positioned once
  on `mouseover`; the cursor is a static CSS rule.
- **Idle during gestures.** `usePanZoom` adds `.svg-interacting` during a
  pan/zoom, which sets `pointer-events: none` on every SVG child
  (`App.css`), so none of the disk handlers fire mid-gesture. Pan/zoom is
  a direct `viewBox` rewrite (no React re-render per frame), and this
  layer adds nothing to it.

### The click-vs-pan subtlety (regression-tested)

Because `.svg-interacting` flips `pointer-events: none` on SVG children
the instant a press starts, by the time `mouseup` fires the disk is
transparent and the browser **retargets the resulting `click` /
`dblclick` to the container** (the common ancestor of the disk-mousedown
and the container-mouseup). Resolving the VL from `click.target` would
therefore always miss — this is exactly the bug where hover worked but
clicks did nothing.

The fix: **capture the VL on `mousedown`**, whose hit-test still lands on
the live disk (the cull class is only set *by* that handler, after the
target is already fixed), and use the captured node in the click /
double-click handlers. A press is told apart from a pan by pointer travel
(`DRAG_THRESHOLD_PX`), and the single-click action is deferred
`VL_SINGLE_CLICK_DELAY_MS` (250 ms) so a double-click pre-empts it.

## Tests

- **`frontend/src/utils/svg/vlInteractions.test.ts`** — unit coverage for
  the module: single-click → `onSelect`, double-click → `onOpenSld` (and
  single-click suppression), the **container-retargeted** click / dbl-click
  (the real-world `pointer-events` cull), the drag guard, hover-tooltip
  gating on `nad-hide-vl-labels`, `displayName` fallback, same-group
  mouseout, single-tooltip reuse, nested-child resolution, multi-VL
  disambiguation, teardown (listeners + tooltip + pending timer), and the
  no-op guards.
- **`frontend/src/App.stateManagement.test.tsx`** (`Voltage-level disk
  interaction wiring`) — captures the handlers App passes to
  `attachVlInteractions` and invokes them, asserting `onSelect` flows into
  the shared Inspect query and `onOpenSld` opens the SLD overlay for the
  VL.

## History

Supersedes the former native `<title>` tooltip injector
(`utils/svg/vlTitles.ts`, `applyVlTitles`, removed): the native title only
delivered hover-name; the unified layer delivers hover + click + double-
click with an immediate, theme-aware tooltip and no double tooltip.
