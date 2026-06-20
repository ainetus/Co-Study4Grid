// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study. 

import { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef, type RefObject } from 'react';
import type { ViewBox } from '../types';
import { getSmoothPanZoomMode, type PanZoomMode } from '../utils/smoothPanZoom';
import { createNadSnapshotCanvas, collectHighlightCss } from '../utils/svg/bitmapSnapshot';

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

export const usePanZoom = (
    svgRef: RefObject<HTMLDivElement | null>,
    initialViewBox: ViewBox | null | undefined,
    active: boolean,
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
        }
    }, [svgRef]);

    // Bitmap-mode teardown: remove the canvas overlay and un-hide the live
    // SVG. Hook-level (not inside the event effect) so the diagram-load and
    // tab-switch lifecycle effects can cancel an in-flight bitmap gesture too.
    // No-op in the default / GPU paths (no canvas, SVG never hidden).
    const teardownBitmap = useCallback(() => {
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
    }, []);

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
            interactingRef.current = false; // a new diagram cancels any pending bake
            teardownBitmap(); // drop any in-flight bitmap overlay for the old diagram
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
        if (!active || !viewBoxRef.current) return;
        applyViewBox(viewBoxRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [active]);

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
        // Capture the base viewBox + element size, then kick off an ASYNC raster
        // of the live NAD to a dpr-scaled canvas. The canvas is mounted (and the
        // live SVG hidden) only once the raster finishes; until then frames fall
        // through to a viewBox write, so the gesture starts on the default path
        // and upgrades to compositor-only the moment the bitmap is ready.
        const beginBitmapInteraction = () => {
            if (interactingRef.current) return;
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
            let css = '';
            try { css = collectHighlightCss(container.ownerDocument); } catch { /* ignore */ }
            createNadSnapshotCanvas(svg, { baseVb, width: w, height: h, zoomTier, css, dpr })
                .then((canvas) => {
                    // Gesture may have settled / a new diagram may have loaded /
                    // the mode may have changed while the raster ran (token bump).
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
                    svg.style.visibility = 'hidden';
                    bitmapReadyRef.current = true;
                    // Jump straight to the current frame (no flash of base view).
                    const live = viewBoxRef.current;
                    if (live) {
                        const t = interactionTransform(baseVb, live, w, h);
                        if (t) canvas.style.transform = t;
                    }
                })
                .catch(() => { /* raster failed → stay on the viewBox fallback */ });
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
                // Bitmap mode: drop the canvas overlay + un-hide the live SVG
                // BEFORE baking the viewBox onto it (no-op for default / GPU).
                teardownBitmap();
                if (viewBoxRef.current) applyViewBox(viewBoxRef.current);
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
            }
            commitViewBox();
        };

        const handleWheel = (e: WheelEvent) => {
            if (!activeRef.current || !viewBoxRef.current) return;
            e.preventDefault();

            // Accumulate scale factor (multiplicative) and record latest cursor
            const scaleFactor = e.deltaY > 0 ? 1.1 : 0.9;
            pendingWheelScale.current *= scaleFactor;
            pendingWheelCursor.current = { x: e.clientX, y: e.clientY };

            // Mark as interacting. Snapshot the pan/zoom mode for the whole
            // gesture and, when smooth, capture the transform base / snapshot.
            modeRef.current = getSmoothPanZoomMode();
            smoothRef.current = modeRef.current !== 'off';
            setInteracting(true);
            if (modeRef.current === 'gpu') beginInteraction();
            else if (modeRef.current === 'bitmap') beginBitmapInteraction();

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
                    if (modeRef.current === 'bitmap') {
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

                    if (modeRef.current === 'bitmap') {
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
            wheelTimerId.current = setTimeout(() => {
                if (smoothRef.current) endInteraction();
                else commitViewBox();
                setInteracting(false);
            }, 150);
        };

        // rAF-throttled drag: at most one DOM update per display frame
        const handleMouseMove = (e: MouseEvent) => {
            if (!activeRef.current || !viewBoxRef.current || !isDragging.current) return;
            e.preventDefault();

            startPoint.current.pendingX = e.clientX;
            startPoint.current.pendingY = e.clientY;

            if (rafId.current) return; // frame already queued

            rafId.current = requestAnimationFrame(() => {
                rafId.current = null;
                const sp = startPoint.current;
                const dx = sp.pendingX - sp.x;
                const dy = sp.pendingY - sp.y;
                sp.x = sp.pendingX;
                sp.y = sp.pendingY;

                const svg = svgElRef.current;
                if (!svg) return;
                // In smooth mode the SVG carries a CSS transform, so use the
                // transform-independent layout width (clientWidth) for the
                // user-per-pixel scale. The default path keeps the original
                // getBoundingClientRect().width for byte-identical behaviour.
                const screenW = smoothRef.current
                    ? (svg.clientWidth || svg.getBoundingClientRect().width)
                    : svg.getBoundingClientRect().width;
                const vb = viewBoxRef.current!;
                const scale = vb.w / screenW;

                const newVb: ViewBox = {
                    ...vb,
                    x: vb.x - dx * scale,
                    y: vb.y - dy * scale,
                };
                if (modeRef.current === 'bitmap') {
                    applyBitmapFrame(newVb);
                } else if (modeRef.current === 'gpu') {
                    applyInteractionFrame(newVb);
                } else {
                    viewBoxRef.current = newVb;
                    applyViewBox(newVb);
                }
            });
        };

        // Track the window where mousemove/mouseup are currently bound for
        // an active drag, so handleMouseUp knows where to unbind. Using a
        // closure-level variable keeps the API minimal.
        let activeDragWindow: Window | null = null;

        const handleMouseUp = () => {
            isDragging.current = false;
            if (rafId.current) {
                cancelAnimationFrame(rafId.current);
                rafId.current = null;
            }
            if (activeDragWindow) {
                activeDragWindow.removeEventListener('mousemove', handleMouseMove);
                activeDragWindow.removeEventListener('mouseup', handleMouseUp);
                activeDragWindow = null;
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
            modeRef.current = getSmoothPanZoomMode();
            smoothRef.current = modeRef.current !== 'off';
            setInteracting(true);
            if (modeRef.current === 'gpu') beginInteraction();
            else if (modeRef.current === 'bitmap') beginBitmapInteraction();

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
        el.addEventListener('mousedown', handleMouseDown);

        return () => {
            el.removeEventListener('wheel', handleWheel);
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
    }, [applyViewBox]);

    return useMemo(() => ({ viewBox, setViewBox: setViewBoxPublic }), [viewBox, setViewBoxPublic]);
};
