// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDetachedTabs } from './useDetachedTabs';

interface FakePopup {
    document: Document;
    closed: boolean;
    listeners: Record<string, Array<() => void>>;
    close: () => void;
    focus: () => void;
    addEventListener: (event: string, handler: () => void) => void;
    removeEventListener: (event: string, handler: () => void) => void;
    dispatch: (event: string) => void;
}

function createFakePopup(): FakePopup {
    // Build a fresh DOM via the main jsdom `document` — we simply use the
    // same document object for body/head since jsdom cannot spawn a second
    // one, but the hook only needs `.document.body`, `.document.head`, and
    // `createElement`, all of which this supports.
    const popupDoc = document.implementation.createHTMLDocument('popup');
    const listeners: Record<string, Array<() => void>> = {};
    const popup: FakePopup = {
        document: popupDoc,
        closed: false,
        listeners,
        close: () => { popup.closed = true; popup.dispatch('pagehide'); },
        focus: vi.fn(),
        addEventListener: (event, handler) => {
            (listeners[event] ||= []).push(handler);
        },
        removeEventListener: (event, handler) => {
            const arr = listeners[event];
            if (!arr) return;
            const idx = arr.indexOf(handler);
            if (idx >= 0) arr.splice(idx, 1);
        },
        dispatch: (event) => {
            (listeners[event] || []).slice().forEach(fn => fn());
        },
    };
    return popup;
}

describe('useDetachedTabs', () => {
    let fakePopups: FakePopup[];
    let openSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        fakePopups = [];
        openSpy = vi.spyOn(window, 'open').mockImplementation(() => {
            const popup = createFakePopup();
            fakePopups.push(popup);
            return popup as unknown as Window;
        });
    });

    afterEach(() => {
        openSpy.mockRestore();
    });

    it('starts with an empty detached map', () => {
        const { result } = renderHook(() => useDetachedTabs());
        expect(result.current.detachedTabs).toEqual({});
        expect(result.current.isDetached('contingency')).toBe(false);
    });

    it('detach opens a popup and records the tab', () => {
        const { result } = renderHook(() => useDetachedTabs());
        act(() => {
            result.current.detach('contingency');
        });
        expect(fakePopups).toHaveLength(1);
        expect(result.current.detachedTabs['contingency']).toBeDefined();
        expect(result.current.isDetached('contingency')).toBe(true);
        expect(result.current.detachedTabs['contingency']!.mountNode.id).toBe('costudy4grid-detached-root');
    });

    it('detaching the same tab twice focuses the existing popup', () => {
        const { result } = renderHook(() => useDetachedTabs());
        act(() => { result.current.detach('contingency'); });
        act(() => { result.current.detach('contingency'); });
        expect(fakePopups).toHaveLength(1);
        expect(fakePopups[0].focus).toHaveBeenCalled();
    });

    it('calls onPopupBlocked when window.open returns null', () => {
        openSpy.mockImplementation(() => null);
        const onPopupBlocked = vi.fn();
        const { result } = renderHook(() => useDetachedTabs({ onPopupBlocked }));
        let entry;
        act(() => {
            entry = result.current.detach('action');
        });
        expect(entry).toBeNull();
        expect(onPopupBlocked).toHaveBeenCalledTimes(1);
        expect(result.current.detachedTabs['action']).toBeUndefined();
    });

    it('reattach closes the popup and removes the entry', () => {
        const { result } = renderHook(() => useDetachedTabs());
        act(() => { result.current.detach('overflow'); });
        expect(result.current.isDetached('overflow')).toBe(true);
        act(() => { result.current.reattach('overflow'); });
        expect(result.current.detachedTabs['overflow']).toBeUndefined();
        expect(fakePopups[0].closed).toBe(true);
    });

    it('prunes a tab automatically when the popup fires pagehide', () => {
        const { result } = renderHook(() => useDetachedTabs());
        act(() => { result.current.detach('n'); });
        expect(result.current.isDetached('n')).toBe(true);
        act(() => {
            fakePopups[0].dispatch('pagehide');
        });
        expect(result.current.detachedTabs['n']).toBeUndefined();
    });

    it('different tabs can be detached independently', () => {
        const { result } = renderHook(() => useDetachedTabs());
        act(() => {
            result.current.detach('contingency');
            result.current.detach('action');
        });
        expect(fakePopups).toHaveLength(2);
        expect(result.current.isDetached('contingency')).toBe(true);
        expect(result.current.isDetached('action')).toBe(true);
        act(() => { result.current.reattach('contingency'); });
        expect(result.current.isDetached('contingency')).toBe(false);
        expect(result.current.isDetached('action')).toBe(true);
    });

    it('cleans up popups on hook unmount', () => {
        const { result, unmount } = renderHook(() => useDetachedTabs());
        act(() => { result.current.detach('n'); });
        const popup = fakePopups[0];
        expect(popup.closed).toBe(false);
        unmount();
        expect(popup.closed).toBe(true);
    });

    // Regression for the "blank other tabs on reattach" bug (Bug 3 in
    // docs/features/detachable-viz-tabs.md). The previous implementation closed
    // the popup window synchronously inside `reattach()`, which tore
    // down the popup document while React was still trying to unmount
    // children from the popup's mount node. The fix is to queue the
    // popup for close and let a useEffect drain the queue AFTER all
    // useLayoutEffects (including VisualizationPanel's host-move effect)
    // have run in the same commit.
    describe('reattach defers popup close until after layout effects (Bug 3)', () => {
        it('does not call window.close synchronously from the reattach call', () => {
            const { result } = renderHook(() => useDetachedTabs());
            act(() => { result.current.detach('contingency'); });
            const popup = fakePopups[0];

            // Monkey-patch close() to record the exact call order.
            const callOrder: string[] = [];
            const origClose = popup.close;
            popup.close = () => { callOrder.push('close'); origClose(); };

            // Wrap the reattach call in a synchronous IIFE so we can
            // observe the state BEFORE act() flushes effects.
            let duringReattach = false;
            let stateAfterReattachCall: typeof result.current.detachedTabs | null = null;
            act(() => {
                duringReattach = true;
                result.current.reattach('contingency');
                // At this point reattach has queued the popup for
                // close and pruned state. But act() hasn't returned
                // yet, so effects haven't flushed. The close MUST NOT
                // have fired yet.
                expect(callOrder).toEqual([]);
                stateAfterReattachCall = result.current.detachedTabs;
                duringReattach = false;
            });

            // After act() returns, effects have flushed: the popup is
            // now closed.
            expect(duringReattach).toBe(false);
            expect(callOrder).toEqual(['close']);
            expect(popup.closed).toBe(true);
            // And the tab is no longer recorded as detached.
            // (We can't use the mid-act snapshot because renderHook's
            // `result.current` is updated at the end of act().)
            expect(stateAfterReattachCall).not.toBeNull();
            expect(result.current.detachedTabs['contingency']).toBeUndefined();
        });

        it('still closes popups that were scheduled while a previous close was pending', () => {
            const { result } = renderHook(() => useDetachedTabs());
            act(() => {
                result.current.detach('n');
                result.current.detach('action');
            });
            const popupN = fakePopups[0];
            const popupAction = fakePopups[1];

            act(() => { result.current.reattach('n'); });
            act(() => { result.current.reattach('action'); });

            expect(popupN.closed).toBe(true);
            expect(popupAction.closed).toBe(true);
        });
    });

    describe('theme propagation into popups (QW19)', () => {
        afterEach(() => {
            document.documentElement.removeAttribute('data-theme');
        });

        it('mirrors the opener theme onto the popup document at detach time', () => {
            document.documentElement.setAttribute('data-theme', 'dark');
            const { result } = renderHook(() => useDetachedTabs());
            act(() => { result.current.detach('contingency'); });
            const doc = fakePopups[0].document;
            expect(doc.documentElement.getAttribute('data-theme')).toBe('dark');
            expect(doc.documentElement.style.colorScheme).toBe('dark');
        });

        it('propagates a live theme toggle to open popups via the observer', async () => {
            document.documentElement.setAttribute('data-theme', 'light');
            const { result } = renderHook(() => useDetachedTabs());
            act(() => { result.current.detach('n'); });
            const doc = fakePopups[0].document;
            expect(doc.documentElement.getAttribute('data-theme')).toBe('light');

            await act(async () => {
                document.documentElement.setAttribute('data-theme', 'dark');
                // Let the MutationObserver microtask deliver.
                await Promise.resolve();
                await Promise.resolve();
            });
            expect(doc.documentElement.getAttribute('data-theme')).toBe('dark');
        });
    });
});
