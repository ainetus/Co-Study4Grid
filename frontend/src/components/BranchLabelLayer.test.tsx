// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useRef } from 'react';
import BranchLabelLayer, { BRANCH_LABELS_ATTR } from './BranchLabelLayer';
import { GESTURE_PROXY_ATTR } from '../utils/svg/canvasProxy';
import type { DiagramData, EdgeMeta, FlowMetric, MetadataIndex, NodeMeta, ViewMode } from '../types';

// Two branches: LONG (0,300)→(600,300) — a label per end — and SHORT
// (100,100)→(160,100) — one at its middle. The view maps user units 1:1 to px.
const SVG = `<svg>
    <g class="nad-branch-edges">
        <g id="e1"><polyline class="nad-edge-path" points="0,300 300,300"/><polyline class="nad-edge-path" points="600,300 300,300"/></g>
        <g id="e2"><polyline class="nad-edge-path" points="100,100 130,100"/><polyline class="nad-edge-path" points="160,100 130,100"/></g>
    </g>
    <g class="nad-edge-infos">
        <g id="e1-i1" transform="translate(120,300)"><text>412</text></g>
        <g id="e1-i2" transform="translate(480,300)"><text>-410</text></g>
        <g id="e2-i1" transform="translate(112,100)"><text>55</text></g>
        <g id="e2-i2" transform="translate(148,100)"><text>-55</text></g>
    </g>
</svg>`;

const node = (svgId: string, equipmentId: string) => [svgId, { svgId, equipmentId } as NodeMeta] as const;
const edge = (id: string, svgId: string): EdgeMeta => ({
    equipmentId: id, svgId, node1: `${svgId}-n1`, node2: `${svgId}-n2`,
    edgeInfo1: { svgId: `${svgId}-i1` }, edgeInfo2: { svgId: `${svgId}-i2` },
} as EdgeMeta);
const META: MetadataIndex = {
    nodesByEquipmentId: new Map(),
    nodesBySvgId: new Map([node('e1-n1', 'CANTEP7'), node('e1-n2', 'CANTEP6'), node('e2-n1', 'A'), node('e2-n2', 'B')]),
    edgesByEquipmentId: new Map([['LONG', edge('LONG', 'e1')], ['SHORT', edge('SHORT', 'e2')]]),
    edgesByNode: new Map(),
};
const DIAGRAM = {
    svg: '', metadata: null,
    branch_loading: { LONG: [41.2, 70.4], SHORT: [97.3, 96.8] },
} as unknown as DiagramData;

function Harness({ mode = 'network', metric = 'loading' }: { mode?: ViewMode; metric?: FlowMetric }) {
    const ref = useRef<HTMLDivElement>(null);
    return (
        <div>
            <div ref={ref} data-testid="container" className="svg-container" dangerouslySetInnerHTML={{ __html: SVG }} />
            <BranchLabelLayer containerRef={ref} diagram={DIAGRAM} metaIndex={META} mode={mode} metric={metric}
                monitoringFactor={0.95} displayName={id => (id === 'LONG' ? 'CANTEY761' : id)} />
        </div>
    );
}

describe('BranchLabelLayer', () => {
    beforeEach(() => {
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
            { left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
        Object.defineProperty(SVGElement.prototype, 'getScreenCTM', {
            configurable: true, value: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
        });
    });
    afterEach(() => {
        vi.restoreAllMocks();
        delete (SVGElement.prototype as { getScreenCTM?: unknown }).getScreenCTM;
    });

    it("labels the branches in px over the diagram and hides pypowsybl's own values", async () => {
        render(<Harness />);
        expect(screen.getByTestId('container')).toHaveAttribute(BRANCH_LABELS_ATTR);
        // LONG is long enough for a label per end; SHORT gets its larger end at the middle.
        await waitFor(() => expect(screen.getByText('41%')).toBeInTheDocument());
        expect(screen.getByText('70%')).toBeInTheDocument();
        expect(screen.getByText('97%').closest('g')).toHaveClass('branch-label--loading-over', 'branch-label--important');
        expect(screen.queryByText('96%')).toBeNull();
    });

    it('MW: the larger magnitude at the middle of a short branch', async () => {
        render(<Harness metric="p" />);
        // pypowsybl's own values stay in the diagram (App.css hides them): look in the layer.
        const layer = within(screen.getByTestId('branch-label-layer'));
        await waitFor(() => expect(layer.getByText('412')).toBeInTheDocument());
        expect(layer.getByText('-410')).toBeInTheDocument();
        // SHORT is too short on screen for a grey (MW) label.
        expect(layer.queryByText('55')).toBeNull();
    });

    it('hovering a branch tells both its ends: voltage level, MW and loading', async () => {
        render(<Harness />);
        await waitFor(() => expect(screen.getByText('41%')).toBeInTheDocument());
        fireEvent.mouseMove(screen.getByTestId('container'), { clientX: 300, clientY: 303 });
        const tip = await screen.findByTestId('branch-tooltip');
        expect(tip).toHaveTextContent('CANTEY761');
        expect(tip).toHaveTextContent('CANTEP7412 MW41.2 %');
        expect(tip).toHaveTextContent('CANTEP6-410 MW70.4 %');
        fireEvent.mouseMove(screen.getByTestId('container'), { clientX: 300, clientY: 200 });
        await waitFor(() => expect(screen.queryByTestId('branch-tooltip')).toBeNull());
    });

    it('hides the labels during a pan / zoom gesture', async () => {
        render(<Harness />);
        await waitFor(() => expect(screen.getByText('41%')).toBeInTheDocument());
        await act(async () => { screen.getByTestId('container').setAttribute(GESTURE_PROXY_ATTR, ''); });
        await waitFor(() => expect(screen.getByTestId('branch-label-layer').style.visibility).toBe('hidden'));
        await act(async () => { screen.getByTestId('container').removeAttribute(GESTURE_PROXY_ATTR); });
        await waitFor(() => expect(screen.getByTestId('branch-label-layer').style.visibility).toBe(''));
    });
});
