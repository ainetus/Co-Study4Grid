// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import type { EdgeMeta, MetadataIndex } from '../../types';
import {
    applyAffine, BranchIndex, buildLabelItems, ENDS_MIN_PX, invertAffine, layoutLabels, PLAIN_MIN_PX,
    readBranchGeometry, type Affine, type BranchGeometry, type LabelItem, type Point,
} from './branchLabels';

const edge = (id: string, svgId: string, infos = true): EdgeMeta => ({
    equipmentId: id, svgId, node1: `${id}-n1`, node2: `${id}-n2`,
    ...(infos ? { edgeInfo1: { svgId: `${svgId}-i1` }, edgeInfo2: { svgId: `${svgId}-i2` } } : {}),
} as EdgeMeta);

const metaIndex = (...edges: EdgeMeta[]): MetadataIndex => ({
    nodesByEquipmentId: new Map(),
    nodesBySvgId: new Map(),
    edgesByEquipmentId: new Map(edges.map(e => [e.equipmentId, e])),
    edgesByNode: new Map(),
});

const geom = (id: string, from: Point, to: Point, over: Partial<BranchGeometry> = {}): BranchGeometry => {
    const mid: Point = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2];
    const at = (t: number): Point => [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t];
    return {
        id, path: [from, to], mid, anchors: [at(0.2), at(0.8)], arrow: 10, mw: [100, -98],
        inks: [null, null], nodes: [`${id}-n1`, `${id}-n2`], ...over,
    };
};

const item = (g: BranchGeometry, over: Partial<LabelItem> = {}): LabelItem => ({
    geom: g, ends: ['80%', '79%'], mid: '80%', tone: 'loading-warn-3', important: true, weight: 80,
    inks: [null, null], midInk: null, inkText: false, ...over,
});

const identity = { width: 1000, height: 800, project: (p: Point) => p, pxPerUnit: 1, measure: (t: string) => t.length * 7 };

describe('readBranchGeometry', () => {
    it('reads the branch polyline end 1 → end 2, its middle, its arrows and the MW pypowsybl printed', () => {
        const container = document.createElement('div');
        // pypowsybl draws each half from its node towards the middle, in its voltage's colour.
        container.innerHTML = `<svg>
            <g class="nad-branch-edges"><g id="e1">
                <polyline class="nad-vl300to500 nad-edge-path" points="0,0 40,0" style="--nad-vl-color: rgb(211, 47, 47)"/>
                <polyline class="nad-vl180to300 nad-edge-path" points="100,0 60,0" style="--nad-vl-color: rgb(46, 125, 50)"/>
            </g></g>
            <g class="nad-edge-infos">
                <g id="e1-i1" transform="translate(20,0) scale(2)"><path/><text data-original-text="412">41%</text></g>
                <g id="e1-i2" transform="translate(80,0) scale(2)"><path/><text>-410</text></g>
            </g>
        </svg>`;
        const [g] = readBranchGeometry(container, metaIndex(edge('L1', 'e1')));
        expect(g.path).toEqual([[0, 0], [40, 0], [60, 0], [100, 0]]);
        expect(g.mid).toEqual([50, 0]);
        expect(g.anchors).toEqual([[20, 0], [80, 0]]);
        expect(g.arrow).toBe(20);
        // The MW under a view's rewrite (Loading %), as printed.
        expect(g.mw).toEqual([412, -410]);
        // A transformer's halves: each its own voltage's colour.
        expect(g.inks).toEqual(['rgb(211, 47, 47)', 'rgb(46, 125, 50)']);
    });

    it('keeps an open branch (no flow arrows) with its middle, and skips one not drawn', () => {
        const container = document.createElement('div');
        container.innerHTML = '<svg><g id="e2"><polyline class="nad-edge-path" points="0,0 10,0 30,0"/></g></svg>';
        const geoms = readBranchGeometry(container, metaIndex(edge('OPEN', 'e2', false), edge('GONE', 'e9')));
        expect(geoms.map(g => g.id)).toEqual(['OPEN']);
        expect(geoms[0].mid).toEqual([15, 0]);
        expect(geoms[0].anchors).toEqual([null, null]);
        expect(geoms[0].mw).toEqual([null, null]);
    });
});

describe('buildLabelItems', () => {
    const g = geom('L1', [0, 0], [100, 0]);

    it('Loading %: each end, the larger at the middle, coloured from 50 %', () => {
        const [it] = buildLabelItems([g], { branch_loading: { L1: [96.4, 88.0] } }, 'network', 'loading', 0.95);
        expect(it).toMatchObject({ ends: ['96%', '88%'], mid: '96%', tone: 'loading-over', important: true, weight: 96.4 });
        // An end below 50 % of a coloured branch still reads its own loading.
        const [warn] = buildLabelItems([g], { branch_loading: { L1: [31, 52] } }, 'network', 'loading', 0.95);
        expect(warn).toMatchObject({ ends: ['31%', '52%'], tone: 'loading-warn-1' });
    });

    it('Loading %: no label for a grey branch, in Flows or in Impacts', () => {
        expect(buildLabelItems([g], { branch_loading: { L1: [31, 30] } }, 'network', 'loading', 0.95)).toEqual([]);
        const deltas = { loading_deltas: { L1: { delta: 0.4, category: 'grey' as const } } };
        expect(buildLabelItems([g], deltas, 'delta', 'loading', 0.95)).toEqual([]);
    });

    it('Impacts in MW: no label for an insignificant change either', () => {
        const flows = { flow_deltas: { L1: { delta: 0.4, category: 'grey' as const } } };
        expect(buildLabelItems([g], flows, 'delta', 'p', 0.95)).toEqual([]);
    });

    it("Loading %: a transformer's unlimited end has no label", () => {
        const [it] = buildLabelItems([g], { branch_loading: { L1: [null, 70.2] } }, 'network', 'loading', 0.95);
        expect(it.ends).toEqual([null, '70%']);
        expect(it.mid).toBe('70%');
    });

    it('Impacts: the change at both ends, important when significant', () => {
        const diagram = {
            loading_deltas: { L1: { delta: 12.34, category: 'positive' as const } },
            flow_deltas: { L1: { delta: -58, category: 'negative' as const } },
        };
        const [loading] = buildLabelItems([g], diagram, 'delta', 'loading', 0.95);
        expect(loading).toMatchObject({ ends: ['Δ +12.3%', 'Δ +12.3%'], tone: 'delta-positive', important: true });
        const [mw] = buildLabelItems([g], diagram, 'delta', 'p', 0.95);
        expect(mw).toMatchObject({ mid: 'Δ -58.0', tone: 'delta-negative', important: true });
    });

    it('MW: each end as printed, the larger magnitude at the middle', () => {
        const [it] = buildLabelItems([geom('L1', [0, 0], [100, 0], { mw: [-120.4, 118] })], {}, 'network', 'p', 0.95);
        expect(it).toMatchObject({ ends: ['-120', '118'], mid: '120', tone: 'plain', important: false });
    });

    it("MW: written in each end's voltage colour, the middle in its larger end's", () => {
        const tr = geom('TR', [0, 0], [100, 0], { mw: [80, -250], inks: ['rgb(211, 47, 47)', 'rgb(46, 125, 50)'] });
        const [it] = buildLabelItems([tr], {}, 'network', 'p', 0.95);
        expect(it.inks).toEqual(['rgb(211, 47, 47)', 'rgb(46, 125, 50)']);
        expect(it.midInk).toBe('rgb(46, 125, 50)');
        expect(it.inkText).toBe(true);
    });

    it('Loading % and Impacts: outlined in the voltage colour, the text in the scale\'s', () => {
        const tr = geom('TR', [0, 0], [100, 0], { mw: [250, -80], inks: ['rgb(211, 47, 47)', 'rgb(46, 125, 50)'] });
        const [loading] = buildLabelItems([tr], { branch_loading: { TR: [null, 96] } }, 'network', 'loading', 0.95);
        // The middle reads the loaded end (side 2): its colour.
        expect(loading).toMatchObject({ inks: ['rgb(211, 47, 47)', 'rgb(46, 125, 50)'], midInk: 'rgb(46, 125, 50)', inkText: false });
        const deltas = { flow_deltas: { TR: { delta: 40, category: 'positive' as const } } };
        const [impact] = buildLabelItems([tr], deltas, 'delta', 'p', 0.95);
        // A change reads the same at both ends: the middle in the larger flow's end colour.
        expect(impact).toMatchObject({ midInk: 'rgb(211, 47, 47)', inkText: false });
    });

    it('leaves out a branch with nothing to say', () => {
        expect(buildLabelItems([g], { branch_loading: {} }, 'network', 'loading', 0.95)).toEqual([]);
        expect(buildLabelItems([geom('L1', [0, 0], [1, 0], { mw: [null, null] })], {}, 'network', 'p', 0.95)).toEqual([]);
    });
});

describe('layoutLabels', () => {
    it('a branch short on screen gets one label at its middle', () => {
        const placed = layoutLabels([item(geom('S', [100, 100], [160, 100]))], identity);
        expect(placed).toHaveLength(1);
        expect(placed[0]).toMatchObject({ text: '80%', x: 130, y: 100 });
    });

    it('a branch long enough gets a label at each end, beside its arrow towards the middle', () => {
        const g = geom('L', [100, 300], [100 + ENDS_MIN_PX + 100, 300]);
        const placed = layoutLabels([item(g, { inks: ['rgb(1, 1, 1)', 'rgb(2, 2, 2)'] })], identity);
        expect(placed.map(p => p.text)).toEqual(['80%', '79%']);
        expect(placed.map(p => p.ink)).toEqual(['rgb(1, 1, 1)', 'rgb(2, 2, 2)']);
        expect(placed.every(p => !p.inkText)).toBe(true);
        const [a, b] = placed;
        expect(a.x).toBeGreaterThan(g.anchors[0]![0] + g.arrow);
        expect(b.x).toBeLessThan(g.anchors[1]![0] - g.arrow);
        expect(a.y).toBe(300);
    });

    it('labels a grey branch only once it is long enough on screen', () => {
        const short = item(geom('G1', [0, 50], [PLAIN_MIN_PX - 10, 50]), { important: false });
        const long = item(geom('G2', [0, 200], [PLAIN_MIN_PX + 10, 200]), { important: false });
        expect(layoutLabels([short, long], identity).map(p => p.id)).toEqual(['G2']);
    });

    it('never puts a label over another: the coloured, then the larger value wins', () => {
        const at = (id: string, over: Partial<LabelItem>) => item(geom(id, [400, 400], [460, 400]), over);
        const placed = layoutLabels([
            at('GREY', { important: false, weight: 999 }),
            at('LOW', { weight: 60 }),
            at('HIGH', { weight: 101 }),
        ], identity);
        expect(placed.map(p => p.id)).toEqual(['HIGH']);
    });

    it('skips the branches out of view', () => {
        expect(layoutLabels([item(geom('OUT', [2000, 2000], [2050, 2000]))], identity)).toEqual([]);
    });
});

describe('BranchIndex', () => {
    it('finds the branch within the tolerance of the pointer, along a long line too', () => {
        const index = new BranchIndex([geom('A', [0, 0], [1000, 0]), geom('B', [0, 50], [1000, 50])]);
        expect(index.nearest([500, 4], 8).map(g => g.id)).toEqual(['A']);
        expect(index.nearest([999, 47], 8).map(g => g.id)).toEqual(['B']);
        expect(index.nearest([500, 25], 8)).toEqual([]);
    });

    it('returns the parallel circuits drawn over each other, nearest first', () => {
        const index = new BranchIndex([
            geom('TWIN1', [0, 0], [1000, 0]), geom('TWIN2', [0, 1], [1000, 1]), geom('FAR', [0, 30], [1000, 30]),
        ]);
        expect(index.nearest([500, 0.2], 8, 2).map(g => g.id)).toEqual(['TWIN1', 'TWIN2']);
    });
});

describe('affine helpers', () => {
    it('inverts a CTM', () => {
        const m: Affine = [2, 0, 0, 2, 10, -5];
        const inv = invertAffine(m)!;
        expect(applyAffine(inv, applyAffine(m, [3, 4]))).toEqual([3, 4]);
        expect(invertAffine([0, 0, 0, 0, 1, 1])).toBeNull();
    });
});
