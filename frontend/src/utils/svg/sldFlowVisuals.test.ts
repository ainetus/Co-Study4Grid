// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import { beforeEach, describe, expect, it } from 'vitest';
import { applySldFlowVisuals, clearSldFlowVisuals, hasSldFlowVisuals, type SldFlowData } from './sldFlowVisuals';

// A pypowsybl SLD as it draws a voltage level: one extern cell per feeder,
// its P and Q arrows (`sld-feeder-info`) carrying the branch end's side in
// the metadata. L1 is seen from its side ONE, the transformer T1 from its
// side TWO (no limit there), L9 has no limit, LOAD1 is a load.
const cell = (id: string, p: string, q: string) =>
    `<g class="sld-extern-cell" id="cell_${id}">`
    + `<g class="sld-wire"><polyline points="0,0 0,10"/></g>`
    + `<g class="sld-feeder-info sld-in sld-active-power" id="${id}_P"><polygon class="sld-arrow-in"/>`
    + `<text class="sld-label" x="15" y="5">${p}</text></g>`
    + `<g class="sld-feeder-info sld-out sld-reactive-power" id="${id}_Q"><polygon class="sld-arrow-out"/>`
    + `<text class="sld-label" x="15" y="5">${q}</text></g>`
    + `<g class="sld-top-feeder" id="${id}_FEEDER"><text class="sld-label">${id} name</text></g>`
    + `</g>`;

const SVG = `<svg xmlns="http://www.w3.org/2000/svg">${cell('L1', '-19', '3')}${cell('T1', '210', '12')}`
    + `${cell('L9', '50', '4')}${cell('LOAD1', '2', '-1')}</svg>`;

const info = (id: string, equipmentId: string, side?: string) => [
    { id: `${id}_P`, equipmentId, componentType: 'ARROW_ACTIVE', ...(side ? { side } : {}) },
    { id: `${id}_Q`, equipmentId, componentType: 'ARROW_REACTIVE', ...(side ? { side } : {}) },
];

const METADATA = JSON.stringify({
    nodes: [
        { id: 'L1_FEEDER', equipmentId: 'L1', componentType: 'LINE' },
        { id: 'T1_FEEDER', equipmentId: 'T1', componentType: 'TWO_WINDINGS_TRANSFORMER' },
        { id: 'L9_FEEDER', equipmentId: 'L9', componentType: 'LINE' },
        { id: 'LOAD1_FEEDER', equipmentId: 'LOAD1', componentType: 'LOAD' },
    ],
    feederInfos: [...info('L1', 'L1', 'ONE'), ...info('T1', 'T1', 'TWO'), ...info('L9', 'L9', 'ONE'), ...info('LOAD1', 'LOAD1')],
});

const DATA: SldFlowData = {
    sldMetadata: METADATA,
    branch_loading: { L1: [73.4, 74.9], T1: [96.2, null] },
    loading_deltas: {
        L1: { delta: 12.4, category: 'positive' },
        T1: { delta: -0.3, category: 'grey' },
    },
    flow_deltas: { L1: { delta: 30.5, category: 'positive', flip_arrow: true } },
    reactive_flow_deltas: { L1: { delta: 1.2, category: 'grey', flip_arrow: false } },
    asset_deltas: { LOAD1: { delta_p: -5, delta_q: 0, category: 'negative', category_p: 'negative', category_q: 'grey' } },
};

const p = (c: HTMLElement, id: string) => c.querySelector(`#${id}_P .sld-label`)!;
const q = (c: HTMLElement, id: string) => c.querySelector(`#${id}_Q`)!;
const cellOf = (c: HTMLElement, id: string) => c.querySelector(`#cell_${id}`)!;

describe('sldFlowVisuals', () => {
    let container: HTMLElement;
    beforeEach(() => {
        container = document.createElement('div');
        container.innerHTML = SVG;
    });

    describe('Loading % — Flows', () => {
        beforeEach(() => applySldFlowVisuals(container, DATA, 'network', 'loading', 0.95));

        it('reads each branch feeder as the loading of the end it draws', () => {
            expect(p(container, 'L1').textContent).toBe('73%');
            // T1 has no limit on its side TWO: the other end tells its loading.
            expect(p(container, 'T1').textContent).toBe('96%');
        });

        it('colours the feeder cells on the NAD scale, the value on a pill of that colour from 50 %', () => {
            expect(cellOf(container, 'L1').classList.contains('sld-loading-warn-3')).toBe(true);
            expect(cellOf(container, 'T1').classList.contains('sld-loading-over')).toBe(true);
            const pill = container.querySelector('#L1_P .sld-loading-pill');
            expect(pill?.classList.contains('sld-loading-pill--warn-3')).toBe(true);
            expect(pill?.nextElementSibling).toBe(p(container, 'L1'));
            expect(p(container, 'L1').classList.contains('sld-loading-text')).toBe(true);
        });

        it('hides the Q arrow of a branch: the loading is one figure per end', () => {
            expect(q(container, 'L1').classList.contains('sld-loading-hidden')).toBe(true);
            expect(q(container, 'T1').classList.contains('sld-loading-hidden')).toBe(true);
        });

        it('greys a branch without a limit, with a dash', () => {
            expect(p(container, 'L9').textContent).toBe('—');
            expect(cellOf(container, 'L9').classList.contains('sld-loading-low')).toBe(true);
            expect(container.querySelector('#L9_P .sld-loading-pill')).toBeNull();
        });

        it('leaves loads and generators in MW: they have no limit', () => {
            expect(p(container, 'LOAD1').textContent).toBe('2');
            expect(q(container, 'LOAD1').classList.contains('sld-loading-hidden')).toBe(false);
            expect(cellOf(container, 'LOAD1').getAttribute('class')).toBe('sld-extern-cell');
        });

        it('keeps the feeder names', () => {
            expect(container.querySelector('#L1_FEEDER .sld-label')!.textContent).toBe('L1 name');
        });
    });

    describe('Loading % — Impacts', () => {
        beforeEach(() => applySldFlowVisuals(container, DATA, 'delta', 'loading', 0.95));

        it('reads each branch as its loading change, rounded, coloured like the deltas', () => {
            const l1 = p(container, 'L1');
            expect(l1.textContent).toBe('+12%');
            expect(l1.classList.contains('sld-delta-text-positive')).toBe(true);
            expect(cellOf(container, 'L1').classList.contains('sld-delta-positive')).toBe(true);
            // Under one point, a decimal keeps the change's sign.
            expect(p(container, 'T1').textContent).toBe('-0.3%');
            expect(cellOf(container, 'T1').classList.contains('sld-delta-grey')).toBe(true);
            expect(p(container, 'L9').textContent).toBe('—');
        });

        it('does not turn the arrows: a loading change has no direction', () => {
            expect(container.querySelector('[data-arrow-flipped]')).toBeNull();
            expect(q(container, 'L1').classList.contains('sld-loading-hidden')).toBe(true);
        });

        it('keeps the MW change of loads and generators', () => {
            expect(p(container, 'LOAD1').textContent).toBe('Δ -5.0');
            expect(p(container, 'LOAD1').classList.contains('sld-delta-text-negative')).toBe(true);
        });
    });

    describe('MW', () => {
        it('Flows is pypowsybl\'s own rendering: nothing painted', () => {
            applySldFlowVisuals(container, DATA, 'network', 'p', 0.95);
            expect(hasSldFlowVisuals(container)).toBe(false);
            expect(p(container, 'L1').textContent).toBe('-19');
        });

        it('Impacts reads P and Q as their change and turns the arrows to it', () => {
            applySldFlowVisuals(container, DATA, 'delta', 'p', 0.95);
            expect(p(container, 'L1').textContent).toBe('Δ +30.5');
            expect(container.querySelector('#L1_Q .sld-label')!.textContent).toBe('Δ +1.2');
            expect(cellOf(container, 'L1').classList.contains('sld-delta-positive')).toBe(true);
            expect(container.querySelector('#L1_P').classList.contains('sld-out')).toBe(true);
        });

        it('stays in MW when the SLD carries no loading', () => {
            applySldFlowVisuals(container, { ...DATA, branch_loading: undefined }, 'delta', 'loading', 0.95);
            expect(p(container, 'L1').textContent).toBe('Δ +30.5');
        });
    });

    it('reads a value printed with its thousands grouped as a number (1,550 MW)', () => {
        container.innerHTML = SVG.replace('>2<', '>1,550<');
        applySldFlowVisuals(container, DATA, 'delta', 'p', 0.95);
        expect(p(container, 'LOAD1').textContent).toBe('Δ -5.0');
    });

    it('a feeder whose side the metadata does not give reads its branch, the larger end', () => {
        const noSide = JSON.stringify({ feederInfos: [{ id: 'L1_P', equipmentId: 'L1' }] });
        applySldFlowVisuals(container, { ...DATA, sldMetadata: noSide }, 'network', 'loading', 0.95);
        expect(p(container, 'L1').textContent).toBe('74%');
    });

    it('clears back to pypowsybl\'s SLD', () => {
        applySldFlowVisuals(container, DATA, 'network', 'loading', 0.95);
        expect(hasSldFlowVisuals(container)).toBe(true);
        clearSldFlowVisuals(container);
        expect(hasSldFlowVisuals(container)).toBe(false);
        const pristine = document.createElement('div');
        pristine.innerHTML = SVG;
        expect(container.innerHTML).toBe(pristine.innerHTML);

        applySldFlowVisuals(container, DATA, 'delta', 'p', 0.95);
        clearSldFlowVisuals(container);
        expect(container.querySelector('#L1_P').classList.contains('sld-in')).toBe(true);
        expect(p(container, 'L1').textContent).toBe('-19');
    });
});
