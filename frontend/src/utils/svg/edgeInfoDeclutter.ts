// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0

/**
 * Edge-info flow-label de-cluttering by *sliding along the edge*.
 *
 * pypowsybl places each branch's two flow values (the `<text class="nad-active">`
 * + direction arrow) at ~22 % from each terminal, in fixed user-space units, with
 * NO label de-collision. On a geographic layout the values that fan out of a busy
 * substation all land near that shared node and pile up into an unreadable blob —
 * the operator sees flow values "missing" because they overprint each other.
 *
 * Rather than HIDE overlapping values (so all flows stay visible), this pass
 * nudges each overlapping label a bit further along its own edge — away from the
 * crowd — until they separate. Because the values are vector `<text>` that scale
 * with the viewBox, overlap is **invariant to zoom in user space**, so this runs
 * ONCE at diagram-processing time (in `boostSvgForLargeGrid`), never per frame —
 * it has zero effect on pan/zoom gesture cost.
 *
 * The motion is constrained to each label's edge tangent (so values never float
 * off their line) and **capped per label**: a label may slide at most
 * `maxSlideToMid` along the +tangent (toward its branch mid-point) and a little
 * the other way, so on short dense-core edges it can't overshoot past mid onto a
 * neighbouring branch. The displacement direction is emergent mutual repulsion:
 * for a substation cluster the crowd centre is the shared node, so "away from the
 * crowd" is "toward mid-segment" — exactly the desired behaviour. Labels with no
 * overlap are returned untouched (offset 0).
 *
 * Implementation note: the hot path uses flat `Float64Array`s and a numeric-keyed
 * spatial hash (no per-element string keys) so it stays in the single-digit-ms
 * range even at ~16 k labels × many relaxation passes.
 */

export interface EdgeInfoLabel {
    /** Anchor position in user space (the group's `translate`). */
    x: number;
    y: number;
    /**
     * Unit tangent along the edge, oriented TOWARD the branch mid-point
     * (so a positive slide moves the label away from its terminal node).
     */
    tx: number;
    ty: number;
    /** Half-extent of the rendered label ALONG the tangent (user space). */
    halfLen: number;
    /** Half-extent of the rendered label PERPENDICULAR to the tangent. */
    halfThick: number;
    /**
     * Max distance this label may slide toward mid (+tangent) before it would
     * reach its branch mid-point. Omit / non-finite ⇒ fall back to the
     * label-size cap (`maxSlideFactor`). The backward (−tangent) cap is always
     * the label-size cap, kept small so labels don't drift back into the node.
     */
    maxSlideToMid?: number;
}

export interface DeclutterOptions {
    /** Relaxation passes (default 8). More = better separation in dense cores. */
    iterations?: number;
    /** Per-pass step fraction of the residual overlap (default 0.5). */
    damping?: number;
    /** Extra clearance added between labels, user space (default 0). */
    padding?: number;
    /**
     * Fallback slide cap when a label has no geometric `maxSlideToMid`:
     * cap = maxSlideFactor × full label length (default 5). Also caps the
     * small backward (toward-node) slide.
     */
    maxSlideFactor?: number;
}

/**
 * Resolve overlapping flow labels by sliding each along its edge tangent.
 * Returns the signed along-tangent offset for each input label (same order);
 * the caller applies `pos += offset × tangent`. Pure + deterministic.
 */
export const declutterEdgeInfoLabels = (
    labels: EdgeInfoLabel[],
    opts: DeclutterOptions = {},
): number[] => {
    const n = labels.length;
    const offset = new Float64Array(n);
    if (n < 2) return Array.from(offset);

    const iterations = opts.iterations ?? 8;
    const damping = opts.damping ?? 0.5;
    const padding = opts.padding ?? 0;
    const maxSlideFactor = opts.maxSlideFactor ?? 5;

    // Flatten into typed arrays for the hot loop (no per-element property reads).
    const X = new Float64Array(n);
    const Y = new Float64Array(n);
    const TX = new Float64Array(n);
    const TY = new Float64Array(n);
    const HL = new Float64Array(n);
    const HT = new Float64Array(n);
    const capFwd = new Float64Array(n);
    const capBack = new Float64Array(n);
    let sumHL = 0;
    let maxHL = 0;
    for (let i = 0; i < n; i++) {
        const l = labels[i];
        X[i] = l.x; Y[i] = l.y; TX[i] = l.tx; TY[i] = l.ty;
        HL[i] = l.halfLen; HT[i] = l.halfThick;
        const sizeCap = maxSlideFactor * 2 * l.halfLen;
        const toMid = l.maxSlideToMid;
        const hasGeom = typeof toMid === 'number' && isFinite(toMid) && toMid > 0;
        // With geometry: slide freely toward mid (+tangent), capped at mid, and
        // only a LITTLE back toward the node — bounded relative to the node
        // distance (toMid ≈ 1.6× node distance) so a label can never drift back
        // past its own substation. Without geometry: symmetric size cap.
        capFwd[i] = hasGeom ? Math.min(toMid, sizeCap * 2) : sizeCap;
        capBack[i] = hasGeom ? toMid * 0.25 : sizeCap;
        sumHL += l.halfLen;
        if (l.halfLen > maxHL) maxHL = l.halfLen;
    }

    // Spatial hash cell + collision-free numeric key. Cell ≈ a couple of label
    // lengths so any overlapping pair lands within a 3×3 neighbourhood; the grid
    // is rebuilt on the (slid) positions each pass to keep buckets small in the
    // dense core.
    const cell = Math.max(1e-6, 2 * (sumHL / n) + 2 * maxHL);
    const KOFF = 1 << 20;    // shift cell indices non-negative
    const KSTRIDE = 1 << 21; // > 2·KOFF so (gx,gy) → unique key < 2^42

    const delta = new Float64Array(n);
    const cx = new Float64Array(n);
    const cy = new Float64Array(n);
    // Spatial hash as an intrusive linked list (head cell→first index, `next`
    // chains same-cell labels) so each pass rebuilds in place with ZERO bucket-
    // array allocation — the dominant cost when iterating many passes over ~16k
    // labels. The `head` Map is reused (cleared) every pass.
    const next = new Int32Array(n);
    const head = new Map<number, number>();

    for (let iter = 0; iter < iterations; iter++) {
        head.clear();
        for (let i = 0; i < n; i++) {
            const px = X[i] + offset[i] * TX[i];
            const py = Y[i] + offset[i] * TY[i];
            cx[i] = px; cy[i] = py;
            const gx = Math.floor(px / cell);
            const gy = Math.floor(py / cell);
            const key = (gx + KOFF) * KSTRIDE + (gy + KOFF);
            const h = head.get(key);
            next[i] = h === undefined ? -1 : h;
            head.set(key, i);
        }

        delta.fill(0);
        for (let i = 0; i < n; i++) {
            const ix = cx[i], iy = cy[i];
            const tix = TX[i], tiy = TY[i];
            const nix = -tiy, niy = tix;   // edge normal
            const hli = HL[i], hti = HT[i];
            const gx = Math.floor(ix / cell);
            const gy = Math.floor(iy / cell);
            let d = 0;
            for (let dx = -1; dx <= 1; dx++) {
                for (let dy = -1; dy <= 1; dy++) {
                    const h = head.get((gx + dx + KOFF) * KSTRIDE + (gy + dy + KOFF));
                    for (let j = h === undefined ? -1 : h; j >= 0; j = next[j]) {
                        if (j === i) continue;
                        const ddx = ix - cx[j];
                        const ddy = iy - cy[j];
                        const along = ddx * tix + ddy * tiy;
                        const ovAlong = (hli + HL[j] + padding) - Math.abs(along);
                        if (ovAlong <= 0) continue;
                        const perp = ddx * nix + ddy * niy;
                        const ovPerp = (hti + HT[j]) - Math.abs(perp);
                        if (ovPerp <= 0) continue;
                        // Push i away from j along its tangent; deterministic
                        // tiebreak for (near-)coincident anchors.
                        const dir = along > 1e-6 ? 1 : (along < -1e-6 ? -1 : (i < j ? 1 : -1));
                        d += dir * ovAlong * damping * 0.5;
                    }
                }
            }
            delta[i] = d;
        }

        for (let i = 0; i < n; i++) {
            let o = offset[i] + delta[i];
            if (o > capFwd[i]) o = capFwd[i];
            else if (o < -capBack[i]) o = -capBack[i];
            offset[i] = o;
        }
    }

    return Array.from(offset);
};

/** Parse a `rotate(<deg>)` angle (degrees) from a transform string, or null. */
export const parseRotateDeg = (transform: string | null): number | null => {
    if (!transform) return null;
    const m = /rotate\(\s*([-0-9.eE+]+)/.exec(transform);
    if (!m) return null;
    const deg = parseFloat(m[1]);
    return Number.isFinite(deg) ? deg : null;
};
