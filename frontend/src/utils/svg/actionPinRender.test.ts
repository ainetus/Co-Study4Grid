// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from 'vitest';
import {
    applyActionOverviewPins,
    computePinScale,
    crossPath,
    readPinBaseRadius,
    starPath,
} from './actionPinRender';
import type { ActionPinInfo, CombinedPinInfo } from './actionPinData';
import { FEED_HIDDEN_OPACITY } from './pinGlyph';

describe('computePinScale', () => {
    it('keeps scale = 1 when baseR already exceeds both floors', () => {
        const { effectiveR, scale } = computePinScale(50, 10, 500);
        // minSvgR = 22/10 = 2.2, viewBoxMinR = 500/50 = 10 → baseR 50 wins.
        expect(effectiveR).toBe(50);
        expect(scale).toBe(1);
    });

    it('grows the pin when the screen floor dominates (low zoom)', () => {
        // pxPerSvgUnit = 0.5 → minSvgR = 22 / 0.5 = 44, baseR = 30.
        const { effectiveR, scale } = computePinScale(30, 0.5, 500);
        expect(effectiveR).toBe(44);
        expect(scale).toBeCloseTo(44 / 30, 5);
    });

    it('grows the pin when the viewBox-fraction floor dominates', () => {
        // viewBox extent 5000 → viewBoxMinR = 100.
        const { effectiveR, scale } = computePinScale(30, 10, 5000);
        expect(effectiveR).toBe(100);
        expect(scale).toBeCloseTo(100 / 30, 5);
    });

    it('handles zero viewBox gracefully (returns baseR)', () => {
        const { effectiveR, scale } = computePinScale(30, 10, 0);
        // minSvgR = 22/10 = 2.2, viewBoxMinR = 0 → baseR 30 wins.
        expect(effectiveR).toBe(30);
        expect(scale).toBe(1);
    });
});

describe('readPinBaseRadius', () => {
    const makeSvg = (html: string): SVGSVGElement => {
        const parser = new DOMParser();
        const doc = parser.parseFromString(
            `<svg xmlns="http://www.w3.org/2000/svg">${html}</svg>`,
            'image/svg+xml',
        );
        return doc.documentElement as unknown as SVGSVGElement;
    };

    it('reads r from the first .nad-vl-nodes circle when present', () => {
        const svg = makeSvg(
            '<g class="nad-vl-nodes"><circle r="42"/></g><circle r="99"/>',
        );
        expect(readPinBaseRadius(svg)).toBe(42);
    });

    it('falls back to any circle[r] when no .nad-vl-nodes group', () => {
        const svg = makeSvg('<circle r="17"/>');
        expect(readPinBaseRadius(svg)).toBe(17);
    });

    it('falls back to 30 for SVGs without circles', () => {
        const svg = makeSvg('<rect width="10" height="10"/>');
        expect(readPinBaseRadius(svg)).toBe(30);
    });

    it('falls back to 30 when the first circle has a bogus radius', () => {
        const svg = makeSvg('<circle r="NaN"/>');
        expect(readPinBaseRadius(svg)).toBe(30);
    });
});

describe('starPath', () => {
    it('produces a closed SVG path with 10 vertices', () => {
        const d = starPath(0, 0, 10);
        expect(d.startsWith('M ')).toBe(true);
        expect(d.endsWith(' Z')).toBe(true);
        const lCount = d.split(' L ').length - 1;
        // 10 vertices → 1 M + 9 L-separators.
        expect(lCount).toBe(9);
    });
});

describe('crossPath', () => {
    it('produces a closed 12-vertex path centred at the given coordinates', () => {
        const d = crossPath(0, 0, 10);
        expect(d.startsWith('M ')).toBe(true);
        expect(d.endsWith('Z')).toBe(true);
        // Count `L ` tokens — cross has 11 Ls after the initial M (12 vertices).
        const lCount = d.split(' L ').length - 1;
        expect(lCount).toBe(11);
    });
});

describe('applyActionOverviewPins — progressive reveal of the feed', () => {
    const makeContainer = () => {
        const container = document.createElement('div');
        container.innerHTML = '<svg viewBox="0 0 400 400"></svg>';
        return container;
    };
    const pin = (id: string, x: number): ActionPinInfo => ({
        id, x, y: 100, severity: 'green', label: '60%', title: id,
    });
    const combined: CombinedPinInfo = {
        pairId: 'a+b', action1Id: 'a', action2Id: 'b',
        p1: { x: 50, y: 100 }, p2: { x: 150, y: 100 },
        x: 100, y: 60, label: '55%', title: 'a+b', severity: 'green',
    };

    const pinOf = (container: HTMLElement, id: string) => container.querySelector(`[data-action-id="${id}"]`);

    it('badges the pins whose card the feed lists, unitary and combined', () => {
        const container = makeContainer();
        applyActionOverviewPins(container, [pin('a', 50), pin('b', 150), pin('c', 250)], () => {}, undefined, {
            combinedPins: [combined],
            feedReveal: { displayedIds: new Set(['a', 'a+b']), hiddenIds: new Set(['b']) },
        });
        expect(pinOf(container, 'a')?.getAttribute('data-feed')).toBe('shown');
        expect(pinOf(container, 'a')?.querySelector('.cs4g-pin-feed-badge')).toBeTruthy();
        expect(pinOf(container, 'a+b')?.getAttribute('data-feed')).toBe('shown');
        expect(pinOf(container, 'a+b')?.querySelector('.nad-action-overview-pin-body .cs4g-pin-feed-badge')).toBeTruthy();
        for (const other of ['b', 'c']) {
            expect(pinOf(container, other)?.querySelector('.cs4g-pin-feed-badge')).toBeNull();
        }
    });

    it('fades hidden suggestions only — unitary and combined, curve included', () => {
        const container = makeContainer();
        applyActionOverviewPins(container, [pin('a', 50), pin('b', 150), pin('c', 250)], () => {}, undefined, {
            combinedPins: [combined],
            feedReveal: { displayedIds: new Set(['a']), hiddenIds: new Set(['b', 'a+b']) },
        });
        const hiddenOpacity = String(FEED_HIDDEN_OPACITY);
        expect(pinOf(container, 'b')?.getAttribute('data-feed')).toBe('hidden');
        expect(pinOf(container, 'b')?.getAttribute('opacity')).toBe(hiddenOpacity);
        expect(pinOf(container, 'a+b')?.getAttribute('data-feed')).toBe('hidden');
        expect(pinOf(container, 'a+b')?.getAttribute('opacity')).toBe(hiddenOpacity);
        expect(container.querySelector('.nad-combined-action-curve')?.getAttribute('opacity')).toBe(hiddenOpacity);
        // Listed, and not a suggestion of the feed at all: full opacity.
        expect(pinOf(container, 'a')?.hasAttribute('opacity')).toBe(false);
        expect(pinOf(container, 'c')?.hasAttribute('data-feed')).toBe(false);
        expect(pinOf(container, 'c')?.hasAttribute('opacity')).toBe(false);
    });

    it('leaves every pin as is when the reveal state is not wired', () => {
        const container = makeContainer();
        applyActionOverviewPins(container, [pin('a', 50)], () => {}, undefined, { combinedPins: [combined] });
        expect(container.querySelector('.cs4g-pin-feed-badge')).toBeNull();
        expect(container.querySelector('[data-feed]')).toBeNull();
        expect(container.querySelector('.nad-combined-action-curve')?.hasAttribute('opacity')).toBe(false);
    });
});

describe('applyActionOverviewPins — overlapping pins', () => {
    const makeContainer = () => {
        const container = document.createElement('div');
        container.innerHTML = '<svg viewBox="0 0 400 400"></svg>';
        return container;
    };
    const pin = (id: string, x: number, y = 100): ActionPinInfo => ({
        id, x, y, severity: 'green', label: '60%', title: id,
    });
    const pinOf = (container: HTMLElement, id: string) =>
        container.querySelector(`.nad-action-overview-pin[data-action-id="${id}"]`);

    it('spreads pins sharing an anchor, each with a leader line back to it', () => {
        const container = makeContainer();
        applyActionOverviewPins(container, [pin('a', 100), pin('b', 100), pin('far', 380, 380)], () => {});
        const a = pinOf(container, 'a');
        const b = pinOf(container, 'b');
        // The groups stay on the anchor; their glyphs move apart.
        expect(a?.getAttribute('transform')).toBe('translate(100 100)');
        expect(b?.getAttribute('transform')).toBe('translate(100 100)');
        const offA = a?.querySelector('.cs4g-pin-offset')?.getAttribute('transform');
        const offB = b?.querySelector('.cs4g-pin-offset')?.getAttribute('transform');
        expect(offA).toBeTruthy();
        expect(offA).not.toBe(offB);
        expect(a?.querySelector('.cs4g-pin-leader')).not.toBeNull();
        expect(b?.querySelector('.cs4g-pin-anchor')).not.toBeNull();
        // A pin with room around it stays put, without a leader.
        expect(pinOf(container, 'far')?.querySelector('.cs4g-pin-leader')).toBeNull();
    });
});
