// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import SldEditPanel from './SldEditPanel';

const defaultProps = {
    pendingChanges: [],
    onReset: vi.fn(),
    onSimulate: vi.fn(),
    onClose: vi.fn(),
};

describe('SldEditPanel', () => {
    it('shows the empty-state hint when there are no pending changes', () => {
        render(<SldEditPanel {...defaultProps} />);
        expect(screen.getByText(/click any switch/i)).toBeInTheDocument();
    });

    it('renders one row per pending change with baseline→target direction', () => {
        render(<SldEditPanel
            {...defaultProps}
            pendingChanges={[
                { switchId: 'SW_A', baselineOpen: false, targetOpen: true },
                { switchId: 'SW_B', baselineOpen: true, targetOpen: false },
            ]}
        />);
        const a = screen.getByTestId('sld-edit-change-SW_A');
        const b = screen.getByTestId('sld-edit-change-SW_B');
        expect(a.textContent).toMatch(/fermé.*ouvert/);
        expect(b.textContent).toMatch(/ouvert.*fermé/);
    });

    it('disables both action buttons when no changes are staged', () => {
        render(<SldEditPanel {...defaultProps} />);
        expect(screen.getByTestId('sld-edit-reset')).toBeDisabled();
        expect(screen.getByTestId('sld-edit-simulate')).toBeDisabled();
    });

    it('enables and fires Reset / Simulate when changes exist', () => {
        const onReset = vi.fn();
        const onSimulate = vi.fn();
        render(<SldEditPanel
            {...defaultProps}
            onReset={onReset}
            onSimulate={onSimulate}
            pendingChanges={[{ switchId: 'SW_A', baselineOpen: false, targetOpen: true }]}
        />);
        fireEvent.click(screen.getByTestId('sld-edit-reset'));
        fireEvent.click(screen.getByTestId('sld-edit-simulate'));
        expect(onReset).toHaveBeenCalledTimes(1);
        expect(onSimulate).toHaveBeenCalledTimes(1);
    });

    it('shows a combined-with badge when combinedWithActionId is provided', () => {
        render(<SldEditPanel
            {...defaultProps}
            pendingChanges={[{ switchId: 'SW_A', baselineOpen: false, targetOpen: true }]}
            combinedWithActionId="disco_LINE_42"
        />);
        expect(screen.getByText(/combined with disco_LINE_42/i)).toBeInTheDocument();
    });

    it('disables Simulate when busy', () => {
        render(<SldEditPanel
            {...defaultProps}
            pendingChanges={[{ switchId: 'SW_A', baselineOpen: false, targetOpen: true }]}
            busy
        />);
        const sim = screen.getByTestId('sld-edit-simulate');
        expect(sim).toBeDisabled();
        expect(sim.textContent).toMatch(/simulating/i);
    });

    it('fires onClose when the ✕ is clicked', () => {
        const onClose = vi.fn();
        render(<SldEditPanel {...defaultProps} onClose={onClose} />);
        fireEvent.click(screen.getByTestId('sld-edit-close'));
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});
