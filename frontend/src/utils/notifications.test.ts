// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    notifications,
    notifyError,
    notifyInfo,
    notifySuccess,
    dismissNotification,
    clearNotifications,
    DEFAULT_TIMEOUT_MS,
} from './notifications';

const snap = () => notifications.getSnapshot();

describe('notification store', () => {
    beforeEach(() => { notifications.clear(); });

    it('raises a notification with the given severity + message', () => {
        notifyError('boom');
        expect(snap()).toHaveLength(1);
        expect(snap()[0]).toMatchObject({ severity: 'error', message: 'boom' });
    });

    it('trims and ignores empty messages', () => {
        expect(notifyInfo('   ')).toBe(-1);
        expect(snap()).toHaveLength(0);
    });

    it('makes errors sticky and info/success non-sticky by default', () => {
        notifyError('e');
        notifyInfo('i');
        notifySuccess('s');
        const bySeverity = Object.fromEntries(snap().map(n => [n.severity, n.sticky]));
        expect(bySeverity).toEqual({ error: true, info: false, success: false });
    });

    it('de-dupes an identical severity+message instead of stacking', () => {
        notifyError('same');
        notifyError('same');
        expect(snap()).toHaveLength(1);
        // A different message, or a different severity, is a separate toast.
        notifyError('other');
        notifyInfo('same');
        expect(snap()).toHaveLength(3);
    });

    it('dismisses a single notification by id', () => {
        const id = notifyError('x');
        notifyError('y');
        dismissNotification(id);
        expect(snap().map(n => n.message)).toEqual(['y']);
    });

    it('clears a whole severity', () => {
        notifyError('e1');
        notifyError('e2');
        notifyInfo('keep');
        notifications.clearSeverity('error');
        expect(snap().map(n => n.message)).toEqual(['keep']);
    });

    it('clears everything', () => {
        notifyError('e');
        notifyInfo('i');
        clearNotifications();
        expect(snap()).toHaveLength(0);
    });

    it('notifies subscribers on change', () => {
        const listener = vi.fn();
        const unsub = notifications.subscribe(listener);
        notifyError('a');
        expect(listener).toHaveBeenCalledTimes(1);
        unsub();
        notifyError('b');
        expect(listener).toHaveBeenCalledTimes(1);
    });

    it('returns a stable snapshot reference between mutations', () => {
        notifyError('a');
        const first = snap();
        expect(snap()).toBe(first); // no mutation → same array reference
        notifyInfo('b');
        expect(snap()).not.toBe(first); // mutation → new reference
    });

    describe('auto-expiry', () => {
        beforeEach(() => { vi.useFakeTimers(); });
        afterEach(() => { vi.useRealTimers(); });

        it('auto-dismisses non-sticky toasts after the timeout', () => {
            notifyInfo('temp');
            expect(snap()).toHaveLength(1);
            vi.advanceTimersByTime(DEFAULT_TIMEOUT_MS);
            expect(snap()).toHaveLength(0);
        });

        it('keeps sticky (error) toasts past the timeout', () => {
            notifyError('stays');
            vi.advanceTimersByTime(DEFAULT_TIMEOUT_MS * 3);
            expect(snap()).toHaveLength(1);
        });
    });
});
