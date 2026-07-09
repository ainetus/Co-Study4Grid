// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useManualSimulation, type ManualSimulationParams } from './useManualSimulation';
import type { DiagramsState } from './useDiagrams';
import type { AnalysisResult, VlOverlay } from '../types';

const mockSimStream = vi.fn();
const mockGetSldTopologyPreview = vi.fn();

vi.mock('../api', () => ({
    api: {
        simulateAndVariantDiagramStream: (...args: unknown[]) => mockSimStream(...args),
        getSldTopologyPreview: (...args: unknown[]) => mockGetSldTopologyPreview(...args),
        simulateManualAction: vi.fn(),
    },
}));

/** Build a streamed NDJSON Response-like from event objects. */
function ndjson(events: object[]) {
    const enc = new TextEncoder();
    return {
        ok: true,
        body: new ReadableStream<Uint8Array>({
            start(controller) {
                for (const e of events) controller.enqueue(enc.encode(JSON.stringify(e) + '\n'));
                controller.close();
            },
        }),
    };
}

function makeDiagrams(overrides: Partial<DiagramsState> = {}): DiagramsState {
    return {
        vlOverlay: null,
        primeActionDiagram: vi.fn(),
        handleVlDoubleClick: vi.fn(),
        ...overrides,
    } as unknown as DiagramsState;
}

function makeParams(overrides: Partial<ManualSimulationParams> = {}): ManualSimulationParams {
    return {
        diagrams: makeDiagrams(),
        selectedContingency: ['LINE_X'],
        result: null,
        voltageLevels: ['VL1'],
        wrappedManualActionAdded: vi.fn(),
        setError: vi.fn(),
        ...overrides,
    };
}

function overlay(partial: Partial<VlOverlay>): VlOverlay {
    return {
        vlName: 'VL', actionId: null, svg: null, sldMetadata: null,
        loading: false, error: null, tab: 'n-1',
        ...partial,
    } as VlOverlay;
}

describe('useManualSimulation', () => {
    beforeEach(() => { vi.clearAllMocks(); });

    describe('handleSimulateUnsimulatedAction', () => {
        it('errors (no API call) when no contingency is selected', async () => {
            const setError = vi.fn();
            const { result } = renderHook(() =>
                useManualSimulation(makeParams({ selectedContingency: [], setError })));

            await act(async () => { await result.current.handleSimulateUnsimulatedAction('ACT'); });

            expect(setError).toHaveBeenCalledWith('Select a contingency first.');
            expect(mockSimStream).not.toHaveBeenCalled();
        });

        it('streams metrics+diagram, primes the diagram, and registers the action with model provenance', async () => {
            const diagrams = makeDiagrams();
            const wrappedManualActionAdded = vi.fn();
            mockSimStream.mockResolvedValue(ndjson([
                { type: 'metrics', action_id: 'ACT', description_unitaire: 'd', rho_before: [1], rho_after: [0.9], max_rho: 0.9, max_rho_line: 'LINE_1', is_rho_reduction: true, lines_overloaded: ['LINE_1'] },
                { type: 'diagram', svg: '<svg/>', metadata: '{}', action_id: 'ACT' },
            ]));
            const { result } = renderHook(() => useManualSimulation(makeParams({
                diagrams,
                wrappedManualActionAdded,
                result: { active_model: 'random' } as unknown as AnalysisResult,
            })));

            await act(async () => { await result.current.handleSimulateUnsimulatedAction('ACT'); });

            expect(diagrams.primeActionDiagram).toHaveBeenCalledWith('ACT', expect.objectContaining({ svg: '<svg/>' }), 1);
            // Provenance = the model that scored the pin, not "user".
            expect(wrappedManualActionAdded).toHaveBeenCalledWith(
                'ACT', expect.objectContaining({ max_rho_line: 'LINE_1' }), ['LINE_1'], 'random',
            );
        });

        it('surfaces a stream error event via setError', async () => {
            const setError = vi.fn();
            mockSimStream.mockResolvedValue(ndjson([{ type: 'error', message: 'boom' }]));
            const { result } = renderHook(() => useManualSimulation(makeParams({ setError })));

            await act(async () => { await result.current.handleSimulateUnsimulatedAction('ACT'); });

            expect(setError).toHaveBeenCalledWith('boom');
        });
    });

    describe('handleSimulateSldEdit', () => {
        it('is a no-op when nothing is staged', async () => {
            const { result } = renderHook(() =>
                useManualSimulation(makeParams({ diagrams: makeDiagrams({ vlOverlay: overlay({ tab: 'action' }) }) })));

            await act(async () => { await result.current.handleSimulateSldEdit(); });

            expect(mockSimStream).not.toHaveBeenCalled();
        });
    });

    describe('sldEditBaseActionId', () => {
        it('is null off the action tab and the action id on it', () => {
            const { result, rerender } = renderHook(
                ({ ov }: { ov: VlOverlay }) => useManualSimulation(makeParams({ diagrams: makeDiagrams({ vlOverlay: ov }) })),
                { initialProps: { ov: overlay({ tab: 'n-1', actionId: 'X' }) } },
            );
            expect(result.current.sldEditBaseActionId).toBeNull();

            rerender({ ov: overlay({ tab: 'action', actionId: 'ACT_1' }) });
            expect(result.current.sldEditBaseActionId).toBe('ACT_1');
        });
    });
});
