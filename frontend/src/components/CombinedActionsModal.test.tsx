// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study. 

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import CombinedActionsModal from './CombinedActionsModal';
import { api } from '../api';
import type { AnalysisResult, CombinedAction } from '../types';

type SimulateResult = Awaited<ReturnType<typeof api.simulateManualAction>>;

describe('CombinedActionsModal', () => {
    const mockAnalysisResult: AnalysisResult = {
        actions: {
            'act1': { description_unitaire: 'Action 1', max_rho: 0.8, rho_before: [0.8], rho_after: [0.7], max_rho_line: 'L1', is_rho_reduction: true, action_topology: { lines_ex_bus: {}, lines_or_bus: {}, gens_bus: {}, loads_bus: {} } },
            'act2': { description_unitaire: 'Action 2', max_rho: 0.9, rho_before: [0.9], rho_after: [0.8], max_rho_line: 'L2', is_rho_reduction: true, action_topology: { lines_ex_bus: {}, lines_or_bus: {}, gens_bus: {}, loads_bus: {} } },
            'act3': { description_unitaire: 'Action 3', max_rho: 0.85, rho_before: [0.85], rho_after: [0.8], max_rho_line: 'L3', is_rho_reduction: true, action_topology: { lines_ex_bus: {}, lines_or_bus: {}, gens_bus: {}, loads_bus: {} } },
        },
        combined_actions: {
            'act1+act2': {
                action1_id: 'act1',
                action2_id: 'act2',
                betas: [1.0, 0.9],
                max_rho: 0.72,
                max_rho_line: 'L3',
                estimated_max_rho: 0.75,
                estimated_max_rho_line: 'L3_EST',
                is_rho_reduction: true,
                description: 'Pre-computed Pair',
                p_or_combined: [],
                rho_before: [0.75],
                rho_after: [0.72]
            }
        },
        action_scores: {
            'disco': { scores: { 'act1': 10, 'act2': 20, 'act3': 15 } }
        },
        lines_overloaded: [],
        message: 'done',
        dc_fallback: false,
        pdf_path: null,
        pdf_url: null,
    };

    const defaultProps = {
        isOpen: true,
        onClose: vi.fn(),
        analysisResult: mockAnalysisResult,
        disconnectedElement: 'L_FAULTY',
        onSimulateCombined: vi.fn(),
        onSimulateSingleAction: vi.fn(),
    };

    beforeEach(() => {
        vi.restoreAllMocks();
        vi.spyOn(api, 'computeSuperposition').mockImplementation(() => Promise.resolve({} as unknown as CombinedAction));
        vi.spyOn(api, 'simulateManualAction').mockImplementation(() => Promise.resolve({} as unknown as SimulateResult));
    });

    afterEach(() => {
        cleanup();
    });

    const getExploreTab = () => screen.getByTestId('tab-explore');

    it('renders and shows computed pairs by default', () => {
        render(<CombinedActionsModal {...defaultProps} />);
        expect(screen.getByText('Computed Pairs')).toBeInTheDocument();
        expect(screen.getByText('75.0%')).toBeInTheDocument();
    });

    it('hides Computed Pairs rows whose max-ρ exceeds the Max-loading threshold', async () => {
        // The Max-loading spinner in the shared ActionFilterRings
        // must filter the Computed Pairs table the same way it
        // filters the unitary score tables. The fixture's only pair
        // is "estimated-only" (no ``simulated_max_rho``), so the
        // threshold falls back to ``estimated_max_rho = 0.75`` (the
        // 75.0 % the table renders by default). Setting the
        // threshold to 70 % (0.70) must hide it; bumping it back to
        // 100 % must restore the row.
        render(<CombinedActionsModal {...defaultProps} />);
        expect(screen.getByText('75.0%')).toBeInTheDocument();
        const input = screen.getByTestId('sidebar-filter-threshold-input') as HTMLInputElement;
        fireEvent.change(input, { target: { value: '70' } });
        expect(screen.queryByText('75.0%')).not.toBeInTheDocument();
        fireEvent.change(input, { target: { value: '100' } });
        expect(screen.getByText('75.0%')).toBeInTheDocument();
    });

    it('filters actions by category including LS in explore tab', async () => {
        const resultWithTypes: AnalysisResult = {
            ...mockAnalysisResult,
            actions: {
                ...mockAnalysisResult.actions,
                'disco1': { description_unitaire: 'Disco 1', max_rho: 0.8, rho_before: [0.8], rho_after: [0.7], max_rho_line: 'L1', is_rho_reduction: true, action_topology: { lines_ex_bus: {}, lines_or_bus: {}, gens_bus: {}, loads_bus: {} } },
                'reco1': { description_unitaire: 'Reco 1', max_rho: 0.9, rho_before: [0.9], rho_after: [0.8], max_rho_line: 'L2', is_rho_reduction: true, action_topology: { lines_ex_bus: {}, lines_or_bus: {}, gens_bus: {}, loads_bus: {} } },
                'ls1': { description_unitaire: 'LS 1', max_rho: 0.7, rho_before: [0.7], rho_after: [0.6], max_rho_line: 'L1', is_rho_reduction: true, action_topology: { loads_bus: { 'L1': -1 }, lines_ex_bus: {}, lines_or_bus: {}, gens_bus: {} } },
            },
            action_scores: {
                'disco': { scores: { 'disco1': 10 } },
                'reco': { scores: { 'reco1': 20 } },
                'load_shedding': { scores: { 'ls1': 5 } }
            }
        };

        render(<CombinedActionsModal {...defaultProps} analysisResult={resultWithTypes as AnalysisResult} />);
        fireEvent.click(getExploreTab());

        // Filter for disconnections via the shared action-type ring in
        // the modal header (drives BOTH tabs).
        fireEvent.click(screen.getByTestId('sidebar-filter-type-disco'));
        expect(screen.getByText('disco1')).toBeInTheDocument();
        expect(screen.queryByText('reco1')).not.toBeInTheDocument();

        // Filter for load shedding.
        fireEvent.click(screen.getByTestId('sidebar-filter-type-ls'));
        expect(screen.getByText('ls1')).toBeInTheDocument();
        expect(screen.queryByText('disco1')).not.toBeInTheDocument();
    });

    it('shows all actions in explore tab by default (no filter active)', () => {
        const resultWithTypes: AnalysisResult = {
            ...mockAnalysisResult,
            actions: {
                ...mockAnalysisResult.actions,
                'disco1': { description_unitaire: 'Disco 1', max_rho: 0.8, rho_before: [0.8], rho_after: [0.7], max_rho_line: 'L1', is_rho_reduction: true, action_topology: { lines_ex_bus: {}, lines_or_bus: {}, gens_bus: {}, loads_bus: {} } },
                'reco1': { description_unitaire: 'Reco 1', max_rho: 0.9, rho_before: [0.9], rho_after: [0.8], max_rho_line: 'L2', is_rho_reduction: true, action_topology: { lines_ex_bus: {}, lines_or_bus: {}, gens_bus: {}, loads_bus: {} } },
            },
            action_scores: {
                'disco': { scores: { 'disco1': 10 } },
                'reco': { scores: { 'reco1': 20 } },
            },
        };
        render(<CombinedActionsModal {...defaultProps} analysisResult={resultWithTypes} />);
        fireEvent.click(getExploreTab());
        expect(screen.getByText('disco1')).toBeInTheDocument();
        expect(screen.getByText('reco1')).toBeInTheDocument();
    });

    it('renders the shared filter rings in the modal header for the explore tab', () => {
        render(<CombinedActionsModal {...defaultProps} />);
        fireEvent.click(getExploreTab());
        expect(screen.getByTestId('sidebar-action-filters')).toBeInTheDocument();
        const discoToggle = screen.getByTestId('sidebar-filter-type-disco');
        expect(discoToggle).toBeInTheDocument();
        // Clicking should not throw and should update the shared filter.
        expect(() => fireEvent.click(discoToggle)).not.toThrow();
        expect(discoToggle.getAttribute('aria-pressed')).toBe('true');
    });

    it('the severity ring in the modal header filters Explore-Pairs rows by outcome', async () => {
        // act1 / act2 / act3 all simulate to max_rho < 0.95 → green
        // severity. A single click on the red toggle "solos" it
        // (deferred by one double-click window), leaving only
        // red-severity rows — so all three green rows drop out.
        render(<CombinedActionsModal {...defaultProps} />);
        fireEvent.click(getExploreTab());
        expect(screen.getByText('act1')).toBeInTheDocument();
        const redToggle = screen.getByTestId('sidebar-filter-category-red');
        fireEvent.click(redToggle);
        await waitFor(() => {
            expect(screen.queryByText('act1')).not.toBeInTheDocument();
        });
        expect(screen.queryByText('act2')).not.toBeInTheDocument();
        expect(screen.getByText(/No scored actions available/)).toBeInTheDocument();
    });

    it('groups actions by type in explore tab table including LS', async () => {
        const resultWithLS: AnalysisResult = {
            ...mockAnalysisResult,
            actions: {
                ...mockAnalysisResult.actions,
                'ls_test': { description_unitaire: 'LS Test', max_rho: 0.7, rho_before: [0.7], rho_after: [0.6], max_rho_line: 'L1', is_rho_reduction: true, action_topology: { loads_bus: { 'L1': -1 }, lines_ex_bus: {}, lines_or_bus: {}, gens_bus: {} } },
            },
            action_scores: {
                ...mockAnalysisResult.action_scores,
                'load_shedding': { scores: { 'ls_test': 5 } }
            }
        };
        render(<CombinedActionsModal {...defaultProps} analysisResult={resultWithLS as AnalysisResult} />);
        fireEvent.click(getExploreTab());

        // The explore-tab table groups rows under per-type headers.
        expect(screen.getAllByText('DISCO').length).toBeGreaterThan(0);
        expect(screen.getAllByText('LOAD SHEDDING').length).toBeGreaterThan(0);
        expect(screen.getByText('ls_test')).toBeInTheDocument();
    });

    it('performs simulation and shows feedback', async () => {
        vi.mocked(api.simulateManualAction).mockResolvedValueOnce({
            action_id: 'act1+act2',
            max_rho: 0.73,
            max_rho_line: 'L3_SIM',
            is_rho_reduction: true,
            is_islanded: false,
            description_unitaire: 'Simulated combined',
            rho_before: [0.8],
            rho_after: [0.73],
            non_convergence: null,
            lines_overloaded: [],
            is_estimated: false
        } as unknown as SimulateResult);

        render(<CombinedActionsModal {...defaultProps} />);

        fireEvent.click(getExploreTab());
        fireEvent.click(screen.getByText('act1'));
        fireEvent.click(screen.getByText('act2'));

        const simButton = await screen.findByText('Simulate Combined');
        fireEvent.click(simButton);

        await waitFor(() => {
            const feedback = screen.getByTestId('simulation-feedback');
            expect(within(feedback).getByText('73.0%')).toBeInTheDocument();
            expect(within(feedback).getByText(/Line: L3_SIM/)).toBeInTheDocument();
        });
    });

    it('falls back to max_rho if estimated_max_rho is missing', () => {
        const resultWithMissingEst: AnalysisResult = {
            ...mockAnalysisResult,
            combined_actions: {
                'act1+act2': {
                    ...mockAnalysisResult.combined_actions!['act1+act2'],
                    estimated_max_rho: undefined,
                    max_rho: 0.99
                }
            }
        };
        render(<CombinedActionsModal {...defaultProps} analysisResult={resultWithMissingEst} />);
        expect(screen.getByText('99.0%')).toBeInTheDocument();
    });

    // ── MW Start column ────────────────────────────────────────────────────

    it('shows MW Start numeric value in explore tab for actions with mw_start', async () => {
        const resultWithMw: AnalysisResult = {
            ...mockAnalysisResult,
            action_scores: {
                'disco': {
                    scores: { 'act1': 10, 'act2': 20, 'act3': 15 },
                    mw_start: { 'act1': 142.5, 'act2': 88.0, 'act3': null }
                }
            }
        };
        render(<CombinedActionsModal {...defaultProps} analysisResult={resultWithMw} />);
        fireEvent.click(getExploreTab());

        expect(await screen.findByText('142.5')).toBeInTheDocument();
        expect(screen.getByText('88.0')).toBeInTheDocument();
    });

    it('shows N/A in explore tab for actions with null mw_start', async () => {
        const resultWithNullMw: AnalysisResult = {
            ...mockAnalysisResult,
            action_scores: {
                'line_reconnection': {
                    scores: { 'act1': 10, 'act2': 20, 'act3': 15 },
                    mw_start: { 'act1': null, 'act2': null, 'act3': null }
                }
            }
        };
        render(<CombinedActionsModal {...defaultProps} analysisResult={resultWithNullMw} />);
        fireEvent.click(getExploreTab());

        const naCells = await screen.findAllByText('N/A');
        expect(naCells.length).toBeGreaterThanOrEqual(1);
    });

    it('shows N/A when mw_start map is absent from action_scores', async () => {
        const resultNoMwStart: AnalysisResult = {
            ...mockAnalysisResult,
            action_scores: {
                'disco': {
                    scores: { 'act1': 10 }
                    // no mw_start field
                }
            }
        };
        render(<CombinedActionsModal {...defaultProps} analysisResult={resultNoMwStart} />);
        fireEvent.click(getExploreTab());

        expect(await screen.findByText('N/A')).toBeInTheDocument();
    });

    // Bug: the Explore Pairs estimation/comparison card must stay
    // visible after a successful Simulate Combined call so the user
    // can read the simulation result in place. Previously the useEffect
    // that rebuilt the preview from `analysisResult.combined_actions`
    // wiped the card the moment `onSimulateCombined` mutated the parent
    // analysisResult (because the newly-simulated pair lands in
    // `actions`, not in `combined_actions`).
    describe('Estimation card persistence on Simulate Combined', () => {
        const simResponse = {
            action_id: 'act1+act2',
            description_unitaire: 'Simulated combined',
            rho_before: [0.8],
            rho_after: [0.73],
            max_rho: 0.73,
            max_rho_line: 'L3_SIM',
            is_rho_reduction: true,
            is_islanded: false,
            non_convergence: null,
            lines_overloaded: [],
            is_estimated: false,
        } as unknown as SimulateResult;

        // After Simulate Combined completes, the comparison card (the
        // one carrying the "Explore Pairs Comparison" header) must
        // stay rendered and must show the simulation feedback.
        it('keeps the comparison card open and shows the feedback after Simulate', async () => {
            vi.mocked(api.simulateManualAction).mockResolvedValueOnce(simResponse);

            const { rerender } = render(<CombinedActionsModal {...defaultProps} />);
            fireEvent.click(getExploreTab());
            fireEvent.click(screen.getByText('act1'));
            fireEvent.click(screen.getByText('act2'));

            // Pre-computed pair 'act1+act2' exists in mockAnalysisResult,
            // so the preview card is visible immediately.
            expect(await screen.findByTestId('comparison-card')).toBeInTheDocument();

            const simButton = await screen.findByText('Simulate Combined');
            fireEvent.click(simButton);

            // Simulation feedback appears inside the SAME comparison card.
            await waitFor(() => {
                const feedback = screen.getByTestId('simulation-feedback');
                expect(within(feedback).getByText('73.0%')).toBeInTheDocument();
            });
            expect(screen.getByTestId('comparison-card')).toBeInTheDocument();

            // Regression: re-render with a NEW analysisResult that now
            // contains the simulated pair in `actions` (the real flow
            // via onSimulateCombined). The card must NOT disappear.
            const updatedResult: AnalysisResult = {
                ...mockAnalysisResult,
                actions: {
                    ...mockAnalysisResult.actions,
                    'act1+act2': {
                        description_unitaire: 'Simulated combined',
                        rho_before: [0.8],
                        rho_after: [0.73],
                        max_rho: 0.73,
                        max_rho_line: 'L3_SIM',
                        is_rho_reduction: true,
                    },
                },
            };
            rerender(<CombinedActionsModal {...defaultProps} analysisResult={updatedResult} />);

            expect(screen.getByTestId('comparison-card')).toBeInTheDocument();
            const feedback = screen.getByTestId('simulation-feedback');
            expect(within(feedback).getByText('73.0%')).toBeInTheDocument();
        });

        // The card should still reset when the user changes their pair
        // selection (deselect then pick different actions).
        it('resets the comparison card when the pair selection changes', async () => {
            vi.mocked(api.simulateManualAction).mockResolvedValueOnce(simResponse);

            render(<CombinedActionsModal {...defaultProps} />);
            fireEvent.click(getExploreTab());
            fireEvent.click(screen.getByText('act1'));
            fireEvent.click(screen.getByText('act2'));

            const card = await screen.findByTestId('comparison-card');
            expect(card).toBeInTheDocument();

            // Click Simulate Combined — card must stay.
            fireEvent.click(await screen.findByText('Simulate Combined'));
            await waitFor(() => {
                expect(screen.getByTestId('simulation-feedback')).toBeInTheDocument();
            });

            // Deselect act2 → only 1 selected → card must disappear.
            // After selection, 'act2' text appears in both the selection
            // chip and the row; click the chip's × button so we hit a
            // single, unambiguous element.
            const chip = screen.getByTestId('chip-act2');
            const closeBtn = within(chip).getByText('\u00D7');
            fireEvent.click(closeBtn);
            await waitFor(() => {
                expect(screen.queryByTestId('comparison-card')).not.toBeInTheDocument();
            });
        });

        // The card should also reset when the user leaves the Explore
        // Pairs tab (e.g. jumps back to Computed Pairs).
        it('resets the comparison card when leaving the Explore Pairs tab', async () => {
            render(<CombinedActionsModal {...defaultProps} />);
            fireEvent.click(getExploreTab());
            fireEvent.click(screen.getByText('act1'));
            fireEvent.click(screen.getByText('act2'));

            expect(await screen.findByTestId('comparison-card')).toBeInTheDocument();

            fireEvent.click(screen.getByTestId('tab-computed'));
            await waitFor(() => {
                expect(screen.queryByTestId('comparison-card')).not.toBeInTheDocument();
            });
        });
    });

    // Modal layout: the dialog should use (almost) the full viewport
    // width so wide tables fit without a horizontal scrollbar at the
    // modal level. The body container must also suppress horizontal
    // overflow so any over-wide inner element scrolls within its own
    // sub-container instead of leaking out.
    describe('modal layout width', () => {
        it('uses 95vw as its width — no fixed 950px cap', () => {
            render(<CombinedActionsModal {...defaultProps} />);
            const card = screen.getByTestId('combine-modal-card');
            expect(card.style.width).toBe('95vw');
            expect(card.style.maxWidth).toBe('95vw');
            // Regression guard: the previous hard-coded 950px width
            // caused horizontal scrolling on narrow viewports and
            // wasted space on wide ones.
            expect(card.style.width).not.toBe('950px');
        });

        it('body prevents horizontal overflow from leaking to the modal', () => {
            render(<CombinedActionsModal {...defaultProps} />);
            const body = screen.getByTestId('combine-modal-body');
            // overflowX must be explicitly hidden so tables inside
            // cannot force the modal to grow a horizontal scrollbar.
            expect(body.style.overflowX).toBe('hidden');
            // Vertical scrolling remains enabled for long content.
            expect(body.style.overflowY).toBe('auto');
            // minWidth: 0 is required so this flex child can shrink
            // below its intrinsic content width instead of forcing
            // the parent flex container to overflow.
            expect(body.style.minWidth).toBe('0px');
        });

        it('outer modal card still hides its own overflow', () => {
            render(<CombinedActionsModal {...defaultProps} />);
            const card = screen.getByTestId('combine-modal-card');
            expect(card.style.overflow).toBe('hidden');
        });

        it('anchors the card to a fixed viewport top so the title/filter header does not hop as the body height changes', () => {
            // Switching between Computed Pairs / Explore Pairs or
            // toggling a chip filter changes the body height. With
            // ``alignItems: center`` the card re-centers vertically on
            // every height change, making the title + filter header
            // jump up and down. Anchoring to the top (``flex-start`` +
            // ``marginTop: 7.5vh``) keeps the header at the same screen
            // height regardless of the body row count.
            render(<CombinedActionsModal {...defaultProps} />);
            const backdrop = screen.getByTestId('combine-modal-card').parentElement!;
            expect(backdrop.style.alignItems).toBe('flex-start');
            const card = screen.getByTestId('combine-modal-card');
            expect(card.style.marginTop).toBe('7.5vh');
            expect(card.style.maxHeight).toBe('85vh');
        });
    });

    // The Explore Pairs tab now exposes editable MW inputs for injection
    // actions. When the user edits the target MW and clicks Simulate, the
    // value must reach api.simulateManualAction as the 5th argument.
    describe('targetMw threading through Explore Pairs', () => {
        it('passes the edited injection target MW to api.simulateManualAction', async () => {
            const resultWithLS: AnalysisResult = {
                ...mockAnalysisResult,
                actions: {
                    ...mockAnalysisResult.actions,
                    'load_shedding_L1': {
                        description_unitaire: 'shed L1', max_rho: 0.6,
                        rho_before: [0.8], rho_after: [0.6], max_rho_line: 'L1',
                        is_rho_reduction: true,
                        load_shedding_details: [{ load_name: 'L1', voltage_level_id: 'VL1', shedded_mw: 5.0 }],
                    },
                },
                action_scores: {
                    'load_shedding': { scores: { 'load_shedding_L1': 5 }, mw_start: { 'load_shedding_L1': 22.0 } },
                },
            };
            const simRes = {
                action_id: 'load_shedding_L1',
                description_unitaire: 'shed L1',
                rho_before: [0.8],
                rho_after: [0.5],
                max_rho: 0.5,
                max_rho_line: 'L1',
                is_rho_reduction: true,
                non_convergence: null,
                lines_overloaded: [],
            } as unknown as SimulateResult;
            vi.mocked(api.simulateManualAction).mockResolvedValue(simRes);

            render(<CombinedActionsModal {...defaultProps} analysisResult={resultWithLS} />);
            fireEvent.click(getExploreTab());

            const input = screen.getByTestId('explore-mw-load_shedding_L1') as HTMLInputElement;
            fireEvent.change(input, { target: { value: '12' } });

            const row = screen.getByText('load_shedding_L1').closest('tr')!;
            fireEvent.click(within(row).getByText('Re-run'));

            await waitFor(() => {
                const calls = vi.mocked(api.simulateManualAction).mock.calls;
                expect(calls.length).toBe(1);
                expect(calls[0][0]).toBe('load_shedding_L1');
                expect(calls[0][4]).toBe(12);
            });
        });

        it('passes null (not undefined) when no targetMw is specified for a combined pair', async () => {
            const simRes = {
                action_id: 'act1+act2',
                description_unitaire: 'Combined',
                rho_before: [0.8],
                rho_after: [0.73],
                max_rho: 0.73,
                max_rho_line: 'L3',
                is_rho_reduction: true,
                non_convergence: null,
                lines_overloaded: [],
                is_estimated: false,
            } as unknown as SimulateResult;
            vi.mocked(api.simulateManualAction).mockResolvedValue(simRes);

            render(<CombinedActionsModal {...defaultProps} />);
            fireEvent.click(getExploreTab());
            fireEvent.click(screen.getByText('act1'));
            fireEvent.click(screen.getByText('act2'));

            const simButton = await screen.findByText('Simulate Combined');
            fireEvent.click(simButton);

            await waitFor(() => {
                const calls = vi.mocked(api.simulateManualAction).mock.calls;
                expect(calls.length).toBe(1);
                expect(calls[0][0]).toContain('+');
                expect(calls[0][4]).toBeNull();
            });
        });
    });

    // Bugs 6 & 7: simulations triggered from the modal must
    //   (1) land in the correct bucket (single → Suggested via
    //       onSimulateSingleAction; combined pair → Selected via
    //       onSimulateCombined), and
    //   (2) leave the modal open so the user can keep exploring /
    //       simulating additional rows without losing their place.
    describe('simulation dispatch & modal persistence (Bugs 6/7)', () => {
        const simResult = {
            action_id: 'act1',
            description_unitaire: 'Simulated Action 1',
            rho_before: [0.8],
            rho_after: [0.7],
            max_rho: 0.7,
            max_rho_line: 'L1',
            is_rho_reduction: true,
            non_convergence: null,
            lines_overloaded: ['LINE_A'],
        } as unknown as SimulateResult;

        it('routes a single-action Explore-Pairs simulation through onSimulateSingleAction, not onSimulateCombined', async () => {
            const onSimulateSingleAction = vi.fn();
            const onSimulateCombined = vi.fn();
            const onClose = vi.fn();
            vi.spyOn(api, 'simulateManualAction').mockResolvedValue(simResult);

            render(
                <CombinedActionsModal
                    {...defaultProps}
                    onSimulateSingleAction={onSimulateSingleAction}
                    onSimulateCombined={onSimulateCombined}
                    onClose={onClose}
                />,
            );
            fireEvent.click(getExploreTab());

            // The mock analysisResult has pre-simulated rho_after values,
            // so the per-row button is labelled "Re-run" — click any of
            // them to trigger a single-action simulation.
            const simulateButtons = await screen.findAllByText('Re-run');
            fireEvent.click(simulateButtons[0]);

            await waitFor(() => {
                expect(onSimulateSingleAction).toHaveBeenCalledTimes(1);
            });
            // Single action must NOT be promoted to Selected via
            // onSimulateCombined...
            expect(onSimulateCombined).not.toHaveBeenCalled();
            // ...and the modal must stay open.
            expect(onClose).not.toHaveBeenCalled();
        });

        it('routes a computed pair simulation through onSimulateCombined and keeps the modal open', async () => {
            const onSimulateSingleAction = vi.fn();
            const onSimulateCombined = vi.fn();
            const onClose = vi.fn();
            vi.spyOn(api, 'simulateManualAction').mockResolvedValue({
                ...simResult,
                action_id: 'act1+act2',
            } as unknown as SimulateResult);

            render(
                <CombinedActionsModal
                    {...defaultProps}
                    onSimulateSingleAction={onSimulateSingleAction}
                    onSimulateCombined={onSimulateCombined}
                    onClose={onClose}
                />,
            );

            // The Computed Pairs tab is the default. Click the first
            // "Simulate" button available for a pre-computed pair row.
            const simulateButtons = await screen.findAllByText('Simulate');
            fireEvent.click(simulateButtons[0]);

            await waitFor(() => {
                expect(onSimulateCombined).toHaveBeenCalledTimes(1);
            });
            // Combined pair id containing '+' must NOT trigger the
            // single-action path.
            expect(onSimulateSingleAction).not.toHaveBeenCalled();
            // Crucially: the modal must remain open (Bug 7).
            expect(onClose).not.toHaveBeenCalled();
        });
    });
});
