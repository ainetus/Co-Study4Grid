// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import AppSidebar from './AppSidebar';

describe('AppSidebar', () => {
    const baseProps = {
        selectedContingency: [] as string[],
        pendingContingency: [] as string[],
        branches: ['BRANCH_A', 'BRANCH_B'],
        nameMap: {} as Record<string, string>,
        n1LinesOverloaded: undefined as string[] | undefined,
        n1LinesOverloadedRho: undefined as number[] | undefined,
        selectedOverloads: undefined as Set<string> | null | undefined,
        onPendingContingencyChange: vi.fn(),
        onContingencyApply: vi.fn(),
        displayName: (id: string) => id,
        onContingencyZoom: vi.fn(),
        onOverloadClick: vi.fn(),
        children: <div data-testid="sidebar-children">FEED</div>,
    };

    it('renders the picker card by default and includes the children slot', () => {
        render(<AppSidebar {...baseProps} />);
        expect(screen.getByTestId('sidebar')).toBeInTheDocument();
        expect(screen.getByText('⚡ Select Contingency')).toBeInTheDocument();
        expect(screen.getByTestId('sidebar-children')).toBeInTheDocument();
    });

    it('hides the picker card when hideContingencyPicker is true', () => {
        render(
            <AppSidebar
                {...baseProps}
                selectedContingency={['BRANCH_A']}
                pendingContingency={['BRANCH_A']}
                hideContingencyPicker
            />,
        );
        expect(screen.queryByText('⚡ Select Contingency')).not.toBeInTheDocument();
        expect(screen.getByTestId('sidebar-children')).toBeInTheDocument();
    });

    it('omits the picker card when no branches are loaded yet', () => {
        render(<AppSidebar {...baseProps} branches={[]} />);
        expect(screen.queryByText('⚡ Select Contingency')).not.toBeInTheDocument();
    });

    describe('Collapse mode', () => {
        it('renders a thin strip with an expand button when collapsed=true', () => {
            const onToggleCollapsed = vi.fn();
            render(
                <AppSidebar
                    {...baseProps}
                    collapsed
                    onToggleCollapsed={onToggleCollapsed}
                />,
            );
            const sidebar = screen.getByTestId('sidebar');
            expect(sidebar).toHaveAttribute('data-collapsed', 'true');
            expect(screen.getByTestId('sidebar-expand-button')).toBeInTheDocument();
            // The picker card and the children-slot (feed) are NOT
            // rendered in collapsed mode — the strip is intentionally
            // bare so the visualization panel takes the freed width.
            expect(screen.queryByText('⚡ Select Contingency')).not.toBeInTheDocument();
            expect(screen.queryByTestId('sidebar-children')).not.toBeInTheDocument();
        });

        it('fires onToggleCollapsed when the expand button is clicked', () => {
            const onToggleCollapsed = vi.fn();
            render(
                <AppSidebar
                    {...baseProps}
                    collapsed
                    onToggleCollapsed={onToggleCollapsed}
                />,
            );
            fireEvent.click(screen.getByTestId('sidebar-expand-button'));
            expect(onToggleCollapsed).toHaveBeenCalledTimes(1);
        });

        it('renders the collapse caret in the expanded shell when onToggleCollapsed is wired', () => {
            const onToggleCollapsed = vi.fn();
            render(
                <AppSidebar
                    {...baseProps}
                    onToggleCollapsed={onToggleCollapsed}
                />,
            );
            const caret = screen.getByTestId('sidebar-collapse-button');
            expect(caret).toBeInTheDocument();
            fireEvent.click(caret);
            expect(onToggleCollapsed).toHaveBeenCalledTimes(1);
        });

        it('omits the collapse caret when no toggle handler is provided', () => {
            render(<AppSidebar {...baseProps} />);
            expect(screen.queryByTestId('sidebar-collapse-button')).not.toBeInTheDocument();
        });
    });

    describe('Forwarding to SidebarSummary', () => {
        it('passes the Clear handler and overload toggles through to the sticky banner', () => {
            const onClearContingency = vi.fn();
            const onToggleOverload = vi.fn();
            render(
                <AppSidebar
                    {...baseProps}
                    selectedContingency={['BRANCH_A']}
                    pendingContingency={['BRANCH_A']}
                    n1LinesOverloaded={['LINE_X']}
                    n1LinesOverloadedRho={[1.05]}
                    onClearContingency={onClearContingency}
                    onToggleOverload={onToggleOverload}
                />,
            );
            fireEvent.click(screen.getByTestId('sidebar-summary-clear'));
            expect(onClearContingency).toHaveBeenCalledTimes(1);
            fireEvent.doubleClick(screen.getByRole('button', { name: 'LINE_X' }));
            expect(onToggleOverload).toHaveBeenCalledWith('LINE_X');
        });
    });
});
