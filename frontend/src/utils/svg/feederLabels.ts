// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import type { FeederLabel } from '../../types';

/**
 * Build ``{friendlyName: [equipmentId, ...]}`` from the SLD feeder-label map so
 * an overloaded line reported by its grid2op / operator FRIENDLY name (e.g.
 * "MARSIL61PRAGN") can be resolved to the IIDM-id-keyed SLD cell (e.g.
 * "relation_8423569-225") and get its overload halo (Issue 2).
 */
export function buildFriendlyToEquip(
    feederLabels: Record<string, FeederLabel> | undefined,
): Map<string, string[]> {
    const map = new Map<string, string[]>();
    if (!feederLabels) return map;
    for (const [eid, info] of Object.entries(feederLabels)) {
        if (info?.name) {
            const arr = map.get(info.name) ?? [];
            arr.push(eid);
            map.set(info.name, arr);
        }
    }
    return map;
}

/**
 * Candidate equipment ids for an overloaded line: the friendly→id mapping (if
 * any) plus the raw value as a fallback — covers networks whose overload list
 * is already IIDM-id-keyed.
 */
export function overloadCandidates(
    lineId: string,
    friendlyToEquip: Map<string, string[]>,
): string[] {
    const mapped = friendlyToEquip.get(lineId);
    return mapped && mapped.length > 0 ? [lineId, ...mapped] : [lineId];
}

/**
 * Relabel branch feeders with the NAME of the voltage level at the OTHER end of
 * the branch (e.g. "MARSILLON 225kV") instead of pypowsybl's default raw IIDM
 * branch id (e.g. "relation_8423569-225"), which is hard to interpret on the
 * PyPSA grids (Issue 1). The backend (``build_feeder_labels``) resolves the
 * far-end VL name + parallel-circuit index; here we just swap the matching
 * ``<text>`` content.
 *
 * Idempotent: the original text is stashed in ``data-feeder-orig`` so a tab /
 * VL / preview switch restores cleanly, and highlight clones (which carry a
 * copy of the label but are removed on the next render) are skipped.
 */
export function applyFeederRelabels(
    container: HTMLElement,
    feederLabels: Record<string, FeederLabel> | undefined,
    activeSvg: string | null,
): void {
    // Restore any previous relabel first, then re-apply against the current SVG.
    container.querySelectorAll('[data-feeder-relabel]').forEach(el => {
        const orig = el.getAttribute('data-feeder-orig');
        if (orig !== null) el.textContent = orig;
        el.removeAttribute('data-feeder-relabel');
        el.removeAttribute('data-feeder-orig');
    });
    const entries = feederLabels
        ? Object.entries(feederLabels).filter(([, info]) => !!info && !!info.label)
        : [];
    if (entries.length === 0 || !activeSvg) return;

    const texts = Array.from(container.querySelectorAll<SVGTextElement>('text'))
        .filter(t => !t.closest('.sld-highlight-clone'));
    for (const [eid, info] of entries) {
        const label = info.label as string;
        const variants = new Set([eid, eid.replace(/\./g, '_'), eid.replace(/_/g, '.')]);
        const textEl = texts.find(t =>
            !t.hasAttribute('data-feeder-relabel')
            && variants.has((t.textContent ?? '').trim()),
        );
        if (!textEl) continue;
        textEl.setAttribute('data-feeder-orig', textEl.textContent ?? '');
        textEl.setAttribute('data-feeder-relabel', '1');
        textEl.textContent = label;
    }
}
