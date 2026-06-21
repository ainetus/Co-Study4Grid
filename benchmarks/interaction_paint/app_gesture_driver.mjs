// Drive the REAL Co-Study4Grid app (localhost:5173) end-to-end on the
// isolated port-9444 Chrome: open Settings, point at pypsa_eur_eur220_225_380_400,
// Apply, wait for the N NAD, then measure a REAL drag-pan + wheel-zoom gesture
// through the app's own usePanZoom handlers, with the GPU toggle OFF then ON.
const PORT = 9444;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function findTarget() {
  for (let i = 0; i < 40; i++) {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const t = list.find(x => x.type === 'page' && /^https?:/.test(x.url));
    if (t && t.webSocketDebuggerUrl) return t;
    await sleep(250);
  }
  throw new Error('no page target');
}
function connect(wsUrl) {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl); let id = 0; const pending = new Map();
    ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const { r, j } = pending.get(m.id); pending.delete(m.id); m.error ? j(new Error(JSON.stringify(m.error))) : r(m.result); } });
    ws.addEventListener('open', () => {
      const send = (method, params = {}) => new Promise((r, j) => { const mid = ++id; pending.set(mid, { r, j }); ws.send(JSON.stringify({ id: mid, method, params })); });
      const evalJs = async (expr, awaitPromise = false) => { const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise }); if (res.exceptionDetails) throw new Error('eval: ' + JSON.stringify(res.exceptionDetails).slice(0, 300)); return res.result.value; };
      resolve({ send, evalJs });
    });
  });
}

const { send, evalJs } = await connect((await findTarget()).webSocketDebuggerUrl);
await send('Runtime.enable');
const log = (...a) => console.error(...a);

// Helper expressions injected into the page.
const HELPERS = `
window.__setInput = (sel, val) => {
  const el = document.querySelector(sel); if (!el) return 'no-el:' + sel;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, val);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return el.value;
};
window.__btn = (txt) => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === txt); if (b) { b.click(); return true; } return false; };
window.__summarize = (a) => { if(!a.length) return null; const s=a.slice().sort((x,y)=>x-y); const n=s.length, mean=a.reduce((p,v)=>p+v,0)/n; const pct=p=>s[Math.min(n-1,Math.floor(p*n))]; const drop=a.filter(d=>d>14).length; return {frames:n, mean:+mean.toFixed(2), median:+pct(0.5).toFixed(2), p95:+pct(0.95).toFixed(2), max:+s[n-1].toFixed(2), fps_median:+(1000/pct(0.5)).toFixed(1), dropPct:+(100*drop/n).toFixed(1)}; };
// Real drag-pan through the app's usePanZoom (mousedown on container, mousemove on window).
window.__dragPan = (durationMs) => new Promise(resolve => {
  const c = [...document.querySelectorAll('.svg-container')].find(e => e.offsetParent !== null && e.querySelector('svg'));
  if (!c) return resolve({error:'no visible svg-container'});
  const r = c.getBoundingClientRect();
  const cx = r.left + r.width/2, cy = r.top + r.height/2;
  const md = new MouseEvent('mousedown', {bubbles:true, clientX:cx, clientY:cy, button:0});
  c.dispatchEvent(md);
  const intervals=[]; let last=performance.now(); const t0=last;
  function frame(now){
    intervals.push(now-last); last=now;
    const e=now-t0; const t=(e/durationMs); const dx=Math.sin(t*Math.PI*4)*250;
    window.dispatchEvent(new MouseEvent('mousemove',{bubbles:true, clientX:cx+dx, clientY:cy, button:0}));
    if(e<durationMs) requestAnimationFrame(frame);
    else { window.dispatchEvent(new MouseEvent('mouseup',{bubbles:true, clientX:cx+dx, clientY:cy, button:0})); intervals.shift(); resolve(window.__summarize(intervals)); }
  }
  requestAnimationFrame(frame);
});
// Real wheel-zoom through usePanZoom (wheel on container, alternating in/out).
window.__wheelZoom = (durationMs) => new Promise(resolve => {
  const c = [...document.querySelectorAll('.svg-container')].find(e => e.offsetParent !== null && e.querySelector('svg'));
  if (!c) return resolve({error:'no visible svg-container'});
  const r = c.getBoundingClientRect(); const cx=r.left+r.width/2, cy=r.top+r.height/2;
  const intervals=[]; let last=performance.now(); const t0=last;
  function frame(now){
    intervals.push(now-last); last=now;
    const e=now-t0;
    const dir = Math.sin(e/250) > 0 ? -1 : 1; // zoom in/out
    c.dispatchEvent(new WheelEvent('wheel',{bubbles:true, cancelable:true, clientX:cx, clientY:cy, deltaY: dir*100}));
    if(e<durationMs) requestAnimationFrame(frame);
    else { intervals.shift(); resolve(window.__summarize(intervals)); }
  }
  requestAnimationFrame(frame);
});
'ok';`;
await evalJs(HELPERS);

// 1. Open Settings if not open.
let settingsOpen = await evalJs(`!!document.querySelector('#networkPathInput')`);
if (!settingsOpen) { await evalJs(`window.__btn('⚙')`); await sleep(600); }
log('settings open:', await evalJs(`!!document.querySelector('#networkPathInput')`));

// 2. Set paths.
log('net:', await evalJs(`window.__setInput('#networkPathInput','data/pypsa_eur_eur220_225_380_400/network.xiidm')`));
log('act:', await evalJs(`window.__setInput('#actionPathInput','data/pypsa_eur_eur220_225_380_400/actions.json')`));
// layout input: 3rd path input (no id). Set by locating label "Layout".
await evalJs(`(()=>{const labs=[...document.querySelectorAll('label')];const l=labs.find(x=>/layout/i.test(x.textContent));if(l){const inp=l.parentElement.querySelector('input[type=text]')||l.closest('div').querySelector('input[type=text]');if(inp){const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;s.call(inp,'data/pypsa_eur_eur220_225_380_400/grid_layout.json');inp.dispatchEvent(new Event('input',{bubbles:true}));return inp.value;}}return 'no-layout-input';})()`).then(v=>log('layout:',v));

// 3. Ensure GPU toggle is OFF for the first run.
await evalJs(`(()=>{const t=document.querySelector('[data-testid=smooth-pan-zoom-toggle]');if(t&&t.checked){t.click();} return t?('checked='+document.querySelector('[data-testid=smooth-pan-zoom-toggle]').checked):'no-toggle';})()`).then(v=>log('toggle pre:',v));

// 4. Apply.
await evalJs(`window.__btn('Apply')`); log('clicked Apply');

// 5. Wait for the N NAD to mount with many nodes.
let mounted = 0;
for (let i = 0; i < 120; i++) { mounted = await evalJs(`(()=>{const s=document.querySelector('.svg-container svg');return s?s.querySelectorAll('*').length:0;})()`).catch(()=>0); if (mounted > 5000) break; await sleep(1000); }
log('NAD nodes mounted:', mounted, 'tab:', await evalJs(`document.querySelector('.svg-container svg')?.getAttribute('viewBox')?.slice(0,30)`));
if (mounted < 5000) { console.log(JSON.stringify({error:'NAD did not mount', mounted})); process.exit(1); }
await sleep(800);

// 6. Measure OFF.
const off_pan = await evalJs(`window.__dragPan(2500)`, true);
await sleep(300);
const off_zoom = await evalJs(`window.__wheelZoom(2500)`, true);
log('OFF pan', JSON.stringify(off_pan), 'zoom', JSON.stringify(off_zoom));

// 7. Flip GPU toggle ON via Settings (open, click toggle, close WITHOUT Apply).
await evalJs(`window.__btn('⚙')`); await sleep(500);
const onState = await evalJs(`(()=>{const t=document.querySelector('[data-testid=smooth-pan-zoom-toggle]');if(t&&!t.checked){t.click();} return document.querySelector('[data-testid=smooth-pan-zoom-toggle]')?.checked;})()`);
log('toggle now ON:', onState, 'localStorage:', await evalJs(`localStorage.getItem('cs4g-smooth-pan-zoom')`));
// Close settings without Apply: click ✕ or Cancel.
await evalJs(`(()=>{if(!window.__btn('✕')){const fb=[...document.querySelectorAll('button')].find(b=>/cancel|close|annul/i.test(b.textContent));if(fb)fb.click();}})()`); await sleep(500);
log('settings closed:', !(await evalJs(`!!document.querySelector('#networkPathInput')`)));

// 8. Measure ON.
const on_pan = await evalJs(`window.__dragPan(2500)`, true);
await sleep(300);
const on_zoom = await evalJs(`window.__wheelZoom(2500)`, true);
log('ON pan', JSON.stringify(on_pan), 'zoom', JSON.stringify(on_zoom));

console.log(JSON.stringify({ off:{pan:off_pan,zoom:off_zoom}, on:{pan:on_pan,zoom:on_zoom} }));
process.exit(0);
