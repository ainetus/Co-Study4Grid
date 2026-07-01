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

const SVG_NS = 'http://www.w3.org/2000/svg';
/** Wrap a relabelled feeder onto multiple lines past this width so a long
 *  far-end VL name (e.g. "LANNEMEZAN 225kV 1") stops overprinting the adjacent
 *  feeder's label at the top / bottom of the SLD. */
const FEEDER_WRAP_CHARS = 15;
const FEEDER_MAX_LINES = 3;

/**
 * Break a feeder label into at most ``FEEDER_MAX_LINES`` lines no wider than
 * ``FEEDER_WRAP_CHARS``, splitting on whitespace. A single word longer than the
 * budget is left intact on its own line (hard-splitting an id / name reads
 * worse than one slightly-long line). Overflow past the line cap is folded back
 * into the last line.
 */
export function wrapFeederLabel(label: string): string[] {
    if (label.length <= FEEDER_WRAP_CHARS || !label.includes(' ')) return [label];
    const words = label.split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let cur = '';
    for (const w of words) {
        if (!cur) cur = w;
        else if ((cur + ' ' + w).length <= FEEDER_WRAP_CHARS) cur += ' ' + w;
        else { lines.push(cur); cur = w; }
    }
    if (cur) lines.push(cur);
    if (lines.length > FEEDER_MAX_LINES) {
        const head = lines.slice(0, FEEDER_MAX_LINES - 1);
        head.push(lines.slice(FEEDER_MAX_LINES - 1).join(' '));
        return head;
    }
    return lines;
}

/**
 * Write ``label`` into ``textEl``, wrapping onto multiple ``<tspan>`` lines when
 * it is long. The block is vertically centred on the original baseline (first
 * line lifted by half the block height) so the wrapped label sits where the
 * single-line id used to, spreading up AND down rather than only downward into
 * the diagram.
 */
function setFeederText(textEl: SVGTextElement, label: string): void {
    const lines = wrapFeederLabel(label);
    if (lines.length <= 1) {
        textEl.textContent = label;
        return;
    }
    const x = textEl.getAttribute('x') ?? '0';
    textEl.textContent = '';
    lines.forEach((line, i) => {
        const tspan = document.createElementNS(SVG_NS, 'tspan');
        tspan.setAttribute('x', x);
        tspan.setAttribute('dy', i === 0 ? `${(-0.6 * (lines.length - 1)).toFixed(2)}em` : '1.2em');
        tspan.textContent = line;
        textEl.appendChild(tspan);
    });
}

/**
 * Relabel branch feeders with the NAME of the voltage level at the OTHER end of
 * the branch (e.g. "MARSILLON 225kV") instead of pypowsybl's default raw IIDM
 * branch id (e.g. "relation_8423569-225"), which is hard to interpret on the
 * PyPSA grids (Issue 1). The backend (``build_feeder_labels``) resolves the
 * far-end VL name + parallel-circuit index; here we swap the matching
 * ``<text>`` content, wrapping long labels so they don't occlude their
 * neighbours, and tag each with ``data-feeder-nav`` (the far-end VL id) so a
 * click can navigate to that VL's SLD.
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
        if (orig !== null) el.textContent = orig;  // replacing textContent drops any wrap <tspan>s
        el.removeAttribute('data-feeder-relabel');
        el.removeAttribute('data-feeder-orig');
        el.removeAttribute('data-feeder-nav');
        el.classList.remove('sld-feeder-navigable');
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
        setFeederText(textEl, label);
        if (info.other_vl) {
            textEl.setAttribute('data-feeder-nav', info.other_vl);
            textEl.classList.add('sld-feeder-navigable');
        }
    }
}
