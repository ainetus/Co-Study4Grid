// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSldOverlay } from './useSldOverlay';

vi.mock('../api', () => ({
    api: {
        getNSld: vi.fn(),
        getN1Sld: vi.fn(),
        getActionVariantSld: vi.fn(),
    }
}));

vi.mock('../utils/interactionLogger', () => ({
    interactionLogger: { record: vi.fn() },
}));

import { api } from '../api';
import { interactionLogger } from '../utils/interactionLogger';

describe('useSldOverlay', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('initializes with null vlOverlay', () => {
        const { result } = renderHook(() => useSldOverlay('n'));
        expect(result.current.vlOverlay).toBeNull();
    });

    it('initializes selectedContingencyForSld ref with an empty list', () => {
        const { result } = renderHook(() => useSldOverlay('n'));
        expect(result.current.selectedContingencyForSld.current).toEqual([]);
    });

    it('handleVlDoubleClick sets vlOverlay with loading state', () => {
        vi.mocked(api.getNSld).mockImplementation(() => new Promise(() => { /* never resolves */ }));
        const { result } = renderHook(() => useSldOverlay('n'));

        act(() => {
            result.current.handleVlDoubleClick('action_1', 'VL_400');
        });

        expect(result.current.vlOverlay).not.toBeNull();
        expect(result.current.vlOverlay!.vlName).toBe('VL_400');
        expect(result.current.vlOverlay!.actionId).toBe('action_1');
        expect(result.current.vlOverlay!.loading).toBe(true);
        expect(result.current.vlOverlay!.svg).toBeNull();
    });

    it('handleVlDoubleClick logs interaction', () => {
        vi.mocked(api.getNSld).mockImplementation(() => new Promise(() => { /* never resolves */ }));
        const { result } = renderHook(() => useSldOverlay('n'));

        act(() => {
            result.current.handleVlDoubleClick('action_1', 'VL_400');
        });

        expect(interactionLogger.record).toHaveBeenCalledWith('sld_overlay_opened', {
            vl_name: 'VL_400',
            action_id: 'action_1',
        });
    });

    it('handleVlDoubleClick uses correct initial tab based on activeTab', () => {
        vi.mocked(api.getN1Sld).mockImplementation(() => new Promise(() => { /* never resolves */ }));
        const { result } = renderHook(() => useSldOverlay('contingency'));

        act(() => {
            result.current.handleVlDoubleClick('act1', 'VL_220');
        });

        expect(result.current.vlOverlay!.tab).toBe('contingency');
    });

    it('handleVlDoubleClick sets tab to action for action activeTab', () => {
        vi.mocked(api.getActionVariantSld).mockImplementation(() => new Promise(() => { /* never resolves */ }));
        const { result } = renderHook(() => useSldOverlay('action'));

        act(() => {
            result.current.handleVlDoubleClick('act1', 'VL_63');
        });

        expect(result.current.vlOverlay!.tab).toBe('action');
    });

    it('handleVlDoubleClick forceTab overrides the activeTab-derived initial tab', () => {
        // The overflow-graph pin double-click drills straight into the
        // post-action SLD regardless of which main tab is active.
        vi.mocked(api.getActionVariantSld).mockImplementation(() => new Promise(() => { /* never resolves */ }));
        const { result } = renderHook(() => useSldOverlay('n'));

        act(() => {
            result.current.handleVlDoubleClick('act1', 'VL_63', 'action');
        });

        expect(result.current.vlOverlay!.tab).toBe('action');
        expect(api.getActionVariantSld).toHaveBeenCalled();
    });

    it('handleOverlayClose sets vlOverlay to null', () => {
        vi.mocked(api.getNSld).mockImplementation(() => new Promise(() => { /* never resolves */ }));
        const { result } = renderHook(() => useSldOverlay('n'));

        act(() => {
            result.current.handleVlDoubleClick('act1', 'VL_400');
        });
        expect(result.current.vlOverlay).not.toBeNull();

        act(() => {
            result.current.handleOverlayClose();
        });
        expect(result.current.vlOverlay).toBeNull();
    });

    it('handleOverlayClose logs interaction', () => {
        const { result } = renderHook(() => useSldOverlay('n'));
        act(() => {
            result.current.handleOverlayClose();
        });
        expect(interactionLogger.record).toHaveBeenCalledWith('sld_overlay_closed');
    });

    it('handleOverlaySldTabChange does nothing when vlOverlay is null', () => {
        const { result } = renderHook(() => useSldOverlay('n'));
        act(() => {
            result.current.handleOverlaySldTabChange('contingency');
        });
        // No error thrown, no overlay set
        expect(result.current.vlOverlay).toBeNull();
    });

    it('handleOverlaySldTabChange logs interaction when vlOverlay exists', () => {
        vi.mocked(api.getNSld).mockImplementation(() => new Promise(() => { /* never resolves */ }));
        const { result } = renderHook(() => useSldOverlay('n'));

        act(() => {
            result.current.handleVlDoubleClick('act1', 'VL_400');
        });

        vi.mocked(api.getN1Sld).mockImplementation(() => new Promise(() => { /* never resolves */ }));
        act(() => {
            result.current.handleOverlaySldTabChange('contingency');
        });

        expect(interactionLogger.record).toHaveBeenCalledWith('sld_overlay_tab_changed', {
            tab: 'contingency',
            vl_name: 'VL_400',
        });
    });

    it('setVlOverlay allows direct state manipulation', () => {
        const { result } = renderHook(() => useSldOverlay('n'));

        act(() => {
            result.current.setVlOverlay({
                vlName: 'VL_TEST',
                actionId: null,
                svg: '<svg/>',
                sldMetadata: null,
                loading: false,
                error: null,
                tab: 'n',
            });
        });

        expect(result.current.vlOverlay).not.toBeNull();
        expect(result.current.vlOverlay!.vlName).toBe('VL_TEST');
    });

    it('fetchSldVariant resolves and populates vlOverlay with N SLD data', async () => {
        vi.mocked(api.getNSld).mockResolvedValue({
            svg: '<svg>N-SLD</svg>',
            sld_metadata: '{"nodes":[]}',
        });

        const { result } = renderHook(() => useSldOverlay('n'));

        act(() => {
            result.current.handleVlDoubleClick('act1', 'VL_400');
        });

        // Wait for the async fetch to complete
        await vi.waitFor(() => {
            expect(result.current.vlOverlay!.loading).toBe(false);
        });

        expect(result.current.vlOverlay!.svg).toBe('<svg>N-SLD</svg>');
        expect(result.current.vlOverlay!.sldMetadata).toBe('{"nodes":[]}');
    });

    it('carries the Loading view of each SLD: its branch loading, and its change on N-1 / action', async () => {
        vi.mocked(api.getNSld).mockResolvedValue({
            svg: '<svg>N-SLD</svg>', sld_metadata: null, voltage_level_id: 'VL_400',
            branch_loading: { L1: [40, 41] },
        });
        vi.mocked(api.getActionVariantSld).mockResolvedValue({
            svg: '<svg>ACT-SLD</svg>', sld_metadata: null, action_id: 'act1', voltage_level_id: 'VL_400',
            branch_loading: { L1: [70, 71] },
            loading_deltas: { L1: { delta: 30, category: 'positive' } },
        });
        const { result } = renderHook(() => useSldOverlay('n'));

        act(() => {
            result.current.handleVlDoubleClick('act1', 'VL_400');
        });
        await vi.waitFor(() => {
            expect(result.current.vlOverlay!.loading).toBe(false);
        });
        expect(result.current.vlOverlay!.branch_loading).toEqual({ L1: [40, 41] });
        expect(result.current.vlOverlay!.loading_deltas).toBeUndefined();

        act(() => {
            result.current.handleOverlaySldTabChange('action');
        });
        await vi.waitFor(() => {
            expect(result.current.vlOverlay!.svg).toBe('<svg>ACT-SLD</svg>');
        });
        expect(result.current.vlOverlay!.branch_loading).toEqual({ L1: [70, 71] });
        expect(result.current.vlOverlay!.loading_deltas).toEqual({ L1: { delta: 30, category: 'positive' } });
    });

    it('fetchSldVariant handles error gracefully', async () => {
        vi.mocked(api.getNSld).mockRejectedValue({
            response: { data: { detail: 'Network error' } },
        });

        const { result } = renderHook(() => useSldOverlay('n'));

        act(() => {
            result.current.handleVlDoubleClick('act1', 'VL_400');
        });

        await vi.waitFor(() => {
            expect(result.current.vlOverlay!.loading).toBe(false);
        });

        expect(result.current.vlOverlay!.error).toBe('Network error');
        expect(result.current.vlOverlay!.svg).toBeNull();
    });

    // Regression for the "Action '' not found in last analysis
    // result" bug: the operator opens the SLD overlay from the
    // N tab (actionId = '') with a remedial action already
    // selected, then clicks the ACTION sub-tab inside the overlay.
    // Previously, handleOverlaySldTabChange forwarded the stored
    // actionId ('') and the backend rejected the request. The
    // hook now falls back to the `liveSelectedActionId` it was
    // instantiated with so a real action id reaches the API.
    describe('action sub-tab fallback (Action "" not found bug)', () => {
        it('falls back to liveSelectedActionId when vlOverlay.actionId is empty', async () => {
            vi.mocked(api.getNSld).mockResolvedValue({
                svg: '<svg>N-SLD</svg>',
                sld_metadata: null,
            });
            vi.mocked(api.getActionVariantSld).mockResolvedValue({
                svg: '<svg>ACT-SLD</svg>',
                sld_metadata: null,
                flow_deltas: {},
                reactive_flow_deltas: {},
                asset_deltas: {},
                changed_switches: {},
            });

            // The hook is instantiated from the main (N) tab with
            // an already-selected action 'ACT_42'.
            const { result } = renderHook(() => useSldOverlay('n', 'ACT_42'));

            // Open the SLD with an empty actionId — this is what
            // App.tsx USED to do when the activeTab was 'n'.
            act(() => {
                result.current.handleVlDoubleClick('', 'VL_400');
            });
            await vi.waitFor(() => {
                expect(result.current.vlOverlay!.loading).toBe(false);
            });
            // Clear mocks so we only see the upcoming call.
            vi.mocked(api.getActionVariantSld).mockClear();

            // Now the user flips the overlay sub-tab to 'action'.
            act(() => {
                result.current.handleOverlaySldTabChange('action');
            });
            await vi.waitFor(() => {
                expect(result.current.vlOverlay!.loading).toBe(false);
            });

            // The API must have been called with the LIVE
            // selectedActionId ('ACT_42'), NOT with the empty
            // actionId stored on vlOverlay. This proves the
            // fallback kicked in.
            expect(api.getActionVariantSld).toHaveBeenCalledWith('ACT_42', 'VL_400');
            // And the overlay now holds the resolved action id so
            // subsequent highlight passes can find it.
            expect(result.current.vlOverlay!.actionId).toBe('ACT_42');
            // No error should have been set.
            expect(result.current.vlOverlay!.error).toBeNull();
        });

        it('shows a friendly error when no action is available at all', async () => {
            vi.mocked(api.getNSld).mockResolvedValue({
                svg: '<svg>N-SLD</svg>',
                sld_metadata: null,
            });
            // No liveSelectedActionId passed → the fallback has
            // nothing to fall back to.
            const { result } = renderHook(() => useSldOverlay('n'));

            act(() => {
                result.current.handleVlDoubleClick('', 'VL_400');
            });
            await vi.waitFor(() => {
                expect(result.current.vlOverlay!.loading).toBe(false);
            });

            act(() => {
                result.current.handleOverlaySldTabChange('action');
            });
            await vi.waitFor(() => {
                expect(result.current.vlOverlay!.loading).toBe(false);
            });

            // No API call should have been issued (we don't want
            // the backend to see the empty-string id and throw).
            expect(api.getActionVariantSld).not.toHaveBeenCalled();
            // Instead, a friendly inline error is shown.
            expect(result.current.vlOverlay!.error).toMatch(/no action selected/i);
        });

        it('prefers the explicit actionId when one is stored on vlOverlay', async () => {
            vi.mocked(api.getActionVariantSld).mockResolvedValue({
                svg: '<svg>ACT-SLD</svg>',
                sld_metadata: null,
                flow_deltas: {},
                reactive_flow_deltas: {},
                asset_deltas: {},
                changed_switches: {},
            });

            // Hook instantiated with a "live" selection of ACT_B,
            // but the overlay was opened with the explicit
            // argument ACT_A — the explicit id must win.
            const { result } = renderHook(() => useSldOverlay('action', 'ACT_B'));

            act(() => {
                result.current.handleVlDoubleClick('ACT_A', 'VL_400');
            });
            await vi.waitFor(() => {
                expect(result.current.vlOverlay!.loading).toBe(false);
            });

            // First call uses the explicit ACT_A.
            expect(api.getActionVariantSld).toHaveBeenCalledWith('ACT_A', 'VL_400');
        });
    });

    describe('refreshCurrentIfAction', () => {
        // Regression: before this wiring a manual re-simulation (MW edit
        // on load-shedding / curtailment, tap edit on PST) updated
        // `result.actions[actionId]` but the SLD overlay kept showing
        // the pre-resimulation highlights and flow deltas because
        // `vlOverlay.svg` was stale.
        it('re-fetches the SLD when the overlay matches the given action', async () => {
            vi.mocked(api.getActionVariantSld).mockResolvedValue({
                svg: '<svg>SLD_v1</svg>',
                sld_metadata: null,
                flow_deltas: {},
                reactive_flow_deltas: {},
                asset_deltas: {},
                changed_switches: {},
            } as unknown as Awaited<ReturnType<typeof api.getActionVariantSld>>);
            const { result } = renderHook(() => useSldOverlay('action'));

            act(() => {
                result.current.handleVlDoubleClick('ACT_LS', 'VL_400');
            });
            await vi.waitFor(() => {
                expect(result.current.vlOverlay!.loading).toBe(false);
            });
            expect(api.getActionVariantSld).toHaveBeenCalledTimes(1);

            act(() => {
                result.current.refreshCurrentIfAction('ACT_LS');
            });
            await vi.waitFor(() => {
                expect(api.getActionVariantSld).toHaveBeenCalledTimes(2);
            });
            expect(api.getActionVariantSld).toHaveBeenLastCalledWith('ACT_LS', 'VL_400');
        });

        it('does nothing when the overlay is closed', () => {
            const { result } = renderHook(() => useSldOverlay('n'));
            expect(result.current.vlOverlay).toBeNull();

            act(() => {
                result.current.refreshCurrentIfAction('ACT_LS');
            });

            expect(api.getActionVariantSld).not.toHaveBeenCalled();
        });

        it('does nothing when the overlay is open on a DIFFERENT action', async () => {
            vi.mocked(api.getActionVariantSld).mockResolvedValue({
                svg: '<svg/>',
                sld_metadata: null,
                flow_deltas: {},
                reactive_flow_deltas: {},
                asset_deltas: {},
                changed_switches: {},
            } as unknown as Awaited<ReturnType<typeof api.getActionVariantSld>>);
            const { result } = renderHook(() => useSldOverlay('action'));

            act(() => {
                result.current.handleVlDoubleClick('ACT_A', 'VL_400');
            });
            await vi.waitFor(() => {
                expect(result.current.vlOverlay!.loading).toBe(false);
            });
            vi.mocked(api.getActionVariantSld).mockClear();

            act(() => {
                result.current.refreshCurrentIfAction('ACT_OTHER');
            });

            expect(api.getActionVariantSld).not.toHaveBeenCalled();
        });
    });
});
