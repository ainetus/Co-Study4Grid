// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import React from 'react';
import type { ActionTypeKind } from '../utils/actionTypes';

// Monochrome glyphs drawn with `currentColor` so the caller owns the
// tint. Kept deliberately uncoloured — the action-type ring is the
// "uncoloured pictogram" family, in contrast with the colour-coded
// severity ring.
const GLYPHS: Record<ActionTypeKind, React.ReactNode> = {
    // Line disconnection — a vertical conductor trace, dashed to
    // signal the line is cut. The vertical orientation keeps line
    // actions distinct from the horizontal coupler-switch glyphs.
    disco: <path d="M8 2 V14" strokeDasharray="2.8 2.4" />,
    // Line reconnection — the same vertical conductor trace, solid:
    // the line is restored.
    reco: <path d="M8 2 V14" />,
    // Open coupling — a switch with the blade swung clear of the
    // right contact: the two busbar nodes of the voltage level stay
    // split.
    open: (
        <>
            <circle cx="2" cy="8" r="1.15" fill="currentColor" stroke="none" />
            <path d="M2 8 H5.6" />
            <path d="M5.6 8 L10 3.7" />
            <path d="M11.4 8 H14" />
            <circle cx="14" cy="8" r="1.15" fill="currentColor" stroke="none" />
        </>
    ),
    // Close coupling — the switch blade seated flat, merging the two
    // busbar nodes of the voltage level into one.
    close: (
        <>
            <circle cx="2" cy="8" r="1.15" fill="currentColor" stroke="none" />
            <path d="M2 8 H14" />
            <circle cx="14" cy="8" r="1.15" fill="currentColor" stroke="none" />
        </>
    ),
    // Down arrow pressed onto a load bar.
    ls: (
        <>
            <path d="M8 2 V9.5" />
            <path d="M4.8 6.3 L8 9.5 L11.2 6.3" />
            <path d="M3 13.5 H13" />
        </>
    ),
    // Sun (renewable) with a down arrow — generation curtailed.
    rc: (
        <>
            <circle cx="8" cy="5.4" r="2.3" />
            <path d="M8 1.1 V2.1" />
            <path d="M3.7 5.4 H4.7" />
            <path d="M11.3 5.4 H12.3" />
            <path d="M4.9 2.3 L5.6 3" />
            <path d="M11.1 2.3 L10.4 3" />
            <path d="M5.5 10.5 L8 13.6 L10.5 10.5" />
            <path d="M8 9 V13.4" />
        </>
    ),
    // Redispatching — a generator dial with up/down arrows: production
    // can be raised OR lowered (signed delta), unlike curtailment which
    // only reduces.
    redispatch: (
        <>
            <circle cx="8" cy="8" r="3" />
            <path d="M13 4.5 V8.5" />
            <path d="M11.4 6.9 L13 8.5 L14.6 6.9" />
            <path d="M3 11.5 V7.5" />
            <path d="M1.4 9.1 L3 7.5 L4.6 9.1" />
        </>
    ),
    // Tap dial — a gauge with a needle.
    pst: (
        <>
            <circle cx="8" cy="8" r="6" />
            <path d="M8 8 L11.6 5.2" />
            <circle cx="8" cy="8" r="1.1" fill="currentColor" stroke="none" />
        </>
    ),
};

/**
 * Uncoloured action-type pictogram. Used by the ActionFilterRings
 * action-type ring; pairs with `ACTION_TYPE_LABELS` for the tooltip.
 */
export const ActionTypeIcon: React.FC<{ kind: ActionTypeKind; size?: number }> = ({ kind, size = 13 }) => (
    <svg
        width={size}
        height={size}
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
    >
        {GLYPHS[kind]}
    </svg>
);

export default ActionTypeIcon;
