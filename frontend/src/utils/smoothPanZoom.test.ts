// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { isSmoothPanZoomEnabled, setSmoothPanZoomEnabled } from './smoothPanZoom';
import { interactionLogger } from './interactionLogger';

describe('smoothPanZoom preference singleton', () => {
    beforeEach(() => {
        localStorage.clear();
        setSmoothPanZoomEnabled(false);
    });

    it('defaults to OFF', () => {
        expect(isSmoothPanZoomEnabled()).toBe(false);
    });

    it('toggles, persists to localStorage, and reads back', () => {
        setSmoothPanZoomEnabled(true);
        expect(isSmoothPanZoomEnabled()).toBe(true);
        expect(localStorage.getItem('cs4g-smooth-pan-zoom')).toBe('1');

        setSmoothPanZoomEnabled(false);
        expect(isSmoothPanZoomEnabled()).toBe(false);
        expect(localStorage.getItem('cs4g-smooth-pan-zoom')).toBe('0');
    });

    it('notifies subscribers only on a real change', () => {
        // Re-import to access the internal store via the public hook surface
        // is awkward; instead assert the logger fires once per real flip.
        const spy = vi.spyOn(interactionLogger, 'record');
        setSmoothPanZoomEnabled(true);
        setSmoothPanZoomEnabled(true); // no-op, same value
        setSmoothPanZoomEnabled(false);
        const calls = spy.mock.calls.filter(([t]) => t === 'smooth_pan_zoom_toggled');
        expect(calls).toHaveLength(2);
        expect(calls[0][1]).toEqual({ enabled: true });
        expect(calls[1][1]).toEqual({ enabled: false });
        spy.mockRestore();
    });
});
