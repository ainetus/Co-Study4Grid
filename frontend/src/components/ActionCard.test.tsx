// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

vi.mock('../utils/svgUtils', () => ({
    getActionTargetVoltageLevels: vi.fn(() => []),
    getActionTargetLines: vi.fn(() => []),
    isCouplingAction: vi.fn(() => false),
}));

import ActionCard from './ActionCard';
import type { ActionDetail } from '../types';

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

    it('hides the description at rest (progressive disclosure)', () => {
        render(<ActionCard {...defaultProps} />);
        expect(screen.queryByText('Open line L1')).not.toBeInTheDocument();
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

    it('places severity icon before the title and star/reject rail in the header row', () => {
        // Structural spec: the header row contains (left to right)
        // the severity pictogram, then the title, then the hover-
        // revealed star/reject rail in the top-right corner.
        const { container } = render(<ActionCard {...defaultProps} />);
        // The first child of the card is the header flex row
        const card = container.querySelector('[data-testid="action-card-act_1"]')!;
        const headerRow = card.children[0] as HTMLElement;

        // Left group: severity icon + title
        const leftGroup = headerRow.children[0] as HTMLElement;
        const severity = leftGroup.querySelector('[data-testid="action-card-act_1-severity"]');
        const title = leftGroup.querySelector('h4');
        expect(severity).not.toBeNull();
        expect(title).not.toBeNull();
        // Severity comes before title in DOM order
        const children = Array.from(leftGroup.children);
        expect(children.indexOf(severity!)).toBeLessThan(children.indexOf(title!));

        // Right group: the rail sits as the second child of the header row
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
        expect(screen.getByText('Max loading:')).toBeInTheDocument();
        expect(screen.getAllByText(/85\.0%/).length).toBeGreaterThan(0);
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

    it('renders the "Overload loading after" detail only inside the viewing disclosure', () => {
        // At rest the "Overload loading after" detail is hidden — the
        // per-card max ρ% summary above replaces it.  Only the viewing
        // card expands the per-line breakdown.  "Loading before" stays
        // in the sticky Overloads panel and never appears on the card.
        const { rerender } = render(<ActionCard {...defaultProps} />);
        expect(screen.queryByText(/loading after/i)).not.toBeInTheDocument();
        expect(screen.queryByText(/loading before/i)).not.toBeInTheDocument();

        rerender(<ActionCard {...defaultProps} isViewing={true} />);
        expect(screen.getByText(/Overload loading after/i)).toBeInTheDocument();
        expect(screen.queryByText(/loading before/i)).not.toBeInTheDocument();
    });

    it('renders the Source / provenance row BELOW the "Overload loading after" line in the unfolded card', () => {
        // Operator-requested layout: Source is a low-information
        // attribution row, so it sits at the very bottom of the
        // unfolded disclosure — below the operational fields
        // (description, per-line editors, "Overload loading after").
        // Pre-change the row sat just under the description, which
        // pushed it above the more relevant operational data.
        const details: ActionDetail = {
            ...baseDetails,
            origin: 'user',
        };
        render(<ActionCard {...defaultProps} details={details} isViewing={true} />);
        const disclosure = screen.getByTestId('action-card-act_1-disclosure');
        const html = disclosure.innerHTML;
        const overloadIdx = html.indexOf('Overload loading after');
        const sourceIdx = html.indexOf('Source:');
        expect(overloadIdx).toBeGreaterThanOrEqual(0);
        expect(sourceIdx).toBeGreaterThanOrEqual(0);
        expect(sourceIdx).toBeGreaterThan(overloadIdx);
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
        expect(screen.getByText('LOAD_X')).toBeInTheDocument();
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
        expect(screen.getByText('GEN_Y')).toBeInTheDocument();
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
        expect(screen.getByText('THERM_1')).toBeInTheDocument();
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

    it('renders a clickable VL chip for a redispatch action (zoom + SLD)', () => {
        const onVlDoubleClick = vi.fn();
        const details: ActionDetail = {
            ...baseDetails,
            redispatch_details: [
                { gen_name: 'THERM_1', voltage_level_id: 'VL_BIEST', delta_mw: 10.0, target_mw: 40.0, direction: 'up' }
            ],
        };
        render(<ActionCard {...defaultProps} details={details} onVlDoubleClick={onVlDoubleClick} />);
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
                .toHaveTextContent('Source: Manual simulation (user)');
        });

        it('resolves a model id to its label for a recommender-originated action', () => {
            const details = { ...baseDetails, origin: 'random_overflow' };
            render(<ActionCard {...defaultProps} details={details} isViewing availableModels={models} />);
            expect(screen.getByTestId('action-card-act_1-origin'))
                .toHaveTextContent('Source: Random (post overflow analysis)');
        });

        it('falls back to the raw origin id when no model matches', () => {
            const details = { ...baseDetails, origin: 'ml_policy_v9' };
            render(<ActionCard {...defaultProps} details={details} isViewing availableModels={models} />);
            expect(screen.getByTestId('action-card-act_1-origin'))
                .toHaveTextContent('Source: ml_policy_v9');
        });

        it('does not render the Source row when origin is absent', () => {
            // baseDetails has no `origin` — legacy / un-tracked actions.
            render(<ActionCard {...defaultProps} isViewing availableModels={models} />);
            expect(screen.queryByTestId('action-card-act_1-origin')).not.toBeInTheDocument();
        });

        it('does not render the Source row on a folded (non-viewing) card', () => {
            const details = { ...baseDetails, origin: 'user' };
            render(<ActionCard {...defaultProps} details={details} isViewing={false} availableModels={models} />);
            expect(screen.queryByTestId('action-card-act_1-origin')).not.toBeInTheDocument();
        });
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
