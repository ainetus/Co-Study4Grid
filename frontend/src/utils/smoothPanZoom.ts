// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import { useSyncExternalStore } from 'react';
import { interactionLogger } from './interactionLogger';

/**
 * Pan/zoom rendering mode preference — how usePanZoom renders a gesture:
 *
 *  - 'canvas' (default): draw a light stand-in of the network (grouped Path2D
 *             per style and grid cell, utils/svg/canvasProxy.ts) on a canvas
 *             over the live SVG during the gesture and rewrite the live
 *             viewBox once, when the operator pauses. 30–60 fps on the full
 *             European grid, with or without a GPU, every gesture complete
 *             (docs/performance/canvas-gesture-proxy.md). Falls back to 'off'
 *             where no proxy can be drawn (no Path2D / 2D canvas) and on
 *             surfaces that opt out (the Action overview).
 *  - 'off'    ("Classic", safe everywhere): per-frame viewBox rewrite + the
 *             interaction-time paint culling in App.css. GPU-independent, but
 *             every frame restyles and re-lays out the whole SVG (2–5 fps on
 *             the European grid).
 *  - 'gpu'    : compositor-only CSS transform on the live <svg> during the
 *             gesture, baking back to viewBox on settle. Smoother on GPU, but
 *             Chrome still re-rasters the huge vector layer each frame, so the
 *             win is modest (~1.2–1.5×) and it REGRESSES on software/VDI.
 *  - 'bitmap' : rasterise the NAD to a <canvas> ONCE at gesture start and
 *             transform that bitmap during the gesture (compositor-only, no
 *             vector re-raster), baking back to the live SVG on settle.
 *             Fast on an M4 Pro, but Chrome cannot createImageBitmap() an SVG
 *             blob, so the snapshot decodes on the main thread (0.4–3 s per
 *             gesture on an Intel laptop) and the gesture runs on the slow
 *             path meanwhile.
 *
 * An explicit choice is kept (stored 'off' stays classic); only operators who
 * never picked a mode get the default.
 *
 * Modelled as a tiny singleton (like interactionLogger / gameBridge / useTheme)
 * rather than threaded through props, because four independent usePanZoom
 * instances (N / N-1 / Action / overview) read it imperatively at gesture
 * start, and only the Settings selector writes it. localStorage-persisted.
 */
export type PanZoomMode = 'off' | 'gpu' | 'bitmap' | 'canvas';

const STORAGE_KEY = 'cs4g-smooth-pan-zoom';

/** Mode until the operator picks one in Settings. */
export const DEFAULT_PAN_ZOOM_MODE: PanZoomMode = 'canvas';

const readInitial = (): PanZoomMode => {
    try {
        const v = localStorage.getItem(STORAGE_KEY);
        if (v === 'gpu' || v === 'bitmap' || v === 'canvas' || v === 'off') return v;
        if (v === '1') return 'gpu'; // migrate the legacy boolean storage
        return DEFAULT_PAN_ZOOM_MODE;
    } catch {
        // localStorage unavailable (private mode, SSR-like envs).
        return DEFAULT_PAN_ZOOM_MODE;
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
    const value = useSyncExternalStore(subscribe, getSmoothPanZoomMode, () => DEFAULT_PAN_ZOOM_MODE);
    return { mode: value, setMode: setSmoothPanZoomMode, enabled: value !== 'off', setEnabled: setSmoothPanZoomEnabled };
};
