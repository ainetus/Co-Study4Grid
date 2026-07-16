// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0

// Shared modal keyboard / focus behaviour (QW20). The dialogs previously had
// no Escape-to-close, no initial focus, no focus trap, and inconsistent
// `role`/`aria-modal`. This hook centralises all of it:
//   - Escape closes the modal (opt-out via closeOnEscape).
//   - On open, focus moves into the modal (initialFocusRef ?? the container).
//   - Tab / Shift+Tab wrap within the modal's focusable descendants (trap).
//   - On close, focus is restored to whatever had it before the modal opened.
//   - `dialogProps` stamps role="dialog" + aria-modal + tabIndex=-1.

import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE_SELECTOR = [
    'a[href]',
    'button:not([disabled])',
    'textarea:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
].join(', ');

export interface ModalKeyboardOptions {
    isOpen: boolean;
    onClose: () => void;
    /** Default true — set false for modals that must not close on Escape. */
    closeOnEscape?: boolean;
    /** Element to focus on open; falls back to the modal container. */
    initialFocusRef?: RefObject<HTMLElement | null>;
}

export interface ModalKeyboardResult {
    containerRef: RefObject<HTMLDivElement | null>;
    dialogProps: { readonly role: 'dialog'; readonly 'aria-modal': true; readonly tabIndex: -1 };
}

const DIALOG_PROPS = { role: 'dialog', 'aria-modal': true, tabIndex: -1 } as const;

export function useModalKeyboard(
    { isOpen, onClose, closeOnEscape = true, initialFocusRef }: ModalKeyboardOptions,
): ModalKeyboardResult {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const restoreFocusRef = useRef<HTMLElement | null>(null);
    // Latest-ref for the caller-provided values so the keydown effect below
    // depends only on `isOpen` / `closeOnEscape`. Without this, an inline
    // `onClose` (a new identity each render) would re-run the effect on every
    // render — and its cleanup restores focus, so the modal would thrash focus.
    const onCloseRef = useRef(onClose);
    const initialFocusStore = useRef(initialFocusRef);
    useEffect(() => {
        onCloseRef.current = onClose;
        initialFocusStore.current = initialFocusRef;
    });

    useEffect(() => {
        if (!isOpen) return;
        // Remember what had focus so we can restore it on close.
        restoreFocusRef.current = document.activeElement as HTMLElement | null;
        (initialFocusStore.current?.current ?? containerRef.current)?.focus();

        const onKeyDown = (e: KeyboardEvent) => {
            if (closeOnEscape && e.key === 'Escape') {
                e.stopPropagation();
                onCloseRef.current();
                return;
            }
            if (e.key !== 'Tab' || !containerRef.current) return;
            // The selector already excludes disabled controls and
            // tabindex="-1"; DOM order is what the wrap needs. (No visibility
            // filter — offsetParent/getClientRects are unavailable under jsdom
            // and display:none controls aren't Tab-reachable anyway.)
            const focusables = Array.from(
                containerRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
            );
            if (focusables.length === 0) {
                e.preventDefault();
                containerRef.current.focus();
                return;
            }
            const first = focusables[0];
            const last = focusables[focusables.length - 1];
            const active = document.activeElement;
            if (e.shiftKey && (active === first || active === containerRef.current)) {
                e.preventDefault();
                last.focus();
            } else if (!e.shiftKey && active === last) {
                e.preventDefault();
                first.focus();
            }
        };

        document.addEventListener('keydown', onKeyDown, true);
        return () => {
            document.removeEventListener('keydown', onKeyDown, true);
            restoreFocusRef.current?.focus?.();
        };
    }, [isOpen, closeOnEscape]);

    return { containerRef, dialogProps: DIALOG_PROPS };
}
