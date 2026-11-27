// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import type { EdgeMeta, MetadataIndex } from '../../types';
import { applyDeltaVisuals } from './deltaVisuals';
import { applyLoadingVisuals, formatChange, isPrintedNumber, loadingClass, LOADING_CLASSES, parsePrintedNumber } from './loadingVisuals';

const edge = (id: string): EdgeMeta => ({
    equipmentId: id, svgId: `svg-${id}`, node1: 'n1', node2: 'n2',
    edgeInfo1: { svgId: `info1-${id}` },
    edgeInfo2: { svgId: `info2-${id}` },
} as EdgeMeta);

const metaIndex = (...ids: string[]): MetadataIndex => ({
    nodesByEquipmentId: new Map(),
    nodesBySvgId: new Map(),
    edgesByEquipmentId: new Map(ids.map(id => [id, edge(id)])),
    edgesByNode: new Map(),
});

const container = (...ids: string[]): HTMLElement => {
    const div = document.createElement('div');
    div.innerHTML = `<svg>${ids.map(id => `
        <g id="svg-${id}"><path/></g>
        <g id="info1-${id}"><text>123</text></g>
        <g id="info2-${id}"><text>-121</text></g>`).join('')}</svg>`;
    return div;
};

const classesOf = (root: HTMLElement, id: string) => Array.from(root.querySelector(`#svg-${id}`)!.classList);
const labelOf = (root: HTMLElement, id: string, end: 1 | 2 = 1) => root.querySelector(`#info${end}-${id} text`)!.textContent;

describe('loadingClass', () => {
    it('greys below 50 %, steps pale yellow → orange up to the monitoring factor, vivid orange from it', () => {
        expect(loadingClass(49.9, 0.95)).toBe('nad-loading-low');
        expect(loadingClass(50, 0.95)).toBe('nad-loading-warn-1');
        expect(loadingClass(71, 0.95)).toBe('nad-loading-warn-3');
        expect(loadingClass(94.9, 0.95)).toBe('nad-loading-warn-5');
        expect(loadingClass(95, 0.95)).toBe('nad-loading-over');
        expect(loadingClass(130, 0.95)).toBe('nad-loading-over');
    });

    it('follows the monitoring factor', () => {
        expect(loadingClass(97, 1.0)).toBe('nad-loading-warn-5');
        expect(loadingClass(97, 0.9)).toBe('nad-loading-over');
    });
});

describe('applyLoadingVisuals', () => {
    it('colours each branch by its loading and labels it in percent', () => {
        const root = container('L1', 'L2', 'L3');
        applyLoadingVisuals(root, { branch_loading: { L1: [42.0, 41.0], L2: [70.6, 69.8], L3: [101.2, 100.4] } },
            metaIndex('L1', 'L2', 'L3'), 'network', 0.95);

        expect(classesOf(root, 'L1')).toContain('nad-loading-low');
        expect(classesOf(root, 'L2')).toContain('nad-loading-warn-3');
        expect(classesOf(root, 'L3')).toContain('nad-loading-over');
        // Each end reads its own loading; the colour follows the more loaded end.
        expect(labelOf(root, 'L2')).toBe('70%');
        expect(labelOf(root, 'L2', 2)).toBe('69%');
        expect(labelOf(root, 'L3')).toBe('101%');
        expect(root.querySelector('#info1-L2 text')!.getAttribute('data-original-text')).toBe('123');
    });

    it("reads a transformer's unlimited side as a dash, coloured by its limited one", () => {
        const root = container('T1');
        applyLoadingVisuals(root, { branch_loading: { T1: [null, 97.2] } }, metaIndex('T1'), 'network', 0.95);
        expect(classesOf(root, 'T1')).toContain('nad-loading-over');
        expect(labelOf(root, 'T1')).toBe('\u2014');
        expect(labelOf(root, 'T1', 2)).toBe('97%');
    });

    it('greys a branch without a limit with a dash', () => {
        const root = container('L1');
        applyLoadingVisuals(root, { branch_loading: {} }, metaIndex('L1'), 'network', 0.95);
        expect(classesOf(root, 'L1')).toContain('nad-loading-low');
        expect(labelOf(root, 'L1')).toBe('—');
    });

    it('shows the loading change in Impacts mode, coloured like the flow deltas', () => {
        const root = container('L1', 'L2', 'L3');
        applyLoadingVisuals(root, {
            branch_loading: { L1: [90, 90], L2: [40, 40], L3: [50, 50] },
            loading_deltas: {
                L1: { delta: 25.04, category: 'positive' },
                L2: { delta: -12.5, category: 'negative' },
                L3: { delta: 0.1, category: 'grey' },
            },
        }, metaIndex('L1', 'L2', 'L3'), 'delta', 0.95);

        expect(classesOf(root, 'L1')).toContain('nad-delta-positive');
        expect(classesOf(root, 'L2')).toContain('nad-delta-negative');
        expect(classesOf(root, 'L3')).toContain('nad-delta-grey');
        expect(labelOf(root, 'L1')).toBe('Δ +25.0%');
        expect(labelOf(root, 'L2')).toBe('Δ -12.5%');
        expect(LOADING_CLASSES.some(c => classesOf(root, 'L1').includes(c))).toBe(false);
    });

    it('falls back to the absolute loading in Impacts mode without deltas (N state)', () => {
        const root = container('L1');
        applyLoadingVisuals(root, { branch_loading: { L1: [97, 96] } }, metaIndex('L1'), 'delta', 0.95);
        expect(classesOf(root, 'L1')).toContain('nad-loading-over');
        expect(labelOf(root, 'L1')).toBe('97%');
    });

    it('recolours a branch drawn without flow labels (open in this state)', () => {
        const root = container('L1');
        const index = metaIndex('L1');
        const open = { ...edge('L1'), edgeInfo1: undefined, edgeInfo2: undefined } as EdgeMeta;
        index.edgesByEquipmentId.set('L1', open);
        applyLoadingVisuals(root, { branch_loading: { L1: [0, 0] } }, index, 'network', 0.95);
        expect(classesOf(root, 'L1')).toContain('nad-loading-low');
        expect(labelOf(root, 'L1')).toBe('123');
    });

    it('leaves the diagram alone when it carries no loading', () => {
        const root = container('L1');
        applyLoadingVisuals(root, {}, metaIndex('L1'), 'network', 0.95);
        expect(classesOf(root, 'L1')).toEqual([]);
        expect(labelOf(root, 'L1')).toBe('123');
    });

    it('back to MW: the delta pass restores the labels and the loading pass clears its classes', () => {
        const root = container('L1');
        const diagram = { branch_loading: { L1: [85, 84] as [number, number] }, flow_deltas: {} };
        const index = metaIndex('L1');
        applyLoadingVisuals(root, diagram, index, 'network', 0.95);

        applyDeltaVisuals(root, diagram, index, false);
        applyLoadingVisuals(root, diagram, index, null, 0.95);

        expect(classesOf(root, 'L1')).toEqual([]);
        expect(labelOf(root, 'L1')).toBe('123');
        expect(labelOf(root, 'L1', 2)).toBe('-121');
    });
});

describe('printed numbers', () => {
    it('reads the values pypowsybl prints, thousands grouped or not', () => {
        expect(parsePrintedNumber('-1,297')).toBe(-1297);
        expect(parsePrintedNumber('1 550')).toBe(1550);
        expect(parsePrintedNumber(' -19 ')).toBe(-19);
        expect(parsePrintedNumber('12.5')).toBe(12.5);
        expect(isPrintedNumber('1,550')).toBe(true);
        expect(isPrintedNumber('-8')).toBe(true);
        expect(isPrintedNumber('MAGNY1')).toBe(false);
        expect(isPrintedNumber('73%')).toBe(false);
    });
});

describe('formatChange', () => {
    it('rounds a change, its sign telling up from down; under one unit a decimal, none at all 0', () => {
        expect(formatChange('%')(12.4)).toBe('+12%');
        expect(formatChange('%')(-9.6)).toBe('-10%');
        expect(formatChange('%')(-0.4)).toBe('-0.4%');
        expect(formatChange('')(0.5)).toBe('+1');
        expect(formatChange('%')(0.04)).toBe('0%');
        expect(formatChange('')(0)).toBe('0');
    });
});
