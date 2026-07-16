// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useActionDiagramCache } from './useActionDiagramCache';
import type { DiagramData } from '../types';

const mockProcessSvg = vi.fn();
vi.mock('../utils/svgUtils', () => ({ processSvg: (...args: unknown[]) => mockProcessSvg(...args) }));

const raw = (svg: string) => ({ svg, metadata: '{}' } as unknown as DiagramData & { svg: string });

describe('useActionDiagramCache', () => {
    beforeEach(() => vi.clearAllMocks());

    it('primes a processed diagram (scaled svg + originalViewBox) into the cache', () => {
        mockProcessSvg.mockReturnValue({ svg: '<svg-scaled/>', viewBox: { x: 0, y: 0, w: 1, h: 1 } });
        const { result } = renderHook(() => useActionDiagramCache('L1'));

        act(() => { result.current.primeActionDiagram('ACT', raw('<raw/>'), 3); });

        expect(mockProcessSvg).toHaveBeenCalledWith('<raw/>', 3);
        expect(result.current.actionDiagramCacheRef.current.get('ACT')).toMatchObject({
            svg: '<svg-scaled/>', originalViewBox: { x: 0, y: 0, w: 1, h: 1 },
        });
    });

    it('clears the cache when the contingency key changes', () => {
        mockProcessSvg.mockReturnValue({ svg: 's', viewBox: null });
        const { result, rerender } = renderHook(
            ({ key }) => useActionDiagramCache(key),
            { initialProps: { key: 'L1' } },
        );
        act(() => { result.current.primeActionDiagram('ACT', raw('r'), 1); });
        expect(result.current.actionDiagramCacheRef.current.size).toBe(1);

        rerender({ key: 'L2' });
        expect(result.current.actionDiagramCacheRef.current.size).toBe(0);
    });

    it('LRU-caps the cache at 3 entries, evicting the oldest (QW15)', () => {
        mockProcessSvg.mockReturnValue({ svg: 's', viewBox: null });
        const { result } = renderHook(() => useActionDiagramCache('L1'));
        const cache = () => result.current.actionDiagramCacheRef.current;

        act(() => {
            ['A', 'B', 'C', 'D'].forEach((id) => result.current.primeActionDiagram(id, raw('r'), 1));
        });

        // Cap holds; the oldest (A) was evicted, the last three remain.
        expect(cache().size).toBe(3);
        expect(cache().has('A')).toBe(false);
        expect([...cache().keys()]).toEqual(['B', 'C', 'D']);
    });

    it('re-priming an id refreshes its recency so it survives eviction (QW15)', () => {
        mockProcessSvg.mockReturnValue({ svg: 's', viewBox: null });
        const { result } = renderHook(() => useActionDiagramCache('L1'));
        const cache = () => result.current.actionDiagramCacheRef.current;

        act(() => {
            ['A', 'B', 'C'].forEach((id) => result.current.primeActionDiagram(id, raw('r'), 1));
            // Touch A (moves it to most-recent), then add D → B should be evicted.
            result.current.primeActionDiagram('A', raw('r'), 1);
            result.current.primeActionDiagram('D', raw('r'), 1);
        });

        expect(cache().size).toBe(3);
        expect(cache().has('B')).toBe(false);
        expect([...cache().keys()]).toEqual(['C', 'A', 'D']);
    });

    it('does not throw or store when processSvg fails', () => {
        mockProcessSvg.mockImplementation(() => { throw new Error('bad svg'); });
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { result } = renderHook(() => useActionDiagramCache('L1'));

        act(() => { result.current.primeActionDiagram('ACT', raw('r'), 1); });

        expect(result.current.actionDiagramCacheRef.current.has('ACT')).toBe(false);
        warn.mockRestore();
    });
});
