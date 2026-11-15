// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study. 

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePanZoom, wheelZoomFactor } from './usePanZoom';
import { setSmoothPanZoomMode } from '../utils/smoothPanZoom';
import type { ViewBox } from '../types';

/**
 * Tests for usePanZoom hook — focused on the useLayoutEffect optimizations:
 * - applyViewBox runs before paint when tab becomes active
 * - viewBox is applied to SVG DOM element directly
 * - setViewBox updates both ref and React state
 */

function createMockSvgContainer(viewBox?: string) {
    const container = document.createElement('div');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    if (viewBox) svg.setAttribute('viewBox', viewBox);
    container.appendChild(svg);
    return { container, svg };
}

describe('usePanZoom', () => {
    const initialVB: ViewBox = { x: 0, y: 0, w: 1000, h: 800 };

    // The canvas proxy is the default mode; most cases here pin the classic
    // path (per-frame viewBox writes), and the canvas mode has its own block.
    beforeEach(() => { setSmoothPanZoomMode('off'); });

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns null viewBox when initialViewBox is null', () => {
        const ref = { current: document.createElement('div') };
        const { result } = renderHook(() => usePanZoom(ref, null, true));
        expect(result.current.viewBox).toBeNull();
    });

    it('syncs viewBox from initialViewBox on mount', () => {
        const { container, svg } = createMockSvgContainer('0 0 500 500');
        const ref = { current: container };

        const { result } = renderHook(() => usePanZoom(ref, initialVB, true));

        expect(result.current.viewBox).toEqual(initialVB);
        expect(svg.getAttribute('viewBox')).toBe('0 0 1000 800');
    });

    it('applies viewBox to SVG DOM when becoming active (useLayoutEffect)', () => {
        const { container, svg } = createMockSvgContainer('0 0 500 500');
        const ref = { current: container };

        // Start inactive
        const { result, rerender } = renderHook(
            ({ active }) => usePanZoom(ref, initialVB, active),
            { initialProps: { active: false } }
        );

        // Initial viewBox is set even when inactive (via initialViewBox effect)
        expect(result.current.viewBox).toEqual(initialVB);

        // Now become active — useLayoutEffect should apply viewBox before paint
        rerender({ active: true });
        expect(svg.getAttribute('viewBox')).toBe('0 0 1000 800');
    });

    it('setViewBox updates both DOM and React state', () => {
        const { container, svg } = createMockSvgContainer('0 0 500 500');
        const ref = { current: container };

        const { result } = renderHook(() => usePanZoom(ref, initialVB, true));

        const newVB: ViewBox = { x: 100, y: 200, w: 500, h: 400 };
        act(() => {
            result.current.setViewBox(newVB);
        });

        expect(result.current.viewBox).toEqual(newVB);
        expect(svg.getAttribute('viewBox')).toBe('100 200 500 400');
    });

    it('preserves viewBox across active/inactive transitions', () => {
        const { container, svg } = createMockSvgContainer('0 0 500 500');
        const ref = { current: container };

        const { result, rerender } = renderHook(
            ({ active }) => usePanZoom(ref, initialVB, active),
            { initialProps: { active: true } }
        );

        // Set a custom viewBox
        const customVB: ViewBox = { x: 50, y: 50, w: 300, h: 200 };
        act(() => {
            result.current.setViewBox(customVB);
        });
        expect(svg.getAttribute('viewBox')).toBe('50 50 300 200');

        // Deactivate
        rerender({ active: false });

        // Reactivate — should restore the custom viewBox
        rerender({ active: true });
        expect(svg.getAttribute('viewBox')).toBe('50 50 300 200');
    });

    it('updates viewBox when initialViewBox changes (new diagram loaded)', () => {
        const { container, svg } = createMockSvgContainer('0 0 500 500');
        const ref = { current: container };

        const { result, rerender } = renderHook(
            ({ ivb }) => usePanZoom(ref, ivb, true),
            { initialProps: { ivb: initialVB as ViewBox | null } }
        );

        expect(result.current.viewBox).toEqual(initialVB);

        const newIVB: ViewBox = { x: 0, y: 0, w: 2000, h: 1600 };
        rerender({ ivb: newIVB });

        expect(result.current.viewBox).toEqual(newIVB);
        expect(svg.getAttribute('viewBox')).toBe('0 0 2000 1600');
    });

    it('does not crash when svgRef is null', () => {
        const ref = { current: null };
        const { result } = renderHook(() => usePanZoom(ref, initialVB, true));
        expect(result.current.viewBox).toEqual(initialVB);
    });


    describe('svg-interacting class toggle', () => {
        it('does not have svg-interacting class initially', () => {
            const { container } = createMockSvgContainer('0 0 1000 800');
            const ref = { current: container };

            renderHook(() => usePanZoom(ref, initialVB, true));

            expect(container.classList.contains('svg-interacting')).toBe(false);
        });
    });

    describe('CTM cache invalidation', () => {
        it('setViewBox applies viewBox to DOM (which invalidates cached CTM)', () => {
            const { container, svg } = createMockSvgContainer('0 0 1000 800');
            const ref = { current: container };

            const { result } = renderHook(() => usePanZoom(ref, initialVB, true));

            // Simulate zoom by setting a smaller viewBox
            const zoomedVB: ViewBox = { x: 200, y: 200, w: 400, h: 300 };
            act(() => {
                result.current.setViewBox(zoomedVB);
            });

            // viewBox should update in DOM
            expect(svg.getAttribute('viewBox')).toBe('200 200 400 300');

            // Set another viewBox — each call invalidates cached CTM
            const zoomedVB2: ViewBox = { x: 300, y: 300, w: 200, h: 150 };
            act(() => {
                result.current.setViewBox(zoomedVB2);
            });

            expect(svg.getAttribute('viewBox')).toBe('300 300 200 150');
            expect(result.current.viewBox).toEqual(zoomedVB2);
        });
    });

    describe('regression: multiple rapid active/inactive transitions', () => {
        it('does not corrupt viewBox after rapid tab switching', () => {
            const { container, svg } = createMockSvgContainer('0 0 500 500');
            const ref = { current: container };

            const { result, rerender } = renderHook(
                ({ active }) => usePanZoom(ref, initialVB, active),
                { initialProps: { active: true } }
            );

            // Set a custom zoom
            const zoomedVB: ViewBox = { x: 100, y: 100, w: 200, h: 200 };
            act(() => {
                result.current.setViewBox(zoomedVB);
            });

            // Rapid tab switch simulation
            rerender({ active: false });
            rerender({ active: true });
            rerender({ active: false });
            rerender({ active: true });

            // ViewBox should be preserved through all transitions
            expect(svg.getAttribute('viewBox')).toBe('100 100 200 200');
            expect(result.current.viewBox).toEqual(zoomedVB);
        });
    });

    describe('zoom tier (data-zoom-tier attribute)', () => {
        it('sets "overview" tier on initial load (full extent viewBox)', () => {
            const { container } = createMockSvgContainer('0 0 500 500');
            const ref = { current: container };

            renderHook(() => usePanZoom(ref, initialVB, true));

            // ratio = 1000/1000 = 1.0 > 0.5 → overview
            expect(container.getAttribute('data-zoom-tier')).toBe('overview');
        });

        it('sets "region" tier when zoomed to 50% of original width', () => {
            const { container } = createMockSvgContainer('0 0 500 500');
            const ref = { current: container };

            const { result } = renderHook(() => usePanZoom(ref, initialVB, true));

            // ratio = 400/1000 = 0.4 → region (0.15 < 0.4 ≤ 0.5)
            act(() => {
                result.current.setViewBox({ x: 200, y: 200, w: 400, h: 300 });
            });

            expect(container.getAttribute('data-zoom-tier')).toBe('region');
        });

        it('sets "detail" tier when zoomed to <15% of original width', () => {
            const { container } = createMockSvgContainer('0 0 500 500');
            const ref = { current: container };

            const { result } = renderHook(() => usePanZoom(ref, initialVB, true));

            // ratio = 100/1000 = 0.1 → detail (≤ 0.15)
            act(() => {
                result.current.setViewBox({ x: 400, y: 400, w: 100, h: 80 });
            });

            expect(container.getAttribute('data-zoom-tier')).toBe('detail');
        });

        it('transitions between tiers as zoom changes', () => {
            const { container } = createMockSvgContainer('0 0 500 500');
            const ref = { current: container };

            const { result } = renderHook(() => usePanZoom(ref, initialVB, true));
            expect(container.getAttribute('data-zoom-tier')).toBe('overview');

            // Zoom to region
            act(() => {
                result.current.setViewBox({ x: 0, y: 0, w: 300, h: 240 });
            });
            expect(container.getAttribute('data-zoom-tier')).toBe('region');

            // Zoom to detail
            act(() => {
                result.current.setViewBox({ x: 0, y: 0, w: 100, h: 80 });
            });
            expect(container.getAttribute('data-zoom-tier')).toBe('detail');

            // Zoom back out to overview
            act(() => {
                result.current.setViewBox({ x: 0, y: 0, w: 900, h: 720 });
            });
            expect(container.getAttribute('data-zoom-tier')).toBe('overview');
        });

        it('resets tier when a new diagram loads (initialViewBox changes)', () => {
            const { container } = createMockSvgContainer('0 0 500 500');
            const ref = { current: container };

            const { result, rerender } = renderHook(
                ({ ivb }) => usePanZoom(ref, ivb, true),
                { initialProps: { ivb: initialVB as ViewBox | null } }
            );

            // Zoom into detail
            act(() => {
                result.current.setViewBox({ x: 400, y: 400, w: 100, h: 80 });
            });
            expect(container.getAttribute('data-zoom-tier')).toBe('detail');

            // New diagram loads with different dimensions
            const newIVB: ViewBox = { x: 0, y: 0, w: 5000, h: 4000 };
            rerender({ ivb: newIVB });

            // Should reset to overview (ratio = 5000/5000 = 1.0)
            expect(container.getAttribute('data-zoom-tier')).toBe('overview');
        });

        it('preserves tier across active/inactive transitions', () => {
            const { container } = createMockSvgContainer('0 0 500 500');
            const ref = { current: container };

            const { result, rerender } = renderHook(
                ({ active }) => usePanZoom(ref, initialVB, active),
                { initialProps: { active: true } }
            );

            // Zoom to detail
            act(() => {
                result.current.setViewBox({ x: 0, y: 0, w: 100, h: 80 });
            });
            expect(container.getAttribute('data-zoom-tier')).toBe('detail');

            // Deactivate and reactivate
            rerender({ active: false });
            rerender({ active: true });

            expect(container.getAttribute('data-zoom-tier')).toBe('detail');
        });

        it('does not set tier when container ref is null', () => {
            const ref = { current: null };

            renderHook(() => usePanZoom(ref, initialVB, true));

            // No container → no attribute to check (should not crash)
        });

        it('handles exact boundary values correctly', () => {
            const { container } = createMockSvgContainer('0 0 500 500');
            const ref = { current: container };

            const { result } = renderHook(() => usePanZoom(ref, initialVB, true));

            // ratio = 500/1000 = 0.5 → exactly at boundary → region (not overview)
            act(() => {
                result.current.setViewBox({ x: 0, y: 0, w: 500, h: 400 });
            });
            expect(container.getAttribute('data-zoom-tier')).toBe('region');

            // ratio = 150/1000 = 0.15 → exactly at boundary → detail (not region)
            act(() => {
                result.current.setViewBox({ x: 0, y: 0, w: 150, h: 120 });
            });
            expect(container.getAttribute('data-zoom-tier')).toBe('detail');
        });
    });

    // Regression for Bug 1/2/4 in docs/features/detachable-viz-tabs.md:
    // `usePanZoom` used to bind mousemove/mouseup to `window` captured
    // at effect-run time. When a tab was detached into a popup, the
    // element's ownerWindow became the popup but the listeners still
    // lived on the main window — drag-pan therefore stopped working
    // inside the popup. The fix binds mousemove/mouseup PER-DRAG
    // inside handleMouseDown, using a fresh
    // `el.ownerDocument.defaultView` lookup each time. This test
    // verifies that drag-start binds to the element's current owner
    // window and drag-end unbinds from it, regardless of the window
    // identity.
    describe('drag listeners bind to the element\'s current ownerWindow per-drag (Bug 1/2/4)', () => {
        it('does not register any mousemove/mouseup on window at effect bind time', () => {
            const { container } = createMockSvgContainer('0 0 1000 800');
            const ref = { current: container };

            const windowAddSpy = vi.spyOn(window, 'addEventListener');
            renderHook(() => usePanZoom(ref, initialVB, true));

            // Critical: the effect must NOT register any
            // mousemove/mouseup globally at bind time. Those are only
            // registered when a drag actually starts (in handleMouseDown).
            const globalMouseMoveCalls = windowAddSpy.mock.calls.filter(
                ([evt]) => evt === 'mousemove' || evt === 'mouseup'
            );
            expect(globalMouseMoveCalls).toEqual([]);
            windowAddSpy.mockRestore();
        });

        it('binds mousemove/mouseup on the element\'s current ownerWindow when mousedown fires', () => {
            const { container } = createMockSvgContainer('0 0 1000 800');
            const ref = { current: container };
            renderHook(() => usePanZoom(ref, initialVB, true));

            // `container.ownerDocument.defaultView` is the jsdom
            // window here. Spy on addEventListener on that window.
            const ownerWindow = container.ownerDocument.defaultView!;
            const addSpy = vi.spyOn(ownerWindow, 'addEventListener');

            // Fire a mousedown on the element to enter drag state.
            const mouseDown = new MouseEvent('mousedown', { bubbles: true, clientX: 10, clientY: 10 });
            container.dispatchEvent(mouseDown);

            // The drag listeners are now bound on the owner window.
            const calls = addSpy.mock.calls.map(([evt]) => evt);
            expect(calls).toContain('mousemove');
            expect(calls).toContain('mouseup');
            addSpy.mockRestore();
        });

        it('unbinds mousemove/mouseup from the owner window on mouseup', () => {
            const { container } = createMockSvgContainer('0 0 1000 800');
            const ref = { current: container };
            renderHook(() => usePanZoom(ref, initialVB, true));

            const ownerWindow = container.ownerDocument.defaultView!;
            const removeSpy = vi.spyOn(ownerWindow, 'removeEventListener');

            container.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 10, clientY: 10 }));
            ownerWindow.dispatchEvent(new MouseEvent('mouseup'));

            const calls = removeSpy.mock.calls.map(([evt]) => evt);
            expect(calls).toContain('mousemove');
            expect(calls).toContain('mouseup');
            removeSpy.mockRestore();
        });

        it('resolves the ownerWindow on every mousedown, even across container movements', () => {
            // Use a detached container so we can freely patch its
            // ownerDocument.defaultView without affecting other tests.
            const doc = document.implementation.createHTMLDocument('t');
            const container = doc.createElement('div');
            const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.setAttribute('viewBox', '0 0 1000 800');
            container.appendChild(svg);
            const ref = { current: container };
            renderHook(() => usePanZoom(ref, initialVB, true));

            // Simulate a "second window" by patching the detached
            // document's defaultView to point at a fake window. This
            // is what would happen when the tab is relocated to a
            // popup via imperative DOM move.
            let lastTarget: EventTarget | null = null;
            const fakeWindow: Partial<Window> = {
                addEventListener: ((event: string) => {
                    lastTarget = fakeWindow as unknown as EventTarget;
                    void event;
                }) as Window['addEventListener'],
                removeEventListener: (() => {}) as Window['removeEventListener'],
            };

            Object.defineProperty(doc, 'defaultView', {
                configurable: true,
                get: () => fakeWindow,
            });

            container.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 10, clientY: 10 }));

            // On this drag, listeners were bound to the fake window —
            // proving that the lookup happens per-drag rather than
            // once at effect time. (If it were captured at effect
            // time, the drag would have bound to whatever `window`
            // was at that moment, not the current ownerWindow.)
            expect(lastTarget).toBe(fakeWindow);
        });
    });

    describe('bitmap mode — graceful degradation', () => {
        // In jsdom (no SVG-to-canvas raster) and on a cold serialisation cache,
        // a bitmap-mode gesture must NOT crash, must NOT mount a canvas overlay,
        // and must leave the live SVG visible (it stays on the viewBox fallback).
        // The expensive serialize is never run synchronously in the handler, so
        // the gesture start stays responsive.
        it('does not crash or mount a canvas; keeps the live SVG visible', async () => {
            setSmoothPanZoomMode('bitmap');
            try {
                const { container, svg } = createMockSvgContainer('0 0 1000 800');
                document.body.appendChild(container);
                const ref = { current: container };
                renderHook(() => usePanZoom(ref, initialVB, true));

                act(() => {
                    container.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 100, clientY: 100 }));
                });
                act(() => {
                    window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 130, clientY: 120 }));
                });
                // flush the deferred build (setTimeout 0)
                await act(async () => { await new Promise((r) => setTimeout(r, 5)); });

                expect(container.querySelector('canvas')).toBeNull();
                expect(svg.style.visibility).not.toBe('hidden');

                act(() => { window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); });
                document.body.removeChild(container);
            } finally {
                setSmoothPanZoomMode('off');
            }
        });
    });
    describe('wheelZoomFactor — delta magnitude', () => {
        it('zooms 10 % per mouse-wheel notch, in both directions', () => {
            expect(wheelZoomFactor(100, 0, 800)).toBeCloseTo(1.1);
            expect(wheelZoomFactor(-100, 0, 800)).toBeCloseTo(1 / 1.1);
        });

        it('counts any notched-wheel delta as at least one notch (53 px on some platforms)', () => {
            expect(wheelZoomFactor(53, 0, 800)).toBeCloseTo(1.1);
        });

        it('keeps every notch of a coalesced event (Chrome sums queued deltas)', () => {
            expect(wheelZoomFactor(300, 0, 800)).toBeCloseTo(1.1 ** 3);
        });

        it('zooms small trackpad deltas proportionally instead of 10 % each', () => {
            expect(wheelZoomFactor(4, 0, 800)).toBeCloseTo(1.1 ** 0.04);
        });

        it('normalises line / page delta modes and caps a single event at 10 notches', () => {
            expect(wheelZoomFactor(3, 1, 800)).toBeCloseTo(1.1 ** 0.99);
            expect(wheelZoomFactor(5, 2, 800)).toBeCloseTo(1.1 ** 10);
            expect(wheelZoomFactor(0, 0, 800)).toBe(1);
        });
    });

    describe('drag-pan follows the cursor', () => {
        let frames: FrameRequestCallback[];

        const layout = (svg: SVGSVGElement, w: number, h: number) => {
            svg.getBoundingClientRect = () => ({ left: 0, top: 0, right: w, bottom: h, width: w, height: h, x: 0, y: 0, toJSON: () => ({}) });
            Object.defineProperty(svg, 'clientWidth', { configurable: true, value: w });
            Object.defineProperty(svg, 'clientHeight', { configurable: true, value: h });
        };

        beforeEach(() => {
            frames = [];
            vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { frames.push(cb); return frames.length; });
            vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
        });

        afterEach(() => {
            vi.restoreAllMocks();
        });

        const drag = (container: HTMLElement, from: number, to: number, runFrames: boolean) => {
            act(() => { container.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: from, clientY: 100 })); });
            act(() => { window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: to, clientY: 100 })); });
            if (runFrames) act(() => { while (frames.length) frames.shift()!(0); });
            act(() => { window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); });
        };

        it('applies the pending movement when the mouseup arrives before the frame', () => {
            const { container, svg } = createMockSvgContainer('0 0 1000 800');
            layout(svg, 1000, 800);
            renderHook(() => usePanZoom({ current: container }, initialVB, true));
            // The mousemove's frame never runs before the mouseup — the case of
            // a busy main thread delivering both in one task.
            drag(container, 100, 200, false);
            expect(svg.getAttribute('viewBox')).toBe('-100 0 1000 800');
        });

        it('uses the letterboxed axis scale under preserveAspectRatio "meet"', () => {
            // Panel 2.5:1, diagram 1.25:1 → the height binds: 2 user units per px.
            const { container, svg } = createMockSvgContainer('0 0 1000 800');
            layout(svg, 1000, 400);
            renderHook(() => usePanZoom({ current: container }, initialVB, true));
            drag(container, 100, 150, true);
            expect(svg.getAttribute('viewBox')).toBe('-100 0 1000 800');
        });
    });

    describe('a press during the wheel settle', () => {
        beforeEach(() => {
            vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
            vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 0);
            vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
        });

        afterEach(() => {
            vi.useRealTimers();
            vi.restoreAllMocks();
            document.body.innerHTML = '';
        });

        it('takes the gesture over: the wheel settle does not un-cull mid-drag', () => {
            const { container } = createMockSvgContainer('0 0 1000 800');
            document.body.appendChild(container);
            renderHook(() => usePanZoom({ current: container }, initialVB, true));
            act(() => { container.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100, clientX: 500, clientY: 400 })); });
            expect(container.classList.contains('svg-interacting')).toBe(true);
            act(() => { container.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 100, clientY: 100 })); });
            act(() => { vi.advanceTimersByTime(500); });
            expect(container.classList.contains('svg-interacting')).toBe(true);
            act(() => { window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); });
            expect(container.classList.contains('svg-interacting')).toBe(false);
        });
    });

    describe('canvas gesture proxy mode', () => {
        let frames: FrameRequestCallback[];
        let paints: string[];

        // jsdom has no 2D canvas: a context that records what the on-screen
        // proxy paints (the offscreen overview cache is not recorded).
        class FakePath2D { moveTo() {} lineTo() {} closePath() {} ellipse() {} addPath() {} }
        const fakeCtx = (canvas: HTMLCanvasElement) => {
            const record = (op: string) => { if (canvas.classList.contains('nad-canvas-proxy')) paints.push(op); };
            return {
                globalAlpha: 1, fillStyle: '', strokeStyle: '', lineWidth: 1, lineCap: '', lineJoin: '',
                setTransform: () => {}, setLineDash: () => {}, fill: () => {}, stroke: () => {}, drawImage: () => {},
                fillRect: () => record('fillRect'),
                clearRect: () => record('clearRect'),
            };
        };
        const shown = () => paints[paints.length - 1] === 'fillRect';
        const flushFrames = () => act(() => { while (frames.length) frames.shift()!(0); });

        beforeEach(() => {
            frames = [];
            paints = [];
            vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
            vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { frames.push(cb); return frames.length; });
            vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
            vi.stubGlobal('Path2D', FakePath2D);
            vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
                return fakeCtx(this) as unknown as CanvasRenderingContext2D;
            });
            setSmoothPanZoomMode('canvas');
        });

        afterEach(() => {
            setSmoothPanZoomMode('off');
            vi.useRealTimers();
            vi.restoreAllMocks();
            vi.unstubAllGlobals();
            document.body.innerHTML = '';
        });

        const setup = (options?: { gestureProxy?: boolean }) => {
            const { container, svg } = createMockSvgContainer('0 0 1000 800');
            document.body.appendChild(container);
            svg.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800, x: 0, y: 0, toJSON: () => ({}) });
            for (const el of [svg, container]) {
                Object.defineProperty(el, 'clientWidth', { configurable: true, value: 1000 });
                Object.defineProperty(el, 'clientHeight', { configurable: true, value: 800 });
            }
            const hook = renderHook(() => usePanZoom({ current: container }, initialVB, true, options));
            return { container, svg, hook };
        };
        const press = (el: Element, x: number, y = 100) => act(() => { el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y })); });
        const move = (x: number, y = 100) => act(() => { window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y })); });
        const release = () => act(() => { window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); });

        it('pans on the canvas and bakes the live viewBox once, when the operator pauses', () => {
            const { container, svg } = setup();
            press(container, 100);
            // A press alone draws nothing: a plain click selects a VL.
            expect(paints).toEqual([]);
            move(150);
            flushFrames();
            expect(shown()).toBe(true);
            expect(container.hasAttribute('data-gesture-proxy')).toBe(true);
            // No culling toggle on this path: it restyles the whole live tree.
            expect(container.classList.contains('svg-interacting')).toBe(false);
            expect(svg.getAttribute('viewBox')).toBe('0 0 1000 800');

            release();
            expect(svg.getAttribute('viewBox')).toBe('0 0 1000 800');
            act(() => { vi.advanceTimersByTime(400); });
            expect(svg.getAttribute('viewBox')).toBe('-50 0 1000 800');
            // The canvas stays up until the live SVG has painted the bake.
            expect(shown()).toBe(true);
            flushFrames();
            expect(shown()).toBe(false);
            expect(container.hasAttribute('data-gesture-proxy')).toBe(false);
        });

        it('chains drags that follow within the pause, with a single bake', () => {
            const { container, svg } = setup();
            press(container, 100);
            move(150);
            flushFrames();
            release();
            act(() => { vi.advanceTimersByTime(200); });
            press(container, 300);
            move(350);
            flushFrames();
            release();
            act(() => { vi.advanceTimersByTime(399); });
            expect(svg.getAttribute('viewBox')).toBe('0 0 1000 800');
            act(() => { vi.advanceTimersByTime(1); });
            expect(svg.getAttribute('viewBox')).toBe('-100 0 1000 800');
        });

        it('a plain click neither draws the proxy nor rewrites the viewBox', () => {
            const { container, svg } = setup();
            const setAttr = vi.spyOn(svg, 'setAttribute');
            press(container, 100);
            release();
            act(() => { vi.advanceTimersByTime(1000); });
            flushFrames();
            expect(paints).toEqual([]);
            expect(setAttr).not.toHaveBeenCalledWith('viewBox', expect.anything());
        });

        it('zooms on the canvas and bakes after the wheel pause', () => {
            const { container, svg } = setup();
            act(() => { container.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100, clientX: 500, clientY: 400 })); });
            flushFrames();
            expect(shown()).toBe(true);
            expect(svg.getAttribute('viewBox')).toBe('0 0 1000 800');
            act(() => { vi.advanceTimersByTime(400); });
            const [, , w] = svg.getAttribute('viewBox')!.split(' ').map(Number);
            expect(w).toBeCloseTo(1000 / 1.1);
        });

        it('falls back to the default path on surfaces that opt out (Action overview)', () => {
            const { container } = setup({ gestureProxy: false });
            press(container, 100);
            expect(container.querySelector('canvas.nad-canvas-proxy')).toBeNull();
            expect(container.classList.contains('svg-interacting')).toBe(true);
            release();
        });

        it('a programmatic viewBox jump ends a canvas gesture', () => {
            const { container, svg, hook } = setup();
            press(container, 100);
            move(150);
            flushFrames();
            expect(shown()).toBe(true);
            act(() => { hook.result.current.setViewBox({ x: 10, y: 20, w: 300, h: 240 }); });
            expect(shown()).toBe(false);
            expect(svg.getAttribute('viewBox')).toBe('10 20 300 240');
            release();
            act(() => { vi.advanceTimersByTime(1000); });
            expect(svg.getAttribute('viewBox')).toBe('10 20 300 240');
        });
    });
});
