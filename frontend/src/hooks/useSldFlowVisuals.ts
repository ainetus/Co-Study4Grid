// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import { useLayoutEffect, useRef, type RefObject } from 'react';
import type { FlowMetric, ViewMode, VlOverlay } from '../types';
import { applySldFlowVisuals, clearSldFlowVisuals, hasSldFlowVisuals } from '../utils/svg/sldFlowVisuals';

/**
 * Paint the SLD's flow values in the view of the diagram tabs — MW or
 * Loading %, Flows or Impacts (`utils/svg/sldFlowVisuals`).
 *
 * A layout effect, so a pan's re-render never paints a frame of pypowsybl's
 * own values in between (the impact ↔ flow blink operators saw with a plain
 * effect). It runs every render and self-gates: nothing is redone while the
 * inputs are the same objects and the DOM still shows what was painted — a
 * reconciliation that wipes the painting is caught by that probe. The
 * target-topology preview owns the canvas: its stale flows are greyed, not
 * painted.
 */
export function useSldFlowVisuals(
    bodyRef: RefObject<HTMLDivElement | null>,
    overlay: VlOverlay,
    view: ViewMode,
    metric: FlowMetric,
    monitoringFactor: number,
    preview: boolean,
): void {
    const applied = useRef<{ inputs: readonly unknown[]; painted: boolean } | null>(null);
    useLayoutEffect(() => {
        const container = bodyRef.current;
        if (!container || preview) return;
        const inputs = [
            overlay.svg, overlay.sldMetadata, overlay.tab, view, metric, monitoringFactor,
            overlay.flow_deltas, overlay.reactive_flow_deltas, overlay.asset_deltas,
            overlay.branch_loading, overlay.loading_deltas,
        ];
        const last = applied.current;
        if (last && last.inputs.every((v, i) => Object.is(v, inputs[i]))
            && hasSldFlowVisuals(container) === last.painted) {
            return;
        }
        clearSldFlowVisuals(container);
        if (overlay.svg) applySldFlowVisuals(container, overlay, view, metric, monitoringFactor);
        applied.current = { inputs, painted: hasSldFlowVisuals(container) };
    });
}
