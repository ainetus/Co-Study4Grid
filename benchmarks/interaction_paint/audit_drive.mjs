// Real-app pan/zoom interaction benchmark driver (CDP, real input pipeline).
//
//   node drive.mjs --hw gpu|sw --mode off|gpu|bitmap --scenarios a,b,c --reps 3 --out res.json
//
// Loads the study through the UI (Load Study), opens the N tab, then replays
// scripted gestures with Input.dispatchMouseEvent (so wheel coalescing, the
// input router and the compositor behave as for a real operator) while the
// injected instrumentation (instrument.js) records frame cadence, visual
// updates and long-animation-frame breakdowns.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { launchChrome, waitTarget, connect, browserWs, sleep } from './audit_cdp.mjs';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const HW = arg('hw', 'gpu');
const MODE = arg('mode', 'off');
const APP_URL = arg('url', 'http://127.0.0.1:8000/');
const REPS = +arg('reps', '3');
const OUT = arg('out', `res_${HW}_${MODE}.json`);
const PORT = +arg('port', '9350');
const SCEN = arg('scenarios', 'all');
const TRACE = arg('trace', '');          // scenario name to trace (Chrome trace JSON)
const W = +arg('width', '1920'), H = +arg('height', '1080');
const INJECT = arg('inject', '');
const EXPF = arg('exp', '');             // experiment flags → localStorage 'cs4g-exp'
const HEADED = arg('headed', '0') === '1';
const KEEP = arg('keep', '0') === '1';
const ATTACH = arg('attach', '0') === '1';

const here = path.dirname(new URL(import.meta.url).pathname);
const instrument = fs.readFileSync(path.join(here, 'audit_instrument.js'), 'utf8');
const injectSrc = INJECT ? fs.readFileSync(INJECT, 'utf8') : '';
const expCss = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'audit_exp_css.js'), 'utf8');
const profile = path.join(os.tmpdir(), `cs4g_audit_prof_${PORT}`);
if (!ATTACH) fs.rmSync(profile, { recursive: true, force: true });

const gpuFlags = ['--use-angle=gl', '--enable-gpu', '--ignore-gpu-blocklist'];
const proc = ATTACH ? { kill() {} } : launchChrome({ port: PORT, profile, headless: !HEADED, gpu: HW === 'gpu', width: W, height: H,
  extra: HW === 'gpu' ? gpuFlags : [] });
const log = (...a) => console.error(`[${HW}/${MODE}${EXPF ? '+' + EXPF : ''}]`, ...a);

const page = await connect((await waitTarget(PORT)).webSocketDebuggerUrl);
const browser = await connect(await browserWs(PORT));
await page.send('Page.enable');
await page.send('Runtime.enable');
const consoleLines = [];
page.on('Runtime.consoleAPICalled', (p) => {
  const txt = p.args.map(a => a.value ?? a.description ?? '').join(' ');
  if (/\[SVG\]|\[perf\]|took|ms/.test(txt)) consoleLines.push(txt.slice(0, 200));
});
if (!ATTACH) await page.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `try{localStorage.setItem('cs4g-smooth-pan-zoom', ${JSON.stringify(MODE)});localStorage.setItem('cs4g-exp', ${JSON.stringify(EXPF)})}catch(e){}\n${instrument}\n${expCss}\n${injectSrc}`,
});
if (!ATTACH) await page.send('Page.navigate', { url: APP_URL });

const ev = page.evalJs;
async function waitFor(expr, timeoutMs = 120000, every = 50) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { const v = await ev(expr); if (v) return v; } catch { /* page navigating */ }
    await sleep(every);
  }
  throw new Error('timeout waiting for ' + expr.slice(0, 120));
}
const pageNow = () => ev('performance.timeOrigin + performance.now()');

// ---------- Study load ----------
let load = {}, tabSwitch = {};
if (!ATTACH) {
await waitFor(`!!Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Load Study') && !b.disabled)`);
await sleep(500);
await ev(`(() => {
  window.__loadT = { click: performance.now() };
  const mo = new MutationObserver(() => {
    if (!window.__loadT.nMount && document.querySelector('#n-svg-container > svg')) {
      window.__loadT.nMount = performance.now();
      requestAnimationFrame(() => requestAnimationFrame(() => { window.__loadT.nMountPainted = performance.now(); }));
    }
  });
  mo.observe(document.body, { childList: true, subtree: true });
  Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Load Study')).click();
})()`);
await waitFor(`!!(window.__loadT && window.__loadT.nMountPainted)`, 300000, 100);
Object.assign(load, await ev(`window.__loadT`));
load.resources = await ev(`performance.getEntriesByType('resource').filter(r => r.name.includes('/api/')).map(r => ({ n: r.name.replace(location.origin, '').split('?')[0], start: Math.round(r.startTime), dur: Math.round(r.duration), ttfb: Math.round(r.responseStart - r.startTime), xfer: r.transferSize, size: r.decodedBodySize }))`);
load.domNodes = await ev(`document.querySelectorAll('#n-svg-container *').length`);
load.svgBytes = await ev(`(() => { const s = document.querySelector('#n-svg-container > svg'); return s ? s.outerHTML.length : 0 })()`);
log('loaded: click→nMount', Math.round(load.nMount - load.click), 'ms; DOM nodes', load.domNodes);

// Open the N tab, measure the first display (display:none → block on ~100k nodes).
await sleep(1500);
tabSwitch = await ev(`(async () => {
  const P = window.__cs4gPerf; P.begin('tab-n-first');
  const t0 = performance.now();
  document.querySelector('[data-testid="tab-button-n"]').click();
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const t1 = performance.now();
  await new Promise(r => setTimeout(r, 400));
  const rec = P.end();
  return { clickToPaint: t1 - t0, loaf: rec.loaf };
})()`);
log('N tab first display:', Math.round(tabSwitch.clickToPaint), 'ms');
await sleep(2500); // let idle work (bitmap prewarm, idle callbacks) settle
}

await page.send('Performance.enable').catch(() => {});
const perfMetrics = Object.fromEntries(((await page.send('Performance.getMetrics').catch(() => ({ metrics: [] }))).metrics || [])
  .filter(m => /JSHeapUsedSize|Nodes|LayoutObjects|Documents|JSEventListeners/.test(m.name)).map(m => [m.name, m.value]));
log('metrics', JSON.stringify(perfMetrics));
const rect = await ev(`(() => { const r = document.querySelector('#n-svg-container').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
const vb0 = await ev(`document.querySelector('#n-svg-container > svg').getAttribute('viewBox')`);
log('container', JSON.stringify(rect), 'vb0', vb0);
const at = (fx, fy) => ({ x: Math.round(rect.x + fx * rect.w), y: Math.round(rect.y + fy * rect.h) });

// ---------- Input primitives (fire on a fixed clock, never await per-event) ----------
async function fireSchedule(events) {
  // events: [{ dt, params }] with dt = ms offset from start. Sent without
  // awaiting each ack, like an OS input stream (Chrome coalesces as needed).
  const t0 = performance.now();
  const pending = [];
  for (const e of events) {
    const wait = t0 + e.dt - performance.now();
    if (wait > 1) await sleep(wait);
    pending.push(page.send('Input.dispatchMouseEvent', e.params).catch(() => {}));
  }
  await Promise.all(pending);
}
function wheelEvents({ at: p, notches, dir, interval }) {
  return Array.from({ length: notches }, (_, i) => ({ dt: i * interval,
    params: { type: 'mouseWheel', x: p.x, y: p.y, deltaX: 0, deltaY: dir * 100 } }));
}
function dragEvents(points, durationMs, hz = 60) {
  // points: [{x,y}, ...] polyline traversed at constant speed.
  const segs = [];
  let total = 0;
  for (let i = 1; i < points.length; i++) { const d = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y); segs.push(d); total += d; }
  const n = Math.max(2, Math.round(durationMs / (1000 / hz)));
  const evs = [{ dt: 0, params: { type: 'mousePressed', x: points[0].x, y: points[0].y, button: 'left', buttons: 1, clickCount: 1 } }];
  for (let k = 1; k <= n; k++) {
    let d = (k / n) * total, i = 0;
    while (i < segs.length - 1 && d > segs[i]) { d -= segs[i]; i++; }
    const f = segs[i] ? d / segs[i] : 1;
    const x = points[i].x + (points[i + 1].x - points[i].x) * f;
    const y = points[i].y + (points[i + 1].y - points[i].y) * f;
    evs.push({ dt: k * (1000 / hz), params: { type: 'mouseMoved', x: Math.round(x), y: Math.round(y), button: 'left', buttons: 1 } });
  }
  const last = evs[evs.length - 1].params;
  evs.push({ dt: (n + 1) * (1000 / hz), params: { type: 'mouseReleased', x: last.x, y: last.y, button: 'left', buttons: 0, clickCount: 1 } });
  return evs;
}

async function unzoom() {
  await ev(`(() => { const b = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Unzoom') && b.offsetParent); b && b.click(); })()`);
  await sleep(700);
}
async function preZoom(notches, fx = 0.5, fy = 0.5) {
  if (!notches) return;
  // One notch at a time with full settle, so the start state is deterministic.
  for (let i = 0; i < notches; i++) {
    await fireSchedule(wheelEvents({ at: at(fx, fy), notches: 1, dir: -1, interval: 0 }));
    await sleep(60);
  }
  await sleep(900);
}

// ---------- Scenarios ----------
// Cursor anchors are fractions of the NAD panel. The European NAD's dense
// core (France/Benelux/Germany) sits around (0.45, 0.55) at full extent.
const SCENARIOS = {
  // Fast mouse-wheel spin in: 16 notches 40 ms apart (0.9^16 → ~19 % width = region/detail edge).
  zoom_in_burst: { setup: { pre: 0 }, gesture: () => wheelEvents({ at: at(0.45, 0.55), notches: 16, dir: -1, interval: 40 }) },
  // ...and back out from deep zoom (pre-zoomed 20 notches ≈ 12 % width).
  zoom_out_burst: { setup: { pre: 20 }, gesture: () => wheelEvents({ at: at(0.45, 0.55), notches: 20, dir: 1, interval: 40 }) },
  // Trackpad/smooth-wheel style: 40 small events 16 ms apart.
  zoom_in_smooth: { setup: { pre: 0 }, gesture: () => wheelEvents({ at: at(0.45, 0.55), notches: 24, dir: -1, interval: 16 }) },
  // Notch-by-notch: 6 notches 300 ms apart → each one settles (labels restored) before the next.
  zoom_in_notches: { setup: { pre: 4 }, gesture: () => wheelEvents({ at: at(0.45, 0.55), notches: 6, dir: -1, interval: 300 }) },
  // Drag-pan at full extent.
  pan_overview: { setup: { pre: 0 }, gesture: () => dragEvents([at(0.35, 0.5), at(0.65, 0.5)], 1000) },
  // Drag-pan at region zoom (~35 % width).
  pan_region: { setup: { pre: 10 }, gesture: () => dragEvents([at(0.3, 0.5), at(0.7, 0.55)], 1000) },
  // Drag-pan at detail zoom (~12 % width).
  pan_detail: { setup: { pre: 20 }, gesture: () => dragEvents([at(0.3, 0.5), at(0.7, 0.55)], 1000) },
  // Navigate across Europe at region zoom: 4 successive drags with short regrab pauses.
  navigate_region: { setup: { pre: 10, fx: 0.2, fy: 0.75 }, gesture: () => {
    const legs = [[at(0.8, 0.3), at(0.2, 0.7)], [at(0.8, 0.3), at(0.2, 0.7)], [at(0.7, 0.2), at(0.3, 0.8)], [at(0.8, 0.5), at(0.2, 0.5)]];
    let t = 0; const evs = [];
    for (const leg of legs) { for (const e of dragEvents(leg, 700)) evs.push({ dt: t + e.dt, params: e.params }); t += 700 + 2 * 16 + 180; }
    return evs;
  } },
};

async function clickAt(p) {
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', buttons: 0, clickCount: 1 });
}
async function runJump(name, rep) {
  // Programmatic viewBox jumps: latency from the operator's input to the
  // first painted frame showing the new view, and the cost of that frame.
  await unzoom();
  if (name === 'unzoom_click') await preZoom(20, 0.45, 0.55);
  await sleep(1200);
  await ev(`window.__cs4gPerf.begin(${JSON.stringify(name)})`);
  const timeOrigin = await ev('performance.timeOrigin');
  let tIn0;
  if (name === 'unzoom_click') {
    const b = await ev(`(() => { const b = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Unzoom') && b.offsetParent); const r = b.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
    tIn0 = await pageNow();
    await clickAt(b);
  } else {
    const inp = await ev(`(() => { const i = Array.from(document.querySelectorAll('input')).find(i => (i.placeholder || '').includes('Inspect') && i.offsetParent); const r = i.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
    await clickAt(inp);
    await sleep(300);
    const vl = await ev(`(async () => { const r = await fetch('/api/voltage-levels'); const j = await r.json(); const ids = (j.voltage_levels || []).slice().sort(); return ids[Math.floor(ids.length * 0.37)]; })()`);
    tIn0 = await pageNow();
    await page.send('Input.insertText', { text: vl });
  }
  await sleep(2500);
  const rec = await ev(`window.__cs4gPerf.end()`);
  // Clear the inspect query so later scenarios start clean.
  if (name === 'inspect_jump') { await ev(`(() => { const i = Array.from(document.querySelectorAll('input')).find(i => (i.placeholder || '').includes('Inspect') && i.offsetParent); if (i) { const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; s.call(i, ''); i.dispatchEvent(new Event('input', { bubbles: true })); i.blur(); } })()`); await sleep(800); }
  const in0 = tIn0 - timeOrigin;
  const f = rec.frames, st = rec.states;
  const vis = (s) => { const p = (s || '').split('|'); return [p[0], p[1], p[2], p[6] || ''].join('|'); };
  let ci = -1;
  for (let i = 1; i < f.length; i++) if (f[i] >= in0 - 20 && vis(st[i]) !== vis(st[i - 1])) { ci = i; break; }
  const painted = ci > 0 && ci + 1 < f.length ? f[ci + 1] - in0 : null;
  const loaf = rec.loaf.filter(l => l.start >= in0 - 5).slice(0, 4).map(l => ({ dur: Math.round(l.dur), styleLayoutPaint: Math.round(l.start + l.dur - l.styleStart), scripts: l.scripts.filter(s => s.dur > 5).map(s => `${s.inv}:${s.dur}`).join(' ') }));
  return { name, rep, inputToPaintedMs: painted != null ? Math.round(painted) : null, changeFrameMs: ci > 0 && ci + 1 < f.length ? Math.round(f[ci + 1] - f[ci]) : null, loaf, finalState: st[st.length - 1] };
}

async function runTabReturn(name, rep) {
  // Leave the N tab for the (light) Context tab, come back, and time the
  // click → painted frame of the N diagram (the cost of re-showing ~99k nodes).
  await unzoom();
  await sleep(800);
  const r = await ev(`(async () => {
    const raf2 = () => new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res)));
    const ctx = document.querySelector('[data-testid="tab-button-context"]');
    if (!ctx) return { error: 'no context tab' };
    ctx.click();
    await new Promise(res => setTimeout(res, 1200));
    await raf2();
    const P = window.__cs4gPerf; P.begin('tab_return_n');
    const t0 = performance.now();
    document.querySelector('[data-testid="tab-button-n"]').click();
    await raf2();
    const t1 = performance.now();
    await new Promise(res => setTimeout(res, 500));
    const rec = P.end();
    return { clickToPaint: t1 - t0, loaf: rec.loaf.slice(0, 3).map(l => ({ dur: Math.round(l.dur), styleLayoutPaint: Math.round(l.start + l.dur - l.styleStart) })) };
  })()`);
  await sleep(800);
  return { name, rep, inputToPaintedMs: r.clickToPaint != null ? Math.round(r.clickToPaint) : null, changeFrameMs: r.loaf && r.loaf[0] ? r.loaf[0].dur : null, loaf: r.loaf || r };
}

async function runScenario(name, rep) {
  if (name === 'tab_return_n') return runTabReturn(name, rep);
  if (name === 'unzoom_click' || name === 'inspect_jump') return runJump(name, rep);
  const sc = SCENARIOS[name];
  await unzoom();
  await preZoom(sc.setup.pre || 0, sc.setup.fx ?? 0.45, sc.setup.fy ?? 0.55);
  await sleep(1200);
  const events = sc.gesture();
  const tracing = TRACE === name && rep === 0;
  let traceDone;
  if (tracing) {
    traceDone = new Promise((resolve) => browser.on('Tracing.tracingComplete', resolve));
    await browser.send('Tracing.start', { transferMode: 'ReturnAsStream', traceConfig: { recordMode: 'recordAsMuchAsPossible',
      includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'disabled-by-default-devtools.timeline.frame', 'blink', 'cc', 'gpu', 'viz', 'benchmark', 'input', 'latencyInfo', 'toplevel', 'blink.user_timing', 'disabled-by-default-devtools.timeline.paint'] } });
    await sleep(200);
  }
  await ev(`window.__cs4gPerf.begin(${JSON.stringify(name)})`);
  const tIn0 = await pageNow();
  await fireSchedule(events);
  const tIn1 = await pageNow();
  await sleep(1300);
  const rec = await ev(`window.__cs4gPerf.end()`);
  let tracePath = null;
  if (tracing) {
    await browser.send('Tracing.end');
    const { stream } = await traceDone;
    let data = '';
    for (;;) { const r = await browser.send('IO.read', { handle: stream, size: 1 << 20 }); data += r.base64Encoded ? Buffer.from(r.data, 'base64').toString() : r.data; if (r.eof) break; }
    await browser.send('IO.close', { handle: stream });
    tracePath = OUT.replace(/\.json$/, `.${name}.trace.json`);
    fs.writeFileSync(tracePath, data);
  }
  const timeOrigin = await ev('performance.timeOrigin');
  return analyse(name, rep, rec, tIn0 - timeOrigin, tIn1 - timeOrigin, events.length, tracePath, events);
}

function pct(a, p) { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]; }
function completeness(events, st) {
  // How much of the requested gesture the diagram actually ended up showing.
  const vbOf = (s) => { const v = (s || '').split('|')[0].split(/\s+/).map(Number); return v.length === 4 && v.every(Number.isFinite) ? v : null; };
  const v0 = vbOf(st.find(s => vbOf(s))), v1 = vbOf([...st].reverse().find(s => vbOf(s)));
  if (!v0 || !v1) return null;
  const wheels = events.filter(e => e.params.type === 'mouseWheel');
  if (wheels.length) {
    const want = wheels.reduce((acc, e) => acc * (e.params.deltaY > 0 ? 1.1 : 0.9), 1);
    return +(Math.log(v1[2] / v0[2]) / Math.log(want)).toFixed(2);
  }
  let dx = 0, dy = 0, prev = null, down = false;
  for (const e of events) {
    const p = e.params;
    if (p.type === 'mousePressed') { down = true; prev = p; continue; }
    if (p.type === 'mouseReleased') { if (prev) { dx += p.x - prev.x; dy += p.y - prev.y; } down = false; prev = null; continue; }
    if (down && prev) { dx += p.x - prev.x; dy += p.y - prev.y; prev = p; }
  }
  // Content must follow the cursor: with preserveAspectRatio 'xMidYMid meet'
  // one screen px is max(w/W, h/H) user units (the letterboxed axis).
  const scale = Math.max(v0[2] / rect.w, v0[3] / rect.h);
  const want = Math.hypot(dx, dy) * scale;
  const got = Math.hypot(v1[0] - v0[0], v1[1] - v0[1]);
  return want ? +(got / want).toFixed(2) : null;
}
function analyse(name, rep, rec, in0, in1, nInputs, tracePath, events) {
  const f = rec.frames, st = rec.states;
  // Gesture window: first input → last input.
  const iv = [];
  for (let i = 1; i < f.length; i++) if (f[i] >= in0 && f[i] <= in1 + 20) iv.push(f[i] - f[i - 1]);
  // Visual updates: frames whose (viewBox|transform|canvas) state changed.
  let updates = 0, lastChange = null, firstChange = null;
  const vis = (s) => { const p = (s || '').split('|'); return [p[0], p[1], p[2], p[6] || ''].join('|'); };
  for (let i = 1; i < f.length; i++) {
    if (vis(st[i]) !== vis(st[i - 1])) { updates++; lastChange = f[i]; if (firstChange == null && f[i] >= in0) firstChange = f[i]; }
  }
  // Settle: first frame after the gesture where interacting flag cleared.
  let settleIdx = -1;
  for (let i = 1; i < f.length; i++) if (f[i] > in1 && (st[i] || '').split('|')[3] === '0' && (st[i - 1] || '').split('|')[3] === '1') { settleIdx = i; break; }
  const settleFrame = settleIdx > 0 && settleIdx + 1 < f.length ? f[settleIdx + 1] - f[settleIdx] : null;
  const loafIn = rec.loaf.filter(l => l.start >= in0 - 5 && l.start <= in1 + 20);
  const loafSettle = settleIdx > 0 ? rec.loaf.filter(l => l.start >= f[settleIdx - 1] - 5 && l.start <= f[settleIdx] + 400) : [];
  const brk = (ls) => ls.map(l => ({ dur: Math.round(l.dur), pre: Math.round(l.styleStart - l.start), styleLayoutPaint: Math.round(l.start + l.dur - l.styleStart), scripts: l.scripts.filter(s => s.dur > 5).map(s => `${s.inv}:${s.dur}${s.fs ? '(forced ' + s.fs + ')' : ''}`).join(' ') }));
  const span = in1 - in0;
  return {
    name, rep, nInputs, gestureMs: Math.round(span), completeness: completeness(events, st), doneVersion: 2,
    framesInGesture: iv.length, fps: iv.length ? +(1000 / (iv.reduce((a, b) => a + b, 0) / iv.length)).toFixed(1) : null,
    frameMs: { p50: +pct(iv, 0.5)?.toFixed(1), p90: +pct(iv, 0.9)?.toFixed(1), max: +Math.max(...iv, 0).toFixed(1) },
    visualUpdates: updates, firstVisualMs: firstChange != null ? Math.round(firstChange - in0) : null,
    catchUpMs: lastChange != null ? Math.round(lastChange - in1) : null,
    settleAfterLastInputMs: settleIdx > 0 ? Math.round(f[settleIdx] - in1) : null,
    settleFrameMs: settleFrame != null ? Math.round(settleFrame) : null,
    longFramesInGesture: loafIn.length, longFramesSumMs: Math.round(loafIn.reduce((a, l) => a + l.dur, 0)),
    loafGesture: brk(loafIn).slice(0, 12), loafSettle: brk(loafSettle).slice(0, 4),
    finalState: st[st.length - 1], tracePath,
    cullFlips: (() => { let n = 0; for (let i = 1; i < f.length; i++) if (f[i] < in1 && (st[i] || '').split('|')[3] === '0' && (st[i - 1] || '').split('|')[3] === '1') n++; return n; })(),
    inputs: (rec.inputs || []).map(x => x.join(',')).join(' '),
    timeline: f.map((t, i) => { const p = (st[i] || '').split('|'); return `${Math.round(t - in0)}:${p[3] || '-'}${p[4] ? p[4][0] : ''}${i && vis(st[i]) !== vis(st[i - 1]) ? '*' : ''}`; }).join(' '),
  };
}

const names = SCEN === 'all' ? [...Object.keys(SCENARIOS), 'unzoom_click', 'inspect_jump', 'tab_return_n'] : SCEN === 'none' ? [] : SCEN.split(',');
const results = [];
// Warm-up gesture (fills raster caches / bitmap serialisation cache).
await fireSchedule(wheelEvents({ at: at(0.45, 0.55), notches: 3, dir: -1, interval: 40 }));
await sleep(800);
for (let rep = 0; rep < REPS; rep++) {
  for (const n of names) {
    const r = await runScenario(n, rep);
    results.push(r);
    if (r.inputToPaintedMs !== undefined) { log(`${n} #${rep}: input→painted ${r.inputToPaintedMs} ms, change frame ${r.changeFrameMs} ms ${JSON.stringify(r.loaf)}`); continue; }
    log(`${n} #${rep}: done ${r.completeness} flips ${r.cullFlips} fps ${r.fps} p50 ${r.frameMs.p50} p90 ${r.frameMs.p90} max ${r.frameMs.max} | upd ${r.visualUpdates}/${r.nInputs} first ${r.firstVisualMs} catchUp ${r.catchUpMs} | settle +${r.settleAfterLastInputMs} frame ${r.settleFrameMs} | LoAF ${r.longFramesInGesture} (${r.longFramesSumMs}ms)`);
  }
}
const gpuInfo = (await browser.send('SystemInfo.getInfo')).gpu.auxAttributes?.glRenderer;
const expApplied = await ev('window.__cs4gExpCss || null').catch(() => null);
const proxyStats = await ev('window.__proxyStats || null').catch(() => null);
fs.writeFileSync(OUT, JSON.stringify({ hw: HW, mode: MODE, exp: EXPF, expApplied, proxyStats, perfMetrics, gpu: gpuInfo, viewport: { W, H }, rect, vb0, load, tabSwitch, consoleLines: consoleLines.slice(0, 60), results }, null, 1));
log('wrote', OUT);
if (!KEEP) proc.kill('SIGKILL');
process.exit(0);
