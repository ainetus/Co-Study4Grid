# UI design critique — Co-Study4Grid frontend

**Status**: Proposal / review. **Recommendations 1-5 have all landed
between 2026-05-01 and 2026-05-02.**

| # | Recommendation | Status | Landed in |
|---|---|---|---|
| 1 | Design-token layer | ✅ Full | 47a2700 / 0e60059 / b8de481 (2026-05-01 → 2026-05-02) — Phases A/B/C |
| 2 | Progressive-disclosure ActionCard | ✅ Full | fbfb2b0 (PR #121, 2026-05-02) |
| 3 | Cap NAD overload halo at zoom | ✅ Full | fbfb2b0 (PR #121, 2026-05-02) — screen-space halo, originally a discrete `data-zoom-tier` cap; superseded 2026-06-20 by a **continuous** zoom-adaptive width (`--nad-halo-w` driven by usePanZoom: thin ~24px when zoomed in → grows toward 120px when zoomed out, no tier snap) |
| 4 | Tier the warning system | ✅ Full | tier-warning-system PR (2026-05-02) — NoticesPanel pill + inline contextual hints |
| 5 | Diagram legend | ✅ Full | tier-warning-system PR (2026-05-02) — collapsible bottom-right per tab |

**Recommendation #4 (tier the warning system, 2026-05-02).** The
five concurrent yellow `#fff3cd` banners called out below were
consolidated into a single sidebar-header **NoticesPanel** pill plus
small grey **inline contextual hints** under the relevant control,
following the recommendation verbatim:

- New `frontend/src/components/NoticesPanel.tsx` — pill with a
  count badge in the sidebar header (above `SidebarSummary`).
  Clicking expands a panel of `Notice` cards. Each card carries an
  optional `action` (e.g. "Open settings") and optional `onDismiss`
  handler. The pill self-hides when the live notice list goes to
  zero.
- `App.tsx` builds the active `Notice[]` from the existing
  dismissable state machinery (`showActionDictNotice`,
  `showRecommenderNotice`, `showMonitoringWarning`). Three notices
  feed the panel today: `action-dict` (info), `monitoring-coverage`
  (warning), `recommender-thresholds` (info).
- `OverloadPanel.tsx` — the inline yellow monitoring-coverage
  banner is gone. The component now accepts a `monitoringHint`
  string and renders it as one short grey line under the heading
  ("130/150 lines monitored — see Notices for details.").
- `ActionFeed.tsx` — the inline "Action dictionary" yellow banner
  and the "Recommender Settings" yellow banner have been removed.
  The two overlap warnings (manual / rejected vs. analysis) have
  been **demoted to inline contextual hints** — small grey italic
  text instead of a full yellow box. A new
  `overviewFilteredOutCount` hint surfaces under the Suggested /
  Rejected header when the overview filter hides cards: "5 actions
  hidden by the overview filter." — closing the loop the
  recommendation specifically called for.
- New tests: `NoticesPanel.test.tsx` (6 cases — pill counter, dialog
  toggle, dismiss callback, action button, auto-hide on empty),
  `DiagramLegend.test.tsx` (8 cases — collapse/expand, per-tab row
  set, voltage-level note, VL-names hidden hint).
- Test churn: the obsolete inline-banner tests in
  `ActionFeed.test.tsx`, `OverloadPanel.test.tsx`, and
  `App.stateManagement.test.tsx` were removed or rewritten to
  match the new contract; two App-level prop-passing tests are
  `it.skip`-ped with rationale comments because the props they
  guarded (`recommenderConfig`, `onDismissWarning`,
  `onOpenSettings` on OverloadPanel) no longer flow through the
  ActionFeed / OverloadPanel boundary.

**Recommendation #5 (add a diagram legend, 2026-05-02).** New
`frontend/src/components/DiagramLegend.tsx` — a small "Legend"
pill in the bottom-right of every diagram tab that expands into a
collapsible panel listing the on-screen colour conventions:
- N tab: overloaded line (orange halo), disconnected branch (dashed
  grey), voltage-level palette note.
- N-1 tab: contingency (yellow halo), overloaded line, flow-up
  delta (orange line), flow-down delta (blue line), disconnected
  branch, voltage-level palette note.
- Action tab: contingency, action target (pink halo), overloaded
  line, flow-up / flow-down deltas, disconnected branch, voltage-
  level palette note.
- The panel also surfaces a "Voltage-level names are hidden — toggle
  VL next to Inspect to show them" hint when the operator has the
  VL-names toggle off, closing the largest onboarding gap visible
  in the original screenshot review.
- The legend is collapsed by default — the bottom-right pill is
  small enough to never compete with the network when the operator
  is scanning; click to expand, click ✕ to collapse.

The original recommendations from the code-only review and
screenshot review remain below for traceability. The
recommendations they describe are now historical — see the table
above for the landing commits.

**Recommendation #1 (design-token layer)
landed in full 2026-05-01 → 2026-05-02** across three commits.
`frontend/src/styles/tokens.{css,ts}` defines the semantic palette:
~24 colors (Tailwind blue-ramp brand, Bootstrap warning/danger/success,
info-cyan family for curtailment, accent-purple family for PST tap
edits), 4/8 spacing scale, 6 type sizes, 3 radii, diagram-signal
colors (overload, contingency, action-target soft/strong/darker,
breaker, deltas), and the action-overview pin palette
(severity green/orange/red/grey × base/dimmed/highlighted, plus pin
chrome — glyph background, label text, gold star, rejected cross,
neutral stroke). All inline-style components AND the SVG-emitting
pin renderer are migrated; ActionFeed / VisualizationPanel test
assertions read the `var(--…)` strings. The
`scripts/check_code_quality.py` gate now requires **zero** hex
literals outside the token files (down from ~654 pre-migration,
518 after Phase A, 56 after Phase B).

**Phase A** (commit 47a2700, 2026-05-01) — token scaffold + global
CSS + 4 representative components (Header, StatusToasts,
SidebarSummary, OverloadPanel) + ratcheting gate.

**Phase B** (commit 0e60059, 2026-05-01) — 14 inline-style
components (ActionTypeFilterChips, ConfirmationDialog, AppSidebar,
ActionCardPopover, ErrorBoundary, ReloadSessionModal,
CombinedActionsModal, SldOverlay, ComputedPairsTable, SettingsModal,
ActionSearchDropdown, ActionCard, ExplorePairsTab, ActionFeed,
VisualizationPanel) + test-assertion updates.

**Phase C** (2026-05-02) — the three SVG-emitting files that use
`setAttribute('fill', …)` for raw SVG presentation attributes:
- `frontend/src/utils/svg/actionPinData.ts` — severity triplets
  (green/orange/red/grey × base/dimmed/highlighted) now alias the
  `pinColors` / `pinColorsDimmed` / `pinColorsHighlighted` exports
  from `tokens.ts`.
- `frontend/src/utils/svg/actionPinRender.ts` — pin glyph fills
  (white inner, dark text, gold star, red cross, neutral stroke)
  now read from `pinChrome`.
- `frontend/src/components/ActionOverviewDiagram.tsx` — legend
  swatch `color={pinColors.green}` etc., plus all the inline-style
  chrome migrated to `colors.*` var() refs.
- `frontend/src/index.css` — the `#242424` dark-mode placeholder
  now uses `var(--color-surface-dark)`.

The Phase C compromise: `tokens.ts` is the runtime source of truth
for pin colours (raw hex strings) because browsers don't reliably
resolve `var(--…)` inside SVG presentation attributes set via
`setAttribute`, and unit tests assert on the resolved hex via
`getAttribute('fill')`. `tokens.css` mirrors the same values for
future CSS-only consumers. Both `tokens.css` and `tokens.ts` are
exempt from the hex-literal gate. Nothing else is.
**Date**: 2026-05-01 (updated same day with screenshot review)
**Method**: Initial pass was a code-only review of `frontend/src/`.
A second pass cross-checked the findings against a screenshot of the
running app on `bare_env_small_grid_test` with one contingency
(`ARGIAL71CANTE`) and a combined remedial action selected
(`disco_BERG9L61CANTE+pst_tap_ARKA_TD_661_inc2`), with the SLD
overlay open on `CANTEP6` and the Overflow Analysis PDF detached to
a side window. Corrections from that pass are folded inline; a
running list lives at the end of the doc under "Screenshot review —
confirmations and corrections". File-path + line-number citations
are included throughout so each finding can be sanity-checked
against the real surface.

This doc supersedes the ad-hoc `frontend-ui-improvements.md` log for
*new* visual-design work; that file remains the record of the changes
already shipped (voltage filter, run-button placement, etc.). When any
finding here lands, migrate the relevant section into a `features/`
doc and remove it from this critique.

---

## TL;DR

The interaction design is thoughtful — sticky sidebar summary,
severity-coded action cards, "Make a first guess" empty state, tied
detached tabs. The visual layer has not kept pace. Three competing
color systems (Flat UI, Bootstrap, Tailwind), 273 hex literals, 464
inline `style={{}}` blocks, no design tokens, and ~20 distinct
emoji acting as primary navigation glyphs.

The headline opportunities (re-ranked after screenshot review):

1. **Design-token layer** — replace 273 hex literals + 202 numeric
   font sizes with a small semantic token set.
2. **Progressive-disclosure pass on `ActionCard`** — at-rest cards
   show 5 fields, not 15.
3. **Cap NAD overload halo size** — small CSS change, large
   legibility win. *Promoted from "Moderate" after screenshot
   confirmed the halos dwarf network detail at typical zoom.*
4. Warning-tier consolidation, then diagram legend. See
   "Priority recommendations" below.

Most other findings fall out of these.

---

## Scope

What was read:

- `frontend/src/App.tsx` (state hub)
- `frontend/src/App.css` and `frontend/src/index.css`
- `frontend/src/components/Header.tsx`
- `frontend/src/components/AppSidebar.tsx` and `SidebarSummary.tsx`
- `frontend/src/components/OverloadPanel.tsx`
- `frontend/src/components/ActionFeed.tsx`
- `frontend/src/components/ActionCard.tsx`
- `frontend/src/components/StatusToasts.tsx`
- `frontend/src/components/modals/SettingsModal.tsx` (head)
- `frontend/src/components/VisualizationPanel.tsx` (head)

What was *not* read in depth (and is therefore not covered here):

- `CombinedActionsModal`, `ComputedPairsTable`, `ExplorePairsTab`,
  `ActionSearchDropdown`, `ActionCardPopover`, `SldOverlay`,
  `ActionOverviewDiagram`, `DetachableTabHost`,
  `ReloadSessionModal`, `ConfirmationDialog`.

When the recommendations below are scheduled, those surfaces should
get a follow-up pass.

---

## First impression (2-second read)

*Updated from screenshot.* The eye actually lands first on the NAD
view's halo highlights — a large yellow halo (the contingency line)
and a large pink halo (the action target) dominate the centre panel.
This is **the right hierarchy** for a contingency tool: the operator's
job is to look at the network, and the network leads. The original
code-only critique that "buttons in the Header outweigh the title"
was overstated — at rendered scale the dark-slate Header reads as
neutral chrome, the brand is legible, and the four primary buttons
(Load Study, Save Results, Reload Session, Settings) sit right-aligned
without competing with the diagram below.

Two real first-impression problems remain:

- **The halos are too large at typical zoom.** Both the yellow
  contingency halo and the pink action-target halo are sized in grid
  units, so at this zoom level they are roughly 8-10× the visual
  weight of the line they highlight. They identify *which area* to
  look at but obscure the network detail underneath. See
  "Diagram visualization" below.
- **No legend or color key anywhere on screen.** The NAD shows lines
  in purple, red, orange, green, and dashed variants; the detached
  Overflow PDF uses red / orange / green coloured ovals; the SLD
  overlay introduces yet another palette. None of it is explained on
  the surface. A new operator has to learn the conventions
  out-of-band. This is a meaningful onboarding gap.

---

## Usability

| Finding | Severity | Recommendation |
|---|---|---|
| **Warning fatigue.** Five different yellow `#fff3cd` banners can stack in the sidebar simultaneously: action-dictionary info (`ActionFeed.tsx:761`), recommender-settings hint (`ActionFeed.tsx:917`), selected-action overlap (`ActionFeed.tsx:794`), rejected-action overlap (`ActionFeed.tsx:969`), monitoring-coverage warning (`OverloadPanel.tsx:140`). Each has a Dismiss × button, so users will reflexively close them — losing genuinely useful info. | Moderate | Tier them. Errors stay in the toast (`StatusToasts.tsx`). Persistent constraints (recommender thresholds, monitoring scope) belong as a small "context" line under the relevant section, not a yellow banner. Reserve the banner pattern for one warning at a time. |
| **`ActionCard` is doing the work of three components.** A single card carries: severity badge, description, optional load-shedding edit row, optional curtailment edit row, optional PST tap edit row, islanding warning, voltage-level badges, line badges, "Loading after" line list, max-loading link, ⭐ / ❌ buttons, plus a vertical "VIEWING" ribbon when active (`ActionCard.tsx:193-413`). At 12px font on a 25%-width sidebar, this is dense to the point of being hard to scan. | Critical | Collapse the editable detail rows into an "Edit parameters" disclosure that expands only on the *viewing* card. Move the inline ⭐ / ❌ to a hover-revealed action group. The card should at-rest show: rank, ID, severity, max ρ, primary target — five fields, not fifteen. |
| **Two-step analysis flow is not signposted.** The user has to (a) pick a contingency, (b) optionally toggle which N-1 overloads to monitor (double-click in `OverloadPanel.tsx:99-106`, undocumented in the UI itself except via a hover tooltip on a `?` glyph), (c) click "Analyze & Suggest", (d) click "Display N prioritized actions". The double-click toggle is invisible — the `?` help bubble (`OverloadPanel.tsx:194`) is the only affordance. | Moderate | Make the toggle explicit (a checkbox in front of each N-1 overload, or "Include in analysis" on hover). The "Display N prioritized actions" step looks redundant with "Analyze & Suggest" — consider auto-displaying once analysis completes, with a "Re-run" button instead. |
| **Emoji as primary affordance.** ⚡ 📄 🔄 💾 ⚙️ 🎯 🔍 ⚠️ 💡 📊 ⛔ 📐 🔓 🔒 🏝️ ⭐ ❌ across the chrome. Emoji rendering is OS-dependent (Apple's ⚠️ is yellow, Microsoft's is orange, some Linux fontconfig setups render as monochrome boxes). On a workstation that may run Windows or Linux in a control room, this is a brand-consistency risk. | Moderate | Replace navigation/action emoji with `lucide-react` icons (already in `package.json`). Keep emoji only where they are user data (e.g. severity legends), not as button glyphs. |
| **Network path lives in two places.** Header has a path input (`Header.tsx:60-91`); Settings → Paths has the same field (`SettingsModal.tsx:91-97`) — the modal carries a "Synchronized with the banner field" hint (line 92). Two-source-of-truth UIs always confuse some operators. | Minor | Pick one. The header field is faster for the common case (load → study → switch); the modal could show the path read-only with an "Edit in header" affordance. |
| **Keyboard navigation through the action feed.** No visible tabindex management — pressing Tab cycles through every nested button, edit input, and underlined link inside each `ActionCard`. With 20+ cards visible after analysis, that's hundreds of stops. | Moderate | Wrap each card in a single keyboard-focusable shell with `role="article"`; expose card-level commands (select, reject, view) via keyboard shortcuts and a screen-reader-friendly menu. |

---

## Visual hierarchy

**What draws the eye first** *(corrected from screenshot)*: the NAD
halos in the centre panel — yellow (contingency) and pink (action
target). This is the correct lead. The Header reads as supporting
chrome, not as a competing focal point.

**Reading flow**: top-to-bottom in the sidebar (Sticky summary →
Select Contingency → Overloads → Action feed) is correct, and the
section weights actually work better at rendered scale than the
source suggested. The 11px sticky summary (`SidebarSummary.tsx:48`)
*is* small, but it sits against a darker grey and reads as
"persistent state" rather than primary content — appropriate for a
status strip. The bigger consistency miss is that **each section
still uses different conventions**: the Overloads panel mixes
`⚠️ N-1 Overloads:` (left-aligned, 14px) with a tiny `?` help bubble
and an inline checkbox; the Action feed jumps to 14-15px headers with
pill counters; the sticky summary uses dotted-underline links.
A unified treatment of "section header + counter + inline actions"
would tighten the rhythm noticeably.

**Specific emphasis problems**:

- Card heading `#1 — load_shedding_X` at 12px (`ActionCard.tsx:248-256`)
  is *smaller* than the severity badge next to it (11px bold,
  color-filled). Confirmed in screenshot — the "Still overloaded"
  pill consistently reads louder than the action ID.
- The "VIEWING" vertical ribbon (`ActionCard.tsx:224-244`).
  *Corrected from screenshot.* At rendered scale it is less dominant
  than the source suggested — it reads as a quiet vertical accent
  rather than shouting. The heavier signals on the viewing card are
  actually the light-blue card background and the inline editable
  PST tap row. The ribbon itself is fine; it is the surrounding
  weight (background change + extra controls) that combines into a
  visually heavy state.
- The "Analyze & Suggest" CTA uses a gradient
  `linear-gradient(135deg, #27ae60, #2ecc71)` with a colored
  drop-shadow (`ActionFeed.tsx:878-882`) — the only gradient in the
  app. Not visible in the captured screenshot (the analysis has
  already run), but worth flagging because it breaks the otherwise-
  flat aesthetic.

**Whitespace**: tight throughout. Cards have 10px padding, sidebar has
15px padding, Overloads panel has 8px. There is no breathing room
between dense elements — the sidebar feels packed even when it has
only three cards in it.

---

## Diagram visualization

*Section added after screenshot review.* This was not visible from the
source alone — the rendered NAD, SLD overlay, and detached Overflow
PDF together raise their own design issues.

| Finding | Severity | Recommendation |
|---|---|---|
| **Overload halo size dwarfs the network it highlights.** The yellow contingency halo and pink action-target halo are sized in grid units, so at typical operator zoom they cover roughly 8-10× the area of the line they identify. Useful for "where do I look", actively unhelpful for "what is happening on this line". The halos in the screenshot occlude several substations and a half-dozen connecting lines. See `App.css:140-167` (stroke-width 150px in grid units). | Critical | Cap the halo's *visual* width. Either (a) switch to a screen-space stroke (`vector-effect: non-scaling-stroke` is already used elsewhere — apply it here too) capped at e.g. 24px, or (b) keep the grid-unit stroke for zoomed-out overview but fade to a thinner outline + glow at zoom-tier `region` and `detail`. The existing `data-zoom-tier` infrastructure (`App.css:44-66`) is the right hook. |
| **No legend / color key on screen.** Lines render in purple (most), red, orange, green, with solid and dashed variants. The detached Overflow PDF uses a totally different palette (red / orange / green colored ovals). The SLD overlay introduces a third. None of it is explained on the surface. | Moderate | Add a small collapsible legend in the bottom-right of each diagram tab. At minimum: contingency (yellow halo), action target (pink halo), overloaded line (orange halo), disconnected branch (dashed), nominal voltage colors (the existing voltage-range slider already has the data — extend it with color swatches). |
| **Tab title truncation hides important context.** The Remedial Action tab reads `Remedial Action: disco_BERG9L61CANTE+pst_tap_ARKA…` — the action ID is truncated mid-token. For combined actions this loses the second leg entirely. | Moderate | Use a two-line tab label (small grey "Remedial Action" line + larger truncated ID line with a `title` attribute holding the full ID), or move the action ID into a separate breadcrumb-style strip below the tab row. |
| **The detached PDF graph is more legible than the live NAD.** The Overflow Analysis panel on the right shows a node-graph visualization (substations as labeled colored ovals, flow arrows between them, percentages on edges) that reads dramatically clearer than the geographically-laid-out NAD next to it. It is doing less — fewer lines, no geographic constraint, larger node labels — but the operator can absorb the post-action flow picture in seconds from the PDF and only minutes from the NAD. | Insight, not action | Worth understanding *why* the PDF reads better and whether any of those choices (larger node labels at zoom-tier `overview`, cleaner edge routing on overload paths) can be borrowed into the NAD. Possible follow-up doc, not an immediate change. |
| **SLD overlay floats over the NAD rather than docking.** The `CANTEP6 Flows` overlay in the screenshot occludes a sizable portion of the network it was opened from. The user can drag-resize but cannot dock it to a side panel. | Minor | Offer a "dock left" / "dock right" affordance in the overlay header, or auto-position it on the side opposite the selected voltage level. The existing detached-tabs infrastructure (`useDetachedTabs`) is most of the plumbing already. |

---

## Consistency

This is the single largest gap. Numbers from the codebase:

- **464 inline `style={{}}` declarations** across 21 component files
- **273 hardcoded hex colors** across 24 files
- **202 numeric `fontSize:` declarations** across 19 files
- **0 design tokens, CSS variables, or utility classes** for color /
  spacing / typography

The hex values reveal three competing color systems living together:

| System | Where | Sample colors |
|---|---|---|
| Flat UI | Header, StatusToasts, sliders | `#2c3e50`, `#3498db`, `#e74c3c`, `#27ae60`, `#7f8c8d` |
| Bootstrap | ActionFeed CTAs, modals, tooltips | `#007bff`, `#dc3545`, `#28a745`, `#856404`, `#fff3cd` |
| Tailwind | ActionCard sub-rows, SidebarSummary | `#1e40af`, `#dbeafe`, `#fef3c7`, `#92400e`, `#d1fae5` |

A single `ActionCard` renders blue links from Tailwind (`#1e40af`), a
yellow shedding box from Tailwind (`#fef3c7` / `#92400e`), a cyan
curtailment box from Tailwind (`#e0f2fe` / `#075985`), a purple PST
box from Tailwind (`#f3e8ff` / `#6b21a8`), and a Bootstrap-blue
"VIEWING" ribbon (`#007bff`) — five sub-systems on one card.

Other consistency issues:

- Type sizes range from 10px to 22px without a clear scale. Common:
  10, 11, 12, 13, 14 (minor steps), then jumps to 1.1rem (~17.6px)
  and back. No `--font-size-md` etc.
- Spacing values: 2, 3, 4, 5, 6, 7, 8, 10, 12, 15, 20, 25 — every
  multiple of 1px is in play. No 4 / 8 grid.
- Border radii: 3, 4, 6, 8, 10, 12 — same fragmentation.
- The "underlined-dotted clickable link" pattern is reimplemented in
  `OverloadPanel`, `SidebarSummary`, and `ActionCard` with subtly
  different colors and weights. This is the most obvious component
  that has not yet been extracted.

---

## Accessibility

Best-effort review from source — no live contrast measurement.

- **Body text below 12px is common.** SidebarSummary is 11px
  (`SidebarSummary.tsx:48`), Overloads list is 12px
  (`OverloadPanel.tsx:170`), tooltips are 10px (`ActionFeed.tsx:995`),
  the VIEWING ribbon is 10px. WCAG does not set a hard size minimum,
  but human-factors literature flags <12px as fatiguing for sustained
  reading — and grid operators *will* read this for hours.
- **Color-only state encoding.** Selected vs. deselected overloads
  differ by hex (`#1e40af` vs `#bdc3c7`) plus font weight
  (`OverloadPanel.tsx:91-95`). For deuteranomaly (~5% of men) the
  blue-vs-grey distinction at 11-12px will be subtle. Pair with an
  icon (✓ vs ✗) or add underline / strikethrough.
- **Low-contrast pair to verify.** `#bdc3c7` on `#ffffff` (deselected
  overloads on white) — approximately 1.7:1, well below WCAG AA's
  4.5:1. The intent is "barely visible" but the same style is used in
  clickable text. Run a contrast checker on this pair.
- **Severity badges rely on color + text.** The text labels
  ("Solves overload", "Solved — low margin", "Still overloaded") help,
  but they sit inside same-color-as-border pills at 11px — so the
  *first* read is color-only. Pair with a small icon (`CheckCircle` /
  `AlertTriangle` / `XCircle` from `lucide-react`).
- **Touch targets.** Underlined dotted "links" in `OverloadPanel` and
  `SidebarSummary` are 11px with 0 padding (`OverloadPanel.tsx:65-76`).
  About 12-14×16px. Fine for mouse; below 44×44 for touch. Likely not
  a use case here, but worth noting if control-room touchscreens are
  in scope.
- **Focus styles** rely on browser defaults — none of the inline
  styles override `:focus`. With background-colored buttons everywhere,
  the default outline may be invisible on the colored fills. Add
  explicit `:focus-visible` rings via a CSS class.

---

## What works well

- **The "Make a first guess" empty state** (`ActionFeed.tsx:819-842`)
  is genuinely good guided onboarding — dashed border, soft hover,
  clear CTA, and it disappears once analysis starts (line 815-818).
  Exactly the right pattern for a tool with a non-obvious entry path.
- **The sticky `SidebarSummary`** (`AppSidebar.tsx:58-66`) keeps the
  contingency and N-1 overloads visible while the rest of the sidebar
  scrolls. Real operational thinking — the operator never loses the
  "what am I working on" anchor.
- **Severity logic on `ActionCard`** (`ActionCard.tsx:75-88`) handles
  the surprising states (`non_convergence`, `is_islanded`) by
  *replacing* the severity verdict, not stacking on top of it. That is
  the right call — divergence and islanding are not shades of severity,
  they are different verdicts entirely.
- **Branch search via `<datalist>`** (`AppSidebar.tsx:71-86`) gives
  operators native autocomplete with name + ID display labels
  (`App.tsx:241`). For a tool with thousands of branches this is the
  right primitive.
- **Detachable + tied tabs** (`useDetachedTabs`, `useTiedTabsSync`).
  The side-by-side comparison workflow they enable is core to this
  domain and surprisingly rare in network-analysis tools. Keep it.
- **Comments preserve a lot of design rationale** (e.g. why "Loading
  before" was removed from cards, `ActionCard.tsx:374-378`). That is a
  sign of considered design even where the visual layer is rough.
- **Detached panel reattach affordance** (visible in the screenshot's
  right-hand Overflow Analysis pane). The "Reattach" button is
  clearly labeled, in the panel header, with an arrow-back icon —
  the user is never stuck in detached mode. Good.
- **The right hierarchy at first glance.** The NAD with its halos
  carries the focal weight, the sidebar provides context, the Header
  recedes. This is correct for a contingency tool and is the kind of
  outcome that is easy to get wrong by overdesigning the chrome.

---

## Priority recommendations

### 1. Stand up a design-token layer first

Before any visual work, replace the 273 hex literals and 202 numeric
font sizes with a small token set:

- ~12 semantic colors: surface, border, text-primary / secondary /
  tertiary, brand, success, warning, danger, accent.
- A 4 / 8 spacing scale.
- 6 type sizes (e.g. xs 11, sm 12, md 14, lg 16, xl 20, xxl 24).
- 3 radii (sm 4, md 6, lg 8).

Pick one of the three palettes (Tailwind's blue-50…900 ramp is the
closest fit for what is already there) and migrate. This single change
probably resolves half the consistency issues mechanically and gives
you a place to enforce dark-mode if it ever becomes a requirement.

The CONTRIBUTING.md gate already enforces "no `any`" — add "no inline
hex" once the token layer exists. The `check_code_quality.py` script
is the right place to land that rule.

### 2. Redesign `ActionCard` around progressive disclosure

At rest: rank, ID, severity badge with icon, max ρ%, primary target.
On hover: ⭐ / ❌ slide in from the right edge. On viewing-state: the
parameter editors (load shedding / curtailment / PST tap) expand
inline; everything else stays terse. Drop the vertical "VIEWING"
ribbon — a left-edge accent stripe at higher saturation does the same
job at lower visual cost. This is the single largest scannability win
available.

Open question: the editable MW / tap inputs are currently always
visible. Hiding them behind a disclosure changes the muscle-memory of
operators who already know the workflow. Likely worth a quick check
with two or three operators before committing.

### 3. Cap NAD overload halo size

*Promoted from "Moderate" finding to top-three after screenshot
review.* At the current zoom level the halos cover so much of the
network that they hurt more than they help. Either switch to a
screen-space stroke capped at ~24px or leverage the existing
`data-zoom-tier` infrastructure (`App.css:44-66`) to shrink the halo
at `region` and `detail` zoom tiers. This is a small CSS change with
a disproportionately large legibility win — it is the cheapest of the
top three to land.

### 4. Tier the warning system  *(Landed 2026-05-02 — see header summary.)*

Replace the five concurrent yellow banners with:

- One toast for transient errors (already in place via
  `StatusToasts.tsx`).
- A single "Notices" pill in the sidebar header that opens a panel
  listing active warnings (action-dict info, recommender thresholds,
  monitoring coverage).
- Inline contextual hints (small grey text under the relevant control)
  for things like "5 actions filtered out by the overview filter".

The cumulative warning load is currently teaching users to ignore
yellow. *Note: the captured screenshot has analysis already complete
and only one non-zero overload condition active, so none of the five
banners are visible — this finding remains a code-only inference. It
should be re-validated by replicating the multi-warning state.*

**What landed:** new `NoticesPanel` (sidebar pill +
collapsible panel), three `Notice` entries fed from App.tsx
(`action-dict`, `monitoring-coverage`, `recommender-thresholds`),
inline `monitoringHint` on `OverloadPanel`, inline grey overlap
hints inside `ActionFeed`, and a brand-new "X actions hidden by
the overview filter" inline counter. Multi-warning state was
reproducible during development by leaving an action dictionary
loaded but unused while the recommender thresholds were still in
their default values — all three notices appear at once and
collapse into the single pill.

### 5. Add a diagram legend  *(Landed 2026-05-02 — see header summary.)*

Smallest standalone improvement on the list. A collapsible legend in
the bottom-right of each diagram tab — covering halo colors,
disconnection styling, and voltage-level color mapping — would close
the largest onboarding gap visible in the screenshot.

**What landed:** `frontend/src/components/DiagramLegend.tsx`. A
small bottom-right "Legend" pill on the N / N-1 / Action tabs that
expands into a panel listing contingency / action-target /
overload halos, flow-delta direction colours, the dashed-grey
disconnection convention, and a voltage-level palette note plus
a VL-names-hidden reminder. Per-tab row sets (e.g. action target
only on the action tab) so the legend never claims more than the
diagram itself shows.

---

## Screenshot review — confirmations and corrections

A second pass against a real screenshot (analysis run on
`bare_env_small_grid_test`, contingency `ARGIAL71CANTE`, combined
remedial action selected, SLD overlay open on `CANTEP6`, Overflow
Analysis PDF detached) shifted several findings. Recorded here so the
provenance of each claim stays clear.

**Corrected (claim was overstated in the code-only pass):**

- *"Header buttons outweigh the brand."* Not really — at rendered
  scale the Header reads as neutral chrome. Brand is legible. Removed
  from First Impression and Visual Hierarchy.
- *"The VIEWING ribbon out-shouts the card content."* The ribbon
  itself is quiet; what reads as heavy on a viewing card is the
  combination of light-blue background + inline editable controls.
  Updated.
- *"Three near-identical sidebar greys with no clear edge."* The
  edges are clearer at rendered scale than the source suggested.
  Removed.

**Confirmed (visible in screenshot, finding stands):**

- ActionCard density. The selected combined action carries header +
  description + two badge links + editable PST tap row + re-simulate
  button + Loading after + Max loading + viewing ribbon — ~7 vertical
  rows in a card on a ~350px-wide sidebar. Critical-severity finding
  unchanged.
- Severity badges read louder than action IDs. "Still overloaded"
  pills are the loudest text on each suggested card.
- Emoji-as-affordance throughout (yellow stars, red ✕s, ⚠️s, 🎯s,
  🔍s). All visible.
- Sticky `SidebarSummary` works as designed — the operator can see
  the current contingency and N-1 overload while scrolling the
  action feed.

**New (only visible at render time):**

- NAD overload halos dwarf network detail at typical zoom. Promoted
  to a top-three priority recommendation.
- No on-screen legend or color key. New "Add a diagram legend"
  recommendation.
- Tab title truncation on long action IDs (e.g.
  `disco_BERG9L61CANTE+pst_tap_ARKA…`).
- The detached Overflow PDF reads dramatically clearer than the live
  NAD next to it. Worth a separate investigation; flagged as insight
  rather than action.
- SLD overlay floats over the NAD rather than docking — minor.

**Still unverified:**

- Multi-warning state (all five `#fff3cd` banners stacked). The
  captured run only triggers one or two conditions, so the cumulative
  warning load remains a code-only inference.
- Behaviour with realistic data volume. The captured run shows ~10
  suggested actions; the density problem may scale non-linearly with
  ~50+ actions on `pypsa_eur_fr400`.
- Emoji rendering on non-macOS workstations.

---

## Related docs

- [`features/frontend-ui-improvements.md`](../features/frontend-ui-improvements.md) — record of UI changes already shipped.
- [`features/action-overview-diagram.md`](../features/action-overview-diagram.md) — the pin-overlay surface, not yet covered here.
- [`architecture/code-quality-analysis.md`](../architecture/code-quality-analysis.md) — broader quality audit; the design-token gap is a natural follow-up to its frontend findings.
- [`proposals/new-features-brainstorm-mars26.md`](new-features-brainstorm-mars26.md) — feature ideas; some (Cmd+K, shortcuts) intersect with the keyboard-nav finding above.
