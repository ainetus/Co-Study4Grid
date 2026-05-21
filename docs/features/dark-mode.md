# Dark Mode

Co-Study4Grid ships a light/dark theme toggle. The whole UI re-themes
from a single source of truth — the design-token CSS custom properties
in `frontend/src/styles/tokens.css` — so a theme switch is one DOM
attribute flip, not a per-component restyle.

This document is the contract: where the theme lives, how it
propagates, what the diagram / overflow-viewer special-cases are, and
which tests guard each piece.

---

## 1. How the theme is selected

| Layer | What it does |
|-------|--------------|
| Pre-mount script (`frontend/index.html`) | Reads `localStorage['cs4g-theme']` (or the OS `prefers-color-scheme`) **before React mounts** and sets `<html data-theme="…">` + `colorScheme`. Avoids a flash of light theme on a dark reload. |
| `useTheme` hook (`frontend/src/hooks/useTheme.ts`) | Owns the React-side theme state. Applies `data-theme` + `color-scheme` to `<html>`, persists to `localStorage`, exposes `theme` / `toggleTheme` / `setTheme`. |
| `resolveInitialTheme()` | Pure resolver shared in spirit with the inline script: persisted value → OS preference → `light`. Tolerates a missing `localStorage` / `matchMedia`. |
| Header toggle (`components/Header.tsx`) | Sun/moon button (`data-testid="header-theme-toggle"`) calling `toggleTheme`. `☾` in light mode, `☀` in dark. |

The selected theme is recorded as the interaction event
`theme_toggled { theme }` (declared in the `InteractionType` union,
mirrored in `specConformance.test.ts` and
`scripts/check_standalone_parity.py`).

> **Note on multiple `useTheme()` instances.** The hook keeps local
> `useState`, so two components calling `useTheme()` do **not** share a
> re-render. The single source of truth across the app is the
> `<html data-theme>` attribute. Consumers that need to react to a
> theme change without owning the toggle (e.g. `useOverflowIframe`)
> observe that attribute with a `MutationObserver` rather than reading
> React state.

---

## 2. Tokens are the single source of truth

`frontend/src/styles/tokens.css` defines every colour as a CSS custom
property under `:root` (light) with a `[data-theme="dark"]` override
block. `tokens.ts` exposes typed `var(--…)` accessors for inline
`style` objects. **The code-quality gate enforces zero hex literals
outside `tokens.css` / `tokens.ts`** — so adding a dark variant means
editing only the token files, and the whole UI follows.

Dark mode flips the **chrome** tokens (surfaces, borders, text, brand,
state colours, accent). It deliberately does **not** flip the
domain-signal tokens (`--signal-*`, the action-pin palette) because
those encode grid semantics and are rendered onto a diagram backdrop.

### Tokens added for dark mode

| Token | Why |
|-------|-----|
| `--color-diagram-surface` | Backdrop behind the pypowsybl NAD/SLD (white in light, near-black `#0c0f13` in dark). The SVG is transparent, so the container *is* the diagram background. |
| `--color-diagram-veil` | Semi-opaque veil painted over a diagram while a new one loads (translucent white → translucent near-black). |
| `--color-text-on-bright` | Dark ink that stays dark in **both** themes — for text sitting on a solid bright fill (warning-yellow badge, the load-shedding "Re-simulate" button). The `*-text` tokens are tuned for the matching `*-soft` background and flip light in dark mode, so they can't be used on a bright fill. |

---

## 3. The "soft-background" trap

The recurring dark-mode bug class: a control styled `background: <X>Soft`
+ `color: <X>Text` reads fine in light mode (pale bg, dark text) but in
dark mode `<X>Soft` becomes dark while `<X>Text` becomes light — so a
control with a **solid bright** fill (`colors.warning`, `colors.brand`)
ends up with low-contrast text. Two fixes are used:

- **Solid bright fill** (always bright in both themes) → text =
  `colors.textOnBright` (badge) or `colors.textOnBrand` (active toggle
  segments: Flows/Impacts, Hierarchical/Geo, the VL-names button, tabs).
- **Soft fill** (pale in light, dark in dark) → the `*-text` token is
  correct, no change needed.

When adding a toggle/badge: if the active background is a solid brand /
state colour, set the text to `textOnBrand` / `textOnBright`, never to
`colors.surface` or a `*-text` token.

---

## 4. Diagram (NAD/SLD) legibility

pypowsybl bakes voltage-coded line colours into the SVG via an inline
`<style>` and renders on a transparent canvas. Dark-mode handling lives
in `frontend/src/App.css` under `[data-theme="dark"]`:

- **Canvas** — `.svg-container { background: var(--color-diagram-surface) }`
  goes near-black. Lines keep their semantic colours (they read on dark).
- **NAD flow values** (`.nad-edge-infos text`) — recoloured light. The
  white "halo" pypowsybl strokes under each value (via `paint-order`)
  is repainted in the backdrop colour so light text isn't fringed/fuzzy.
- **NAD VL labels** — HTML `<div>`s inside `<foreignObject>` (not
  `<text>`). Given light text + a dark chip.
- **Action-overview dim rect** — the `.nad-overview-dim-rect` is set to
  `fill="white"` inline for light mode; a CSS `fill: var(--color-diagram-surface)`
  rule (a CSS property beats the inline presentation attribute) makes it
  dim toward near-black, so it no longer leaves a grey square over the
  dark canvas.
- **SLD labels** (`[data-testid="sld-overlay"] text`) — recoloured
  light, **excluding** `sld-delta-text-*` so the flow-delta
  positive/negative/neutral colouring is preserved.

> **Pin labels are deliberately untouched.** Action-overview pins are
> `<text>` with their own dark-on-white glyph fills written via
> `setAttribute`. The NAD text rules are class-scoped (`.nad-edge-infos`,
> not a blanket `text`) precisely so pin labels stay readable.

---

## 5. Overflow Analysis viewer (iframe)

The Overflow Analysis tab embeds a third-party HTML graph viewer in an
iframe served from the backend. Theming it requires both sides:

- **Frontend** (`hooks/useOverflowIframe.ts`) — posts a
  `cs4g:theme { theme }` message to the iframe on overlay-ready and
  whenever `<html data-theme>` flips (watched via `MutationObserver`).
- **Backend** (`expert_backend/services/overflow_overlay.py`) — the
  `inject_overlay()` injector (run at serve time on every
  `/results/pdf/*.html` request) adds:
  - a `cs4g:theme` message handler that sets `<html data-cs4g-theme>`,
  - a dark stylesheet keyed off `html[data-cs4g-theme="dark"]`:
    body / `#sidebar` / `#stage` surfaces, the white graphviz canvas
    polygon repainted dark, and **edge** fixes scoped to `g.edge`:
    flow-value labels lightened, grey "null redispatch" edges →
    near-white, black "overload" edges → red (`#ef4444`). Node
    ellipses and their labels are never touched.

> Because the dark CSS + handler are injected **server-side**, a change
> to `overflow_overlay.py` requires a **backend restart** to take
> effect — the long-running uvicorn process serves the old injection
> until then.

---

## 6. Tests

| Spec | Test |
|------|------|
| Theme resolution / persistence / `<html>` apply / toggle / `theme_toggled` log | `frontend/src/hooks/useTheme.test.ts` |
| Header toggle glyph + aria-label + document flip | `frontend/src/components/Header.test.tsx` (`dark-mode toggle`) |
| Overflow viewer: `cs4g:theme` handler, dark chrome surfaces, canvas repaint, edge label/colour retargets, `g.edge` scoping | `expert_backend/tests/test_overflow_overlay.py` (`TestDarkTheme`) |

---

## 7. Adding a dark variant for a new colour

1. Add the token to `:root` in `tokens.css`, and its dark value in the
   `[data-theme="dark"]` block.
2. Add the typed accessor to `tokens.ts`.
3. Use `colors.<name>` (inline styles) or `var(--…)` (CSS). Never inline
   a hex — the gate (`scripts/check_code_quality.py`) fails on it.
4. If it's text on a **solid bright** fill, use `textOnBright` /
   `textOnBrand` instead of a `*-text` token (see §3).
