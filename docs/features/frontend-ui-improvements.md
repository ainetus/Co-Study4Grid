# Frontend UI Improvements Plan

> **Status**: Implemented  
> **Scope**: `frontend/src/` components. The auto-generated
> `frontend/dist-standalone/standalone.html` (PR #101) inherits from
> the React source via `npm run build:standalone`; the legacy
> hand-maintained `standalone_interface.html` has been decommissioned.  
> **Date**: 2026-04-01

> **Note (historical)**: this is an early UI-improvements plan. Several
> of these items have since been **superseded or extended** by later
> work — notably the shared **Action Filter rings** strip (severity +
> action-type + Max-loading, replacing the per-surface category toggles
> here), the **collapsible readability sidebar**, the tiered **Notices
> pill + DiagramLegend**, and **light / dark theme** (all 0.8.0). For
> current behavior see [`docs/README.md`](../README.md), the relevant
> feature docs (e.g. [`dark-mode.md`](dark-mode.md)) and the
> [`CHANGELOG`](../../CHANGELOG.md). The content below is preserved as
> the original plan of record.

---

## Table of Contents

1. [Move & Rename "Run Analysis" Button](#1-move--rename-run-analysis-button)
2. [Always-Visible Visualization Tabs with Placeholder Messages](#2-always-visible-visualization-tabs-with-placeholder-messages)
3. [Collapsible Voltage Filter](#3-collapsible-voltage-filter)
4. [Revised Color Code for Highlights](#4-revised-color-code-for-highlights)

---

## 1. Move & Rename "Run Analysis" Button

### Current State

The "Run Analysis" button lives inside the **contingency selector card** in `App.tsx` (line ~812–829), directly below the contingency `<input>` field. It is rendered as:

```tsx
<button onClick={wrappedRunAnalysis} disabled={!selectedBranch || analysisLoading}>
  {analysisLoading ? '⚙️ Running...' : '🚀 Run Analysis'}
</button>
```

The **ActionFeed** panel (below the OverloadPanel in the sidebar) already has its own button zone where:
- A **processing spinner** appears while `analysisLoading` is true (line ~916)
- A **"Display N prioritized actions"** button appears when `pendingAnalysisResult` is ready (line ~934)

### Target State

Move the analysis trigger into the **ActionFeed** panel header area, at the location where the processing indicator and "Display" button appear. The three states become a single slot:

| State | What is shown |
|-------|---------------|
| **Idle** (no analysis running, no pending result) | `🔍 Analyze & Suggest` button (green, enabled only if `selectedBranch` is set) |
| **Running** (`analysisLoading === true`) | `⚙️ Analyzing…` button (yellow, disabled) |
| **Pending** (`pendingAnalysisResult !== null`) | `📊 Display N prioritized actions` button (green gradient, enabled) |

### Files to Change

#### `App.tsx`
- **Remove** the `<button onClick={wrappedRunAnalysis}>` block (lines ~812–829) from the contingency selector card.
- **Pass** `onRunAnalysis={wrappedRunAnalysis}` as a new prop to `<ActionFeed>`.
- The `selectedBranch` value is already passed (indirectly via `analysisLoading` disable logic). Also pass `canRunAnalysis={!!selectedBranch && !analysisLoading}` so ActionFeed can enable/disable.

#### `ActionFeed.tsx`
- **Add props**: `onRunAnalysis: () => void`, `canRunAnalysis: boolean`.
- In the **Suggested Actions section** (around line ~916–956), replace the current conditional rendering with the unified three-state slot:

```tsx
{/* Unified analysis action slot */}
<div style={{ padding: '10px 15px' }}>
  {analysisLoading ? (
    <button disabled style={{ /* yellow processing style */ }}>
      ⚙️ Analyzing…
    </button>
  ) : pendingAnalysisResult ? (
    <button onClick={onDisplayPrioritizedActions} style={{ /* green gradient */ }}>
      📊 Display {count} prioritized actions
    </button>
  ) : (
    <button onClick={onRunAnalysis} disabled={!canRunAnalysis} style={{ /* green style */ }}>
      🔍 Analyze & Suggest
    </button>
  )}
</div>
```

#### `standalone_interface.html`
- Apply the same relocation: remove the analysis button from the contingency selector area and add it into the action feed panel header.

#### Test Files
- Update `App.settings.test.tsx` and `App.session.test.tsx`: the `'🚀 Run Analysis'` text selector changes to `'🔍 Analyze & Suggest'`. Locate the button inside the action feed panel instead of the sidebar header.

---

## 2. Always-Visible Visualization Tabs with Placeholder Messages

### Current State

In `VisualizationPanel.tsx` (lines ~808–858), tabs are **conditionally rendered**:
- **Network (N)**: Always shown
- **Contingency (N-1)**: Only when `selectedBranch` is set
- **Action**: Only when `selectedActionId` is set
- **Overflow Analysis**: Only when `result?.pdf_url` exists

### Target State

All four tabs are **always visible**. When a tab's content is not yet available, clicking it shows a placeholder message guiding the user on what to do. Additionally, the **Action** tab dynamically updates its label to include the selected action ID.

#### Tab Definitions

| Tab | Label (default) | Label (populated) | Placeholder message |
|-----|------------------|--------------------|---------------------|
| N | `Network (N)` | — | *(always populated after config)* `Configure a network path in Settings to view the base-case diagram.` |
| N-1 | `Contingency (N-1)` | — | `Select a contingency element from the dropdown above to view the N-1 state.` |
| Action | `Remedial Action` | `Remedial Action: {actionId}` | `Select an action card from the suggestions panel to view its effect on the network.` |
| Overflow | `Overflow Analysis` | — | `Run an analysis to generate the overflow graph.` |

#### Tab Styling

- **Populated tabs**: Current active/inactive styling (bold + colored bottom border when active).
- **Unpopulated tabs**: Slightly dimmer text (`#aab`), italic label, no colored border even when active. Still clickable.
- **Active but unpopulated**: White background + placeholder message in content area (centered, grey italic text with a subtle icon).

### Files to Change

#### `VisualizationPanel.tsx`

- **Remove conditional rendering** of tab buttons. Render all four always.
- Add availability flags:
  ```tsx
  const tabAvailable = {
    'n': !!nDiagram?.svg,
    'n-1': !!n1Diagram?.svg,
    'action': !!actionDiagram?.svg,
    'overflow': !!result?.pdf_url,
  };
  ```
- Update the **Action** tab label:
  ```tsx
  const actionTabLabel = selectedActionId
    ? `Remedial Action: ${selectedActionId}`
    : 'Remedial Action';
  ```
  Truncate long action IDs with CSS `text-overflow: ellipsis` (max ~200px) and show full ID on hover via `title` attribute.
- In the tab **content area**, wrap each tab's body:
  ```tsx
  {activeTab === 'action' && (
    tabAvailable['action']
      ? <MemoizedSvgContainer ... />
      : <TabPlaceholder message="Select an action card from the suggestions panel to view its effect on the network." />
  )}
  ```
- Add a small `TabPlaceholder` component (inline or local):
  ```tsx
  const TabPlaceholder: React.FC<{ message: string }> = ({ message }) => (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      height: '100%', color: '#999', fontStyle: 'italic', padding: '40px',
      textAlign: 'center', fontSize: '0.95rem'
    }}>
      {message}
    </div>
  );
  ```

#### `standalone_interface.html`
- Mirror the same logic: always render all 4 tab buttons, show placeholder text when content is unavailable.

#### `App.tsx`
- Remove any logic that prevents switching to a tab when its content is unavailable (if present). The `onTabChange` handler should allow selecting any tab at any time.

---

## 3. Collapsible Voltage Filter

### Current State

The voltage filter is a **vertical sidebar** on the right side of the visualization panel (`VisualizationPanel.tsx` lines ~1074–1125, CSS class `.voltage-sidebar`). It is always visible when `uniqueVoltages.length > 1`, consuming ~62px of horizontal space.

### Target State

The voltage filter sidebar is **collapsed by default**, showing only a small toggle button. When expanded, it shows the full slider UI as today.

#### Collapsed State
- A small vertical button on the right edge: `▸ kV` (or a filter icon from lucide-react).
- Width: ~24px, just enough for the icon/label.
- Click expands the filter.

#### Expanded State
- Full current sidebar (62px width) with an additional collapse button (`◂` or `✕`) at the top.
- Clicking the collapse button or clicking outside collapses it back.

### Files to Change

#### `VisualizationPanel.tsx`
- Add local state: `const [voltageFilterExpanded, setVoltageFilterExpanded] = useState(false);`
- Wrap the existing voltage sidebar in a conditional:
  ```tsx
  {uniqueVoltages.length > 1 && (
    voltageFilterExpanded ? (
      <div className="voltage-sidebar">
        <button onClick={() => setVoltageFilterExpanded(false)}
          style={{ alignSelf: 'flex-end', background: 'none', border: 'none', cursor: 'pointer', fontSize: '14px' }}>
          ✕
        </button>
        {/* ... existing slider content ... */}
      </div>
    ) : (
      <button
        className="voltage-sidebar-toggle"
        onClick={() => setVoltageFilterExpanded(true)}
        title="Show voltage filter"
      >
        <span style={{ writingMode: 'vertical-rl' }}>kV ▸</span>
      </button>
    )
  )}
  ```

#### `App.css`
- Add `.voltage-sidebar-toggle` style:
  ```css
  .voltage-sidebar-toggle {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    width: 24px;
    background: rgba(244, 244, 244, 0.85);
    border: none;
    border-left: 1px solid #ccc;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 15;
    color: #666;
    font-size: 12px;
  }
  .voltage-sidebar-toggle:hover {
    background: rgba(230, 230, 230, 0.95);
    color: #333;
  }
  ```

#### `standalone_interface.html`
- Add equivalent collapse/expand toggle with the same CSS and JS logic.

---

## 4. Revised Color Code for Highlights

### Current State

| Element | NAD Color | SLD Color | CSS Class |
|---------|-----------|-----------|-----------|
| Action targets | Yellow `#fffb00` | Yellow `#fffb00` | `.nad-action-target`, `.sld-highlight-action` |
| Contingency | Orange `#ff9800` | Orange `#ff9800` | `.nad-contingency-highlight`, `.sld-highlight-contingency` |
| Overloads | Orange `#ff8c00` | Orange `#ff8c00` dashed | `.nad-overloaded`, `.sld-highlight-overloaded` |
| Breakers/switches | — | Purple `#e040fb` | `.sld-highlight-breaker` |

**Problem**: Contingency and overloads both use orange, making them hard to distinguish. Actions use yellow which doesn't contrast well with orange on bright backgrounds.

### Target Color Scheme

| Element | New Color | Hex | Rationale |
|---------|-----------|-----|-----------|
| **Remedial Actions** | Purple-pink | `#e040fb` | Distinctive, stands out against network blues/greens |
| **Contingency** | Yellow | `#f5c542` | Warm "warning" tone, clearly different from orange |
| **Overloads** | Orange | `#ff8c00` | Kept — strong "danger" association, universally understood |
| **Breakers/switches** | Purple (lighter) | `#ce93d8` | Softer shade to distinguish from action purple-pink |

### Visual Hierarchy
```
  🟣 Purple-pink (#e040fb)  →  Actions (what the operator chose)
  🟡 Yellow (#f5c542)       →  Contingency (the triggering event)
  🟠 Orange (#ff8c00)       →  Overloads (the problem to solve)
  🟣 Light purple (#ce93d8) →  Breakers (topology detail)
```

### Files to Change

#### `App.css` — NAD Highlights

**Action targets**: Yellow → Purple-pink
```css
/* Before */
.nad-action-target {
    filter: drop-shadow(0 0 8px #fffb00) drop-shadow(0 0 15px #fffb00) !important;
}
.nad-action-target path, .nad-action-target line, ... {
    stroke: #fffb00 !important;
}
.nad-action-target circle, .nad-action-target rect {
    stroke: #ffe600 !important;
    fill: #ffe600 !important;
}

/* After */
.nad-action-target {
    filter: drop-shadow(0 0 8px #e040fb) drop-shadow(0 0 15px #e040fb) !important;
}
.nad-action-target path, .nad-action-target line, ... {
    stroke: #e040fb !important;
}
.nad-action-target circle, .nad-action-target rect {
    stroke: #e040fb !important;
    fill: #e040fb !important;
    fill-opacity: 0.6 !important;
}
```

**Contingency**: Orange → Yellow
```css
/* Before */
.nad-contingency-highlight {
    filter: drop-shadow(0 0 8px #ff9800) drop-shadow(0 0 15px #ff9800) !important;
}
.nad-contingency-highlight path, ... {
    stroke: #ff9800 !important;
}

/* After */
.nad-contingency-highlight {
    filter: drop-shadow(0 0 8px #f5c542) drop-shadow(0 0 15px #f5c542) !important;
}
.nad-contingency-highlight path, ... {
    stroke: #f5c542 !important;
}
.nad-contingency-highlight circle, .nad-contingency-highlight rect {
    stroke: #f5c542 !important;
    fill: #f5c542 !important;
}
```

**Overloads**: No change (already orange `#ff8c00`). But add NAD highlight support for overloads using the same clone-based glow pattern used for contingency and actions, so overloaded lines get a visible orange halo instead of just a stroke-width bump.

#### `App.css` — SLD Highlights

```css
/* Action: yellow → purple-pink */
.sld-highlight-clone.sld-highlight-action {
    filter: drop-shadow(0 0 4px #e040fb) drop-shadow(0 0 8px #e040fb);
}
.sld-highlight-clone.sld-highlight-action path, ... {
    stroke: #e040fb !important;
}

/* Contingency: orange → yellow */
.sld-highlight-clone.sld-highlight-contingency {
    filter: drop-shadow(0 0 4px #f5c542) drop-shadow(0 0 8px #f5c542);
}
.sld-highlight-clone.sld-highlight-contingency path, ... {
    stroke: #f5c542 !important;
}

/* Overloads: unchanged (orange #ff8c00, dashed) */

/* Breakers: bold purple → lighter purple */
.sld-highlight-clone.sld-highlight-breaker {
    filter: drop-shadow(0 0 3px #ce93d8) drop-shadow(0 0 6px #ce93d8);
}
.sld-highlight-clone.sld-highlight-breaker path, ... {
    stroke: #ce93d8 !important;
}
```

#### `App.css` — Overload Highlight Enhancement

Add clone-based glow for overloaded lines (currently overloads only get a stroke-width increase, no halo/glow like actions and contingency do):

```css
.nad-overloaded {
    filter: drop-shadow(0 0 6px #ff8c00) drop-shadow(0 0 12px #ff8c00) !important;
}
```

#### `svgUtils.ts` — Overload Highlighting

Currently `highlightOverloadedLines()` (line ~186) only adds the `nad-overloaded` class to existing elements. To match the clone-based approach used by actions and contingency (for consistent glow rendering), consider upgrading it to also create cloned background elements with the `.nad-overloaded` class. This gives overloads the same visual treatment (halo behind the original element).

Alternatively, the simpler CSS-only `filter: drop-shadow()` addition above may be sufficient if the existing stroke-width increase already makes overloads visible enough. Start with the CSS-only approach and upgrade to clones only if needed.

#### `standalone_interface.html`
- Update all matching CSS rules with the same color changes.
- The standalone file has its own embedded `<style>` block — search for `#fffb00`, `#ff9800`, `#e040fb` and apply the same replacements.

#### `cssRegression.test.ts`
- Update expected color values in assertions:
  - `nad-action-target` → expect `#e040fb` instead of `#fffb00`
  - `nad-contingency-highlight` → expect `#f5c542` instead of `#ff9800`
  - standalone equivalents likewise

#### Color Legend
Consider adding a small legend to the visualization panel (bottom-left corner, semi-transparent) so users understand the color coding:

```
 ● Purple-pink — Remedial action targets
 ● Yellow — Contingency element
 ● Orange — Overloaded lines
```

This is optional but recommended for discoverability.

---

## Implementation Order

Recommended sequence (each item is independently deployable):

1. **Color code revision** (item 4) — CSS-only changes, low risk, high visual impact. Update tests.
2. **Collapsible voltage filter** (item 3) — Self-contained UI change, no cross-component dependencies.
3. **Always-visible tabs** (item 2) — Moderate refactor of VisualizationPanel tab rendering.
4. **Move analysis button** (item 1) — Cross-component change (App.tsx ↔ ActionFeed.tsx), needs test updates.

---

## Summary of All Files Affected

| File | Changes |
|------|---------|
| `frontend/src/App.tsx` | Remove analysis button from contingency card, pass new props to ActionFeed |
| `frontend/src/components/ActionFeed.tsx` | Add `onRunAnalysis`/`canRunAnalysis` props, unified three-state button slot |
| `frontend/src/components/VisualizationPanel.tsx` | Always-visible tabs with placeholders, dynamic action tab label, collapsible voltage filter |
| `frontend/src/App.css` | Color scheme update (actions → purple-pink, contingency → yellow), overload glow, voltage toggle style |
| `frontend/src/utils/svgUtils.ts` | (Optional) Upgrade overload highlighting to clone-based approach |
| `frontend/src/utils/cssRegression.test.ts` | Update expected color values |
| `frontend/src/App.settings.test.tsx` | Update button text selector |
| `frontend/src/App.session.test.tsx` | Update button text selector |
| `standalone_interface.html` | Mirror all four changes in embedded CSS/JS |
