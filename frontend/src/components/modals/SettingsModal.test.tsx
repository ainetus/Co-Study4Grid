// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import SettingsModal from './SettingsModal';
import { SettingsState } from '../../hooks/useSettings';
import { interactionLogger } from '../../utils/interactionLogger';

describe('SettingsModal', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        interactionLogger.clear();
    });

    const mockSettings = {
        isSettingsOpen: true,
        settingsTab: 'paths',
        setSettingsTab: vi.fn(),
        networkPath: '/net.xiidm',
        setNetworkPath: vi.fn(),
        actionPath: '/act.json',
        setActionPath: vi.fn(),
        layoutPath: '/lay.json',
        setLayoutPath: vi.fn(),
        outputFolderPath: '/out',
        setOutputFolderPath: vi.fn(),
        configFilePath: '/conf.json',
        setConfigFilePath: vi.fn(),
        changeConfigFilePath: vi.fn().mockResolvedValue(undefined),
        minLineReconnections: 1.0,
        setMinLineReconnections: vi.fn(),
        minCloseCoupling: 1.0,
        setMinCloseCoupling: vi.fn(),
        minOpenCoupling: 1.0,
        setMinOpenCoupling: vi.fn(),
        minLineDisconnections: 1.0,
        setMinLineDisconnections: vi.fn(),
        nPrioritizedActions: 5,
        setNPrioritizedActions: vi.fn(),
        minPst: 1.0,
        setMinPst: vi.fn(),
        minLoadShedding: 0.0,
        setMinLoadShedding: vi.fn(),
        minRenewableCurtailmentActions: 0.0,
        setMinRenewableCurtailmentActions: vi.fn(),
        minRedispatch: 0.0,
        setMinRedispatch: vi.fn(),
        ignoreReconnections: false,
        setIgnoreReconnections: vi.fn(),
        monitoringFactor: 0.95,
        setMonitoringFactor: vi.fn(),
        linesMonitoringPath: '',
        setLinesMonitoringPath: vi.fn(),
        preExistingOverloadThreshold: 0.02,
        setPreExistingOverloadThreshold: vi.fn(),
        pypowsyblFastMode: true,
        setPypowsyblFastMode: vi.fn(),
        pickSettingsPath: vi.fn(),
        handleCloseSettings: vi.fn(),
    } as unknown as SettingsState;

    const defaultProps = {
        settings: mockSettings,
        onApply: vi.fn(),
    };

    it('returns null when isSettingsOpen is false', () => {
        const { container } = render(<SettingsModal {...defaultProps} settings={{ ...mockSettings, isSettingsOpen: false } as unknown as SettingsState} />);
        expect(container.firstChild).toBeNull();
    });

    it('renders Paths tab by default', () => {
        render(<SettingsModal {...defaultProps} />);
        expect(screen.getByLabelText('Network File Path (.xiidm)')).toBeInTheDocument();
        expect(screen.getByDisplayValue('/net.xiidm')).toBeInTheDocument();
    });

    it('switches tabs correctly', () => {
        render(<SettingsModal {...defaultProps} />);
        
        fireEvent.click(screen.getByText('Recommender'));
        expect(mockSettings.setSettingsTab).toHaveBeenCalledWith('recommender');

        fireEvent.click(screen.getByText('Configurations'));
        expect(mockSettings.setSettingsTab).toHaveBeenCalledWith('configurations');
    });

    it('calls setters on input change', () => {
        // Paths tab input
        render(<SettingsModal {...defaultProps} />);
        fireEvent.change(screen.getByLabelText('Network File Path (.xiidm)'), { target: { value: '/new.xiidm' } });
        expect(mockSettings.setNetworkPath).toHaveBeenCalledWith('/new.xiidm');

        // Recommender tab input (requires tab switch in real app, but here we can mock render with that tab)
        const { unmount } = render(<SettingsModal {...defaultProps} settings={{ ...mockSettings, settingsTab: 'recommender' } as unknown as SettingsState} />);
        fireEvent.change(screen.getByLabelText('Min Line Reconnections'), { target: { value: '2.5' } });
        expect(mockSettings.setMinLineReconnections).toHaveBeenCalledWith(2.5);
        unmount();

        // Checkbox input
        render(<SettingsModal {...defaultProps} settings={{ ...mockSettings, settingsTab: 'recommender' } as unknown as SettingsState} />);
        fireEvent.click(screen.getByLabelText('Ignore Reconnections'));
        expect(mockSettings.setIgnoreReconnections).toHaveBeenCalledWith(true);
    });

    it('calls apply and close callbacks', () => {
        render(<SettingsModal {...defaultProps} />);
        
        fireEvent.click(screen.getByText('Apply'));
        expect(defaultProps.onApply).toHaveBeenCalled();

        fireEvent.click(screen.getByText('Close'));
        expect(mockSettings.handleCloseSettings).toHaveBeenCalled();
    });

    it('calls pickSettingsPath on file icon click', () => {
        render(<SettingsModal {...defaultProps} />);
        const pickButtons = screen.getAllByText('📄');
        fireEvent.click(pickButtons[0]);
        expect(mockSettings.pickSettingsPath).toHaveBeenCalled();
    });

    // =====================================================================
    // Model-driven param filtering + degraded-fallback robustness
    // =====================================================================
    describe('recommender param visibility', () => {
        const recommenderSettings = (overrides: Record<string, unknown>) => ({
            ...mockSettings,
            settingsTab: 'recommender',
            recommenderModel: 'expert',
            setRecommenderModel: vi.fn(),
            computeOverflowGraph: true,
            setComputeOverflowGraph: vi.fn(),
            ...overrides,
        } as unknown as SettingsState);

        it('renders the Min Redispatch field when the active model declares it', () => {
            const settings = recommenderSettings({
                availableModels: [{
                    name: 'expert', label: 'Expert system',
                    requires_overflow_graph: true, is_default: true,
                    params: [
                        { name: 'min_redispatch', label: 'Min Redispatching', kind: 'int' },
                        { name: 'min_load_shedding', label: 'Min Load Shedding', kind: 'int' },
                    ],
                }],
            });
            render(<SettingsModal {...defaultProps} settings={settings} />);
            expect(screen.getByLabelText('Min Redispatch')).toBeInTheDocument();
            expect(screen.getByLabelText('Min Load Shedding')).toBeInTheDocument();
            // Undeclared field must stay hidden (dynamic filtering still works).
            expect(screen.queryByLabelText('Min PST Actions')).not.toBeInTheDocument();
        });

        it('REGRESSION: a model that declares NO params (degraded /api/models fallback) shows ALL fields, not none', () => {
            // When /api/models errors the frontend serves a static
            // {name:'expert', params:[]} fallback. Without the empty-params
            // guard this blanked out every parameter in the tab.
            const settings = recommenderSettings({
                availableModels: [{
                    name: 'expert', label: 'Expert system',
                    requires_overflow_graph: true, is_default: true,
                    params: [],
                }],
            });
            render(<SettingsModal {...defaultProps} settings={settings} />);
            for (const label of [
                'Min Line Reconnections', 'Min Close Coupling', 'Min Open Coupling',
                'Min Line Disconnections', 'Min PST Actions', 'Min Load Shedding',
                'Min Renewable Curtailment', 'Min Redispatch',
            ]) {
                expect(screen.getByLabelText(label)).toBeInTheDocument();
            }
        });
    });

    // =====================================================================
    // settings_tab_changed interaction log shape
    // =====================================================================
    //
    // The replay contract requires { from_tab, to_tab } so an agent can
    // assert the modal was in the expected tab before clicking the new
    // one. Before this fix the logger emitted only { tab } (the
    // destination), which lost the "where was the user coming from?"
    // information needed for verification.
    // ---------------------------------------------------------------------
    describe('settings_tab_changed interaction log shape', () => {
        it('logs { from_tab, to_tab } when switching from paths → recommender', () => {
            render(<SettingsModal {...defaultProps} />);

            fireEvent.click(screen.getByText('Recommender'));

            const log = interactionLogger.getLog();
            const tabChange = log.find(e => e.type === 'settings_tab_changed');
            expect(tabChange).toBeDefined();
            expect(tabChange!.details).toEqual({ from_tab: 'paths', to_tab: 'recommender' });
        });

        it('logs { from_tab, to_tab } when switching from paths → configurations', () => {
            render(<SettingsModal {...defaultProps} />);

            fireEvent.click(screen.getByText('Configurations'));

            const log = interactionLogger.getLog();
            const tabChange = log.find(e => e.type === 'settings_tab_changed');
            expect(tabChange).toBeDefined();
            expect(tabChange!.details).toEqual({ from_tab: 'paths', to_tab: 'configurations' });
        });

        it('records from_tab as the currently-active tab, not the initial one', () => {
            // Re-render the modal already on the "recommender" tab and
            // click "configurations": the from_tab must be 'recommender'.
            render(
                <SettingsModal
                    {...defaultProps}
                    settings={{ ...mockSettings, settingsTab: 'recommender' } as unknown as SettingsState}
                />
            );

            fireEvent.click(screen.getByText('Configurations'));

            const log = interactionLogger.getLog();
            const tabChange = log.find(e => e.type === 'settings_tab_changed');
            expect(tabChange).toBeDefined();
            expect(tabChange!.details).toEqual({ from_tab: 'recommender', to_tab: 'configurations' });
        });

        it('does NOT log when the user clicks the already-active tab (no-op skip)', () => {
            // Clicking the already-active tab is a UI no-op — it must
            // not pollute the log with empty transitions that a replay
            // agent would have to filter out. Regression guard.
            render(<SettingsModal {...defaultProps} />);

            fireEvent.click(screen.getByText('Paths'));

            const log = interactionLogger.getLog();
            expect(log.filter(e => e.type === 'settings_tab_changed')).toHaveLength(0);
            // And the setter must still not have been called with the
            // same value (idempotency in practice is fine, but we log
            // only real transitions).
        });

        it('still calls setSettingsTab even on a no-op click (setter is unconditional)', () => {
            // The setter is invoked for every click so React state
            // remains consistent with the DOM — only the logger is
            // gated on "actually changed". This test pins that exact
            // split behaviour.
            render(<SettingsModal {...defaultProps} />);

            fireEvent.click(screen.getByText('Paths'));

            expect(mockSettings.setSettingsTab).toHaveBeenCalledWith('paths');
        });
    });
});
