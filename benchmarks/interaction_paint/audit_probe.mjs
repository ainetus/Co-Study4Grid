// Targeted probes behind the canvas gesture proxy's design choices
// (docs/performance/canvas-gesture-proxy.md). Each one attaches to a KEPT
// session — the app loaded on the grid under test in headless Chrome:
//
//   DETACH=1 node audit_drive.mjs --hw gpu --mode canvas --scenarios none --keep 1 --port 9351 --out session.json
//   node audit_probe.mjs <probe> [--port 9351]
//
// Probes (all on the N tab):
//   flip        cost of restyling the proxy canvas at region zoom, per property
//   drag-hits   hit tests at the start of a region-zoom drag, with / without pointer capture
//   wheel-hits  hit tests during a wheel burst over the live SVG
//   rebuild     when the proxy rebuild runs relative to an Inspect jump, and the mutations it reacts to
//   detached    a canvas-mode drag in a detached window
//   layers      composited layers before / during a canvas gesture
//
// The probes inject styles / listeners into the page and remove them again;
// restart the session to be sure of a clean state between runs.
import { waitTarget, connect, browserWs, sleep } from './audit_cdp.mjs';

const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : dflt; };
const PROBE = argv[0];
const PORT = +opt('port', '9351');
const C = `document.querySelector('canvas.nad-canvas-proxy')`;
const TWO_FRAMES = `await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));`;

const mainTarget = await waitTarget(PORT, t => t.url.startsWith('http'));
const page = await connect(mainTarget.webSocketDebuggerUrl);
const browser = await connect(await browserWs(PORT));
const ev = page.evalJs;

const rectOf = async (pg = page) => pg.evalJs(`(() => { const r = document.querySelector('#n-svg-container').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
const r0 = await rectOf();
const at = (fx, fy, r = r0) => ({ x: Math.round(r.x + r.w * fx), y: Math.round(r.y + r.h * fy) });
const mouse = (pg, type, p, buttons = 1) => pg.send('Input.dispatchMouseEvent', { type, ...p, button: 'left', buttons, clickCount: 1 });
const unzoom = async () => { await ev(`(() => { const b = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Unzoom') && b.offsetParent); b && b.click(); })()`); await sleep(2500); };
// Ten notches at ~35 % of the full extent, then wait for the bake and its re-raster.
const regionZoom = async (settleMs = 8000) => {
  await unzoom();
  for (let i = 0; i < 10; i++) { await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...at(0.45, 0.55), deltaX: 0, deltaY: -100 }); await sleep(60); }
  await sleep(settleMs);
};
const drag = async (p0, p1, moves = 30, pg = page) => {
  await mouse(pg, 'mousePressed', p0);
  for (let k = 1; k <= moves; k++) {
    await mouse(pg, 'mouseMoved', { x: Math.round(p0.x + (p1.x - p0.x) * k / moves), y: Math.round(p0.y + (p1.y - p0.y) * k / moves) });
    await sleep(16.7);
  }
  await mouse(pg, 'mouseReleased', p1, 0);
};

// Trace `fn` and return the renderer's trace events.
const traced = async (fn) => {
  const done = new Promise((resolve) => browser.on('Tracing.tracingComplete', resolve));
  await browser.send('Tracing.start', { transferMode: 'ReturnAsStream', traceConfig: { recordMode: 'recordAsMuchAsPossible',
    includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'blink', 'cc', 'toplevel', 'input'] } });
  await sleep(300);
  await fn();
  await browser.send('Tracing.end');
  const { stream } = await done;
  let data = '';
  for (;;) { const x = await browser.send('IO.read', { handle: stream, size: 1 << 20 }); data += x.base64Encoded ? Buffer.from(x.data, 'base64').toString() : x.data; if (x.eof) break; }
  await browser.send('IO.close', { handle: stream });
  const j = JSON.parse(data);
  return Array.isArray(j) ? j : j.traceEvents;
};
const totals = (events, names) => {
  const t = {};
  for (const e of events) if (e.ph === 'X' && names.includes(e.name)) { t[e.name] ??= [0, 0]; t[e.name][0] += e.dur / 1000; t[e.name][1]++; }
  return Object.entries(t).map(([k, [ms, n]]) => `${k.replace('PaintArtifactCompositor::Update', 'Layerize').replace('LayerTreeHost::WaitForCommitCompletion', 'WaitCommit')}=${ms.toFixed(0)}ms/${n}`).join('  ');
};

const probes = {
  // Every style change on the canvas re-layerizes the page; only content changes are free.
  async flip() {
    await regionZoom();
    if (!await ev(`!!${C}`)) { await drag(at(0.4, 0.5), at(0.45, 0.5), 5); await sleep(3000); }
    const saved = await ev(`${C}.getAttribute('style')`);
    const NAMES = ['Paint', 'PaintArtifactCompositor::Update', 'RasterTask', 'HitTest'];
    const step = async (label, js) => {
      const evs = await traced(async () => { await ev(`(async () => { const c = ${C}; ${js}; ${TWO_FRAMES} })()`); await sleep(2500); });
      console.log(label.padEnd(30), totals(evs, NAMES));
      await sleep(1500);
    };
    await step('nothing', '');
    await step('content only (fillRect)', `c.getContext('2d').fillRect(0, 0, 4, 4)`);
    await step('opacity 1 -> 0', `c.style.opacity = '0'`);
    await step('opacity 0 -> 1', `c.style.opacity = '1'`);
    await step('pointer-events none -> auto', `c.style.pointerEvents = 'auto'`);
    await step('pointer-events auto -> none', `c.style.pointerEvents = 'none'`);
    await step('translate off-screen', `c.style.transform = 'translate(-300000px, 0px)'`);
    await step('translate back', `c.style.transform = 'translate(0px, 0px)'`);
    if (argv.includes('--display')) {
      await step('display none', `c.style.display = 'none'`);
      await step('display back', `c.style.display = ''`);
    }
    await ev(`${C}.setAttribute('style', ${JSON.stringify(saved)})`);
  },

  // The press and the first move hit-test the live SVG before the capture applies.
  async ['drag-hits']() {
    await regionZoom();
    const variant = async (label, captureAtDown, preventDown) => {
      await ev(`(() => { const el = document.querySelector('#n-svg-container');
        if (el.__p1) el.removeEventListener('pointerdown', el.__p1); if (el.__p2) el.removeEventListener('mousedown', el.__p2, true);
        el.__p1 = ${captureAtDown} ? (e) => el.setPointerCapture(e.pointerId) : null; if (el.__p1) el.addEventListener('pointerdown', el.__p1);
        el.__p2 = ${preventDown} ? (e) => e.preventDefault() : null; if (el.__p2) el.addEventListener('mousedown', el.__p2, true); })()`);
      const evs = await traced(async () => { await drag(at(0.3, 0.5), at(0.5, 0.52), 12); await sleep(200); });
      const down = evs.find(e => e.name === 'EventDispatch' && e.args?.data?.type === 'mousedown');
      const up = evs.find(e => e.name === 'EventDispatch' && e.args?.data?.type === 'mouseup');
      const ht = evs.filter(e => e.ph === 'X' && e.name === 'HitTest' && e.dur > 2000 && down && up && e.ts >= down.ts - 1000 && e.ts <= up.ts + 1000);
      const dragged = evs.filter(e => e.ph === 'X' && e.name === 'MouseEventManager::handleMouseDraggedEvent' && e.dur > 2000);
      console.log(label.padEnd(36), `hit tests > 2 ms: ${ht.length} (${(ht.reduce((a, e) => a + e.dur, 0) / 1000).toFixed(0)} ms) at +${ht.map(e => ((e.ts - down.ts) / 1000).toFixed(0)).join(', +')} ms; slow drag-selection checks: ${dragged.length}`);
      await sleep(2500);
    };
    await variant('as built (capture on the first move)', false, false);
    await variant('capture on pointerdown', true, false);
    await variant('preventDefault on mousedown', false, true);
    await variant('both', true, true);
    await ev(`(() => { const el = document.querySelector('#n-svg-container'); if (el.__p1) el.removeEventListener('pointerdown', el.__p1); if (el.__p2) el.removeEventListener('mousedown', el.__p2, true); })()`);
  },

  // Chrome latches the wheel target, so a click-through proxy costs wheel bursts little.
  async ['wheel-hits']() {
    const burst = async (label, pe) => {
      await ev(`(() => { const st = document.getElementById('probe-pe') || document.head.appendChild(Object.assign(document.createElement('style'), { id: 'probe-pe' })); st.textContent = ${JSON.stringify(pe ? `canvas.nad-canvas-proxy { pointer-events: ${pe} !important; }` : '')}; })()`);
      await regionZoom(6000);
      const evs = await traced(async () => {
        for (let i = 0; i < 12; i++) { await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...at(0.5, 0.5), deltaX: 0, deltaY: 100 }); await sleep(40); }
        await sleep(200);
      });
      const ht = evs.filter(e => e.ph === 'X' && e.name === 'HitTest');
      const wheels = evs.filter(e => e.name === 'EventDispatch' && e.args?.data?.type === 'wheel');
      console.log(label.padEnd(30), `wheel events ${wheels.length}, hit tests ${ht.length} (${(ht.reduce((a, e) => a + e.dur, 0) / 1000).toFixed(0)} ms, ${ht.filter(e => e.dur > 2000).length} over 2 ms)`);
      await sleep(3000);
    };
    await burst('canvas click-through (built)', '');
    await burst('canvas hit-testable', 'auto');
    await ev(`document.getElementById('probe-pe')?.remove()`);
  },

  // The rebuild after a highlight change waits for 600 ms of quiet, after the jump's paint.
  async rebuild() {
    await ev(`(() => {
      window.__probe = { idle: [], vb: [], cls: 0, style: 0, child: 0 };
      if (!window.__probeRic) {
        const orig = window.requestIdleCallback.bind(window);
        window.requestIdleCallback = (cb, o) => orig((d) => { const t0 = performance.now(); try { cb(d); } finally { window.__probe.idle.push([t0, performance.now() - t0]); } }, o);
        window.__probeRic = true;
      }
      const svg = document.querySelector('#n-svg-container svg');
      new MutationObserver(() => window.__probe.vb.push(performance.now())).observe(svg, { attributes: true, attributeFilter: ['viewBox'] });
      new MutationObserver((rs) => { for (const r of rs) { if (r.type === 'childList') window.__probe.child++; else if (r.attributeName === 'class') window.__probe.cls++; else window.__probe.style++; } })
        .observe(svg, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] });
    })()`);
    const inspect = (text) => ev(`(() => { const i = Array.from(document.querySelectorAll('input')).find(i => (i.placeholder || '').includes('Inspect') && i.offsetParent); const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; s.call(i, ${JSON.stringify(text)}); i.dispatchEvent(new Event('input', { bubbles: true })); if (!${JSON.stringify(text)}) i.blur(); })()`);
    for (const [k, frac] of [0.37, 0.52, 0.71].entries()) {
      await unzoom();
      const inp = await ev(`(() => { const i = Array.from(document.querySelectorAll('input')).find(i => (i.placeholder || '').includes('Inspect') && i.offsetParent); const r = i.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
      await mouse(page, 'mousePressed', inp); await mouse(page, 'mouseReleased', inp, 0);
      await sleep(300);
      const vl = await ev(`(async () => { const j = await (await fetch('/api/voltage-levels')).json(); const ids = (j.voltage_levels || []).slice().sort(); return ids[Math.floor(ids.length * ${frac})]; })()`);
      await ev(`(() => { Object.assign(window.__probe, { idle: [], vb: [], cls: 0, style: 0, child: 0, t0: performance.now() }); })()`);
      await page.send('Input.insertText', { text: vl });
      await sleep(2500);
      const d = await ev(`(() => ({ ...window.__probe }))()`);
      const rel = (t) => Math.round(t - d.t0);
      console.log(`jump ${k}: viewBox written at +${d.vb.map(rel).join(', +')} ms; idle callbacks > 5 ms: ${d.idle.filter(([, dur]) => dur > 5).map(([t, dur]) => `+${rel(t)} (${Math.round(dur)} ms)`).join(', ') || 'none'}; svg mutations: class ${d.cls}, style ${d.style}, childList ${d.child}`);
      await inspect('');
      await sleep(1500);
    }
  },

  // Owner-window rAF / idle callbacks: the proxy also works in a detached window.
  async detached() {
    const centre = async (pg, sel) => pg.evalJs(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
    const click = async (pg, p) => { await mouse(pg, 'mousePressed', p); await mouse(pg, 'mouseReleased', p, 0); };
    await click(page, await centre(page, '[data-testid="tab-detach-n"]'));
    const popT = await waitTarget(PORT, t => t.id !== mainTarget.id);
    const pop = await connect(popT.webSocketDebuggerUrl);
    await sleep(1500);
    const state = () => pop.evalJs(`(() => { const c = document.querySelector('#n-svg-container'); const cv = c.querySelector('canvas.nad-canvas-proxy'); return { proxyUp: c.hasAttribute('data-gesture-proxy'), canvasInPopup: cv ? cv.ownerDocument === document : null, viewBox: c.querySelector('svg').getAttribute('viewBox') }; })()`);
    const r = await rectOf(pop);
    const before = (await state()).viewBox;
    const p0 = at(0.3, 0.5, r), p1 = at(0.6, 0.5, r);
    await mouse(pop, 'mousePressed', p0);
    for (let k = 1; k <= 20; k++) { await mouse(pop, 'mouseMoved', { x: Math.round(p0.x + (p1.x - p0.x) * k / 20), y: p0.y }); await sleep(17); }
    const mid = await state();
    await mouse(pop, 'mouseReleased', p1, 0);
    await sleep(1500);
    const after = await state();
    console.log('mid-drag:', JSON.stringify({ ...mid, liveViewBoxUnchanged: mid.viewBox === before }));
    console.log('after the pause:', JSON.stringify({ ...after, viewBoxMoved: after.viewBox !== before }));
    await click(page, await centre(page, '[data-testid="tab-detach-n"]'));
    await sleep(800);
  },

  // The proxy canvas is its own composited layer; the live SVG sits in the root layer.
  async layers() {
    let layers = null;
    page.on('LayerTree.layerTreeDidChange', (p) => { if (p.layers) layers = p.layers; });
    await page.send('DOM.enable');
    await page.send('LayerTree.enable');
    const dump = async (label) => {
      await sleep(600);
      const big = (layers || []).filter(l => l.width * l.height > 200000);
      console.log(`--- ${label}: ${layers ? layers.length : 0} layers; large ones:`);
      for (const l of big) {
        let node = '';
        if (l.backendNodeId) { try { const d = await page.send('DOM.describeNode', { backendNodeId: l.backendNodeId }); node = `${d.node.nodeName} ${(d.node.attributes || []).join(' ').slice(0, 80)}`; } catch { /* detached node */ } }
        let reasons = '';
        try { const c = await page.send('LayerTree.compositingReasons', { layerId: l.layerId }); reasons = (c.compositingReasonIds || c.compositingReasons || []).join(','); } catch { /* unknown layer */ }
        console.log(`  ${l.layerId} ${Math.round(l.width)}x${Math.round(l.height)} draws=${l.drawsContent} paints=${l.paintCount} node=${node} reasons=${reasons}`);
      }
    };
    await dump('idle');
    const p0 = at(0.3, 0.5);
    await mouse(page, 'mousePressed', p0);
    await mouse(page, 'mouseMoved', { x: p0.x + 40, y: p0.y });
    await dump('during a canvas gesture');
    await mouse(page, 'mouseReleased', { x: p0.x + 40, y: p0.y }, 0);
  },
};

if (!probes[PROBE]) {
  console.error(`usage: node audit_probe.mjs <${Object.keys(probes).join(' | ')}> [--port 9351]`);
  process.exit(2);
}
await probes[PROBE]();
process.exit(0);
