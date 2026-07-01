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
 * Break a single word wider than ``budget`` into pieces no wider than it,
 * preferring a natural separator (``_`` ``-`` ``.``) at or before the budget so
 * an id like ``virtual_relation_8423568`` splits between segments rather than
 * mid-token; falls back to a hard character cut when a chunk has no separator.
 * The separator stays attached to the preceding piece so the pieces re-join
 * exactly into the original word.
 */
function breakLongWord(word: string, budget: number): string[] {
    if (word.length <= budget) return [word];
    const pieces: string[] = [];
    let rest = word;
    while (rest.length > budget) {
        let cut = -1;
        for (let i = Math.min(budget, rest.length - 1); i >= 1; i--) {
            const ch = rest[i];
            if (ch === '_' || ch === '-' || ch === '.') { cut = i + 1; break; }
        }
        if (cut <= 0) cut = budget; // no separator in range → hard split
        pieces.push(rest.slice(0, cut));
        rest = rest.slice(cut);
    }
    if (rest) pieces.push(rest);
    return pieces;
}

/**
 * Break a feeder label into at most ``FEEDER_MAX_LINES`` lines no wider than
 * ``FEEDER_WRAP_CHARS``. Splits on whitespace first, and a single word still
 * wider than the budget (a long raw IIDM id — ``L_virtual_relation_8423568…``)
 * is further broken on its ``_`` / ``-`` / ``.`` separators so it stops running
 * horizontally off its feeder and overprinting the neighbour. Overflow past the
 * line cap is folded back into the last line.
 */
export function wrapFeederLabel(label: string): string[] {
    if (label.length <= FEEDER_WRAP_CHARS) return [label];
    const lines: string[] = [];
    let cur = '';
    for (const word of label.split(/\s+/).filter(Boolean)) {
        // A word that still fits on the current line joins it with a space.
        if (cur && (cur + ' ' + word).length <= FEEDER_WRAP_CHARS) {
            cur += ' ' + word;
            continue;
        }
        if (cur) { lines.push(cur); cur = ''; }
        const pieces = breakLongWord(word, FEEDER_WRAP_CHARS);
        for (let i = 0; i < pieces.length - 1; i++) lines.push(pieces[i]);
        cur = pieces[pieces.length - 1];
    }
    if (cur) lines.push(cur);
    if (lines.length === 0) return [label];
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

/** Feeder cells whose name label sits at the diagram extremity. */
const FEEDER_CELL_SELECTOR = '.sld-extern-cell, .sld-intern-cell, .sld-shunt-cell';
/** A flow value (``-14`` / ``16.8 MVAr``) rather than an equipment name. */
const NUMERIC_LABEL_RE = /^[+-]?[\d.,\s]+(?:\s*[A-Za-z%°]+)?$/;

/**
 * Wrap every long feeder NAME label at a substation's extremities so the names
 * stop overlapping — the generator / load / unmatched-branch names that
 * :func:`applyFeederRelabels` does NOT rewrite (only far-end-named branches get
 * relabelled). Targets the equipment-name ``<text>`` inside each feeder cell
 * (excluding the numeric P/Q flow labels and the already-relabelled feeders,
 * which wrap themselves) and rewrites it with the same centred multi-line
 * ``<tspan>`` block used for relabels.
 *
 * Idempotent: the original text is stashed in ``data-feeder-wrap-orig`` and
 * restored first, and highlight clones (removed on the next render) are skipped.
 * Run AFTER :func:`applyFeederRelabels` so relabelled feeders are left alone.
 */
export function applyFeederLabelWrap(
    container: HTMLElement,
    activeSvg: string | null,
): void {
    container.querySelectorAll('[data-feeder-wrap]').forEach(el => {
        const orig = el.getAttribute('data-feeder-wrap-orig');
        if (orig !== null) el.textContent = orig;  // replacing textContent drops any wrap <tspan>s
        el.removeAttribute('data-feeder-wrap');
        el.removeAttribute('data-feeder-wrap-orig');
    });
    if (!activeSvg) return;

    container.querySelectorAll<SVGElement>(FEEDER_CELL_SELECTOR).forEach(cell => {
        cell.querySelectorAll<SVGTextElement>('text').forEach(textEl => {
            if (textEl.closest('.sld-highlight-clone')) return;
            if (textEl.hasAttribute('data-feeder-relabel')) return;       // relabel wraps its own
            if (textEl.closest('.sld-active-power, .sld-reactive-power')) return; // flow value
            const raw = (textEl.textContent ?? '').trim();
            if (raw.length <= FEEDER_WRAP_CHARS || NUMERIC_LABEL_RE.test(raw)) return;
            if (wrapFeederLabel(raw).length <= 1) return;
            textEl.setAttribute('data-feeder-wrap-orig', textEl.textContent ?? '');
            textEl.setAttribute('data-feeder-wrap', '1');
            setFeederText(textEl, raw);
        });
    });
}
