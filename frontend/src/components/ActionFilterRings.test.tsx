// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import ActionFilterRings from './ActionFilterRings';
import { DEFAULT_ACTION_OVERVIEW_FILTERS } from '../utils/actionTypes';
import type { ActionOverviewFilters } from '../types';

const baseFilters: ActionOverviewFilters = DEFAULT_ACTION_OVERVIEW_FILTERS;

describe('ActionFilterRings', () => {
    // The severity ring defers the single-click toggle by one
    // double-click window so a double-click can "solo" instead —
    // fake timers let the tests drive both gestures deterministically.
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    const flushClickDelay = () => act(() => { vi.advanceTimersByTime(300); });

    it('renders the severity ring (4 colour-coded outcome toggles)', () => {
        render(<ActionFilterRings filters={baseFilters} onFiltersChange={vi.fn()} />);
        for (const cat of ['green', 'orange', 'red', 'grey']) {
            expect(screen.getByTestId(`sidebar-filter-category-${cat}`)).toBeInTheDocument();
        }
    });

    it('renders the action-type ring (7 uncoloured pictogram toggles)', () => {
        render(<ActionFilterRings filters={baseFilters} onFiltersChange={vi.fn()} />);
        for (const t of ['disco', 'reco', 'open', 'close', 'ls', 'rc', 'pst']) {
            expect(screen.getByTestId(`sidebar-filter-type-${t}`)).toBeInTheDocument();
        }
    });

    it('replaces the textual "Actions:" label with a 📍 + dash glyph (keeps the wording in the title tooltip)', () => {
        // Removing the leading word frees ~60px on the sidebar row so
        // the severity ring + action-type ring + threshold spinner
        // fit a single line. The wording moves into the hover tooltip
        // so the meaning stays reachable without occupying space.
        const { container } = render(<ActionFilterRings filters={baseFilters} onFiltersChange={vi.fn()} />);
        const root = screen.getByTestId('sidebar-action-filters');
        expect(root.textContent).not.toContain('Actions:');
        // Pin glyph + em-dash separator present.
        expect(root.textContent).toContain('📍');
        expect(root.textContent).toContain('–');
        // Wording is reachable on hover via the title tooltip.
        expect(container.querySelector('[title="Actions filters"]')).not.toBeNull();
    });

    it('renders the Max-loading threshold spinner at a 3-digit-tight width (compact single-row layout)', () => {
        // Operator-reported regression: the rings bar wrapped onto a
        // second line when the threshold input was 38 px wide.
        // Three real-world digits (max-loading ≤ 200 %, never 1000 %)
        // fit comfortably in 26 px with native spinner arrows
        // suppressed by inline ``appearance: textfield`` + the
        // ``::-webkit-inner-spin-button`` CSS rule.
        render(<ActionFilterRings filters={baseFilters} onFiltersChange={vi.fn()} />);
        const input = screen.getByTestId('sidebar-filter-threshold-input') as HTMLInputElement;
        expect(input.style.width).toBe('26px');
        expect(input.style.appearance).toBe('textfield');
        // The leading ⚡ glyph was removed (it now belongs to
        // Contingency); the input sits directly inside the label so
        // the bar fits the sidebar.
        const label = screen.getByTestId('sidebar-filter-threshold');
        expect(label.textContent).not.toContain('⚡');
    });

    it('shows every severity toggle as pressed when all categories are enabled', () => {
        render(<ActionFilterRings filters={baseFilters} onFiltersChange={vi.fn()} />);
        for (const cat of ['green', 'orange', 'red', 'grey']) {
            expect(screen.getByTestId(`sidebar-filter-category-${cat}`)).toHaveAttribute('aria-pressed', 'true');
        }
    });

    it('single-click solos a severity category — enables only that outcome (after the double-click window)', () => {
        const onFiltersChange = vi.fn();
        render(<ActionFilterRings filters={baseFilters} onFiltersChange={onFiltersChange} />);
        fireEvent.click(screen.getByTestId('sidebar-filter-category-red'));
        // Deferred until the double-click window elapses.
        expect(onFiltersChange).not.toHaveBeenCalled();
        flushClickDelay();
        expect(onFiltersChange).toHaveBeenCalledWith({
            ...baseFilters,
            categories: { green: false, orange: false, red: true, grey: false },
        });
    });

    it('single-click on an already-soloed severity category restores all outcomes', () => {
        const onFiltersChange = vi.fn();
        const filters: ActionOverviewFilters = {
            ...baseFilters,
            categories: { green: false, orange: false, red: true, grey: false },
        };
        render(<ActionFilterRings filters={filters} onFiltersChange={onFiltersChange} />);
        fireEvent.click(screen.getByTestId('sidebar-filter-category-red'));
        flushClickDelay();
        expect(onFiltersChange).toHaveBeenCalledWith({
            ...filters,
            categories: { green: true, orange: true, red: true, grey: true },
        });
    });

    it('double-click toggles a severity category off', () => {
        const onFiltersChange = vi.fn();
        render(<ActionFilterRings filters={baseFilters} onFiltersChange={onFiltersChange} />);
        const red = screen.getByTestId('sidebar-filter-category-red');
        fireEvent.click(red);
        fireEvent.click(red);
        expect(onFiltersChange).toHaveBeenCalledTimes(1);
        expect(onFiltersChange).toHaveBeenCalledWith({
            ...baseFilters,
            categories: { ...baseFilters.categories, red: false },
        });
        // The deferred single-click must NOT also fire after the toggle.
        flushClickDelay();
        expect(onFiltersChange).toHaveBeenCalledTimes(1);
    });

    it('double-click toggles a disabled severity category back on', () => {
        const onFiltersChange = vi.fn();
        const filters: ActionOverviewFilters = {
            ...baseFilters,
            categories: { ...baseFilters.categories, grey: false },
        };
        render(<ActionFilterRings filters={filters} onFiltersChange={onFiltersChange} />);
        const greyToggle = screen.getByTestId('sidebar-filter-category-grey');
        expect(greyToggle).toHaveAttribute('aria-pressed', 'false');
        fireEvent.click(greyToggle);
        fireEvent.click(greyToggle);
        expect(onFiltersChange).toHaveBeenCalledWith({
            ...filters,
            categories: { ...filters.categories, grey: true },
        });
    });

    it('selects a single action type when its toggle is clicked', () => {
        const onFiltersChange = vi.fn();
        render(<ActionFilterRings filters={baseFilters} onFiltersChange={onFiltersChange} />);
        fireEvent.click(screen.getByTestId('sidebar-filter-type-pst'));
        expect(onFiltersChange).toHaveBeenCalledWith({ ...baseFilters, actionType: 'pst' });
    });

    it('clears the action-type filter back to "all" when the active type is re-clicked', () => {
        const onFiltersChange = vi.fn();
        const filters: ActionOverviewFilters = { ...baseFilters, actionType: 'ls' };
        render(<ActionFilterRings filters={filters} onFiltersChange={onFiltersChange} />);
        const lsToggle = screen.getByTestId('sidebar-filter-type-ls');
        expect(lsToggle).toHaveAttribute('aria-pressed', 'true');
        fireEvent.click(lsToggle);
        expect(onFiltersChange).toHaveBeenCalledWith({ ...filters, actionType: 'all' });
    });

    it('exposes the underlying wording as a hover tooltip on every toggle', () => {
        render(<ActionFilterRings filters={baseFilters} onFiltersChange={vi.fn()} />);
        expect(screen.getByTestId('sidebar-filter-category-green'))
            .toHaveAttribute('title', expect.stringContaining('Solves overload'));
        expect(screen.getByTestId('sidebar-filter-type-disco'))
            .toHaveAttribute('title', 'Show only: Line disconnection');
    });

    it('hosts a compact Max-loading threshold spinner alongside the rings', () => {
        // Moved out of the ActionOverviewDiagram header into the
        // sidebar rings so the overview banner stays single-row; the
        // operator can adjust the threshold from the same control
        // surface that drives severity + action-type filtering.
        render(<ActionFilterRings filters={baseFilters} onFiltersChange={vi.fn()} />);
        const input = screen.getByTestId('sidebar-filter-threshold-input') as HTMLInputElement;
        expect(input.type).toBe('number');
        expect(input.min).toBe('0');
        expect(input.max).toBe('300');
        expect(input.step).toBe('1');
        // DEFAULT threshold = 1.5 → 150 %.
        expect(input.value).toBe('150');
    });

    it('threshold input update fires onFiltersChange with the new fractional threshold', () => {
        // The widget reads / writes a 0–300 % integer; the wire format
        // is the fraction (1.0 = 100 %).
        const onFiltersChange = vi.fn();
        render(<ActionFilterRings filters={baseFilters} onFiltersChange={onFiltersChange} />);
        const input = screen.getByTestId('sidebar-filter-threshold-input') as HTMLInputElement;
        fireEvent.change(input, { target: { value: '100' } });
        expect(onFiltersChange).toHaveBeenCalledTimes(1);
        expect(onFiltersChange.mock.calls[0][0].threshold).toBeCloseTo(1.0);
    });

    it('threshold input clamps values outside 0–300 %', () => {
        const onFiltersChange = vi.fn();
        render(<ActionFilterRings filters={baseFilters} onFiltersChange={onFiltersChange} />);
        const input = screen.getByTestId('sidebar-filter-threshold-input') as HTMLInputElement;
        fireEvent.change(input, { target: { value: '999' } });
        expect(onFiltersChange).toHaveBeenLastCalledWith(expect.objectContaining({ threshold: 3.0 }));
        fireEvent.change(input, { target: { value: '-50' } });
        expect(onFiltersChange).toHaveBeenLastCalledWith(expect.objectContaining({ threshold: 0 }));
    });

    it('emits no raw hex literals in inline styles', () => {
        const { container } = render(<ActionFilterRings filters={baseFilters} onFiltersChange={vi.fn()} />);
        const hexInStyle = /#[0-9a-fA-F]{3,8}\b/;
        const offenders: string[] = [];
        container.querySelectorAll<HTMLElement>('[style]').forEach(el => {
            const style = el.getAttribute('style') ?? '';
            if (hexInStyle.test(style)) offenders.push(style);
        });
        expect(offenders).toEqual([]);
    });
});
