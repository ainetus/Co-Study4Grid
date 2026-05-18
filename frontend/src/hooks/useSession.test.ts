// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSession, type RestoreContext } from './useSession';
import { interactionLogger } from '../utils/interactionLogger';
import type { SessionResult, AnalysisResult } from '../types';

// Mock the api module
const mockSaveSession = vi.fn();
const mockListSessions = vi.fn();
const mockLoadSession = vi.fn();
const mockUpdateConfig = vi.fn();
const mockGetBranches = vi.fn();
const mockGetVoltageLevels = vi.fn();
const mockGetNominalVoltages = vi.fn();
const mockGetNetworkDiagram = vi.fn().mockResolvedValue({ svg: '<svg/>', metadata: null });
const mockRestoreAnalysisContext = vi.fn().mockResolvedValue({
    status: 'success',
    lines_we_care_about_count: 0,
    computed_pairs_count: 0,
});

vi.mock('../api', () => ({
    api: {
        saveSession: (...args: unknown[]) => mockSaveSession(...args),
        listSessions: (...args: unknown[]) => mockListSessions(...args),
        loadSession: (...args: unknown[]) => mockLoadSession(...args),
        updateConfig: (...args: unknown[]) => mockUpdateConfig(...args),
        getBranches: (...args: unknown[]) => mockGetBranches(...args),
        getVoltageLevels: (...args: unknown[]) => mockGetVoltageLevels(...args),
        getNominalVoltages: (...args: unknown[]) => mockGetNominalVoltages(...args),
        getNetworkDiagram: (...args: unknown[]) => mockGetNetworkDiagram(...args),
        restoreAnalysisContext: (...args: unknown[]) => mockRestoreAnalysisContext(...args),
    },
}));

vi.mock('../utils/sessionUtils', () => ({
    buildSessionResult: vi.fn().mockReturnValue({
        saved_at: '2026-03-27T12:00:00.000Z',
        configuration: {},
        contingency: { disconnected_elements: [], selected_overloads: [], monitor_deselected: false },
        overloads: { n_overloads: [], n1_overloads: [], resolved_overloads: [] },
        overflow_graph: null,
        analysis: null,
        interaction_log: [],
    }),
}));

describe('useSession — interaction logging', () => {
    beforeEach(() => {
        interactionLogger.clear();
        vi.clearAllMocks();
    });

    const makeSaveParams = (overrides: Record<string, unknown> = {}) => ({
        networkPath: '/data/net.xiidm',
        actionPath: '/data/actions.json',
        layoutPath: '',
        outputFolderPath: '/tmp/output',
        minLineReconnections: 2, minCloseCoupling: 3, minOpenCoupling: 2, minLineDisconnections: 3,
        minPst: 1, minLoadShedding: 0, minRenewableCurtailmentActions: 0, nPrioritizedActions: 10,
        linesMonitoringPath: '', monitoringFactor: 0.95, preExistingOverloadThreshold: 0.02,
        ignoreReconnections: false, pypowsyblFastMode: true,
        selectedContingency: ['LINE_A'], selectedOverloads: new Set(['OL1']), monitorDeselected: false,
        nOverloads: [] as string[], n1Overloads: ['OL1'],
        result: null,
        selectedActionIds: new Set<string>(), rejectedActionIds: new Set<string>(),
        manuallyAddedIds: new Set<string>(), suggestedByRecommenderIds: new Set<string>(),
        setInfoMessage: vi.fn(), setError: vi.fn(),
        ...overrides,
    });

    it('logs session_saved when handleSaveResults is called with output folder', async () => {
        mockSaveSession.mockResolvedValue({ session_folder: '/tmp/session_1', pdf_copied: false });

        const { result } = renderHook(() => useSession());

        await act(async () => {
            await result.current.handleSaveResults(makeSaveParams());
        });

        const log = interactionLogger.getLog();
        expect(log).toHaveLength(1);
        expect(log[0].type).toBe('session_saved');
        expect(log[0].details).toEqual({ output_folder: '/tmp/output' });
    });

    it('logs session_saved even for browser download (no output folder)', async () => {
        // Render the hook FIRST before mocking document.createElement
        const { result } = renderHook(() => useSession());

        // Now mock DOM for download
        const mockAnchor = document.createElement('a');
        const clickSpy = vi.spyOn(mockAnchor, 'click').mockImplementation(() => {});
        const createElementSpy = vi.spyOn(document, 'createElement').mockReturnValue(mockAnchor);
        vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test');
        vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

        await act(async () => {
            await result.current.handleSaveResults(makeSaveParams({ outputFolderPath: '', selectedContingency: [] }));
        });

        const log = interactionLogger.getLog();
        expect(log).toHaveLength(1);
        expect(log[0].type).toBe('session_saved');
        expect(log[0].details).toEqual({ output_folder: '' });
        expect(clickSpy).toHaveBeenCalled();

        createElementSpy.mockRestore();
    });

    it('logs session_reload_modal_opened when handleOpenReloadModal is called', async () => {
        mockListSessions.mockResolvedValue({ sessions: ['session_1', 'session_2'] });

        const { result } = renderHook(() => useSession());
        const setError = vi.fn();

        await act(async () => {
            await result.current.handleOpenReloadModal('/tmp/output', setError);
        });

        const log = interactionLogger.getLog();
        expect(log).toHaveLength(1);
        expect(log[0].type).toBe('session_reload_modal_opened');
    });

    it('logs session_reload_modal_opened even when outputFolderPath is empty (before error)', async () => {
        const { result } = renderHook(() => useSession());
        const setError = vi.fn();

        await act(async () => {
            await result.current.handleOpenReloadModal('', setError);
        });

        const log = interactionLogger.getLog();
        expect(log).toHaveLength(1);
        expect(log[0].type).toBe('session_reload_modal_opened');
        expect(setError).toHaveBeenCalled();
    });

    it('passes interaction_log to api.saveSession', async () => {
        mockSaveSession.mockResolvedValue({ session_folder: '/tmp/s', pdf_copied: false });

        // Record some interactions first
        interactionLogger.record('zoom_in');
        interactionLogger.record('config_loaded', { path: '/data' });

        const { result } = renderHook(() => useSession());

        await act(async () => {
            await result.current.handleSaveResults(makeSaveParams());
        });

        expect(mockSaveSession).toHaveBeenCalledTimes(1);
        const callArgs = mockSaveSession.mock.calls[0][0];
        expect(callArgs.interaction_log).toBeDefined();
        // Should be valid JSON containing our logged events
        const parsed = JSON.parse(callArgs.interaction_log);
        expect(Array.isArray(parsed)).toBe(true);
        // At least the two we recorded plus the session_saved event
        expect(parsed.length).toBeGreaterThanOrEqual(3);
    });

    it('handleSaveResults passes interactionLog to buildSessionResult', async () => {
        mockSaveSession.mockResolvedValue({ session_folder: '/tmp/s', pdf_copied: false });
        const { buildSessionResult } = await import('../utils/sessionUtils');

        interactionLogger.record('zoom_in');

        const { result } = renderHook(() => useSession());

        await act(async () => {
            await result.current.handleSaveResults(makeSaveParams({ networkPath: '', actionPath: '', selectedContingency: [] }));
        });

        expect(buildSessionResult).toHaveBeenCalledTimes(1);
        const buildArgs = (buildSessionResult as ReturnType<typeof vi.fn>).mock.calls[0][0];
        expect(buildArgs.interactionLog).toBeDefined();
        expect(Array.isArray(buildArgs.interactionLog)).toBe(true);
    });
});

// ===========================================================================
// handleRestoreSession — session reload fidelity
// ===========================================================================
//
// These tests guard the fixes that land alongside PRs #73, #78, #83 and
// #88: enrichment fields (load_shedding_details / curtailment_details /
// pst_details / lines_overloaded_after) must survive a save/reload
// round-trip, committedNetworkPathRef must be updated on restore so the
// "Change Network?" confirmation dialog doesn't misfire, and the new
// recommender thresholds (min_load_shedding,
// min_renewable_curtailment_actions) must be restored even when the
// session JSON predates them.
//
// The tests mock the api module at the top of this file; each restore
// test wires a fresh RestoreContext with vi.fn() setters so it can
// assert exactly which values were pushed into App state.
// ---------------------------------------------------------------------------

describe('useSession — handleRestoreSession', () => {
    beforeEach(() => {
        interactionLogger.clear();
        vi.clearAllMocks();
        mockUpdateConfig.mockResolvedValue({});
        mockGetBranches.mockResolvedValue({ branches: ['LINE_A', 'LINE_B'], name_map: {} });
        mockGetVoltageLevels.mockResolvedValue({ voltage_levels: ['VL_1', 'VL_2'], name_map: {} });
        mockGetNominalVoltages.mockResolvedValue({
            mapping: { VL_1: 400, VL_2: 225 },
            unique_kv: [225, 400],
        });
    });

    /** Build a minimal but valid RestoreContext with vi.fn() setters. */
    const makeCtx = (
        overrides: Partial<RestoreContext> = {},
    ): RestoreContext & {
        // Expose the refs for assertions.
        restoringSessionRef: { current: boolean };
        committedBranchRef: { current: string };
        committedNetworkPathRef: { current: string };
    } => ({
        outputFolderPath: '/tmp/output',
        setNetworkPath: vi.fn(),
        setActionPath: vi.fn(),
        setLayoutPath: vi.fn(),
        setMinLineReconnections: vi.fn(),
        setMinCloseCoupling: vi.fn(),
        setMinOpenCoupling: vi.fn(),
        setMinLineDisconnections: vi.fn(),
        setMinPst: vi.fn(),
        setMinLoadShedding: vi.fn(),
        setMinRenewableCurtailmentActions: vi.fn(),
        setNPrioritizedActions: vi.fn(),
        setLinesMonitoringPath: vi.fn(),
        setMonitoringFactor: vi.fn(),
        setPreExistingOverloadThreshold: vi.fn(),
        setIgnoreReconnections: vi.fn(),
        setPypowsyblFastMode: vi.fn(),
        applyConfigResponse: vi.fn(),
        setBranches: vi.fn(),
        setVoltageLevels: vi.fn(),
        setNameMap: vi.fn(),
        setNominalVoltageMap: vi.fn(),
        setUniqueVoltages: vi.fn(),
        setVoltageRange: vi.fn(),
        fetchBaseDiagram: vi.fn(),
        ingestBaseDiagram: vi.fn(),
        setMonitorDeselected: vi.fn(),
        setSelectedOverloads: vi.fn(),
        setResult: vi.fn(),
        setSelectedActionIds: vi.fn(),
        setRejectedActionIds: vi.fn(),
        setManuallyAddedIds: vi.fn(),
        setSuggestedByRecommenderIds: vi.fn(),
        restoringSessionRef: { current: false },
        committedBranchRef: { current: '' },
        committedNetworkPathRef: { current: '' },
        setSelectedContingency: vi.fn(),
        setInfoMessage: vi.fn(),
        setError: vi.fn(),
        ...overrides,
    } as unknown as RestoreContext & {
        restoringSessionRef: { current: boolean };
        committedBranchRef: { current: string };
        committedNetworkPathRef: { current: string };
    });

    /** Minimal SessionResult builder with sensible defaults. */
    const makeSession = (overrides: Partial<SessionResult> = {}): SessionResult => ({
        saved_at: '2026-04-14T10:00:00.000Z',
        configuration: {
            network_path: '/data/net.xiidm',
            action_file_path: '/data/actions.json',
            layout_path: '/data/layout.json',
            min_line_reconnections: 2.0,
            min_close_coupling: 3.0,
            min_open_coupling: 2.0,
            min_line_disconnections: 3.0,
            min_pst: 1.5,
            min_load_shedding: 2.5,
            min_renewable_curtailment_actions: 1.25,
            n_prioritized_actions: 8,
            lines_monitoring_path: '/data/monitoring.csv',
            monitoring_factor: 0.93,
            pre_existing_overload_threshold: 0.04,
            ignore_reconnections: true,
            pypowsybl_fast_mode: false,
        },
        contingency: {
            disconnected_elements: ['LINE_A'],
            selected_overloads: ['LINE_OL1', 'LINE_OL2'],
            monitor_deselected: true,
        },
        overloads: {
            n_overloads: [],
            n1_overloads: ['LINE_OL1', 'LINE_OL2'],
            resolved_overloads: ['LINE_OL1'],
        },
        overflow_graph: null,
        analysis: null,
        ...overrides,
    });

    it('restores every configuration field, including new load-shedding / curtailment thresholds', async () => {
        mockLoadSession.mockResolvedValue(makeSession());
        const ctx = makeCtx();

        const { result } = renderHook(() => useSession());

        await act(async () => {
            await result.current.handleRestoreSession('session_abc', ctx);
        });

        // Paths
        expect(ctx.setNetworkPath).toHaveBeenCalledWith('/data/net.xiidm');
        expect(ctx.setActionPath).toHaveBeenCalledWith('/data/actions.json');
        expect(ctx.setLayoutPath).toHaveBeenCalledWith('/data/layout.json');

        // Recommender thresholds — the two values added by PR #73 / #78
        // are the specific regression this test is guarding against.
        expect(ctx.setMinLineReconnections).toHaveBeenCalledWith(2.0);
        expect(ctx.setMinCloseCoupling).toHaveBeenCalledWith(3.0);
        expect(ctx.setMinOpenCoupling).toHaveBeenCalledWith(2.0);
        expect(ctx.setMinLineDisconnections).toHaveBeenCalledWith(3.0);
        expect(ctx.setMinPst).toHaveBeenCalledWith(1.5);
        expect(ctx.setMinLoadShedding).toHaveBeenCalledWith(2.5);
        expect(ctx.setMinRenewableCurtailmentActions).toHaveBeenCalledWith(1.25);
        expect(ctx.setNPrioritizedActions).toHaveBeenCalledWith(8);

        // Monitoring + flags
        expect(ctx.setLinesMonitoringPath).toHaveBeenCalledWith('/data/monitoring.csv');
        expect(ctx.setMonitoringFactor).toHaveBeenCalledWith(0.93);
        expect(ctx.setPreExistingOverloadThreshold).toHaveBeenCalledWith(0.04);
        expect(ctx.setIgnoreReconnections).toHaveBeenCalledWith(true);
        expect(ctx.setPypowsyblFastMode).toHaveBeenCalledWith(false);
    });

    it('falls back to safe defaults when older sessions lack load-shedding / curtailment thresholds', async () => {
        // Simulate a pre-PR-#73 session dump: neither new field present.
        const legacy = makeSession();
        delete (legacy.configuration as { min_load_shedding?: number }).min_load_shedding;
        delete (legacy.configuration as { min_renewable_curtailment_actions?: number })
            .min_renewable_curtailment_actions;
        mockLoadSession.mockResolvedValue(legacy);

        const ctx = makeCtx();

        const { result } = renderHook(() => useSession());

        await act(async () => {
            await result.current.handleRestoreSession('legacy_session', ctx);
        });

        // Defaults are 0.0 per the restore contract: "Older session
        // dumps that predate these fields fall back to 0.0 on reload."
        expect(ctx.setMinLoadShedding).toHaveBeenCalledWith(0.0);
        expect(ctx.setMinRenewableCurtailmentActions).toHaveBeenCalledWith(0.0);
    });

    it('updates committedNetworkPathRef on successful restore', async () => {
        // The bug: before this fix, the ref stayed empty after a
        // reload, so the first manual edit to the Header network input
        // silently dropped the study instead of prompting the "Change
        // Network?" confirmation dialog.
        mockLoadSession.mockResolvedValue(makeSession());
        const ctx = makeCtx();

        const { result } = renderHook(() => useSession());

        await act(async () => {
            await result.current.handleRestoreSession('session_xyz', ctx);
        });

        expect(ctx.committedNetworkPathRef.current).toBe('/data/net.xiidm');
    });

    it('forwards all configuration fields to the backend via api.updateConfig', async () => {
        mockLoadSession.mockResolvedValue(makeSession());
        const ctx = makeCtx();

        const { result } = renderHook(() => useSession());

        await act(async () => {
            await result.current.handleRestoreSession('session_1', ctx);
        });

        expect(mockUpdateConfig).toHaveBeenCalledTimes(1);
        const payload = mockUpdateConfig.mock.calls[0][0];
        expect(payload).toMatchObject({
            network_path: '/data/net.xiidm',
            action_file_path: '/data/actions.json',
            layout_path: '/data/layout.json',
            min_line_reconnections: 2.0,
            min_close_coupling: 3.0,
            min_open_coupling: 2.0,
            min_line_disconnections: 3.0,
            min_pst: 1.5,
            min_load_shedding: 2.5,
            min_renewable_curtailment_actions: 1.25,
            n_prioritized_actions: 8,
            monitoring_factor: 0.93,
            pre_existing_overload_threshold: 0.04,
            ignore_reconnections: true,
            pypowsybl_fast_mode: false,
        });
    });

    it('records a session_reloaded interaction event on success', async () => {
        mockLoadSession.mockResolvedValue(makeSession());
        const ctx = makeCtx();

        const { result } = renderHook(() => useSession());

        await act(async () => {
            await result.current.handleRestoreSession('session_reload_42', ctx);
        });

        const log = interactionLogger.getLog();
        const reloaded = log.find(e => e.type === 'session_reloaded');
        expect(reloaded).toBeDefined();
        expect(reloaded!.details).toEqual({ session_name: 'session_reload_42' });
    });

    it('short-circuits (no API call) when outputFolderPath is empty', async () => {
        const ctx = makeCtx({ outputFolderPath: '' });

        const { result } = renderHook(() => useSession());

        await act(async () => {
            await result.current.handleRestoreSession('session_x', ctx);
        });

        expect(mockLoadSession).not.toHaveBeenCalled();
        expect(ctx.setNetworkPath).not.toHaveBeenCalled();
        expect(ctx.committedNetworkPathRef.current).toBe('');
    });

    it('sets restoringSessionRef BEFORE the first state update so every intermediate render is flagged as a restore (regression for spurious Change Contingency? dialog on session reload with different contingency)', async () => {
        // The dialog is suppressed by useContingencyFetch when
        // restoringSessionRef.current === true. If the ref is only
        // flipped late (after the awaits inside handleRestoreSession),
        // any intermediate render that fires the
        // useContingencyFetch effect with the still-old
        // selectedContingency BUT a newly mutated
        // committedBranchRef OR a fresh hasAnalysisState callback can
        // misclassify the restore as a user-driven contingency
        // change. The ref must therefore flip BEFORE any state
        // mutation — i.e. before setNetworkPath, before
        // setSessionRestoring's render etc.
        const order: string[] = [];
        const ctx = makeCtx();
        const restoringRef = { current: false };
        Object.defineProperty(restoringRef, 'current', {
            set(v: boolean) {
                if (v) order.push('restoringSessionRef=true');
                else order.push('restoringSessionRef=false');
                Object.defineProperty(this, '_v', { value: v, writable: true, configurable: true });
            },
            get() { return (this as unknown as { _v?: boolean })._v ?? false; },
            configurable: true,
        });
        ctx.restoringSessionRef = restoringRef as unknown as typeof ctx.restoringSessionRef;
        ctx.setNetworkPath = vi.fn(() => order.push('setNetworkPath'));
        ctx.setSelectedContingency = vi.fn(() => order.push('setSelectedContingency'));

        mockLoadSession.mockResolvedValue(makeSession({
            contingency: { disconnected_elements: ['LINE_B'], selected_overloads: [], monitor_deselected: false },
        }));
        const { result } = renderHook(() => useSession());
        await act(async () => {
            await result.current.handleRestoreSession('session_early_ref', ctx);
        });

        const earlyRefIdx = order.indexOf('restoringSessionRef=true');
        const networkPathIdx = order.indexOf('setNetworkPath');
        const branchIdx = order.indexOf('setSelectedContingency');
        // The ref must flip true at the very top of the function —
        // before ANY ctx.setX call has had a chance to render
        // intermediate state. ``setNetworkPath`` is the FIRST setter
        // exercised by handleRestoreSession, so it is the canonical
        // marker of "the restore has started touching state".
        expect(earlyRefIdx).toBeGreaterThanOrEqual(0);
        expect(networkPathIdx).toBeGreaterThanOrEqual(0);
        expect(branchIdx).toBeGreaterThanOrEqual(0);
        expect(earlyRefIdx).toBeLessThan(networkPathIdx);
        expect(earlyRefIdx).toBeLessThan(branchIdx);
    });

    it('keeps restoringSessionRef true through the entire restore even when api.loadSession errors are caught (ref is cleared so the next user gesture is not misclassified)', async () => {
        // Defensive: if the restore aborts mid-flight, the ref must
        // be reset to false — otherwise the very next user-driven
        // contingency change would silently bypass the confirmation
        // dialog (because useContingencyFetch reads
        // restoringSessionRef.current and would still see true).
        const ctx = makeCtx();
        mockLoadSession.mockRejectedValue({ response: { data: { detail: 'oops' } } });

        const { result } = renderHook(() => useSession());
        await act(async () => {
            await result.current.handleRestoreSession('session_failing', ctx);
        });

        expect(ctx.restoringSessionRef.current).toBe(false);
        expect(ctx.setError).toHaveBeenCalled();
    });

    it('also resyncs pendingContingency so the Trigger button does not stay dirty after restore (UX guard against accidental replay of the pre-restore branch)', async () => {
        const ctx = makeCtx();
        const setPendingContingency = vi.fn();
        (ctx as RestoreContext & { setPendingContingency: typeof setPendingContingency }).setPendingContingency = setPendingContingency;

        mockLoadSession.mockResolvedValue(makeSession({
            contingency: { disconnected_elements: ['LINE_B'], selected_overloads: [], monitor_deselected: false },
        }));
        const { result } = renderHook(() => useSession());
        await act(async () => {
            await result.current.handleRestoreSession('session_pending_sync', ctx);
        });

        expect(setPendingContingency).toHaveBeenCalledWith(['LINE_B']);
    });

    it('calls resetAllState BEFORE api.loadSession so the dialog guard cannot race the restore', async () => {
        // The user-requested fix: clean the existing per-study state
        // at the START of the restore, exactly like a Load Study,
        // so ``hasAnalysisState()`` reads false during the entire
        // window between resetAllState and setResult(restored). That
        // window is what used to make the contingency-change dialog
        // fire and wipe the just-restored suggestions on Confirm.
        const order: string[] = [];
        const ctx = makeCtx();
        const resetAllState = vi.fn(() => order.push('resetAllState'));
        (ctx as RestoreContext & { resetAllState: typeof resetAllState }).resetAllState = resetAllState;
        mockLoadSession.mockImplementation(async () => {
            order.push('loadSession');
            return makeSession({
                contingency: { disconnected_elements: ['LINE_B'], selected_overloads: [], monitor_deselected: false },
            });
        });

        const { result } = renderHook(() => useSession());
        await act(async () => {
            await result.current.handleRestoreSession('session_reset', ctx);
        });

        expect(resetAllState).toHaveBeenCalledTimes(1);
        const resetIdx = order.indexOf('resetAllState');
        const loadIdx = order.indexOf('loadSession');
        expect(resetIdx).toBeGreaterThanOrEqual(0);
        expect(loadIdx).toBeGreaterThanOrEqual(0);
        expect(resetIdx).toBeLessThan(loadIdx);
    });

    it('on a SECOND consecutive reload, resetAllState fires first and ends with committedBranchRef matching the newly-restored contingency (regression for "Change Contingency?" appearing after successive reloads)', async () => {
        // Pre-populate the refs as if a previous restore landed
        // ``LINE_A`` with non-null analysis state. The new reload then
        // restores ``LINE_B``. Without resetAllState clearing the refs
        // first, the dialog guard in useContingencyFetch sees committed
        // != selected with hasAnalysisState() true during the
        // intermediate window and fires the spurious dialog.
        const order: string[] = [];
        const ctx = makeCtx();
        const restoringRef = { current: false };
        ctx.restoringSessionRef = restoringRef as unknown as typeof ctx.restoringSessionRef;
        const committedBranchRef = { current: ['LINE_A'] as string[] };
        Object.defineProperty(committedBranchRef, 'current', {
            set(v: string[]) {
                order.push(`committedBranchRef=${(v ?? []).join('+')}`);
                Object.defineProperty(this, '_v', { value: v, writable: true, configurable: true });
            },
            get() { return (this as unknown as { _v?: string[] })._v ?? ['LINE_A']; },
            configurable: true,
        });
        ctx.committedBranchRef = committedBranchRef as unknown as typeof ctx.committedBranchRef;
        const resetAllState = vi.fn(() => {
            order.push('resetAllState');
            // Mirror what App.resetAllState actually does to the ref —
            // wipe to empty BEFORE the restore continues.
            committedBranchRef.current = [];
        });
        (ctx as RestoreContext & { resetAllState: typeof resetAllState }).resetAllState = resetAllState;
        ctx.setSelectedContingency = vi.fn(() => order.push('setSelectedContingency'));
        ctx.setResult = vi.fn(() => order.push('setResult'));

        mockLoadSession.mockResolvedValue(makeSession({
            contingency: { disconnected_elements: ['LINE_B'], selected_overloads: [], monitor_deselected: false },
        }));
        const { result } = renderHook(() => useSession());
        await act(async () => {
            await result.current.handleRestoreSession('session_double_reload', ctx);
        });

        // resetAllState must fire FIRST, wiping committedBranchRef
        // from the previous reload's LINE_A.
        const resetIdx = order.indexOf('resetAllState');
        const wipeIdx = order.indexOf('committedBranchRef=');
        const setLineBIdx = order.indexOf('committedBranchRef=LINE_B');
        expect(resetIdx).toBe(0);
        expect(wipeIdx).toBeGreaterThan(resetIdx);
        expect(wipeIdx).toBeLessThan(setLineBIdx);
        // Final state: committedBranchRef matches the restored
        // contingency (LINE_B), so the dialog guard's sameElements
        // check evaluates true on the post-restore render.
        expect(committedBranchRef.current).toEqual(['LINE_B']);
        // restoringSessionRef must be set to true between resetAllState
        // and the restore's setX calls — see the dedicated test below
        // for the strict ordering. Here we only assert it was flipped.
        expect(restoringRef.current).toBe(true);
    });

    it('sets restoringSessionRef BEFORE setSelectedContingency so the N-1 fetch effect bypasses its hasAnalysisState short-circuit (regression)', async () => {
        // Without the ref being flipped to `true` first, the N-1
        // useEffect in App.tsx short-circuits the second a session
        // with existing analysis state is restored — because the
        // restored `result` is non-null so `hasAnalysisState() ===
        // true`, which the early-return gate used to treat as "no
        // fetch needed". The ref lets the gate distinguish
        // "already-analyzed this branch" from "session just
        // restored, still need N-1 diagram". Verified here via the
        // call-order of the ref-set vs the setSelectedContingency call.
        const order: string[] = [];
        const ctx = makeCtx();
        const restoringRef = { current: false };
        Object.defineProperty(restoringRef, 'current', {
            set(v: boolean) {
                if (v) order.push('restoringSessionRef=true');
                Object.defineProperty(this, '_v', { value: v, writable: true, configurable: true });
            },
            get() { return (this as unknown as { _v?: boolean })._v ?? false; },
            configurable: true,
        });
        ctx.restoringSessionRef = restoringRef as unknown as typeof ctx.restoringSessionRef;
        const committedBranchRef = { current: [] as string[] };
        Object.defineProperty(committedBranchRef, 'current', {
            set(v: string[]) {
                order.push(`committedBranchRef=${(v ?? []).join('+')}`);
                Object.defineProperty(this, '_v', { value: v, writable: true, configurable: true });
            },
            get() { return (this as unknown as { _v?: string[] })._v ?? []; },
            configurable: true,
        });
        ctx.committedBranchRef = committedBranchRef as unknown as typeof ctx.committedBranchRef;
        ctx.setSelectedContingency = vi.fn(() => order.push('setSelectedContingency'));

        mockLoadSession.mockResolvedValue(makeSession({
            contingency: { disconnected_elements: ['LINE_A'], selected_overloads: [], monitor_deselected: false },
        }));
        const { result } = renderHook(() => useSession());
        await act(async () => {
            await result.current.handleRestoreSession('session_ref_order', ctx);
        });

        // The ref must flip to true before setSelectedContingency is called,
        // otherwise the N-1 effect sees `restoringSessionRef.current === false`
        // and wipes the just-restored analysis state.
        const refIdx = order.indexOf('restoringSessionRef=true');
        const branchIdx = order.indexOf('setSelectedContingency');
        expect(refIdx).toBeGreaterThanOrEqual(0);
        expect(branchIdx).toBeGreaterThanOrEqual(0);
        expect(refIdx).toBeLessThan(branchIdx);
        expect(committedBranchRef.current).toEqual(['LINE_A']);
    });

    it('surfaces backend errors via ctx.setError and leaves the ref empty', async () => {
        mockLoadSession.mockRejectedValue({ response: { data: { detail: 'not found' } } });
        const ctx = makeCtx();

        const { result } = renderHook(() => useSession());

        await act(async () => {
            await result.current.handleRestoreSession('missing', ctx);
        });

        expect(ctx.setError).toHaveBeenCalledWith(expect.stringContaining('not found'));
        // Ref must remain untouched so the Header dialog logic still
        // uses the pre-restore value (empty here → no false-positive).
        expect(ctx.committedNetworkPathRef.current).toBe('');
    });

    // -----------------------------------------------------------------
    // Action-enrichment restoration (PRs #73, #78, #83)
    // -----------------------------------------------------------------

    /**
     * Extract the ActionDetail object the hook pushed into setResult
     * by replaying the setter function against a null previous state.
     * setResult is called with a functional updater, so we reach into
     * the first call and invoke the updater to materialise the new
     * AnalysisResult the hook computed.
     */
    const captureRestoredResult = (
        setResultMock: ReturnType<typeof vi.fn>,
    ): AnalysisResult | null => {
        const call = setResultMock.mock.calls.find(args =>
            typeof args[0] === 'function' || (args[0] && typeof args[0] === 'object'),
        );
        if (!call) return null;
        const updater = call[0];
        if (typeof updater === 'function') {
            return (updater as (prev: AnalysisResult | null) => AnalysisResult | null)(null);
        }
        return updater as AnalysisResult | null;
    };

    it('restores load_shedding_details / curtailment_details / pst_details / lines_overloaded_after into each ActionDetail', async () => {
        // This is the regression for the main session-reload bug: the
        // four enrichment fields were persisted by buildSessionResult
        // but dropped on reload, so the PST / load-shedding /
        // curtailment editor cards rendered empty and the Remedial
        // Action tab lost its post-action overload halos.
        mockLoadSession.mockResolvedValue(makeSession({
            analysis: {
                message: 'ok',
                dc_fallback: false,
                action_scores: {},
                combined_actions: {},
                actions: {
                    load_shed_1: {
                        description_unitaire: 'Shed load L1',
                        rho_before: [1.1],
                        rho_after: [0.8],
                        max_rho: 0.8,
                        max_rho_line: 'LINE_OL1',
                        is_rho_reduction: true,
                        lines_overloaded_after: ['LINE_OL2'],
                        load_shedding_details: [
                            { load_name: 'L1', voltage_level_id: 'VL_1', shedded_mw: 4.2 },
                        ],
                        status: {
                            is_selected: false,
                            is_suggested: true,
                            is_rejected: false,
                            is_manually_simulated: false,
                        },
                    },
                    curtail_1: {
                        description_unitaire: 'Curtail wind W1',
                        rho_before: [1.2],
                        rho_after: [0.95],
                        max_rho: 0.95,
                        max_rho_line: 'LINE_OL1',
                        is_rho_reduction: true,
                        lines_overloaded_after: [],
                        curtailment_details: [
                            { gen_name: 'W1', voltage_level_id: 'VL_2', curtailed_mw: 7.5 },
                        ],
                        status: {
                            is_selected: false,
                            is_suggested: true,
                            is_rejected: false,
                            is_manually_simulated: false,
                        },
                    },
                    pst_1: {
                        description_unitaire: 'Move PST tap',
                        rho_before: [1.05],
                        rho_after: [0.9],
                        max_rho: 0.9,
                        max_rho_line: 'LINE_OL1',
                        is_rho_reduction: true,
                        pst_details: [
                            { pst_name: 'PST_A', tap_position: 5, low_tap: -16, high_tap: 16 },
                        ],
                        status: {
                            is_selected: false,
                            is_suggested: true,
                            is_rejected: false,
                            is_manually_simulated: false,
                        },
                    },
                },
            },
        }));
        const ctx = makeCtx();

        const { result } = renderHook(() => useSession());

        await act(async () => {
            await result.current.handleRestoreSession('session_enriched', ctx);
        });

        const restored = captureRestoredResult(ctx.setResult as ReturnType<typeof vi.fn>);
        expect(restored).not.toBeNull();

        // Load shedding
        const ls = restored!.actions['load_shed_1'];
        expect(ls.load_shedding_details).toEqual([
            { load_name: 'L1', voltage_level_id: 'VL_1', shedded_mw: 4.2 },
        ]);
        expect(ls.lines_overloaded_after).toEqual(['LINE_OL2']);

        // Curtailment
        const ct = restored!.actions['curtail_1'];
        expect(ct.curtailment_details).toEqual([
            { gen_name: 'W1', voltage_level_id: 'VL_2', curtailed_mw: 7.5 },
        ]);
        expect(ct.lines_overloaded_after).toEqual([]);

        // PST editor card depends on pst_details
        const pst = restored!.actions['pst_1'];
        expect(pst.pst_details).toEqual([
            { pst_name: 'PST_A', tap_position: 5, low_tap: -16, high_tap: 16 },
        ]);
    });

    it('preserves action status flags (selected / suggested / rejected / manually-simulated) on restore', async () => {
        mockLoadSession.mockResolvedValue(makeSession({
            analysis: {
                message: 'ok',
                dc_fallback: false,
                action_scores: {},
                combined_actions: {},
                actions: {
                    act_fav: {
                        description_unitaire: 'fav',
                        rho_before: [1.1], rho_after: [0.8], max_rho: 0.8,
                        max_rho_line: 'L1', is_rho_reduction: true,
                        status: { is_selected: true, is_suggested: true, is_rejected: false, is_manually_simulated: false },
                    },
                    act_rej: {
                        description_unitaire: 'rej',
                        rho_before: [1.1], rho_after: [1.0], max_rho: 1.0,
                        max_rho_line: 'L1', is_rho_reduction: false,
                        status: { is_selected: false, is_suggested: true, is_rejected: true, is_manually_simulated: false },
                    },
                    act_manual: {
                        description_unitaire: 'manual',
                        rho_before: [1.2], rho_after: [0.9], max_rho: 0.9,
                        max_rho_line: 'L1', is_rho_reduction: true,
                        status: { is_selected: true, is_suggested: false, is_rejected: false, is_manually_simulated: true },
                    },
                },
            },
        }));
        const ctx = makeCtx();

        const { result } = renderHook(() => useSession());

        await act(async () => {
            await result.current.handleRestoreSession('session_status', ctx);
        });

        expect(ctx.setSelectedActionIds).toHaveBeenCalledWith(
            new Set(['act_fav', 'act_manual']),
        );
        expect(ctx.setRejectedActionIds).toHaveBeenCalledWith(new Set(['act_rej']));
        expect(ctx.setManuallyAddedIds).toHaveBeenCalledWith(new Set(['act_manual']));
        expect(ctx.setSuggestedByRecommenderIds).toHaveBeenCalledWith(
            new Set(['act_fav', 'act_rej']),
        );
    });

    it('re-pushes lines_we_care_about to the backend via /api/restore-analysis-context (regression)', async () => {
        // Without this call, a simulate-action triggered after reload
        // silently falls back to the backend default monitored-line
        // set instead of the per-study set captured at save time.
        // Parity with the standalone HTML mirror (PR
        // `claude/auto-generate-standalone-interface-Hhogk`).
        mockLoadSession.mockResolvedValue(makeSession({
            overloads: {
                n_overloads: [],
                n1_overloads: ['LINE_OL1'],
                resolved_overloads: ['LINE_OL1'],
            },
            analysis: {
                message: 'ok',
                dc_fallback: false,
                action_scores: {},
                combined_actions: {},
                actions: {},
                lines_we_care_about: ['LINE_MON1', 'LINE_MON2', 'LINE_MON3'],
                computed_pairs: { 'act_a+act_b': { max_rho: 0.87 } },
            },
        }));
        const ctx = makeCtx();
        const { result } = renderHook(() => useSession());

        await act(async () => {
            await result.current.handleRestoreSession('session_with_context', ctx);
        });

        expect(mockRestoreAnalysisContext).toHaveBeenCalledOnce();
        expect(mockRestoreAnalysisContext).toHaveBeenCalledWith({
            lines_we_care_about: ['LINE_MON1', 'LINE_MON2', 'LINE_MON3'],
            disconnected_elements: ['LINE_A'],
            lines_overloaded: ['LINE_OL1'],
            computed_pairs: { 'act_a+act_b': { max_rho: 0.87 } },
        });
    });

    it('skips /api/restore-analysis-context when the saved session predates lines_we_care_about', async () => {
        // Older session dumps never persisted the monitored-line set.
        // The restore path must stay silent rather than call the
        // endpoint with null payloads (which would wipe whatever
        // default the backend already has).
        mockLoadSession.mockResolvedValue(makeSession({
            analysis: {
                message: 'ok',
                dc_fallback: false,
                action_scores: {},
                combined_actions: {},
                actions: {},
                // no lines_we_care_about / computed_pairs
            },
        }));
        const ctx = makeCtx();
        const { result } = renderHook(() => useSession());

        await act(async () => {
            await result.current.handleRestoreSession('legacy_session', ctx);
        });

        expect(mockRestoreAnalysisContext).not.toHaveBeenCalled();
    });

    it('swallows /api/restore-analysis-context failures without aborting the reload', async () => {
        // If the context push fails (e.g. backend was restarted since
        // save), the reload must still complete — the user simply
        // loses the monitored-line set, but the rest of the session
        // state is preserved. Mirrors the standalone try/catch at
        // standalone_interface.html:3866.
        mockLoadSession.mockResolvedValue(makeSession({
            analysis: {
                message: 'ok',
                dc_fallback: false,
                action_scores: {},
                combined_actions: {},
                actions: {},
                lines_we_care_about: ['LINE_MON1'],
            },
        }));
        mockRestoreAnalysisContext.mockRejectedValueOnce(new Error('backend offline'));
        const ctx = makeCtx();
        const { result } = renderHook(() => useSession());

        await act(async () => {
            await result.current.handleRestoreSession('session_crash_context', ctx);
        });

        expect(mockRestoreAnalysisContext).toHaveBeenCalledOnce();
        // Contingency setters still ran → reload did not abort.
        expect(ctx.setMonitorDeselected).toHaveBeenCalled();
        expect(ctx.setSelectedOverloads).toHaveBeenCalled();
    });

    it('does not crash when action entries omit the new enrichment fields (legacy shape)', async () => {
        // Pre-PR-#73 action entries lack every enrichment field. The
        // restore path must propagate the absent fields as undefined
        // instead of throwing.
        mockLoadSession.mockResolvedValue(makeSession({
            analysis: {
                message: 'ok',
                dc_fallback: false,
                action_scores: {},
                combined_actions: {},
                actions: {
                    legacy_act: {
                        description_unitaire: 'legacy',
                        rho_before: [1.1], rho_after: [0.7], max_rho: 0.7,
                        max_rho_line: 'L1', is_rho_reduction: true,
                        status: { is_selected: false, is_suggested: true, is_rejected: false, is_manually_simulated: false },
                    },
                },
            },
        }));
        const ctx = makeCtx();

        const { result } = renderHook(() => useSession());

        await act(async () => {
            await result.current.handleRestoreSession('legacy_action', ctx);
        });

        const restored = captureRestoredResult(ctx.setResult as ReturnType<typeof vi.fn>);
        expect(restored).not.toBeNull();
        const legacy = restored!.actions['legacy_act'];
        expect(legacy.load_shedding_details).toBeUndefined();
        expect(legacy.curtailment_details).toBeUndefined();
        expect(legacy.pst_details).toBeUndefined();
        expect(legacy.lines_overloaded_after).toBeUndefined();
    });

    it('skips estimation-only combined entries that were never simulated manually', async () => {
        // Combined entries that are estimation-only (e.g. "act_a+act_b"
        // with is_estimated=true and no manual simulation) are not
        // restored as top-level actions — they live under
        // combined_actions instead.
        mockLoadSession.mockResolvedValue(makeSession({
            analysis: {
                message: 'ok',
                dc_fallback: false,
                action_scores: {},
                combined_actions: {
                    'act_a+act_b': {
                        action1_id: 'act_a',
                        action2_id: 'act_b',
                        betas: [0.5, 0.5],
                        max_rho: 0.9,
                        max_rho_line: 'LINE_X',
                        is_rho_reduction: true,
                        description: 'Combined a+b',
                        estimated_max_rho: 0.9,
                        estimated_max_rho_line: 'LINE_X',
                        is_simulated: false,
                    },
                },
                actions: {
                    act_a: {
                        description_unitaire: 'a',
                        rho_before: [1.0], rho_after: [0.95], max_rho: 0.95,
                        max_rho_line: 'L1', is_rho_reduction: true,
                        status: { is_selected: false, is_suggested: true, is_rejected: false, is_manually_simulated: false },
                    },
                    'act_a+act_b': {
                        description_unitaire: 'a+b estimated',
                        rho_before: null,
                        rho_after: null,
                        max_rho: null,
                        max_rho_line: 'LINE_X',
                        is_rho_reduction: true,
                        is_estimated: true,
                        status: { is_selected: false, is_suggested: false, is_rejected: false, is_manually_simulated: false },
                    },
                },
            },
        }));
        const ctx = makeCtx();

        const { result } = renderHook(() => useSession());

        await act(async () => {
            await result.current.handleRestoreSession('combo_session', ctx);
        });

        const restored = captureRestoredResult(ctx.setResult as ReturnType<typeof vi.fn>);
        expect(restored).not.toBeNull();
        // Only the real action survived — the estimation-only
        // combined entry was filtered out.
        expect(Object.keys(restored!.actions)).toEqual(['act_a']);
        // But the combined_actions dictionary still carries it.
        expect(restored!.combined_actions).toHaveProperty('act_a+act_b');
    });

    // -----------------------------------------------------------------
    // Recommender model + action origin restore fidelity
    // -----------------------------------------------------------------

    it('restores result.active_model + compute_overflow_graph so the model reminder survives a reload', async () => {
        // Regression: active_model was persisted under
        // analysis.active_model but never re-attached to the live
        // `result`, so the "Suggestions produced by <model>" reminder
        // below the Suggested Actions tab header vanished on reload.
        mockLoadSession.mockResolvedValue(makeSession({
            analysis: {
                message: 'ok',
                dc_fallback: false,
                action_scores: {},
                combined_actions: {},
                active_model: 'random_overflow',
                compute_overflow_graph: true,
                actions: {},
            },
        }));
        const ctx = makeCtx();

        const { result } = renderHook(() => useSession());
        await act(async () => {
            await result.current.handleRestoreSession('model_session', ctx);
        });

        const restored = captureRestoredResult(ctx.setResult as ReturnType<typeof vi.fn>);
        expect(restored).not.toBeNull();
        expect(restored!.active_model).toBe('random_overflow');
        expect(restored!.compute_overflow_graph).toBe(true);
    });

    it('restores all per-stage execution-time fields onto the live result', async () => {
        // The ActionFeed reminder shows a "Suggestions produced by
        // <model> in <X>s ⓘ" headline driven by ``result.*_time`` and
        // ``result.wall_clock_time``. Reload must re-attach all six
        // fields onto the live result so the operator sees the same
        // numbers without re-running the analysis.
        mockLoadSession.mockResolvedValue(makeSession({
            analysis: {
                message: 'ok',
                dc_fallback: false,
                action_scores: {},
                combined_actions: {},
                active_model: 'expert',
                actions: {},
                step1_time: 2.16,
                overflow_graph_time: 7.84,
                action_prediction_time: 0.94,
                assessment_time: 15.5,
                enrichment_time: 0.76,
                wall_clock_time: 27.8,
            },
        }));
        const ctx = makeCtx();

        const { result } = renderHook(() => useSession());
        await act(async () => {
            await result.current.handleRestoreSession('timing_session', ctx);
        });

        const restored = captureRestoredResult(ctx.setResult as ReturnType<typeof vi.fn>);
        expect(restored).not.toBeNull();
        expect(restored!.step1_time).toBe(2.16);
        expect(restored!.overflow_graph_time).toBe(7.84);
        expect(restored!.action_prediction_time).toBe(0.94);
        expect(restored!.assessment_time).toBe(15.5);
        expect(restored!.enrichment_time).toBe(0.76);
        expect(restored!.wall_clock_time).toBe(27.8);
    });

    it('restores timing fields as undefined when the saved session predates them', async () => {
        // Legacy session dumps (before the execution-time breakdown
        // landed) have no timing fields. The restore must NOT crash
        // and must leave the live result without those fields — the
        // ActionFeed reminder's ``showBreakdown`` falsey-check then
        // hides the headline entirely.
        mockLoadSession.mockResolvedValue(makeSession({
            analysis: {
                message: 'ok',
                dc_fallback: false,
                action_scores: {},
                combined_actions: {},
                active_model: 'expert',
                actions: {},
                // No timing fields whatsoever — old format.
            },
        }));
        const ctx = makeCtx();

        const { result } = renderHook(() => useSession());
        await act(async () => {
            await result.current.handleRestoreSession('legacy_no_timings', ctx);
        });

        const restored = captureRestoredResult(ctx.setResult as ReturnType<typeof vi.fn>);
        expect(restored).not.toBeNull();
        expect(restored!.step1_time).toBeUndefined();
        expect(restored!.overflow_graph_time).toBeUndefined();
        expect(restored!.action_prediction_time).toBeUndefined();
        expect(restored!.assessment_time).toBeUndefined();
        expect(restored!.enrichment_time).toBeUndefined();
        expect(restored!.wall_clock_time).toBeUndefined();
    });

    it('treats a null overflow_graph_time as "model did not compute it" rather than missing', async () => {
        // Distinct from undefined: ``null`` means a graph-free model
        // (e.g. ``random``) ran. The restore should preserve that
        // semantic by leaving ``overflow_graph_time`` undefined — the
        // ActionFeed reminder's tooltip then omits the Overflow line.
        mockLoadSession.mockResolvedValue(makeSession({
            analysis: {
                message: 'ok',
                dc_fallback: false,
                action_scores: {},
                combined_actions: {},
                active_model: 'random',
                actions: {},
                overflow_graph_time: null,
                action_prediction_time: 0.5,
                assessment_time: 1.2,
            },
        }));
        const ctx = makeCtx();

        const { result } = renderHook(() => useSession());
        await act(async () => {
            await result.current.handleRestoreSession('graphless_session', ctx);
        });

        const restored = captureRestoredResult(ctx.setResult as ReturnType<typeof vi.fn>);
        expect(restored).not.toBeNull();
        expect(restored!.overflow_graph_time).toBeUndefined();
        expect(restored!.action_prediction_time).toBe(0.5);
        expect(restored!.assessment_time).toBe(1.2);
    });

    it('restores a saved action origin verbatim', async () => {
        mockLoadSession.mockResolvedValue(makeSession({
            analysis: {
                message: 'ok',
                dc_fallback: false,
                action_scores: {},
                combined_actions: {},
                active_model: 'random_overflow',
                actions: {
                    reco_1: {
                        description_unitaire: 'Reco', rho_before: [1.1], rho_after: [0.9],
                        max_rho: 0.9, max_rho_line: 'LINE_OL1', is_rho_reduction: true,
                        origin: 'random_overflow',
                        status: { is_selected: false, is_suggested: true, is_rejected: false, is_manually_simulated: false },
                    },
                    manual_1: {
                        description_unitaire: 'Manual', rho_before: [1.2], rho_after: [0.85],
                        max_rho: 0.85, max_rho_line: 'LINE_OL1', is_rho_reduction: true,
                        origin: 'user',
                        status: { is_selected: true, is_suggested: false, is_rejected: false, is_manually_simulated: true },
                    },
                },
            },
        }));
        const ctx = makeCtx();

        const { result } = renderHook(() => useSession());
        await act(async () => {
            await result.current.handleRestoreSession('origin_session', ctx);
        });

        const restored = captureRestoredResult(ctx.setResult as ReturnType<typeof vi.fn>);
        expect(restored!.actions['reco_1'].origin).toBe('random_overflow');
        expect(restored!.actions['manual_1'].origin).toBe('user');
    });

    it('derives origin for legacy sessions that predate the field (from status flags + active_model)', async () => {
        // Legacy session dumps have no `origin` on action entries. The
        // restore path derives one: manually-simulated → "user",
        // suggested → analysis.active_model, otherwise undefined.
        mockLoadSession.mockResolvedValue(makeSession({
            analysis: {
                message: 'ok',
                dc_fallback: false,
                action_scores: {},
                combined_actions: {},
                active_model: 'expert',
                actions: {
                    suggested_legacy: {
                        description_unitaire: 'Suggested', rho_before: [1.1], rho_after: [0.9],
                        max_rho: 0.9, max_rho_line: 'LINE_OL1', is_rho_reduction: true,
                        // no `origin` — legacy shape
                        status: { is_selected: false, is_suggested: true, is_rejected: false, is_manually_simulated: false },
                    },
                    manual_legacy: {
                        description_unitaire: 'Manual', rho_before: [1.2], rho_after: [0.85],
                        max_rho: 0.85, max_rho_line: 'LINE_OL1', is_rho_reduction: true,
                        status: { is_selected: true, is_suggested: false, is_rejected: false, is_manually_simulated: true },
                    },
                },
            },
        }));
        const ctx = makeCtx();

        const { result } = renderHook(() => useSession());
        await act(async () => {
            await result.current.handleRestoreSession('legacy_origin_session', ctx);
        });

        const restored = captureRestoredResult(ctx.setResult as ReturnType<typeof vi.fn>);
        // suggested → derived from analysis.active_model
        expect(restored!.actions['suggested_legacy'].origin).toBe('expert');
        // manually-simulated → "user"
        expect(restored!.actions['manual_legacy'].origin).toBe('user');
    });
});
