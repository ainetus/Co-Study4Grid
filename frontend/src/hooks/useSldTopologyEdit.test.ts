// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment jsdom

import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSldTopologyEdit } from './useSldTopologyEdit';
import { interactionLogger } from '../utils/interactionLogger';

const baseline = (): Record<string, boolean> => ({
    SW_A: false,
    SW_B: true,
    SW_C: false,
});

describe('useSldTopologyEdit', () => {
    beforeEach(() => { interactionLogger.clear(); });

    it('ignores toggles while edit mode is off', () => {
        const { result } = renderHook(() => useSldTopologyEdit(baseline()));
        act(() => { result.current.toggleSwitch('SW_A'); });
        expect(result.current.changedSwitches).toEqual({});
        expect(result.current.pendingChanges).toHaveLength(0);
    });

    it('records a switch toggle relative to baseline', () => {
        const { result } = renderHook(() => useSldTopologyEdit(baseline()));
        act(() => { result.current.setEditMode(true); });
        act(() => { result.current.toggleSwitch('SW_A'); });
        expect(result.current.changedSwitches).toEqual({ SW_A: true });
        expect(result.current.pendingChanges).toEqual([
            { switchId: 'SW_A', baselineOpen: false, targetOpen: true },
        ]);
    });

    it('removes the override when toggled back to baseline', () => {
        const { result } = renderHook(() => useSldTopologyEdit(baseline()));
        act(() => { result.current.setEditMode(true); });
        act(() => { result.current.toggleSwitch('SW_A'); });
        act(() => { result.current.toggleSwitch('SW_A'); });
        expect(result.current.changedSwitches).toEqual({});
    });

    it('rejects taps on switches not in the baseline', () => {
        const { result } = renderHook(() => useSldTopologyEdit(baseline()));
        act(() => { result.current.setEditMode(true); });
        act(() => { result.current.toggleSwitch('UNKNOWN_SW'); });
        expect(result.current.changedSwitches).toEqual({});
    });

    it('reset() clears all pending toggles and logs', () => {
        const { result } = renderHook(() => useSldTopologyEdit(baseline()));
        act(() => { result.current.setEditMode(true); });
        act(() => { result.current.toggleSwitch('SW_A'); });
        act(() => { result.current.toggleSwitch('SW_B'); });
        expect(result.current.changedSwitches).toEqual({ SW_A: true, SW_B: false });
        act(() => { result.current.reset(); });
        expect(result.current.changedSwitches).toEqual({});
        const types = interactionLogger.getLog().map(e => e.type);
        expect(types).toContain('sld_edit_reset');
    });

    it('switching edit mode off drops pending toggles', () => {
        const { result } = renderHook(() => useSldTopologyEdit(baseline()));
        act(() => { result.current.setEditMode(true); });
        act(() => { result.current.toggleSwitch('SW_A'); });
        act(() => { result.current.setEditMode(false); });
        expect(result.current.changedSwitches).toEqual({});
    });

    it('drops pending toggles when baseline identity changes', () => {
        let baselineRef = baseline();
        const { result, rerender } = renderHook(
            (props: { b: Record<string, boolean> | undefined }) => useSldTopologyEdit(props.b),
            { initialProps: { b: baselineRef } },
        );
        act(() => { result.current.setEditMode(true); });
        act(() => { result.current.toggleSwitch('SW_A'); });
        expect(result.current.changedSwitches).toEqual({ SW_A: true });

        baselineRef = baseline();
        rerender({ b: baselineRef });
        expect(result.current.changedSwitches).toEqual({});
    });

    it('logs sld_switch_toggled on each successful toggle', () => {
        const { result } = renderHook(() => useSldTopologyEdit(baseline()));
        act(() => { result.current.setEditMode(true); });
        act(() => { result.current.toggleSwitch('SW_A'); });
        const toggles = interactionLogger.getLog().filter(e => e.type === 'sld_switch_toggled');
        expect(toggles).toHaveLength(1);
        expect(toggles[0].details).toEqual({ equipment_id: 'SW_A' });
    });
});
