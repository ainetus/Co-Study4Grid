// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import DiagramLabelToggles from './DiagramLabelToggles';

describe('DiagramLabelToggles', () => {
    it('flips the VL names and the zoomed-out values independently', () => {
        const onToggleVlNames = vi.fn();
        const onToggleMidValues = vi.fn();
        render(<DiagramLabelToggles showVlNames onToggleVlNames={onToggleVlNames}
            showMidValues onToggleMidValues={onToggleMidValues} />);

        const values = screen.getByTestId('toggle-mid-values');
        expect(values).toHaveAttribute('aria-pressed', 'true');
        fireEvent.click(values);
        expect(onToggleMidValues).toHaveBeenCalledWith(false);
        expect(onToggleVlNames).not.toHaveBeenCalled();

        fireEvent.click(screen.getByTestId('toggle-vl-names'));
        expect(onToggleVlNames).toHaveBeenCalledWith(false);
    });

    it('shows a toggle only when it is wired', () => {
        render(<DiagramLabelToggles showVlNames={false} showMidValues={false} onToggleMidValues={vi.fn()} />);
        expect(screen.queryByTestId('toggle-vl-names')).toBeNull();
        expect(screen.getByTestId('toggle-mid-values')).toHaveAttribute('aria-pressed', 'false');
    });
});
