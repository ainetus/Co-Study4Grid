// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study. 

import { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef, type RefObject } from 'react';
import type { ViewBox } from '../types';
import { getSmoothPanZoomMode, type PanZoomMode } from '../utils/smoothPanZoom';
import {
    collectHighlightCss,
    serializeStrippedSvg,
    composeSnapshotMarkup,
    rasterizeMarkupToCanvas,
} from '../utils/svg/bitmapSnapshot';
import { createCanvasProxyController } from '../utils/svg/canvasProxy';

/**
 * Custom Hook for SVG Pan/Zoom via viewBox manipulation.
 * Performance: viewBox updates go directly to the DOM via refs,
 * bypassing React's render cycle during active interaction.
 * React state is only synced on interaction end / pause.
 *
 * Optimizations over the baseline (PR #5):
 * - Wheel zoom batched through rAF (was applying every event)
 * - getScreenCTM() cached and reused within a zoom burst
 * - Pointer-events disabled on SVG children during interaction
 *   (eliminates expensive hit-testing on thousands of elements)
 * - Pointer-events disabled on SVG children during interaction
 *   (eliminates expensive hit-testing on thousands of elements)
 */
export type ZoomTier = 'overview' | 'region' | 'detail';

const computeZoomTier = (current: ViewBox, original: ViewBox): ZoomTier => {
    const ratio = current.w / original.w;
    if (ratio > 0.5) return 'overview';
    if (ratio > 0.15) return 'region';
    return 'detail';
};

// Screen-space px width for the overload / action / contingency line halos,
// driven into the `--nad-halo-w` CSS var (see App.css). The halos are thin
// (HALO_MIN_PX — a clean trace of the branch) across the whole zoomed-in range
// and grow toward HALO_MAX_PX (a prominent marker) only once past the overview
// boundary, so a contingency stays visible on the full-extent view. Continuous
// at ratio = 0.5 — no jarring snap at a tier boundary.
const HALO_MIN_PX = 24;
const HALO_MAX_PX = 50;
const computeHaloWidthPx = (current: ViewBox, original: ViewBox): number => {
    const ratio = current.w / original.w;
    if (ratio <= 0.5) return HALO_MIN_PX;
    const t = Math.min(1, (ratio - 0.5) / 0.5);
    return Math.round(HALO_MIN_PX + (HALO_MAX_PX - HALO_MIN_PX) * t);
};

/**
 * Element-local affine for a viewBox under `preserveAspectRatio="xMidYMid
 * meet"` (what pypowsybl emits). Returns the uniform scale `a` and offset
 * `(cx, cy)` such that a user-space point `u` renders at element-local
 * pixel `(a*u.x + cx, a*u.y + cy)`. Used by the opt-in smooth-pan/zoom path.
 */
const meetLocal = (vb: ViewBox, W: number, H: number) => {
    const a = Math.min(W / vb.w, H / vb.h);
    return { a, cx: (W - a * vb.w) / 2 - a * vb.x, cy: (H - a * vb.h) / 2 - a * vb.y };
};

/**
 * CSS transform (with `transform-origin: 0 0`) for the <svg> element that
 * makes a diagram baked at viewBox `base` render pixel-identically to
 * viewBox `target`. The opt-in "Smooth pan/zoom (GPU)" mode applies this
 * during a gesture so the compositor translates/scales the already-
 * rasterised SVG layer instead of repainting ~100k DOM nodes per frame,
 * then bakes `target` into the viewBox attribute on settle. Returns null on
 * degenerate input so the caller falls back to a direct viewBox write.
 *
 * Derivation: with both states on the same element + meet rule, the
 * element-local maps are similarities `L(u) = a·u + c`. The transform
 * `T(p) = s·p + t` must satisfy `T(L_base(u)) = L_target(u)` for all u,
 * giving `s = a_t / a_b` and `t = c_t − s·c_b`.
 */
const interactionTransform = (base: ViewBox, target: ViewBox, W: number, H: number): string | null => {
    if (!(W > 0 && H > 0 && base.w > 0 && base.h > 0 && target.w > 0 && target.h > 0)) return null;
    const lb = meetLocal(base, W, H);
    const lt = meetLocal(target, W, H);
    const s = lt.a / lb.a;
    const tx = lt.cx - s * lb.cx;
    const ty = lt.cy - s * lb.cy;
    if (!Number.isFinite(s) || !Number.isFinite(tx) || !Number.isFinite(ty)) return null;
    return `translate(${tx}px, ${ty}px) scale(${s})`;
};

/**
 * Analytic inverse of the `xMidYMid meet` mapping: the user-space point under
 * a client pixel for a given viewBox. Used by the BITMAP mode's wheel zoom,
 * where the live <svg> is `visibility:hidden` at its base viewBox so
 * `getScreenCTM()` would report the base mapping, not the live (transformed)
 * one — anchoring the zoom to the wrong point. Computing it from the *current*
 * viewBox + the element box keeps the point under the cursor fixed.
 */
const cursorToUserSpace = (
    svg: SVGSVGElement, size: { w: number; h: number } | null, vb: ViewBox, clientX: number, clientY: number,
): { x: number; y: number } => {
    const rect = svg.getBoundingClientRect();
    const W = (size && size.w) || rect.width;
    const H = (size && size.h) || rect.height;
    const a = Math.min(W / vb.w, H / vb.h);
    const offX = (W - a * vb.w) / 2;
    const offY = (H - a * vb.h) / 2;
    return { x: vb.x + ((clientX - rect.left) - offX) / a, y: vb.y + ((clientY - rect.top) - offY) / a };
};

/** Wheel debounce before a gesture settles (labels / flows repaint). */
const WHEEL_SETTLE_MS = 150;
/**
 * Pause that settles a canvas-path gesture, wheel or drag. The settle bakes
 * the live SVG — one full relayout, then a re-raster that holds up every
 * commit (up to ~1 s at region zoom on the European grid) — so notch-by-notch
 * zooming and successive drags stay on the cheap canvas until the operator
 * pauses.
 */
const CANVAS_SETTLE_MS = 400;
/** Zoom per mouse-wheel notch, and the wheel delta (px) that counts as one notch. */
const WHEEL_ZOOM_STEP = 1.1;
const WHEEL_NOTCH_PX = 100;
/** Deltas at least this large come from a notched wheel (one notch minimum). */
const WHEEL_NOTCH_MIN_PX = 40;

/**
 * viewBox scale factor for one wheel event (> 1 zooms out). Honours the delta
 * MAGNITUDE: behind a busy main thread Chrome coalesces queued wheel events
 * and sums their deltas, and counting such an event as a single notch lost
 * most of a fast spin. A notched-wheel event (|Δ| ≥ 40 px — 53 to 120 px
 * depending on OS) counts as at least one notch, so per-notch zoom is
 * unchanged; small trackpad deltas zoom proportionally instead of 10 % each.
 */
export const wheelZoomFactor = (deltaY: number, deltaMode: number, pageHeight: number): number => {
    const px = deltaMode === 1 ? deltaY * 33 : deltaMode === 2 ? deltaY * pageHeight : deltaY;
    const mag = Math.abs(px);
    if (!(mag > 0)) return 1;
    const notches = Math.min(10, mag >= WHEEL_NOTCH_MIN_PX ? Math.max(1, mag / WHEEL_NOTCH_PX) : mag / WHEEL_NOTCH_PX);
    return Math.pow(WHEEL_ZOOM_STEP, Math.sign(px) * notches);
};

export interface PanZoomOptions {
    /**
     * Allow the `'canvas'` gesture proxy on this surface (default true). The
     * proxy draws the network only, so surfaces that overlay other content on
     * the diagram during a gesture (the Action-overview pins) opt out and use
     * the default path instead.
     */
    gestureProxy?: boolean;
}

export const usePanZoom = (
    svgRef: RefObject<HTMLDivElement | null>,
    initialViewBox: ViewBox | null | undefined,
    active: boolean,
    options: PanZoomOptions = {},
) => {
    // React state: "settled" viewBox for downstream consumers
    const [viewBox, setViewBox] = useState<ViewBox | null>(null);
    // Mutable ref for the hot path — updated every frame, no React render
    const viewBoxRef = useRef<ViewBox | null>(null);
    const isDragging = useRef(false);
    const startPoint = useRef({ x: 0, y: 0, pendingX: 0, pendingY: 0 });
    const wheelTimerId = useRef<ReturnType<typeof setTimeout> | null>(null);
    const rafId = useRef<number | null>(null);
    // Cached SVG element ref — avoids querySelector on every event
    const svgElRef = useRef<SVGSVGElement | null>(null);
    const activeRef = useRef(active);
    activeRef.current = active;

    // Cached getScreenCTM() — invalidated after each rAF viewBox apply
    const ctmCacheRef = useRef<DOMMatrix | null>(null);

    // Wheel zoom rAF batching: accumulate scale factor + last cursor position
    const wheelRafId = useRef<number | null>(null);
    const pendingWheelScale = useRef(1);
    const pendingWheelCursor = useRef({ x: 0, y: 0 });

    // Zoom tier: tracked in ref to avoid DOM writes when tier hasn't changed
    const currentTierRef = useRef<ZoomTier | null>(null);
    // Last `--nad-halo-w` value written, to skip redundant style writes per frame
    const currentHaloWRef = useRef<number | null>(null);
    const originalVbRef = useRef<ViewBox | null>(null);

    // Opt-in "Smooth pan/zoom (GPU)" state. `smoothRef` snapshots the
    // preference at gesture start so the whole gesture is consistent;
    // `baseVbRef` is the viewBox baked on the DOM when the gesture began
    // and `baseSizeRef` the element's untransformed CSS size — both feed
    // the per-frame CSS transform. `interactingRef` marks that a transform
    // is live and must be baked back into the viewBox on settle.
    const smoothRef = useRef(false);
    const interactingRef = useRef(false);
    const baseVbRef = useRef<ViewBox | null>(null);
    const baseSizeRef = useRef<{ w: number; h: number } | null>(null);
    // Which smooth mode this gesture uses (snapshotted at gesture start).
    const modeRef = useRef<PanZoomMode>('off');
    // Bitmap mode: the dpr-scaled <canvas> overlay transformed during the
    // gesture, and whether the (async) snapshot has been drawn + mounted yet.
    const bitmapCanvasRef = useRef<HTMLCanvasElement | null>(null);
    const bitmapReadyRef = useRef(false);
    // Generation token: bumped on every begin/teardown so a slow async raster
    // from a settled gesture can't mount a stale bitmap into a later gesture.
    const bitmapTokenRef = useRef(0);
    // Cached serialisation of the FO-stripped live SVG (the ~250ms expensive,
    // viewBox-INDEPENDENT part of a bitmap snapshot). Pre-warmed on idle and
    // invalidated when the SVG DOM changes, so a gesture's snapshot becomes a
    // cheap header re-compose + an off-thread decode instead of the 250ms
    // main-thread serialize that froze the pan start.
    const snapshotSerializedRef = useRef<string | null>(null);
    // Canvas gesture proxy (`'canvas'` mode, utils/svg/canvasProxy.ts): a light
    // stand-in of the network drawn on a canvas during the gesture, so the live
    // SVG is only rewritten once, on settle.
    const proxyAllowedRef = useRef(options.gestureProxy !== false);
    proxyAllowedRef.current = options.gestureProxy !== false;
    const [canvasProxy] = useState(() => createCanvasProxyController({
        getLiveSvg: () => svgElRef.current,
        getContainer: () => svgRef.current,
        getExtent: () => originalVbRef.current,
        haloWidth: (vb) => (originalVbRef.current ? computeHaloWidthPx(vb, originalVbRef.current) : null),
    }));
    const canvasModeActive = () => proxyAllowedRef.current && getSmoothPanZoomMode() === 'canvas';


    // Toggle interaction class on container to disable pointer-events on SVG children
    const setInteracting = (interacting: boolean) => {
        const container = svgRef.current;
        if (container) {
            container.classList.toggle('svg-interacting', interacting);
        }
    };

    // Direct DOM update — no React involved
    const applyViewBox = useCallback((vb: ViewBox | null) => {
        const svg = svgElRef.current;
        // Safety net: a NaN/Infinity in any field would yield e.g.
        // `viewBox="NaN -2245943 NaN NaN"`, which SVG rejects and
        // renders as a blank diagram. The upstream callers should
        // never produce non-finite values, but a missing/malformed
        // coordinate in grid_layout.json can leak through the
        // pypowsybl metadata; refuse rather than corrupt the DOM.
        // `svg == null` is benign (tab sync writes a valid viewBox
        // before the target tab's SVG is mounted) — don't warn on it,
        // only warn on the real bug (a non-finite field).
        const vbIsFinite = !!vb &&
            Number.isFinite(vb.x) && Number.isFinite(vb.y) &&
            Number.isFinite(vb.w) && Number.isFinite(vb.h);
        if (svg && vbIsFinite) {
            svg.setAttribute('viewBox', `${vb!.x} ${vb!.y} ${vb!.w} ${vb!.h}`);
            // A concrete viewBox is the settled source of truth — drop any
            // leftover smooth-mode interaction transform so the bake is
            // exact and programmatic writes (zoom buttons, tab sync, load,
            // tied tabs) reset it. Inert in the default path (transform is
            // never set), so it costs nothing there. `style?.` guards the
            // jsdom case where DOMParser'd SVG nodes lack a style object.
            if (svg.style?.transform) {
                svg.style.transform = '';
                svg.style.willChange = '';
            }
        } else if (vb && !vbIsFinite) {
            // Trace the upstream caller so we can pinpoint which path
            // (handleZoomToElement, useTabSync, useTiedTabsSync, an
            // overflow-iframe postMessage handler, …) leaked a NaN /
            // Infinity field. Stack-trace via Error() — works in every
            // browser that supports SVG.
            console.warn('[usePanZoom] rejected non-finite viewBox', vb, new Error().stack);
        }
        // Invalidate CTM cache after viewBox change
        ctmCacheRef.current = null;

        // Update zoom tier attribute (only writes DOM when tier changes)
        const container = svgRef.current;
        const orig = originalVbRef.current;
        if (container && vb && orig) {
            const tier = computeZoomTier(vb, orig);
            if (tier !== currentTierRef.current) {
                currentTierRef.current = tier;
                container.setAttribute('data-zoom-tier', tier);
            }
            // Zoom-adaptive halo width: thin when zoomed in, growing toward a
            // prominent marker when zoomed out (smooth, no tier snap). Cheap —
            // only writes the var when the rounded px value actually changes.
            const haloW = computeHaloWidthPx(vb, orig);
            if (haloW !== currentHaloWRef.current && container.style) {
                currentHaloWRef.current = haloW;
                container.style.setProperty('--nad-halo-w', `${haloW}px`);
            }
        }
    }, [svgRef]);

    // Bitmap-mode teardown: remove the canvas overlay and un-hide the live
    // SVG. Hook-level (not inside the event effect) so the diagram-load and
    // tab-switch lifecycle effects can cancel an in-flight bitmap gesture too.
    // No-op in the default / GPU paths (no canvas, SVG never hidden).
    const teardownBitmap = useCallback(() => {
        canvasProxy.hide();
        bitmapTokenRef.current++; // invalidate any in-flight async raster
        const canvas = bitmapCanvasRef.current;
        if (canvas) {
            canvas.style.transform = '';
            canvas.style.willChange = '';
            canvas.remove();
            bitmapCanvasRef.current = null;
        }
        bitmapReadyRef.current = false;
        const svg = svgElRef.current;
        if (svg?.style && svg.style.visibility === 'hidden') svg.style.visibility = '';
    }, [canvasProxy]);

    // Pre-warm the serialisation cache (bitmap mode only) so the NEXT gesture's
    // snapshot skips the heavy serialize. Runs on idle — off any gesture.
    const prewarmSnapshot = useCallback(() => {
        const svg = svgElRef.current;
        // Never serialise mid-gesture (it would freeze a frame); a later settle /
        // observer schedule warms it. Skip if already warm or not in bitmap mode.
        if (!svg || interactingRef.current || snapshotSerializedRef.current != null
            || getSmoothPanZoomMode() !== 'bitmap') return;
        try { snapshotSerializedRef.current = serializeStrippedSvg(svg); } catch { /* ignore */ }
    }, []);

    const scheduleSnapshotPrewarm = useCallback(() => {
        if (getSmoothPanZoomMode() !== 'bitmap') return;
        if (typeof requestIdleCallback === 'function') {
            requestIdleCallback(() => prewarmSnapshot(), { timeout: 1500 });
        } else {
            setTimeout(() => prewarmSnapshot(), 200);
        }
    }, [prewarmSnapshot]);

    const invalidateSnapshotCache = useCallback(() => {
        snapshotSerializedRef.current = null;
        scheduleSnapshotPrewarm();
    }, [scheduleSnapshotPrewarm]);

    // Flush ref -> React state for downstream consumers. Skip the state
    // update (and the React re-render it triggers) when the settled viewBox
    // is byte-identical to the last committed one — e.g. a drag that returns
    // to its origin or a wheel burst that nets back to the same frame. The DOM
    // is settled independently by applyViewBox, so the guard is purely a
    // redundant-render saver. Mirrors the equality guard in setViewBoxPublic.
    const commitViewBox = () => {
        const vb = viewBoxRef.current;
        if (!vb) return;
        setViewBox(prev => {
            if (prev &&
                prev.x === vb.x && prev.y === vb.y &&
                prev.w === vb.w && prev.h === vb.h) {
                return prev;
            }
            return { ...vb };
        });
    };

    // Cache SVG element when container content changes.
    // Also hide text immediately on large grids to prevent a flash
    // of unreadable text before the first applyViewBox call.
    // Runs only when a new diagram loads (initialViewBox changes),
    // NOT on every render — otherwise it blocks paint on tab switch.
    useLayoutEffect(() => {
        if (svgRef.current) {
            svgElRef.current = svgRef.current.querySelector('svg');
        } else {
            svgElRef.current = null;
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [initialViewBox]);

    // Sync from initialViewBox (diagram load or programmatic reset)
    useEffect(() => {
        if (initialViewBox) {
            // Store the full-extent viewBox for zoom tier calculation.
            // Only update on diagram load (when initialViewBox object identity changes),
            // not on programmatic zoom which uses setViewBoxPublic instead.
            originalVbRef.current = initialViewBox;
            currentTierRef.current = null; // force re-evaluation
            currentHaloWRef.current = null; // re-apply --nad-halo-w for the new diagram
            interactingRef.current = false; // a new diagram cancels any pending bake
            teardownBitmap(); // drop any in-flight bitmap overlay for the old diagram
            canvasProxy.dispose(); // its geometry belongs to the old diagram
            invalidateSnapshotCache(); // the SVG content changed — re-warm later
            viewBoxRef.current = initialViewBox;
            applyViewBox(initialViewBox);
            setViewBox(initialViewBox);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [initialViewBox]);

    // Sync DOM viewBox BEFORE paint when tab becomes active — prevents
    // one frame of stale viewBox on tab switch.
    useLayoutEffect(() => {
        // A tab switch ends any in-flight smooth-mode gesture; applyViewBox
        // re-bakes the settled viewBox and clears the transform.
        interactingRef.current = false;
        teardownBitmap();
        invalidateSnapshotCache();
        // Only the visible tab holds a canvas proxy (canvas + overview cache).
        if (!active) canvasProxy.dispose();
        if (!active || !viewBoxRef.current) return;
        applyViewBox(viewBoxRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [active]);

    // Invalidate the bitmap serialisation cache when the live SVG's CONTENT
    // changes (highlight halos / flow-delta classes + the clones they add),
    // so a snapshot never bakes stale visuals. viewBox attribute writes are NOT
    // observed (attributeFilter excludes them), so per-frame pans don't churn
    // the cache. Cheap when idle; only fires on real highlight mutations.
    useEffect(() => {
        const svg = svgElRef.current;
        if (!svg || typeof MutationObserver === 'undefined') return;
        scheduleSnapshotPrewarm();
        if (active && canvasModeActive()) canvasProxy.prewarm();
        // Inline `style` too: the voltage filter hides elements that way. The
        // root's own attributes are written by the gesture modes, not content.
        const obs = new MutationObserver((records) => {
            if (!records.some(r => r.type === 'childList' || r.target !== svg)) return;
            invalidateSnapshotCache();
            if (active && canvasModeActive()) canvasProxy.invalidate();
        });
        obs.observe(svg, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] });
        // The proxy bakes theme colours (diagram surface, highlight tokens).
        const themeObs = new MutationObserver(() => {
            if (active && canvasModeActive()) canvasProxy.invalidate();
        });
        themeObs.observe(svg.ownerDocument.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
        // Its overview cache is baked for the panel size (sidebar toggle,
        // detached window resize): re-bake on idle.
        const container = svgRef.current;
        const RO = svg.ownerDocument.defaultView?.ResizeObserver;
        const resizeObs = container && RO ? new RO(() => {
            if (active && canvasModeActive()) canvasProxy.prewarm();
        }) : null;
        if (container) resizeObs?.observe(container);
        return () => { obs.disconnect(); themeObs.disconnect(); resizeObs?.disconnect(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [active, initialViewBox]);

    // Stable event registration — re-registers when active tab changes
    // OR when the diagram loads (initialViewBox changes).
    useEffect(() => {
        const el = svgRef.current;
        if (!el || !active) return;

        // Get (or cache) the screen CTM
        const getCTM = (): DOMMatrix | null => {
            if (ctmCacheRef.current) return ctmCacheRef.current;
            const svg = svgElRef.current;
            if (!svg) return null;
            const ctm = svg.getScreenCTM();
            if (ctm) ctmCacheRef.current = ctm;
            return ctm;
        };

        // --- Opt-in smooth-pan/zoom (GPU compositing) helpers ---
        // Snapshot the baked viewBox + element size so each gesture frame
        // can be expressed as a CSS transform relative to it.
        const beginInteraction = () => {
            if (interactingRef.current) return;
            const svg = svgElRef.current;
            if (!svg || !viewBoxRef.current) return;
            const rect = svg.getBoundingClientRect();
            baseVbRef.current = { ...viewBoxRef.current };
            baseSizeRef.current = { w: svg.clientWidth || rect.width, h: svg.clientHeight || rect.height };
            if (svg.style) {
                svg.style.transformOrigin = '0 0';
                svg.style.willChange = 'transform';
            }
            interactingRef.current = true;
        };

        // Render `vb` via a compositor-only CSS transform — no viewBox
        // rewrite, so no full vector repaint. Keeps viewBoxRef in lockstep
        // so the wheel/drag math and the final bake stay exact, and
        // invalidates the CTM cache so the next getScreenCTM reflects
        // base+transform = the live mapping. Falls back to a viewBox write
        // if anything is missing or the transform is degenerate.
        const applyInteractionFrame = (vb: ViewBox) => {
            const svg = svgElRef.current;
            const base = baseVbRef.current;
            const size = baseSizeRef.current;
            const t = (svg && base && size) ? interactionTransform(base, vb, size.w, size.h) : null;
            if (!svg || !t) {
                viewBoxRef.current = vb;
                applyViewBox(vb);
                return;
            }
            viewBoxRef.current = vb;
            svg.style.transform = t;
            ctmCacheRef.current = null;
        };

        // --- Opt-in BITMAP mode helpers (rasterise once, transform the bitmap) ---
        // Capture the base viewBox + element size, then build the bitmap OFF the
        // gesture handler. The gesture pans via the viewBox fallback from frame 1
        // (responsive); the bitmap only mounts when ready. If the serialisation
        // cache is COLD (the ~250ms expensive part), this gesture stays on the
        // fallback and we warm the cache on idle — so the START is NEVER frozen;
        // the bitmap engages from the next gesture once warm.
        const beginBitmapInteraction = () => {
            if (interactingRef.current) return;
            // Clean a canvas left mounted by a previous gesture whose deferred
            // reveal hasn't fired yet (token bump cancels that pending reveal).
            teardownBitmap();
            const svg = svgElRef.current;
            const container = svgRef.current;
            if (!svg || !container || !viewBoxRef.current) return;
            const rect = svg.getBoundingClientRect();
            const w = svg.clientWidth || rect.width;
            const h = svg.clientHeight || rect.height;
            baseVbRef.current = { ...viewBoxRef.current };
            baseSizeRef.current = { w, h };
            interactingRef.current = true;
            bitmapReadyRef.current = false;
            const token = ++bitmapTokenRef.current;
            const baseVb = baseVbRef.current;
            const view = container.ownerDocument.defaultView ?? window;
            const dpr = view.devicePixelRatio || 1;
            const zoomTier = container.getAttribute('data-zoom-tier');

            const build = () => {
                if (token !== bitmapTokenRef.current || !interactingRef.current || modeRef.current !== 'bitmap') return;
                const live = svgElRef.current;
                if (!live) return;
                const serialized = snapshotSerializedRef.current;
                if (serialized == null) {
                    // Cold cache: don't freeze this gesture serialising 9MB on the
                    // main thread — stay on the viewBox fallback and warm for next.
                    scheduleSnapshotPrewarm();
                    return;
                }
                let css = '';
                try { css = collectHighlightCss(container.ownerDocument); } catch { /* ignore */ }
                const markup = composeSnapshotMarkup(serialized, {
                    baseVb, width: w, height: h, zoomTier, css,
                    haloWidthPx: currentHaloWRef.current,
                });
                rasterizeMarkupToCanvas(markup, w, h, dpr)
                    .then((canvas) => {
                        // Gesture may have settled / a new diagram may have loaded /
                        // the mode may have changed while the (off-thread) decode ran.
                        if (token !== bitmapTokenRef.current || !interactingRef.current
                            || modeRef.current !== 'bitmap' || bitmapCanvasRef.current) return;
                        canvas.style.position = 'absolute';
                        canvas.style.left = '0';
                        canvas.style.top = '0';
                        canvas.style.width = `${w}px`;
                        canvas.style.height = `${h}px`;
                        canvas.style.transformOrigin = '0 0';
                        canvas.style.willChange = 'transform';
                        canvas.style.pointerEvents = 'none';
                        container.appendChild(canvas);
                        bitmapCanvasRef.current = canvas;
                        live.style.visibility = 'hidden';
                        bitmapReadyRef.current = true;
                        // Jump straight to the current frame (no flash of base view).
                        const cur = viewBoxRef.current;
                        if (cur) {
                            const t = interactionTransform(baseVb, cur, w, h);
                            if (t) canvas.style.transform = t;
                        }
                    })
                    .catch(() => { /* raster failed → stay on the viewBox fallback */ });
            };
            // Defer off the mousedown/wheel handler so the first frame paints.
            setTimeout(build, 0);
        };

        // --- Canvas gesture proxy (`'canvas'` mode) ---
        // Show the stand-in over the live SVG; the live viewBox stays at
        // `baseVb` until the settle bake. False when no proxy can be drawn,
        // and the gesture then falls back to the default path.
        const beginCanvasInteraction = (): boolean => {
            if (interactingRef.current) return true;
            const svg = svgElRef.current;
            const vb = viewBoxRef.current;
            if (!svg || !vb || !canvasProxy.begin()) return false;
            const rect = svg.getBoundingClientRect();
            baseVbRef.current = { ...vb };
            baseSizeRef.current = { w: svg.clientWidth || rect.width, h: svg.clientHeight || rect.height };
            interactingRef.current = true;
            return true;
        };
        const applyCanvasFrame = (vb: ViewBox) => {
            viewBoxRef.current = vb;
            if (interactingRef.current) canvasProxy.frame(vb);
            else applyViewBox(vb);
        };

        // Resolve the mode for a gesture that is starting: the canvas proxy
        // must be allowed on this surface and drawable, else use the default.
        const startGesture = () => {
            if (interactingRef.current) return;
            let mode = getSmoothPanZoomMode();
            if (mode === 'canvas' && !(proxyAllowedRef.current && beginCanvasInteraction())) mode = 'off';
            modeRef.current = mode;
            smoothRef.current = mode !== 'off';
            if (mode !== 'canvas') setInteracting(true);
            if (mode === 'gpu') beginInteraction();
            else if (mode === 'bitmap') beginBitmapInteraction();
        };

        // Per-frame: keep viewBoxRef in lockstep (the wheel/drag math + the
        // settle bake all read it), then transform the canvas if it's mounted,
        // else fall back to a viewBox write (pre-raster frames).
        const applyBitmapFrame = (vb: ViewBox) => {
            viewBoxRef.current = vb;
            const canvas = bitmapCanvasRef.current;
            const base = baseVbRef.current;
            const size = baseSizeRef.current;
            if (bitmapReadyRef.current && canvas && base && size) {
                const t = interactionTransform(base, vb, size.w, size.h);
                if (t) { canvas.style.transform = t; ctmCacheRef.current = null; return; }
            }
            applyViewBox(vb);
        };

        // Bake the live viewBox back onto the SVG (single repaint at the
        // settled position; applyViewBox clears the transform) and sync
        // React state. Safe to call in the default path — it just commits.
        const endInteraction = () => {
            if (interactingRef.current) {
                interactingRef.current = false;
                if (modeRef.current === 'canvas') {
                    // One bake of the live SVG, behind the still-visible proxy,
                    // which is dropped once that repaint has landed. Skipped
                    // when the view did not move: it is a full relayout.
                    const vb = viewBoxRef.current;
                    const base = baseVbRef.current;
                    if (vb && !(base && vb.x === base.x && vb.y === base.y && vb.w === base.w && vb.h === base.h)) {
                        applyViewBox(vb);
                    }
                    canvasProxy.settle();
                } else if (bitmapCanvasRef.current) {
                    // BITMAP settle. Bake the target viewBox onto the STILL-HIDDEN
                    // live SVG first (it repaints behind the bitmap), then keep the
                    // bitmap on top for ~2 frames before revealing the SVG + dropping
                    // the canvas. Revealing immediately would expose the SVG layer's
                    // STALE base-zoom paint for the ~50ms vector repaint — the
                    // "ghost halo" the operator sees on a fast zoom. The token guard
                    // cancels this deferred reveal if a new gesture starts first
                    // (beginBitmapInteraction tears the canvas down up-front).
                    if (viewBoxRef.current) applyViewBox(viewBoxRef.current);
                    const token = ++bitmapTokenRef.current;
                    const reveal = () => {
                        if (token !== bitmapTokenRef.current) return; // superseded
                        const sv = svgElRef.current;
                        if (sv?.style) sv.style.visibility = '';
                        const c = bitmapCanvasRef.current;
                        if (c) { c.style.transform = ''; c.style.willChange = ''; c.remove(); }
                        bitmapCanvasRef.current = null;
                        bitmapReadyRef.current = false;
                    };
                    requestAnimationFrame(() => requestAnimationFrame(reveal));
                } else if (viewBoxRef.current) {
                    // default / GPU: single bake at the settled position.
                    applyViewBox(viewBoxRef.current);
                }
                // The gesture is over — drop the `will-change: transform`
                // compositor-layer hint now so we don't hold a promoted
                // multi-MB layer through the wheel-commit debounce gap or
                // between gestures. applyViewBox already clears it when a
                // transform was live on settle, but clear unconditionally to
                // also cover the frame(s) where applyInteractionFrame fell back
                // to a direct viewBox write (no transform set). This does NOT
                // shorten the 150ms cull/debounce window — only the hint.
                const svg = svgElRef.current;
                if (svg?.style) svg.style.willChange = '';
                // Re-warm the serialisation cache off the gesture (idle) so the
                // next bitmap gesture is fast. No-op if already warm / not bitmap.
                scheduleSnapshotPrewarm();
            }
            commitViewBox();
        };

        // Debounced end of a wheel gesture, or of a canvas-path drag. A press
        // in progress owns the gesture: its mouseup settles it.
        const settleGesture = () => {
            wheelTimerId.current = null;
            if (isDragging.current) return;
            if (smoothRef.current) endInteraction();
            else commitViewBox();
            setInteracting(false);
        };

        const handleWheel = (e: WheelEvent) => {
            if (!activeRef.current || !viewBoxRef.current) return;
            e.preventDefault();

            // Accumulate scale factor (multiplicative) and record latest cursor
            const view = el.ownerDocument.defaultView ?? window;
            pendingWheelScale.current *= wheelZoomFactor(e.deltaY, e.deltaMode, view.innerHeight);
            pendingWheelCursor.current = { x: e.clientX, y: e.clientY };

            // Mark as interacting. Snapshot the pan/zoom mode for the whole
            // gesture and, when smooth, capture the transform base / snapshot.
            startGesture();

            // Schedule rAF if not already queued
            if (!wheelRafId.current) {
                // Snapshot the CTM before the rAF (while it's still valid)
                const ctm = getCTM();

                wheelRafId.current = requestAnimationFrame(() => {
                    wheelRafId.current = null;

                    const vb = viewBoxRef.current;
                    const svg = svgElRef.current;
                    if (!vb || !svg) return;

                    const accumulatedScale = pendingWheelScale.current;
                    pendingWheelScale.current = 1; // reset accumulator

                    const cursor = pendingWheelCursor.current;
                    let svgP: { x: number; y: number };
                    if (modeRef.current === 'bitmap' || modeRef.current === 'canvas') {
                        // Live SVG is hidden at its base viewBox, so getScreenCTM
                        // is stale — derive the cursor's user point analytically.
                        svgP = cursorToUserSpace(svg, baseSizeRef.current, vb, cursor.x, cursor.y);
                    } else {
                        if (!ctm) return;
                        const pt = svg.createSVGPoint();
                        pt.x = cursor.x;
                        pt.y = cursor.y;
                        svgP = pt.matrixTransform(ctm.inverse());
                    }

                    const newVb: ViewBox = {
                        x: vb.x + (svgP.x - vb.x) * (1 - accumulatedScale),
                        y: vb.y + (svgP.y - vb.y) * (1 - accumulatedScale),
                        w: vb.w * accumulatedScale,
                        h: vb.h * accumulatedScale,
                    };

                    if (modeRef.current === 'canvas') {
                        applyCanvasFrame(newVb);
                    } else if (modeRef.current === 'bitmap') {
                        applyBitmapFrame(newVb);
                    } else if (modeRef.current === 'gpu') {
                        applyInteractionFrame(newVb);
                    } else {
                        viewBoxRef.current = newVb;
                        applyViewBox(newVb);
                    }
                });
            }

            // Debounced commit: sync to React after scrolling stops
            if (wheelTimerId.current) clearTimeout(wheelTimerId.current);
            wheelTimerId.current = setTimeout(settleGesture, modeRef.current === 'canvas' ? CANVAS_SETTLE_MS : WHEEL_SETTLE_MS);
        };

        // Canvas path: the press waits for the pointer to travel before the
        // gesture starts, so a plain click (VL select, SLD) draws nothing.
        let deferredStart = false;
        let dragPointerId: number | null = null;
        const handlePointerDown = (e: PointerEvent) => { dragPointerId = e.pointerId; };

        // rAF-throttled drag: at most one DOM update per display frame
        const handleMouseMove = (e: MouseEvent) => {
            if (!activeRef.current || !viewBoxRef.current || !isDragging.current) return;
            e.preventDefault();
            if (deferredStart) {
                if (e.clientX === startPoint.current.x && e.clientY === startPoint.current.y) return;
                deferredStart = false;
                startGesture();
                // The proxy is click-through: capture the pointer, or every
                // move hit-tests the live SVG underneath (20–40 ms each at
                // region zoom on the European grid).
                if (modeRef.current === 'canvas' && dragPointerId !== null && typeof el.setPointerCapture === 'function') {
                    try { el.setPointerCapture(dragPointerId); } catch { /* pointer already released */ }
                }
            }

            startPoint.current.pendingX = e.clientX;
            startPoint.current.pendingY = e.clientY;

            if (rafId.current) return; // frame already queued

            rafId.current = requestAnimationFrame(() => {
                rafId.current = null;
                applyDragDelta();
            });
        };

        // Apply the cursor travel since the last applied frame.
        const applyDragDelta = () => {
            const sp = startPoint.current;
            const dx = sp.pendingX - sp.x;
            const dy = sp.pendingY - sp.y;
            sp.x = sp.pendingX;
            sp.y = sp.pendingY;

            const svg = svgElRef.current;
            const vb = viewBoxRef.current;
            if (!svg || !vb || (dx === 0 && dy === 0)) return;
            // In smooth mode the SVG carries a CSS transform, so use the
            // transform-independent layout size (clientWidth/Height).
            const rect = svg.getBoundingClientRect();
            const screenW = smoothRef.current ? (svg.clientWidth || rect.width) : rect.width;
            const screenH = smoothRef.current ? (svg.clientHeight || rect.height) : rect.height;
            if (!(screenW > 0)) return; // not laid out: no px → user-unit mapping
            // pypowsybl's preserveAspectRatio="xMidYMid meet" letterboxes one
            // axis: one screen px is max(w/W, h/H) user units. vb.w / W alone
            // made the map slide slower than the cursor whenever the panel is
            // wider than the diagram.
            const scale = screenH > 0 ? Math.max(vb.w / screenW, vb.h / screenH) : vb.w / screenW;

            const newVb: ViewBox = {
                ...vb,
                x: vb.x - dx * scale,
                y: vb.y - dy * scale,
            };
            if (modeRef.current === 'canvas') {
                applyCanvasFrame(newVb);
            } else if (modeRef.current === 'bitmap') {
                applyBitmapFrame(newVb);
            } else if (modeRef.current === 'gpu') {
                applyInteractionFrame(newVb);
            } else {
                viewBoxRef.current = newVb;
                applyViewBox(newVb);
            }
        };

        // Track the window where mousemove/mouseup are currently bound for
        // an active drag, so handleMouseUp knows where to unbind. Using a
        // closure-level variable keeps the API minimal.
        let activeDragWindow: Window | null = null;

        const handleMouseUp = () => {
            isDragging.current = false;
            deferredStart = false;
            dragPointerId = null;
            if (rafId.current) {
                cancelAnimationFrame(rafId.current);
                rafId.current = null;
                // The last coalesced mousemove often arrives in the same task
                // as the mouseup when frames are slow: apply its travel rather
                // than dropping the end of the drag.
                applyDragDelta();
            }
            if (activeDragWindow) {
                activeDragWindow.removeEventListener('mousemove', handleMouseMove);
                activeDragWindow.removeEventListener('mouseup', handleMouseUp);
                activeDragWindow = null;
            }
            if (interactingRef.current && modeRef.current === 'canvas') {
                // Settle when the operator pauses, as for the wheel: a drag
                // that follows continues on the proxy, with no bake between.
                if (wheelTimerId.current) clearTimeout(wheelTimerId.current);
                wheelTimerId.current = setTimeout(settleGesture, CANVAS_SETTLE_MS);
                return;
            }
            // Bake the smooth-mode transform back to viewBox (and commit);
            // the default path just commits to React state on drag end.
            if (smoothRef.current) endInteraction();
            else commitViewBox();
            setInteracting(false);
        };

        const handleMouseDown = (e: MouseEvent) => {
            if (!activeRef.current || !viewBoxRef.current) return;
            isDragging.current = true;
            startPoint.current = { x: e.clientX, y: e.clientY, pendingX: e.clientX, pendingY: e.clientY };
            // A pending settle (wheel debounce, canvas drag pause) now belongs
            // to this press.
            if (wheelTimerId.current) {
                clearTimeout(wheelTimerId.current);
                wheelTimerId.current = null;
            }
            deferredStart = proxyAllowedRef.current && getSmoothPanZoomMode() === 'canvas';
            if (!deferredStart) startGesture();

            // Resolve the element's CURRENT owner window per-drag rather
            // than capturing it at effect-bind time. This is critical for
            // detachable tabs: when the tab's DOM is relocated to a popup
            // window via imperative move, `el.ownerDocument.defaultView`
            // points at the popup, so drag-pan keeps working there —
            // whereas a captured `window` reference would still listen
            // to the main window and ignore events in the popup.
            const dragWindow = el.ownerDocument.defaultView ?? window;
            activeDragWindow = dragWindow;
            dragWindow.addEventListener('mousemove', handleMouseMove);
            dragWindow.addEventListener('mouseup', handleMouseUp);
        };

        el.addEventListener('wheel', handleWheel, { passive: false });
        el.addEventListener('pointerdown', handlePointerDown);
        el.addEventListener('mousedown', handleMouseDown);

        return () => {
            el.removeEventListener('wheel', handleWheel);
            el.removeEventListener('pointerdown', handlePointerDown);
            el.removeEventListener('mousedown', handleMouseDown);
            // Clean up any in-flight drag listeners.
            if (activeDragWindow) {
                activeDragWindow.removeEventListener('mousemove', handleMouseMove);
                activeDragWindow.removeEventListener('mouseup', handleMouseUp);
                activeDragWindow = null;
            }
            if (wheelTimerId.current) clearTimeout(wheelTimerId.current);
            if (rafId.current) cancelAnimationFrame(rafId.current);
            if (wheelRafId.current) cancelAnimationFrame(wheelRafId.current);
            // Drop any in-flight smooth-mode transform so a re-bind / tab
            // teardown never leaves a stale transform on the SVG.
            interactingRef.current = false;
            teardownBitmap();
            const svgEl = svgElRef.current;
            if (svgEl && svgEl.style?.transform) {
                svgEl.style.transform = '';
                svgEl.style.willChange = '';
            }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [active, initialViewBox]);

    // Public API: updates ref + DOM + React state immediately
    const setViewBoxPublic = useCallback((vb: ViewBox) => {
        // Reject non-finite viewBoxes at the public boundary too —
        // otherwise viewBoxRef.current gets polluted with NaN and the
        // tab-active layout effect re-emits the bad value at the next
        // tab switch (which would slip past applyViewBox's DOM guard
        // but pollute downstream React state). applyViewBox itself
        // will log the stack trace.
        if (
            !vb ||
            !Number.isFinite(vb.x) || !Number.isFinite(vb.y) ||
            !Number.isFinite(vb.w) || !Number.isFinite(vb.h)
        ) {
            applyViewBox(vb);
            return;
        }
        if (interactingRef.current && modeRef.current === 'canvas') {
            // A programmatic jump (zoom buttons, Inspect, tied tabs) ends the gesture.
            interactingRef.current = false;
            canvasProxy.hide();
        }
        viewBoxRef.current = vb;
        applyViewBox(vb);
        setViewBox(prev => {
            if (prev && vb &&
                prev.x === vb.x && prev.y === vb.y &&
                prev.w === vb.w && prev.h === vb.h) {
                return prev;
            }
            return vb;
        });
    }, [applyViewBox, canvasProxy]);

    return useMemo(() => ({ viewBox, setViewBox: setViewBoxPublic }), [viewBox, setViewBoxPublic]);
};
