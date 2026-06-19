// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import ExplorePairsTab from './ExplorePairsTab';
import type { AnalysisResult, CombinedAction } from '../types';

describe('ExplorePairsTab', () => {
    const scoredActionsList = [
        { actionId: 'act1', score: 10, type: 'disco', mwStart: null },
        { actionId: 'act2', score: 20, type: 'reco', mwStart: 50.0 },
        { actionId: 'act3', score: 15, type: 'disco', mwStart: null },
    ];

    const mockAnalysisResult: AnalysisResult = {
        actions: {
            act1: { description_unitaire: 'D1', max_rho: 0.8, rho_before: [0.8], rho_after: [0.7], max_rho_line: 'L1', is_rho_reduction: true, action_topology: { lines_ex_bus: {}, lines_or_bus: {}, gens_bus: {}, loads_bus: {} } },
            act2: { description_unitaire: 'R1', max_rho: 0.9, rho_before: [0.9], rho_after: [0.8], max_rho_line: 'L2', is_rho_reduction: true, action_topology: { lines_ex_bus: {}, lines_or_bus: {}, gens_bus: {}, loads_bus: {} } },
        },
        lines_overloaded: [],
        message: 'done',
        dc_fallback: false,
        pdf_path: null,
        pdf_url: null,
    };

    const defaultProps = {
        scoredActionsList,
        selectedIds: new Set<string>(),
        onToggle: vi.fn(),
        onClearSelection: vi.fn(),
        preview: null as CombinedAction | null,
        simulationFeedback: null,
        sessionSimResults: {} as Record<string, { max_rho: number | null; max_rho_line: string; is_rho_reduction: boolean }>,
        analysisResult: mockAnalysisResult,
        loading: false,
        error: null as string | null,
        simulating: false,
        hasRestricted: false,
        monitoringFactor: 0.95,
        onEstimate: vi.fn(),
        onSimulate: vi.fn(),
        onSimulateSingle: vi.fn(),
    };

    it('renders selection chips header showing 0/2 selected', () => {
        render(<ExplorePairsTab {...defaultProps} />);
        expect(screen.getByText('Selected Actions (0/2)')).toBeInTheDocument();
    });

    it('renders placeholder text when no actions selected', () => {
        render(<ExplorePairsTab {...defaultProps} />);
        expect(screen.getByText(/Click rows in the table below to select/)).toBeInTheDocument();
    });

    it('renders selected chips when actions are selected', () => {
        render(<ExplorePairsTab {...defaultProps} selectedIds={new Set(['act1', 'act2'])} />);
        expect(screen.getByTestId('chip-act1')).toBeInTheDocument();
        expect(screen.getByTestId('chip-act2')).toBeInTheDocument();
        expect(screen.getByText('Selected Actions (2/2)')).toBeInTheDocument();
    });

    it('renders action rows from scored actions list', () => {
        render(<ExplorePairsTab {...defaultProps} />);
        expect(screen.getByText('act1')).toBeInTheDocument();
        expect(screen.getByText('act2')).toBeInTheDocument();
        expect(screen.getByText('act3')).toBeInTheDocument();
    });

    it('calls onToggle when an action row is clicked', () => {
        const onToggle = vi.fn();
        render(<ExplorePairsTab {...defaultProps} onToggle={onToggle} />);
        fireEvent.click(screen.getByText('act1'));
        expect(onToggle).toHaveBeenCalledWith('act1');
    });

    it('shows estimate button when less than 2 actions selected', () => {
        render(<ExplorePairsTab {...defaultProps} />);
        expect(screen.getByText('Select 2 actions to estimate')).toBeInTheDocument();
    });

    it('shows enabled estimate button when 2 actions selected', () => {
        render(<ExplorePairsTab {...defaultProps} selectedIds={new Set(['act1', 'act2'])} />);
        expect(screen.getByTestId('estimate-button')).toBeInTheDocument();
        expect(screen.getByText('Estimate combination effect')).toBeInTheDocument();
    });

    it('disables Estimate and surfaces the load-shedding/curtailment caveat when hasRestricted is true', () => {
        render(<ExplorePairsTab {...defaultProps} selectedIds={new Set(['act1', 'act2'])} hasRestricted={true} />);
        const estimateBtn = screen.getByTestId('estimate-button');
        expect(estimateBtn).toBeDisabled();
        expect(estimateBtn).toHaveTextContent(/Estimation not available/i);
    });

    it('exposes a Simulate Combined button in the no-preview state that stays enabled even when hasRestricted', () => {
        const onSimulate = vi.fn();
        render(
            <ExplorePairsTab
                {...defaultProps}
                selectedIds={new Set(['act1', 'act2'])}
                hasRestricted={true}
                onSimulate={onSimulate}
            />,
        );
        const simBtn = screen.getByTestId('simulate-combined-button');
        expect(simBtn).toBeEnabled();
        fireEvent.click(simBtn);
        expect(onSimulate).toHaveBeenCalled();
    });

    it('disables the no-preview Simulate Combined button until 2 actions are selected', () => {
        render(<ExplorePairsTab {...defaultProps} selectedIds={new Set(['act1'])} />);
        expect(screen.getByTestId('simulate-combined-button')).toBeDisabled();
    });

    it('calls onEstimate when estimate button is clicked', () => {
        const onEstimate = vi.fn();
        render(<ExplorePairsTab {...defaultProps} selectedIds={new Set(['act1', 'act2'])} onEstimate={onEstimate} />);
        fireEvent.click(screen.getByTestId('estimate-button'));
        expect(onEstimate).toHaveBeenCalled();
    });

    it('shows estimating message when loading', () => {
        render(<ExplorePairsTab {...defaultProps} selectedIds={new Set(['act1', 'act2'])} loading={true} />);
        expect(screen.getByText(/Estimating Combination/)).toBeInTheDocument();
    });

    it('renders comparison card when preview is set', () => {
        const preview: CombinedAction = {
            action1_id: 'act1',
            action2_id: 'act2',
            betas: [1.0, 0.9],
            max_rho: 0.72,
            max_rho_line: 'L3',
            estimated_max_rho: 0.75,
            estimated_max_rho_line: 'L3',
            is_rho_reduction: true,
            description: 'Combined',
            p_or_combined: [],
            rho_before: [0.8],
            rho_after: [0.72],
        };
        render(<ExplorePairsTab {...defaultProps} selectedIds={new Set(['act1', 'act2'])} preview={preview} />);
        expect(screen.getByTestId('comparison-card')).toBeInTheDocument();
        expect(screen.getByText('75.0%')).toBeInTheDocument();
        expect(screen.getByText(/Estimated Max Loading/)).toBeInTheDocument();
    });

    it('shows simulation feedback in comparison card', () => {
        const preview: CombinedAction = {
            action1_id: 'act1', action2_id: 'act2', betas: [1.0], max_rho: 0.72,
            max_rho_line: 'L3', is_rho_reduction: true, description: 'Combined',
            p_or_combined: [], rho_before: [0.8], rho_after: [0.72],
        };
        const feedback = { max_rho: 0.68, max_rho_line: 'L2', is_rho_reduction: true };
        render(<ExplorePairsTab {...defaultProps} selectedIds={new Set(['act1', 'act2'])} preview={preview} simulationFeedback={feedback} />);
        expect(screen.getByTestId('simulation-feedback')).toBeInTheDocument();
        expect(screen.getByText('68.0%')).toBeInTheDocument();
    });

    it('shows the Simulate Combined button on top of the card while a preview is shown and no simulation has run yet', () => {
        const preview: CombinedAction = {
            action1_id: 'act1', action2_id: 'act2', betas: [1.0], max_rho: 0.72,
            max_rho_line: 'L3', is_rho_reduction: true, description: 'Combined',
            p_or_combined: [], rho_before: [0.8], rho_after: [0.72],
        };
        render(<ExplorePairsTab {...defaultProps} selectedIds={new Set(['act1', 'act2'])} preview={preview} />);
        expect(screen.getByTestId('simulate-combined-top-button')).toBeInTheDocument();
    });

    it('hides the top Simulate Combined button once a simulation result is available', () => {
        const preview: CombinedAction = {
            action1_id: 'act1', action2_id: 'act2', betas: [1.0], max_rho: 0.72,
            max_rho_line: 'L3', is_rho_reduction: true, description: 'Combined',
            p_or_combined: [], rho_before: [0.8], rho_after: [0.72],
        };
        const feedback = { max_rho: 0.68, max_rho_line: 'L2', is_rho_reduction: true };
        render(<ExplorePairsTab {...defaultProps} selectedIds={new Set(['act1', 'act2'])} preview={preview} simulationFeedback={feedback} />);
        expect(screen.queryByTestId('simulate-combined-top-button')).not.toBeInTheDocument();
    });

    it('renders the card with only the Simulation Result column when simulation ran without an estimate', () => {
        const feedback = { max_rho: 0.68, max_rho_line: 'L2', is_rho_reduction: true };
        render(<ExplorePairsTab {...defaultProps} selectedIds={new Set(['act1', 'act2'])} simulationFeedback={feedback} />);
        expect(screen.getByTestId('comparison-card')).toBeInTheDocument();
        expect(screen.getByTestId('simulation-feedback')).toBeInTheDocument();
        expect(screen.queryByText(/Estimated Max Loading/)).not.toBeInTheDocument();
    });

    it('does not render Estimate / Simulate buttons inside the comparison card header', () => {
        const preview: CombinedAction = {
            action1_id: 'act1', action2_id: 'act2', betas: [1.0], max_rho: 0.72,
            max_rho_line: 'L3', is_rho_reduction: true, description: 'Combined',
            p_or_combined: [], rho_before: [0.8], rho_after: [0.72],
        };
        render(<ExplorePairsTab {...defaultProps} selectedIds={new Set(['act1', 'act2'])} preview={preview} />);
        const card = screen.getByTestId('comparison-card');
        expect(within(card).queryByText('Estimate combination effect')).not.toBeInTheDocument();
        expect(within(card).queryByText('Estimation unavailable')).not.toBeInTheDocument();
        expect(within(card).queryByText('Simulate Combined')).not.toBeInTheDocument();
    });

    it('hides the bottom action bar once a simulation has run (no preview path)', () => {
        const feedback = { max_rho: 0.68, max_rho_line: 'L2', is_rho_reduction: true };
        render(<ExplorePairsTab {...defaultProps} selectedIds={new Set(['act1', 'act2'])} simulationFeedback={feedback} />);
        expect(screen.queryByTestId('estimate-button')).not.toBeInTheDocument();
        expect(screen.queryByTestId('simulate-combined-button')).not.toBeInTheDocument();
    });

    it('clicking the top Simulate Combined button calls onSimulate', () => {
        const onSimulate = vi.fn();
        const preview: CombinedAction = {
            action1_id: 'act1', action2_id: 'act2', betas: [1.0], max_rho: 0.72,
            max_rho_line: 'L3', is_rho_reduction: true, description: 'Combined',
            p_or_combined: [], rho_before: [0.8], rho_after: [0.72],
        };
        render(<ExplorePairsTab {...defaultProps} selectedIds={new Set(['act1', 'act2'])} preview={preview} onSimulate={onSimulate} />);
        fireEvent.click(screen.getByTestId('simulate-combined-top-button'));
        expect(onSimulate).toHaveBeenCalled();
    });

    it('disables the top Simulate Combined button while simulating', () => {
        const preview: CombinedAction = {
            action1_id: 'act1', action2_id: 'act2', betas: [1.0], max_rho: 0.72,
            max_rho_line: 'L3', is_rho_reduction: true, description: 'Combined',
            p_or_combined: [], rho_before: [0.8], rho_after: [0.72],
        };
        render(<ExplorePairsTab {...defaultProps} selectedIds={new Set(['act1', 'act2'])} preview={preview} simulating={true} />);
        expect(screen.getByTestId('simulate-combined-top-button')).toBeDisabled();
    });

    it('uses the "Simulation Result" title when only simulation ran (no estimate)', () => {
        const feedback = { max_rho: 0.68, max_rho_line: 'L2', is_rho_reduction: true };
        render(<ExplorePairsTab {...defaultProps} selectedIds={new Set(['act1', 'act2'])} simulationFeedback={feedback} />);
        const card = screen.getByTestId('comparison-card');
        // "Simulation Result" appears as both the card title and the column header — so we expect 2 matches
        expect(within(card).getAllByText('Simulation Result').length).toBe(2);
        expect(within(card).queryByText('Explore Pairs Comparison')).not.toBeInTheDocument();
    });

    it('surfaces target_max_rho in the comparison card when it differs from the global estimated line', () => {
        const preview: CombinedAction = {
            action1_id: 'act1', action2_id: 'act2', betas: [1.5, 0.5],
            max_rho: 0.82, max_rho_line: 'LOUHAL31PYMON',
            estimated_max_rho: 0.82, estimated_max_rho_line: 'LOUHAL31PYMON',
            target_max_rho: 0.20, target_max_rho_line: 'BEON L31CPVAN',
            is_rho_reduction: false, description: 'Combined',
            p_or_combined: [], rho_before: [0.8], rho_after: [0.20],
        };
        render(<ExplorePairsTab {...defaultProps} selectedIds={new Set(['act1', 'act2'])} preview={preview} />);
        const target = screen.getByTestId('target-max-rho');
        expect(target).toHaveTextContent(/20\.0%.*BEON L31CPVAN/);
    });

    it('hides target_max_rho when it matches the global estimated line (nothing to add)', () => {
        const preview: CombinedAction = {
            action1_id: 'act1', action2_id: 'act2', betas: [1.0, 0.9],
            max_rho: 0.72, max_rho_line: 'L3',
            estimated_max_rho: 0.72, estimated_max_rho_line: 'L3',
            target_max_rho: 0.72, target_max_rho_line: 'L3',
            is_rho_reduction: true, description: 'Combined',
            p_or_combined: [], rho_before: [0.8], rho_after: [0.72],
        };
        render(<ExplorePairsTab {...defaultProps} selectedIds={new Set(['act1', 'act2'])} preview={preview} />);
        expect(screen.queryByTestId('target-max-rho')).not.toBeInTheDocument();
    });

    it('uses the "Explore Pairs Comparison" title when an estimate is present', () => {
        const preview: CombinedAction = {
            action1_id: 'act1', action2_id: 'act2', betas: [1.0], max_rho: 0.72,
            max_rho_line: 'L3', is_rho_reduction: true, description: 'Combined',
            p_or_combined: [], rho_before: [0.8], rho_after: [0.72],
        };
        render(<ExplorePairsTab {...defaultProps} selectedIds={new Set(['act1', 'act2'])} preview={preview} />);
        const card = screen.getByTestId('comparison-card');
        expect(within(card).getByText('Explore Pairs Comparison')).toBeInTheDocument();
    });

    it('shows error message in comparison card', () => {
        const preview: CombinedAction = {
            action1_id: 'act1', action2_id: 'act2', betas: [1.0], max_rho: 0.72,
            max_rho_line: 'L3', is_rho_reduction: true, description: 'Combined',
            p_or_combined: [], rho_before: [0.8], rho_after: [0.72],
        };
        render(<ExplorePairsTab {...defaultProps} selectedIds={new Set(['act1', 'act2'])} preview={preview} error="Superposition failed" />);
        expect(screen.getByText('Superposition failed')).toBeInTheDocument();
    });

    // The action-type / severity filtering moved OUT of this tab — it
    // is now driven by the shared ActionFilterRings in the Combine-modal
    // header, which hands ExplorePairsTab an already-filtered
    // `scoredActionsList`. The tab itself only renders what it is given.
    it('renders exactly the rows it is handed (no in-tab filtering)', () => {
        render(<ExplorePairsTab {...defaultProps} scoredActionsList={[scoredActionsList[0]]} />);
        expect(screen.getByText('act1')).toBeInTheDocument();
        expect(screen.queryByText('act2')).not.toBeInTheDocument();
        expect(screen.queryByText('act3')).not.toBeInTheDocument();
    });

    it('calls onClearSelection when Clear All is clicked', () => {
        const onClearSelection = vi.fn();
        render(<ExplorePairsTab {...defaultProps} selectedIds={new Set(['act1'])} onClearSelection={onClearSelection} />);
        fireEvent.click(screen.getByText('Clear All'));
        expect(onClearSelection).toHaveBeenCalled();
    });

    it('shows MW Start values in action rows', () => {
        render(<ExplorePairsTab {...defaultProps} />);
        expect(screen.getByText('50.0')).toBeInTheDocument();
    });

    it('shows N/A for null MW Start values', () => {
        render(<ExplorePairsTab {...defaultProps} />);
        expect(screen.getAllByText('N/A').length).toBeGreaterThan(0);
    });

    it('shows the empty state when handed an empty scored-actions list', () => {
        render(<ExplorePairsTab {...defaultProps} scoredActionsList={[]} />);
        expect(screen.getByText(/No scored actions available/)).toBeInTheDocument();
    });

    it('renders every row it is handed', () => {
        render(<ExplorePairsTab {...defaultProps} />);
        expect(screen.getByText('act1')).toBeInTheDocument();
        expect(screen.getByText('act2')).toBeInTheDocument();
        expect(screen.getByText('act3')).toBeInTheDocument();
    });

    // Injection actions (load shedding / curtailment / redispatch) expose an
    // editable MW setpoint per row so the operator can tune the target shed
    // amount or the signed redispatch delta before simulating — parity with
    // the manual-selection table and the action card.
    describe('editable injection setpoint', () => {
        const injectionList = [
            { actionId: 'load_shedding_L1', score: 22, type: 'load_shedding', mwStart: 22.0 },
            { actionId: 'redispatch_G1', score: 1.0, type: 'redispatch', mwStart: 14.3 },
        ];
        const injectionAnalysis: AnalysisResult = {
            actions: {
                redispatch_G1: {
                    description_unitaire: 'redispatch G1', max_rho: 0.9, rho_before: [0.9], rho_after: [0.8],
                    max_rho_line: 'L1', is_rho_reduction: true,
                    redispatch_details: [{ gen_name: 'G1', voltage_level_id: 'VL1', delta_mw: 10.0, target_mw: 24.3, direction: 'up', current_mw: 14.3, max_raise_mw: 30.0, max_lower_mw: 14.3 }],
                },
            },
            lines_overloaded: [], message: 'done', dc_fallback: false, pdf_path: null, pdf_url: null,
        };

        it('renders an editable input for load-shedding and redispatch rows', () => {
            render(<ExplorePairsTab {...defaultProps} scoredActionsList={injectionList} analysisResult={injectionAnalysis} />);
            expect(screen.getByTestId('explore-mw-load_shedding_L1')).toBeInTheDocument();
            expect(screen.getByTestId('explore-mw-redispatch_G1')).toBeInTheDocument();
        });

        it('defaults the redispatch input to the simulated delta_mw', () => {
            render(<ExplorePairsTab {...defaultProps} scoredActionsList={injectionList} analysisResult={injectionAnalysis} />);
            const input = screen.getByTestId('explore-mw-redispatch_G1') as HTMLInputElement;
            expect(input.value).toBe('10.0');
        });

        it('does not render an editable input for non-injection (disco/reco) rows', () => {
            render(<ExplorePairsTab {...defaultProps} />);
            expect(screen.queryByTestId('explore-mw-act1')).not.toBeInTheDocument();
            expect(screen.queryByTestId('explore-mw-act2')).not.toBeInTheDocument();
        });

        it('passes the edited target MW to onSimulateSingle when the row button is clicked', () => {
            const onSimulateSingle = vi.fn();
            render(<ExplorePairsTab {...defaultProps} scoredActionsList={injectionList} analysisResult={injectionAnalysis} onSimulateSingle={onSimulateSingle} />);
            fireEvent.change(screen.getByTestId('explore-mw-load_shedding_L1'), { target: { value: '12' } });
            // The LS action is untested → button reads "Simulate".
            const row = screen.getByText('load_shedding_L1').closest('tr')!;
            fireEvent.click(within(row).getByText('Simulate'));
            expect(onSimulateSingle).toHaveBeenCalledWith('load_shedding_L1', 12);
        });

        it('passes undefined target MW for a non-injection row (recommender default)', () => {
            const onSimulateSingle = vi.fn();
            render(<ExplorePairsTab {...defaultProps} onSimulateSingle={onSimulateSingle} />);
            // act1 (disco) is pre-simulated in the mock → button reads "Re-run".
            const row = screen.getByText('act1').closest('tr')!;
            fireEvent.click(within(row).getByText('Re-run'));
            expect(onSimulateSingle).toHaveBeenCalledWith('act1', undefined);
        });
    });
});
