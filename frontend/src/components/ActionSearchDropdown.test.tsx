// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { createRef } from 'react';
import ActionSearchDropdown from './ActionSearchDropdown';
import { DEFAULT_ACTION_OVERVIEW_FILTERS } from '../utils/actionTypes';
import type { ActionDetail, ActionOverviewFilters } from '../types';

describe('ActionSearchDropdown', () => {
    const defaultProps = {
        dropdownRef: createRef<HTMLDivElement>(),
        searchInputRef: createRef<HTMLInputElement>(),
        searchQuery: '',
        onSearchQueryChange: vi.fn(),
        filters: DEFAULT_ACTION_OVERVIEW_FILTERS as ActionOverviewFilters,
        onFiltersChange: vi.fn(),
        error: null as string | null,
        loadingActions: false,
        scoredActionsList: [] as { type: string; actionId: string; score: number; mwStart: number | null }[],
        filteredActions: [] as { id: string; description: string; type?: string }[],
        actionScores: undefined as Record<string, Record<string, unknown>> | undefined,
        actions: {} as Record<string, ActionDetail>,
        cardEditMw: {} as Record<string, string>,
        onCardEditMwChange: vi.fn(),
        cardEditTap: {} as Record<string, string>,
        onCardEditTapChange: vi.fn(),
        simulating: null as string | null,
        resimulating: null as string | null,
        onAddAction: vi.fn(),
        onResimulate: vi.fn(),
        onResimulateTap: vi.fn(),
        onShowTooltip: vi.fn(),
        onHideTooltip: vi.fn(),
        monitoringFactor: 0.95,
    };

    it('renders search input with placeholder', () => {
        render(<ActionSearchDropdown {...defaultProps} />);
        expect(screen.getByPlaceholderText('Search action by ID or description...')).toBeInTheDocument();
    });

    it('renders the shared ActionFilterRings (severity + action-type rings)', () => {
        render(<ActionSearchDropdown {...defaultProps} />);
        expect(screen.getByTestId('sidebar-action-filters')).toBeInTheDocument();
        for (const t of ['disco', 'reco', 'ls', 'rc', 'pst', 'open', 'close']) {
            expect(screen.getByTestId(`sidebar-filter-type-${t}`)).toBeInTheDocument();
        }
        for (const c of ['green', 'orange', 'red', 'grey']) {
            expect(screen.getByTestId(`sidebar-filter-category-${c}`)).toBeInTheDocument();
        }
    });

    it('calls onFiltersChange when an action-type ring toggle is clicked', () => {
        const onFiltersChange = vi.fn();
        render(<ActionSearchDropdown {...defaultProps} onFiltersChange={onFiltersChange} />);
        fireEvent.click(screen.getByTestId('sidebar-filter-type-pst'));
        expect(onFiltersChange).toHaveBeenCalledWith(
            expect.objectContaining({ actionType: 'pst' }),
        );
    });

    it('marks the active action-type toggle with aria-pressed="true"', () => {
        render(
            <ActionSearchDropdown
                {...defaultProps}
                filters={{ ...DEFAULT_ACTION_OVERVIEW_FILTERS, actionType: 'disco' }}
            />,
        );
        expect(screen.getByTestId('sidebar-filter-type-disco').getAttribute('aria-pressed')).toBe('true');
        expect(screen.getByTestId('sidebar-filter-type-pst').getAttribute('aria-pressed')).toBe('false');
    });

    it('calls onSearchQueryChange when input changes', () => {
        const onSearchQueryChange = vi.fn();
        render(<ActionSearchDropdown {...defaultProps} onSearchQueryChange={onSearchQueryChange} />);
        fireEvent.change(screen.getByPlaceholderText('Search action by ID or description...'), { target: { value: 'test' } });
        expect(onSearchQueryChange).toHaveBeenCalledWith('test');
    });

    it('displays error message when error is set', () => {
        render(<ActionSearchDropdown {...defaultProps} error="Something went wrong" />);
        expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    });

    it('shows loading message when loadingActions is true', () => {
        render(<ActionSearchDropdown {...defaultProps} loadingActions={true} />);
        expect(screen.getByText('Loading actions...')).toBeInTheDocument();
    });

    it('shows "All actions already added" when no actions available and no query', () => {
        render(<ActionSearchDropdown {...defaultProps} />);
        expect(screen.getByText('All actions already added')).toBeInTheDocument();
    });

    it('renders filtered actions list', () => {
        const filteredActions = [
            { id: 'reco_1', description: 'Close line L1' },
            { id: 'reco_2', description: 'Close line L2' },
        ];
        render(<ActionSearchDropdown {...defaultProps} searchQuery="reco" filteredActions={filteredActions} />);
        expect(screen.getByText('reco_1')).toBeInTheDocument();
        expect(screen.getByText('reco_2')).toBeInTheDocument();
    });

    it('calls onAddAction when an action item is clicked', () => {
        const onAddAction = vi.fn();
        const filteredActions = [{ id: 'reco_1', description: 'Close line L1' }];
        render(<ActionSearchDropdown {...defaultProps} searchQuery="reco" filteredActions={filteredActions} onAddAction={onAddAction} />);
        fireEvent.click(screen.getByText('reco_1'));
        expect(onAddAction).toHaveBeenCalledWith('reco_1');
    });

    it('shows manual ID option when searchQuery does not match any filtered action', () => {
        render(<ActionSearchDropdown {...defaultProps} searchQuery="my_custom_action" />);
        expect(screen.getByTestId('manual-id-option-my_custom_action')).toBeInTheDocument();
        expect(screen.getByText('my_custom_action')).toBeInTheDocument();
    });

    it('calls onAddAction with manual ID when manual option is clicked', () => {
        const onAddAction = vi.fn();
        render(<ActionSearchDropdown {...defaultProps} searchQuery="manual_42" onAddAction={onAddAction} />);
        fireEvent.click(screen.getByTestId('manual-id-option-manual_42'));
        expect(onAddAction).toHaveBeenCalledWith('manual_42');
    });

    it('renders scored actions table when scored actions exist and no search query', () => {
        const scoredActionsList = [
            { type: 'line_reconnection', actionId: 'act_1', score: 10, mwStart: null },
        ];
        const actionScores = {
            line_reconnection: { scores: { act_1: 10 }, params: {} },
        };
        render(<ActionSearchDropdown {...defaultProps} scoredActionsList={scoredActionsList} actionScores={actionScores} />);
        expect(screen.getByText('Scored Actions')).toBeInTheDocument();
        expect(screen.getByText('act_1')).toBeInTheDocument();
        expect(screen.getByText('10.00')).toBeInTheDocument();
    });

    it('shows simulating state on action items', () => {
        const filteredActions = [{ id: 'act_sim', description: 'Test Action' }];
        render(<ActionSearchDropdown {...defaultProps} searchQuery="act" filteredActions={filteredActions} simulating="act_sim" />);
        expect(screen.getByText('Simulating...')).toBeInTheDocument();
    });

    describe('wide mode (centered overlay when scoring is computed)', () => {
        it('renders the narrow inline dropdown by default', () => {
            render(<ActionSearchDropdown {...defaultProps} />);
            expect(screen.getByTestId('manual-selection-dropdown')).toBeInTheDocument();
            expect(screen.queryByTestId('manual-selection-wide')).not.toBeInTheDocument();
            expect(screen.queryByTestId('manual-selection-backdrop')).not.toBeInTheDocument();
        });

        it('renders a wide centered overlay with backdrop when wide=true', () => {
            render(<ActionSearchDropdown {...defaultProps} wide />);
            expect(screen.queryByTestId('manual-selection-dropdown')).not.toBeInTheDocument();
            const wide = screen.getByTestId('manual-selection-wide');
            expect(wide).toBeInTheDocument();
            // Mirrors the Combine Actions modal layout: centered, fixed,
            // 80vw wide so the score table has room for its columns.
            const styleAttr = wide.getAttribute('style') || '';
            expect(styleAttr).toContain('position: fixed');
            expect(styleAttr).toContain('width: 80vw');
            expect(screen.getByTestId('manual-selection-backdrop')).toBeInTheDocument();
        });

        it('anchors the wide overlay to a fixed viewport top (no vertical re-centering as content grows)', () => {
            // Operators picking a chip that filters the score table down
            // to zero rows (or back up) used to see the modal hop
            // vertically: ``top: 50% / translate(-50%, -50%)`` re-centers
            // on the body's new height. The fix anchors the top of the
            // modal to a fixed viewport offset so the title + filter
            // header stay at the same screen height regardless of the
            // table's row count.
            render(<ActionSearchDropdown {...defaultProps} wide />);
            const styleAttr = screen.getByTestId('manual-selection-wide').getAttribute('style') || '';
            expect(styleAttr).toContain('top: 7.5vh');
            expect(styleAttr).toContain('translateX(-50%)');
            expect(styleAttr).not.toContain('translate(-50%, -50%)');
        });

        it('still renders the score table inside the wide overlay', () => {
            const scoredActionsList = [
                { type: 'line_reconnection', actionId: 'act_wide_1', score: 7.25, mwStart: null },
            ];
            const actionScores = {
                line_reconnection: { scores: { act_wide_1: 7.25 }, params: {} },
            };
            render(
                <ActionSearchDropdown
                    {...defaultProps}
                    scoredActionsList={scoredActionsList}
                    actionScores={actionScores}
                    wide
                />,
            );
            expect(screen.getByTestId('manual-selection-wide')).toBeInTheDocument();
            expect(screen.getByText('Scored Actions')).toBeInTheDocument();
            expect(screen.getByText('act_wide_1')).toBeInTheDocument();
            expect(screen.getByText('7.25')).toBeInTheDocument();
        });
    });

    describe('Target MW sync (Bug 1)', () => {
        // A computed load-shedding action is already in the `actions` map
        // with a simulated shedded_mw value. The score table row for that
        // action must display the simulated value by default instead of an
        // empty input, so the user can see what the action was run with.
        it('populates LS score-table input with stored shedded_mw for computed actions', () => {
            const scoredActionsList = [
                { type: 'load_shedding', actionId: 'load_shedding_L1', score: 1.0, mwStart: 6.4 },
            ];
            const actionScores = {
                load_shedding: { scores: { load_shedding_L1: 1.0 }, params: {} },
            };
            const actions: Record<string, ActionDetail> = {
                load_shedding_L1: {
                    description_unitaire: 'shed L1',
                    rho_before: null,
                    rho_after: null,
                    max_rho: 0.5,
                    max_rho_line: 'LINE_A',
                    is_rho_reduction: true,
                    load_shedding_details: [
                        { load_name: 'L1', voltage_level_id: 'VL1', shedded_mw: 5.4 },
                    ],
                },
            };
            render(
                <ActionSearchDropdown
                    {...defaultProps}
                    scoredActionsList={scoredActionsList}
                    actionScores={actionScores}
                    actions={actions}
                />,
            );
            const input = screen.getByTestId('target-mw-load_shedding_L1') as HTMLInputElement;
            expect(input.value).toBe('5.4');
        });

        // Same guarantee for renewable curtailment: the stored curtailed_mw
        // must show up as the default value for computed rows.
        it('populates RC score-table input with stored curtailed_mw for computed actions', () => {
            const scoredActionsList = [
                { type: 'renewable_curtailment', actionId: 'curtail_G1', score: 1.0, mwStart: 8.0 },
            ];
            const actionScores = {
                renewable_curtailment: { scores: { curtail_G1: 1.0 }, params: {} },
            };
            const actions: Record<string, ActionDetail> = {
                curtail_G1: {
                    description_unitaire: 'curtail G1',
                    rho_before: null,
                    rho_after: null,
                    max_rho: 0.6,
                    max_rho_line: 'LINE_B',
                    is_rho_reduction: true,
                    curtailment_details: [
                        { gen_name: 'G1', voltage_level_id: 'VL2', curtailed_mw: 3.1 },
                    ],
                },
            };
            render(
                <ActionSearchDropdown
                    {...defaultProps}
                    scoredActionsList={scoredActionsList}
                    actionScores={actionScores}
                    actions={actions}
                />,
            );
            const input = screen.getByTestId('target-mw-curtail_G1') as HTMLInputElement;
            expect(input.value).toBe('3.1');
        });

        // The cardEditMw value (written when the user edits the input on the
        // prioritized action card) must be reflected in the score table row
        // input, so the two UIs stay synchronized.
        it('mirrors cardEditMw value in the score-table input', () => {
            const onCardEditMwChange = vi.fn();
            const scoredActionsList = [
                { type: 'load_shedding', actionId: 'load_shedding_L1', score: 1.0, mwStart: 6.4 },
            ];
            const actionScores = {
                load_shedding: { scores: { load_shedding_L1: 1.0 }, params: {} },
            };
            const actions: Record<string, ActionDetail> = {
                load_shedding_L1: {
                    description_unitaire: 'shed L1',
                    rho_before: null,
                    rho_after: null,
                    max_rho: 0.5,
                    max_rho_line: 'LINE_A',
                    is_rho_reduction: true,
                    load_shedding_details: [
                        { load_name: 'L1', voltage_level_id: 'VL1', shedded_mw: 5.4 },
                    ],
                },
            };
            render(
                <ActionSearchDropdown
                    {...defaultProps}
                    scoredActionsList={scoredActionsList}
                    actionScores={actionScores}
                    actions={actions}
                    cardEditMw={{ load_shedding_L1: '4.2' }}
                    onCardEditMwChange={onCardEditMwChange}
                />,
            );
            const input = screen.getByTestId('target-mw-load_shedding_L1') as HTMLInputElement;
            // cardEditMw overrides the stored shedded_mw default.
            expect(input.value).toBe('4.2');
        });

        // Typing in the score-table row must propagate the change through
        // onCardEditMwChange (the shared edit state used by both the row and
        // the action card).
        it('forwards score-table edits through onCardEditMwChange', () => {
            const onCardEditMwChange = vi.fn();
            const scoredActionsList = [
                { type: 'load_shedding', actionId: 'load_shedding_L1', score: 1.0, mwStart: 6.4 },
            ];
            const actionScores = {
                load_shedding: { scores: { load_shedding_L1: 1.0 }, params: {} },
            };
            const actions: Record<string, ActionDetail> = {
                load_shedding_L1: {
                    description_unitaire: 'shed L1',
                    rho_before: null,
                    rho_after: null,
                    max_rho: 0.5,
                    max_rho_line: 'LINE_A',
                    is_rho_reduction: true,
                    load_shedding_details: [
                        { load_name: 'L1', voltage_level_id: 'VL1', shedded_mw: 5.4 },
                    ],
                },
            };
            render(
                <ActionSearchDropdown
                    {...defaultProps}
                    scoredActionsList={scoredActionsList}
                    actionScores={actionScores}
                    actions={actions}
                    onCardEditMwChange={onCardEditMwChange}
                />,
            );
            const input = screen.getByTestId('target-mw-load_shedding_L1');
            fireEvent.change(input, { target: { value: '4.0' } });
            expect(onCardEditMwChange).toHaveBeenCalledWith('load_shedding_L1', '4.0');
        });

        // A non-computed LS row (no action detail yet) should render an
        // empty input — the stored-MW fallback only applies once the action
        // has been simulated.
        it('leaves LS input empty for non-computed actions', () => {
            const scoredActionsList = [
                { type: 'load_shedding', actionId: 'load_shedding_L2', score: 1.0, mwStart: 6.4 },
            ];
            const actionScores = {
                load_shedding: { scores: { load_shedding_L2: 1.0 }, params: {} },
            };
            render(
                <ActionSearchDropdown
                    {...defaultProps}
                    scoredActionsList={scoredActionsList}
                    actionScores={actionScores}
                    actions={{}}
                />,
            );
            const input = screen.getByTestId('target-mw-load_shedding_L2') as HTMLInputElement;
            expect(input.value).toBe('');
        });
    });

    // Redispatch actions edit a SIGNED delta (raise > 0 / lower < 0), not an
    // absolute target. They get a dedicated "Δ MW" column in the score table,
    // mirroring the editable increment already shown on the action card.
    describe('Redispatch delta column', () => {
        const redispatchScores = {
            redispatch: { scores: { redispatch_G1: 1.0 }, params: {} },
        };
        const scoredRedispatch = [
            { type: 'redispatch', actionId: 'redispatch_G1', score: 1.0, mwStart: 14.3 },
        ];
        const computedRedispatch: Record<string, ActionDetail> = {
            redispatch_G1: {
                description_unitaire: 'redispatch G1',
                rho_before: null,
                rho_after: null,
                max_rho: 0.8,
                max_rho_line: 'LINE_A',
                is_rho_reduction: true,
                redispatch_details: [
                    { gen_name: 'G1', voltage_level_id: 'VL1', delta_mw: 10.0, target_mw: 24.3, direction: 'up', current_mw: 14.3, max_raise_mw: 30.0, max_lower_mw: 14.3 },
                ],
            },
        };

        it('renders the Δ MW header and an editable delta input for redispatch rows', () => {
            render(
                <ActionSearchDropdown
                    {...defaultProps}
                    scoredActionsList={scoredRedispatch}
                    actionScores={redispatchScores}
                    actions={{}}
                />,
            );
            expect(screen.getByText('Δ MW')).toBeInTheDocument();
            expect(screen.getByTestId('delta-mw-redispatch_G1')).toBeInTheDocument();
        });

        it('populates the delta input with the simulated delta_mw for computed actions', () => {
            render(
                <ActionSearchDropdown
                    {...defaultProps}
                    scoredActionsList={scoredRedispatch}
                    actionScores={redispatchScores}
                    actions={computedRedispatch}
                />,
            );
            const input = screen.getByTestId('delta-mw-redispatch_G1') as HTMLInputElement;
            expect(input.value).toBe('10.0');
        });

        it('leaves the delta input empty for non-computed redispatch rows', () => {
            render(
                <ActionSearchDropdown
                    {...defaultProps}
                    scoredActionsList={scoredRedispatch}
                    actionScores={redispatchScores}
                    actions={{}}
                />,
            );
            const input = screen.getByTestId('delta-mw-redispatch_G1') as HTMLInputElement;
            expect(input.value).toBe('');
        });

        it('forwards delta edits through onCardEditMwChange', () => {
            const onCardEditMwChange = vi.fn();
            render(
                <ActionSearchDropdown
                    {...defaultProps}
                    scoredActionsList={scoredRedispatch}
                    actionScores={redispatchScores}
                    actions={{}}
                    onCardEditMwChange={onCardEditMwChange}
                />,
            );
            fireEvent.change(screen.getByTestId('delta-mw-redispatch_G1'), { target: { value: '-5' } });
            expect(onCardEditMwChange).toHaveBeenCalledWith('redispatch_G1', '-5');
        });

        it('adds a non-computed redispatch action with the typed delta as target MW', () => {
            const onAddAction = vi.fn();
            render(
                <ActionSearchDropdown
                    {...defaultProps}
                    scoredActionsList={scoredRedispatch}
                    actionScores={redispatchScores}
                    actions={{}}
                    cardEditMw={{ redispatch_G1: '8' }}
                    onAddAction={onAddAction}
                />,
            );
            // Click the row (not the input) to add the action.
            fireEvent.click(screen.getByTestId('score-redispatch_G1'));
            expect(onAddAction).toHaveBeenCalledWith('redispatch_G1', 8, undefined);
        });

        it('re-simulates a computed redispatch action when the delta is edited', () => {
            const onResimulate = vi.fn();
            render(
                <ActionSearchDropdown
                    {...defaultProps}
                    scoredActionsList={scoredRedispatch}
                    actionScores={redispatchScores}
                    actions={computedRedispatch}
                    cardEditMw={{ redispatch_G1: '15' }}
                    onResimulate={onResimulate}
                />,
            );
            fireEvent.click(screen.getByTestId('score-redispatch_G1'));
            expect(onResimulate).toHaveBeenCalledWith('redispatch_G1', 15);
        });
    });

    // Regression: once "Analyze & Suggest" has produced action scores,
    // applying a type filter may filter the score list down to zero.
    // Previously the dropdown silently fell back to the full network
    // action list, which misled the operator into thinking the
    // analysis recommended any of those actions. A yellow warning
    // banner must now tell them that no scored action matched the
    // selected type. The banner is suppressed when the analysis
    // hasn't been run (actionScores undefined) or when the 'all'
    // filter is active, to avoid false positives.
    describe('no-relevant-action warning (after analyze & suggest)', () => {
        it('shows the warning when actionScores are non-empty but the type filter hides them all', () => {
            const actionScores = {
                pst_tap_change: {
                    scores: { 'pst-A': 5 },
                    params: {},
                },
            };
            render(
                <ActionSearchDropdown
                    {...defaultProps}
                    // Type filter is RECO but the only scored action is a PST.
                    filters={{ ...DEFAULT_ACTION_OVERVIEW_FILTERS, actionType: 'reco' }}
                    scoredActionsList={[]}
                    actionScores={actionScores}
                />,
            );
            const banner = screen.getByTestId('no-relevant-action-warning');
            expect(banner).toBeInTheDocument();
            expect(banner.textContent).toMatch(/no relevant action detected/i);
        });

        it('does NOT show the warning when actionScores is undefined (analysis not yet run)', () => {
            render(
                <ActionSearchDropdown
                    {...defaultProps}
                    filters={{ ...DEFAULT_ACTION_OVERVIEW_FILTERS, actionType: 'reco' }}
                    scoredActionsList={[]}
                    actionScores={undefined}
                />,
            );
            expect(screen.queryByTestId('no-relevant-action-warning')).not.toBeInTheDocument();
        });

        it('does NOT show the warning when actionScores is empty (analysis ran but produced nothing)', () => {
            render(
                <ActionSearchDropdown
                    {...defaultProps}
                    filters={{ ...DEFAULT_ACTION_OVERVIEW_FILTERS, actionType: 'reco' }}
                    scoredActionsList={[]}
                    actionScores={{}}
                />,
            );
            expect(screen.queryByTestId('no-relevant-action-warning')).not.toBeInTheDocument();
        });

        it('does NOT show the warning under the `all` filter (user is not filtering by type)', () => {
            const actionScores = {
                pst_tap_change: { scores: { 'pst-A': 5 }, params: {} },
            };
            render(
                <ActionSearchDropdown
                    {...defaultProps}
                    filters={{ ...DEFAULT_ACTION_OVERVIEW_FILTERS, actionType: 'all' }}
                    scoredActionsList={[]}
                    actionScores={actionScores}
                />,
            );
            expect(screen.queryByTestId('no-relevant-action-warning')).not.toBeInTheDocument();
        });

        it('does NOT show the warning when there is at least one scored action after filtering', () => {
            const actionScores = {
                pst_tap_change: { scores: { 'pst-A': 5 }, params: {} },
            };
            render(
                <ActionSearchDropdown
                    {...defaultProps}
                    filters={{ ...DEFAULT_ACTION_OVERVIEW_FILTERS, actionType: 'pst' }}
                    scoredActionsList={[
                        { type: 'pst_tap_change', actionId: 'pst-A', score: 5, mwStart: null },
                    ]}
                    actionScores={actionScores}
                />,
            );
            expect(screen.queryByTestId('no-relevant-action-warning')).not.toBeInTheDocument();
        });

        it('does NOT show the warning while the user is typing in the search box', () => {
            const actionScores = {
                pst_tap_change: { scores: { 'pst-A': 5 }, params: {} },
            };
            render(
                <ActionSearchDropdown
                    {...defaultProps}
                    searchQuery="foo"
                    filters={{ ...DEFAULT_ACTION_OVERVIEW_FILTERS, actionType: 'reco' }}
                    scoredActionsList={[]}
                    actionScores={actionScores}
                />,
            );
            expect(screen.queryByTestId('no-relevant-action-warning')).not.toBeInTheDocument();
        });
    });

    // Operator-requested addition: a "Simulated Max ρ" column in the
    // score table so the user can compare action effectiveness from
    // inside the manual-selection modal without bouncing back to the
    // action card stack. Pending rows render an em-dash; simulated
    // rows show the max-ρ percentage with the same green / orange /
    // red severity colouring the ActionCard uses, and divergent /
    // islanded simulations render the matching warning label.
    describe('Simulated Max ρ column', () => {
        const baseScored = [
            { type: 'line_reconnection', actionId: 'reco_1', score: 5, mwStart: null },
        ];
        const baseScores = {
            line_reconnection: { scores: { reco_1: 5 }, params: {} },
        };

        it('renders the column header in the score table', () => {
            render(
                <ActionSearchDropdown
                    {...defaultProps}
                    scoredActionsList={baseScored}
                    actionScores={baseScores}
                />,
            );
            expect(screen.getByText(/Simulated Max/i)).toBeInTheDocument();
        });

        it('renders an em-dash for an unsimulated row', () => {
            render(
                <ActionSearchDropdown
                    {...defaultProps}
                    scoredActionsList={baseScored}
                    actionScores={baseScores}
                />,
            );
            const cell = screen.getByTestId('sim-max-rho-reco_1');
            expect(cell.getAttribute('data-state')).toBe('pending');
            expect(cell.textContent).toBe('—');
        });

        it('renders the green-severity max ρ once the action has been simulated below the monitoring band', () => {
            const actions: Record<string, ActionDetail> = {
                reco_1: {
                    description_unitaire: 'r1',
                    rho_before: [1.05],
                    rho_after: [0.5],
                    max_rho: 0.5,
                    max_rho_line: 'LINE_A',
                    is_rho_reduction: true,
                },
            };
            render(
                <ActionSearchDropdown
                    {...defaultProps}
                    scoredActionsList={baseScored}
                    actionScores={baseScores}
                    actions={actions}
                />,
            );
            const cell = screen.getByTestId('sim-max-rho-reco_1');
            expect(cell.getAttribute('data-state')).toBe('green');
            expect(cell.textContent).toBe('50.0%');
            expect(cell.getAttribute('title')).toBe('Max ρ on LINE_A');
        });

        it('renders orange severity when max_rho is in the (mf - 0.05, mf] band', () => {
            const actions: Record<string, ActionDetail> = {
                reco_1: {
                    description_unitaire: 'r1',
                    rho_before: [1.05],
                    rho_after: [0.92],
                    // monitoringFactor = 0.95 (default). 0.92 is in
                    // (mf - 0.05, mf] → orange.
                    max_rho: 0.92,
                    max_rho_line: 'LINE_A',
                    is_rho_reduction: true,
                },
            };
            render(
                <ActionSearchDropdown
                    {...defaultProps}
                    scoredActionsList={baseScored}
                    actionScores={baseScores}
                    actions={actions}
                />,
            );
            expect(screen.getByTestId('sim-max-rho-reco_1').getAttribute('data-state')).toBe('orange');
        });

        it('renders red severity when max_rho is above the monitoring factor', () => {
            const actions: Record<string, ActionDetail> = {
                reco_1: {
                    description_unitaire: 'r1',
                    rho_before: [1.05],
                    rho_after: [1.02],
                    max_rho: 1.02,
                    max_rho_line: 'LINE_A',
                    is_rho_reduction: false,
                },
            };
            render(
                <ActionSearchDropdown
                    {...defaultProps}
                    scoredActionsList={baseScored}
                    actionScores={baseScores}
                    actions={actions}
                />,
            );
            const cell = screen.getByTestId('sim-max-rho-reco_1');
            expect(cell.getAttribute('data-state')).toBe('red');
            expect(cell.textContent).toBe('102.0%');
        });

        it('renders a "divergent" label for a non-convergent simulation', () => {
            const actions: Record<string, ActionDetail> = {
                reco_1: {
                    description_unitaire: 'r1',
                    rho_before: null,
                    rho_after: null,
                    // Backend writes max_rho = 0 on non-convergence — the
                    // numeric value must NOT leak as "0.0%". The
                    // non_convergence flag wins.
                    max_rho: 0,
                    max_rho_line: 'N/A',
                    is_rho_reduction: false,
                    non_convergence: 'LoadFlow failure: foo',
                },
            };
            render(
                <ActionSearchDropdown
                    {...defaultProps}
                    scoredActionsList={baseScored}
                    actionScores={baseScores}
                    actions={actions}
                />,
            );
            const cell = screen.getByTestId('sim-max-rho-reco_1');
            expect(cell.getAttribute('data-state')).toBe('divergent');
            expect(cell.textContent).toBe('divergent');
            expect(cell.getAttribute('title')).toContain('LoadFlow failure');
        });

        it('renders an "islanded" label for an islanded simulation', () => {
            const actions: Record<string, ActionDetail> = {
                reco_1: {
                    description_unitaire: 'r1',
                    rho_before: null,
                    rho_after: null,
                    max_rho: 0.4,
                    max_rho_line: 'LINE_A',
                    is_rho_reduction: false,
                    is_islanded: true,
                    disconnected_mw: 42.5,
                },
            };
            render(
                <ActionSearchDropdown
                    {...defaultProps}
                    scoredActionsList={baseScored}
                    actionScores={baseScores}
                    actions={actions}
                />,
            );
            const cell = screen.getByTestId('sim-max-rho-reco_1');
            expect(cell.getAttribute('data-state')).toBe('islanded');
            expect(cell.textContent).toBe('islanded');
            expect(cell.getAttribute('title')).toContain('42.5 MW');
        });
    });

    // Mirrors the ``Simulated Line`` column in
    // ``ComputedPairsTable`` — surfaces the branch carrying max ρ on
    // the post-action observation, resolved through ``displayName``
    // so the operator sees the friendly pypowsybl substation pair
    // (e.g. ``BEON L31CPVAN``) instead of the raw element ID. Pending
    // rows and faulted simulations (divergent / islanded) render an
    // em-dash because the post-action max-ρ branch is not meaningful
    // in those cases.
    describe('Simulated Line column', () => {
        const baseScored = [
            { type: 'line_reconnection', actionId: 'reco_1', score: 5, mwStart: null },
        ];
        const baseScores = {
            line_reconnection: { scores: { reco_1: 5 }, params: {} },
        };

        it('renders the column header in the score table', () => {
            render(
                <ActionSearchDropdown
                    {...defaultProps}
                    scoredActionsList={baseScored}
                    actionScores={baseScores}
                />,
            );
            expect(screen.getByText('Simulated Line')).toBeInTheDocument();
        });

        it('renders an em-dash for an unsimulated row', () => {
            render(
                <ActionSearchDropdown
                    {...defaultProps}
                    scoredActionsList={baseScored}
                    actionScores={baseScores}
                />,
            );
            const cell = screen.getByTestId('sim-line-reco_1');
            expect(cell.getAttribute('data-state')).toBe('pending');
            expect(cell.textContent).toBe('—');
        });

        it('renders displayName(max_rho_line) once the action has been simulated', () => {
            const actions: Record<string, ActionDetail> = {
                reco_1: {
                    description_unitaire: 'r1',
                    rho_before: [1.05],
                    rho_after: [0.85],
                    max_rho: 0.85,
                    max_rho_line: 'BRANCH_ID_42',
                    is_rho_reduction: true,
                },
            };
            const displayName = (id: string) => id === 'BRANCH_ID_42' ? 'BEON L31CPVAN' : id;
            render(
                <ActionSearchDropdown
                    {...defaultProps}
                    scoredActionsList={baseScored}
                    actionScores={baseScores}
                    actions={actions}
                    displayName={displayName}
                />,
            );
            const cell = screen.getByTestId('sim-line-reco_1');
            expect(cell.getAttribute('data-state')).toBe('resolved');
            expect(cell.textContent).toBe('BEON L31CPVAN');
            // Raw ID still on the title so the operator can copy it
            // if they need to debug at the data layer.
            expect(cell.getAttribute('title')).toBe('BRANCH_ID_42');
        });

        it('falls back to the raw id when displayName has no mapping', () => {
            const actions: Record<string, ActionDetail> = {
                reco_1: {
                    description_unitaire: 'r1',
                    rho_before: [1.05],
                    rho_after: [0.85],
                    max_rho: 0.85,
                    max_rho_line: 'UNMAPPED_LINE',
                    is_rho_reduction: true,
                },
            };
            render(
                <ActionSearchDropdown
                    {...defaultProps}
                    scoredActionsList={baseScored}
                    actionScores={baseScores}
                    actions={actions}
                />,
            );
            expect(screen.getByTestId('sim-line-reco_1').textContent).toBe('UNMAPPED_LINE');
        });

        it('renders an em-dash for a divergent simulation', () => {
            const actions: Record<string, ActionDetail> = {
                reco_1: {
                    description_unitaire: 'r1',
                    rho_before: null,
                    rho_after: null,
                    max_rho: 0,
                    max_rho_line: 'N/A',
                    is_rho_reduction: false,
                    non_convergence: 'LoadFlow failure',
                },
            };
            render(
                <ActionSearchDropdown
                    {...defaultProps}
                    scoredActionsList={baseScored}
                    actionScores={baseScores}
                    actions={actions}
                />,
            );
            const cell = screen.getByTestId('sim-line-reco_1');
            expect(cell.getAttribute('data-state')).toBe('unavailable');
            expect(cell.textContent).toBe('—');
        });

        it('renders an em-dash for an islanded simulation', () => {
            const actions: Record<string, ActionDetail> = {
                reco_1: {
                    description_unitaire: 'r1',
                    rho_before: null,
                    rho_after: null,
                    max_rho: 0.4,
                    max_rho_line: 'LINE_A',
                    is_rho_reduction: false,
                    is_islanded: true,
                    disconnected_mw: 12,
                },
            };
            render(
                <ActionSearchDropdown
                    {...defaultProps}
                    scoredActionsList={baseScored}
                    actionScores={baseScores}
                    actions={actions}
                />,
            );
            const cell = screen.getByTestId('sim-line-reco_1');
            expect(cell.getAttribute('data-state')).toBe('unavailable');
            expect(cell.textContent).toBe('—');
        });
    });

    // Score column moved to position 2 (right after the Action
    // name) so the ranking is visible without the operator's eye
    // having to scan past the per-row MW / tap inputs. Pin both the
    // header order AND the row cell order so a future drag-resize
    // or re-shuffle can't silently regress it.
    describe('Score column position', () => {
        const baseScored = [
            { type: 'line_reconnection', actionId: 'reco_1', score: 7.25, mwStart: null },
        ];
        const baseScores = {
            line_reconnection: { scores: { reco_1: 7.25 }, params: {} },
        };

        it('renders the Score header in the second column (right after Action)', () => {
            render(
                <ActionSearchDropdown
                    {...defaultProps}
                    scoredActionsList={baseScored}
                    actionScores={baseScores}
                />,
            );
            const headers = screen.getAllByRole('columnheader');
            expect(headers[0].textContent).toBe('Action');
            expect(headers[1].textContent).toBe('Score');
        });

        it('renders the score value cell in the second column of the data row', () => {
            render(
                <ActionSearchDropdown
                    {...defaultProps}
                    scoredActionsList={baseScored}
                    actionScores={baseScores}
                />,
            );
            const actionRow = screen.getAllByRole('row').find(r => r.textContent?.includes('reco_1'));
            const cells = actionRow!.querySelectorAll('td');
            // Column 0 = action name; column 1 = score (newly moved).
            expect(cells[0].textContent).toContain('reco_1');
            expect(cells[1].textContent).toBe('7.25');
            expect(screen.getByTestId('score-reco_1').textContent).toBe('7.25');
        });
    });

    // Operator-requested addition: the wide modal now stays mounted
    // across multiple simulations (see
    // ``ActionFeed.handleAddAction``), so it needs an explicit
    // dismiss affordance. Matches the Combine Actions modal close
    // button (``CombinedActionsModal.tsx:391``). The narrow inline
    // dropdown does not get a header — it relies on outside-click
    // dismissal as before.
    describe('Close button (wide mode)', () => {
        it('renders the close button only when wide AND onClose is wired', () => {
            const onClose = vi.fn();
            render(<ActionSearchDropdown {...defaultProps} wide onClose={onClose} />);
            expect(screen.getByTestId('manual-selection-close')).toBeInTheDocument();
        });

        it('does not render the close button in narrow mode', () => {
            const onClose = vi.fn();
            render(<ActionSearchDropdown {...defaultProps} onClose={onClose} />);
            expect(screen.queryByTestId('manual-selection-close')).not.toBeInTheDocument();
        });

        it('does not render the close button when onClose is omitted', () => {
            render(<ActionSearchDropdown {...defaultProps} wide />);
            expect(screen.queryByTestId('manual-selection-close')).not.toBeInTheDocument();
        });

        it('invokes onClose when the close button is clicked', () => {
            const onClose = vi.fn();
            render(<ActionSearchDropdown {...defaultProps} wide onClose={onClose} />);
            fireEvent.click(screen.getByTestId('manual-selection-close'));
            expect(onClose).toHaveBeenCalledTimes(1);
        });

        it('uses the multiplication-sign glyph (×) so it matches the Combine modal', () => {
            const onClose = vi.fn();
            render(<ActionSearchDropdown {...defaultProps} wide onClose={onClose} />);
            // &times; → ×
            expect(screen.getByTestId('manual-selection-close').textContent).toBe('×');
        });
    });
});
