// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import { useEffect, type RefObject } from 'react';

/**
 * Navigate to a branch extremity's voltage level by clicking its (relabelled)
 * feeder name on the SLD. ``applyFeederRelabels`` tags each navigable feeder
 * label with ``data-feeder-nav`` = the far-end VL id; a delegated capture-phase
 * listener on the overlay body resolves that id and hands it to
 * ``onNavigateToVl`` (which re-opens the SLD for that VL, keeping the current
 * tab so the same overload stays in view from the other end).
 *
 * Capture phase + a stop-immediate so the edit-mode switch/injection click
 * handler on the same container never also fires for a label click. A press
 * that moved (a pan, tracked in ``panMovedRef``) is ignored, matching the
 * switch-click gesture discrimination.
 */
export function useSldFeederNav(
    bodyRef: RefObject<HTMLDivElement | null>,
    onNavigateToVl: ((vlId: string) => void) | undefined,
    panMovedRef: RefObject<boolean>,
): void {
    useEffect(() => {
        const container = bodyRef.current;
        if (!container || !onNavigateToVl) return;
        const onClick = (ev: MouseEvent) => {
            if (panMovedRef.current) return;
            const target = ev.target as Element | null;
            const hit = target?.closest('[data-feeder-nav]');
            if (!hit) return;
            const vlId = hit.getAttribute('data-feeder-nav');
            if (!vlId) return;
            ev.stopImmediatePropagation();
            ev.preventDefault();
            onNavigateToVl(vlId);
        };
        container.addEventListener('click', onClick, true);
        return () => container.removeEventListener('click', onClick, true);
    }, [bodyRef, onNavigateToVl, panMovedRef]);
}
