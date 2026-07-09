// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { useModalKeyboard } from './useModalKeyboard';

function Modal({ isOpen, onClose, closeOnEscape }: { isOpen: boolean; onClose: () => void; closeOnEscape?: boolean }) {
    const { containerRef, dialogProps } = useModalKeyboard({ isOpen, onClose, closeOnEscape });
    if (!isOpen) return null;
    return (
        <div ref={containerRef} {...dialogProps} data-testid="modal">
            <button data-testid="first">first</button>
            <button data-testid="last">last</button>
        </div>
    );
}

describe('useModalKeyboard (QW20)', () => {
    it('stamps role="dialog" + aria-modal on the container', () => {
        render(<Modal isOpen onClose={vi.fn()} />);
        const modal = screen.getByTestId('modal');
        expect(modal).toHaveAttribute('role', 'dialog');
        expect(modal).toHaveAttribute('aria-modal', 'true');
    });

    it('calls onClose on Escape when open', () => {
        const onClose = vi.fn();
        render(<Modal isOpen onClose={onClose} />);
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('does not call onClose on Escape when closeOnEscape is false', () => {
        const onClose = vi.fn();
        render(<Modal isOpen onClose={onClose} closeOnEscape={false} />);
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(onClose).not.toHaveBeenCalled();
    });

    it('does nothing on Escape when closed', () => {
        const onClose = vi.fn();
        render(<Modal isOpen={false} onClose={onClose} />);
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(onClose).not.toHaveBeenCalled();
    });

    it('moves focus into the modal on open', () => {
        render(<Modal isOpen onClose={vi.fn()} />);
        // The container (tabIndex=-1) receives focus on open.
        expect(screen.getByTestId('modal')).toHaveFocus();
    });

    it('restores focus to the trigger element on close', () => {
        const trigger = document.createElement('button');
        document.body.appendChild(trigger);
        trigger.focus();
        expect(trigger).toHaveFocus();

        const { rerender } = render(<Modal isOpen onClose={vi.fn()} />);
        expect(screen.getByTestId('modal')).toHaveFocus();

        rerender(<Modal isOpen={false} onClose={vi.fn()} />);
        expect(trigger).toHaveFocus();
        document.body.removeChild(trigger);
    });

    it('wraps Tab from last focusable back to first (focus trap)', () => {
        render(<Modal isOpen onClose={vi.fn()} />);
        const last = screen.getByTestId('last');
        last.focus();
        fireEvent.keyDown(document, { key: 'Tab' });
        expect(screen.getByTestId('first')).toHaveFocus();
    });

    it('wraps Shift+Tab from first focusable to last', () => {
        render(<Modal isOpen onClose={vi.fn()} />);
        const first = screen.getByTestId('first');
        first.focus();
        fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
        expect(screen.getByTestId('last')).toHaveFocus();
    });
});
