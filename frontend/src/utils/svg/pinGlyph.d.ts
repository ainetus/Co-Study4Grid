// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// SPDX-License-Identifier: MPL-2.0
//
// TypeScript declarations for the shared JS pin-glyph module. The
// implementation lives in ``pinGlyph.js`` because it has to be
// readable as plain text by the FastAPI backend (which inlines it
// into the iframe overlay).

export type PinSeverity = 'green' | 'orange' | 'red' | 'grey';

/** Progressive reveal of the action feed: card listed, or not yet. */
export type PinFeedState = 'shown' | 'hidden';

export interface PinGlyphOptions {
    severity: PinSeverity;
    label?: string;
    title?: string;
    actionId?: string;
    isSelected?: boolean;
    isRejected?: boolean;
    /** Filter-dimmed pin (kept visible only because a passing combined
     *  action references it).  Distinct from ``isRejected``. */
    dimmed?: boolean;
    /** Progressive reveal of the suggestions: 'shown' (card listed in
     *  the action feed) adds the feed badge; 'hidden' draws the whole
     *  pin at ``FEED_HIDDEN_OPACITY``, severity colours kept. */
    feed?: PinFeedState;
    /** Body radius in user-space units. */
    r: number;
    /** Optional override for the label font size (default = max(9, r*0.8)). */
    labelFont?: number;
    /** Optional CSS class for the inner <g> body group (used by the
     *  rescale layer in ``actionPinRender.ts``). */
    bodyClass?: string;
}

export const FEED_HIDDEN_OPACITY: number;
export const SEVERITY_FILL: Record<PinSeverity, string>;
export const SEVERITY_FILL_DIMMED: Record<PinSeverity, string>;
export const SEVERITY_FILL_HIGHLIGHTED: Record<PinSeverity, string>;
export const PIN_CHROME: {
    glyphBg: string;
    glyphText: string;
    gold: string;
    goldDark: string;
    crossFill: string;
    crossStroke: string;
    feedBadge: string;
    strokeNeutral: string;
};

export function pinStarPath(cx: number, cy: number, outerR: number): string;
export function pinCrossPath(cx: number, cy: number, halfW: number): string;
export function appendFeedBadge(
    doc: Document,
    body: SVGGElement,
    r: number,
): SVGGElement;
export function resolvePinFill(
    severity: PinSeverity,
    isSelected: boolean,
    isRejected: boolean,
    isDimmed: boolean,
): string;
export function createPinGlyph(
    doc: Document,
    opts: PinGlyphOptions,
): SVGGElement;

/** Footprint pitch of a pin, in radii (horizontal / vertical). */
export const SPREAD_PITCH_X: number;
export const SPREAD_PITCH_Y: number;
/** Tip positions that keep every pin visible — see ``pinGlyph.js``. */
export function spreadPins(
    anchors: ReadonlyArray<{ x: number; y: number }>,
    r: number,
): Array<{ x: number; y: number }>;
/** Offset a pin's glyph from its anchor, with a leader line back to it. */
export function setPinOffset(
    doc: Document,
    g: SVGGElement,
    dx: number,
    dy: number,
    r: number,
): void;
