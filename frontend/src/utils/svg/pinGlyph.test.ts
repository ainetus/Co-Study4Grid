// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from 'vitest';
import {
    appendFeedBadge,
    createPinGlyph,
    FEED_HIDDEN_OPACITY,
    PIN_CHROME,
    pinStarPath,
    pinCrossPath,
    resolvePinFill,
    SEVERITY_FILL,
    SEVERITY_FILL_DIMMED,
    SEVERITY_FILL_HIGHLIGHTED,
} from './pinGlyph';
import { pinChrome, pinColors, pinColorsDimmed, pinColorsHighlighted } from '../../styles/tokens';

describe('pinGlyph palette parity with design tokens', () => {
    // The palette in pinGlyph.js is duplicated by necessity (the
    // file is read raw by the backend). This regression test fails
    // loudly if either side drifts from the design-token source.
    it('SEVERITY_FILL mirrors pinColors', () => {
        expect(SEVERITY_FILL).toEqual({ ...pinColors });
    });
    it('SEVERITY_FILL_DIMMED mirrors pinColorsDimmed', () => {
        expect(SEVERITY_FILL_DIMMED).toEqual({ ...pinColorsDimmed });
    });
    it('SEVERITY_FILL_HIGHLIGHTED mirrors pinColorsHighlighted', () => {
        expect(SEVERITY_FILL_HIGHLIGHTED).toEqual({ ...pinColorsHighlighted });
    });
    it('PIN_CHROME mirrors the matching pinChrome tokens', () => {
        for (const [key, hex] of Object.entries(PIN_CHROME)) {
            expect(pinChrome[key as keyof typeof pinChrome], key).toBe(hex);
        }
    });
});

describe('resolvePinFill', () => {
    it('returns highlighted hex when isSelected', () => {
        expect(resolvePinFill('orange', true, false, false))
            .toBe(SEVERITY_FILL_HIGHLIGHTED.orange);
    });
    it('returns dimmed hex when isRejected', () => {
        expect(resolvePinFill('red', false, true, false))
            .toBe(SEVERITY_FILL_DIMMED.red);
    });
    it('returns dimmed hex when only dimmed flag is set', () => {
        expect(resolvePinFill('green', false, false, true))
            .toBe(SEVERITY_FILL_DIMMED.green);
    });
    it('returns base hex by default', () => {
        expect(resolvePinFill('grey', false, false, false))
            .toBe(SEVERITY_FILL.grey);
    });
    it('falls back to grey when severity is unknown', () => {
        expect(resolvePinFill('unknown' as unknown as 'grey', false, false, false))
            .toBe(SEVERITY_FILL.grey);
    });
});

describe('pinStarPath / pinCrossPath', () => {
    it('star path closes its sub-path', () => {
        const d = pinStarPath(0, 0, 10);
        expect(d.startsWith('M')).toBe(true);
        expect(d.endsWith('Z')).toBe(true);
    });
    it('cross path closes its sub-path', () => {
        const d = pinCrossPath(0, 0, 10);
        expect(d.startsWith('M')).toBe(true);
        expect(d.endsWith('Z')).toBe(true);
    });
});

describe('createPinGlyph', () => {
    const SVG_NS = 'http://www.w3.org/2000/svg';

    const makeSvg = () => {
        const svg = document.createElementNS(SVG_NS, 'svg');
        document.body.appendChild(svg);
        return svg;
    };

    it('builds an SVG <g> with the expected chrome layers', () => {
        const svg = makeSvg();
        const g = createPinGlyph(document, {
            severity: 'orange',
            label: '92%',
            r: 20,
            actionId: 'A1',
        });
        svg.appendChild(g);
        // Body group + path + chrome circle + label text.
        expect(g.getAttribute('data-action-id')).toBe('A1');
        expect(g.getAttribute('data-severity')).toBe('orange');
        expect(g.querySelector('path')).toBeTruthy();
        expect(g.querySelector('circle')).toBeTruthy();
        const text = g.querySelector('text');
        expect(text?.textContent).toBe('92%');
    });

    it('adds a star symbol when isSelected', () => {
        const svg = makeSvg();
        const g = createPinGlyph(document, {
            severity: 'green', label: '50%', r: 20, isSelected: true,
        });
        svg.appendChild(g);
        // Star is a separate <path> on top of the body path. Two
        // paths in total: bubble + star.
        expect(g.querySelectorAll('path').length).toBe(2);
        expect(g.getAttribute('data-selected')).toBe('true');
    });

    it('adds a cross symbol and dim opacity when isRejected', () => {
        const svg = makeSvg();
        const g = createPinGlyph(document, {
            severity: 'red', label: '88%', r: 20, isRejected: true,
        });
        svg.appendChild(g);
        expect(g.querySelectorAll('path').length).toBe(2);
        expect(g.getAttribute('data-rejected')).toBe('true');
        expect(g.getAttribute('opacity')).toBe('0.55');
    });

    it('uses the dimmed palette when only `dimmed` is set', () => {
        const svg = makeSvg();
        const g = createPinGlyph(document, {
            severity: 'green', label: '12%', r: 20, dimmed: true,
        });
        svg.appendChild(g);
        const bodyPath = g.querySelector('path');
        expect(bodyPath?.getAttribute('fill')).toBe(SEVERITY_FILL_DIMMED.green);
        expect(g.getAttribute('opacity')).toBe('0.4');
    });

    it('adds the feed badge when the card is listed in the action feed', () => {
        const svg = makeSvg();
        const g = createPinGlyph(document, {
            severity: 'green', label: '61%', r: 20, feed: 'shown',
        });
        svg.appendChild(g);
        expect(g.getAttribute('data-feed')).toBe('shown');
        expect(g.hasAttribute('opacity')).toBe(false);
        const badge = g.querySelector('.cs4g-pin-feed-badge');
        expect(badge).toBeTruthy();
        // Inside the body group, so the screen-constant rescale scales it.
        expect(badge?.parentElement?.getAttribute('class')).toBe('cs4g-pin-body');
        expect(badge?.querySelector('circle')?.getAttribute('fill')).toBe(PIN_CHROME.feedBadge);
        expect(badge?.querySelector('title')?.textContent).toBe('Card shown in the action feed');
    });

    it('draws no feed badge by default', () => {
        const g = createPinGlyph(document, { severity: 'green', label: '61%', r: 20 });
        expect(g.hasAttribute('data-feed')).toBe(false);
        expect(g.querySelector('.cs4g-pin-feed-badge')).toBeNull();
    });

    it('fades a suggestion the feed still hides, keeping its severity colour', () => {
        const g = createPinGlyph(document, {
            severity: 'orange', label: '94%', r: 20, feed: 'hidden',
        });
        expect(g.getAttribute('data-feed')).toBe('hidden');
        expect(g.getAttribute('opacity')).toBe(String(FEED_HIDDEN_OPACITY));
        expect(FEED_HIDDEN_OPACITY).toBeGreaterThan(0);
        expect(FEED_HIDDEN_OPACITY).toBeLessThan(1);
        // Full severity fill — not the washed-out palette of rejected /
        // un-simulated / filter-dimmed pins.
        expect(g.querySelector('path')?.getAttribute('fill')).toBe(SEVERITY_FILL.orange);
        expect(g.querySelector('.cs4g-pin-feed-badge')).toBeNull();
    });

    it('places the badge on the upper-right rim of the bubble, clear of the top symbol slot', () => {
        const body = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        const badge = appendFeedBadge(document, body, 10);
        const disc = badge.querySelector('circle');
        const cx = Number(disc?.getAttribute('cx'));
        const cy = Number(disc?.getAttribute('cy'));
        const rb = Number(disc?.getAttribute('r'));
        // Bubble centre is (0, -19) with radius 10: the badge centre sits on its rim.
        expect(Math.hypot(cx, cy + 19)).toBeCloseTo(10, 0);
        expect(cx).toBeGreaterThan(0);
        // A combined pin's "+" badge (radius 3.5) sits at (0, -28.5), the
        // slot of the star / cross — which never meet the feed badge.
        expect(Math.hypot(cx, cy + 28.5)).toBeGreaterThan(rb + 3.5);
    });
});
