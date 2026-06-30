// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import { useLayoutEffect, useRef, type RefObject } from 'react';
import type { FeederLabel, SldTab } from '../types';
import { applyFeederRelabels } from '../utils/svg/feederLabels';

/**
 * Relabel SLD branch feeders with the far-end VL name (Issue 1). Owns the
 * render-every-time + signature self-gate so a pan reconciliation that drops
 * the relabel re-applies it, mirroring the other SldOverlay label passes.
 */
export function useSldFeederRelabel(
    bodyRef: RefObject<HTMLDivElement | null>,
    feederLabels: Record<string, FeederLabel> | undefined,
    activeSvg: string | null,
    tab: SldTab,
    actionId: string | null,
    preview: boolean,
): void {
    const sigRef = useRef<string>('');
    useLayoutEffect(() => {
        const container = bodyRef.current;
        if (!container) return;
        const entries = feederLabels
            ? Object.entries(feederLabels).filter(([, info]) => !!info && !!info.label)
            : [];
        const sig = JSON.stringify({
            svgLen: activeSvg?.length ?? 0,
            tab,
            action: actionId,
            preview,
            labels: entries.map(([eid, info]) => `${eid}=${info.label}`).sort(),
        });
        const applied = container.querySelector('[data-feeder-relabel]') !== null;
        const expect = entries.length > 0 && !!activeSvg;
        if (sig === sigRef.current && (expect ? applied : !applied)) return;
        sigRef.current = sig;
        applyFeederRelabels(container, feederLabels, activeSvg);
    });
}
