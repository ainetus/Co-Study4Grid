// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0

import type { ViewBox } from '../../types';
import { declutterEdgeInfoLabels, parseRotateDeg, type EdgeInfoLabel } from './edgeInfoDeclutter';

/**
 * Scale SVG elements for large grids so text, nodes, and flow values
 * are readable when zoomed in and naturally shrink at full view.
 */
export const boostSvgForLargeGrid = (svgString: string, viewBox: ViewBox | null, vlCount: number): string => {
    if (!viewBox) return svgString;

    // Skip boost entirely for grids with < 500 voltage levels
    if (!vlCount || vlCount < 500) return svgString;

    const start = Date.now();
    const diagramSize = Math.max(viewBox.w, viewBox.h);
    const REFERENCE_SIZE = 1250;
    const BOOST_THRESHOLD = 3;
    const ratio = diagramSize / REFERENCE_SIZE;
    if (ratio <= BOOST_THRESHOLD) return svgString;

    const boost = Math.sqrt(ratio / BOOST_THRESHOLD);
    const boostStr = boost.toFixed(2);
    // Node circles, edge-info groups, and the VL-label CSS all scale with
    // `boost` (clamped). Pypowsybl emits geometry in fixed user-units
    // (`r = 27.5` for the VL outer circle, 20 px font for flow values,
    // 10×10 arrow path) regardless of layout extent, so on a wide
    // viewBox like the Mercator-metres PyPSA layout (~1.4 M units across
    // France) those primitives become sub-pixel at almost every zoom
    // level. Scaling them up by `boost` brings the rendered VL circle
    // back up to ~530 user-units on fr225_400, which is the regime the
    // operator-style RTE study layouts already render in.
    //
    // History (kept for context, see CHANGELOG entry 2026-05-08):
    //   - cbe0695 dampened nodes by `sqrt(boost)` to fight the dense-
    //     overlap blob on the old 8 000-unit-wide PyPSA layout. Nodes were
    //     still scaled UP, just less than text.
    //   - The shrink direction was made aggressive (`0.75 / boost²`,
    //     floor 0.25) to combat the 225/400 kV collocation overlap on
    //     dense urban substations.
    //   - The Mercator-metres layout fix (regenerate_grid_layout.py)
    //     removed the structural overlap by giving the layout a span
    //     of ~1.4 M user-units. With that fix in place, the shrink no
    //     longer has anything to shrink — it just makes nodes invisible.
    //     Reverting to the natural same-factor-as-text behaviour, with
    //     a sane clamp, restores readability.
    //
    // The NODE_BOOST_GAIN multiplier on top of `boost` was added
    // 2026-05-08 after the operator ran the Mercator-metres fix and
    // reported that nodes at the natural `boost` factor (~19 on the
    // French grid) were still pin-prick-sized at city-zoom — pypowsybl's
    // r=27.5 in a 1.4 M viewBox is only 0.04 % of the diagram, which
    // puts node radius below 1 px even at 10× zoom. The first iteration
    // used GAIN=10 (≈ 0.4 % of viewBox per circle); operator feedback
    // was that this overwhelmed dense regions like Paris where
    // adjacent substations overlap. Reduced to 10/3 ≈ 3.33 — circles
    // land at ~0.13 % of viewBox, ~15 px diameter at 10× zoom, with
    // enough whitespace between Paris substations to keep the cluster
    // readable.
    //
    // The clamp prevents pathological cases:
    //   - Floor 0.5 on a small grid that just crossed the
    //     BOOST_THRESHOLD: gained boost stays around 3, no underflow.
    //   - Ceiling 250 caps the multiplier on grids whose viewBox is so
    //     huge (≥ 9 M units) that the gained boost would overwhelm the
    //     intrinsic node density.
    //
    // Adding an OFFSET (third iteration) gave a baseline shape that
    // converges to native rendering for very small viewBoxes; adding
    // density-suppression (fourth iteration, 2026-05-08) handles the
    // case where a layout has the same span as a PyPSA-EUR grid but a
    // MUCH higher VL count.
    //
    // Operator-reported case: `bare_env_20240828T0100Z` covers France
    // at the same scale as `pypsa_eur_fr225_400` (~1.64 M-wide viewBox)
    // but with 18 141 VLs instead of 1 196 — 15× the density. The pure
    // OFFSET formula gave both the same nodeBoost ≈ 60, which is
    // correct for fr225_400 but produces overlap on bare_env where
    // median NN is 1 776 (so r/NN = 102 %, every node merges with its
    // neighbour). The fix divides the gained boost by
    // `sqrt(max(1, density / REFERENCE))` so denser layouts shrink
    // proportionally while sparser ones (PyPSA-EUR) pass through
    // unchanged.
    //
    // Calibration:
    //
    //   layout          vlCount  viewBox    density/REF  nodeBoost (before → after)
    //   fr225_400       1 196    1.4 M      1.02 (≈1)    60.4 → 59.7 (drift -1 %)
    //   European        5 247    4.4 M      0.56 (clip1) 110.2 → 110.2 (unchanged)
    //   bare_env        18 141   1.64 M     13.3         65.8 → 18.1 ← fix
    //   tiny dense fix  1 000    20 K       4 167        3.7 → 1.0 (floor)
    //   tiny native     —        ≤ 8 K      —            1.0 (offset)
    //
    // Tuning knobs:
    //   - bare-env-style grids still too big?      raise NODE_BOOST_GAIN  (does
    //                                              hardly anything for very
    //                                              high density, lifts the
    //                                              PyPSA-scale grids)
    //   - PyPSA grids feel too small?              raise NODE_BOOST_GAIN
    //   - Want the density penalty to bite earlier? lower VL_DENSITY_REFERENCE
    //   - Hard "always native" floor?              raise NODE_BOOST_FLOOR
    const NODE_BOOST_FLOOR = 1.0;
    const NODE_BOOST_OFFSET = 1.5;
    const NODE_BOOST_GAIN = 10 / 3;
    const NODE_BOOST_CEILING = 250;
    // VLs per unit² above which the formula starts shrinking nodes
    // proportionally to `sqrt(density)`. Calibrated against fr225_400:
    // 1 196 VLs / (1.4 M × 1.39 M) ≈ 6 × 10⁻¹⁰. Less-dense layouts
    // (European, fr400) sit BELOW the reference and pass through; more
    // dense ones (bare_env operator reference at ~13× denser) get
    // scaled down by sqrt(13) ≈ 3.6×.
    const VL_DENSITY_REFERENCE = 6e-10;

    const viewBoxArea = viewBox.w * viewBox.h;
    const density = vlCount / Math.max(1, viewBoxArea);
    const densitySuppress = Math.sqrt(Math.max(1, density / VL_DENSITY_REFERENCE));
    const rawBoost = (boost - NODE_BOOST_OFFSET) * NODE_BOOST_GAIN + 1;
    const nodeBoost = Math.max(
        NODE_BOOST_FLOOR,
        Math.min(NODE_BOOST_CEILING, rawBoost / densitySuppress),
    );
    const nodeBoostStr = nodeBoost.toFixed(2);

    try {
        const parser = new DOMParser();
        const doc = parser.parseFromString(svgString, 'image/svg+xml');
        const svgEl = doc.documentElement;

        // === 1. Scale CSS values in <style> blocks ===
        // VL labels (`nad-text-nodes`, `font: 25px serif`), legend chip and
        // label-box paddings all shrink in step with the node circles so the
        // diagram reads as a coherent miniature on dense grids. Edge-info
        // text uses its own `font: 20px serif` rule that we leave alone —
        // its visible size is driven by the per-edge `<g transform>` we
        // rewrite in section 3 below.
        const styles = svgEl.querySelectorAll('style');
        styles.forEach(style => {
            let css = style.textContent || '';
            css = css.replace(/font:\s*25px\s+serif/, `font: ${Math.round(25 * nodeBoost)}px serif`);
            css = css.replace(
                'padding: 10px; border-radius: 10px;',
                `padding: ${Math.max(2, Math.round(10 * nodeBoost))}px; border-radius: ${Math.max(2, Math.round(10 * nodeBoost))}px;`
            );
            css = css.replace(
                'margin-right: 10px; width: 20px; height: 20px;',
                `margin-right: ${Math.max(2, Math.round(10 * nodeBoost))}px; width: ${Math.max(4, Math.round(20 * nodeBoost))}px; height: ${Math.max(4, Math.round(20 * nodeBoost))}px;`
            );
            style.textContent = css;
        });

        // === 2. Scale node groups (circles + inner bus sectors/paths) ===
        // Also collect each VL group's centre + outer radius so section 4
        // can extend branch-polyline endpoints inward to the new circle
        // edge. Pypowsybl emits each VL as `<g transform="translate(cx,cy)">
        // <circle r="27.5" .../></g>`, so the centre is the parent group's
        // translation and the outer radius is the largest `r` among its
        // child circles.
        const vlOuter: Array<{ cx: number; cy: number; r: number }> = [];
        const collectVlOuter = (groupEl: Element, circle: Element) => {
            const t = groupEl.getAttribute('transform') || '';
            const m = /translate\(\s*([-0-9.eE+]+)\s*[, ]\s*([-0-9.eE+]+)\s*\)/.exec(t);
            if (!m) return;
            const cx = parseFloat(m[1]);
            const cy = parseFloat(m[2]);
            if (!isFinite(cx) || !isFinite(cy)) return;
            const r = parseFloat(circle.getAttribute('r') || '0');
            if (!isFinite(r) || r <= 0) return;
            vlOuter.push({ cx, cy, r });
        };

        const circles = svgEl.querySelectorAll('circle');
        const scaledGroups = new Set<Element>();
        // Track which group → max-r mapping so we keep only the OUTER circle
        // per VL when the same group has several concentric busnodes.
        const groupOuterIdx = new Map<Element, number>();
        const isInsideVlNodes = (el: Element): boolean => {
            for (let p: Element | null = el; p; p = p.parentElement) {
                if (p.classList && p.classList.contains('nad-vl-nodes')) return true;
            }
            return false;
        };

        for (let i = 0; i < circles.length; i++) {
            const circle = circles[i];
            let targetEl: Element = circle.parentElement as Element;

            // If flattened, target might not be a 'g' or might be a large container
            if (!targetEl || targetEl.tagName !== 'g' || (targetEl.children.length > 5 && targetEl.querySelector('foreignObject'))) {
                targetEl = circle;
            }

            // Record VL centres while we're walking circles (only those that
            // live under .nad-vl-nodes — injection / 3-winding glyphs are
            // unrelated). For multi-bus VLs, keep the outermost radius.
            if (isInsideVlNodes(circle)) {
                const r = parseFloat(circle.getAttribute('r') || '0');
                if (isFinite(r) && r > 0) {
                    const prevIdx = groupOuterIdx.get(targetEl);
                    if (prevIdx === undefined) {
                        collectVlOuter(targetEl, circle);
                        groupOuterIdx.set(targetEl, vlOuter.length - 1);
                    } else if (vlOuter[prevIdx] && r > vlOuter[prevIdx].r) {
                        vlOuter[prevIdx].r = r;
                    }
                }
            }

            if (scaledGroups.has(targetEl)) continue;

            const t = targetEl.getAttribute('transform') || '';
            if (t.includes('NaN')) continue;

            scaledGroups.add(targetEl);
            const cx = circle.getAttribute('cx');
            const cy = circle.getAttribute('cy');

            if (cx === 'NaN' || cy === 'NaN') continue;

            const cxNum = parseFloat(cx || '0');
            const cyNum = parseFloat(cy || '0');

            if (!isNaN(cxNum) && !isNaN(cyNum)) {
                targetEl.setAttribute('transform', `${t} translate(${cxNum},${cyNum}) scale(${nodeBoostStr}) translate(${-cxNum},${-cyNum})`);
            }

            if (i % 100 === 0 && Date.now() - start > 5000) {
                console.warn('[SVG] Boosting taking too long, some elements might not be scaled.');
                break;
            }
        }

        // === 3. Scale edge-info group transforms (flow arrows + values) ===
        // Match the node-circle factor so flow text + direction arrows shrink
        // in lockstep with the substations they annotate. Without this, dense
        // urban regions (Paris/Lyon) stay an unreadable blob of arrowheads
        // even after the circles are downscaled — exactly what the operator
        // sees right after the node-shrink lands.
        // Section 5 below also projects each indicator's `translate(...)`
        // onto the nearest straightened branch polyline so they stop
        // floating in space after the kink-drop.
        const edgeInfoGroup = svgEl.querySelector('.nad-edge-infos');
        if (edgeInfoGroup) {
            const infoGs = edgeInfoGroup.querySelectorAll(':scope > g[transform]');
            for (let i = 0; i < infoGs.length; i++) {
                const g = infoGs[i];
                const t = g.getAttribute('transform');
                if (t && t.includes('translate(') && !t.includes('scale(') && !t.includes('NaN')) {
                    g.setAttribute('transform', t + ` scale(${nodeBoostStr})`);
                }
            }
        }

        // === 4. Reconnect branch polylines to the shrunken VL circles ===
        // Pypowsybl draws each branch as one or two `<polyline>` whose first
        // point sits exactly on the OUTER VL circle (at distance r from the
        // VL centre). After section 2 the rendered circle is `nodeBoost × r`,
        // so the polyline endpoint now floats `(1 − nodeBoost) × r` away
        // from the new edge, leaving a visible gap. Walk every polyline,
        // detect which endpoint(s) sit on a VL outer circle, and pull them
        // inward along the (centre − endpoint) direction so the line meets
        // the new edge again. Endpoints that aren't on any VL circle (mid-
        // line vertices, midpoint joins) are left untouched.
        const reconnectStart = Date.now();
        let reconnectedEndpoints = 0;
        let straightenedKinks = 0;
        // Branch segments collected during the polyline walk, used by
        // section 5 to project flow indicators back onto the line.
        const branchSegments: Array<{ start: [number, number]; end: [number, number] }> = [];
        // Sections 4 and 5 (line-endpoint reconnection, kink drop, flow-
        // indicator projection) are only meaningful when nodes are being
        // SHRUNK below pypowsybl's native r=27.5. With the Mercator-metres
        // layout the formula produces nodeBoost ≥ 1 (boost mode); the line
        // endpoints already sit on or inside the rendered circle, the
        // arrow placements are still valid, and there's no kink to remove
        // because the per-branch curve is invisible at this scale anyway.
        // Gate both sections on shrink mode so boost-mode runs stay cheap
        // and don't push flow indicators outside their host segments.
        const SHRINK_BAND_AID = nodeBoost < 1;
        if (SHRINK_BAND_AID && vlOuter.length > 0) {
            // Hash-grid spatial index so endpoint lookup is ~O(1) instead of
            // O(N_vl) per polyline. Cell size big enough that the search
            // never has to scan more than a 3×3 neighbourhood.
            const CELL = 60;
            const grid = new Map<string, Array<{ cx: number; cy: number; r: number }>>();
            for (const vl of vlOuter) {
                const gx = Math.floor(vl.cx / CELL);
                const gy = Math.floor(vl.cy / CELL);
                const key = `${gx},${gy}`;
                let bucket = grid.get(key);
                if (!bucket) { bucket = []; grid.set(key, bucket); }
                bucket.push(vl);
            }

            const ENDPOINT_TOL_REL = 0.1;   // accept |d − r| ≤ 10 % r
            const ENDPOINT_TOL_ABS = 1.0;   // and at least 1 user-unit slack
            const t = 1 - nodeBoost;        // pull-inward ratio

            const tryExtend = (px: number, py: number): [number, number] | null => {
                if (!isFinite(px) || !isFinite(py)) return null;
                const gx = Math.floor(px / CELL);
                const gy = Math.floor(py / CELL);
                let best: { vl: { cx: number; cy: number; r: number }; err: number } | null = null;
                for (let dx = -1; dx <= 1; dx++) {
                    for (let dy = -1; dy <= 1; dy++) {
                        const bucket = grid.get(`${gx + dx},${gy + dy}`);
                        if (!bucket) continue;
                        for (const vl of bucket) {
                            const ddx = px - vl.cx;
                            const ddy = py - vl.cy;
                            const d = Math.hypot(ddx, ddy);
                            const tol = Math.max(ENDPOINT_TOL_ABS, vl.r * ENDPOINT_TOL_REL);
                            const err = Math.abs(d - vl.r);
                            if (err < tol && (!best || err < best.err)) {
                                best = { vl, err };
                            }
                        }
                    }
                }
                if (!best) return null;
                return [
                    px + (best.vl.cx - px) * t,
                    py + (best.vl.cy - py) * t,
                ];
            };

            const polylines = svgEl.querySelectorAll('.nad-edge-path');
            for (let i = 0; i < polylines.length; i++) {
                const pl = polylines[i];
                if (pl.tagName.toLowerCase() !== 'polyline') continue;
                const raw = pl.getAttribute('points') || '';
                if (!raw) continue;
                // Pypowsybl uses "x1,y1 x2,y2 ..." but accept whitespace too.
                const tokens = raw.trim().split(/\s+/).filter(Boolean);
                if (tokens.length < 2) continue;
                let pts: Array<[number, number]> = [];
                let parseOk = true;
                for (const tok of tokens) {
                    const [sx, sy] = tok.split(',');
                    const x = parseFloat(sx);
                    const y = parseFloat(sy);
                    if (!isFinite(x) || !isFinite(y)) { parseOk = false; break; }
                    pts.push([x, y]);
                }
                if (!parseOk || pts.length < 2) continue;

                let dirty = false;

                // Straighten branch half-edges: pypowsybl renders each branch
                // as two polylines that meet at a per-branch shared midpoint,
                // and inserts an extra intermediate vertex on each half-edge
                // to make parallel branches fan out gracefully. For close-by
                // VL pairs that intermediate vertex produces a visible
                // triangle "kink" (operator screenshot, May 2026). Drop the
                // intermediate vertices on every `.nad-branch-edges` polyline
                // so each half-edge becomes a clean straight line from VL
                // outer ring to the shared midpoint. The midpoint is kept
                // intact, so parallel branches between the same VL pair
                // still fan out via their distinct midpoints — only the
                // bowed shape on each half-edge goes away. 3-winding
                // transformer edges (under `.nad-3wt-edges`) are left alone:
                // their three-spoke geometry depends on the intermediate
                // vertices.
                const isBranchEdge = pl.closest('.nad-branch-edges') !== null;
                if (isBranchEdge && pts.length > 2) {
                    pts = [pts[0], pts[pts.length - 1]];
                    dirty = true;
                    straightenedKinks++;
                }

                const firstNew = tryExtend(pts[0][0], pts[0][1]);
                if (firstNew) { pts[0] = firstNew; dirty = true; reconnectedEndpoints++; }
                const lastIdx = pts.length - 1;
                const lastNew = tryExtend(pts[lastIdx][0], pts[lastIdx][1]);
                if (lastNew) { pts[lastIdx] = lastNew; dirty = true; reconnectedEndpoints++; }

                if (dirty) {
                    pl.setAttribute(
                        'points',
                        pts.map(p => `${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(' '),
                    );
                }

                // Remember the final 2-point segment of every branch
                // half-edge (after straighten + extend) so section 5 can
                // project the corresponding flow indicator onto it.
                // 3WT polylines are kept multi-vertex above and would
                // produce inaccurate segments here, so we only record
                // straight 2-point branch polylines.
                if (isBranchEdge && pts.length === 2) {
                    branchSegments.push({ start: pts[0], end: pts[1] });
                }

                if (i % 200 === 0 && Date.now() - reconnectStart > 3000) {
                    console.warn('[SVG] Reconnect taking too long; some endpoints may not be extended.');
                    break;
                }
            }
        }

        // === 5. Project flow indicators onto the straightened polylines ===
        // Section 4 collapsed each branch half-edge to a 2-point line. The
        // matching `<g class="nad-edge-infos"> > g[transform="translate(x,y)">"`
        // entries (one per branch end) keep the position pypowsybl computed
        // against the OLD bowed geometry, so they now float in space — this
        // is the "labels look like floating in the void" symptom from the
        // operator's screenshot. Project each indicator's translate onto the
        // nearest collected segment, capped at a sane distance so we never
        // snap to an unrelated branch.
        let projectedIndicators = 0;
        if (branchSegments.length > 0 && edgeInfoGroup) {
            const SEG_CELL = 200;
            const segGrid = new Map<string, Array<{ start: [number, number]; end: [number, number] }>>();
            for (const seg of branchSegments) {
                // Bucket by segment midpoint so a 3×3 lookup catches every
                // segment whose midpoint is within ~1.5 × SEG_CELL of the
                // indicator. A typical pypowsybl flow indicator sits within
                // ~30 % of the half-edge length from one endpoint, so this
                // is generous.
                const mx = (seg.start[0] + seg.end[0]) / 2;
                const my = (seg.start[1] + seg.end[1]) / 2;
                const key = `${Math.floor(mx / SEG_CELL)},${Math.floor(my / SEG_CELL)}`;
                let bucket = segGrid.get(key);
                if (!bucket) { bucket = []; segGrid.set(key, bucket); }
                bucket.push(seg);
            }

            // Cap distance: if the indicator is more than this far from
            // every segment, leave it where it is (better to keep
            // pypowsybl's original placement than snap to an unrelated
            // branch). Calibrated against the fr400 fixture where the
            // worst legitimate kink offset was ~50 u — we leave a 4× margin.
            const MAX_PROJECT_DIST = 200;

            const projectOntoSegment = (
                px: number, py: number,
                ax: number, ay: number, bx: number, by: number,
            ): { proj: [number, number]; dist: number } => {
                const dx = bx - ax;
                const dy = by - ay;
                const len2 = dx * dx + dy * dy;
                if (len2 === 0) return { proj: [ax, ay], dist: Math.hypot(px - ax, py - ay) };
                let tt = ((px - ax) * dx + (py - ay) * dy) / len2;
                if (tt < 0) tt = 0;
                else if (tt > 1) tt = 1;
                const projX = ax + tt * dx;
                const projY = ay + tt * dy;
                return { proj: [projX, projY], dist: Math.hypot(px - projX, py - projY) };
            };

            const infoGs = edgeInfoGroup.querySelectorAll(':scope > g[transform]');
            for (let i = 0; i < infoGs.length; i++) {
                const g = infoGs[i];
                const t = g.getAttribute('transform') || '';
                // Section 3 appended ` scale(...)` to each transform, so we
                // need to re-extract the leading `translate(...)` and rewrite
                // the whole thing.
                const m = /translate\(\s*([-0-9.eE+]+)\s*[, ]\s*([-0-9.eE+]+)\s*\)/.exec(t);
                if (!m) continue;
                const x = parseFloat(m[1]);
                const y = parseFloat(m[2]);
                if (!isFinite(x) || !isFinite(y)) continue;

                const gx = Math.floor(x / SEG_CELL);
                const gy = Math.floor(y / SEG_CELL);
                let best: { proj: [number, number]; dist: number } | null = null;
                for (let dx = -1; dx <= 1; dx++) {
                    for (let dy = -1; dy <= 1; dy++) {
                        const bucket = segGrid.get(`${gx + dx},${gy + dy}`);
                        if (!bucket) continue;
                        for (const seg of bucket) {
                            const r = projectOntoSegment(x, y, seg.start[0], seg.start[1], seg.end[0], seg.end[1]);
                            if (!best || r.dist < best.dist) best = r;
                        }
                    }
                }
                if (!best || best.dist > MAX_PROJECT_DIST) continue;

                const trailing = t.replace(/translate\(\s*[-0-9.eE+]+\s*[, ]\s*[-0-9.eE+]+\s*\)/, '').trim();
                const newTranslate = `translate(${best.proj[0].toFixed(2)},${best.proj[1].toFixed(2)})`;
                g.setAttribute('transform', trailing ? `${newTranslate} ${trailing}` : newTranslate);
                projectedIndicators++;

                if (i % 500 === 0 && Date.now() - reconnectStart > 5000) {
                    console.warn('[SVG] Indicator projection taking too long; some flow labels may stay off-line.');
                    break;
                }
            }
        }

        // === 6. De-clutter overlapping flow values (slide along the edge) ===
        // pypowsybl places both branch flow values ~22 % from each terminal with
        // NO label de-collision, so the values fanning out of a busy substation
        // overprint into an unreadable blob. Slide each overlapping value further
        // along its OWN edge — toward mid-segment, away from the crowd — until they
        // separate. Every flow stays visible. Overlap is zoom-invariant in user
        // space (vector <text> scale with the viewBox), so this one pass is correct
        // at every zoom and never runs during a gesture. The slide is oriented +
        // capped from the nearest VL node (vlOuter, already collected in section 2)
        // so a value can't overshoot a short dense-core edge onto a neighbour.
        // Hot path uses flat arrays + numeric-keyed hashes. See
        // utils/svg/edgeInfoDeclutter.ts.
        let declutteredLabels = 0;
        if (edgeInfoGroup) {
            const declutterStart = Date.now();
            // Spatial hash over VL node centres → nearest substation per label.
            const NODE_CELL = Math.max(1e-6, Math.sqrt((viewBox.w * viewBox.h) / Math.max(1, vlCount)));
            const NK_OFF = 1 << 20, NK_STRIDE = 1 << 21;
            const nodeGrid = new Map<number, number[]>();
            for (let i = 0; i < vlOuter.length; i++) {
                const gx = Math.floor(vlOuter[i].cx / NODE_CELL);
                const gy = Math.floor(vlOuter[i].cy / NODE_CELL);
                const key = (gx + NK_OFF) * NK_STRIDE + (gy + NK_OFF);
                const b = nodeGrid.get(key);
                if (b) b.push(i); else nodeGrid.set(key, [i]);
            }
            let nnx = 0, nny = 0; // nearest-node centre (out-params)
            const nearestNodeDist2 = (px: number, py: number): number => {
                const gx = Math.floor(px / NODE_CELL), gy = Math.floor(py / NODE_CELL);
                let best = Infinity;
                for (let dx = -1; dx <= 1; dx++) {
                    for (let dy = -1; dy <= 1; dy++) {
                        const b = nodeGrid.get((gx + dx + NK_OFF) * NK_STRIDE + (gy + dy + NK_OFF));
                        if (!b) continue;
                        for (let k = 0; k < b.length; k++) {
                            const vl = vlOuter[b[k]];
                            const ex = px - vl.cx, ey = py - vl.cy;
                            const d2 = ex * ex + ey * ey;
                            if (d2 < best) { best = d2; nnx = vl.cx; nny = vl.cy; }
                        }
                    }
                }
                return best;
            };

            const RE_TRANSLATE = /translate\(\s*([-0-9.eE+]+)\s*[, ]\s*([-0-9.eE+]+)\s*\)/;
            const RE_SCALE = /scale\(\s*([-0-9.eE+]+)/;
            const infoGs2 = edgeInfoGroup.querySelectorAll(':scope > g[transform]');
            const labels: EdgeInfoLabel[] = [];
            const slots: Array<{ g: Element; x: number; y: number; tx: number; ty: number; trailing: string } | null> = [];
            for (let i = 0; i < infoGs2.length; i++) {
                const g = infoGs2[i];
                const t = g.getAttribute('transform') || '';
                const mt = RE_TRANSLATE.exec(t);
                if (!mt) { slots.push(null); continue; }
                const x = parseFloat(mt[1]);
                const y = parseFloat(mt[2]);
                if (!isFinite(x) || !isFinite(y)) { slots.push(null); continue; }
                // Direct child access (arrow <path> + value <text>) — avoids two
                // querySelector descents per group across ~16k groups.
                let arrowT: string | null = null;
                let txt = '';
                for (let c = g.firstElementChild; c; c = c.nextElementSibling) {
                    const tag = c.tagName;
                    if (arrowT === null && (tag === 'path' || tag === 'PATH')) arrowT = c.getAttribute('transform');
                    else if (tag === 'text' || tag === 'TEXT') txt = c.textContent || '';
                }
                const ang = parseRotateDeg(arrowT);
                if (ang == null) { slots.push(null); continue; }
                const a = (ang * Math.PI) / 180;
                let tx = Math.cos(a);
                let ty = Math.sin(a);
                const ms = RE_SCALE.exec(t);
                const sRaw = ms ? parseFloat(ms[1]) : 1;
                const scale = isFinite(sRaw) && sRaw > 0 ? sRaw : 1;
                const nChars = Math.max(1, (txt.trim().length) || 3);
                const halfLen = (nChars * 11 * 0.5 + 14) * scale;
                const halfThick = 12 * scale;
                // Orient the tangent toward mid (away from the nearest node) and
                // cap the toward-mid slide relative to the distance to that node.
                // The label sits ~22 % along its edge, so ~1.2× the node distance
                // just reaches mid; we allow 2× so a value can slide PAST mid into
                // the far half (more room to separate in dense cores) while still
                // staying on its own branch line. Symmetric size-cap fallback when
                // no node is near (rare).
                let maxSlideToMid: number | undefined;
                const d2 = nearestNodeDist2(x, y);
                if (isFinite(d2)) {
                    if ((x - nnx) * tx + (y - nny) * ty < 0) { tx = -tx; ty = -ty; }
                    maxSlideToMid = Math.sqrt(d2) * 1.6;
                }
                const trailing = t.replace(RE_TRANSLATE, '').trim();
                slots.push({ g, x, y, tx, ty, trailing });
                labels.push({ x, y, tx, ty, halfLen, halfThick, maxSlideToMid });
            }
            const parseMs = Date.now() - declutterStart;
            if (labels.length > 1) {
                const offsets = declutterEdgeInfoLabels(labels, { iterations: 8, maxSlideFactor: 5 });
                let li = 0;
                for (let i = 0; i < slots.length; i++) {
                    const slot = slots[i];
                    if (!slot) continue;
                    const off = offsets[li++];
                    if (Math.abs(off) > 0.5) {
                        const nx = slot.x + off * slot.tx;
                        const ny = slot.y + off * slot.ty;
                        const newTranslate = `translate(${nx.toFixed(2)},${ny.toFixed(2)})`;
                        slot.g.setAttribute('transform', slot.trailing ? `${newTranslate} ${slot.trailing}` : newTranslate);
                        declutteredLabels++;
                    }
                }
            }
            console.log(`[SVG] declutter pass: ${Date.now() - declutterStart}ms (parse ${parseMs}ms, ${labels.length} labels, ${declutteredLabels} moved)`);
        }

        const result = new XMLSerializer().serializeToString(svgEl);
        console.log(
            `[SVG] De-cluttered ${declutteredLabels} flow labels. ` +
            `Boosted vlCount=${vlCount}, ratio ${ratio.toFixed(2)}, boost ${boostStr}, ` +
            `nodeBoost ${nodeBoostStr}, straightened ${straightenedKinks} half-edges, ` +
            `reconnected ${reconnectedEndpoints} endpoints, projected ${projectedIndicators} flow ` +
            `indicators in ${Date.now() - start}ms`,
        );
        return result;
    } catch (err) {
        console.error('[SVG] Failed to boost SVG:', err);
        return svgString;
    }
};

/**
 * Parse viewBox from raw SVG string and apply boost for large grids.
 */
export const processSvg = (rawSvg: string, vlCount: number): { svg: string; viewBox: ViewBox | null } => {
    const match = rawSvg.match(/viewBox=["']([^"']+)["']/);
    let vb: ViewBox | null = null;
    if (match) {
        const parts = match[1].split(/\s+|,/).map(parseFloat);
        if (parts.length === 4) vb = { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
    }

    const svg = boostSvgForLargeGrid(rawSvg, vb, vlCount);
    return { svg, viewBox: vb };
};
