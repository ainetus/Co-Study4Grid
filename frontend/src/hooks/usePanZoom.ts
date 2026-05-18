// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study. 

import { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef, type RefObject } from 'react';
import type { ViewBox } from '../types';

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

    // Flush ref -> React state for downstream consumers
    const commitViewBox = () => {
        if (viewBoxRef.current) {
            setViewBox({ ...viewBoxRef.current });
        }
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
            viewBoxRef.current = initialViewBox;
            applyViewBox(initialViewBox);
            setViewBox(initialViewBox);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [initialViewBox]);

    // Sync DOM viewBox BEFORE paint when tab becomes active — prevents
    // one frame of stale viewBox on tab switch.
    useLayoutEffect(() => {
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

        const handleWheel = (e: WheelEvent) => {
            if (!activeRef.current || !viewBoxRef.current) return;
            e.preventDefault();

            // Accumulate scale factor (multiplicative) and record latest cursor
            const scaleFactor = e.deltaY > 0 ? 1.1 : 0.9;
            pendingWheelScale.current *= scaleFactor;
            pendingWheelCursor.current = { x: e.clientX, y: e.clientY };

            // Mark as interacting
            setInteracting(true);

            // Schedule rAF if not already queued
            if (!wheelRafId.current) {
                // Snapshot the CTM before the rAF (while it's still valid)
                const ctm = getCTM();

                wheelRafId.current = requestAnimationFrame(() => {
                    wheelRafId.current = null;

                    const vb = viewBoxRef.current;
                    const svg = svgElRef.current;
                    if (!vb || !svg || !ctm) return;

                    const accumulatedScale = pendingWheelScale.current;
                    pendingWheelScale.current = 1; // reset accumulator

                    const cursor = pendingWheelCursor.current;
                    const pt = svg.createSVGPoint();
                    pt.x = cursor.x;
                    pt.y = cursor.y;
                    const svgP = pt.matrixTransform(ctm.inverse());

                    const newVb: ViewBox = {
                        x: vb.x + (svgP.x - vb.x) * (1 - accumulatedScale),
                        y: vb.y + (svgP.y - vb.y) * (1 - accumulatedScale),
                        w: vb.w * accumulatedScale,
                        h: vb.h * accumulatedScale,
                    };

                    viewBoxRef.current = newVb;
                    applyViewBox(newVb);
                });
            }

            // Debounced commit: sync to React after scrolling stops
            if (wheelTimerId.current) clearTimeout(wheelTimerId.current);
            wheelTimerId.current = setTimeout(() => {
                setInteracting(false);
                commitViewBox();
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
                const screenW = svg.getBoundingClientRect().width;
                const vb = viewBoxRef.current!;
                const scale = vb.w / screenW;

                const newVb: ViewBox = {
                    ...vb,
                    x: vb.x - dx * scale,
                    y: vb.y - dy * scale,
                };
                viewBoxRef.current = newVb;
                applyViewBox(newVb);
            });
        };

        // Track the window where mousemove/mouseup are currently bound for
        // an active drag, so handleMouseUp knows where to unbind. Using a
        // closure-level variable keeps the API minimal.
        let activeDragWindow: Window | null = null;

        const handleMouseUp = () => {
            isDragging.current = false;
            setInteracting(false);
            if (rafId.current) {
                cancelAnimationFrame(rafId.current);
                rafId.current = null;
            }
            if (activeDragWindow) {
                activeDragWindow.removeEventListener('mousemove', handleMouseMove);
                activeDragWindow.removeEventListener('mouseup', handleMouseUp);
                activeDragWindow = null;
            }
            commitViewBox(); // Sync to React state on drag end
        };

        const handleMouseDown = (e: MouseEvent) => {
            if (!activeRef.current || !viewBoxRef.current) return;
            isDragging.current = true;
            startPoint.current = { x: e.clientX, y: e.clientY, pendingX: e.clientX, pendingY: e.clientY };
            setInteracting(true);

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
