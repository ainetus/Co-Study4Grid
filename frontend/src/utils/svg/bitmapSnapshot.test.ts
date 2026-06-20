// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { buildSnapshotSvg, collectHighlightCss } from './bitmapSnapshot';

const makeSvg = (inner: string): SVGSVGElement => {
    const doc = new DOMParser().parseFromString(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="50" height="50">${inner}</svg>`,
        'image/svg+xml',
    );
    return doc.documentElement as unknown as SVGSVGElement;
};

describe('buildSnapshotSvg', () => {
    it('strips foreignObjects (canvas taint) but keeps the highlight clones', () => {
        const svg = makeSvg(
            '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">L</div></foreignObject>'
            + '<g id="nad-background-layer"><path class="nad-overloaded nad-highlight-clone" d="M0,0"/></g>',
        );
        const clone = buildSnapshotSvg(svg, {
            baseVb: { x: 1, y: 2, w: 30, h: 40 }, width: 800, height: 600, zoomTier: 'detail',
        });
        expect(clone.querySelectorAll('foreignObject').length).toBe(0);
        expect(clone.querySelector('path.nad-overloaded')).toBeTruthy();
        expect(clone.getAttribute('viewBox')).toBe('1 2 30 40');
        expect(clone.getAttribute('width')).toBe('800');
        expect(clone.getAttribute('height')).toBe('600');
        expect(clone.getAttribute('data-zoom-tier')).toBe('detail');
        // the live SVG must be left untouched
        expect(svg.querySelectorAll('foreignObject').length).toBe(1);
    });

    it('injects the provided css as a leading <style> (so var() tokens resolve first)', () => {
        const svg = makeSvg('<path/>');
        const clone = buildSnapshotSvg(svg, {
            baseVb: { x: 0, y: 0, w: 1, h: 1 }, width: 10, height: 10,
            css: 'svg{--signal-overload:#f00}\n.nad-overloaded path{stroke:var(--signal-overload)}',
        });
        const style = clone.querySelector('style');
        expect(style).toBeTruthy();
        expect(style!.textContent).toContain('--signal-overload');
        expect(clone.firstElementChild?.tagName.toLowerCase()).toBe('style');
    });
});

describe('collectHighlightCss', () => {
    it('collects only the highlight/delta/edge-info rules from the stylesheets', () => {
        const style = document.createElement('style');
        style.textContent =
            '.nad-overloaded path { stroke: orange; }'
            + '.some-unrelated-class { color: green; }'
            + '.nad-delta-positive polyline { stroke: blue; }';
        document.head.appendChild(style);
        try {
            const css = collectHighlightCss(document);
            expect(css).toContain('nad-overloaded');
            expect(css).toContain('nad-delta-positive');
            expect(css).not.toContain('some-unrelated-class');
            // Base non-scaling-stroke must be re-asserted or branch/delta lines
            // render sub-pixel (user-space) in the detached clone.
            expect(css).toContain('vector-effect:non-scaling-stroke');
        } finally {
            document.head.removeChild(style);
        }
    });
});
