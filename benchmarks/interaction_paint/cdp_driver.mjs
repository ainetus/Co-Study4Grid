// Drive the bench_fluidity.html harness in a headed Chrome via the DevTools
// Protocol (Node 22 global WebSocket + fetch — no npm deps). Chrome must be
// running with --remote-debugging-port=9333 and the no-throttle flags so the
// page keeps rendering at full GPU speed even while occluded.
const PORT = process.env.CDP_PORT || 9333;
const URLMATCH = 'bench_fluidity.html';
const DURATION = +(process.env.DUR || 2500);
const REPS = +(process.env.REPS || 3);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function findTarget() {
  const wantAny = !!process.env.NAV || process.env.ANYPAGE === '1';
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const t = wantAny
        ? list.find(x => x.type === 'page' && /^https?:|^about:|chrome:\/\/newtab/.test(x.url))
        : list.find(x => x.type === 'page' && x.url.includes(URLMATCH));
      if (t && t.webSocketDebuggerUrl) return t;
    } catch { /* port not up yet */ }
    await sleep(500);
  }
  throw new Error('no page target found (wantAny=' + wantAny + ')');
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve: r, reject: j } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) j(new Error(JSON.stringify(msg.error))); else r(msg.result);
      }
    });
    ws.addEventListener('error', (e) => reject(new Error('ws error ' + (e.message || ''))));
    ws.addEventListener('open', () => {
      const send = (method, params = {}) => new Promise((r, j) => {
        const mid = ++id; pending.set(mid, { resolve: r, reject: j });
        ws.send(JSON.stringify({ id: mid, method, params }));
      });
      const evalJs = async (expr, awaitPromise = false) => {
        const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise });
        if (res.exceptionDetails) throw new Error('eval: ' + JSON.stringify(res.exceptionDetails));
        return res.result.value;
      };
      resolve({ send, evalJs, ws });
    });
  });
}

const EXPR = process.env.EXPR || `window.__runSuite(${DURATION}, ${REPS})`;
const { evalJs, send } = await connect((await findTarget()).webSocketDebuggerUrl);
await send('Runtime.enable');
await send('Page.enable');
if (process.env.NAV) { await send('Page.navigate', { url: process.env.NAV }); await sleep(2500); }
else if (process.env.RELOAD === '1') { await send('Page.reload', { ignoreCache: true }); await sleep(1500); }

// Wait for harness readiness.
for (let i = 0; i < 60 && process.env.SKIPREADY !== '1'; i++) {
  const ready = await evalJs(`(typeof window.__runSuite === 'function' && typeof window.__runExtra === 'function' && document.getElementById('out') && document.getElementById('out').textContent.startsWith('ready'))`);
  if (ready) break;
  await sleep(500);
}

const env = await evalJs(`(()=>{return {visibility:document.visibilityState, dpr:window.devicePixelRatio, url:location.href};})()`);
console.error('ENV', JSON.stringify(env));
if (env.visibility !== 'visible') console.error('WARNING: visibility=' + env.visibility + ' — rAF may be throttled. Anti-throttle flags should keep it running anyway.');

const result = await evalJs(EXPR, true);
console.log(JSON.stringify(result));
process.exit(0);
