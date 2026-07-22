// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { TabId } from '../types';
import { colors } from '../styles/tokens';

/** Resolve the opener's current theme ('dark' | 'light'). */
function currentTheme(): 'dark' | 'light' {
    return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

/**
 * Mirror the opener's theme onto a popup document (QW19). The popup clones the
 * opener's stylesheets (incl. tokens.css with its `[data-theme="dark"]`
 * overrides), but NOT the `data-theme` attribute the theme toggle writes on the
 * opener's <html> — so without this a detached tab always rendered light.
 */
function mirrorTheme(popupDoc: Document): void {
    const theme = currentTheme();
    popupDoc.documentElement.setAttribute('data-theme', theme);
    popupDoc.documentElement.style.colorScheme = theme;
}

/**
 * A "detached" tab lives in a secondary browser window. The React component
 * tree for the tab content is still rendered from App.tsx — only a stable
 * portal-target DOM node is physically relocated (via appendChild) into the
 * popup's body by `DetachableTabHost`. Because the createPortal target never
 * changes (it's the same orphan div), React never unmounts the sub-tree —
 * so refs, event listeners, MemoizedSvgContainer state and the SVG viewBox
 * attribute all survive the detach/reattach round-trip unchanged.
 */
export interface DetachedTabEntry {
    /** The opened popup window — closed popups are pruned automatically. */
    window: Window;
    /** The <div id="root"> inside the popup, used as the portal target. */
    mountNode: HTMLElement;
}

export type DetachedTabsMap = Partial<Record<TabId, DetachedTabEntry>>;

const DEFAULT_POPUP_FEATURES = 'popup=yes,width=1100,height=800,resizable=yes,scrollbars=yes';

const TAB_TITLES: Record<TabId, string> = {
    'n': 'Network (N)',
    'contingency': 'Contingency (N-1)',
    'action': 'Remedial Action',
    'overflow': 'Overflow Analysis',
};

/**
 * Clone all <style> and <link rel="stylesheet"> nodes from the opener
 * document into the popup document so the portaled React tree picks up the
 * same CSS rules (Vite HMR injects styles as <style> elements, and in
 * production we get a stylesheet <link>).
 */
function cloneStylesIntoPopup(popupDoc: Document): void {
    const openerDoc = window.document;
    const head = popupDoc.head;
    openerDoc.querySelectorAll('link[rel="stylesheet"], style').forEach(node => {
        head.appendChild(node.cloneNode(true));
    });
    // Ensure the body fills the viewport so absolutely-positioned children
    // (tab content uses position:absolute + inset:0) have something to
    // size themselves against.
    const bodyStyle = popupDoc.body.style;
    bodyStyle.margin = '0';
    bodyStyle.height = '100vh';
    bodyStyle.width = '100vw';
    bodyStyle.display = 'flex';
    bodyStyle.flexDirection = 'column';
    bodyStyle.background = colors.surface;
    popupDoc.documentElement.style.height = '100%';
}

/**
 * Build the popup's mount node — a flex-growing div inside body — so that
 * the portaled tab content can use height:100% and position:absolute.
 */
function buildMountNode(popupDoc: Document): HTMLElement {
    const mount = popupDoc.createElement('div');
    mount.id = 'costudy4grid-detached-root';
    mount.style.cssText = `flex: 1; position: relative; width: 100%; min-height: 0; background: ${colors.surface};`;
    popupDoc.body.appendChild(mount);
    return mount;
}

export interface UseDetachedTabsResult {
    detachedTabs: DetachedTabsMap;
    /** True if the tab is currently opened in a secondary window. */
    isDetached: (tabId: TabId) => boolean;
    /**
     * Detach a tab into a new popup window. Returns the popup entry or null
     * if window.open was blocked. Subsequent calls for the same tab focus
     * the existing popup instead of creating a new one.
     */
    detach: (tabId: TabId) => DetachedTabEntry | null;
    /** Close the popup for the given tab (if any) and fold it back inline. */
    reattach: (tabId: TabId) => void;
    /** Focus the popup for the given tab if it exists. No-op otherwise. */
    focus: (tabId: TabId) => void;
}

export function useDetachedTabs(
    options: { onPopupBlocked?: () => void } = {}
): UseDetachedTabsResult {
    const [detachedTabs, setDetachedTabs] = useState<DetachedTabsMap>({});
    // Ref mirror so stable callbacks can read the latest map without
    // re-binding their identity on every change. Updated in a
    // useLayoutEffect to stay compatible with React strict-mode's
    // "no ref writes during render" rule.
    const detachedRef = useRef<DetachedTabsMap>({});
    const onPopupBlockedRef = useRef(options.onPopupBlocked);
    // Popups that should be closed AFTER React has had a chance to
    // relocate the tab's DOM back to the main window. Closing the popup
    // synchronously inside `reattach` can unmap its document while the
    // tab's portal host is still inside it — which, with the previous
    // React-portal implementation, tore down the React sub-tree in a
    // dying document and left other tabs in a blank state. Deferring
    // the close to a useEffect ensures the imperative DOM move has
    // already run before the popup window goes away.
    const pendingCloseRef = useRef<Window[]>([]);
    useLayoutEffect(() => {
        detachedRef.current = detachedTabs;
    }, [detachedTabs]);
    useLayoutEffect(() => {
        onPopupBlockedRef.current = options.onPopupBlocked;
    }, [options.onPopupBlocked]);

    const pruneTab = useCallback((tabId: TabId) => {
        setDetachedTabs(prev => {
            if (!prev[tabId]) return prev;
            const next = { ...prev };
            delete next[tabId];
            return next;
        });
    }, []);

    const reattach = useCallback((tabId: TabId) => {
        const entry = detachedRef.current[tabId];
        if (entry && !entry.window.closed) {
            // Queue the popup for closing; the effect below will close it
            // only after VisualizationPanel's useLayoutEffect has moved
            // the tab host back into the main window.
            pendingCloseRef.current.push(entry.window);
        }
        pruneTab(tabId);
    }, [pruneTab]);

    // Runs after VisualizationPanel's own useLayoutEffect (children run
    // before parents, and useEffect runs after useLayoutEffect in the
    // same commit), so by the time we close the popup the tab's DOM has
    // already been relocated back to the main tree.
    useEffect(() => {
        const popups = pendingCloseRef.current;
        if (popups.length === 0) return;
        pendingCloseRef.current = [];
        for (const w of popups) {
            try { if (!w.closed) w.close(); } catch { /* ignore */ }
        }
    }, [detachedTabs]);

    const detach = useCallback((tabId: TabId): DetachedTabEntry | null => {
        const existing = detachedRef.current[tabId];
        if (existing && !existing.window.closed) {
            try { existing.window.focus(); } catch { /* ignore */ }
            return existing;
        }

        const popup = window.open('', `costudy4grid_tab_${tabId}`, DEFAULT_POPUP_FEATURES);
        if (!popup) {
            onPopupBlockedRef.current?.();
            return null;
        }

        popup.document.open();
        popup.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Co-Study4Grid — ${TAB_TITLES[tabId]}</title></head><body></body></html>`);
        popup.document.close();
        cloneStylesIntoPopup(popup.document);
        mirrorTheme(popup.document);
        const mountNode = buildMountNode(popup.document);

        // When the popup is closed (by the user, by reload, or by our
        // reattach() call) we must prune it from state so the content
        // folds back into the main window. Using 'pagehide' is more
        // reliable than 'beforeunload' in modern browsers.
        const handleClose = () => pruneTab(tabId);
        popup.addEventListener('pagehide', handleClose);
        popup.addEventListener('beforeunload', handleClose);

        const entry: DetachedTabEntry = { window: popup, mountNode };
        setDetachedTabs(prev => ({ ...prev, [tabId]: entry }));
        return entry;
    }, [pruneTab]);

    // Keep open popups in sync with live theme toggles (QW19): observe the
    // opener's <html> data-theme and mirror every change onto each popup
    // document. Reads detachedRef so it needs no dep churn.
    useEffect(() => {
        const observer = new MutationObserver(() => {
            const theme = currentTheme();
            for (const entry of Object.values(detachedRef.current)) {
                if (entry && !entry.window.closed) {
                    try {
                        entry.window.document.documentElement.setAttribute('data-theme', theme);
                        entry.window.document.documentElement.style.colorScheme = theme;
                    } catch { /* popup navigating away */ }
                }
            }
        });
        observer.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ['data-theme'],
        });
        return () => observer.disconnect();
    }, []);

    const isDetached = useCallback((tabId: TabId) => {
        const entry = detachedRef.current[tabId];
        return !!entry && !entry.window.closed;
    }, []);

    const focus = useCallback((tabId: TabId) => {
        const entry = detachedRef.current[tabId];
        if (entry && !entry.window.closed) {
            try { entry.window.focus(); } catch { /* ignore */ }
        }
    }, []);

    // Poll periodically to catch popups that were closed without firing
    // pagehide (rare, but observed on some browsers during tab-crashes).
    useEffect(() => {
        const tabIds = Object.keys(detachedTabs) as TabId[];
        if (tabIds.length === 0) return;
        const intervalId = window.setInterval(() => {
            for (const tabId of tabIds) {
                const entry = detachedTabs[tabId];
                if (entry && entry.window.closed) pruneTab(tabId);
            }
        }, 1000);
        return () => window.clearInterval(intervalId);
    }, [detachedTabs, pruneTab]);

    // On App unmount (full page reload / navigation) close any live popups
    // so they don't linger as orphans pointing at a dead React tree.
    useEffect(() => {
        return () => {
            const entries = detachedRef.current;
            for (const key of Object.keys(entries) as TabId[]) {
                const entry = entries[key];
                if (entry && !entry.window.closed) {
                    try { entry.window.close(); } catch { /* ignore */ }
                }
            }
        };
    }, []);

    return { detachedTabs, isDetached, detach, reattach, focus };
}
