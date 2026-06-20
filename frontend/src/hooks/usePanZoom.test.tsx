// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study. 

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePanZoom } from './usePanZoom';
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
});
