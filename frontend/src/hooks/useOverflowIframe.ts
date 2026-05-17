// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0

import React from 'react';
import type {
    ActionOverviewFilters,
    IframeToParentMessage,
    ParentToIframeMessage,
} from '../types';
import { interactionLogger } from '../utils/interactionLogger';
import { decidePopoverPlacement } from '../utils/popoverPlacement';
import type { OverflowPin } from '../utils/svg/overflowPinPayload';

/**
 * Runtime guard for the iframe → parent envelope. Verifies the shape
 * against the discriminated union in `types.ts` so the consuming
 * branches can rely on typed access.
 */
function isIframeMessage(value: unknown): value is IframeToParentMessage {
    if (!value || typeof value !== 'object') return false;
    const t = (value as { type?: unknown }).type;
    if (typeof t !== 'string' || !t.startsWith('cs4g:')) return false;
    return true;
}

export interface OverflowIframePopoverPin {
    id: string;
    screenX: number;
    screenY: number;
    placeAbove: boolean;
    horizontalAlign: 'start' | 'center' | 'end';
}

export interface OverflowIframeState {
    overflowIframeRef: React.MutableRefObject<HTMLIFrameElement | null>;
    overflowPopoverRef: React.MutableRefObject<HTMLDivElement | null>;
    overflowPopoverPin: OverflowIframePopoverPin | null;
    setOverflowPopoverPin: React.Dispatch<React.SetStateAction<OverflowIframePopoverPin | null>>;
    overflowPopoverViewport: { width: number; height: number } | null;
    setOverflowPopoverViewport: React.Dispatch<React.SetStateAction<{ width: number; height: number } | null>>;
}

interface UseOverflowIframeArgs {
    pdfUrl: string | null | undefined;
    overflowPinsEnabled: boolean;
    overflowPins: ReadonlyArray<OverflowPin> | undefined;
    overviewFilters: ActionOverviewFilters | undefined;
    /** Total execution time (seconds) for creating + generating the
     *  overflow analysis graph. Forwarded to the iframe via the
     *  ``cs4g:overflow-meta`` envelope so the overlay can render it
     *  as a subtitle below its ``<h1>`` filename header. ``null`` /
     *  ``undefined`` hides the subtitle. */
    overflowGraphTime?: number | null;
    onOverflowPinPreview?: (actionId: string) => void;
    onOverflowPinDoubleClick?: (actionId: string, substation: string) => void;
    onSimulateUnsimulatedAction?: (actionId: string) => void;
    onOverviewFiltersChange?: (filters: ActionOverviewFilters) => void;
    /** The iframe sidebar hosts the pins on/off toggle; the parent
     *  remains the source of truth for `overflowPinsEnabled` so it
     *  echoes the new state back via `cs4g:pins`. */
    onOverflowPinsToggle?: (enabled: boolean) => void;
    onVlOpen?: (vlId: string) => void;
    /** When the overflow tab is detached into a secondary popup, the
     *  iframe's `window.parent.postMessage(...)` calls land on the
     *  popup window — not the main React window where this hook lives.
     *  Pass the popup window here so the message handler is also bound
     *  to it; without this, every iframe→parent event (overlay-ready,
     *  pin clicks, filter changes, …) is dropped after a layout switch
     *  remounts the iframe inside the popup. */
    detachedWindow?: Window | null;
}

/**
 * Encapsulates the overflow-graph iframe ↔ parent-window plumbing:
 *
 *   1. ``cs4g:overlay-ready`` handshake so we know the iframe has
 *      registered its message listener before the first pin payload
 *      is broadcast.
 *   2. Routing every iframe-originated message to the right parent
 *      callback (pin click, pin double-click, unsimulated-pin
 *      double-click, filter change, layer toggle, node double-click)
 *      and emitting the matching interactionLogger event.
 *   3. Pin-popover state (`overflowPopoverPin` / `overflowPopoverViewport`)
 *      with outside-click + Escape dismissal, mirroring the Action-
 *      Overview pin preview UX.
 *   4. Broadcasting current pin payload + filter chip state back into
 *      the iframe whenever they change (or once at overlay-ready time).
 *
 * The iframe is same-origin (localhost:8000), so postMessage is safe.
 */
export function useOverflowIframe(args: UseOverflowIframeArgs): OverflowIframeState {
    const {
        pdfUrl,
        overflowPinsEnabled,
        overflowPins,
        overviewFilters,
        overflowGraphTime,
        onOverflowPinPreview,
        onOverflowPinDoubleClick,
        onSimulateUnsimulatedAction,
        onOverviewFiltersChange,
        onOverflowPinsToggle,
        onVlOpen,
        detachedWindow,
    } = args;

    const overflowIframeRef = React.useRef<HTMLIFrameElement | null>(null);
    const [overlayReady, setOverlayReady] = React.useState(false);
    const [overflowPopoverPin, setOverflowPopoverPin] = React.useState<OverflowIframePopoverPin | null>(null);
    const [overflowPopoverViewport, setOverflowPopoverViewport] = React.useState<{
        width: number; height: number;
    } | null>(null);
    const overflowPopoverRef = React.useRef<HTMLDivElement | null>(null);

    React.useEffect(() => {
        // Reset readiness on URL change (a new file means a fresh load).
        setOverlayReady(false);
        // A fresh iframe means any old popover is referencing a pin
        // that no longer exists. Drop it on URL change.
        setOverflowPopoverPin(null);
        setOverflowPopoverViewport(null);
    }, [pdfUrl]);

    React.useEffect(() => {
        const onMessage = (ev: MessageEvent) => {
            if (!isIframeMessage(ev?.data)) return;
            const msg = ev.data;
            switch (msg.type) {
                case 'cs4g:overlay-ready':
                    setOverlayReady(true);
                    break;
                case 'cs4g:pin-clicked': {
                    // Single click on an overflow pin mirrors the
                    // Action-Overview pin: focus the feed card on the
                    // matching action AND show a floating
                    // ActionCardPopover anchored on the pin. Must NOT
                    // call `onActionSelect` — that would switch the
                    // active tab and prevent a follow-up double-click
                    // drill into the SLD overlay.
                    if (onOverflowPinPreview) onOverflowPinPreview(msg.actionId);
                    interactionLogger.record('overflow_pin_clicked', { actionId: msg.actionId });
                    // The pin's bounding rect is in iframe-screen
                    // pixels; translate to parent-screen pixels by
                    // adding the iframe's own offset so the popover
                    // lands on the correct spot in the parent document.
                    const iframeEl = overflowIframeRef.current;
                    const rect = msg.screenRect;
                    if (iframeEl && rect) {
                        const ifRect = iframeEl.getBoundingClientRect();
                        const cx = ifRect.left + rect.left + rect.width / 2;
                        const cy = ifRect.top + rect.top + rect.height / 2;
                        const viewport = {
                            width: window.innerWidth,
                            height: window.innerHeight,
                        };
                        const placement = decidePopoverPlacement(cx, cy, viewport);
                        setOverflowPopoverPin({
                            id: msg.actionId,
                            screenX: cx,
                            screenY: cy,
                            ...placement,
                        });
                        setOverflowPopoverViewport(viewport);
                    }
                    break;
                }
                case 'cs4g:pin-double-clicked':
                    // Drill into the SLD on the action sub-tab for
                    // that substation. Double-click cancels any open
                    // preview popover so the SLD overlay takes focus.
                    setOverflowPopoverPin(null);
                    setOverflowPopoverViewport(null);
                    if (onOverflowPinDoubleClick) {
                        onOverflowPinDoubleClick(msg.actionId, msg.substation);
                    }
                    break;
                case 'cs4g:overflow-unsimulated-pin-double-clicked':
                    // Double-click on an un-simulated overflow pin
                    // kicks off a manual simulation — same path the
                    // Action Overview's renderUnsimulatedPin double-
                    // click takes through
                    // `handleSimulateUnsimulatedAction`. Drop the
                    // popover first; the simulation will replace
                    // this pin with a real one.
                    setOverflowPopoverPin(null);
                    setOverflowPopoverViewport(null);
                    if (onSimulateUnsimulatedAction) {
                        onSimulateUnsimulatedAction(msg.actionId);
                    }
                    interactionLogger.record('overview_unsimulated_pin_simulated', {
                        action_id: msg.actionId,
                    });
                    break;
                case 'cs4g:overflow-filter-changed':
                    // The iframe sidebar carries a copy of the
                    // Action-Overview filter chips. Forward changes
                    // so the parent's shared `overviewFilters` (which
                    // also drives the Action Feed and the Action
                    // Overview NAD pins) stays in lock-step.
                    if (onOverviewFiltersChange) {
                        onOverviewFiltersChange(msg.filters);
                    }
                    interactionLogger.record('overview_filter_changed', {
                        kind: 'overflow_iframe',
                    });
                    break;
                case 'cs4g:overflow-layer-toggled':
                    interactionLogger.record('overflow_layer_toggled', {
                        key: msg.key, label: msg.label, visible: msg.visible,
                    });
                    break;
                case 'cs4g:overflow-select-all-layers':
                    interactionLogger.record('overflow_select_all_layers', {
                        visible: msg.visible,
                    });
                    break;
                case 'cs4g:overflow-pins-toggled':
                    // The pins on/off toggle now lives inside the
                    // iframe's filter panel. Forward the new state so
                    // the parent's `overflowPinsEnabled` flips and the
                    // standard `cs4g:pins` echo brings the iframe UI
                    // back in sync (the parent remains the source of
                    // truth, single round-trip per toggle).
                    if (onOverflowPinsToggle) onOverflowPinsToggle(!!msg.enabled);
                    interactionLogger.record('overflow_pins_toggled', { enabled: !!msg.enabled });
                    break;
                case 'cs4g:overflow-node-double-clicked':
                    // The overflow graph node double-click opens the
                    // SLD overlay for that voltage level (or
                    // substation, depending on the backend). The
                    // parent's `onVlOpen` handler routes through the
                    // same path used by the NAD double-click.
                    if (onVlOpen) onVlOpen(msg.name);
                    interactionLogger.record('overflow_node_double_clicked', { name: msg.name });
                    break;
            }
        };
        window.addEventListener('message', onMessage);
        // When the overflow tab is detached, the iframe lives inside a
        // popup window. Its `window.parent.postMessage(...)` calls hit
        // the popup window, not the main one — so we listen there too.
        // Without this binding the overlay-ready handshake (and every
        // subsequent pin / filter / node event) would be dropped after
        // a layout switch remounts the iframe inside the popup.
        const popup = (detachedWindow && detachedWindow !== window && !detachedWindow.closed)
            ? detachedWindow : null;
        if (popup) {
            popup.addEventListener('message', onMessage);
        }
        return () => {
            window.removeEventListener('message', onMessage);
            if (popup) {
                try { popup.removeEventListener('message', onMessage); } catch { /* popup torn down */ }
            }
        };
    }, [onVlOpen, onOverflowPinPreview, onOverflowPinDoubleClick,
        onOverviewFiltersChange, onOverflowPinsToggle,
        onSimulateUnsimulatedAction, detachedWindow]);

    // Outside-click + Escape dismissal for the overflow pin popover —
    // mirrors `ActionOverviewDiagram`. Clicks INSIDE the iframe (the
    // pin itself, the graph background) live in a different document
    // and don't reach the parent's mousedown handler, so they don't
    // close the popover. To prevent that the iframe's own background
    // click is forwarded by the upstream interactive_html clicker
    // through the existing `cs4g:overflow-node-double-clicked` path
    // (clicks not on a pin are silently ignored), so the popover
    // stays open until the user clicks outside the iframe / hits Esc
    // / clicks the popover's own close button.
    React.useEffect(() => {
        if (!overflowPopoverPin) return;
        const onDocMouseDown = (e: MouseEvent) => {
            const target = e.target as Node | null;
            if (overflowPopoverRef.current && target
                && overflowPopoverRef.current.contains(target)) return;
            // Clicks ON the iframe itself bubble up to the parent as
            // an event whose target is the iframe element. Don't close
            // the popover in that case — the click might be a follow-up
            // pin click handled separately.
            if (target instanceof Element
                && target === overflowIframeRef.current) return;
            setOverflowPopoverPin(null);
            setOverflowPopoverViewport(null);
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                setOverflowPopoverPin(null);
                setOverflowPopoverViewport(null);
            }
        };
        document.addEventListener('mousedown', onDocMouseDown);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onDocMouseDown);
            document.removeEventListener('keydown', onKey);
        };
    }, [overflowPopoverPin]);

    React.useEffect(() => {
        const iframe = overflowIframeRef.current;
        if (!iframe || !iframe.contentWindow) return;
        if (!overlayReady) return;
        const msg: ParentToIframeMessage = {
            type: 'cs4g:pins',
            visible: !!overflowPinsEnabled,
            pins: overflowPinsEnabled ? (overflowPins ?? []) : [],
        };
        iframe.contentWindow.postMessage(msg, '*');
    }, [overlayReady, overflowPinsEnabled, overflowPins]);

    // Broadcast the current Action-Overview filter state into the
    // iframe whenever it changes (and once at overlay-ready time).
    // The iframe's sidebar mirrors these chips so a change made on
    // the Action Overview NAD instantly reflects in the overflow
    // graph filter panel — and vice versa.
    React.useEffect(() => {
        const iframe = overflowIframeRef.current;
        if (!iframe || !iframe.contentWindow) return;
        if (!overlayReady) return;
        if (!overviewFilters) return;
        const msg: ParentToIframeMessage = {
            type: 'cs4g:filters',
            filters: overviewFilters,
        };
        iframe.contentWindow.postMessage(msg, '*');
    }, [overlayReady, overviewFilters]);

    // Broadcast the overflow-graph build time so the iframe overlay
    // renders it as a subtitle right below the sidebar ``<h1>``. The
    // overlay JS owns the DOM mutation — the React side only forwards
    // the value, mirroring the pattern used for pins / filters above.
    React.useEffect(() => {
        const iframe = overflowIframeRef.current;
        if (!iframe || !iframe.contentWindow) return;
        if (!overlayReady) return;
        const msg: ParentToIframeMessage = {
            type: 'cs4g:overflow-meta',
            overflowGraphTime: typeof overflowGraphTime === 'number' ? overflowGraphTime : null,
        };
        iframe.contentWindow.postMessage(msg, '*');
    }, [overlayReady, overflowGraphTime]);

    return {
        overflowIframeRef,
        overflowPopoverRef,
        overflowPopoverPin,
        setOverflowPopoverPin,
        overflowPopoverViewport,
        setOverflowPopoverViewport,
    };
}
