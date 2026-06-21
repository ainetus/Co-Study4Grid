// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { declutterEdgeInfoLabels, parseRotateDeg, type EdgeInfoLabel } from './edgeInfoDeclutter';

const lbl = (x: number, y: number, deg: number, halfLen = 10, halfThick = 4): EdgeInfoLabel => {
    const a = (deg * Math.PI) / 180;
    return { x, y, tx: Math.cos(a), ty: Math.sin(a), halfLen, halfThick };
};
// Centre after applying the returned along-tangent offset.
const moved = (l: EdgeInfoLabel, off: number) => [l.x + off * l.tx, l.y + off * l.ty] as const;
const dist = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0] - b[0], a[1] - b[1]);

describe('declutterEdgeInfoLabels', () => {
    it('returns zero offsets for < 2 labels', () => {
        expect(declutterEdgeInfoLabels([])).toEqual([]);
        expect(declutterEdgeInfoLabels([lbl(0, 0, 0)])).toEqual([0]);
    });

    it('leaves non-overlapping labels untouched', () => {
        const labels = [lbl(0, 0, 0), lbl(1000, 0, 0)];
        const off = declutterEdgeInfoLabels(labels);
        expect(off[0]).toBe(0);
        expect(off[1]).toBe(0);
    });

    it('separates two coincident colinear labels along the edge', () => {
        const labels = [lbl(0, 0, 0, 10), lbl(0, 0, 0, 10)];
        const off = declutterEdgeInfoLabels(labels);
        // Deterministic tiebreak: index 0 slides +, index 1 slides −.
        expect(off[0]).toBeGreaterThan(5);
        expect(off[1]).toBeLessThan(-5);
        // They end up ~ (halfLen_i + halfLen_j) = 20 apart (4 passes ≈ 19.4).
        const sep = dist(moved(labels[0], off[0]), moved(labels[1], off[1]));
        expect(sep).toBeGreaterThan(18);
    });

    it('slides a fan of labels sharing a node outward (toward mid-segment)', () => {
        // 6 flow labels all anchored on the same substation node, each on a
        // different outgoing line direction → the classic dense-cluster blob.
        const dirs = [0, 30, 65, 130, 200, 300];
        const labels = dirs.map(d => lbl(0, 0, d, 12));
        const off = declutterEdgeInfoLabels(labels, { iterations: 6 });
        // Every label slid outward along its own line (away from the crowd).
        for (const o of off) expect(Math.abs(o)).toBeGreaterThan(0);
        // Minimum pairwise centre distance improved vs the all-coincident start.
        let minSep = Infinity;
        for (let i = 0; i < labels.length; i++) {
            for (let j = i + 1; j < labels.length; j++) {
                minSep = Math.min(minSep, dist(moved(labels[i], off[i]), moved(labels[j], off[j])));
            }
        }
        expect(minSep).toBeGreaterThan(8);
    });

    it('never slides further than the cap', () => {
        const labels = [lbl(0, 0, 0, 10), lbl(0, 0, 0, 10)];
        const off = declutterEdgeInfoLabels(labels, { iterations: 40, maxSlideFactor: 1 });
        const cap = 1 * 2 * 10; // maxSlideFactor × 2 × halfLen
        for (const o of off) expect(Math.abs(o)).toBeLessThanOrEqual(cap + 1e-9);
    });

    it('caps the forward (toward-mid) slide at maxSlideToMid', () => {
        const a = lbl(0, 0, 0, 10); a.maxSlideToMid = 3;       // capFwd = 3
        const b = lbl(0, 0, 0, 10); b.maxSlideToMid = 1000;
        const off = declutterEdgeInfoLabels([a, b], { iterations: 20 });
        // index 0 slides + (tiebreak) but is capped at its small toMid.
        expect(off[0]).toBeGreaterThan(0);
        expect(off[0]).toBeLessThanOrEqual(3 + 1e-9);
    });

    it('bounds the backward (toward-node) slide when geometry is known', () => {
        // label 0 is pushed backward by a neighbour ahead of it on the same
        // line; with geometry the backward slide is capped at 0.25×toMid so a
        // value never drifts back past its own substation.
        const a = lbl(0, 0, 0, 10); a.maxSlideToMid = 20;      // capBack = 5
        const b = lbl(5, 0, 0, 10); b.maxSlideToMid = 20;
        const off = declutterEdgeInfoLabels([a, b], { iterations: 20 });
        expect(off[0]).toBeLessThan(0);                        // pushed back
        expect(off[0]).toBeGreaterThanOrEqual(-5 - 1e-9);      // but bounded
    });

    it('keeps motion on the edge tangent (no perpendicular drift)', () => {
        const l = lbl(100, 50, 37, 10);
        const labels = [l, lbl(100, 50, 37, 10)];
        const off = declutterEdgeInfoLabels(labels);
        const [mx, my] = moved(l, off[0]);
        // Displacement vector is parallel to the tangent → zero normal component.
        const dvx = mx - l.x, dvy = my - l.y;
        const perp = Math.abs(dvx * -l.ty + dvy * l.tx);
        expect(perp).toBeLessThan(1e-6);
    });

    it('parseRotateDeg extracts the angle (and tolerates absence)', () => {
        expect(parseRotateDeg('rotate(21.72)')).toBeCloseTo(21.72);
        expect(parseRotateDeg('translate(5,6) rotate(-68.28)')).toBeCloseTo(-68.28);
        expect(parseRotateDeg('translate(5,6)')).toBeNull();
        expect(parseRotateDeg(null)).toBeNull();
    });
});
