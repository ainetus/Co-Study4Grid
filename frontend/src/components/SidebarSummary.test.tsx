// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import SidebarSummary from './SidebarSummary';
import { DEFAULT_ACTION_OVERVIEW_FILTERS } from '../utils/actionTypes';
import type { ActionOverviewFilters } from '../types';

describe('SidebarSummary', () => {
    const baseProps = {
        selectedContingency: [] as string[],
        n1LinesOverloaded: undefined as string[] | undefined,
        n1LinesOverloadedRho: undefined as number[] | undefined,
        selectedOverloads: undefined as Set<string> | null | undefined,
        displayName: (id: string) => id,
        onContingencyZoom: vi.fn(),
        onOverloadClick: vi.fn(),
    };

    it('renders nothing when there is no contingency, no overloads and no filters', () => {
        const { container } = render(<SidebarSummary {...baseProps} />);
        expect(container.firstChild).toBeNull();
    });

    it('renders the contingency row with a zoom-to button', () => {
        const onContingencyZoom = vi.fn();
        render(
            <SidebarSummary
                {...baseProps}
                selectedContingency={['LINE_A']}
                onContingencyZoom={onContingencyZoom}
            />,
        );
        const strip = screen.getByTestId('sticky-feed-summary');
        expect(strip).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'LINE_A' }));
        expect(onContingencyZoom).toHaveBeenCalledWith('LINE_A');
    });

    it('uses the ⚡ lightning pictogram for the Contingency label (replaces the old 🎯)', () => {
        // Visual contract: the Contingency-as-fault metaphor is
        // pinned on the ⚡ glyph across the sidebar (status line +
        // picker card title). The legacy 🎯 must not regress here.
        render(
            <SidebarSummary
                {...baseProps}
                selectedContingency={['LINE_A']}
            />,
        );
        const strip = screen.getByTestId('sticky-feed-summary');
        expect(strip.textContent).toContain('⚡ Contingency');
        expect(strip.textContent).not.toContain('🎯');
    });

    it('renders the overloads row with per-line jump buttons', () => {
        const onOverloadClick = vi.fn();
        render(
            <SidebarSummary
                {...baseProps}
                n1LinesOverloaded={['LINE_X']}
                n1LinesOverloadedRho={[1.05]}
                onOverloadClick={onOverloadClick}
            />,
        );
        expect(screen.getByText(/Overloads:/i)).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'LINE_X' }));
        expect(onOverloadClick).toHaveBeenCalledWith('', 'LINE_X', 'contingency');
    });

    it('renders the ActionFilterRings when hasActions + filters + onChange are all wired', () => {
        render(
            <SidebarSummary
                {...baseProps}
                selectedContingency={['LINE_A']}
                overviewFilters={DEFAULT_ACTION_OVERVIEW_FILTERS as ActionOverviewFilters}
                onOverviewFiltersChange={vi.fn()}
                hasActions
            />,
        );
        expect(screen.getByTestId('sidebar-action-filters')).toBeInTheDocument();
    });

    it('hides the filter rings while the feed has no action to filter (hasActions=false)', () => {
        render(
            <SidebarSummary
                {...baseProps}
                selectedContingency={['LINE_A']}
                overviewFilters={DEFAULT_ACTION_OVERVIEW_FILTERS as ActionOverviewFilters}
                onOverviewFiltersChange={vi.fn()}
                hasActions={false}
            />,
        );
        expect(screen.queryByTestId('sidebar-action-filters')).not.toBeInTheDocument();
    });

    it('hides the filter rings when no overviewFilters object is supplied', () => {
        render(
            <SidebarSummary
                {...baseProps}
                selectedContingency={['LINE_A']}
                hasActions
            />,
        );
        expect(screen.queryByTestId('sidebar-action-filters')).not.toBeInTheDocument();
    });

    it('renders the strip for the filter rings alone, below the overloads row', () => {
        render(
            <SidebarSummary
                {...baseProps}
                n1LinesOverloaded={['LINE_X']}
                n1LinesOverloadedRho={[1.05]}
                overviewFilters={DEFAULT_ACTION_OVERVIEW_FILTERS as ActionOverviewFilters}
                onOverviewFiltersChange={vi.fn()}
                hasActions
            />,
        );
        const overloads = screen.getByText(/Overloads:/i);
        const filters = screen.getByTestId('sidebar-action-filters');
        // Filter rings come AFTER the overloads row in document order.
        expect(overloads.compareDocumentPosition(filters) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('renders the strip even when ONLY the filter rings are present', () => {
        render(
            <SidebarSummary
                {...baseProps}
                overviewFilters={DEFAULT_ACTION_OVERVIEW_FILTERS as ActionOverviewFilters}
                onOverviewFiltersChange={vi.fn()}
                hasActions
            />,
        );
        expect(screen.getByTestId('sticky-feed-summary')).toBeInTheDocument();
        expect(screen.getByTestId('sidebar-action-filters')).toBeInTheDocument();
    });

    // ===== readability-feed PR: Clear button =====
    describe('Clear contingency shortcut', () => {
        it('renders the Clear button next to the contingency label when a handler is wired', () => {
            render(
                <SidebarSummary
                    {...baseProps}
                    selectedContingency={['LINE_A']}
                    onClearContingency={vi.fn()}
                />,
            );
            const clearBtn = screen.getByTestId('sidebar-summary-clear');
            expect(clearBtn).toBeInTheDocument();
            expect(clearBtn.textContent).toMatch(/Clear/);
        });

        it('fires onClearContingency when the Clear button is clicked', () => {
            const onClearContingency = vi.fn();
            render(
                <SidebarSummary
                    {...baseProps}
                    selectedContingency={['LINE_A']}
                    onClearContingency={onClearContingency}
                />,
            );
            fireEvent.click(screen.getByTestId('sidebar-summary-clear'));
            expect(onClearContingency).toHaveBeenCalledTimes(1);
        });

        it('omits the Clear button when no handler is provided', () => {
            render(
                <SidebarSummary
                    {...baseProps}
                    selectedContingency={['LINE_A']}
                />,
            );
            expect(screen.queryByTestId('sidebar-summary-clear')).not.toBeInTheDocument();
        });

        it('omits the Clear button when there is no contingency to clear', () => {
            render(
                <SidebarSummary
                    {...baseProps}
                    n1LinesOverloaded={['LINE_X']}
                    n1LinesOverloadedRho={[1.05]}
                    onClearContingency={vi.fn()}
                />,
            );
            expect(screen.queryByTestId('sidebar-summary-clear')).not.toBeInTheDocument();
        });
    });

    // ===== readability-feed PR: double-click overload toggle =====
    describe('Overload double-click toggle', () => {
        it('toggles the overload via onToggleOverload on double-click', () => {
            const onToggleOverload = vi.fn();
            render(
                <SidebarSummary
                    {...baseProps}
                    selectedContingency={['LINE_A']}
                    n1LinesOverloaded={['LINE_X', 'LINE_Y']}
                    n1LinesOverloadedRho={[1.05, 1.02]}
                    onToggleOverload={onToggleOverload}
                />,
            );
            fireEvent.doubleClick(screen.getByRole('button', { name: 'LINE_X' }));
            expect(onToggleOverload).toHaveBeenCalledWith('LINE_X');
        });

        it('single-click still routes to onOverloadClick (zoom shortcut) regardless of toggle wiring', () => {
            const onOverloadClick = vi.fn();
            render(
                <SidebarSummary
                    {...baseProps}
                    selectedContingency={['LINE_A']}
                    n1LinesOverloaded={['LINE_X']}
                    n1LinesOverloadedRho={[1.05]}
                    onOverloadClick={onOverloadClick}
                    onToggleOverload={vi.fn()}
                />,
            );
            fireEvent.click(screen.getByRole('button', { name: 'LINE_X' }));
            expect(onOverloadClick).toHaveBeenCalledWith('', 'LINE_X', 'contingency');
        });

        it('does nothing on double-click when no toggle handler is wired', () => {
            // The double-click branch is gated on `onToggleOverload` —
            // without it the dbl-click is a no-op (the existing single-
            // click zoom semantics are preserved by the click handler).
            const onToggleOverload = vi.fn();
            render(
                <SidebarSummary
                    {...baseProps}
                    selectedContingency={['LINE_A']}
                    n1LinesOverloaded={['LINE_X']}
                    n1LinesOverloadedRho={[1.05]}
                    // onToggleOverload intentionally omitted
                />,
            );
            fireEvent.doubleClick(screen.getByRole('button', { name: 'LINE_X' }));
            expect(onToggleOverload).not.toHaveBeenCalled();
        });

        it('shows the deselected style when an overload is not in selectedOverloads', () => {
            const selectedOverloads = new Set<string>();
            const { container } = render(
                <SidebarSummary
                    {...baseProps}
                    selectedContingency={['LINE_A']}
                    n1LinesOverloaded={['LINE_X']}
                    n1LinesOverloadedRho={[1.05]}
                    selectedOverloads={selectedOverloads}
                />,
            );
            const link = screen.getByRole('button', { name: 'LINE_X' });
            // Deselected links carry weight 400 and no underline (vs 600
            // + underline-dotted for selected) — matches the OverloadPanel
            // contract preserved by the readability-feed PR.
            const style = link.getAttribute('style') || '';
            expect(style).toMatch(/font-weight:\s*400/);
            expect(style).not.toMatch(/underline/);
            expect(container).toBeInTheDocument();
        });
    });

    // ===== readability-feed PR: overload info bubble =====
    describe('Overload info bubble', () => {
        const overloadProps = {
            ...baseProps,
            selectedContingency: ['LINE_A'],
            n1LinesOverloaded: ['LINE_X', 'LINE_Y'],
            n1LinesOverloadedRho: [1.05, 1.02],
        };

        it('renders the bubble icon when overloads are present', () => {
            render(<SidebarSummary {...overloadProps} />);
            expect(screen.getByTestId('sidebar-summary-overloads-bubble')).toBeInTheDocument();
        });

        it('opens the popover on click and shows N-overloads + N-1 toggles + monitor-deselected', () => {
            const onToggleOverload = vi.fn();
            const onToggleMonitorDeselected = vi.fn();
            render(
                <SidebarSummary
                    {...overloadProps}
                    nLinesOverloaded={['LINE_N_PRE']}
                    nLinesOverloadedRho={[1.10]}
                    selectedOverloads={new Set(['LINE_X'])} // LINE_Y deselected → monitor-deselected toggle shows
                    onToggleOverload={onToggleOverload}
                    onToggleMonitorDeselected={onToggleMonitorDeselected}
                    monitorDeselected={false}
                    monitoringHint="100/200 lines monitored — see Notices for details."
                />,
            );
            fireEvent.click(screen.getByTestId('sidebar-summary-overloads-bubble'));

            const popover = screen.getByTestId('overload-info-popover');
            expect(popover).toBeInTheDocument();
            expect(popover.textContent).toMatch(/100\/200 lines monitored/);
            expect(within(popover).getByText('LINE_N_PRE')).toBeInTheDocument();
            expect(within(popover).getByTestId('overload-info-toggle-LINE_X')).toBeInTheDocument();
            expect(within(popover).getByTestId('overload-info-toggle-LINE_Y')).toBeInTheDocument();
            expect(within(popover).getByTestId('overload-info-monitor-deselected')).toBeInTheDocument();
        });

        it('toggles the overload from the popover checkbox', () => {
            const onToggleOverload = vi.fn();
            render(
                <SidebarSummary
                    {...overloadProps}
                    selectedOverloads={new Set(['LINE_X', 'LINE_Y'])}
                    onToggleOverload={onToggleOverload}
                />,
            );
            fireEvent.click(screen.getByTestId('sidebar-summary-overloads-bubble'));
            const popover = screen.getByTestId('overload-info-popover');
            const checkbox = within(popover).getByTestId('overload-info-toggle-LINE_X')
                .querySelector('input[type="checkbox"]') as HTMLInputElement;
            fireEvent.click(checkbox);
            expect(onToggleOverload).toHaveBeenCalledWith('LINE_X');
        });

        it('hides the monitor-deselected toggle when every overload is selected', () => {
            render(
                <SidebarSummary
                    {...overloadProps}
                    selectedOverloads={new Set(['LINE_X', 'LINE_Y'])}
                    onToggleMonitorDeselected={vi.fn()}
                />,
            );
            fireEvent.click(screen.getByTestId('sidebar-summary-overloads-bubble'));
            expect(screen.queryByTestId('overload-info-monitor-deselected')).not.toBeInTheDocument();
        });

        it('falls back to "None" for N-overloads when the list is empty', () => {
            render(<SidebarSummary {...overloadProps} />);
            fireEvent.click(screen.getByTestId('sidebar-summary-overloads-bubble'));
            const popover = screen.getByTestId('overload-info-popover');
            expect(popover.textContent).toMatch(/N Overloads:\s*None/);
        });
    });
});
