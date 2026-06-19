// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import { useSyncExternalStore } from 'react';
import { interactionLogger } from './interactionLogger';

/**
 * "Smooth pan/zoom (GPU)" preference — an OPT-IN, off-by-default rendering
 * mode that swaps usePanZoom's per-frame viewBox rewrite (full vector
 * repaint) for a compositor-only CSS transform during the gesture, baking
 * back to viewBox on settle. On GPU-accelerated browsers this is far
 * smoother on large grids; on software / VDI / remote-desktop sessions it
 * regresses badly (every pan frame re-rasters new layer tiles), which is
 * exactly why it is opt-in and defaults OFF. The safe default path is the
 * viewBox repaint + interaction-time paint culling (see App.css).
 *
 * Modelled as a tiny singleton (like interactionLogger / gameBridge) rather
 * than threaded through props, because four independent usePanZoom
 * instances (N / N-1 / Action / overview) read it imperatively at gesture
 * start, and only the Settings toggle writes it. localStorage-persisted,
 * mirroring useTheme.
 */
const STORAGE_KEY = 'cs4g-smooth-pan-zoom';

const readInitial = (): boolean => {
    try {
        return localStorage.getItem(STORAGE_KEY) === '1';
    } catch {
        // localStorage unavailable (private mode, SSR-like envs) — default off.
        return false;
    }
};

let enabled = readInitial();
const listeners = new Set<() => void>();

/** Imperative read for the hot path (usePanZoom reads this at gesture start). */
export const isSmoothPanZoomEnabled = (): boolean => enabled;

export const setSmoothPanZoomEnabled = (next: boolean): void => {
    if (next === enabled) return;
    enabled = next;
    try {
        localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
    } catch {
        // ignore — same fallback as readInitial.
    }
    interactionLogger.record('smooth_pan_zoom_toggled', { enabled: next });
    listeners.forEach(l => l());
};

const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
};

/** React binding for the Settings toggle. */
export const useSmoothPanZoom = (): { enabled: boolean; setEnabled: (b: boolean) => void } => {
    const value = useSyncExternalStore(subscribe, isSmoothPanZoomEnabled, () => false);
    return { enabled: value, setEnabled: setSmoothPanZoomEnabled };
};
