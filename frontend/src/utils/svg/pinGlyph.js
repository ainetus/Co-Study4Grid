// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
//
// Shared pin-glyph builder.
//
// This module is consumed in TWO different runtimes:
//
//  1. The React/TypeScript bundle — imported normally as an ES
//     module from `actionPinRender.ts` to render the Action
//     Overview pins.
//  2. The cross-origin overflow-graph iframe — read as text by
//     `expert_backend/services/overflow_overlay.py`, the `export`
//     prefixes are stripped, and the body is spliced into the
//     overlay <script> block. Same code, same shape, same palette.
//
// Hard rules to keep the dual-consumer pattern working:
//   - PLAIN JavaScript only (no TypeScript syntax).
//   - No `import` statements — the iframe runtime has no module
//     loader, so the file must be self-contained.
//   - All public values use `export const` / `export function` so
//     the backend's regex-strip pass can find them deterministically.

// --- Severity palette --------------------------------------------------
// Hex values mirror the React `pinColors` / `pinColorsDimmed` /
// `pinColorsHighlighted` design tokens (`frontend/src/styles/tokens.ts`).
// Duplicated here only because this file must be readable as a plain
// string by the backend; the TS side asserts the palette stays in
// sync via a regression test.

export const SEVERITY_FILL = {
    green: '#28a745',
    orange: '#f0ad4e',
    red: '#dc3545',
    grey: '#9ca3af',
};

export const SEVERITY_FILL_DIMMED = {
    green: '#a3c9ab',
    orange: '#dcd0b8',
    red: '#d4a5ab',
    grey: '#c8cdd2',
};

export const SEVERITY_FILL_HIGHLIGHTED = {
    green: '#1e9e3a',
    orange: '#e89e20',
    red: '#c82333',
    grey: '#7b8a96',
};

export const PIN_CHROME = {
    glyphBg: '#ffffff',
    glyphText: '#1f2937',
    gold: '#eab308',
    goldDark: '#a16207',
    crossFill: '#ef4444',
    crossStroke: '#b91c1c',
    feedBadge: '#1e40af',
};

const SVG_NS = 'http://www.w3.org/2000/svg';

// Opacity of a suggestion whose card the action feed still hides
// (progressive reveal). Its body keeps the severity colour — unlike
// the washed-out palette of rejected / un-simulated / filter-dimmed
// pins — so it reads as "same action, not listed yet".
export const FEED_HIDDEN_OPACITY = 0.45;

// 5-pointed star path centred at (cx, cy), `outerR` body radius.
export function pinStarPath(cx, cy, outerR) {
    const innerR = outerR * 0.4;
    const pts = [];
    for (let i = 0; i < 10; i++) {
        const angle = (Math.PI / 2) + (i * Math.PI / 5);
        const r = i % 2 === 0 ? outerR : innerR;
        pts.push((cx + r * Math.cos(angle)) + ',' + (cy - r * Math.sin(angle)));
    }
    return 'M ' + pts.join(' L ') + ' Z';
}

// Stylised X (cross) path centred at (cx, cy) with `halfW` half-width.
export function pinCrossPath(cx, cy, halfW) {
    const t = halfW * 0.25;
    return [
        'M ' + (cx - halfW) + ' ' + (cy - halfW + t),
        'L ' + (cx - t) + ' ' + cy,
        'L ' + (cx - halfW) + ' ' + (cy + halfW - t),
        'L ' + (cx - halfW + t) + ' ' + (cy + halfW),
        'L ' + cx + ' ' + (cy + t),
        'L ' + (cx + halfW - t) + ' ' + (cy + halfW),
        'L ' + (cx + halfW) + ' ' + (cy + halfW - t),
        'L ' + (cx + t) + ' ' + cy,
        'L ' + (cx + halfW) + ' ' + (cy - halfW + t),
        'L ' + (cx + halfW - t) + ' ' + (cy - halfW),
        'L ' + cx + ' ' + (cy - t),
        'L ' + (cx - halfW + t) + ' ' + (cy - halfW),
        'Z',
    ].join(' ');
}

// "Card shown in the feed" badge: a brand-blue disc carrying a white
// card glyph, on the upper-right rim of the bubble. Marks the
// suggestions whose card the action feed lists — the progressive
// reveal hides the others behind "Show N more" (their pins are drawn
// at FEED_HIDDEN_OPACITY). Appended to the body group so it follows
// the screen-constant pin rescale.
export function appendFeedBadge(doc, body, r) {
    const cx = r * 0.77;
    const cy = -r - r * 0.9 - r * 0.64;
    const badge = doc.createElementNS(SVG_NS, 'g');
    badge.setAttribute('class', 'cs4g-pin-feed-badge');
    const title = doc.createElementNS(SVG_NS, 'title');
    title.textContent = 'Card shown in the action feed';
    badge.appendChild(title);
    const disc = doc.createElementNS(SVG_NS, 'circle');
    disc.setAttribute('cx', String(cx));
    disc.setAttribute('cy', String(cy));
    disc.setAttribute('r', String(r * 0.38));
    disc.setAttribute('fill', PIN_CHROME.feedBadge);
    disc.setAttribute('stroke', PIN_CHROME.glyphBg);
    disc.setAttribute('stroke-width', String(r * 0.07));
    badge.appendChild(disc);
    const card = doc.createElementNS(SVG_NS, 'rect');
    card.setAttribute('x', String(cx - r * 0.2));
    card.setAttribute('y', String(cy - r * 0.14));
    card.setAttribute('width', String(r * 0.4));
    card.setAttribute('height', String(r * 0.28));
    card.setAttribute('rx', String(r * 0.05));
    card.setAttribute('fill', PIN_CHROME.glyphBg);
    badge.appendChild(card);
    // One "text line" across the card.
    const line = doc.createElementNS(SVG_NS, 'rect');
    line.setAttribute('x', String(cx - r * 0.12));
    line.setAttribute('y', String(cy - r * 0.03));
    line.setAttribute('width', String(r * 0.24));
    line.setAttribute('height', String(r * 0.06));
    line.setAttribute('fill', PIN_CHROME.feedBadge);
    badge.appendChild(line);
    body.appendChild(badge);
    return badge;
}

// Resolve the body fill given severity + status flags. Pulled out
// so callers can pre-compute the colour (e.g. for a connection-line
// stroke matching the pin body) without rebuilding a glyph.
export function resolvePinFill(severity, isSelected, isRejected, isDimmed) {
    const sev = severity || 'grey';
    if (isSelected) {
        return SEVERITY_FILL_HIGHLIGHTED[sev] || SEVERITY_FILL_HIGHLIGHTED.grey;
    }
    if (isRejected || isDimmed) {
        return SEVERITY_FILL_DIMMED[sev] || SEVERITY_FILL_DIMMED.grey;
    }
    return SEVERITY_FILL[sev] || SEVERITY_FILL.grey;
}

/**
 * Build a unitary action pin <g> in the Action-Overview shape.
 *
 * The returned group is anchored at (0,0) (its tip touches the
 * caller-supplied (x, y)). Caller is responsible for setting the
 * outer translate (e.g. via `transform="translate(x y)"`) — this
 * keeps the function reusable from layouts that already provide a
 * positioned parent group.
 *
 * @param {Document} doc       Owner document (parent or iframe).
 * @param {Object}   opts      Pin descriptor.
 * @param {string}   opts.severity   'green' | 'orange' | 'red' | 'grey'.
 * @param {string}   opts.label      Loading-rate label (e.g. '92%').
 * @param {string=}  opts.title      Native <title> tooltip text.
 * @param {string=}  opts.actionId   Stamped as `data-action-id`.
 * @param {boolean=} opts.isSelected Adds gold halo + star symbol.
 * @param {boolean=} opts.isRejected Adds red ✕ symbol + dim opacity.
 * @param {boolean=} opts.dimmed     Filter-dimmed (context only).
 * @param {string=}  opts.feed       Progressive reveal of the action
 *                                   feed: 'shown' (card listed — adds
 *                                   the feed badge) or 'hidden' (card
 *                                   not listed yet — whole pin at
 *                                   FEED_HIDDEN_OPACITY, colours kept).
 * @param {number}   opts.r          Body radius in user-space units.
 * @param {number=}  opts.labelFont  Override for the label font size.
 * @param {string=}  opts.bodyClass  Extra class for the inner body
 *                                   group (used by the rescale layer).
 * @returns {SVGGElement}
 */
export function createPinGlyph(doc, opts) {
    const sev = opts.severity || 'grey';
    const r = opts.r;
    const tail = r * 0.9;
    const labelFont = (typeof opts.labelFont === 'number')
        ? opts.labelFont
        : Math.max(9, r * 0.8);
    const isSelected = !!opts.isSelected;
    const isRejected = !!opts.isRejected;
    const dimmed = !!opts.dimmed;
    const feed = opts.feed === 'shown' || opts.feed === 'hidden' ? opts.feed : null;
    const fill = resolvePinFill(sev, isSelected, isRejected, dimmed);

    const g = doc.createElementNS(SVG_NS, 'g');
    g.setAttribute('class', 'cs4g-pin');
    if (opts.actionId) g.setAttribute('data-action-id', opts.actionId);
    g.setAttribute('data-severity', sev);
    if (isSelected) g.setAttribute('data-selected', 'true');
    if (isRejected) g.setAttribute('data-rejected', 'true');
    if (feed) g.setAttribute('data-feed', feed);

    const body = doc.createElementNS(SVG_NS, 'g');
    body.setAttribute('class', opts.bodyClass || 'cs4g-pin-body');
    body.setAttribute('transform', 'scale(1)');
    g.appendChild(body);

    if (opts.title) {
        const titleEl = doc.createElementNS(SVG_NS, 'title');
        titleEl.textContent = opts.title;
        body.appendChild(titleEl);
    }

    // Teardrop body: half-circle bubble UP, tip at (0, 0).
    const path = doc.createElementNS(SVG_NS, 'path');
    const d = 'M ' + (-r) + ' ' + (-r - tail) +
        ' A ' + r + ' ' + r + ' 0 1 1 ' + r + ' ' + (-r - tail) +
        ' L 0 0 Z';
    path.setAttribute('d', d);
    path.setAttribute('fill', fill);
    if (isSelected) {
        path.setAttribute('stroke', PIN_CHROME.gold);
        path.setAttribute('stroke-width', String(r * 0.12));
    } else {
        path.setAttribute('stroke', 'none');
    }
    body.appendChild(path);

    // Chrome circle (white background under the loading-rate label).
    const chrome = doc.createElementNS(SVG_NS, 'circle');
    chrome.setAttribute('cx', '0');
    chrome.setAttribute('cy', String(-r - tail));
    chrome.setAttribute('r', String(r * 0.72));
    chrome.setAttribute('fill', PIN_CHROME.glyphBg);
    chrome.setAttribute('fill-opacity', '0.92');
    chrome.setAttribute('pointer-events', 'none');
    body.appendChild(chrome);

    const text = doc.createElementNS(SVG_NS, 'text');
    text.setAttribute('x', '0');
    text.setAttribute('y', String(-r - tail));
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('dominant-baseline', 'central');
    text.setAttribute('font-size', String(labelFont));
    text.setAttribute('font-weight', '800');
    text.setAttribute('font-family', 'system-ui, -apple-system, Arial, sans-serif');
    text.setAttribute('fill', PIN_CHROME.glyphText);
    text.setAttribute('pointer-events', 'none');
    text.textContent = opts.label || '';
    body.appendChild(text);

    // Status symbol above the bubble — star (selected) or X (rejected).
    const symbolCy = -r - tail - r * 0.95;
    if (isSelected) {
        const star = doc.createElementNS(SVG_NS, 'path');
        star.setAttribute('d', pinStarPath(0, symbolCy, r * 0.45));
        star.setAttribute('fill', PIN_CHROME.gold);
        star.setAttribute('stroke', PIN_CHROME.goldDark);
        star.setAttribute('stroke-width', String(r * 0.05));
        star.setAttribute('pointer-events', 'none');
        body.appendChild(star);
    } else if (isRejected) {
        const cross = doc.createElementNS(SVG_NS, 'path');
        cross.setAttribute('d', pinCrossPath(0, symbolCy, r * 0.35));
        cross.setAttribute('fill', PIN_CHROME.crossFill);
        cross.setAttribute('stroke', PIN_CHROME.crossStroke);
        cross.setAttribute('stroke-width', String(r * 0.05));
        cross.setAttribute('pointer-events', 'none');
        body.appendChild(cross);
    }
    if (feed === 'shown') appendFeedBadge(doc, body, r);

    if (isRejected) g.setAttribute('opacity', '0.55');
    else if (dimmed) g.setAttribute('opacity', '0.4');
    else if (feed === 'hidden') g.setAttribute('opacity', String(FEED_HIDDEN_OPACITY));

    return g;
}
