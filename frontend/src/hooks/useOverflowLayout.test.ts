// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useOverflowLayout } from './useOverflowLayout';
import type { AnalysisResult } from '../types';

const mockRegen = vi.fn();
vi.mock('../api', () => ({ api: { regenerateOverflowGraph: (...args: unknown[]) => mockRegen(...args) } }));

describe('useOverflowLayout', () => {
    beforeEach(() => vi.clearAllMocks());

    it('starts hierarchical and not loading', () => {
        const { result } = renderHook(() => useOverflowLayout());
        expect(result.current.overflowLayoutMode).toBe('hierarchical');
        expect(result.current.overflowLayoutLoading).toBe(false);
    });

    it('regenerates, merges the new pdf url/path into result, and sets the mode', async () => {
        mockRegen.mockResolvedValue({ pdf_url: '/results/pdf/geo.html', pdf_path: '/tmp/geo.html', cached: false });
        const { result } = renderHook(() => useOverflowLayout());
        const setResult = vi.fn();

        await act(async () => {
            await result.current.handleOverflowLayoutChange('geo', setResult, vi.fn());
        });

        expect(mockRegen).toHaveBeenCalledWith('geo');
        expect(result.current.overflowLayoutMode).toBe('geo');
        expect(result.current.overflowLayoutLoading).toBe(false);
        // The updater merges the pdf fields onto the prior result.
        const updater = setResult.mock.calls.at(-1)![0] as (p: AnalysisResult | null) => AnalysisResult | null;
        expect(updater({ actions: {} } as unknown as AnalysisResult)).toMatchObject({
            pdf_url: '/results/pdf/geo.html', pdf_path: '/tmp/geo.html',
        });
    });

    it('surfaces a regeneration failure via setError and clears loading', async () => {
        mockRegen.mockRejectedValue(new Error('graphviz died'));
        const { result } = renderHook(() => useOverflowLayout());
        const setError = vi.fn();

        await act(async () => {
            await result.current.handleOverflowLayoutChange('geo', vi.fn(), setError);
        });

        expect(setError).toHaveBeenCalledWith(expect.stringContaining('graphviz died'));
        expect(result.current.overflowLayoutLoading).toBe(false);
    });
});
