// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MetadataIndex, NodeMeta } from '../../types';
import { attachVlInteractions, VL_SINGLE_CLICK_DELAY_MS } from './vlInteractions';

const SVG_NS = 'http://www.w3.org/2000/svg';

// Build a `.svg-container` div holding a NAD-shaped SVG with one VL disk.
const makeContainer = (): { container: HTMLDivElement; disk: SVGCircleElement } => {
    const container = document.createElement('div');
    container.className = 'svg-container';
    const svg = document.createElementNS(SVG_NS, 'svg');
    const vlNodes = document.createElementNS(SVG_NS, 'g');
    vlNodes.setAttribute('class', 'nad-vl-nodes');
    const vlGroup = document.createElementNS(SVG_NS, 'g');
    vlGroup.id = 'vl1-svg';
    const disk = document.createElementNS(SVG_NS, 'circle');
    disk.setAttribute('r', '27.5');
    vlGroup.appendChild(disk);
    vlNodes.appendChild(vlGroup);
    svg.appendChild(vlNodes);
    container.appendChild(svg);
    document.body.appendChild(container);
    return { container, disk };
};

const makeMetaIndex = (): MetadataIndex => {
    const node: NodeMeta = { equipmentId: 'VL_400', svgId: 'vl1-svg', x: 0, y: 0 };
    return {
        nodesByEquipmentId: new Map([['VL_400', node]]),
        nodesBySvgId: new Map([['vl1-svg', node]]),
        edgesByEquipmentId: new Map(),
        edgesByNode: new Map(),
    };
};

const mouse = (type: string, x = 5, y = 5): MouseEvent =>
    new MouseEvent(type, { bubbles: true, clientX: x, clientY: y });

describe('attachVlInteractions', () => {
    let cleanups: Array<() => void> = [];

    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        cleanups.forEach((fn) => fn());
        cleanups = [];
        vi.useRealTimers();
        document.body.innerHTML = '';
    });

    it('is a safe no-op when the container or metadata is missing', () => {
        expect(() => attachVlInteractions(null, makeMetaIndex(), {})()).not.toThrow();
        const { container } = makeContainer();
        expect(() => attachVlInteractions(container, null, {})()).not.toThrow();
    });

    it('does nothing when the metadata index has no nodes', () => {
        const { container, disk } = makeContainer();
        const onSelect = vi.fn();
        const empty: MetadataIndex = {
            nodesByEquipmentId: new Map(),
            nodesBySvgId: new Map(),
            edgesByEquipmentId: new Map(),
            edgesByNode: new Map(),
        };
        cleanups.push(attachVlInteractions(container, empty, { onSelect }));
        disk.dispatchEvent(mouse('mousedown'));
        disk.dispatchEvent(mouse('click'));
        vi.advanceTimersByTime(VL_SINGLE_CLICK_DELAY_MS);
        expect(onSelect).not.toHaveBeenCalled();
    });

    it('fires onSelect with the VL equipment id on a single click (after the delay)', () => {
        const { container, disk } = makeContainer();
        const onSelect = vi.fn();
        cleanups.push(attachVlInteractions(container, makeMetaIndex(), { onSelect }));

        disk.dispatchEvent(mouse('mousedown'));
        disk.dispatchEvent(mouse('click'));
        expect(onSelect).not.toHaveBeenCalled(); // deferred for the dbl-click window
        vi.advanceTimersByTime(VL_SINGLE_CLICK_DELAY_MS);
        expect(onSelect).toHaveBeenCalledTimes(1);
        expect(onSelect).toHaveBeenCalledWith('VL_400');
    });

    it('fires onOpenSld and suppresses onSelect on a double click', () => {
        const { container, disk } = makeContainer();
        const onSelect = vi.fn();
        const onOpenSld = vi.fn();
        cleanups.push(attachVlInteractions(container, makeMetaIndex(), { onSelect, onOpenSld }));

        disk.dispatchEvent(mouse('mousedown'));
        disk.dispatchEvent(mouse('click'));
        disk.dispatchEvent(mouse('dblclick'));
        vi.advanceTimersByTime(VL_SINGLE_CLICK_DELAY_MS);

        expect(onOpenSld).toHaveBeenCalledTimes(1);
        expect(onOpenSld).toHaveBeenCalledWith('VL_400');
        expect(onSelect).not.toHaveBeenCalled();
    });

    // Real-world regression: usePanZoom sets pointer-events:none on every
    // SVG child during the gesture, so the browser retargets the resulting
    // `click` / `dblclick` to the container (not the disk). The VL must
    // still be resolved — it is captured from the mousedown, whose hit-test
    // lands on the live disk before the cull is applied.
    it('selects even when the click is retargeted to the container', () => {
        const { container, disk } = makeContainer();
        const onSelect = vi.fn();
        cleanups.push(attachVlInteractions(container, makeMetaIndex(), { onSelect }));

        disk.dispatchEvent(mouse('mousedown')); // hit-tests the live disk
        container.dispatchEvent(mouse('click')); // retargeted to the container
        vi.advanceTimersByTime(VL_SINGLE_CLICK_DELAY_MS);
        expect(onSelect).toHaveBeenCalledWith('VL_400');
    });

    it('opens the SLD even when the double-click is retargeted to the container', () => {
        const { container, disk } = makeContainer();
        const onOpenSld = vi.fn();
        cleanups.push(attachVlInteractions(container, makeMetaIndex(), { onOpenSld }));

        disk.dispatchEvent(mouse('mousedown'));
        container.dispatchEvent(mouse('click'));
        disk.dispatchEvent(mouse('mousedown'));
        container.dispatchEvent(mouse('dblclick'));
        expect(onOpenSld).toHaveBeenCalledWith('VL_400');
    });

    it('treats a drag (pointer travel beyond the threshold) as a pan, not a click', () => {
        const { container, disk } = makeContainer();
        const onSelect = vi.fn();
        cleanups.push(attachVlInteractions(container, makeMetaIndex(), { onSelect }));

        disk.dispatchEvent(mouse('mousedown', 10, 10));
        disk.dispatchEvent(mouse('click', 80, 80)); // moved ~99px → a pan
        vi.advanceTimersByTime(VL_SINGLE_CLICK_DELAY_MS);
        expect(onSelect).not.toHaveBeenCalled();
    });

    it('ignores clicks that do not land on a VL disk', () => {
        const { container } = makeContainer();
        const onSelect = vi.fn();
        cleanups.push(attachVlInteractions(container, makeMetaIndex(), { onSelect }));

        const svg = container.querySelector('svg')!;
        svg.dispatchEvent(mouse('mousedown'));
        svg.dispatchEvent(mouse('click'));
        vi.advanceTimersByTime(VL_SINGLE_CLICK_DELAY_MS);
        expect(onSelect).not.toHaveBeenCalled();
    });

    it('shows the hover tooltip only while the static VL labels are hidden', () => {
        const { container, disk } = makeContainer();
        cleanups.push(attachVlInteractions(container, makeMetaIndex(), {
            displayName: (id) => (id === 'VL_400' ? 'PARIS 400kV' : id),
        }));

        // Labels visible → the name is already drawn, so no tooltip.
        disk.dispatchEvent(mouse('mouseover'));
        expect(container.querySelector('.cs4g-vl-hover-tooltip')).toBeNull();
        disk.dispatchEvent(mouse('mouseout'));

        // Labels hidden → tooltip surfaces the friendly name + raw id.
        container.classList.add('nad-hide-vl-labels');
        disk.dispatchEvent(mouse('mouseover'));
        const tip = container.querySelector('.cs4g-vl-hover-tooltip') as HTMLElement;
        expect(tip).not.toBeNull();
        expect(tip.style.display).toBe('block');
        expect(tip.textContent).toBe('PARIS 400kV (VL_400)');

        // Leaving the disk hides the tooltip again.
        disk.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: null }));
        expect(tip.style.display).toBe('none');
    });

    it('removes its listeners and tooltip node on teardown', () => {
        const { container, disk } = makeContainer();
        const onSelect = vi.fn();
        const teardown = attachVlInteractions(container, makeMetaIndex(), { onSelect });

        container.classList.add('nad-hide-vl-labels');
        disk.dispatchEvent(mouse('mouseover'));
        expect(container.querySelector('.cs4g-vl-hover-tooltip')).not.toBeNull();

        teardown();
        expect(container.querySelector('.cs4g-vl-hover-tooltip')).toBeNull();

        disk.dispatchEvent(mouse('mousedown'));
        disk.dispatchEvent(mouse('click'));
        vi.advanceTimersByTime(VL_SINGLE_CLICK_DELAY_MS);
        expect(onSelect).not.toHaveBeenCalled();
    });
});
