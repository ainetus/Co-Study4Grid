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
        expect(screen.getByText(/click a breaker .* or a load \/ generator/i)).toBeInTheDocument();
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

    it('focuses a single switch when its row is clicked', () => {
        const onFocus = vi.fn();
        render(<SldEditPanel
            {...defaultProps}
            onFocus={onFocus}
            pendingChanges={[
                { switchId: 'SW_A', baselineOpen: false, targetOpen: true },
                { switchId: 'SW_B', baselineOpen: true, targetOpen: false },
            ]}
        />);
        fireEvent.click(screen.getByTestId('sld-edit-focus-SW_A'));
        expect(onFocus).toHaveBeenCalledWith('SW_A');
    });

    it('clears focus when clicking the already-focused row', () => {
        const onFocus = vi.fn();
        render(<SldEditPanel
            {...defaultProps}
            focusedSwitchId="SW_A"
            onFocus={onFocus}
            pendingChanges={[{ switchId: 'SW_A', baselineOpen: false, targetOpen: true }]}
        />);
        fireEvent.click(screen.getByTestId('sld-edit-focus-SW_A'));
        expect(onFocus).toHaveBeenCalledWith(null);
    });

    it('removes a single maneuver via its × button', () => {
        const onRemove = vi.fn();
        render(<SldEditPanel
            {...defaultProps}
            onRemove={onRemove}
            pendingChanges={[{ switchId: 'SW_A', baselineOpen: false, targetOpen: true }]}
        />);
        fireEvent.click(screen.getByTestId('sld-edit-remove-SW_A'));
        expect(onRemove).toHaveBeenCalledWith('SW_A');
    });

    it('removes a block of selected maneuvers', () => {
        const onRemoveMany = vi.fn();
        render(<SldEditPanel
            {...defaultProps}
            onRemoveMany={onRemoveMany}
            pendingChanges={[
                { switchId: 'SW_A', baselineOpen: false, targetOpen: true },
                { switchId: 'SW_B', baselineOpen: true, targetOpen: false },
                { switchId: 'SW_C', baselineOpen: false, targetOpen: true },
            ]}
        />);
        fireEvent.click(screen.getByTestId('sld-edit-select-SW_A'));
        fireEvent.click(screen.getByTestId('sld-edit-select-SW_C'));
        fireEvent.click(screen.getByTestId('sld-edit-remove-selected'));
        expect(onRemoveMany).toHaveBeenCalledTimes(1);
        expect(new Set(onRemoveMany.mock.calls[0][0])).toEqual(new Set(['SW_A', 'SW_C']));
    });

    it('hides the block-remove button when nothing is selected', () => {
        render(<SldEditPanel
            {...defaultProps}
            pendingChanges={[{ switchId: 'SW_A', baselineOpen: false, targetOpen: true }]}
        />);
        expect(screen.queryByTestId('sld-edit-remove-selected')).toBeNull();
    });

    it('lists staged injection retunes with baseline→target MW', () => {
        render(<SldEditPanel
            {...defaultProps}
            injectionChanges={[
                { equipmentId: 'GEN_A', kind: 'generator', baselineP: 120, targetP: 90 },
                { equipmentId: 'LOAD_A', kind: 'load', baselineP: 50, targetP: 30 },
            ]}
        />);
        const gen = screen.getByTestId('sld-edit-injection-GEN_A');
        expect(gen.textContent).toMatch(/120\.0 → 90\.0 MW/);
        const load = screen.getByTestId('sld-edit-injection-LOAD_A');
        expect(load.textContent).toMatch(/50\.0 → 30\.0 MW/);
        // Simulate is enabled with only injection changes (no switch toggles).
        expect(screen.getByTestId('sld-edit-simulate')).not.toBeDisabled();
    });

    it('removes a staged injection retune via its × button', () => {
        const onInjectionRemove = vi.fn();
        render(<SldEditPanel
            {...defaultProps}
            onInjectionRemove={onInjectionRemove}
            injectionChanges={[{ equipmentId: 'GEN_A', kind: 'generator', baselineP: 120, targetP: 90 }]}
        />);
        fireEvent.click(screen.getByTestId('sld-edit-injection-remove-GEN_A'));
        expect(onInjectionRemove).toHaveBeenCalledWith('GEN_A');
    });

    it('focuses an injection row when its label is clicked', () => {
        const onFocus = vi.fn();
        render(<SldEditPanel
            {...defaultProps}
            onFocus={onFocus}
            injectionChanges={[{ equipmentId: 'GEN_A', kind: 'generator', baselineP: 120, targetP: 90 }]}
        />);
        fireEvent.click(screen.getByTestId('sld-edit-injection-focus-GEN_A'));
        expect(onFocus).toHaveBeenCalledWith('GEN_A');
    });
});
