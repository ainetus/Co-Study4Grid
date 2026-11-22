// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import React from 'react';

export type GlyphKind =
    | 'gauge' | 'after' | 'openEnd' | 'user' | 'model' | 'pin'
    | 'copy' | 'check' | 'star' | 'cross' | 'warning' | 'info';

// Same family as ActionTypeIcon / SeverityIcon: a 16-unit grid, 1.6
// strokes, `currentColor` — the caller owns the tint, the glyph the shape.
const GLYPHS: Record<GlyphKind, React.ReactNode> = {
    // Dial with its needle well past half: the highest line loading.
    gauge: (
        <>
            <path d="M2.2 11.5 A5.8 5.8 0 0 1 13.8 11.5" />
            <path d="M8 11.5 L11.3 6.6" />
            <circle cx="8" cy="11.5" r="1.1" fill="currentColor" stroke="none" />
        </>
    ),
    // A line between its two ends with a loading peak — the overloaded
    // lines (kept apart from the load-shedding arrow-onto-a-bar glyph).
    after: (
        <>
            <circle cx="1.9" cy="11.5" r="1.1" fill="currentColor" stroke="none" />
            <path d="M1.9 11.5 H5.2 L8 4.2 L10.8 11.5 H14.1" />
            <circle cx="14.1" cy="11.5" r="1.1" fill="currentColor" stroke="none" />
        </>
    ),
    // A line still live at one end, open at the other.
    openEnd: (
        <>
            <circle cx="2.2" cy="8" r="1.1" fill="currentColor" stroke="none" />
            <path d="M2.2 8 H8.5" />
            <path d="M8.5 8 L12 4.6" />
            <path d="M13.8 8 H14.4" />
        </>
    ),
    user: (
        <>
            <circle cx="8" cy="5.3" r="2.6" />
            <path d="M3 14 C3.4 10.6 12.6 10.6 13 14" />
        </>
    ),
    // A chip: the recommender model that suggested the action.
    model: (
        <>
            <rect x="4" y="4" width="8" height="8" rx="1.6" />
            <path d="M6.5 2 V4 M9.5 2 V4 M6.5 12 V14 M9.5 12 V14 M2 6.5 H4 M2 9.5 H4 M12 6.5 H14 M12 9.5 H14" />
        </>
    ),
    pin: (
        <>
            <path d="M8 14.6 C6 12.4 3.6 9.6 3.6 6.6 A4.4 4.4 0 0 1 12.4 6.6 C12.4 9.6 10 12.4 8 14.6 Z" />
            <circle cx="8" cy="6.6" r="1.5" />
        </>
    ),
    copy: (
        <>
            <rect x="5.5" y="5.5" width="8" height="8.5" rx="1.4" />
            <path d="M10.5 5.5 V3.4 A1.4 1.4 0 0 0 9.1 2 H3.4 A1.4 1.4 0 0 0 2 3.4 V9.1 A1.4 1.4 0 0 0 3.4 10.5 H5.5" />
        </>
    ),
    check: <path d="M3 8.4 L6.6 11.8 L13 4.6" />,
    star: <path d="M8 1.9 L9.8 5.8 L14 6.2 L10.8 9 L11.8 13.2 L8 11 L4.2 13.2 L5.2 9 L2 6.2 L6.2 5.8 Z" />,
    cross: <path d="M4 4 L12 12 M12 4 L4 12" />,
    warning: (
        <>
            <path d="M8 2 L14.5 13.5 H1.5 Z" />
            <path d="M8 6.4 V9.6" />
            <circle cx="8" cy="11.7" r="0.8" fill="currentColor" stroke="none" />
        </>
    ),
    info: (
        <>
            <circle cx="8" cy="8" r="6.2" />
            <path d="M8 7.3 V11.4" />
            <circle cx="8" cy="4.9" r="0.8" fill="currentColor" stroke="none" />
        </>
    ),
};

/**
 * Monochrome UI pictogram (loading, source, location, copy, rail
 * actions…). Decorative by default — the element carrying it owns the
 * tooltip / accessible name.
 */
export const Glyph: React.FC<{ kind: GlyphKind; size?: number; filled?: boolean }> = ({ kind, size = 13, filled = false }) => (
    <svg
        width={size}
        height={size}
        viewBox="0 0 16 16"
        fill={filled ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
        style={{ flexShrink: 0 }}
    >
        {GLYPHS[kind]}
    </svg>
);

export default Glyph;
