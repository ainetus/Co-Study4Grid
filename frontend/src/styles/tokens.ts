// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0

// Token consumers for inline styles. Mirrors `tokens.css`. Values are
// `var(--…)` strings so the resolved color/size lives in one place
// (the CSS custom property) — TypeScript is just a typed accessor.
//
// Use this in components that build `style={{ … }}` objects:
//   import { colors, space, text, radius } from '../styles/tokens';
//   <div style={{ background: colors.surface, padding: space[3] }} />
//
// CSS files keep using `var(--color-brand)` directly.

export const colors = {
  surface: 'var(--color-surface)',
  surfaceMuted: 'var(--color-surface-muted)',
  surfaceRaised: 'var(--color-surface-raised)',
  diagramSurface: 'var(--color-diagram-surface)',
  diagramVeil: 'var(--color-diagram-veil)',

  border: 'var(--color-border)',
  borderSubtle: 'var(--color-border-subtle)',
  borderStrong: 'var(--color-border-strong)',

  textPrimary: 'var(--color-text-primary)',
  textSecondary: 'var(--color-text-secondary)',
  textTertiary: 'var(--color-text-tertiary)',
  textOnBrand: 'var(--color-text-on-brand)',

  brand: 'var(--color-brand)',
  brandStrong: 'var(--color-brand-strong)',
  brandSoft: 'var(--color-brand-soft)',
  brandMid: 'var(--color-brand-mid)',

  success: 'var(--color-success)',
  successStrong: 'var(--color-success-strong)',
  successSoft: 'var(--color-success-soft)',
  successText: 'var(--color-success-text)',

  warning: 'var(--color-warning)',
  warningStrong: 'var(--color-warning-strong)',
  warningSoft: 'var(--color-warning-soft)',
  warningBorder: 'var(--color-warning-border)',
  warningText: 'var(--color-warning-text)',

  danger: 'var(--color-danger)',
  dangerStrong: 'var(--color-danger-strong)',
  dangerSoft: 'var(--color-danger-soft)',
  dangerText: 'var(--color-danger-text)',

  accent: 'var(--color-accent)',
  accentSoft: 'var(--color-accent-soft)',
  accentBorder: 'var(--color-accent-border)',
  accentText: 'var(--color-accent-text)',
  chrome: 'var(--color-chrome)',
  chromeSoft: 'var(--color-chrome-soft)',
  disabled: 'var(--color-disabled)',

  info: 'var(--color-info)',
  infoSoft: 'var(--color-info-soft)',
  infoBorder: 'var(--color-info-border)',
  infoText: 'var(--color-info-text)',
} as const;

export const space = {
  0: 'var(--space-0)',
  half: 'var(--space-half)',
  1: 'var(--space-1)',
  2: 'var(--space-2)',
  3: 'var(--space-3)',
  4: 'var(--space-4)',
  5: 'var(--space-5)',
  6: 'var(--space-6)',
  7: 'var(--space-7)',
} as const;

export const text = {
  xs: 'var(--text-xs)',
  sm: 'var(--text-sm)',
  md: 'var(--text-md)',
  lg: 'var(--text-lg)',
  xl: 'var(--text-xl)',
  xxl: 'var(--text-xxl)',
} as const;

export const radius = {
  sm: 'var(--radius-sm)',
  md: 'var(--radius-md)',
  lg: 'var(--radius-lg)',
} as const;

// Action-overview pin palette — RAW HEX VALUES (not var() refs).
//
// The pin renderer (utils/svg/actionPinRender.ts) writes these into
// raw SVG `fill="…"` attributes via setAttribute. Browsers don't
// reliably resolve `var(--…)` inside SVG presentation attributes
// (only via CSS), and the unit tests in
// `ActionOverviewDiagram.test.tsx` assert on the resolved hex value
// (`getAttribute('fill') === '#28a745'`). So this file IS the
// source-of-truth for pin colours; `tokens.css` mirrors them only
// for future CSS consumers.
//
// Adding a hex literal here is permitted (`tokens.ts` is exempt from
// the hex-literal gate alongside `tokens.css`). Anywhere else,
// import and reuse these constants instead of inlining the hex.

export const pinColors = {
  green: '#28a745',
  orange: '#f0ad4e',
  red: '#dc3545',
  grey: '#9ca3af',
} as const;

// `var(--…)` mirror of `pinColors` for use inside inline `style`
// objects (where the browser DOES resolve custom properties). The
// raw-hex `pinColors` export above stays reserved for SVG
// presentation attributes set via `setAttribute`, which don't.
export const pinColorVars = {
  green: 'var(--pin-green)',
  orange: 'var(--pin-orange)',
  red: 'var(--pin-red)',
  grey: 'var(--pin-grey)',
} as const;

export const pinColorsDimmed = {
  green: '#a3c9ab',
  orange: '#dcd0b8',
  red: '#d4a5ab',
  grey: '#c8cdd2',
} as const;

export const pinColorsHighlighted = {
  green: '#1e9e3a',
  orange: '#e89e20',
  red: '#c82333',
  grey: '#7b8a96',
} as const;

export const pinChrome = {
  glyphBg: '#ffffff',
  glyphText: '#1f2937',
  strokeNeutral: '#6b7280',
  gold: '#eab308',
  goldDark: '#a16207',
  crossFill: '#ef4444',
  crossStroke: '#b91c1c',
} as const;
