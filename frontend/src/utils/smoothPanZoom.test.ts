// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    isSmoothPanZoomEnabled,
    setSmoothPanZoomEnabled,
    getSmoothPanZoomMode,
    setSmoothPanZoomMode,
} from './smoothPanZoom';
import { interactionLogger } from './interactionLogger';

describe('smoothPanZoom preference singleton', () => {
    beforeEach(() => {
        localStorage.clear();
        setSmoothPanZoomMode('off');
    });

    it('defaults to OFF', () => {
        expect(getSmoothPanZoomMode()).toBe('off');
        expect(isSmoothPanZoomEnabled()).toBe(false);
    });

    it('persists each mode to localStorage and reads it back', () => {
        setSmoothPanZoomMode('gpu');
        expect(getSmoothPanZoomMode()).toBe('gpu');
        expect(isSmoothPanZoomEnabled()).toBe(true);
        expect(localStorage.getItem('cs4g-smooth-pan-zoom')).toBe('gpu');

        setSmoothPanZoomMode('bitmap');
        expect(getSmoothPanZoomMode()).toBe('bitmap');
        expect(isSmoothPanZoomEnabled()).toBe(true);
        expect(localStorage.getItem('cs4g-smooth-pan-zoom')).toBe('bitmap');

        setSmoothPanZoomMode('off');
        expect(getSmoothPanZoomMode()).toBe('off');
        expect(isSmoothPanZoomEnabled()).toBe(false);
        expect(localStorage.getItem('cs4g-smooth-pan-zoom')).toBe('off');
    });

    it('back-compat boolean setter maps true→gpu, false→off', () => {
        setSmoothPanZoomEnabled(true);
        expect(getSmoothPanZoomMode()).toBe('gpu');
        setSmoothPanZoomEnabled(false);
        expect(getSmoothPanZoomMode()).toBe('off');
    });

    it('notifies + logs only on a real change, with enabled + mode', () => {
        const spy = vi.spyOn(interactionLogger, 'record');
        setSmoothPanZoomMode('bitmap');
        setSmoothPanZoomMode('bitmap'); // no-op, same value
        setSmoothPanZoomMode('off');
        const calls = spy.mock.calls.filter(([t]) => t === 'smooth_pan_zoom_toggled');
        expect(calls).toHaveLength(2);
        expect(calls[0][1]).toEqual({ enabled: true, mode: 'bitmap' });
        expect(calls[1][1]).toEqual({ enabled: false, mode: 'off' });
        spy.mockRestore();
    });
});
