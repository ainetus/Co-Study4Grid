// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import { useLayoutEffect, useRef, type RefObject } from 'react';
import type { SldTab, VlInjection } from '../types';

/**
 * Render every editable injection's NAME as a dark-blue button: inject a
 * rounded ``<rect>`` behind the matching name ``<text>`` and recolour the label
 * on top (CSS). The whole thing is the click target that opens the active-power
 * editor (``data-injection-equip``, read by the click delegate).
 *
 * Runs every render and self-gates via signature + presence (same pattern as
 * the delta / highlight / feeder-relabel passes): the action / contingency
 * highlight effect CLONES cells (the clone is inserted before the original and
 * later removed), so (a) we must skip clones when matching the name text —
 * otherwise the button lands on the soon-to-be-removed clone and the action
 * target's name loses its button — and (b) we must re-apply if a reconciliation
 * / tab switch drops the buttons.
 */
export function useSldInjectionNameButtons(
    bodyRef: RefObject<HTMLDivElement | null>,
    injectionsBaseline: Record<string, VlInjection> | undefined,
    editMode: boolean,
    activeSvg: string | null,
    tab: SldTab,
    actionId: string | null,
    preview: boolean,
): void {
    const sigRef = useRef<string>('');
    useLayoutEffect(() => {
        const container = bodyRef.current;
        if (!container) return;
        const injections = editMode ? injectionsBaseline : undefined;
        const ids = injections ? Object.keys(injections) : [];
        const sig = JSON.stringify({
            edit: editMode,
            ids: [...ids].sort(),
            svgLen: activeSvg?.length ?? 0,
            tab,
            action: actionId,
            preview,
        });
        const btnsPresent = container.querySelector('.sld-injection-name-btn') !== null;
        const expectBtns = ids.length > 0 && !!activeSvg;
        if (sig === sigRef.current && (expectBtns ? btnsPresent : !btnsPresent)) {
            return;
        }
        sigRef.current = sig;

        container.querySelectorAll('.sld-injection-name-btn').forEach(el => el.remove());
        container.querySelectorAll('.sld-injection-name-label').forEach(el => {
            el.classList.remove('sld-injection-name-label');
            el.removeAttribute('data-injection-equip');
        });
        if (!injections || ids.length === 0) return;

        const SVGNS = 'http://www.w3.org/2000/svg';
        // Skip highlight clones — they carry a copy of the name text but are
        // removed on the next render, so a button placed on a clone vanishes.
        const texts = Array.from(container.querySelectorAll<SVGTextElement>('text'))
            .filter(t => !t.closest('.sld-highlight-clone'));
        for (const equipmentId of ids) {
            const variants = new Set([
                equipmentId,
                equipmentId.replace(/\./g, '_'),
                equipmentId.replace(/_/g, '.'),
            ]);
            const textEl = texts.find(t => variants.has((t.textContent ?? '').trim()));
            if (!textEl || !textEl.parentNode) continue;
            let bbox: DOMRect;
            try {
                bbox = textEl.getBBox();
            } catch {
                continue; // getBBox unavailable (jsdom) / not laid out
            }
            if (!(bbox.width > 0 && bbox.height > 0)) continue;
            const padX = 4, padY = 2.5;
            const rect = document.createElementNS(SVGNS, 'rect');
            rect.setAttribute('x', String(bbox.x - padX));
            rect.setAttribute('y', String(bbox.y - padY));
            rect.setAttribute('width', String(bbox.width + padX * 2));
            rect.setAttribute('height', String(bbox.height + padY * 2));
            rect.setAttribute('rx', '3');
            rect.setAttribute('class', 'sld-injection-name-btn');
            rect.setAttribute('data-injection-equip', equipmentId);
            textEl.parentNode.insertBefore(rect, textEl);
            textEl.classList.add('sld-injection-name-label');
            textEl.setAttribute('data-injection-equip', equipmentId);
        }
        // No deps on purpose — runs every render, self-gates via the
        // signature + presence probe above (catches clone churn + drops).
    });
}
