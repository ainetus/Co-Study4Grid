// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import React from 'react';
import { colors } from '../styles/tokens';

interface SuggestionRevealBarProps {
    /** Suggested cards currently listed. */
    shown: number;
    /** Every suggestion in the Suggested list (shown + hidden). */
    total: number;
    /** Cards revealed by "Show N more" (Settings → Suggestions shown at first). */
    step: number;
    onShowMore: () => void;
    onShowAll: () => void;
}

const buttonStyle: React.CSSProperties = {
    padding: '4px 10px',
    background: colors.surface,
    color: colors.brand,
    border: `1px solid ${colors.brand}`,
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '12px',
    fontWeight: 600,
    whiteSpace: 'nowrap',
};

/**
 * Footer of the Suggested Actions list while some suggestions are
 * still hidden by the progressive reveal: "N of M shown", then "Show
 * N more" (the next batch) and "Show all". When the next batch would
 * take in every remaining card, the single "Show N more" button does.
 */
const SuggestionRevealBar: React.FC<SuggestionRevealBarProps> = ({ shown, total, step, onShowMore, onShowAll }) => {
    const hidden = total - shown;
    const nextBatch = Math.min(step, hidden);
    return (
        <div
            data-testid="suggestion-reveal-bar"
            style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                flexWrap: 'wrap', gap: '6px', margin: '4px 0 10px 0',
            }}
        >
            <span
                title="Every suggestion keeps its pin on the Remedial action overview and the overflow graph: click a pin to reveal its card."
                style={{ fontSize: '11px', color: colors.textTertiary, fontStyle: 'italic', cursor: 'help' }}
            >
                {shown} of {total} suggestions shown
            </span>
            <span style={{ display: 'flex', gap: '6px', marginLeft: 'auto' }}>
                <button
                    type="button"
                    data-testid="show-more-suggestions"
                    onClick={onShowMore}
                    style={buttonStyle}
                >
                    Show {nextBatch} more
                </button>
                {hidden > step && (
                    <button
                        type="button"
                        data-testid="show-all-suggestions"
                        onClick={onShowAll}
                        title={`Reveal the ${hidden} remaining suggestions`}
                        style={buttonStyle}
                    >
                        Show all
                    </button>
                )}
            </span>
        </div>
    );
};

export default SuggestionRevealBar;
