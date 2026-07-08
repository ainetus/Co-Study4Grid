// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study. 

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAnalysis } from './useAnalysis';
import { interactionLogger } from '../utils/interactionLogger';
import { notifications, DEFAULT_TIMEOUT_MS, type NotificationSeverity } from '../utils/notifications';

/** Messages currently in the notification store for a given severity. */
function toastMessages(severity: NotificationSeverity): string[] {
    return notifications.getSnapshot().filter(n => n.severity === severity).map(n => n.message);
}

// Mock the api module (dynamic import in useAnalysis)
const mockRunAnalysisStep1 = vi.fn();
const mockRunAnalysisStep2Stream = vi.fn();

vi.mock('../api', () => ({
    api: {
        runAnalysisStep1: (...args: unknown[]) => mockRunAnalysisStep1(...args),
        runAnalysisStep2Stream: (...args: unknown[]) => mockRunAnalysisStep2Stream(...args),
    },
}));

/** Helper: build a ReadableStream from an NDJSON string */
function makeStream(ndjson: string): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream({
        start(controller) {
            controller.enqueue(encoder.encode(ndjson));
            controller.close();
        },
    });
}

describe('useAnalysis', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        interactionLogger.clear();
        notifications.clear();
    });

    it('initializes with null result and no loading', () => {
        const { result } = renderHook(() => useAnalysis());
        expect(result.current.result).toBeNull();
        expect(result.current.analysisLoading).toBe(false);
        expect(notifications.getSnapshot()).toHaveLength(0);
    });

    it('does nothing when selectedBranch is empty', async () => {
        const { result } = renderHook(() => useAnalysis());
        const clear = vi.fn();
        const setSuggested = vi.fn();

        await act(async () => {
            await result.current.handleRunAnalysis([], clear, setSuggested);
        });

        expect(clear).not.toHaveBeenCalled();
        expect(mockRunAnalysisStep1).not.toHaveBeenCalled();
    });

    it('sets error when step1 returns can_proceed=false', async () => {
        mockRunAnalysisStep1.mockResolvedValue({
            can_proceed: false,
            message: 'Network not loaded',
            lines_overloaded: [],
        });

        const { result } = renderHook(() => useAnalysis());
        const clear = vi.fn();
        const setSuggested = vi.fn();

        await act(async () => {
            await result.current.handleRunAnalysis(['LINE_X'], clear, setSuggested);
        });

        expect(toastMessages('error')).toContain('Network not loaded');
        expect(result.current.analysisLoading).toBe(false);
        expect(mockRunAnalysisStep2Stream).not.toHaveBeenCalled();
    });

    it('sets info message when no overloads detected', async () => {
        mockRunAnalysisStep1.mockResolvedValue({
            can_proceed: true,
            message: 'No overloads detected',
            lines_overloaded: [],
        });

        const { result } = renderHook(() => useAnalysis());

        await act(async () => {
            await result.current.handleRunAnalysis(['LINE_X'], vi.fn(), vi.fn());
        });

        expect(toastMessages('info')).toContain('No overloads detected');
        expect(result.current.analysisLoading).toBe(false);
    });

    it('calls runAnalysisStep2Stream with all_overloads and monitor_deselected', async () => {
        const detected = ['LINE_A', 'LINE_B'];
        mockRunAnalysisStep1.mockResolvedValue({
            can_proceed: true,
            message: '',
            lines_overloaded: detected,
        });

        const resultEvent = JSON.stringify({
            type: 'result',
            actions: {},
            lines_overloaded: detected,
            message: 'Done',
            dc_fallback: false,
        });
        const stream = makeStream(`${resultEvent}\n`);

        mockRunAnalysisStep2Stream.mockResolvedValue({
            ok: true,
            body: stream,
        });

        const { result } = renderHook(() => useAnalysis());

        await act(async () => {
            await result.current.handleRunAnalysis(['LINE_X'], vi.fn(), vi.fn());
        });

        // Verify step2 was called with correct params
        expect(mockRunAnalysisStep2Stream).toHaveBeenCalledWith({
            selected_overloads: detected,
            all_overloads: detected,
            monitor_deselected: false,
            additional_lines_to_cut: [],
        }, expect.any(AbortSignal));
    });

    it('passes monitor_deselected=true when enabled', async () => {
        const detected = ['LINE_A'];
        mockRunAnalysisStep1.mockResolvedValue({
            can_proceed: true,
            message: '',
            lines_overloaded: detected,
        });

        const stream = makeStream(
            JSON.stringify({ type: 'result', actions: {}, lines_overloaded: detected, message: '', dc_fallback: false }) + '\n',
        );
        mockRunAnalysisStep2Stream.mockResolvedValue({ ok: true, body: stream });

        const { result } = renderHook(() => useAnalysis());

        // Enable monitor_deselected
        act(() => { result.current.setMonitorDeselected(true); });

        await act(async () => {
            await result.current.handleRunAnalysis(['LINE_X'], vi.fn(), vi.fn());
        });

        expect(mockRunAnalysisStep2Stream).toHaveBeenCalledWith(
            expect.objectContaining({ monitor_deselected: true }),
            expect.any(AbortSignal),
        );
    });

    describe('handleToggleAdditionalLineToCut', () => {
        it('adds a line when toggling on, removes it when toggling off', () => {
            const { result } = renderHook(() => useAnalysis());

            expect(result.current.additionalLinesToCut.size).toBe(0);

            act(() => { result.current.handleToggleAdditionalLineToCut('LINE_X'); });
            expect(result.current.additionalLinesToCut.has('LINE_X')).toBe(true);

            act(() => { result.current.handleToggleAdditionalLineToCut('LINE_Y'); });
            expect(result.current.additionalLinesToCut.size).toBe(2);

            act(() => { result.current.handleToggleAdditionalLineToCut('LINE_X'); });
            expect(result.current.additionalLinesToCut.has('LINE_X')).toBe(false);
            expect(result.current.additionalLinesToCut.has('LINE_Y')).toBe(true);
        });

        it('ignores empty / falsy line ids', () => {
            const { result } = renderHook(() => useAnalysis());
            act(() => { result.current.handleToggleAdditionalLineToCut(''); });
            expect(result.current.additionalLinesToCut.size).toBe(0);
        });
    });

    it('forwards a non-empty additional_lines_to_cut to step2', async () => {
        const detected = ['LINE_A'];
        mockRunAnalysisStep1.mockResolvedValue({
            can_proceed: true,
            message: '',
            lines_overloaded: detected,
        });
        const stream = makeStream(
            JSON.stringify({ type: 'result', actions: {}, lines_overloaded: detected, message: '', dc_fallback: false }) + '\n',
        );
        mockRunAnalysisStep2Stream.mockResolvedValue({ ok: true, body: stream });

        const { result } = renderHook(() => useAnalysis());

        act(() => {
            result.current.handleToggleAdditionalLineToCut('EXTRA_1');
            result.current.handleToggleAdditionalLineToCut('EXTRA_2');
        });

        await act(async () => {
            await result.current.handleRunAnalysis(['LINE_X'], vi.fn(), vi.fn());
        });

        expect(mockRunAnalysisStep2Stream).toHaveBeenCalledWith(
            expect.objectContaining({
                additional_lines_to_cut: expect.arrayContaining(['EXTRA_1', 'EXTRA_2']),
            }),
            expect.any(AbortSignal),
        );
        // Sanity: the extras pass-through preserves the operator's exact
        // selection — no reordering / dedup at the hook layer.
        const call = mockRunAnalysisStep2Stream.mock.calls[0][0];
        expect(call.additional_lines_to_cut).toHaveLength(2);
    });

    it('processes PDF and result NDJSON events from stream', async () => {
        const detected = ['LINE_A'];
        mockRunAnalysisStep1.mockResolvedValue({
            can_proceed: true, message: '', lines_overloaded: detected,
        });

        const pdfEvent = JSON.stringify({ type: 'pdf', pdf_url: '/results/pdf/graph.pdf', pdf_path: '/tmp/graph.pdf' });
        const resultEvent = JSON.stringify({
            type: 'result',
            actions: {
                act_1: {
                    description_unitaire: 'Test action',
                    rho_before: [0.95], rho_after: [0.80],
                    max_rho: 0.80, max_rho_line: 'LINE_A',
                    is_rho_reduction: true,
                },
            },
            lines_overloaded: detected,
            message: 'Analysis done',
            dc_fallback: false,
        });

        const stream = makeStream(`${pdfEvent}\n${resultEvent}\n`);
        mockRunAnalysisStep2Stream.mockResolvedValue({ ok: true, body: stream });

        const { result } = renderHook(() => useAnalysis());
        const setSuggested = vi.fn();

        await act(async () => {
            await result.current.handleRunAnalysis(['LINE_X'], vi.fn(), setSuggested);
        });

        // PDF event sets result.pdf_url
        expect(result.current.result?.pdf_url).toBe('/results/pdf/graph.pdf');

        // Result event sets pending result and suggested IDs
        expect(result.current.pendingAnalysisResult).not.toBeNull();
        expect(result.current.pendingAnalysisResult?.actions?.act_1).toBeDefined();
        expect(setSuggested).toHaveBeenCalled();
    });

    it("triggers setActiveTab('overflow') immediately when pdf event is received", async () => {
        const detected = ['LINE_A'];
        mockRunAnalysisStep1.mockResolvedValue({
            can_proceed: true, message: '', lines_overloaded: detected,
        });

        const pdfEvent = JSON.stringify({ type: 'pdf', pdf_url: '/results/pdf/graph.pdf', pdf_path: '/tmp/graph.pdf' });
        const resultEvent = JSON.stringify({
            type: 'result',
            actions: {},
            lines_overloaded: detected,
            message: 'Analysis done',
            dc_fallback: false,
        });

        const stream = makeStream(`${pdfEvent}\n${resultEvent}\n`);
        mockRunAnalysisStep2Stream.mockResolvedValue({ ok: true, body: stream });

        const { result } = renderHook(() => useAnalysis());
        const setSuggested = vi.fn();
        const setActiveTab = vi.fn();

        await act(async () => {
            await result.current.handleRunAnalysis(['LINE_X'], vi.fn(), setSuggested, setActiveTab);
        });

        // Verify setActiveTab was called with 'overflow'
        expect(setActiveTab).toHaveBeenCalledWith('overflow');
        // Ensure it was called before or same time as result update
        expect(result.current.result?.pdf_url).toBe('/results/pdf/graph.pdf');
    });

    it('sets error on stream error event', async () => {
        const detected = ['LINE_A'];
        mockRunAnalysisStep1.mockResolvedValue({
            can_proceed: true, message: '', lines_overloaded: detected,
        });

        const stream = makeStream(
            JSON.stringify({ type: 'error', message: 'Backend crashed' }) + '\n',
        );
        mockRunAnalysisStep2Stream.mockResolvedValue({ ok: true, body: stream });

        const { result } = renderHook(() => useAnalysis());

        await act(async () => {
            await result.current.handleRunAnalysis(['LINE_X'], vi.fn(), vi.fn());
        });

        expect(toastMessages('error')).toContain('Analysis failed: Backend crashed');
    });

    it('sets error when step2 rejects', async () => {
        mockRunAnalysisStep1.mockResolvedValue({
            can_proceed: true, message: '', lines_overloaded: ['LINE_A'],
        });
        mockRunAnalysisStep2Stream.mockRejectedValue(new Error('Network error'));

        const { result } = renderHook(() => useAnalysis());

        await act(async () => {
            await result.current.handleRunAnalysis(['LINE_X'], vi.fn(), vi.fn());
        });

        expect(toastMessages('error')).toContain('Network error');
        expect(result.current.analysisLoading).toBe(false);
    });

    describe('cancellation (D5)', () => {
        it('passes an AbortSignal to step 1', async () => {
            mockRunAnalysisStep1.mockResolvedValue({ can_proceed: false, message: 'stop', lines_overloaded: [] });
            const { result } = renderHook(() => useAnalysis());
            await act(async () => {
                await result.current.handleRunAnalysis(['LINE_X'], vi.fn(), vi.fn());
            });
            expect(mockRunAnalysisStep1).toHaveBeenCalledWith(['LINE_X'], expect.any(AbortSignal));
        });

        it('cancelAnalysis aborts the run and surfaces a cancellation notice, not an error', async () => {
            // Step 1 hangs until its signal aborts, then rejects like a real
            // aborted request.
            mockRunAnalysisStep1.mockImplementation((_els: string[], signal?: AbortSignal) =>
                new Promise((_resolve, reject) => {
                    signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
                }),
            );
            const { result } = renderHook(() => useAnalysis());

            let runPromise!: Promise<void>;
            await act(async () => {
                runPromise = result.current.handleRunAnalysis(['LINE_X'], vi.fn(), vi.fn());
                await Promise.resolve();
            });
            expect(result.current.analysisLoading).toBe(true);

            await act(async () => {
                result.current.cancelAnalysis();
                await runPromise;
            });

            expect(result.current.analysisLoading).toBe(false);
            expect(toastMessages('info')).toContain('Analysis cancelled.');
            expect(toastMessages('error')).toEqual([]);
            expect(mockRunAnalysisStep2Stream).not.toHaveBeenCalled();
        });

        it('cancelAnalysis is a no-op when nothing is running', () => {
            const { result } = renderHook(() => useAnalysis());
            expect(() => result.current.cancelAnalysis()).not.toThrow();
        });
    });

    describe('handleToggleOverload', () => {
        it('adds and removes overloads from selection', () => {
            const { result } = renderHook(() => useAnalysis());

            act(() => { result.current.handleToggleOverload('LINE_A'); });
            expect(result.current.selectedOverloads.has('LINE_A')).toBe(true);

            act(() => { result.current.handleToggleOverload('LINE_A'); });
            expect(result.current.selectedOverloads.has('LINE_A')).toBe(false);
        });
    });

    describe('handleDisplayPrioritizedActions', () => {
        it('merges pending result into result and clears pending', async () => {
            const { result } = renderHook(() => useAnalysis());

            // Simulate having a pending result
            const pendingResult = {
                actions: {
                    act_1: {
                        description_unitaire: 'Reco',
                        rho_before: [1.1], rho_after: [0.9],
                        max_rho: 0.9, max_rho_line: 'LINE_A',
                        is_rho_reduction: true,
                    },
                },
                lines_overloaded: ['LINE_A'],
                message: 'OK',
                dc_fallback: false,
                pdf_path: null,
                pdf_url: null,
            };

            act(() => {
                result.current.setPendingAnalysisResult(pendingResult);
            });

            act(() => {
                result.current.handleDisplayPrioritizedActions(new Set());
            });

            expect(result.current.result?.actions?.act_1).toBeDefined();
            expect(result.current.pendingAnalysisResult).toBeNull();
        });

        it('calls setActiveTab("action") when provided', () => {
            const { result } = renderHook(() => useAnalysis());

            const pendingResult = {
                actions: {
                    act_1: {
                        description_unitaire: 'Reco',
                        rho_before: [1.1], rho_after: [0.9],
                        max_rho: 0.9, max_rho_line: 'LINE_A',
                        is_rho_reduction: true,
                    },
                },
                lines_overloaded: ['LINE_A'],
                message: 'OK',
                dc_fallback: false,
                pdf_path: null,
                pdf_url: null,
            };

            act(() => {
                result.current.setPendingAnalysisResult(pendingResult);
            });

            const setActiveTab = vi.fn();
            act(() => {
                result.current.handleDisplayPrioritizedActions(new Set(), setActiveTab);
            });

            expect(setActiveTab).toHaveBeenCalledWith('action');
        });

        it('preserves manually selected actions during merge', async () => {
            const { result } = renderHook(() => useAnalysis());

            // Set an existing result with a manual action
            act(() => {
                result.current.setResult({
                    actions: {
                        manual_1: {
                            description_unitaire: 'Manual',
                            rho_before: null, rho_after: [0.85],
                            max_rho: 0.85, max_rho_line: 'LINE_B',
                            is_rho_reduction: true, is_manual: true,
                        },
                    },
                    lines_overloaded: ['LINE_A'],
                    message: '', dc_fallback: false,
                    pdf_path: null, pdf_url: null,
                });
            });

            // Set pending result with new recommended actions
            act(() => {
                result.current.setPendingAnalysisResult({
                    actions: {
                        reco_1: {
                            description_unitaire: 'Reco',
                            rho_before: [1.1], rho_after: [0.9],
                            max_rho: 0.9, max_rho_line: 'LINE_A',
                            is_rho_reduction: true,
                        },
                    },
                    lines_overloaded: ['LINE_A'],
                    message: 'OK', dc_fallback: false,
                    pdf_path: null, pdf_url: null,
                });
            });

            // Display prioritized, keeping manual_1 selected
            act(() => {
                result.current.handleDisplayPrioritizedActions(new Set(['manual_1']));
            });

            // Both actions should be in the final result
            expect(result.current.result?.actions?.manual_1).toBeDefined();
            expect(result.current.result?.actions?.reco_1).toBeDefined();
        });

        it('preserves a manually added action that is ALSO returned by the recommender (overlap case)', async () => {
            // Regression: a user "first guess" action that happens
            // to coincide with a suggestion from the recommender
            // used to disappear from the Selected bucket after the
            // analysis was displayed, because handleDisplayPrioritized
            // used the plain analysis entry (without is_manual) for
            // the overlapping id. The fix preserves the
            // manually-added entry (keeping is_manual=true) so it
            // stays in Selected and the "was also suggested" warning
            // can fire.
            const { result } = renderHook(() => useAnalysis());

            act(() => {
                result.current.setResult({
                    actions: {
                        overlap_1: {
                            description_unitaire: 'Manual guess',
                            rho_before: null, rho_after: [0.7],
                            max_rho: 0.7, max_rho_line: 'LINE_A',
                            is_rho_reduction: true, is_manual: true,
                        },
                    },
                    lines_overloaded: ['LINE_A'],
                    message: '', dc_fallback: false,
                    pdf_path: null, pdf_url: null,
                });
            });

            act(() => {
                result.current.setPendingAnalysisResult({
                    actions: {
                        overlap_1: {
                            description_unitaire: 'Recommender entry',
                            rho_before: [1.1], rho_after: [0.75],
                            max_rho: 0.75, max_rho_line: 'LINE_A',
                            is_rho_reduction: true,
                        },
                        reco_other: {
                            description_unitaire: 'Another suggestion',
                            rho_before: [1.2], rho_after: [0.85],
                            max_rho: 0.85, max_rho_line: 'LINE_A',
                            is_rho_reduction: true,
                        },
                    },
                    lines_overloaded: ['LINE_A'],
                    message: 'OK', dc_fallback: false,
                    pdf_path: null, pdf_url: null,
                });
            });

            // Display prioritized — even with an EMPTY selectedActionIds
            // (mirrors resetForAnalysisRun clearing the selection of
            // non-manual favorites) the manual action must survive.
            act(() => {
                result.current.handleDisplayPrioritizedActions(new Set());
            });

            // Overlapping id must remain and stay flagged as manual.
            expect(result.current.result?.actions?.overlap_1).toBeDefined();
            expect(result.current.result?.actions?.overlap_1?.is_manual).toBe(true);
            // The new purely-suggested action is merged in as usual.
            expect(result.current.result?.actions?.reco_other).toBeDefined();
            expect(result.current.result?.actions?.reco_other?.is_manual).toBeFalsy();
        });
    });

    describe('overload filtering in step 2', () => {
        it('uses previously selected overloads when still relevant', async () => {
            const detected = ['LINE_A', 'LINE_B', 'LINE_C'];
            mockRunAnalysisStep1.mockResolvedValue({
                can_proceed: true, message: '', lines_overloaded: detected,
            });

            const stream = makeStream(
                JSON.stringify({ type: 'result', actions: {}, lines_overloaded: detected, message: '', dc_fallback: false }) + '\n',
            );
            mockRunAnalysisStep2Stream.mockResolvedValue({ ok: true, body: stream });

            const { result } = renderHook(() => useAnalysis());

            // Pre-select a subset of overloads
            act(() => { result.current.setSelectedOverloads(new Set(['LINE_A', 'LINE_B'])); });

            await act(async () => {
                await result.current.handleRunAnalysis(['LINE_X'], vi.fn(), vi.fn());
            });

            // Should resolve only the intersection of detected and previously selected
            expect(mockRunAnalysisStep2Stream).toHaveBeenCalledWith(
                expect.objectContaining({
                    selected_overloads: ['LINE_A', 'LINE_B'],
                    all_overloads: detected,
                }),
                expect.any(AbortSignal),
            );
        });

        it('resets to all detected when previous selection has no overlap', async () => {
            const detected = ['LINE_C', 'LINE_D'];
            mockRunAnalysisStep1.mockResolvedValue({
                can_proceed: true, message: '', lines_overloaded: detected,
            });

            const stream = makeStream(
                JSON.stringify({ type: 'result', actions: {}, lines_overloaded: detected, message: '', dc_fallback: false }) + '\n',
            );
            mockRunAnalysisStep2Stream.mockResolvedValue({ ok: true, body: stream });

            const { result } = renderHook(() => useAnalysis());

            // Pre-select overloads that won't be detected
            act(() => { result.current.setSelectedOverloads(new Set(['LINE_A', 'LINE_B'])); });

            await act(async () => {
                await result.current.handleRunAnalysis(['LINE_X'], vi.fn(), vi.fn());
            });

            // Should fall back to all detected
            expect(mockRunAnalysisStep2Stream).toHaveBeenCalledWith(
                expect.objectContaining({
                    selected_overloads: detected,
                    all_overloads: detected,
                }),
                expect.any(AbortSignal),
            );
        });
    });

    describe('info message auto-clear', () => {
        it('raises an info toast that the store auto-dismisses after its timeout', () => {
            vi.useFakeTimers();
            const { result } = renderHook(() => useAnalysis());

            act(() => { result.current.setInfoMessage('Temporary message'); });
            expect(toastMessages('info')).toContain('Temporary message');

            act(() => { vi.advanceTimersByTime(DEFAULT_TIMEOUT_MS); });
            expect(toastMessages('info')).not.toContain('Temporary message');

            vi.useRealTimers();
        });
    });

    describe('interaction logging', () => {
        it('logs analysis_step1_started and analysis_step1_completed on successful step1', async () => {
            mockRunAnalysisStep1.mockResolvedValue({
                can_proceed: true,
                message: 'No overloads detected',
                lines_overloaded: [],
            });

            const { result } = renderHook(() => useAnalysis());

            await act(async () => {
                await result.current.handleRunAnalysis(['LINE_X'], vi.fn(), vi.fn());
            });

            const log = interactionLogger.getLog();
            expect(log.length).toBeGreaterThanOrEqual(2);
            expect(log[0].type).toBe('analysis_step1_started');
            expect(log[0].details).toEqual({ element: 'LINE_X' });
            expect(log[1].type).toBe('analysis_step1_completed');
            expect(log[1].details).toEqual({ can_proceed: true, overloads_detected: 0 });
            // Both should share same correlation_id
            expect(log[1].correlation_id).toBe(log[0].correlation_id);
            expect(log[1].duration_ms).toBeGreaterThanOrEqual(0);
        });

        it('logs step1_started but not step1_completed when can_proceed=false', async () => {
            mockRunAnalysisStep1.mockResolvedValue({
                can_proceed: false,
                message: 'Network not loaded',
                lines_overloaded: [],
            });

            const { result } = renderHook(() => useAnalysis());

            await act(async () => {
                await result.current.handleRunAnalysis(['LINE_X'], vi.fn(), vi.fn());
            });

            const log = interactionLogger.getLog();
            expect(log).toHaveLength(1);
            expect(log[0].type).toBe('analysis_step1_started');
        });

        it('logs full step1+step2 cycle with correlation IDs', async () => {
            const detected = ['LINE_A'];
            mockRunAnalysisStep1.mockResolvedValue({
                can_proceed: true, message: '', lines_overloaded: detected,
            });

            const resultEvent = JSON.stringify({
                type: 'result',
                actions: { act_1: { description_unitaire: 'A', rho_before: [1.1], rho_after: [0.9], max_rho: 0.9, max_rho_line: 'LINE_A', is_rho_reduction: true } },
                lines_overloaded: detected,
                message: 'Done', dc_fallback: false,
            });
            const stream = makeStream(`${resultEvent}\n`);
            mockRunAnalysisStep2Stream.mockResolvedValue({ ok: true, body: stream });

            const { result } = renderHook(() => useAnalysis());

            await act(async () => {
                await result.current.handleRunAnalysis(['LINE_X'], vi.fn(), vi.fn());
            });

            const log = interactionLogger.getLog();
            const types = log.map(e => e.type);
            expect(types).toContain('analysis_step1_started');
            expect(types).toContain('analysis_step1_completed');
            expect(types).toContain('analysis_step2_started');
            expect(types).toContain('analysis_step2_completed');

            // step1 pair shares correlation
            const s1Start = log.find(e => e.type === 'analysis_step1_started')!;
            const s1End = log.find(e => e.type === 'analysis_step1_completed')!;
            expect(s1End.correlation_id).toBe(s1Start.correlation_id);

            // step2 pair shares a different correlation
            const s2Start = log.find(e => e.type === 'analysis_step2_started')!;
            const s2End = log.find(e => e.type === 'analysis_step2_completed')!;
            expect(s2End.correlation_id).toBe(s2Start.correlation_id);
            expect(s2Start.correlation_id).not.toBe(s1Start.correlation_id);

            // step2 completion carries the action count under the
            // spec-conformant `n_actions` key (was `actions_count`).
            expect(s2End.details.n_actions).toBe(1);
        });

        it('logs overload_toggled with overload + selected (spec-conformant)', () => {
            // Replay contract (docs/features/interaction-logging.md):
            //   { overload: string, selected: boolean }
            // `selected` must reflect the state AFTER the toggle so a
            // replay agent knows whether this click was a check or uncheck.
            const { result } = renderHook(() => useAnalysis());

            // First toggle — overload moves from unselected → selected.
            act(() => { result.current.handleToggleOverload('LINE_B'); });
            let log = interactionLogger.getLog();
            expect(log).toHaveLength(1);
            expect(log[0].type).toBe('overload_toggled');
            expect(log[0].details).toEqual({ overload: 'LINE_B', selected: true });

            // Second toggle on the same overload — now selected → unselected.
            act(() => { result.current.handleToggleOverload('LINE_B'); });
            log = interactionLogger.getLog();
            expect(log).toHaveLength(2);
            expect(log[1].details).toEqual({ overload: 'LINE_B', selected: false });
        });

        it('logs prioritized_actions_displayed with n_actions (spec-conformant)', () => {
            // Replay contract (docs/features/interaction-logging.md):
            //   { n_actions: number }
            // Previously emitted `{ actions_count }` — the key name drifted
            // from the spec and any replay agent reading
            // `details.n_actions` would see `undefined`.
            const { result } = renderHook(() => useAnalysis());

            act(() => {
                result.current.setPendingAnalysisResult({
                    actions: {
                        a1: { description_unitaire: 'X', rho_before: [1.0], rho_after: [0.9], max_rho: 0.9, max_rho_line: 'L', is_rho_reduction: true },
                        a2: { description_unitaire: 'Y', rho_before: [1.0], rho_after: [0.85], max_rho: 0.85, max_rho_line: 'L', is_rho_reduction: true },
                    },
                    lines_overloaded: ['L'], message: 'OK', dc_fallback: false, pdf_path: null, pdf_url: null,
                });
            });

            act(() => {
                result.current.handleDisplayPrioritizedActions(new Set());
            });

            const log = interactionLogger.getLog();
            expect(log).toHaveLength(1);
            expect(log[0].type).toBe('prioritized_actions_displayed');
            expect(log[0].details).toEqual({ n_actions: 2 });
        });

        it('does not log when handleRunAnalysis is called with empty branch', async () => {
            const { result } = renderHook(() => useAnalysis());

            await act(async () => {
                await result.current.handleRunAnalysis([], vi.fn(), vi.fn());
            });

            expect(interactionLogger.getLog()).toHaveLength(0);
        });
    });

    describe('action origin from recommender model', () => {
        const actionPayload = {
            description_unitaire: 'A', rho_before: [1.1], rho_after: [0.9],
            max_rho: 0.9, max_rho_line: 'LINE_A', is_rho_reduction: true,
        };

        it('stamps origin from active_model on step-2 recommender actions', async () => {
            mockRunAnalysisStep1.mockResolvedValue({ can_proceed: true, message: '', lines_overloaded: ['LINE_A'] });
            const resultEvent = JSON.stringify({
                type: 'result', actions: { act_1: actionPayload },
                active_model: 'random_overflow',
                lines_overloaded: ['LINE_A'], message: 'Done', dc_fallback: false,
            });
            mockRunAnalysisStep2Stream.mockResolvedValue({ ok: true, body: makeStream(`${resultEvent}\n`) });

            const { result } = renderHook(() => useAnalysis());
            await act(async () => {
                await result.current.handleRunAnalysis(['LINE_X'], vi.fn(), vi.fn());
            });

            expect(result.current.pendingAnalysisResult?.actions?.act_1?.origin).toBe('random_overflow');
        });

        it('defaults origin to "expert" when the result event omits active_model', async () => {
            mockRunAnalysisStep1.mockResolvedValue({ can_proceed: true, message: '', lines_overloaded: ['LINE_A'] });
            const resultEvent = JSON.stringify({
                type: 'result', actions: { act_1: actionPayload },
                lines_overloaded: ['LINE_A'], message: 'Done', dc_fallback: false,
            });
            mockRunAnalysisStep2Stream.mockResolvedValue({ ok: true, body: makeStream(`${resultEvent}\n`) });

            const { result } = renderHook(() => useAnalysis());
            await act(async () => {
                await result.current.handleRunAnalysis(['LINE_X'], vi.fn(), vi.fn());
            });

            expect(result.current.pendingAnalysisResult?.actions?.act_1?.origin).toBe('expert');
        });

        it('preserves an existing "user" origin when the recommender re-emits the same action', async () => {
            mockRunAnalysisStep1.mockResolvedValue({ can_proceed: true, message: '', lines_overloaded: ['LINE_A'] });
            const resultEvent = JSON.stringify({
                type: 'result', actions: { firstguess: actionPayload },
                active_model: 'expert',
                lines_overloaded: ['LINE_A'], message: 'Done', dc_fallback: false,
            });
            mockRunAnalysisStep2Stream.mockResolvedValue({ ok: true, body: makeStream(`${resultEvent}\n`) });

            const { result } = renderHook(() => useAnalysis());
            // Operator made a "first guess" before analysis — origin "user".
            act(() => {
                result.current.setResult({
                    pdf_path: null, pdf_url: null,
                    actions: {
                        firstguess: { ...actionPayload, rho_before: null, is_manual: true, origin: 'user' },
                    },
                    lines_overloaded: ['LINE_A'], message: '', dc_fallback: false,
                });
            });

            await act(async () => {
                await result.current.handleRunAnalysis(['LINE_X'], vi.fn(), vi.fn());
            });

            // The recommender re-emitted "firstguess" but the operator's
            // provenance wins — it was their idea first.
            expect(result.current.pendingAnalysisResult?.actions?.firstguess?.origin).toBe('user');
        });

        it('handleDisplayPrioritizedActions preserves origin through the merge', () => {
            const { result } = renderHook(() => useAnalysis());
            act(() => {
                result.current.setPendingAnalysisResult({
                    pdf_path: null, pdf_url: null,
                    actions: {
                        reco_1: { ...actionPayload, origin: 'random_overflow' },
                    },
                    lines_overloaded: ['LINE_A'], message: 'OK', dc_fallback: false,
                });
            });
            act(() => {
                result.current.handleDisplayPrioritizedActions(new Set());
            });
            expect(result.current.result?.actions?.reco_1?.origin).toBe('random_overflow');
        });
    });

    describe('interaction logging — step2 payload', () => {
        it('step2_started carries the full spec payload (element + selected_overloads + all_overloads + monitor_deselected)', async () => {
            // Replay contract (docs/features/interaction-logging.md):
            //   { element, selected_overloads, all_overloads, monitor_deselected }
            // Previously the hook emitted only the latter two, so a
            // replay agent had no way to know which contingency or
            // which overload set was in scope.
            const detected = ['LINE_A', 'LINE_B'];
            mockRunAnalysisStep1.mockResolvedValue({
                can_proceed: true, message: '', lines_overloaded: detected,
            });

            const stream = makeStream(
                JSON.stringify({ type: 'result', actions: {}, lines_overloaded: detected, message: '', dc_fallback: false }) + '\n',
            );
            mockRunAnalysisStep2Stream.mockResolvedValue({ ok: true, body: stream });

            const { result } = renderHook(() => useAnalysis());

            await act(async () => {
                await result.current.handleRunAnalysis(['LINE_X'], vi.fn(), vi.fn());
            });

            const s2Start = interactionLogger.getLog().find(e => e.type === 'analysis_step2_started')!;
            expect(s2Start.details.element).toBe('LINE_X');
            expect(s2Start.details.selected_overloads).toEqual(detected);
            expect(s2Start.details.all_overloads).toEqual(detected);
            expect(s2Start.details.monitor_deselected).toBe(false);
        });
    });
});
