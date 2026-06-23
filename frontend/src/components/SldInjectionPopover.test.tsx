// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import SldInjectionPopover from './SldInjectionPopover';
import type { VlInjection } from '../types';

const genInjection: VlInjection = {
    kind: 'generator', p: 120, min_p: 0, max_p: 200, energy_source: 'WIND',
};
const loadInjection: VlInjection = { kind: 'load', p: 42.5 };

const baseProps = {
    equipmentId: 'GEN_X',
    injection: genInjection,
    currentValue: 120,
    staged: false,
    position: { x: 10, y: 10 },
    onApply: vi.fn(),
    onRemove: vi.fn(),
    onClose: vi.fn(),
};

describe('SldInjectionPopover', () => {
    it('shows the equipment name, kind, energy source and Pmin/Pmax for a generator', () => {
        render(<SldInjectionPopover {...baseProps} onApply={vi.fn()} />);
        expect(screen.getByTestId('sld-injection-name').textContent).toBe('GEN_X');
        expect(screen.getByTestId('sld-injection-source').textContent).toBe('WIND');
        expect(screen.getByTestId('sld-injection-bounds').textContent).toMatch(/0\.0 MW.*200\.0 MW/);
    });

    it('omits bounds + source for a load', () => {
        render(<SldInjectionPopover {...baseProps} equipmentId="LOAD_X" injection={loadInjection} currentValue={42.5} />);
        expect(screen.queryByTestId('sld-injection-bounds')).toBeNull();
        expect(screen.queryByTestId('sld-injection-source')).toBeNull();
    });

    it('applies the typed setpoint', () => {
        const onApply = vi.fn();
        render(<SldInjectionPopover {...baseProps} onApply={onApply} />);
        fireEvent.change(screen.getByTestId('sld-injection-input'), { target: { value: '90' } });
        fireEvent.click(screen.getByTestId('sld-injection-apply'));
        expect(onApply).toHaveBeenCalledWith(90);
    });

    it('seeds the input rounded to a single decimal', () => {
        render(<SldInjectionPopover {...baseProps} currentValue={16.199733180865255} />);
        expect((screen.getByTestId('sld-injection-input') as HTMLInputElement).value).toBe('16.2');
    });

    it('rounds the applied setpoint to one decimal', () => {
        const onApply = vi.fn();
        render(<SldInjectionPopover {...baseProps} onApply={onApply} />);
        fireEvent.change(screen.getByTestId('sld-injection-input'), { target: { value: '90.456' } });
        fireEvent.click(screen.getByTestId('sld-injection-apply'));
        expect(onApply).toHaveBeenCalledWith(90.5);
    });

    it('clamps an out-of-range generator setpoint to its capability bounds', () => {
        const onApply = vi.fn();
        render(<SldInjectionPopover {...baseProps} onApply={onApply} />);
        fireEvent.change(screen.getByTestId('sld-injection-input'), { target: { value: '250' } });
        expect(screen.getByTestId('sld-injection-clamp-note')).toBeInTheDocument();
        fireEvent.click(screen.getByTestId('sld-injection-apply'));
        expect(onApply).toHaveBeenCalledWith(200);
    });

    it('disables Apply when the input is blank / invalid', () => {
        render(<SldInjectionPopover {...baseProps} currentValue={NaN} />);
        expect(screen.getByTestId('sld-injection-apply')).toBeDisabled();
    });

    it('exposes a Reset control only when a value is already staged', () => {
        const { rerender } = render(<SldInjectionPopover {...baseProps} staged={false} />);
        expect(screen.queryByTestId('sld-injection-remove')).toBeNull();
        rerender(<SldInjectionPopover {...baseProps} staged={true} />);
        expect(screen.getByTestId('sld-injection-remove')).toBeInTheDocument();
    });

    it('fires onRemove and onClose from their controls', () => {
        const onRemove = vi.fn();
        const onClose = vi.fn();
        render(<SldInjectionPopover {...baseProps} staged onRemove={onRemove} onClose={onClose} />);
        fireEvent.click(screen.getByTestId('sld-injection-remove'));
        expect(onRemove).toHaveBeenCalled();
        fireEvent.click(screen.getByTestId('sld-injection-cancel'));
        expect(onClose).toHaveBeenCalled();
    });
});
