// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0

// Typed notification store (D5, 2026-07). Replaces the two ad-hoc toast
// channels — a sticky-but-undismissable `error` string and an
// auto-3s-hiding `infoMessage` string whose green-vs-blue colour was
// decided by a magic `'SUCCESS'` prefix — with ONE store carrying an
// explicit severity, a sticky flag, per-item dismissal and (via
// NotificationHost) an aria-live region.
//
// It is a module singleton (mirroring `interactionLogger`) so any layer —
// App, hooks, even non-React helpers — can raise a notification without
// prop-threading a setter, and `useNotifications()` subscribes React to it
// through `useSyncExternalStore`.

import { useSyncExternalStore } from 'react';

export type NotificationSeverity = 'error' | 'success' | 'info';

export interface Notification {
    /** Monotonic id, stable for the item's lifetime (used as React key). */
    readonly id: number;
    readonly severity: NotificationSeverity;
    readonly message: string;
    /** Sticky items stay until dismissed; others auto-expire. */
    readonly sticky: boolean;
}

export interface NotifyOptions {
    /** Override the severity default (errors sticky, info/success not). */
    sticky?: boolean;
    /** Auto-dismiss delay for non-sticky items. Defaults to
     *  `DEFAULT_TIMEOUT_MS`. Ignored when sticky. */
    timeoutMs?: number;
}

/** Non-sticky items auto-dismiss after this long by default. */
export const DEFAULT_TIMEOUT_MS = 4000;

type Timer = ReturnType<typeof setTimeout>;

class NotificationStore {
    private items: readonly Notification[] = [];
    private readonly listeners = new Set<() => void>();
    private readonly timers = new Map<number, Timer>();
    private seq = 0;

    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    };

    /** Stable reference between mutations — required by useSyncExternalStore. */
    getSnapshot = (): readonly Notification[] => this.items;

    private emit(): void {
        for (const listener of this.listeners) listener();
    }

    private clearTimer(id: number): void {
        const t = this.timers.get(id);
        if (t !== undefined) {
            clearTimeout(t);
            this.timers.delete(id);
        }
    }

    notify(severity: NotificationSeverity, message: string, options: NotifyOptions = {}): number {
        const text = (message ?? '').trim();
        if (!text) return -1;
        const sticky = options.sticky ?? severity === 'error';

        // De-dupe: an identical (severity, message) already showing is
        // refreshed rather than stacked — stops a debounced/retrying caller
        // (e.g. the SLD preview) from piling up copies of one error.
        const existing = this.items.find(n => n.severity === severity && n.message === text);
        if (existing) {
            if (!sticky) this.scheduleExpiry(existing.id, options.timeoutMs);
            return existing.id;
        }

        const id = ++this.seq;
        this.items = [...this.items, { id, severity, message: text, sticky }];
        if (!sticky) this.scheduleExpiry(id, options.timeoutMs);
        this.emit();
        return id;
    }

    private scheduleExpiry(id: number, timeoutMs?: number): void {
        this.clearTimer(id);
        this.timers.set(id, setTimeout(() => this.dismiss(id), timeoutMs ?? DEFAULT_TIMEOUT_MS));
    }

    dismiss(id: number): void {
        this.clearTimer(id);
        const next = this.items.filter(n => n.id !== id);
        if (next.length !== this.items.length) {
            this.items = next;
            this.emit();
        }
    }

    /** Remove every notification of a severity (the "clear the error" gesture). */
    clearSeverity(severity: NotificationSeverity): void {
        const next = this.items.filter(n => n.severity !== severity);
        if (next.length !== this.items.length) {
            for (const n of this.items) if (n.severity === severity) this.clearTimer(n.id);
            this.items = next;
            this.emit();
        }
    }

    /** Remove everything (e.g. on a study reset). */
    clear(): void {
        if (this.items.length === 0) return;
        for (const id of this.timers.keys()) this.clearTimer(id);
        this.items = [];
        this.emit();
    }
}

export const notifications = new NotificationStore();

// --- Convenience raisers -------------------------------------------------

/** Raise a sticky error toast (stays until dismissed). */
export function notifyError(message: string): number {
    return notifications.notify('error', message);
}

/** Raise an auto-dismissing info toast. */
export function notifyInfo(message: string): number {
    return notifications.notify('info', message);
}

/** Raise an auto-dismissing success toast (replaces the `'SUCCESS:'` prefix). */
export function notifySuccess(message: string): number {
    return notifications.notify('success', message);
}

export function dismissNotification(id: number): void {
    notifications.dismiss(id);
}

export function clearNotifications(): void {
    notifications.clear();
}

// --- React binding -------------------------------------------------------

/** Subscribe a component to the live notification list. */
export function useNotifications(): readonly Notification[] {
    return useSyncExternalStore(notifications.subscribe, notifications.getSnapshot, notifications.getSnapshot);
}
