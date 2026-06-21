// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
//
// Generate a structurally-faithful pypowsybl-style NAD SVG from the REAL
// grid_layout.json of a data/ grid (default: pypsa_eur_eur220_225_380_400,
// 5247 voltage levels). The output reproduces the browser paint workload
// of the real Network Area Diagram — polyline strokes, bus circles,
// edge-info flow <text> + arrows, and the expensive HTML <foreignObject>
// VL labels — so pan/zoom fluidity can be measured WITHOUT standing up the
// pypowsybl backend. See README.md.
//
//   node generate_nad.mjs [grid_name] [out.svg]
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GRID = process.argv[2] || 'pypsa_eur_eur220_225_380_400';
const OUT = process.argv[3] || resolve(__dirname, 'nad.svg');
const LAYOUT = resolve(__dirname, '../../data', GRID, 'grid_layout.json');
const K_NEAREST = 3;

const layout = JSON.parse(readFileSync(LAYOUT, 'utf8'));
const nodes = Object.keys(layout).map((id) => {
    const [x, y] = layout[id];
    const m = /-(\d{3})$/.exec(id);
    return { id, x, y, kv: m ? parseInt(m[1], 10) : 225 };
});
const N = nodes.length;

let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
for (const n of nodes) {
    if (n.x < minX) minX = n.x; if (n.x > maxX) maxX = n.x;
    if (n.y < minY) minY = n.y; if (n.y > maxY) maxY = n.y;
}
const spanX = maxX - minX, spanY = maxY - minY;
const vbX = minX - spanX * 0.04, vbY = minY - spanY * 0.04, vbW = spanX * 1.08, vbH = spanY * 1.08;

const CELL = Math.max(spanX, spanY) / 220;
const grid = new Map();
const key = (gx, gy) => gx + ',' + gy;
for (let i = 0; i < N; i++) {
    const k = key(Math.floor(nodes[i].x / CELL), Math.floor(nodes[i].y / CELL));
    (grid.get(k) || grid.set(k, []).get(k)).push(i);
}
const edgeSet = new Set(), edges = [];
for (let i = 0; i < N; i++) {
    const a = nodes[i];
    const gx = Math.floor(a.x / CELL), gy = Math.floor(a.y / CELL);
    const cand = [];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const b = grid.get(key(gx + dx, gy + dy)); if (!b) continue;
        for (const j of b) if (j !== i) cand.push([(a.x - nodes[j].x) ** 2 + (a.y - nodes[j].y) ** 2, j]);
    }
    cand.sort((p, q) => p[0] - q[0]);
    for (let k = 0; k < Math.min(K_NEAREST, cand.length); k++) {
        const j = cand[k][1], e = i < j ? i + '_' + j : j + '_' + i;
        if (!edgeSet.has(e)) { edgeSet.add(e); edges.push([i, j]); }
    }
}

const VCOLOR = { 400: '#cc0000', 380: '#e07000', 225: '#138d13', 220: '#1f8f8f' };
const colorFor = (kv) => VCOLOR[kv] || '#888888';
const f = (v) => v.toFixed(1);
const out = [];
out.push(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xhtml="http://www.w3.org/1999/xhtml" `
    + `viewBox="${f(vbX)} ${f(vbY)} ${f(vbW)} ${f(vbH)}" preserveAspectRatio="xMidYMid meet" width="100%" height="100%">`);
out.push(`<style>.nad-edge-infos text{font:20px serif}.nad-label-box{font:25px serif}.nad-edge-path{stroke-width:5;fill:none}.nad-busnode{stroke:#333;stroke-width:3}</style>`);

out.push('<g class="nad-branch-edges">');
for (const [i, j] of edges) {
    const a = nodes[i], b = nodes[j];
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1, nx = -dy / len, ny = dx / len, off = Math.min(len * 0.06, CELL * 0.5);
    const col = colorFor(Math.max(a.kv, b.kv));
    out.push(`<g class="nad-edge">`
        + `<polyline class="nad-edge-path" stroke="${col}" points="${f(a.x)},${f(a.y)} ${f(a.x + dx * 0.33 + nx * off)},${f(a.y + dy * 0.33 + ny * off)} ${f(mx)},${f(my)}"/>`
        + `<polyline class="nad-edge-path" stroke="${col}" points="${f(b.x)},${f(b.y)} ${f(b.x - dx * 0.33 + nx * off)},${f(b.y - dy * 0.33 + ny * off)} ${f(mx)},${f(my)}"/></g>`);
}
out.push('</g>');

out.push('<g class="nad-edge-infos">');
for (const [i, j] of edges) {
    const a = nodes[i], b = nodes[j], flow = ((i * 37 + j * 13) % 900) + 50;
    for (const [p, q] of [[a, b], [b, a]]) {
        out.push(`<g transform="translate(${f(p.x + (q.x - p.x) * 0.22)},${f(p.y + (q.y - p.y) * 0.22)})">`
            + `<g class="nad-edge-info"><text>${flow} MW</text>`
            + `<g class="nad-arrow"><path d="M0,0 L60,0 L30,48 Z" fill="${colorFor(p.kv)}"/></g></g></g>`);
    }
}
out.push('</g>');

out.push('<g class="nad-vl-nodes">');
for (const n of nodes) out.push(`<g transform="translate(${f(n.x)},${f(n.y)})"><circle class="nad-busnode" r="27.5" fill="${colorFor(n.kv)}"/></g>`);
out.push('</g>');

out.push('<g class="nad-label-nodes">');
for (const n of nodes) {
    out.push(`<foreignObject class="nad-text-nodes" x="${f(n.x + 30)}" y="${f(n.y - 30)}" width="520" height="90">`
        + `<div xmlns="http://www.w3.org/1999/xhtml" class="nad-label-box" style="display:inline-block;padding:6px 10px;border:1px solid #999;border-radius:6px;background:#fff;color:#111;white-space:nowrap;font:25px serif">`
        + `${n.id.replace('VL_relation_', '').slice(0, 14)}<br/>${n.kv} kV</div></foreignObject>`);
}
out.push('</g>');
out.push('</svg>');

const svg = out.join('');
writeFileSync(OUT, svg);
const stats = {
    grid: GRID, voltageLevels: N, branches: edges.length, polylines: edges.length * 2,
    foreignObjects: N, approxDomNodes: N + edges.length * 2 + edges.length * 8 + N * 3,
    viewBox: `${f(vbX)} ${f(vbY)} ${f(vbW)} ${f(vbH)}`, bytesMB: +(svg.length / 1e6).toFixed(2),
};
writeFileSync(OUT.replace(/\.svg$/, '.stats.json'), JSON.stringify(stats, null, 2));
console.log(JSON.stringify(stats, null, 2));
