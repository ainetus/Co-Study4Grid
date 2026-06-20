// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import { useSyncExternalStore } from 'react';
import { interactionLogger } from './interactionLogger';

/**
 * Pan/zoom rendering mode preference — an OPT-IN, off-by-default setting that
 * changes how usePanZoom renders a gesture on large grids:
 *
 *  - 'off'    (default, safe everywhere): per-frame viewBox rewrite + the
 *             interaction-time paint culling in App.css. GPU-independent.
 *  - 'gpu'    : compositor-only CSS transform on the live <svg> during the
 *             gesture, baking back to viewBox on settle. Smoother on GPU, but
 *             Chrome still re-rasters the huge vector layer each frame, so the
 *             win is modest (~1.2–1.5×) and it REGRESSES on software/VDI.
 *  - 'bitmap' : rasterise the NAD to a <canvas> ONCE at gesture start and
 *             transform that bitmap during the gesture (compositor-only, no
 *             vector re-raster), baking back to the live SVG on settle.
 *             Benchmarked at 120 fps / 0 dropped frames on the 5247-VL grid
 *             (~6× the GPU path) and composites cheaply even in software — at
 *             the cost of a one-shot raster of a multi-MB SVG at gesture start.
 *
 * Modelled as a tiny singleton (like interactionLogger / gameBridge / useTheme)
 * rather than threaded through props, because four independent usePanZoom
 * instances (N / N-1 / Action / overview) read it imperatively at gesture
 * start, and only the Settings selector writes it. localStorage-persisted.
 */
export type PanZoomMode = 'off' | 'gpu' | 'bitmap';

const STORAGE_KEY = 'cs4g-smooth-pan-zoom';

const readInitial = (): PanZoomMode => {
    try {
        const v = localStorage.getItem(STORAGE_KEY);
        if (v === 'gpu' || v === 'bitmap' || v === 'off') return v;
        if (v === '1') return 'gpu'; // migrate the legacy boolean storage
        return 'off';
    } catch {
        // localStorage unavailable (private mode, SSR-like envs) — default off.
        return 'off';
    }
};

let mode: PanZoomMode = readInitial();
const listeners = new Set<() => void>();

/** Imperative read for the hot path (usePanZoom reads this at gesture start). */
export const getSmoothPanZoomMode = (): PanZoomMode => mode;

/** Back-compat boolean read — true when either smooth mode is active. */
export const isSmoothPanZoomEnabled = (): boolean => mode !== 'off';

export const setSmoothPanZoomMode = (next: PanZoomMode): void => {
    if (next === mode) return;
    mode = next;
    try {
        localStorage.setItem(STORAGE_KEY, next);
    } catch {
        // ignore — same fallback as readInitial.
    }
    interactionLogger.record('smooth_pan_zoom_toggled', { enabled: next !== 'off', mode: next });
    listeners.forEach(l => l());
};

/** Back-compat boolean setter (true → 'gpu', false → 'off'). */
export const setSmoothPanZoomEnabled = (enabled: boolean): void => {
    setSmoothPanZoomMode(enabled ? 'gpu' : 'off');
};

const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
};

/** React binding for the Settings selector. */
export const useSmoothPanZoom = (): {
    mode: PanZoomMode;
    setMode: (m: PanZoomMode) => void;
    enabled: boolean;
    setEnabled: (b: boolean) => void;
} => {
    const value = useSyncExternalStore(subscribe, getSmoothPanZoomMode, () => 'off' as PanZoomMode);
    return { mode: value, setMode: setSmoothPanZoomMode, enabled: value !== 'off', setEnabled: setSmoothPanZoomEnabled };
};
