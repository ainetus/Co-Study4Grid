// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, act, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import NotificationHost from './NotificationHost';
import { notifications, notifyError, notifyInfo, notifySuccess } from '../utils/notifications';

describe('NotificationHost', () => {
    beforeEach(() => { notifications.clear(); cleanup(); });

    it('renders nothing when there are no notifications', () => {
        const { container } = render(<NotificationHost />);
        expect(container).toBeEmptyDOMElement();
    });

    it('renders a toast per notification with severity-tagged testids', () => {
        render(<NotificationHost />);
        act(() => { notifyError('an error'); notifyInfo('some info'); notifySuccess('done'); });
        expect(screen.getByTestId('notification-error')).toHaveTextContent('an error');
        expect(screen.getByTestId('notification-info')).toHaveTextContent('some info');
        expect(screen.getByTestId('notification-success')).toHaveTextContent('done');
    });

    it('announces errors assertively (role=alert) and others politely (role=status)', () => {
        render(<NotificationHost />);
        act(() => { notifyError('boom'); notifyInfo('fyi'); });
        expect(screen.getByTestId('notification-error')).toHaveAttribute('role', 'alert');
        expect(screen.getByTestId('notification-info')).toHaveAttribute('role', 'status');
    });

    it('dismisses a toast when its dismiss button is clicked', async () => {
        const user = userEvent.setup();
        render(<NotificationHost />);
        act(() => { notifyError('go away'); });
        expect(screen.getByText('go away')).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: /dismiss notification/i }));
        expect(screen.queryByText('go away')).not.toBeInTheDocument();
    });
});
