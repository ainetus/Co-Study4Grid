// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

vi.mock('../utils/svgUtils', () => ({
    getActionTargetVoltageLevels: vi.fn(() => []),
    getActionTargetLines: vi.fn(() => []),
    isCouplingAction: vi.fn(() => false),
}));

import ActionCard from './ActionCard';
import { getActionTargetLines } from '../utils/svgUtils';
import type { ActionDetail, EdgeMeta, NodeMeta } from '../types';

describe('ActionCard', () => {
    const emptyTopo = { lines_ex_bus: {}, lines_or_bus: {}, gens_bus: {}, loads_bus: {} };

    const baseDetails: ActionDetail = {
        description_unitaire: 'Open line L1',
        rho_before: [1.05],
        rho_after: [0.85],
        max_rho: 0.85,
        max_rho_line: 'LINE_A',
        is_rho_reduction: true,
        action_topology: emptyTopo,
    };

    const defaultProps = {
        id: 'act_1',
        details: baseDetails,
        index: 0,
        isViewing: false,
        isSelected: false,
        isRejected: false,
        linesOverloaded: ['LINE_A'],
        monitoringFactor: 0.95,
        nodesByEquipmentId: null,
        edgesByEquipmentId: null,
        cardEditMw: {} as Record<string, string>,
        cardEditTap: {} as Record<string, string>,
        resimulating: null,
        onActionSelect: vi.fn(),
        onActionFavorite: vi.fn(),
        onActionReject: vi.fn(),
        onAssetClick: vi.fn(),
        onVlDoubleClick: vi.fn(),
        onCardEditMwChange: vi.fn(),
        onCardEditTapChange: vi.fn(),
        onResimulate: vi.fn(),
        onResimulateTap: vi.fn(),
    };

    it('renders the action card with index and id in the header', () => {
        render(<ActionCard {...defaultProps} />);
        expect(screen.getByTestId('action-card-act_1')).toBeInTheDocument();
        expect(screen.getByText(/^#1/)).toBeInTheDocument();
    });

    it('shows the description right under the title — one line at rest', () => {
        render(<ActionCard {...defaultProps} />);
        const desc = screen.getByTestId('action-card-act_1-description');
        expect(desc).toHaveTextContent('Open line L1');
        expect(desc).toHaveStyle({ whiteSpace: 'nowrap' });
        const title = screen.getByRole('heading', { level: 4 });
        const follows = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
        expect(follows(title, desc)).toBe(true);
        expect(follows(desc, screen.getByTestId('action-card-act_1-loading'))).toBe(true);
    });

    it('reveals the description and disclosure region when viewing', () => {
        render(<ActionCard {...defaultProps} isViewing={true} />);
        expect(screen.getByText('Open line L1')).toBeInTheDocument();
        expect(screen.getByTestId('action-card-act_1-disclosure')).toBeInTheDocument();
    });

    it('displays action index and id in header', () => {
        render(<ActionCard {...defaultProps} index={2} />);
        expect(screen.getByText(/^#3/)).toBeInTheDocument();
    });

    // The severity badge is an icon-only pictogram; its wording lives in
    // the `title` (hover tooltip) / `aria-label`, not as visible text.
    it('shows "Solves overload" severity tooltip when max_rho is below monitoring factor', () => {
        render(<ActionCard {...defaultProps} />);
        expect(screen.getByTitle('Solves overload')).toBeInTheDocument();
    });

    it('shows "Still overloaded" severity tooltip when max_rho exceeds monitoring factor', () => {
        const details = { ...baseDetails, max_rho: 0.98, is_rho_reduction: true };
        render(<ActionCard {...defaultProps} details={details} />);
        expect(screen.getByTitle('Still overloaded')).toBeInTheDocument();
    });

    it('shows "Solved — low margin" severity tooltip when max_rho is close to monitoring factor', () => {
        const details = { ...baseDetails, max_rho: 0.92 };
        render(<ActionCard {...defaultProps} details={details} />);
        expect(screen.getByTitle(/Solved.*low margin/)).toBeInTheDocument();
    });

    it('shows "divergent" severity tooltip for non-convergence actions', () => {
        const details = { ...baseDetails, non_convergence: 'AC did not converge' };
        render(<ActionCard {...defaultProps} details={details} />);
        expect(screen.getByTitle('divergent')).toBeInTheDocument();
        expect(screen.getByText(/LoadFlow failure/)).toBeInTheDocument();
    });

    it('shows "islanded" severity tooltip for islanded actions', () => {
        const details = { ...baseDetails, is_islanded: true, disconnected_mw: 12.5 };
        render(<ActionCard {...defaultProps} details={details} />);
        expect(screen.getByTitle('islanded')).toBeInTheDocument();
        expect(screen.getByText(/12\.5 MW disconnected/)).toBeInTheDocument();
    });

    it('surfaces persistent pre-existing N overloads with an explanatory bubble', () => {
        const details = { ...baseDetails, persistent_n_overloads: ['DARSEL61RASSU', 'FESSEL61VOGEL'] };
        render(<ActionCard {...defaultProps} details={details} />);
        const bubble = screen.getByTestId('action-card-act_1-persistent-n');
        expect(bubble).toBeInTheDocument();
        expect(bubble).toHaveTextContent(/2 pre-existing N overloads persist/);
        expect(bubble.getAttribute('title')).toContain('DARSEL61RASSU');
    });

    it('omits the persistent-N bubble when there are none', () => {
        render(<ActionCard {...defaultProps} details={{ ...baseDetails, persistent_n_overloads: [] }} />);
        expect(screen.queryByTestId('action-card-act_1-persistent-n')).not.toBeInTheDocument();
    });

    it('marks the card with data-viewing="true" when isViewing is true', () => {
        // The viewing-state signal is now a higher-saturation left-edge
        // accent stripe + a `data-viewing` attribute on the card root,
        // not the old vertical "VIEWING" ribbon.  Replacing the ribbon
        // was the largest scannability win in the progressive-disclosure
        // pass (docs/proposals/ui-design-critique.md, recommendation 2).
        render(<ActionCard {...defaultProps} isViewing={true} />);
        expect(screen.getByTestId('action-card-act_1')).toHaveAttribute('data-viewing', 'true');
        expect(screen.queryByText('VIEWING')).not.toBeInTheDocument();
    });

    it('marks the card with data-viewing="false" when isViewing is false', () => {
        render(<ActionCard {...defaultProps} isViewing={false} />);
        expect(screen.getByTestId('action-card-act_1')).toHaveAttribute('data-viewing', 'false');
        expect(screen.queryByText('VIEWING')).not.toBeInTheDocument();
    });

    it('does not render the disclosure region when isViewing is false', () => {
        render(<ActionCard {...defaultProps} isViewing={false} />);
        expect(screen.queryByTestId('action-card-act_1-disclosure')).not.toBeInTheDocument();
    });

    it('hosts the star/reject buttons in a hover-revealed rail (always present in DOM)', () => {
        // The rail's visibility is controlled by CSS (`.action-card-rail`
        // → opacity 0/1 driven by :hover and .is-viewing on the card).
        // The buttons remain in the DOM at all times so keyboard /
        // automation users can reach them.
        const { container } = render(<ActionCard {...defaultProps} />);
        const rail = container.querySelector('.action-card-rail');
        expect(rail).not.toBeNull();
        expect(screen.getByTitle('Select this action')).toBeInTheDocument();
        expect(screen.getByTitle('Reject this action')).toBeInTheDocument();
    });

    it('puts the severity in its own column, then the title row with the star/reject rail at its right', () => {
        // Structural spec: column 1 is the severity pictogram the eye
        // scans down the feed; column 2 holds everything else, starting
        // with the title row (title, then the hover-revealed rail).
        const { container } = render(<ActionCard {...defaultProps} />);
        const card = container.querySelector('[data-testid="action-card-act_1"]')!;
        expect(card.children[0]).toBe(screen.getByTestId('action-card-act_1-severity'));
        const headerRow = (card.children[1] as HTMLElement).children[0] as HTMLElement;
        expect(headerRow.children[0].tagName).toBe('H4');
        const rail = headerRow.querySelector('.action-card-rail');
        expect(rail).not.toBeNull();
        expect(headerRow.children[1]).toBe(rail);
    });

    it('calls onActionSelect when card is clicked', () => {
        const onActionSelect = vi.fn();
        render(<ActionCard {...defaultProps} onActionSelect={onActionSelect} />);
        fireEvent.click(screen.getByTestId('action-card-act_1'));
        expect(onActionSelect).toHaveBeenCalledWith('act_1');
    });

    it('shows star button when action is not selected', () => {
        render(<ActionCard {...defaultProps} isSelected={false} />);
        expect(screen.getByTitle('Select this action')).toBeInTheDocument();
    });

    it('hides star button when action is already selected', () => {
        render(<ActionCard {...defaultProps} isSelected={true} />);
        expect(screen.queryByTitle('Select this action')).not.toBeInTheDocument();
    });

    it('shows reject button when action is not rejected', () => {
        render(<ActionCard {...defaultProps} isRejected={false} />);
        expect(screen.getByTitle('Reject this action')).toBeInTheDocument();
    });

    it('hides reject button when action is already rejected', () => {
        render(<ActionCard {...defaultProps} isRejected={true} />);
        expect(screen.queryByTitle('Reject this action')).not.toBeInTheDocument();
    });

    it('calls onActionFavorite when star button is clicked', () => {
        const onActionFavorite = vi.fn();
        render(<ActionCard {...defaultProps} onActionFavorite={onActionFavorite} />);
        fireEvent.click(screen.getByTitle('Select this action'));
        expect(onActionFavorite).toHaveBeenCalledWith('act_1');
    });

    it('calls onActionReject when reject button is clicked', () => {
        const onActionReject = vi.fn();
        render(<ActionCard {...defaultProps} onActionReject={onActionReject} />);
        fireEvent.click(screen.getByTitle('Reject this action'));
        expect(onActionReject).toHaveBeenCalledWith('act_1');
    });

    it('displays max loading percentage and line name', () => {
        render(<ActionCard {...defaultProps} />);
        // The gauge pictogram replaces the "Max loading:" label; its
        // tooltip recalls what the figure is.
        expect(screen.getByTitle(/^Max loading — the highest line loading/)).toHaveTextContent('85.0%');
        expect(screen.getAllByTitle('Zoom to LINE_A').length).toBeGreaterThan(0);
    });

    it('clicks on the max-loading line name zoom the new worst line, not the pre-action overload', () => {
        // Regression: the action re-distributes flows and the new worst
        // line (LINE_B) is NOT in linesOverloaded (which reflects the
        // pre-action N-1 overloads — only LINE_A here). Clicking
        // "LINE_B" in the "Max loading: X% on LINE_B" row must zoom on
        // LINE_B, not on any of the pre-action lines.
        const onAssetClick = vi.fn();
        const details: ActionDetail = {
            ...baseDetails,
            rho_before: [1.05],
            rho_after: [0.72],     // LINE_A is now below the limit
            max_rho: 0.967,        // but LINE_B (newly overloaded) peaks at 96.7%
            max_rho_line: 'LINE_B',
            is_rho_reduction: true,
        };
        render(
            <ActionCard
                {...defaultProps}
                details={details}
                linesOverloaded={['LINE_A']}
                onAssetClick={onAssetClick}
            />
        );

        // The displayed text must mention the new worst line
        expect(screen.getByText('96.7%')).toBeInTheDocument();

        // Click specifically the "on LINE_B" button inside the Max
        // loading row — not the rho_after button (which would be on
        // LINE_A) and not any sticky-panel button (not in this test).
        const maxRhoButton = screen.getByTitle('Zoom to LINE_B');
        fireEvent.click(maxRhoButton);

        expect(onAssetClick).toHaveBeenCalledTimes(1);
        expect(onAssetClick).toHaveBeenCalledWith('act_1', 'LINE_B', 'action');
    });

    // The action moved the worst loading to LINE_B: the overloaded LINE_A
    // gets a row of its own.
    const movedMax: ActionDetail = { ...baseDetails, max_rho: 0.9, max_rho_line: 'LINE_B' };

    it('shows the overloads after the action on the viewing card only, grouped with the max loading', () => {
        // At rest the per-card max ρ% summary stands alone; the viewing
        // card adds the per-line breakdown IN THE SAME loading group (same
        // kind of information). "Loading before" stays in the sticky
        // Overloads panel and never appears on the card.
        const { rerender } = render(<ActionCard {...defaultProps} details={movedMax} />);
        expect(screen.queryByTestId('action-card-act_1-after')).not.toBeInTheDocument();
        expect(screen.queryByText(/loading before/i)).not.toBeInTheDocument();

        rerender(<ActionCard {...defaultProps} details={movedMax} isViewing={true} />);
        const after = screen.getByTestId('action-card-act_1-after');
        expect(screen.getByTestId('action-card-act_1-loading')).toContainElement(after);
        expect(after).toHaveTextContent(/85\.0%\s*LINE_A/);
        expect(screen.getByTitle(/^Loading after this action of the lines the contingency overloads/)).toBeInTheDocument();
        expect(screen.queryByText(/loading before/i)).not.toBeInTheDocument();
    });

    it('reads the rate first, then the line, in both loading rows', () => {
        render(<ActionCard {...defaultProps} details={movedMax} isViewing={true} />);
        const rows = [screen.getByTitle(/^Max loading/), screen.getByTestId('action-card-act_1-after')];
        expect(rows[0]).toHaveTextContent(/90\.0%\s*LINE_B/);
        expect(rows[1]).toHaveTextContent(/85\.0%\s*LINE_A/);
        for (const row of rows) {
            const rate = row.querySelector('strong')!;
            const line = row.querySelector('button')!;
            expect(rate.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        }
    });

    it('does not repeat the overloaded line when it is still the most loaded one', () => {
        // max_rho_line LINE_A at 85 % is the overloaded LINE_A at 85 %:
        // the max-loading row says it all, with a light mention.
        render(<ActionCard {...defaultProps} isViewing={true} />);
        expect(screen.queryByTestId('action-card-act_1-after')).not.toBeInTheDocument();
        const mention = screen.getByTestId('action-card-act_1-still-max');
        expect(mention).toHaveTextContent('still the most loaded');
        expect(mention).toHaveAttribute('title', expect.stringMatching(/^The line the contingency overloads is still the most loaded/));
        expect(screen.getByTitle(/^Max loading/)).toHaveTextContent(/85\.0%\s*LINE_A/);
    });

    it('keeps the other overloads when the most loaded line is one of them', () => {
        const details: ActionDetail = { ...baseDetails, rho_after: [0.85, 0.6], max_rho: 0.85, max_rho_line: 'LINE_A' };
        render(<ActionCard {...defaultProps} details={details} linesOverloaded={['LINE_A', 'LINE_C']} isViewing={true} />);
        const after = screen.getByTestId('action-card-act_1-after');
        expect(after).toHaveTextContent(/60\.0%\s*LINE_C/);
        expect(after).not.toHaveTextContent('LINE_A');
        expect(screen.getByTestId('action-card-act_1-still-max')).toBeInTheDocument();
    });

    it('mentions nothing on a card at rest', () => {
        render(<ActionCard {...defaultProps} />);
        expect(screen.queryByTestId('action-card-act_1-still-max')).not.toBeInTheDocument();
    });

    it('renders the source / provenance row last, below the overloads after the action', () => {
        // Operator-requested layout: the source is a low-information
        // attribution row, so it sits at the very bottom of the unfolded
        // card — below the operational fields (description, loading group,
        // per-line editors).
        const details: ActionDetail = {
            ...movedMax,
            origin: 'user',
        };
        render(<ActionCard {...defaultProps} details={details} isViewing={true} />);
        const after = screen.getByTestId('action-card-act_1-after');
        const origin = screen.getByTestId('action-card-act_1-origin');
        expect(after.compareDocumentPosition(origin) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('renders load shedding details with MW input and re-simulate button when viewing', () => {
        const details: ActionDetail = {
            ...baseDetails,
            load_shedding_details: [
                { load_name: 'LOAD_X', voltage_level_id: 'VL1', shedded_mw: 5.0 }
            ],
        };
        render(<ActionCard {...defaultProps} details={details} isViewing={true} />);
        expect(screen.getByText(/Shedding on/)).toBeInTheDocument();
        expect(within(screen.getByTestId('action-card-act_1-disclosure')).getByText('LOAD_X')).toBeInTheDocument();
        expect(screen.getByTestId('edit-mw-act_1')).toBeInTheDocument();
        expect(screen.getByTestId('resimulate-act_1')).toBeInTheDocument();
    });

    it('hides the load shedding editor at rest (progressive disclosure)', () => {
        const details: ActionDetail = {
            ...baseDetails,
            load_shedding_details: [
                { load_name: 'LOAD_X', voltage_level_id: 'VL1', shedded_mw: 5.0 }
            ],
        };
        render(<ActionCard {...defaultProps} details={details} isViewing={false} />);
        expect(screen.queryByText(/Shedding on/)).not.toBeInTheDocument();
        expect(screen.queryByTestId('edit-mw-act_1')).not.toBeInTheDocument();
    });

    it('renders curtailment details with MW input and re-simulate button when viewing', () => {
        const details: ActionDetail = {
            ...baseDetails,
            curtailment_details: [
                { gen_name: 'GEN_Y', voltage_level_id: 'VL2', curtailed_mw: 3.0 }
            ],
        };
        render(<ActionCard {...defaultProps} details={details} isViewing={true} />);
        expect(screen.getByText(/Curtailment on/)).toBeInTheDocument();
        expect(within(screen.getByTestId('action-card-act_1-disclosure')).getByText('GEN_Y')).toBeInTheDocument();
        expect(screen.getByTestId('edit-mw-act_1')).toBeInTheDocument();
    });

    it('renders redispatch details with signed-delta MW input when viewing', () => {
        const details: ActionDetail = {
            ...baseDetails,
            redispatch_details: [
                { gen_name: 'THERM_1', voltage_level_id: 'VL3', delta_mw: 10.0, target_mw: 40.0, direction: 'up' }
            ],
        };
        render(<ActionCard {...defaultProps} details={details} isViewing={true} />);
        expect(screen.getByText(/Redispatch on/)).toBeInTheDocument();
        expect(within(screen.getByTestId('action-card-act_1-disclosure')).getByText('THERM_1')).toBeInTheDocument();
        expect(screen.getByTestId('edit-mw-act_1')).toBeInTheDocument();
        expect(screen.getByTestId('resimulate-act_1')).toBeInTheDocument();
    });

    it('passes the signed delta (incl. negative) to onResimulate for redispatch', () => {
        const onResimulate = vi.fn();
        const details: ActionDetail = {
            ...baseDetails,
            redispatch_details: [
                { gen_name: 'THERM_1', voltage_level_id: 'VL3', delta_mw: -10.0, target_mw: 20.0, direction: 'down' }
            ],
        };
        render(<ActionCard {...defaultProps} details={details} isViewing={true} onResimulate={onResimulate} />);
        fireEvent.click(screen.getByTestId('resimulate-act_1'));
        expect(onResimulate).toHaveBeenCalledWith('act_1', -10.0);
    });

    it('renders a clickable VL chip for a redispatch action on the unfolded card (zoom + SLD)', () => {
        const onVlDoubleClick = vi.fn();
        const details: ActionDetail = {
            ...baseDetails,
            redispatch_details: [
                { gen_name: 'THERM_1', voltage_level_id: 'VL_BIEST', delta_mw: 10.0, target_mw: 40.0, direction: 'up' }
            ],
        };
        render(<ActionCard {...defaultProps} details={details} isViewing onVlDoubleClick={onVlDoubleClick} />);
        const chip = screen.getByText('VL_BIEST');
        expect(chip).toBeInTheDocument();
        fireEvent.doubleClick(chip);
        expect(onVlDoubleClick).toHaveBeenCalledWith('act_1', 'VL_BIEST');
    });

    it('shows the max-raise headroom and clamps the delta to it on re-simulate', () => {
        const onResimulate = vi.fn();
        const details: ActionDetail = {
            ...baseDetails,
            redispatch_details: [
                { gen_name: 'THERM_1', voltage_level_id: 'VL3', delta_mw: 10.0, target_mw: 40.0,
                  direction: 'up', current_mw: 30, max_raise_mw: 25, max_lower_mw: 30 }
            ],
        };
        render(<ActionCard {...defaultProps} details={details} isViewing={true}
            onResimulate={onResimulate} cardEditMw={{ act_1: '999' }} />);
        expect(screen.getByText(/max raise: 25 MW/)).toBeInTheDocument();
        fireEvent.click(screen.getByTestId('resimulate-act_1'));
        // 999 requested but clamped to the 25 MW raise headroom.
        expect(onResimulate).toHaveBeenCalledWith('act_1', 25);
    });

    // Evacuation-antenna aggregates (curtail_<antenna_id> / redispatch_<antenna_id>)
    // act on several generators: ONE editor on the total, which the backend
    // spreads pro rata — not one input per generator sharing a single value.
    it('edits a multi-generator curtailment as one total', () => {
        const onResimulate = vi.fn();
        const details: ActionDetail = {
            ...baseDetails,
            curtailment_details: [
                { gen_name: 'WIND_A', voltage_level_id: 'VL_A', curtailed_mw: 9.0 },
                { gen_name: 'WIND_B', voltage_level_id: 'VL_B', curtailed_mw: 3.0 },
            ],
        };
        render(<ActionCard {...defaultProps} details={details} isViewing={true} onResimulate={onResimulate} />);
        expect(screen.getAllByText(/Curtailment on/)).toHaveLength(1);
        const disclosure = within(screen.getByTestId('action-card-act_1-disclosure'));
        expect(disclosure.getByText('WIND_A')).toBeInTheDocument();
        expect(disclosure.getByText('WIND_B')).toBeInTheDocument();
        expect(screen.getByTestId('edit-mw-act_1')).toHaveValue(12);
        fireEvent.click(screen.getByTestId('resimulate-act_1'));
        expect(onResimulate).toHaveBeenCalledWith('act_1', 12);
    });

    it('sums a multi-generator redispatch delta and its headroom', () => {
        const onResimulate = vi.fn();
        const details: ActionDetail = {
            ...baseDetails,
            redispatch_details: [
                { gen_name: 'CCG_A', voltage_level_id: 'VL_A', delta_mw: 5.0, target_mw: 105.0,
                  direction: 'up', max_raise_mw: 15, max_lower_mw: 100 },
                { gen_name: 'CCG_B', voltage_level_id: 'VL_B', delta_mw: 15.0, target_mw: 65.0,
                  direction: 'up', max_raise_mw: 45, max_lower_mw: 50 },
            ],
        };
        render(<ActionCard {...defaultProps} details={details} isViewing={true}
            onResimulate={onResimulate} cardEditMw={{ act_1: '999' }} />);
        expect(screen.getAllByText(/Redispatch on/)).toHaveLength(1);
        expect(screen.getByText(/max raise: 60 MW/)).toBeInTheDocument();
        fireEvent.click(screen.getByTestId('resimulate-act_1'));
        // Clamped to the generators' summed raise headroom.
        expect(onResimulate).toHaveBeenCalledWith('act_1', 60);
    });

    it('renders PST details with tap input and re-simulate button when viewing', () => {
        const details: ActionDetail = {
            ...baseDetails,
            pst_details: [
                { pst_name: 'PST_Z', tap_position: 5, low_tap: -10, high_tap: 10 }
            ],
        };
        render(<ActionCard {...defaultProps} details={details} isViewing={true} />);
        expect(screen.getByText('PST_Z')).toBeInTheDocument();
        expect(screen.getByTestId('edit-tap-act_1')).toBeInTheDocument();
        expect(screen.getByText('[-10..10]')).toBeInTheDocument();
    });

    it('shows the tap the PST starts from beside the tap the action sets', () => {
        const details: ActionDetail = {
            ...baseDetails,
            pst_details: [
                { pst_name: 'PST_Z', tap_position: 29, low_tap: 0, high_tap: 32, tap_start: 24 }
            ],
        };
        render(<ActionCard {...defaultProps} details={details} isViewing={true} />);
        const start = screen.getByTestId('action-card-act_1-tap-start');
        expect(start).toHaveTextContent('start 24');
        expect(start).toHaveAttribute('title', expect.stringContaining('before the action'));
        // The editable input still holds the tap the action sets.
        expect(screen.getByTestId('edit-tap-act_1')).toHaveValue(29);
    });

    it('keeps a start tap of 0, and shows none when the backend sent none', () => {
        const withStart = (tap_start?: number | null): ActionDetail => ({
            ...baseDetails,
            pst_details: [{ pst_name: 'PST_Z', tap_position: 5, low_tap: -10, high_tap: 10, tap_start }],
        });
        const { rerender } = render(<ActionCard {...defaultProps} details={withStart(0)} isViewing={true} />);
        expect(screen.getByTestId('action-card-act_1-tap-start')).toHaveTextContent('start 0');
        rerender(<ActionCard {...defaultProps} details={withStart(undefined)} isViewing={true} />);
        expect(screen.queryByTestId('action-card-act_1-tap-start')).toBeNull();
        rerender(<ActionCard {...defaultProps} details={withStart(null)} isViewing={true} />);
        expect(screen.queryByTestId('action-card-act_1-tap-start')).toBeNull();
    });

    it('calls onResimulate when load shedding re-simulate is clicked', () => {
        const onResimulate = vi.fn();
        const details: ActionDetail = {
            ...baseDetails,
            load_shedding_details: [
                { load_name: 'LOAD_X', voltage_level_id: 'VL1', shedded_mw: 5.0 }
            ],
        };
        render(<ActionCard {...defaultProps} details={details} isViewing={true} onResimulate={onResimulate} />);
        fireEvent.click(screen.getByTestId('resimulate-act_1'));
        expect(onResimulate).toHaveBeenCalledWith('act_1', 5.0);
    });

    it('calls onResimulateTap when PST re-simulate is clicked', () => {
        const onResimulateTap = vi.fn();
        const details: ActionDetail = {
            ...baseDetails,
            pst_details: [
                { pst_name: 'PST_Z', tap_position: 5, low_tap: -10, high_tap: 10 }
            ],
        };
        render(<ActionCard {...defaultProps} details={details} isViewing={true} onResimulateTap={onResimulateTap} />);
        fireEvent.click(screen.getByTestId('resimulate-tap-act_1'));
        expect(onResimulateTap).toHaveBeenCalledWith('act_1', 5);
    });

    it('shows "Simulating..." on re-simulate button when resimulating matches id', () => {
        const details: ActionDetail = {
            ...baseDetails,
            load_shedding_details: [
                { load_name: 'LOAD_X', voltage_level_id: 'VL1', shedded_mw: 5.0 }
            ],
        };
        render(<ActionCard {...defaultProps} details={details} isViewing={true} resimulating="act_1" />);
        expect(screen.getByText('Simulating...')).toBeInTheDocument();
    });

    it('calls onCardEditMwChange when MW input value changes', () => {
        const onCardEditMwChange = vi.fn();
        const details: ActionDetail = {
            ...baseDetails,
            load_shedding_details: [
                { load_name: 'LOAD_X', voltage_level_id: 'VL1', shedded_mw: 5.0 }
            ],
        };
        render(<ActionCard {...defaultProps} details={details} isViewing={true} onCardEditMwChange={onCardEditMwChange} />);
        fireEvent.change(screen.getByTestId('edit-mw-act_1'), { target: { value: '7.5' } });
        expect(onCardEditMwChange).toHaveBeenCalledWith('act_1', '7.5');
    });

    it('shows "No reduction" severity tooltip when is_rho_reduction is false', () => {
        const details = { ...baseDetails, max_rho: 1.1, is_rho_reduction: false };
        render(<ActionCard {...defaultProps} details={details} />);
        expect(screen.getByTitle('No reduction')).toBeInTheDocument();
    });

    // Regression: for a combined action like
    // ``load_shedding_BEON3 TR311+reco_GEN.PY762``, the card used to
    // render ONLY the load-shedding voltage level as a clickable badge
    // and drop the reco's line because an ``if (isLoadShedding) { …
    // return } else { topology-based extraction }`` short-circuit
    // skipped the topology branch whenever load-shedding details were
    // present. Both sub-actions must now produce a badge. Same
    // expectation holds for ``curtailment + reco`` and for pairs where
    // one leg is a disco / coupling.
    it('renders both load-shedding VL and reco line for combined LS+reco action', () => {
        const details: ActionDetail = {
            ...baseDetails,
            load_shedding_details: [
                { load_name: 'BEON3 TR311', voltage_level_id: 'BEON3', shedded_mw: 6.4 },
            ],
            action_topology: {
                lines_ex_bus: { 'GEN.PY762': 1 },
                lines_or_bus: {},
                gens_bus: {},
                loads_bus: {},
            },
        };
        render(
            <ActionCard
                {...defaultProps}
                id="load_shedding_BEON3 TR311+reco_GEN.PY762"
                details={details}
                isViewing
            />
        );
        // Both sub-actions' impacted assets must be clickable.
        expect(screen.getByRole('button', { name: 'BEON3' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'GEN.PY762' })).toBeInTheDocument();
    });

    it('renders both curtailment VL and reco line for combined RC+reco action', () => {
        const details: ActionDetail = {
            ...baseDetails,
            curtailment_details: [
                { gen_name: 'WIND_A', voltage_level_id: 'VL_WIND', curtailed_mw: 42.0 },
            ],
            action_topology: {
                lines_ex_bus: {},
                lines_or_bus: { 'LINE_R': 1 },
                gens_bus: {},
                loads_bus: {},
            },
        };
        render(
            <ActionCard
                {...defaultProps}
                id="curtail_WIND_A+reco_LINE_R"
                details={details}
                isViewing
            />
        );
        expect(screen.getByRole('button', { name: 'VL_WIND' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'LINE_R' })).toBeInTheDocument();
    });

    // The unfolded card shows where the action came from — "user"
    // (manual simulation) or the recommender model that produced it.
    describe('origin / "Source" row', () => {
        const models = [
            { name: 'expert', label: 'Expert system', requires_overflow_graph: true, is_default: true, params: [] },
            { name: 'random_overflow', label: 'Random (post overflow analysis)', requires_overflow_graph: true, is_default: false, params: [] },
        ];

        it('shows "Manual simulation (user)" for a user-originated action when viewing', () => {
            const details = { ...baseDetails, origin: 'user' };
            render(<ActionCard {...defaultProps} details={details} isViewing availableModels={models} />);
            expect(screen.getByTestId('action-card-act_1-origin'))
                .toHaveTextContent('Manual simulation (user)');
            expect(screen.getByTitle('Source: Manual simulation (user)')).toBeInTheDocument();
        });

        it('resolves a model id to its label for a recommender-originated action', () => {
            const details = { ...baseDetails, origin: 'random_overflow' };
            render(<ActionCard {...defaultProps} details={details} isViewing availableModels={models} />);
            expect(screen.getByTitle('Source: Random (post overflow analysis)'))
                .toHaveTextContent('Random (post overflow analysis)');
        });

        it('falls back to the raw origin id when no model matches', () => {
            const details = { ...baseDetails, origin: 'ml_policy_v9' };
            render(<ActionCard {...defaultProps} details={details} isViewing availableModels={models} />);
            expect(screen.getByTitle('Source: ml_policy_v9')).toHaveTextContent('ml_policy_v9');
        });

        it('shows no source when origin is absent — only the action id', () => {
            // baseDetails has no `origin` — legacy / un-tracked actions.
            render(<ActionCard {...defaultProps} isViewing availableModels={models} />);
            expect(screen.queryByTitle(/^Source:/)).not.toBeInTheDocument();
            expect(screen.getByTestId('action-card-act_1-origin')).toHaveTextContent('act_1');
        });

        it('does not render the Source row on a folded (non-viewing) card', () => {
            const details = { ...baseDetails, origin: 'user' };
            render(<ActionCard {...defaultProps} details={details} isViewing={false} availableModels={models} />);
            expect(screen.queryByTestId('action-card-act_1-origin')).not.toBeInTheDocument();
        });
    });

    // The redesign names what an action acts on instead of its raw id —
    // see docs/features/action-card.md.
    describe('readable names', () => {
        const names: Record<string, string> = {
            LINE_W: 'MANDAL71WARAN',
            VL_M: 'MANDARINS 400kV',
            X_GB: 'Exchange with GB',
            LINE_A: 'ATTAQL61MANDA',
            LOAD_M: 'Load — MANDARINS 400kV',
            GEN_S: 'WARANDE 400kV Solar',
            GEN_P: 'Blayais 1',
        };
        const displayName = (id: string) => names[id] ?? id;

        it('titles the card with the names of the elements it acts on, the raw id on hover', () => {
            const onAssetClick = vi.fn();
            const details: ActionDetail = {
                ...baseDetails,
                description_unitaire: "Ouverture de la ligne 'LINE_W'",
                action_topology: { ...emptyTopo, lines_or_bus: { LINE_W: -1 }, lines_ex_bus: { LINE_W: -1 } },
            };
            render(<ActionCard {...defaultProps} id="disco_LINE_W" details={details}
                displayName={displayName} onAssetClick={onAssetClick} />);
            const title = screen.getByRole('heading', { level: 4 });
            expect(title).toHaveAttribute('title', 'disco_LINE_W');
            expect(title).toHaveTextContent('Branch - MANDAL71WARAN');
            expect(title).not.toHaveTextContent('disco_LINE_W');
            // A name in the title is a link: click → zoom on that element.
            fireEvent.click(within(title).getByRole('button', { name: 'MANDAL71WARAN' }));
            expect(onAssetClick).toHaveBeenCalledWith('disco_LINE_W', 'LINE_W', 'action');
        });

        it('titles a manual SLD manoeuvre with its voltage level — double-click opens its SLD', () => {
            const onVlDoubleClick = vi.fn();
            const details: ActionDetail = {
                ...baseDetails,
                description_unitaire: 'Manoeuvre manuelle sur MANDARINS 400kV: disjoncteur MANDAL71WARAN ouvert',
                origin: 'user',
            };
            render(<ActionCard {...defaultProps} id="user_topo_VL_M_1795338763679" details={details}
                displayName={displayName} onVlDoubleClick={onVlDoubleClick} />);
            const title = screen.getByRole('heading', { level: 4 });
            const vl = within(title).getByRole('button', { name: 'MANDARINS 400kV' });
            fireEvent.doubleClick(vl);
            expect(onVlDoubleClick).toHaveBeenCalledWith('user_topo_VL_M_1795338763679', 'VL_M');
            expect(title).toHaveTextContent('Substation - MANDARINS 400kV');
            expect(title).not.toHaveTextContent('user_topo');
        });

        it('reads the ids of a description by their names, the raw text on the viewing card hover', () => {
            const details: ActionDetail = {
                ...baseDetails,
                description_unitaire: "Effacement 'X_GB' ('VL_M')",
            };
            render(<ActionCard {...defaultProps} details={details} displayName={displayName} isViewing />);
            const desc = screen.getByTestId('action-card-act_1-description');
            expect(desc).toHaveTextContent("Effacement 'Exchange with GB' ('MANDARINS 400kV')");
            expect(desc).toHaveAttribute('title', "Effacement 'X_GB' ('VL_M')");
        });

        it('names a shed load in the title and its voltage level once, as a location chip', () => {
            const details: ActionDetail = {
                ...baseDetails,
                load_shedding_details: [{ load_name: 'X_GB', voltage_level_id: 'VL_M', shedded_mw: 120 }],
            };
            render(<ActionCard {...defaultProps} id="load_shedding_X_GB" details={details} displayName={displayName} isViewing />);
            const title = screen.getByRole('heading', { level: 4 });
            expect(title).toHaveTextContent('Exchange - with GB');
            expect(title).not.toHaveTextContent('MANDARINS 400kV');
            const chip = screen.getByTitle(/^Where the action acts: MANDARINS 400kV \(VL_M\)/);
            expect(chip).toHaveTextContent('MANDARINS 400kV');
            expect(screen.getAllByText('MANDARINS 400kV')).toHaveLength(1);
        });

        it('puts the SLD chip at the end of the description row, not in the loading frame', () => {
            const onAssetClick = vi.fn();
            const onVlDoubleClick = vi.fn();
            const details: ActionDetail = {
                ...baseDetails,
                description_unitaire: 'Redispatch G1',
                redispatch_details: [{ gen_name: 'X_GB', voltage_level_id: 'VL_M', delta_mw: 10, target_mw: 60, direction: 'up' }],
            };
            render(<ActionCard {...defaultProps} id="redispatch_X_GB" details={details} displayName={displayName}
                isViewing onAssetClick={onAssetClick} onVlDoubleClick={onVlDoubleClick} />);
            const chip = screen.getByTestId('action-card-redispatch_X_GB-location-VL_M');
            expect(screen.getByTestId('action-card-redispatch_X_GB-how')).toContainElement(chip);
            expect(screen.getByTestId('action-card-redispatch_X_GB-loading')).not.toContainElement(chip);
            // After the description, on the same row.
            expect(screen.getByTestId('action-card-redispatch_X_GB-description').nextElementSibling).toBe(chip);
            fireEvent.click(chip);
            expect(onAssetClick).toHaveBeenCalledWith('redispatch_X_GB', 'VL_M', 'action');
            fireEvent.doubleClick(chip);
            expect(onVlDoubleClick).toHaveBeenCalledWith('redispatch_X_GB', 'VL_M');
        });

        it('gives a coupling action an SLD chip for its voltage level, after the description', () => {
            const onVlDoubleClick = vi.fn();
            const details: ActionDetail = {
                ...baseDetails,
                description_unitaire: "Ouverture du couplage dans le poste 'MANDARINS 400kV'",
                action_topology: { ...emptyTopo, voltage_level_id: 'VL_M' } as ActionDetail['action_topology'],
            };
            render(<ActionCard {...defaultProps} id="open_coupler_VL_M" details={details} displayName={displayName}
                isViewing onVlDoubleClick={onVlDoubleClick} />);
            const chip = screen.getByTestId('action-card-open_coupler_VL_M-location-VL_M');
            expect(chip).toHaveTextContent('MANDARINS 400kV');
            expect(screen.getByTestId('action-card-open_coupler_VL_M-description').nextElementSibling).toBe(chip);
            fireEvent.doubleClick(chip);
            expect(onVlDoubleClick).toHaveBeenCalledWith('open_coupler_VL_M', 'VL_M');
        });

        it('gives an opened transformer an SLD chip for each of its two voltage levels', () => {
            const nodes = new Map<string, NodeMeta>([
                ['VL_M', { equipmentId: 'VL_M', svgId: '1' } as NodeMeta],
                ['VL_N', { equipmentId: 'VL_N', svgId: '2' } as NodeMeta],
            ]);
            const edges = new Map<string, EdgeMeta>([
                ['T_W', { equipmentId: 'T_W', svgId: 'e1', node1: '1', node2: '2' } as EdgeMeta],
            ]);
            const details: ActionDetail = {
                ...baseDetails,
                description_unitaire: "Ouverture du transformateur 'T_W'",
                action_topology: { ...emptyTopo, lines_or_bus: { T_W: -1 }, lines_ex_bus: { T_W: -1 } },
            };
            // svgUtils is mocked here: tell the card which branch the metadata resolves.
            vi.mocked(getActionTargetLines).mockReturnValueOnce(['T_W']);
            render(<ActionCard {...defaultProps} id="disco_T_W" details={details} displayName={displayName}
                isViewing nodesByEquipmentId={nodes} edgesByEquipmentId={edges} />);
            expect(screen.getByTestId('action-card-disco_T_W-location-VL_M')).toHaveTextContent('MANDARINS 400kV');
            expect(screen.getByTestId('action-card-disco_T_W-location-VL_N')).toBeInTheDocument();
        });

        it('gives a line opening an SLD chip for each end of the line, once the metadata is there', () => {
            const nodes = new Map<string, NodeMeta>([
                ['VL_M', { equipmentId: 'VL_M', svgId: '1' } as NodeMeta],
                ['VL_N', { equipmentId: 'VL_N', svgId: '2' } as NodeMeta],
            ]);
            const edges = new Map<string, EdgeMeta>([
                ['LINE_W', { equipmentId: 'LINE_W', svgId: 'e1', node1: '1', node2: '2' } as EdgeMeta],
            ]);
            const details: ActionDetail = {
                ...baseDetails,
                description_unitaire: "Ouverture de la ligne 'LINE_W'",
                action_topology: { ...emptyTopo, lines_or_bus: { LINE_W: -1 }, lines_ex_bus: { LINE_W: -1 } },
            };
            vi.mocked(getActionTargetLines).mockReturnValueOnce(['LINE_W']);
            const { rerender } = render(<ActionCard {...defaultProps} id="disco_LINE_W" details={details}
                displayName={displayName} isViewing />);
            // No metadata yet: no chip, the title name stays a link.
            expect(screen.queryByTitle(/^Where the action acts/)).toBeNull();
            vi.mocked(getActionTargetLines).mockReturnValueOnce(['LINE_W']);
            rerender(<ActionCard {...defaultProps} id="disco_LINE_W" details={details} displayName={displayName}
                isViewing nodesByEquipmentId={nodes} edgesByEquipmentId={edges} />);
            expect(screen.getByTestId('action-card-disco_LINE_W-location-VL_M')).toHaveTextContent('MANDARINS 400kV');
            expect(screen.getByTestId('action-card-disco_LINE_W-location-VL_N')).toBeInTheDocument();
        });

        it('shows no SLD chip until the card is unfolded', () => {
            const details: ActionDetail = {
                ...baseDetails,
                description_unitaire: "Ouverture du couplage dans le poste 'MANDARINS 400kV'",
                action_topology: { ...emptyTopo, voltage_level_id: 'VL_M' } as ActionDetail['action_topology'],
            };
            const { rerender } = render(<ActionCard {...defaultProps} id="open_coupler_VL_M" details={details}
                displayName={displayName} />);
            expect(screen.queryByTestId('action-card-open_coupler_VL_M-location-VL_M')).toBeNull();
            expect(screen.queryByTitle(/^Where the action acts/)).toBeNull();
            // The description stays; the name stays a link in the title.
            expect(screen.getByTestId('action-card-open_coupler_VL_M-description')).toBeInTheDocument();
            expect(within(screen.getByRole('heading', { level: 4 })).getByRole('button', { name: 'MANDARINS 400kV' })).toBeInTheDocument();
            rerender(<ActionCard {...defaultProps} id="open_coupler_VL_M" details={details}
                displayName={displayName} isViewing />);
            expect(screen.getByTestId('action-card-open_coupler_VL_M-location-VL_M')).toBeInTheDocument();
        });

        it('leaves no empty description row at rest for an action whose only extra is its chip', () => {
            const details: ActionDetail = {
                ...baseDetails,
                description_unitaire: '',
                redispatch_details: [{ gen_name: 'GEN_S', voltage_level_id: 'VL_M', delta_mw: 10, target_mw: 60, direction: 'up' }],
            };
            const { rerender } = render(<ActionCard {...defaultProps} id="redispatch_GEN_S" details={details} displayName={displayName} />);
            expect(screen.queryByTestId('action-card-redispatch_GEN_S-how')).toBeNull();
            rerender(<ActionCard {...defaultProps} id="redispatch_GEN_S" details={details} displayName={displayName} isViewing />);
            expect(screen.getByTestId('action-card-redispatch_GEN_S-how')).toBeInTheDocument();
        });

        describe('title convention — the type first, then the name after a dash', () => {
            const titleOf = (id: string, details: ActionDetail) => {
                render(<ActionCard {...defaultProps} id={id} details={details} displayName={displayName} />);
                return screen.getByRole('heading', { level: 4 });
            };

            it('a coupling', () => {
                expect(titleOf('open_coupler_VL_M', {
                    ...baseDetails,
                    description_unitaire: "Ouverture du couplage dans le poste 'MANDARINS 400kV'",
                    action_topology: { ...emptyTopo, voltage_level_id: 'VL_M' } as ActionDetail['action_topology'],
                })).toHaveTextContent('Coupling - MANDARINS 400kV');
            });

            it('a shed load, without the noun its name restates', () => {
                expect(titleOf('load_shedding_LOAD_M', {
                    ...baseDetails,
                    load_shedding_details: [{ load_name: 'LOAD_M', voltage_level_id: 'VL_M', shedded_mw: 5 }],
                })).toHaveTextContent('Load - MANDARINS 400kV');
            });

            it('an exchange', () => {
                expect(titleOf('load_shedding_X_GB', {
                    ...baseDetails,
                    load_shedding_details: [{ load_name: 'X_GB', voltage_level_id: 'VL_M', shedded_mw: 5 }],
                })).toHaveTextContent('Exchange - with GB');
            });

            it('a curtailed solar plant, typed by its carrier', () => {
                const title = titleOf('curtail_GEN_S', {
                    ...baseDetails,
                    curtailment_details: [{ gen_name: 'GEN_S', voltage_level_id: 'VL_M', curtailed_mw: 30 }],
                });
                expect(title).toHaveTextContent('Solar - WARANDE 400kV');
                expect(title).not.toHaveTextContent('WARANDE 400kV Solar');
            });

            it('a redispatched plant that names no carrier is a production', () => {
                expect(titleOf('redispatch_GEN_P', {
                    ...baseDetails,
                    redispatch_details: [{ gen_name: 'GEN_P', voltage_level_id: 'VL_M', delta_mw: 10, target_mw: 60, direction: 'up' }],
                })).toHaveTextContent('Production - Blayais 1');
            });

            it('a combined action chains its parts, each with its type', () => {
                const title = titleOf('disco_LINE_W+open_coupler_VL_M', {
                    ...baseDetails,
                    description_unitaire: "Ouverture de la ligne 'LINE_W' + Ouverture du couplage dans le poste 'MANDARINS 400kV'",
                    action_topology: {
                        ...emptyTopo, lines_or_bus: { LINE_W: -1 }, voltage_level_id: 'VL_M',
                    } as ActionDetail['action_topology'],
                });
                expect(title).toHaveTextContent('Branch - MANDAL71WARAN + Coupling - MANDARINS 400kV');
            });
        });

        it('falls back to the type label, then the raw id, when nothing can be named', () => {
            const { rerender } = render(<ActionCard {...defaultProps} />);
            expect(screen.getByRole('heading', { level: 4 })).toHaveTextContent('act_1');
            rerender(<ActionCard {...defaultProps} id="load_shedding_ALL" details={{ ...baseDetails, action_topology: emptyTopo }} />);
            expect(screen.getByRole('heading', { level: 4 })).toHaveTextContent('Load shedding');
        });

        it('caps a long title at two names, the rest on hover', () => {
            const details: ActionDetail = {
                ...baseDetails,
                curtailment_details: ['G1', 'G2', 'G3', 'G4'].map(g => ({ gen_name: g, voltage_level_id: 'VL_M', curtailed_mw: 1 })),
            };
            render(<ActionCard {...defaultProps} details={details} />);
            const title = screen.getByRole('heading', { level: 4 });
            expect(title).toHaveTextContent(/G1, G2 \+2/);
            expect(screen.getByTitle('G3, G4')).toBeInTheDocument();
        });
    });

    describe('pictograms', () => {
        it('shows the action type as a pictogram with its meaning on hover', () => {
            const details: ActionDetail = {
                ...baseDetails,
                curtailment_details: [{ gen_name: 'WIND_A', voltage_level_id: 'VL_A', curtailed_mw: 9.0 }],
            };
            // ``curtail_*`` is only told apart by its details.
            render(<ActionCard {...defaultProps} id="curtail_WIND_A" details={details} />);
            expect(screen.getByTestId('action-card-curtail_WIND_A-type-rc')).toHaveAttribute('title', 'Renewable curtailment');
        });

        it('shows the source as a pictogram — a person for a manual simulation, a chip for a model', () => {
            const { container, rerender } = render(<ActionCard {...defaultProps} details={{ ...baseDetails, origin: 'user' }} isViewing />);
            expect(screen.getByTitle('Source: Manual simulation (user)').querySelector('svg')).not.toBeNull();
            rerender(<ActionCard {...defaultProps} details={{ ...baseDetails, origin: 'expert' }} isViewing />);
            expect(screen.getByTitle('Source: expert').querySelector('svg')).not.toBeNull();
            expect(container.textContent).not.toMatch(/Source:/);
        });
    });

    it('keeps the raw action id one click away on the viewing card', async () => {
        const writeText = vi.fn(() => Promise.resolve());
        Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
        const onActionSelect = vi.fn();
        render(<ActionCard {...defaultProps} id="user_topo_VL_M_1" isViewing onActionSelect={onActionSelect} />);
        expect(screen.getByTestId('action-card-user_topo_VL_M_1-origin')).toHaveTextContent('user_topo_VL_M_1');
        fireEvent.click(screen.getByTestId('action-card-user_topo_VL_M_1-copy-id'));
        expect(writeText).toHaveBeenCalledWith('user_topo_VL_M_1');
        expect(onActionSelect).not.toHaveBeenCalled();
    });

    describe('half-open overload annotation (charging current)', () => {
        it('annotates the loading with reactive power when a line is open one end', () => {
            const details: ActionDetail = {
                ...baseDetails,
                rho_after: [0.333],
                half_open_overloads: { LINE_A: 16.8 },
            };
            render(
                <ActionCard
                    {...defaultProps}
                    details={details}
                    linesOverloaded={['LINE_A']}
                    isViewing={true}
                />,
            );
            // The 33.3 % is kept (it is physically real) AND explained.
            expect(screen.getByText(/33\.3%/)).toBeInTheDocument();
            expect(screen.getByText(/open one end/i)).toBeInTheDocument();
            expect(screen.getByText(/16\.8 MVAr/)).toBeInTheDocument();
        });

        it('keeps the note on the max-loading row when that row stands for the overload', () => {
            const details: ActionDetail = {
                ...baseDetails,
                rho_after: [0.333], max_rho: 0.333, max_rho_line: 'LINE_A',
                half_open_overloads: { LINE_A: 16.8 },
            };
            render(<ActionCard {...defaultProps} details={details} linesOverloaded={['LINE_A']} isViewing={true} />);
            expect(screen.queryByTestId('action-card-act_1-after')).not.toBeInTheDocument();
            expect(screen.getAllByText(/open one end/i)).toHaveLength(1);
            expect(screen.getByTitle(/^Max loading/)).toHaveTextContent(/33\.3%\s*LINE_A\s*open one end · 16\.8 MVAr/);
        });

        it('does not annotate a normally-loaded line', () => {
            const details: ActionDetail = {
                ...baseDetails,
                rho_after: [0.85],
                // no half_open_overloads
            };
            render(
                <ActionCard
                    {...defaultProps}
                    details={details}
                    linesOverloaded={['LINE_A']}
                    isViewing={true}
                />,
            );
            expect(screen.queryByText(/open one end/i)).not.toBeInTheDocument();
            expect(screen.queryByText(/MVAr/i)).not.toBeInTheDocument();
        });
    });
});
