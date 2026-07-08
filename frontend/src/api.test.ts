// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study. 

import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { api } from './api';

vi.mock('axios');
const mockedAxios = vi.mocked(axios, true);

describe('api client', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('updateConfig', () => {
        it('sends POST to /api/config', async () => {
            const config = {
                network_path: '/test/path',
                action_file_path: '/test/actions.json',
                min_line_reconnections: 2.0,
                min_close_coupling: 3.0,
                min_open_coupling: 2.0,
                min_line_disconnections: 3.0,
                n_prioritized_actions: 10,
                monitoring_factor: 0.95,
                pre_existing_overload_threshold: 0.02,
                ignore_reconnections: false,
                pypowsybl_fast_mode: true
            };
            mockedAxios.post.mockResolvedValue({ data: { status: 'success' } });

            const result = await api.updateConfig(config);
            expect(mockedAxios.post).toHaveBeenCalledWith(
                'http://127.0.0.1:8000/api/config',
                config,
            );
            expect(result).toEqual({ status: 'success' });
        });
    });

    describe('getBranches', () => {
        it('sends GET to /api/branches and returns branches array', async () => {
            mockedAxios.get.mockResolvedValue({
                data: { branches: ['LINE_A', 'LINE_B'], name_map: {} },
            });

            const result = await api.getBranches();
            expect(mockedAxios.get).toHaveBeenCalledWith(
                'http://127.0.0.1:8000/api/branches',
            );
            expect(result).toEqual({ branches: ['LINE_A', 'LINE_B'], name_map: {} });
        });
    });

    describe('getVoltageLevels', () => {
        it('returns voltage levels array', async () => {
            mockedAxios.get.mockResolvedValue({
                data: { voltage_levels: ['VL1', 'VL2'], name_map: {} },
            });

            const result = await api.getVoltageLevels();
            expect(result).toEqual({ voltage_levels: ['VL1', 'VL2'], name_map: {} });
        });
    });

    describe('getNominalVoltages', () => {
        it('returns mapping and unique_kv', async () => {
            const responseData = {
                mapping: { VL1: 400, VL2: 225 },
                unique_kv: [225, 400],
            };
            mockedAxios.get.mockResolvedValue({ data: responseData });

            const result = await api.getNominalVoltages();
            expect(result).toEqual(responseData);
        });
    });

    describe('setRecommenderModel', () => {
        it('POSTs the model + compute_overflow_graph to /api/recommender-model', async () => {
            // Lightweight model swap — does NOT reload the network. Used
            // by useSettings whenever the operator changes the model in
            // the Settings modal OR the dropdown above Analyze & Suggest.
            mockedAxios.post.mockResolvedValue({
                data: { status: 'success', active_model: 'random_overflow', compute_overflow_graph: true },
            });

            const result = await api.setRecommenderModel('random_overflow', true);
            expect(mockedAxios.post).toHaveBeenCalledWith(
                'http://127.0.0.1:8000/api/recommender-model',
                { model: 'random_overflow', compute_overflow_graph: true },
            );
            expect(result).toEqual({
                status: 'success',
                active_model: 'random_overflow',
                compute_overflow_graph: true,
            });
        });
    });

    describe('getNetworkDiagram', () => {
        it('parses the text/plain header+SVG response', async () => {
            // Server now returns:  {json header}\n<svg>...</svg>
            // The client splits on the first newline rather than doing
            // a JSON.parse of the full body (saves ~500 ms on 25 MB
            // grids — see docs/performance/history/loading-parallel.md).
            const header = { metadata: null, lines_overloaded: ['X'], lines_overloaded_rho: [1.05] };
            const svg = '<svg id="n"/>';
            const body = JSON.stringify(header) + '\n' + svg;
            const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
                ok: true,
                status: 200,
                statusText: 'OK',
                text: async () => body,
            } as Response);

            const result = await api.getNetworkDiagram();
            expect(fetchSpy).toHaveBeenCalledWith(
                'http://127.0.0.1:8000/api/network-diagram?format=text'
            );
            expect(result).toEqual({ ...header, svg });
            fetchSpy.mockRestore();
        });

        it('throws on non-ok status', async () => {
            const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
                ok: false,
                status: 500,
                statusText: 'Server Error',
                text: async () => 'boom',
            } as Response);

            await expect(api.getNetworkDiagram()).rejects.toThrow(/HTTP 500/);
            fetchSpy.mockRestore();
        });
    });

    describe('getContingencyDiagram', () => {
        it('sends POST with the disconnected-elements list', async () => {
            const diagramData = { svg: '<svg/>', metadata: '{}', lf_converged: true };
            mockedAxios.post.mockResolvedValue({ data: diagramData });

            const result = await api.getContingencyDiagram(['LINE_A']);
            expect(mockedAxios.post).toHaveBeenCalledWith(
                'http://127.0.0.1:8000/api/contingency-diagram',
                { disconnected_elements: ['LINE_A'] },
            );
            expect(result).toEqual(diagramData);
        });
    });

    describe('getActionVariantDiagram', () => {
        it('sends POST with action ID', async () => {
            mockedAxios.post.mockResolvedValue({
                data: { svg: '<svg/>', metadata: '{}', action_id: 'act_1' },
            });

            const result = await api.getActionVariantDiagram('act_1');
            expect(mockedAxios.post).toHaveBeenCalledWith(
                'http://127.0.0.1:8000/api/action-variant-diagram',
                { action_id: 'act_1' },
            );
            expect(result.action_id).toBe('act_1');
        });
    });

    describe('getAvailableActions', () => {
        it('returns actions list', async () => {
            const actions = [{ id: 'act_1', description: 'Test' }];
            mockedAxios.get.mockResolvedValue({
                data: { actions },
            });

            const result = await api.getAvailableActions();
            expect(result).toEqual(actions);
        });
    });

    describe('simulateManualAction', () => {
        it('sends POST with action_id and the disconnected-elements list', async () => {
            const responseData = {
                action_id: 'act_1',
                description_unitaire: 'Open line',
                rho_before: [0.95],
                rho_after: [0.80],
                max_rho: 0.80,
                max_rho_line: 'LINE_A',
                is_rho_reduction: true,
                lines_overloaded: ['LINE_A'],
            };
            mockedAxios.post.mockResolvedValue({ data: responseData });

            const result = await api.simulateManualAction('act_1', ['LINE_B']);
            expect(mockedAxios.post).toHaveBeenCalledWith(
                'http://127.0.0.1:8000/api/simulate-manual-action',
                { action_id: 'act_1', disconnected_elements: ['LINE_B'], action_content: null, lines_overloaded: null, target_mw: null, target_tap: null },
            );
            expect(result).toEqual(responseData);
        });
    });

    describe('pickPath', () => {
        it('sends GET with file type parameter', async () => {
            mockedAxios.get.mockResolvedValue({
                data: { path: '/home/user/test.xiidm' },
            });

            const result = await api.pickPath('file');
            expect(mockedAxios.get).toHaveBeenCalledWith(
                'http://127.0.0.1:8000/api/pick-path?type=file',
            );
            expect(result).toBe('/home/user/test.xiidm');
        });

        it('sends GET with dir type parameter', async () => {
            mockedAxios.get.mockResolvedValue({
                data: { path: '/home/user/networks' },
            });

            const result = await api.pickPath('dir');
            expect(mockedAxios.get).toHaveBeenCalledWith(
                'http://127.0.0.1:8000/api/pick-path?type=dir',
            );
            expect(result).toBe('/home/user/networks');
        });

        // Bug 4: when the backend returns an error field (e.g. tkinter
        // failed to launch), the API client must throw so the caller can
        // surface a visible message instead of silently returning "".
        it('throws when the backend response contains an error field', async () => {
            mockedAxios.get.mockResolvedValue({
                data: { path: '', error: 'tkinter: no display' },
            });

            await expect(api.pickPath('file')).rejects.toThrow('tkinter: no display');
        });
    });

    describe('runAnalysisStep1', () => {
        it('sends POST with the disconnected-elements list and returns detection result', async () => {
            const responseData = {
                lines_overloaded: ['LINE_A', 'LINE_B'],
                message: 'Detected 2 overloads',
                can_proceed: true,
            };
            mockedAxios.post.mockResolvedValue({ data: responseData });

            const result = await api.runAnalysisStep1(['LINE_X']);
            expect(mockedAxios.post).toHaveBeenCalledWith(
                'http://127.0.0.1:8000/api/run-analysis-step1',
                { disconnected_elements: ['LINE_X'] },
                { signal: undefined },
            );
            expect(result).toEqual(responseData);
        });

        it('returns can_proceed=false when no overloads detected', async () => {
            const responseData = {
                lines_overloaded: [],
                message: 'No overloads detected',
                can_proceed: false,
            };
            mockedAxios.post.mockResolvedValue({ data: responseData });

            const result = await api.runAnalysisStep1(['LINE_Y']);
            expect(result.can_proceed).toBe(false);
            expect(result.lines_overloaded).toEqual([]);
        });
    });

    describe('runAnalysisStep2Stream', () => {
        it('sends POST with selected_overloads, all_overloads, and monitor_deselected', async () => {
            const mockResponse = {
                ok: true,
                statusText: 'OK',
            } as unknown as Response;

            const originalFetch = globalThis.fetch;
            globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

            try {
                await api.runAnalysisStep2Stream({
                    selected_overloads: ['LINE_A'],
                    all_overloads: ['LINE_A', 'LINE_B'],
                    monitor_deselected: true,
                });

                expect(globalThis.fetch).toHaveBeenCalledWith(
                    'http://127.0.0.1:8000/api/run-analysis-step2',
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            selected_overloads: ['LINE_A'],
                            all_overloads: ['LINE_A', 'LINE_B'],
                            monitor_deselected: true,
                            additional_lines_to_cut: [],
                        }),
                    },
                );
            } finally {
                globalThis.fetch = originalFetch;
            }
        });

        it('returns raw Response for streaming consumption', async () => {
            const mockResponse = {
                ok: true,
                statusText: 'OK',
                body: 'mock-body',
            } as unknown as Response;

            const originalFetch = globalThis.fetch;
            globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

            try {
                const result = await api.runAnalysisStep2Stream({
                    selected_overloads: ['LINE_A'],
                    all_overloads: ['LINE_A'],
                    monitor_deselected: false,
                });
                // Returns the raw Response, not parsed data
                expect(result).toBe(mockResponse);
                expect(result.body).toBe('mock-body');
            } finally {
                globalThis.fetch = originalFetch;
            }
        });

        it('throws on non-ok response', async () => {
            const mockResponse = {
                ok: false,
                statusText: 'Internal Server Error',
            } as unknown as Response;

            const originalFetch = globalThis.fetch;
            globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

            try {
                await expect(
                    api.runAnalysisStep2Stream({
                        selected_overloads: ['LINE_A'],
                        all_overloads: ['LINE_A'],
                        monitor_deselected: false,
                    }),
                ).rejects.toThrow('Analysis Resolution failed');
            } finally {
                globalThis.fetch = originalFetch;
            }
        });

        it('passes monitor_deselected=false when not monitoring deselected overloads', async () => {
            const mockResponse = { ok: true, statusText: 'OK' } as unknown as Response;
            const originalFetch = globalThis.fetch;
            globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

            try {
                await api.runAnalysisStep2Stream({
                    selected_overloads: ['LINE_A', 'LINE_B'],
                    all_overloads: ['LINE_A', 'LINE_B', 'LINE_C'],
                    monitor_deselected: false,
                });

                const body = JSON.parse(
                    (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body,
                );
                expect(body.monitor_deselected).toBe(false);
                expect(body.all_overloads).toEqual(['LINE_A', 'LINE_B', 'LINE_C']);
                expect(body.selected_overloads).toEqual(['LINE_A', 'LINE_B']);
            } finally {
                globalThis.fetch = originalFetch;
            }
        });
    });

    describe('legacy runAnalysis removal', () => {
        it('api object does not have a runAnalysis method', () => {
            expect((api as Record<string, unknown>).runAnalysis).toBeUndefined();
        });
    });

    describe('restoreAnalysisContext', () => {
        it('sends POST to /api/restore-analysis-context with the monitored-line set', async () => {
            // Parity with the standalone HTML mirror
            // (standalone_interface.html:3857). Re-pushes the session's
            // `lines_we_care_about` to the backend on reload so later
            // simulate-action calls use the per-study set instead of
            // the backend's default.
            mockedAxios.post.mockResolvedValue({
                data: {
                    status: 'success',
                    lines_we_care_about_count: 3,
                    computed_pairs_count: 0,
                },
            });

            const params = {
                lines_we_care_about: ['LINE_MON1', 'LINE_MON2', 'LINE_MON3'],
                disconnected_elements: ['LINE_A'],
                lines_overloaded: ['LINE_OL1'],
                computed_pairs: null,
            };
            const result = await api.restoreAnalysisContext(params);
            expect(mockedAxios.post).toHaveBeenCalledWith(
                'http://127.0.0.1:8000/api/restore-analysis-context',
                params,
            );
            expect(result.status).toBe('success');
            expect(result.lines_we_care_about_count).toBe(3);
        });
    });
});
