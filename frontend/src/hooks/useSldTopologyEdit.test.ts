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
import type { VlInjection } from '../types';

const baseline = (): Record<string, boolean> => ({
    SW_A: false,
    SW_B: true,
    SW_C: false,
});

const injectionsBaseline = (): Record<string, VlInjection> => ({
    GEN_A: { kind: 'generator', p: 100, min_p: 0, max_p: 200, energy_source: 'WIND' },
    LOAD_A: { kind: 'load', p: 50 },
});

// IMPORTANT: each test passes a STABLE baseline reference. The hook
// resets pendingStates whenever the baseline identity changes, so
// recreating the object on every render (`() =>
// useSldTopologyEdit(baseline())`) would call setState({}) inside
// the effect on every render — an infinite loop that OOM'd CI before
// the bail-out guard was added in the hook (see the comment on the
// guarded useEffect). Keeping it stable here is the production
// pattern: ``vlOverlay.switch_states`` only changes when a new SLD
// payload arrives.

describe('useSldTopologyEdit', () => {
    beforeEach(() => { interactionLogger.clear(); });

    it('ignores toggles while edit mode is off', () => {
        const b = baseline();
        const { result } = renderHook(() => useSldTopologyEdit(b));
        act(() => { result.current.toggleSwitch('SW_A'); });
        expect(result.current.changedSwitches).toEqual({});
        expect(result.current.pendingChanges).toHaveLength(0);
    });

    it('records a switch toggle relative to baseline', () => {
        const b = baseline();
        const { result } = renderHook(() => useSldTopologyEdit(b));
        act(() => { result.current.setEditMode(true); });
        act(() => { result.current.toggleSwitch('SW_A'); });
        expect(result.current.changedSwitches).toEqual({ SW_A: true });
        expect(result.current.pendingChanges).toEqual([
            { switchId: 'SW_A', baselineOpen: false, targetOpen: true },
        ]);
    });

    it('removes the override when toggled back to baseline', () => {
        const b = baseline();
        const { result } = renderHook(() => useSldTopologyEdit(b));
        act(() => { result.current.setEditMode(true); });
        act(() => { result.current.toggleSwitch('SW_A'); });
        act(() => { result.current.toggleSwitch('SW_A'); });
        expect(result.current.changedSwitches).toEqual({});
    });

    it('rejects taps on switches not in the baseline', () => {
        const b = baseline();
        const { result } = renderHook(() => useSldTopologyEdit(b));
        act(() => { result.current.setEditMode(true); });
        act(() => { result.current.toggleSwitch('UNKNOWN_SW'); });
        expect(result.current.changedSwitches).toEqual({});
    });

    it('reset() clears all pending toggles and logs', () => {
        const b = baseline();
        const { result } = renderHook(() => useSldTopologyEdit(b));
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
        const b = baseline();
        const { result } = renderHook(() => useSldTopologyEdit(b));
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

    it('removeSwitch drops a single staged change', () => {
        const b = baseline();
        const { result } = renderHook(() => useSldTopologyEdit(b));
        act(() => { result.current.setEditMode(true); });
        act(() => { result.current.toggleSwitch('SW_A'); });
        act(() => { result.current.toggleSwitch('SW_B'); });
        act(() => { result.current.removeSwitch('SW_A'); });
        expect(result.current.changedSwitches).toEqual({ SW_B: false });
    });

    it('removeSwitches drops a block of staged changes', () => {
        const b = baseline();
        const { result } = renderHook(() => useSldTopologyEdit(b));
        act(() => { result.current.setEditMode(true); });
        act(() => { result.current.toggleSwitch('SW_A'); });
        act(() => { result.current.toggleSwitch('SW_B'); });
        act(() => { result.current.toggleSwitch('SW_C'); });
        act(() => { result.current.removeSwitches(['SW_A', 'SW_C']); });
        expect(result.current.changedSwitches).toEqual({ SW_B: false });
    });

    it('focus state tracks setFocusedSwitch and clears on removal', () => {
        const b = baseline();
        const { result } = renderHook(() => useSldTopologyEdit(b));
        act(() => { result.current.setEditMode(true); });
        act(() => { result.current.toggleSwitch('SW_A'); });
        act(() => { result.current.setFocusedSwitch('SW_A'); });
        expect(result.current.focusedSwitchId).toBe('SW_A');
        act(() => { result.current.removeSwitch('SW_A'); });
        expect(result.current.focusedSwitchId).toBeNull();
    });

    it('logs sld_switch_toggled on each successful toggle', () => {
        const b = baseline();
        const { result } = renderHook(() => useSldTopologyEdit(b));
        act(() => { result.current.setEditMode(true); });
        act(() => { result.current.toggleSwitch('SW_A'); });
        const toggles = interactionLogger.getLog().filter(e => e.type === 'sld_switch_toggled');
        expect(toggles).toHaveLength(1);
        expect(toggles[0].details).toEqual({ equipment_id: 'SW_A' });
    });

    // Regression: the baseline-change effect used to call
    // ``setPendingStates({})`` unconditionally. When the parent passed
    // a fresh object literal on every render (which renderHook does
    // when the props callback re-creates it), React saw a new state
    // value on every render → re-render → effect → setState → loop →
    // OOM at ~4 GB. The hook now bails out via prev-equality and the
    // test below would have failed-fast (timeout) on the old code.
    it('does not infinite-loop when the baseline is recreated each render', () => {
        const { result } = renderHook(
            (props: { tick: number }) =>
                // Same shape every render but a brand-new object → identity
                // changes whenever ``tick`` does. The hook must not relay
                // the change into an unconditional setState.
                useSldTopologyEdit({ SW_A: false, _tick: props.tick > 0 } as unknown as Record<string, boolean>),
            { initialProps: { tick: 0 } },
        );
        for (let i = 0; i < 50; i++) {
            // Use renderHook's rerender via re-running act — each pass
            // forces a fresh baseline literal. Without the bail-out
            // this loop wedges.
            act(() => { result.current.setEditMode(i % 2 === 0); });
        }
        expect(result.current.changedSwitches).toEqual({});
    });

    it('ignores injection edits while edit mode is off', () => {
        const b = baseline();
        const inj = injectionsBaseline();
        const { result } = renderHook(() => useSldTopologyEdit(b, inj));
        act(() => { result.current.setInjection('GEN_A', 90); });
        expect(result.current.changedInjections).toEqual({});
        expect(result.current.injectionChanges).toHaveLength(0);
    });

    it('stages an injection retune relative to baseline', () => {
        const b = baseline();
        const inj = injectionsBaseline();
        const { result } = renderHook(() => useSldTopologyEdit(b, inj));
        act(() => { result.current.setEditMode(true); });
        act(() => { result.current.setInjection('GEN_A', 90); });
        expect(result.current.changedInjections).toEqual({ GEN_A: 90 });
        expect(result.current.injectionChanges).toEqual([
            { equipmentId: 'GEN_A', kind: 'generator', baselineP: 100, targetP: 90, minP: 0, maxP: 200, energySource: 'WIND' },
        ]);
        expect(result.current.hasPendingChanges).toBe(true);
    });

    it('drops the injection override when retuned back onto the baseline', () => {
        const b = baseline();
        const inj = injectionsBaseline();
        const { result } = renderHook(() => useSldTopologyEdit(b, inj));
        act(() => { result.current.setEditMode(true); });
        act(() => { result.current.setInjection('GEN_A', 90); });
        act(() => { result.current.setInjection('GEN_A', 100); });
        expect(result.current.changedInjections).toEqual({});
    });

    it('rejects injection edits on equipment absent from the baseline', () => {
        const b = baseline();
        const inj = injectionsBaseline();
        const { result } = renderHook(() => useSldTopologyEdit(b, inj));
        act(() => { result.current.setEditMode(true); });
        act(() => { result.current.setInjection('GEN_UNKNOWN', 10); });
        expect(result.current.changedInjections).toEqual({});
    });

    it('removeInjection drops a staged retune and clears focus', () => {
        const b = baseline();
        const inj = injectionsBaseline();
        const { result } = renderHook(() => useSldTopologyEdit(b, inj));
        act(() => { result.current.setEditMode(true); });
        act(() => { result.current.setInjection('GEN_A', 90); });
        act(() => { result.current.setInjection('LOAD_A', 30); });
        act(() => { result.current.setFocusedSwitch('GEN_A'); });
        act(() => { result.current.removeInjection('GEN_A'); });
        expect(result.current.changedInjections).toEqual({ LOAD_A: 30 });
        expect(result.current.focusedSwitchId).toBeNull();
    });

    it('switch and injection edits coexist; reset and edit-off clear both', () => {
        const b = baseline();
        const inj = injectionsBaseline();
        const { result } = renderHook(() => useSldTopologyEdit(b, inj));
        act(() => { result.current.setEditMode(true); });
        act(() => { result.current.toggleSwitch('SW_A'); });
        act(() => { result.current.setInjection('GEN_A', 80); });
        expect(result.current.changedSwitches).toEqual({ SW_A: true });
        expect(result.current.changedInjections).toEqual({ GEN_A: 80 });
        expect(result.current.hasPendingChanges).toBe(true);
        act(() => { result.current.reset(); });
        expect(result.current.changedSwitches).toEqual({});
        expect(result.current.changedInjections).toEqual({});
        expect(interactionLogger.getLog().map(e => e.type)).toContain('sld_edit_reset');
    });

    it('drops staged injections when the injection baseline identity changes', () => {
        let injRef = injectionsBaseline();
        const stableSwitches = baseline();
        const { result, rerender } = renderHook(
            (props: { inj: Record<string, VlInjection> }) => useSldTopologyEdit(stableSwitches, props.inj),
            { initialProps: { inj: injRef } },
        );
        act(() => { result.current.setEditMode(true); });
        act(() => { result.current.setInjection('GEN_A', 75); });
        expect(result.current.changedInjections).toEqual({ GEN_A: 75 });
        injRef = injectionsBaseline();
        rerender({ inj: injRef });
        expect(result.current.changedInjections).toEqual({});
    });

    it('logs sld_injection_staged and sld_injection_removed', () => {
        const b = baseline();
        const inj = injectionsBaseline();
        const { result } = renderHook(() => useSldTopologyEdit(b, inj));
        act(() => { result.current.setEditMode(true); });
        act(() => { result.current.setInjection('GEN_A', 90); });
        act(() => { result.current.removeInjection('GEN_A'); });
        const types = interactionLogger.getLog().map(e => e.type);
        expect(types).toContain('sld_injection_staged');
        expect(types).toContain('sld_injection_removed');
        const staged = interactionLogger.getLog().find(e => e.type === 'sld_injection_staged');
        expect(staged?.details).toMatchObject({ equipment_id: 'GEN_A', kind: 'generator', target_mw: 90 });
    });

    it('a no-op baseline change does not destroy a focus or staged toggle on the SAME identity', () => {
        // Defensive: as long as the baseline reference is stable
        // across renders that come from OTHER state changes, the
        // hook must NOT drop overrides. This proves the effect's
        // dep array is just the baseline (not e.g. pendingStates).
        const b = baseline();
        const { result, rerender } = renderHook(
            (props: { b: Record<string, boolean> }) => useSldTopologyEdit(props.b),
            { initialProps: { b } },
        );
        act(() => { result.current.setEditMode(true); });
        act(() => { result.current.toggleSwitch('SW_A'); });
        act(() => { result.current.setFocusedSwitch('SW_A'); });
        // Force a re-render with the SAME baseline object.
        rerender({ b });
        rerender({ b });
        expect(result.current.changedSwitches).toEqual({ SW_A: true });
        expect(result.current.focusedSwitchId).toBe('SW_A');
    });
});
