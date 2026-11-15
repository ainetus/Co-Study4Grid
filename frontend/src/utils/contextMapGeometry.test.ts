// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import { describe, it, expect } from 'vitest';
import type { ContextMapData, ContextMapHighlight } from '../types';
import {
    FIGURE_WIDTH_PT, PROD_REF_MW, RENDER_SIZE,
    arcControl, arrowHead, arrowWidthPt, formatMw, highlightBox, pieSlices, polylineMidpoint, productionMix, ptUnit,
    rampColor, renderScale, trimmedArc, volumeRadiusPt, type Point,
} from './contextMapGeometry';

const length = (pts: Point[]) =>
    pts.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]), 0);

describe('Carte-Front sizing', () => {
    it('one point is the view width over the 649-pt map axes', () => {
        expect(ptUnit([0, 0, 649, 100])).toBe(1);
        expect(ptUnit([0, 0, 100, 1298])).toBe(1298 / FIGURE_WIDTH_PT);
    });

    it('pie radius: area ∝ MW, clipped between 0.5 and 1.5 inch diameters', () => {
        expect(volumeRadiusPt(PROD_REF_MW)).toBeCloseTo(0.75 * 72);
        expect(volumeRadiusPt(10 * PROD_REF_MW)).toBeCloseTo(0.75 * 72);
        expect(volumeRadiusPt(0)).toBeCloseTo(0.25 * 72);
        expect(volumeRadiusPt(PROD_REF_MW / 4)).toBeCloseTo(0.375 * 72);
        expect(volumeRadiusPt(PROD_REF_MW, PROD_REF_MW, 0.5)).toBeCloseTo(0.375 * 72);
    });

    it('arrow width grows with √(|value| / vmax) from 1.4 to 8.5 pt', () => {
        expect(arrowWidthPt(0, 100)).toBeCloseTo(1.4);
        expect(arrowWidthPt(-100, 100)).toBeCloseTo(8.5);
        expect(arrowWidthPt(25, 100)).toBeCloseTo(1.4 + 7.1 * 0.5);
        expect(arrowWidthPt(10, 0)).toBeCloseTo(1.4);
    });
});

describe('arc3 arrows', () => {
    it('bends a positive rad to the same visual side as matplotlib (SVG y down)', () => {
        // Left → right with rad > 0, matplotlib (y up) puts the control point
        // below the chord: cy = y12 − rad·dx. Below is a LARGER y in SVG.
        const [cx, cy] = arcControl([0, 0], [10, 0], 0.2);
        expect(cx).toBeCloseTo(5);
        expect(cy).toBeCloseTo(2);
        expect(arcControl([0, 0], [10, 0], 0)).toEqual([5, 0]);
    });

    it('trims the curve by the requested lengths at both ends', () => {
        const full = trimmedArc([0, 0], [10, 0], 0, 0, 0)!;
        const cut = trimmedArc([0, 0], [10, 0], 0, 2, 3)!;
        expect(length(full)).toBeCloseTo(10);
        expect(cut[0][0]).toBeCloseTo(2);
        expect(cut[cut.length - 1][0]).toBeCloseTo(7);
        expect(trimmedArc([0, 0], [10, 0], 0, 6, 6)).toBeNull();
    });

    it('finds the point halfway along a polyline, by length', () => {
        // Where a transfer value sits on the country mesh: mid VISIBLE arrow.
        expect(polylineMidpoint([[0, 0], [2, 0], [2, 6]])).toEqual([2, 2]);
        const cut = trimmedArc([0, 0], [10, 0], 0, 1, 5)!;
        expect(polylineMidpoint(cut)[0]).toBeCloseTo(3);
        expect(polylineMidpoint([[4, 4]])).toEqual([4, 4]);
    });

    it('stops the shaft at the head base, the head pointing at the tip', () => {
        const { shaft, head } = arrowHead([[0, 0], [5, 0], [10, 0]], 2, 1);
        expect(shaft[shaft.length - 1][0]).toBeCloseTo(8);
        expect(head[0]).toEqual([10, 0]);
        expect(head[1][0]).toBeCloseTo(8);
        expect(Math.abs(head[1][1] - head[2][1])).toBeCloseTo(2);
    });
});

describe('pies', () => {
    it('slices clockwise from the top, skipping empty types', () => {
        const slices = pieSlices(0, 0, 1, [['nuclear', 50], ['gas', 0], ['hydro', 50]]);
        expect(slices.map(s => s.key)).toEqual(['nuclear', 'hydro']);
        // The first half ends at the bottom (x≈0, y≈1): clockwise from the top.
        expect(slices[0].d).toMatch(/^M0,0L0,-1A1,1 0 0 1 /);
        expect(slices[0].d).toMatch(/,1Z$/);
    });

    it('a single type is a full circle', () => {
        expect(pieSlices(0, 0, 1, [['solar', 10]])).toEqual([{ key: 'solar', d: '', full: true }]);
        expect(pieSlices(0, 0, 1, [['solar', 0]])).toEqual([]);
    });
});

describe('mix and nuclear levels', () => {
    it('sums the national mix over the pies, not the neighbour badges, largest first', () => {
        const zone = (kind: string, production: Record<string, number>) => ({ kind, production });
        const data = { zones: [
            zone('region', { nuclear: 100, wind: 10 }),
            zone('region', { nuclear: 50, hydro: 30 }),
            zone('neighbor', { gas: 999 }),
        ] } as unknown as ContextMapData;
        expect(productionMix(data)).toEqual([
            { filiere: 'nuclear', mw: 150 }, { filiere: 'hydro', mw: 30 }, { filiere: 'wind', mw: 10 },
        ]);
    });

    it('ramps a unit colour from Pmin to Pmax through the middle stop', () => {
        const stops = ['#000000', '#808080', '#ffffff'] as const;
        expect(rampColor(stops, 0)).toBe('rgb(0, 0, 0)');
        expect(rampColor(stops, 0.5)).toBe('rgb(128, 128, 128)');
        expect(rampColor(stops, 1)).toBe('rgb(255, 255, 255)');
        expect(rampColor(stops, 7)).toBe('rgb(255, 255, 255)');
    });
});

describe('labels and highlights', () => {
    it('formats MW with thousands separators, unsigned', () => {
        expect(formatMw(12345.6)).toBe('12 346 MW');
        expect(formatMw(-980)).toBe('980 MW');
    });

    it('frames every highlighted element, falling back on zone positions', () => {
        const data = { bounds: [0, 0, 10, 5] } as unknown as ContextMapData;
        const k = renderScale(data.bounds);
        expect(k).toBe(RENDER_SIZE / 10);
        const hl = (points: [number, number][] | null, zone_points: [number, number][]): ContextMapHighlight => ({
            role: 'overload',
            element: { id: 'x', name: 'x', kind: 'branch', zones: ['A'], points, zone_points },
        });
        const box = highlightBox(data, [hl([[1, 1], [2, 3]], []), hl(null, [[4, 2]])]);
        expect(box).toEqual({ x: 1 * k, y: 1 * k, w: 3 * k, h: 2 * k });
        expect(highlightBox(data, [])).toBeNull();
    });
});
