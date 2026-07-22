// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useDiagramHighlights } from './useDiagramHighlights';
import type { AnalysisResult, DiagramData, MetadataIndex } from '../types';
import type { DiagramsState } from './useDiagrams';

vi.mock('../utils/svgUtils', () => ({
    applyContingencyHighlight: vi.fn(),
    applyDeltaVisuals: vi.fn(),
    applyOverloadedHighlights: vi.fn(),
    applyActionTargetHighlights: vi.fn(),
}));

vi.mock('../utils/overloadHighlights', () => ({
    computeN1OverloadHighlights: vi.fn((analysisOverloads: string[], n1Overloads: string[] | undefined) => {
        if (analysisOverloads && analysisOverloads.length > 0) return analysisOverloads;
        return n1Overloads ?? [];
    }),
}));

import {
    applyContingencyHighlight,
    applyDeltaVisuals,
    applyOverloadedHighlights,
    applyActionTargetHighlights,
} from '../utils/svgUtils';

const makeContainer = (): { current: HTMLElement } => ({
    current: document.createElement('div'),
});

const makeMetaIndex = (): MetadataIndex => ({
    nodesByEquipmentId: new Map(),
    nodesBySvgId: new Map(),
    edgesByEquipmentId: new Map(),
    edgesByNode: new Map(),
} as MetadataIndex);

const makeDiagramsState = (overrides: Partial<DiagramsState> = {}): DiagramsState => {
    const n1Diagram = { svg: '<svg></svg>', lines_overloaded: ['OVL_LINE'] } as unknown as DiagramData;
    const actionDiagram = { svg: '<svg></svg>' } as unknown as DiagramData;
    const base = {
        activeTab: 'contingency',
        nDiagram: { svg: '<svg></svg>' } as unknown as DiagramData,
        n1Diagram,
        actionDiagram,
        actionDiagramLoading: false,
        selectedActionId: null,
        actionViewMode: 'network',
        nMetaIndex: makeMetaIndex(),
        n1MetaIndex: makeMetaIndex(),
        actionMetaIndex: makeMetaIndex(),
        nSvgContainerRef: makeContainer(),
        n1SvgContainerRef: makeContainer(),
        actionSvgContainerRef: makeContainer(),
        setActionViewMode: vi.fn(),
    } as unknown as DiagramsState;
    return { ...base, ...overrides } as DiagramsState;
};

// Regression: the call order drives the DOM append order in
// `#nad-background-layer`, which in turn drives visual stacking —
// later-appended = drawn on top. The product spec is
// "action halo > overload halo > contingency halo" (bottom to top).
// Before the fix, the hook invoked overload → contingency on N-1 and
// overload → action → contingency on the Remedial Action tab, which
// placed the yellow contingency halo on top of the pink action halo.
describe('useDiagramHighlights — halo call order matches product spec', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('N-1 tab invokes contingency BEFORE overload (so overload draws on top)', () => {
        const result = {
            lines_overloaded: ['OVL_LINE'],
            actions: {},
            action_scores: {},
        } as unknown as AnalysisResult;
        const diagrams = makeDiagramsState({ activeTab: 'contingency' });

        renderHook(() => useDiagramHighlights({
            diagrams,
            result,
            selectedBranch: 'CONT_LINE',
            selectedOverloads: new Set<string>(),
            monitoringFactor: 0.95,
            detachedTabs: {},
        }));

        const contingencyOrder = (applyContingencyHighlight as unknown as { mock: { invocationCallOrder: number[] } })
            .mock.invocationCallOrder[0];
        const overloadOrder = (applyOverloadedHighlights as unknown as { mock: { invocationCallOrder: number[] } })
            .mock.invocationCallOrder[0];
        const deltaOrder = (applyDeltaVisuals as unknown as { mock: { invocationCallOrder: number[] } })
            .mock.invocationCallOrder[0];

        expect(contingencyOrder).toBeDefined();
        expect(overloadOrder).toBeDefined();
        expect(deltaOrder).toBeDefined();
        // Contingency first (bottom), overload next (top), deltas last
        // (decorate originals, don't affect the clone cascade).
        expect(contingencyOrder).toBeLessThan(overloadOrder);
        expect(overloadOrder).toBeLessThan(deltaOrder);
    });

    it('Remedial Action tab invokes contingency → overload → action (bottom → top)', () => {
        const actionDetail = {
            description_unitaire: "Ouvrir 'ACT_LINE'",
            action_topology: { lines_ex_bus: { ACT_LINE: -1 } },
            max_rho: 1.2,
            lines_overloaded_after: ['OVL_LINE'],
        };
        const result = {
            lines_overloaded: ['OVL_LINE'],
            actions: { 'act-1': actionDetail },
            action_scores: {},
        } as unknown as AnalysisResult;
        const diagrams = makeDiagramsState({
            activeTab: 'action',
            selectedActionId: 'act-1',
        });

        renderHook(() => useDiagramHighlights({
            diagrams,
            result,
            selectedBranch: 'CONT_LINE',
            selectedOverloads: new Set<string>(),
            monitoringFactor: 0.95,
            detachedTabs: {},
        }));

        const contingencyOrder = (applyContingencyHighlight as unknown as { mock: { invocationCallOrder: number[] } })
            .mock.invocationCallOrder[0];
        const overloadOrder = (applyOverloadedHighlights as unknown as { mock: { invocationCallOrder: number[] } })
            .mock.invocationCallOrder[0];
        const actionOrder = (applyActionTargetHighlights as unknown as { mock: { invocationCallOrder: number[] } })
            .mock.invocationCallOrder[0];

        expect(contingencyOrder).toBeDefined();
        expect(overloadOrder).toBeDefined();
        expect(actionOrder).toBeDefined();
        // Bottom → top.
        expect(contingencyOrder).toBeLessThan(overloadOrder);
        expect(overloadOrder).toBeLessThan(actionOrder);
    });
});

// QW14: the highlight pipeline used to re-run on every pan/zoom settle because
// applyHighlightsForTab depended on the whole `diagrams` object, whose identity
// churns when the per-tab pan/zoom (nPZ/n1PZ/actionPZ) changes. Narrowing that
// dependency to the specific members the callback reads (the two container refs
// + two metaIndexes) makes a settle a no-op for highlighting.
describe('useDiagramHighlights — no re-run on pan/zoom settle (QW14)', () => {
    const callCount = (fn: unknown) =>
        (fn as unknown as { mock: { calls: unknown[] } }).mock.calls.length;

    beforeEach(() => vi.clearAllMocks());

    it('does not re-invoke the highlight helpers when only the diagrams object identity changes', () => {
        const diagrams = makeDiagramsState({ activeTab: 'contingency' });
        const result = {
            lines_overloaded: ['OVL_LINE'], actions: {}, action_scores: {},
        } as unknown as AnalysisResult;
        // Hoisted so ONLY the `diagrams` object identity changes on rerender —
        // otherwise a fresh Set / {} each render would trip other effect deps.
        const selectedOverloads = new Set<string>();
        const detachedTabs = {};
        const props = (d: DiagramsState) => ({
            diagrams: d,
            result,
            selectedBranch: 'CONT_LINE',
            selectedOverloads,
            monitoringFactor: 0.95,
            detachedTabs,
        });

        const { rerender } = renderHook(
            (p: ReturnType<typeof props>) => useDiagramHighlights(p),
            { initialProps: props(diagrams) },
        );
        // Initial pass ran the pipeline.
        expect(callCount(applyContingencyHighlight)).toBeGreaterThan(0);
        vi.clearAllMocks();

        // Simulate a pan/zoom settle: a NEW `diagrams` object identity, but every
        // member (container refs, metaIndexes, the three diagrams) is the SAME
        // reference. With the narrowed deps this must not re-run the pipeline.
        rerender(props({ ...diagrams }));

        expect(callCount(applyContingencyHighlight)).toBe(0);
        expect(callCount(applyOverloadedHighlights)).toBe(0);
        expect(callCount(applyDeltaVisuals)).toBe(0);
    });
});
