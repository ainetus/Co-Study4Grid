// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useOverflowIframe } from './useOverflowIframe';
import type { OverflowPin } from '../utils/svg/overflowPinPayload';

/** Window-like stub backed by a real EventTarget so we can dispatch
 *  message events at it just like a popup window would receive them
 *  from `iframe.contentWindow.parent.postMessage(...)` when the
 *  overflow tab is detached into a secondary browser window. */
function makePopupWindow(): Window {
    const target = new EventTarget();
    return Object.assign(target, { closed: false }) as unknown as Window;
}

describe('useOverflowIframe', () => {
    const noopArgs = {
        pdfUrl: '/results/pdf/foo.html' as string | null | undefined,
        overflowPinsEnabled: false,
        overflowPins: [] as ReadonlyArray<OverflowPin>,
        overviewFilters: undefined,
    };

    it('handshake on the MAIN window flips overlayReady so pins broadcast', () => {
        const postMessage = vi.fn();
        const { result, rerender } = renderHook(
            ({ enabled }: { enabled: boolean }) => useOverflowIframe({
                ...noopArgs,
                overflowPinsEnabled: enabled,
            }),
            { initialProps: { enabled: false } },
        );
        // Simulate the iframe ref being attached. Only `contentWindow.postMessage`
        // is read, so a stub object satisfies the broadcast path.
        act(() => {
            (result.current.overflowIframeRef as { current: unknown }).current = {
                contentWindow: { postMessage },
            };
        });
        // Handshake on main window — listener registered there.
        act(() => {
            window.dispatchEvent(new MessageEvent('message', {
                data: { type: 'cs4g:overlay-ready' },
            }));
        });
        // Toggle enabled to trigger the broadcast effect.
        rerender({ enabled: true });
        expect(postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'cs4g:pins', visible: true, pins: [] }),
            '*',
        );
    });

    it('listens on detachedWindow too so the handshake from a popup-mounted iframe is received (regression)', () => {
        // Regression: when the overflow tab is detached, the iframe's
        // `window.parent.postMessage(...)` lands on the popup window.
        // Without binding the listener there, overlay-ready was lost,
        // overlayReady stayed false and the pin-toggle did nothing
        // after a layout switch.
        const popup = makePopupWindow();
        const postMessage = vi.fn();
        const { result, rerender } = renderHook(
            ({ enabled }: { enabled: boolean }) => useOverflowIframe({
                ...noopArgs,
                overflowPinsEnabled: enabled,
                detachedWindow: popup,
            }),
            { initialProps: { enabled: false } },
        );
        act(() => {
            (result.current.overflowIframeRef as { current: unknown }).current = {
                contentWindow: { postMessage },
            };
        });
        // Handshake arrives on the popup window — main window's
        // listener would never see it, but the popup-bound listener
        // must.
        act(() => {
            popup.dispatchEvent(new MessageEvent('message', {
                data: { type: 'cs4g:overlay-ready' },
            }));
        });
        rerender({ enabled: true });
        expect(postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'cs4g:pins', visible: true }),
            '*',
        );
    });

    it('broadcasts cs4g:overflow-meta whenever overflowGraphTime changes after the handshake', () => {
        const postMessage = vi.fn();
        const { result, rerender } = renderHook(
            ({ time }: { time: number | null }) => useOverflowIframe({
                ...noopArgs,
                overflowGraphTime: time,
            }),
            { initialProps: { time: null as number | null } },
        );
        act(() => {
            (result.current.overflowIframeRef as { current: unknown }).current = {
                contentWindow: { postMessage },
            };
        });
        act(() => {
            window.dispatchEvent(new MessageEvent('message', {
                data: { type: 'cs4g:overlay-ready' },
            }));
        });
        // After the handshake, the initial null meta is forwarded so the
        // iframe can wipe any prior subtitle.
        expect(postMessage).toHaveBeenCalledWith(
            { type: 'cs4g:overflow-meta', overflowGraphTime: null },
            '*',
        );
        // Update the time — the new value reaches the iframe.
        postMessage.mockClear();
        rerender({ time: 3.42 });
        expect(postMessage).toHaveBeenCalledWith(
            { type: 'cs4g:overflow-meta', overflowGraphTime: 3.42 },
            '*',
        );
    });

    it('removes the popup-window listener on unmount and on detachedWindow change', () => {
        const popupA = makePopupWindow();
        const popupB = makePopupWindow();
        const removeA = vi.spyOn(popupA, 'removeEventListener');
        const removeB = vi.spyOn(popupB, 'removeEventListener');
        const { rerender, unmount } = renderHook(
            ({ detached }: { detached: Window | null }) => useOverflowIframe({
                ...noopArgs,
                detachedWindow: detached,
            }),
            { initialProps: { detached: popupA as Window | null } },
        );
        // Switch from popupA to popupB — popupA's listener must come off.
        rerender({ detached: popupB });
        expect(removeA).toHaveBeenCalledWith('message', expect.any(Function));
        // Reattach (detached → null) — popupB's listener must come off.
        rerender({ detached: null });
        expect(removeB).toHaveBeenCalledWith('message', expect.any(Function));
        unmount();
    });
});
