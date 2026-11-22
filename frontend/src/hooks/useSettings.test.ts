// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study. 

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useSettings } from './useSettings';
import { interactionLogger } from '../utils/interactionLogger';
import { api } from '../api';
import type { UserConfig } from '../api';

// Mock the api module
vi.mock('../api', () => ({
    api: {
        pickPath: vi.fn(),
        getUserConfig: vi.fn().mockResolvedValue({}),
        getConfigFilePath: vi.fn().mockResolvedValue(''),
        saveUserConfig: vi.fn().mockResolvedValue({}),
        setConfigFilePath: vi.fn().mockResolvedValue({ config_file_path: '', config: {} }),
    },
}));

describe('useSettings — interaction logging', () => {
    beforeEach(() => {
        interactionLogger.clear();
        vi.clearAllMocks();
    });

    it('logs settings_opened with tab when handleOpenSettings is called', () => {
        const { result } = renderHook(() => useSettings());

        act(() => {
            result.current.handleOpenSettings('recommender');
        });

        const log = interactionLogger.getLog();
        expect(log).toHaveLength(1);
        expect(log[0].type).toBe('settings_opened');
        expect(log[0].details).toEqual({ tab: 'recommender' });
    });

    it('logs settings_opened with default tab "paths"', () => {
        const { result } = renderHook(() => useSettings());

        act(() => {
            result.current.handleOpenSettings();
        });

        const log = interactionLogger.getLog();
        expect(log[0].details).toEqual({ tab: 'paths' });
    });

    it('logs settings_cancelled when handleCloseSettings is called', () => {
        const { result } = renderHook(() => useSettings());

        // Open first to set backup
        act(() => { result.current.handleOpenSettings(); });
        interactionLogger.clear();

        act(() => { result.current.handleCloseSettings(); });

        const log = interactionLogger.getLog();
        expect(log).toHaveLength(1);
        expect(log[0].type).toBe('settings_cancelled');
    });

    it('logs path_picked when pickSettingsPath succeeds', async () => {
        const { api } = await import('../api');
        (api.pickPath as ReturnType<typeof vi.fn>).mockResolvedValue('/data/network.xiidm');

        const { result } = renderHook(() => useSettings());
        const setter = vi.fn();

        await act(async () => {
            await result.current.pickSettingsPath('file', setter);
        });

        const log = interactionLogger.getLog();
        expect(log).toHaveLength(1);
        expect(log[0].type).toBe('path_picked');
        expect(log[0].details).toEqual({ type: 'file', path: '/data/network.xiidm' });
        expect(setter).toHaveBeenCalledWith('/data/network.xiidm');
    });

    it('does not log path_picked when pickSettingsPath returns empty', async () => {
        const { api } = await import('../api');
        (api.pickPath as ReturnType<typeof vi.fn>).mockResolvedValue('');

        const { result } = renderHook(() => useSettings());

        await act(async () => {
            await result.current.pickSettingsPath('dir', vi.fn());
        });

        expect(interactionLogger.getLog()).toHaveLength(0);
    });

    it('does not log path_picked when pickSettingsPath throws', async () => {
        const { api } = await import('../api');
        (api.pickPath as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('No picker'));

        const { result } = renderHook(() => useSettings());

        await act(async () => {
            await result.current.pickSettingsPath('file', vi.fn());
        });

        expect(interactionLogger.getLog()).toHaveLength(0);
    });

    it('logs settings_opened for each tab type', () => {
        const { result } = renderHook(() => useSettings());

        const tabs = ['paths', 'recommender', 'configurations'] as const;
        for (const tab of tabs) {
            act(() => { result.current.handleOpenSettings(tab); });
        }

        const log = interactionLogger.getLog();
        expect(log).toHaveLength(3);
        expect(log.map(e => e.details.tab)).toEqual(['paths', 'recommender', 'configurations']);
    });

    // Bug 4: the file-picker buttons used to silently fail when the native
    // dialog couldn't open (no display, tkinter missing). They now surface
    // the backend error via window.alert so the user understands *why*
    // nothing is happening, while still leaving the setter untouched.
    describe('pickSettingsPath error surfacing (Bug 4)', () => {
        it('calls window.alert with the backend error message when the picker fails', async () => {
            const { api } = await import('../api');
            (api.pickPath as ReturnType<typeof vi.fn>).mockRejectedValue(
                new Error('tkinter: no display'),
            );
            const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => { });
            const setter = vi.fn();

            const { result } = renderHook(() => useSettings());

            await act(async () => {
                await result.current.pickSettingsPath('file', setter);
            });

            expect(alertSpy).toHaveBeenCalledTimes(1);
            const message = alertSpy.mock.calls[0][0] as string;
            expect(message).toContain('tkinter: no display');
            expect(setter).not.toHaveBeenCalled();

            alertSpy.mockRestore();
        });

        it('does not alert when the picker succeeds', async () => {
            const { api } = await import('../api');
            (api.pickPath as ReturnType<typeof vi.fn>).mockResolvedValue('/tmp/x.xiidm');
            const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => { });
            const setter = vi.fn();

            const { result } = renderHook(() => useSettings());
            await act(async () => {
                await result.current.pickSettingsPath('file', setter);
            });

            expect(alertSpy).not.toHaveBeenCalled();
            expect(setter).toHaveBeenCalledWith('/tmp/x.xiidm');
            alertSpy.mockRestore();
        });

        it('hints at backend version mismatch when the request 404s', async () => {
            // axios error shape with response.status — what the user
            // hits when the picker endpoint isn't on the running
            // backend (stale instance, mismatched code).
            const { api } = await import('../api');
            const axiosLike = Object.assign(new Error('Request failed with status code 404'), {
                response: { status: 404 },
            });
            (api.pickPath as ReturnType<typeof vi.fn>).mockRejectedValue(axiosLike);
            const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => { });

            const { result } = renderHook(() => useSettings());
            await act(async () => {
                await result.current.pickSettingsPath('file', vi.fn());
            });

            expect(alertSpy).toHaveBeenCalledTimes(1);
            const message = alertSpy.mock.calls[0][0] as string;
            expect(message).toContain('Request failed with status code 404');
            expect(message).toContain('http://127.0.0.1:8000');
            expect(message).toMatch(/restart it after pulling the latest code/);
            alertSpy.mockRestore();
        });

        it('hints at backend not running when the request fails with a network error', async () => {
            const { api } = await import('../api');
            const axiosLike = Object.assign(new Error('Network Error'), {
                code: 'ERR_NETWORK',
            });
            (api.pickPath as ReturnType<typeof vi.fn>).mockRejectedValue(axiosLike);
            const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => { });

            const { result } = renderHook(() => useSettings());
            await act(async () => {
                await result.current.pickSettingsPath('file', vi.fn());
            });

            expect(alertSpy).toHaveBeenCalledTimes(1);
            const message = alertSpy.mock.calls[0][0] as string;
            expect(message).toContain('http://127.0.0.1:8000');
            alertSpy.mockRestore();
        });

        it('does not add the backend hint for backend-reported errors (e.g. tkinter missing)', async () => {
            // When the backend itself returns 200 with an `error` field
            // (the picker subprocess died, tkinter missing, …) the
            // problem isn't transport — surfacing the backend hint
            // would be misleading. api.pickPath rethrows the error
            // string as a plain Error, no `response` attached.
            const { api } = await import('../api');
            (api.pickPath as ReturnType<typeof vi.fn>).mockRejectedValue(
                new Error('No module named tkinter'),
            );
            const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => { });

            const { result } = renderHook(() => useSettings());
            await act(async () => {
                await result.current.pickSettingsPath('file', vi.fn());
            });

            const message = alertSpy.mock.calls[0][0] as string;
            expect(message).toContain('No module named tkinter');
            expect(message).not.toContain('http://127.0.0.1:8000');
            alertSpy.mockRestore();
        });
    });
});

describe('useSettings — suggestions shown at first', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('defaults to 3', () => {
        const { result } = renderHook(() => useSettings());
        expect(result.current.nInitialSuggestions).toBe(3);
    });

    it('loads the persisted value and saves changes to the user config', async () => {
        vi.mocked(api.getUserConfig).mockResolvedValueOnce({ n_initial_suggestions: 5 } as UserConfig);
        const { result } = renderHook(() => useSettings());
        await waitFor(() => expect(result.current.nInitialSuggestions).toBe(5));
        act(() => { result.current.setNInitialSuggestions(8); });
        await waitFor(() => expect(api.saveUserConfig).toHaveBeenLastCalledWith(
            expect.objectContaining({ n_initial_suggestions: 8 }),
        ));
    });

    it('is display-only: never sent to /api/config', () => {
        const { result } = renderHook(() => useSettings());
        expect(result.current.buildConfigRequest()).not.toHaveProperty('n_initial_suggestions');
    });

    it('Cancel restores the value the Settings modal opened with', () => {
        const { result } = renderHook(() => useSettings());
        act(() => { result.current.handleOpenSettings('recommender'); });
        act(() => { result.current.setNInitialSuggestions(7); });
        act(() => { result.current.handleCloseSettings(); });
        expect(result.current.nInitialSuggestions).toBe(3);
    });
});
