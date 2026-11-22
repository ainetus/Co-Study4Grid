// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import SuggestionRevealBar from './SuggestionRevealBar';

describe('SuggestionRevealBar', () => {
    it('shows the count and both reveal buttons while more than a batch is hidden', () => {
        const onShowMore = vi.fn();
        const onShowAll = vi.fn();
        render(<SuggestionRevealBar shown={3} total={15} step={3} onShowMore={onShowMore} onShowAll={onShowAll} />);
        expect(screen.getByText('3 of 15 suggestions shown')).toBeInTheDocument();
        fireEvent.click(screen.getByTestId('show-more-suggestions'));
        expect(onShowMore).toHaveBeenCalledTimes(1);
        expect(screen.getByTestId('show-more-suggestions')).toHaveTextContent('Show 3 more');
        fireEvent.click(screen.getByTestId('show-all-suggestions'));
        expect(onShowAll).toHaveBeenCalledTimes(1);
        expect(screen.getByTestId('show-all-suggestions')).toHaveAttribute('title', 'Reveal the 12 remaining suggestions');
    });

    it('offers a single button when the next batch takes in every remaining card', () => {
        render(<SuggestionRevealBar shown={12} total={14} step={3} onShowMore={vi.fn()} onShowAll={vi.fn()} />);
        expect(screen.getByTestId('show-more-suggestions')).toHaveTextContent('Show 2 more');
        expect(screen.queryByTestId('show-all-suggestions')).not.toBeInTheDocument();
    });
});
