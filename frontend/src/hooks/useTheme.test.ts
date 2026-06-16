// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTheme, resolveInitialTheme } from './useTheme';
import { interactionLogger } from '../utils/interactionLogger';

vi.mock('../utils/interactionLogger', () => ({
    interactionLogger: { record: vi.fn() },
}));

const STORAGE_KEY = 'cs4g-theme';

function mockMatchMedia(prefersDark: boolean) {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
        matches: query.includes('dark') ? prefersDark : false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
    }));
}

describe('resolveInitialTheme', () => {
    beforeEach(() => {
        localStorage.clear();
        mockMatchMedia(false);
    });

    it('returns the persisted theme when present', () => {
        localStorage.setItem(STORAGE_KEY, 'dark');
        expect(resolveInitialTheme()).toBe('dark');
        localStorage.setItem(STORAGE_KEY, 'light');
        expect(resolveInitialTheme()).toBe('light');
    });

    it('ignores a malformed persisted value and falls back to the OS pref', () => {
        localStorage.setItem(STORAGE_KEY, 'banana');
        mockMatchMedia(true);
        expect(resolveInitialTheme()).toBe('dark');
    });

    it('falls back to the OS preference when nothing is persisted', () => {
        mockMatchMedia(true);
        expect(resolveInitialTheme()).toBe('dark');
        mockMatchMedia(false);
        expect(resolveInitialTheme()).toBe('light');
    });

    it('defaults to light when matchMedia is unavailable', () => {
        // @ts-expect-error — intentionally remove matchMedia for the test.
        window.matchMedia = undefined;
        expect(resolveInitialTheme()).toBe('light');
    });
});

describe('useTheme', () => {
    beforeEach(() => {
        localStorage.clear();
        mockMatchMedia(false);
        document.documentElement.removeAttribute('data-theme');
        document.documentElement.style.colorScheme = '';
        vi.clearAllMocks();
    });

    afterEach(() => {
        document.documentElement.removeAttribute('data-theme');
        document.documentElement.style.colorScheme = '';
    });

    it('initialises from the OS preference and applies it to <html>', () => {
        mockMatchMedia(true);
        const { result } = renderHook(() => useTheme());
        expect(result.current.theme).toBe('dark');
        expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
        expect(document.documentElement.style.colorScheme).toBe('dark');
    });

    it('initialises from a persisted value over the OS preference', () => {
        mockMatchMedia(true);
        localStorage.setItem(STORAGE_KEY, 'light');
        const { result } = renderHook(() => useTheme());
        expect(result.current.theme).toBe('light');
        expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    });

    it('toggleTheme flips the theme, the <html> attribute and persists it', () => {
        const { result } = renderHook(() => useTheme());
        expect(result.current.theme).toBe('light');

        act(() => result.current.toggleTheme());

        expect(result.current.theme).toBe('dark');
        expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
        expect(document.documentElement.style.colorScheme).toBe('dark');
        expect(localStorage.getItem(STORAGE_KEY)).toBe('dark');

        act(() => result.current.toggleTheme());

        expect(result.current.theme).toBe('light');
        expect(localStorage.getItem(STORAGE_KEY)).toBe('light');
    });

    it('records a theme_toggled interaction event with the new theme', () => {
        const { result } = renderHook(() => useTheme());
        act(() => result.current.toggleTheme());
        expect(interactionLogger.record).toHaveBeenCalledWith('theme_toggled', { theme: 'dark' });
        act(() => result.current.toggleTheme());
        expect(interactionLogger.record).toHaveBeenCalledWith('theme_toggled', { theme: 'light' });
    });

    it('setTheme applies an explicit theme without a toggle', () => {
        const { result } = renderHook(() => useTheme());
        act(() => result.current.setTheme('dark'));
        expect(result.current.theme).toBe('dark');
        expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
        // setTheme is not a user gesture toggle — it must not log.
        expect(interactionLogger.record).not.toHaveBeenCalled();
    });
});
