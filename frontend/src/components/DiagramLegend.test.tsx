// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DiagramLegend from './DiagramLegend';

describe('DiagramLegend', () => {
    it('renders a collapsed pill by default', () => {
        render(<DiagramLegend tabId="n" />);
        expect(screen.getByTestId('diagram-legend-pill-n')).toBeInTheDocument();
        expect(screen.queryByTestId('diagram-legend-n')).not.toBeInTheDocument();
    });

    it('expands to a panel on click', async () => {
        const user = userEvent.setup();
        render(<DiagramLegend tabId="n" />);
        await user.click(screen.getByTestId('diagram-legend-pill-n'));
        expect(screen.getByTestId('diagram-legend-n')).toBeInTheDocument();
        expect(screen.getByText('Overloaded line')).toBeInTheDocument();
    });

    it('explains the Loading % scale and names the changes by loading', async () => {
        const user = userEvent.setup();
        render(<DiagramLegend tabId="contingency" flowMetric="loading" />);
        await user.click(screen.getByTestId('diagram-legend-pill-contingency'));
        expect(screen.getByText('Loading below 50 %')).toBeInTheDocument();
        expect(screen.getByText('Loading 50 % \u2192 monitoring factor')).toBeInTheDocument();
        expect(screen.getByText('Loading \u2265 monitoring factor')).toBeInTheDocument();
        expect(screen.getByText('Loading up after change')).toBeInTheDocument();
        expect(screen.queryByText('Flow up after change')).toBeNull();
    });

    it('shows no loading scale in MW', async () => {
        const user = userEvent.setup();
        render(<DiagramLegend tabId="contingency" />);
        await user.click(screen.getByTestId('diagram-legend-pill-contingency'));
        expect(screen.queryByText('Loading below 50 %')).toBeNull();
        expect(screen.getByText('Flow up after change')).toBeInTheDocument();
    });

    it('hides the contingency entry on the N tab', async () => {
        const user = userEvent.setup();
        render(<DiagramLegend tabId="n" />);
        await user.click(screen.getByTestId('diagram-legend-pill-n'));
        expect(screen.queryByText('Contingency')).not.toBeInTheDocument();
    });

    it('shows the contingency entry on the N-1 tab', async () => {
        const user = userEvent.setup();
        render(<DiagramLegend tabId="contingency" />);
        await user.click(screen.getByTestId('diagram-legend-pill-contingency'));
        expect(screen.getByText('Contingency')).toBeInTheDocument();
        // Action target only relevant on the action tab.
        expect(screen.queryByText('Action target')).not.toBeInTheDocument();
    });

    it('shows the contingency AND action-target entries on the action tab', async () => {
        const user = userEvent.setup();
        render(<DiagramLegend tabId="action" />);
        await user.click(screen.getByTestId('diagram-legend-pill-action'));
        expect(screen.getByText('Contingency')).toBeInTheDocument();
        expect(screen.getByText('Action target')).toBeInTheDocument();
        expect(screen.getByText('Flow up after change')).toBeInTheDocument();
        expect(screen.getByText('Flow down after change')).toBeInTheDocument();
    });

    it('renders the voltage-level note when more than one voltage is present', async () => {
        const user = userEvent.setup();
        render(<DiagramLegend tabId="n" uniqueVoltages={[63, 225, 400]} />);
        await user.click(screen.getByTestId('diagram-legend-pill-n'));
        expect(screen.getByText('Voltage levels (kV)')).toBeInTheDocument();
    });

    it('mentions the VL-names toggle when names are hidden', async () => {
        const user = userEvent.setup();
        render(<DiagramLegend tabId="n" vlNamesHidden />);
        await user.click(screen.getByTestId('diagram-legend-pill-n'));
        expect(screen.getByText(/Voltage-level names are hidden/i)).toBeInTheDocument();
    });

    it('collapses back to a pill when the close button is clicked', async () => {
        const user = userEvent.setup();
        render(<DiagramLegend tabId="n" />);
        await user.click(screen.getByTestId('diagram-legend-pill-n'));
        await user.click(screen.getByLabelText('Hide diagram legend'));
        expect(screen.getByTestId('diagram-legend-pill-n')).toBeInTheDocument();
        expect(screen.queryByTestId('diagram-legend-n')).not.toBeInTheDocument();
    });
});
