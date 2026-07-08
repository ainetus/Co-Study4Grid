// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0

import { colors, radius, space } from '../styles/tokens';
import {
    useNotifications,
    dismissNotification,
    type Notification,
    type NotificationSeverity,
} from '../utils/notifications';

/**
 * Renders the typed notification store (D5) as a stack of dismissible
 * toasts pinned bottom-right. Replaces the former `StatusToasts` dual
 * error/info banners: severity is explicit (no `'SUCCESS'` string
 * protocol), every toast has a dismiss control, and the stack lives in an
 * `aria-live` region so assistive tech announces new toasts (errors
 * assertively via `role="alert"`, info/success politely).
 */

const SEVERITY_BG: Record<NotificationSeverity, string> = {
    error: colors.danger,
    success: colors.success,
    info: colors.brand,
};

function Toast({ item }: { item: Notification }) {
    return (
        <div
            role={item.severity === 'error' ? 'alert' : 'status'}
            data-testid={`notification-${item.severity}`}
            style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: space[3],
                background: SEVERITY_BG[item.severity],
                color: colors.textOnBrand,
                padding: `${space[3]} ${space[4]}`,
                borderRadius: radius.sm,
                boxShadow: '0 2px 10px rgba(0,0,0,0.2)',
                maxWidth: 420,
                pointerEvents: 'auto',
                fontWeight: item.severity === 'error' ? 'bold' : 'normal',
                border: '1px solid rgba(255,255,255,0.2)',
            }}
        >
            <span style={{ flex: 1, wordBreak: 'break-word' }}>{item.message}</span>
            <button
                type="button"
                aria-label="Dismiss notification"
                onClick={() => dismissNotification(item.id)}
                style={{
                    background: 'transparent',
                    border: 'none',
                    color: colors.textOnBrand,
                    cursor: 'pointer',
                    fontSize: '1.1em',
                    lineHeight: 1,
                    padding: 0,
                    opacity: 0.85,
                }}
            >
                ×
            </button>
        </div>
    );
}

export default function NotificationHost() {
    const items = useNotifications();
    if (items.length === 0) return null;
    return (
        <div
            aria-live="polite"
            aria-atomic="false"
            style={{
                position: 'fixed',
                bottom: 20,
                right: 20,
                zIndex: 1000,
                display: 'flex',
                flexDirection: 'column',
                gap: space[2],
                pointerEvents: 'none',
            }}
        >
            {items.map(item => <Toast key={item.id} item={item} />)}
        </div>
    );
}
