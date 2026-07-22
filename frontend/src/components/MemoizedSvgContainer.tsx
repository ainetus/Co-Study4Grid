// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import React, { type RefObject } from 'react';
import type { TabId } from '../types';

// Prevents React from diffing massive SVG DOM trees on every parent render.
// Uses replaceChildren(svgElement) instead of innerHTML to avoid the re-parse:
//   processSvg (D6) / applyPatchToClone hand us an already-parsed SVGSVGElement,
//   which we adopt directly — no serialize + innerHTML re-parse round-trip.
// A plain string (e.g. SLD overlays not routed through processSvg, or a
// processSvg parse-failure fallback) still takes the innerHTML path.
interface SvgContainerProps {
    svg: SVGSVGElement | string;
    containerRef: RefObject<HTMLDivElement | null>;
    display: string;
    tabId: TabId;
    /** When false, the NAD voltage-level label foreignObject is hidden via CSS. */
    hideVlLabels?: boolean;
}

const MemoizedSvgContainer = React.memo(({ svg, containerRef, display, tabId, hideVlLabels = false }: SvgContainerProps) => {
    React.useLayoutEffect(() => {
        const container = containerRef.current;
        if (!container || !svg) return;

        const start = performance.now();
        if (typeof svg === 'string') {
            // Fallback for plain string SVGs (SLD overlays not going through
            // processSvg, or a processSvg parse-failure fallback).
            container.innerHTML = svg;
        } else {
            // Element-adoption path: adopt the already-parsed element directly
            // (auto-adopted across documents by replaceChildren) — no re-parse.
            container.replaceChildren(svg);
        }
        console.log(`[SVG] DOM injection for ${tabId} took ${(performance.now() - start).toFixed(2)}ms`);
    }, [svg, containerRef, tabId]);

    return (
        <div
            ref={containerRef}
            className={hideVlLabels ? 'svg-container nad-hide-vl-labels' : 'svg-container'}
            id={`${tabId}-svg-container`}
            style={{ display, width: '100%', height: '100%', overflow: 'hidden' }}
        />
    );
});

export default MemoizedSvgContainer;
