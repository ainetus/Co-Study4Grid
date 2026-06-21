// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
//
// Measure pan/zoom paint cost of the large-grid NAD with and without the
// interaction-time culling rule (`.svg-interacting` in App.css), driving a
// real (headless) Chromium. Primary metric: time-to-painted-frame via
// double-rAF, with `--run-all-compositor-stages-before-draw` so each
// frame's full raster+composite cost is captured synchronously.
//
// "plain"  = no class            (labels + flow infos painted every frame)
// "cull"   = `.svg-interacting`  (App.css culls the expensive paint
//                                 elements for the gesture window)
//
// The two modes are interleaved across reps to cancel ordering / raster-
// cache effects. See README.md for setup + the software-GL caveat.
//
//   node bench_pan_zoom.mjs            # uses ./nad.svg + ../../frontend/src/App.css
import { readFileSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(resolve(__dirname, '../../frontend/'));
const { chromium } = require('playwright');

// A pre-installed Chromium (Playwright build or system Chrome). Override
// with PW_CHROME=/path/to/chrome when the default is absent.
const CHROME = process.env.PW_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const ARGS = ['--no-sandbox', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization', '--disable-frame-rate-limit',
    '--run-all-compositor-stages-before-draw', '--disable-renderer-backgrounding'];

const W = 1400, H = 900, REPS = 6, APPLIES = 20;
const svg = readFileSync(resolve(__dirname, 'nad.svg'), 'utf8');
const css = readFileSync(resolve(__dirname, '../../frontend/src/App.css'), 'utf8');
const stats = JSON.parse(readFileSync(resolve(__dirname, 'nad.stats.json'), 'utf8'));

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;background:#fff}#stage{width:${W}px;height:${H}px;position:relative}
${css}
</style></head><body><div id="stage"><div class="svg-container" id="c">${svg}</div></div></body></html>`;

const summarize = (a) => {
    if (!a || !a.length) return null;
    a = a.slice().sort((x, y) => x - y);
    const n = a.length, mean = a.reduce((s, v) => s + v, 0) / n;
    const pct = (p) => a[Math.min(n - 1, Math.floor(p * n))];
    return { n, mean: +mean.toFixed(1), median: +pct(0.5).toFixed(1), p95: +pct(0.95).toFixed(1) };
};
const withTimeout = (p, ms, t) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error('timeout ' + t)), ms))]);

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ARGS });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.error('PAGEERR', e.message));
await page.setContent(html, { waitUntil: 'load' });
await page.waitForTimeout(600);

await page.evaluate(([APPLIES]) => {
    const c = document.getElementById('c'), svg = c.querySelector('svg');
    const W = c.clientWidth, H = c.clientHeight;
    const v = svg.getAttribute('viewBox').split(/\s+/).map(Number);
    const base = { x: v[0], y: v[1], w: v[2], h: v[3] };
    const vbAt = (cx, cy, w) => { const h = w * (base.h / base.w); return { x: cx - w / 2, y: cy - h / 2, w, h }; };
    const lerp = (a, b, t) => a + (b - a) * t, geom = (a, b, t) => a * Math.pow(b / a, t);
    const bCx = base.x + base.w / 2, bCy = base.y + base.h / 2;
    const pX = base.x + base.w * 0.62, pY = base.y + base.h * 0.45, DETAIL = base.w * 0.12;
    const zin = [], pan = [];
    for (let i = 0; i < APPLIES; i++) {
        const t = i / (APPLIES - 1);
        zin.push(vbAt(lerp(bCx, pX, t), lerp(bCy, pY, t), geom(base.w, DETAIL, t)));
        pan.push(vbAt(pX + base.w * 0.5 * t, pY, DETAIL));
    }
    window.__g = { zoomIn: zin, pan };
    const applyVb = (vb) => svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
    const reset = () => { c.classList.remove('svg-interacting'); applyVb(base); };
    const nextPaint = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    window.__one = async (interacting, key) => {
        reset();
        if (interacting) c.classList.add('svg-interacting');
        await nextPaint();
        const times = [];
        for (const vb of window.__g[key]) { const t0 = performance.now(); applyVb(vb); await nextPaint(); times.push(performance.now() - t0); }
        reset();
        return times;
    };
}, [APPLIES]);

console.log('grid ' + stats.voltageLevels + ' VL / ' + stats.branches + ' branches / ' + stats.bytesMB + ' MB SVG | viewport ' + W + 'x' + H);
console.log('time-to-painted-frame (double-rAF), interleaved plain vs cull, ' + REPS + ' reps, headless software-GL\n');
const result = { grid: stats, phases: {} };
for (const g of ['pan', 'zoomIn']) {
    const plain = [], cull = [];
    for (let r = 0; r < REPS; r++) {
        try { plain.push(...await withTimeout(page.evaluate(([i, k]) => window.__one(i, k), [false, g]), 90000, 'plain')); } catch (e) { console.error('plain fail', e.message); }
        await page.waitForTimeout(80);
        try { cull.push(...await withTimeout(page.evaluate(([i, k]) => window.__one(i, k), [true, g]), 90000, 'cull')); } catch (e) { console.error('cull fail', e.message); }
        await page.waitForTimeout(80);
    }
    const sp = summarize(plain), sc = summarize(cull);
    result.phases[g] = { plain: sp, cull: sc };
    console.log(g.padEnd(8) + ' plain  mean ' + sp.mean + 'ms  median ' + sp.median + 'ms  p95 ' + sp.p95 + 'ms');
    console.log(g.padEnd(8) + ' cull   mean ' + sc.mean + 'ms  median ' + sc.median + 'ms  p95 ' + sc.p95 + 'ms');
    console.log('         => culling speedup: mean ' + (sp.mean / sc.mean).toFixed(1) + 'x   median ' + (sp.median / sc.median).toFixed(1) + 'x\n');
}
writeFileSync(resolve(__dirname, 'result.json'), JSON.stringify(result, null, 2));
await browser.close();
console.log('done');
