// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useContextMap } from './useContextMap';
import { signalStudyLoad } from '../utils/studyLoadSignal';
import type { AnalysisResult, ContextMapData, ContextMapElement, DiagramData } from '../types';

vi.mock('../api', () => ({
    api: {
        getContextMap: vi.fn(),
        getContextMapElements: vi.fn(),
    },
}));
import { api } from '../api';

const mockApi = api as unknown as {
    getContextMap: ReturnType<typeof vi.fn>;
    getContextMapElements: ReturnType<typeof vi.fn>;
};

const map = (captureId: number): ContextMapData => ({
    mesh: 'region', home: 'FR', frame: 'geo', bounds: [0, -52, 11, 11], georef: null,
    flows_available: true, capture_id: captureId, basemap: [], country_labels: [],
    zones: [], flows: [], totals: { production: 0, consumption: 0, net_export: 0 },
});

const element = (id: string): ContextMapElement => ({
    id, name: `name ${id}`, kind: 'branch', zones: ['LYON', 'LYON'],
    points: [[1, -45], [2, -46]], zone_points: [[1, -45], [1, -45]],
});

interface Args {
    studyGeneration: number;
    selectedContingency: string[];
    result: AnalysisResult | null;
    n1Diagram: DiagramData | null;
    selectedOverloads: Set<string>;
}
const args = (over: Partial<Args> = {}): Args => ({
    studyGeneration: 0, selectedContingency: [], result: null, n1Diagram: null,
    selectedOverloads: new Set(), ...over,
});

describe('useContextMap', () => {
    beforeEach(() => {
        vi.useRealTimers();
        mockApi.getContextMap.mockReset();
        mockApi.getContextMapElements.mockReset();
        mockApi.getContextMapElements.mockImplementation(async (ids: string[]) => ids.map(element));
    });
    afterEach(() => vi.useRealTimers());

    it('stays empty before any study is loaded', () => {
        const { result } = renderHook(() => useContextMap(args()));
        expect(result.current.data).toBeNull();
        // No study, no Context tab.
        expect(result.current.available).toBe(false);
        expect(mockApi.getContextMap).not.toHaveBeenCalled();
    });

    it('fetches the map once /api/config has answered', async () => {
        mockApi.getContextMap.mockResolvedValue(map(1));
        const { result } = renderHook(() => useContextMap(args({ studyGeneration: 1 })));
        // Unknown while it is read: the tab stays until the answer.
        expect(result.current.available).toBeNull();
        await waitFor(() => expect(result.current.data?.capture_id).toBe(1));
        expect(result.current.loading).toBe(false);
        expect(result.current.available).toBe(true);
        expect(result.current.unavailableReason).toBeNull();
    });

    it('says why a network has no map — and no tab', async () => {
        mockApi.getContextMap.mockResolvedValue({
            available: false, capture_id: 3,
            unavailable_reason: 'it covers a single zone (France): the map compares at least 2',
        });
        const { result } = renderHook(() => useContextMap(args({ studyGeneration: 1 })));
        await waitFor(() => expect(result.current.available).toBe(false));
        expect(result.current.data).toBeNull();
        expect(result.current.unavailableReason).toMatch(/single zone \(France\)/);
        expect(result.current.highlights).toEqual([]);
    });

    it('reports a failed fetch', async () => {
        mockApi.getContextMap.mockRejectedValue(new Error('down'));
        const { result } = renderHook(() => useContextMap(args({ studyGeneration: 1 })));
        await waitFor(() => expect(result.current.error).toBe('down'));
        expect(result.current.data).toBeNull();
        expect(result.current.available).toBe(false);
    });

    it('reads the map early, while /api/config runs, skipping the previous study', async () => {
        mockApi.getContextMap.mockResolvedValueOnce(map(1));
        const { result, rerender } = renderHook((a: Args) => useContextMap(a), {
            initialProps: args({ studyGeneration: 1 }),
        });
        await waitFor(() => expect(result.current.data?.capture_id).toBe(1));

        // Next study: the backend still serves capture 1, then capture 2.
        mockApi.getContextMap
            .mockResolvedValueOnce(map(1))
            .mockResolvedValueOnce(map(2));
        act(() => signalStudyLoad('start'));
        expect(result.current.data).toBeNull();
        expect(result.current.loading).toBe(true);
        await waitFor(() => expect(result.current.data?.capture_id).toBe(2), { timeout: 3000 });
        expect(result.current.loading).toBe(false);

        // /api/config answers: the confirmation fetch returns the same map —
        // nothing is replaced.
        const shown = result.current.data;
        mockApi.getContextMap.mockResolvedValue(map(2));
        act(() => signalStudyLoad('loaded'));
        rerender(args({ studyGeneration: 2 }));
        await waitFor(() => expect(mockApi.getContextMap).toHaveBeenCalledTimes(4));
        expect(result.current.data).toBe(shown);
    });

    it('stops the early read when the study load fails', async () => {
        mockApi.getContextMap.mockRejectedValue(new Error('404'));
        const { result } = renderHook(() => useContextMap(args()));
        act(() => signalStudyLoad('start'));
        expect(result.current.loading).toBe(true);
        act(() => signalStudyLoad('failed'));
        expect(result.current.loading).toBe(false);
        const calls = mockApi.getContextMap.mock.calls.length;
        await new Promise(r => setTimeout(r, 900));
        expect(mockApi.getContextMap.mock.calls.length).toBe(calls);
    });

    it('resolves the contingency and its overloads, with their loading', async () => {
        mockApi.getContextMap.mockResolvedValue(map(1));
        const n1Diagram = {
            svg: '', metadata: null, lines_overloaded: ['OVL_A', 'OVL_B'], lines_overloaded_rho: [1.08, 1.02],
            lines_overloaded_rho_before: [0.81, null],
        } as DiagramData;
        const { result } = renderHook(() => useContextMap(args({
            studyGeneration: 1, selectedContingency: ['CONT'], n1Diagram,
            selectedOverloads: new Set(['OVL_A']), monitoringFactor: 0.95,
        })));
        await waitFor(() => expect(result.current.highlights).toHaveLength(2));
        // Loading after the contingency, and before it (N) when the diagram knows it.
        expect(result.current.highlights.map(h => [h.element.id, h.role, h.rho, h.rhoBefore])).toEqual([
            ['CONT', 'contingency', undefined, undefined],
            ['OVL_A', 'overload', 1.08, 0.81],
        ]);
        expect(result.current.monitoringFactor).toBe(0.95);
        expect(mockApi.getContextMapElements).toHaveBeenCalledWith(['CONT', 'OVL_A']);
    });

    it('caches element geometry per study', async () => {
        mockApi.getContextMap.mockResolvedValue(map(1));
        const { result, rerender } = renderHook((a: Args) => useContextMap(a), {
            initialProps: args({ studyGeneration: 1, selectedContingency: ['A'] }),
        });
        await waitFor(() => expect(result.current.highlights).toHaveLength(1));
        rerender(args({ studyGeneration: 1, selectedContingency: ['B'] }));
        await waitFor(() => expect(result.current.highlights[0]?.element.id).toBe('B'));
        rerender(args({ studyGeneration: 1, selectedContingency: ['A'] }));
        await waitFor(() => expect(result.current.highlights[0]?.element.id).toBe('A'));
        expect(mockApi.getContextMapElements).toHaveBeenCalledTimes(2);
    });
});
