// Part of the 2026-11 large-network interaction audit — see
// docs/performance/large-grid-interaction-audit-2026-11.md
// Minimal CDP client (Node >= 22: global WebSocket + fetch). No npm deps.
import { spawn } from 'node:child_process';
export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export function launchChrome({ port = 9333, profile, headless = true, extra = [], width = 1920, height = 1080, gpu = true }) {
  const args = [
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows', '--disable-features=CalculateNativeWinOcclusion',
    `--window-size=${width},${height}`, '--force-device-scale-factor=1',
    ...(headless ? ['--headless=new'] : []),
    ...(gpu ? [] : ['--disable-gpu']),
    ...extra, 'about:blank',
  ];
  const detached = !!process.env.DETACH;
  const proc = spawn(process.env.CHROME || '/usr/bin/google-chrome', args, { stdio: ['ignore', 'ignore', detached ? 'ignore' : 'pipe'], detached });
  if (detached) proc.unref(); else proc.stderr.on('data', () => {});
  return proc;
}

export async function waitTarget(port, match = () => true) {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const t = list.find(x => x.type === 'page' && match(x));
      if (t && t.webSocketDebuggerUrl) return t;
    } catch { /* not up */ }
    await sleep(250);
  }
  throw new Error('no page target');
}

export async function browserWs(port) {
  for (let i = 0; i < 80; i++) {
    try { return (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl; }
    catch { await sleep(250); }
  }
  throw new Error('no browser ws');
}

export function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const listeners = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve: r, reject: j } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) j(new Error(JSON.stringify(msg.error))); else r(msg.result);
      } else if (msg.method) {
        for (const fn of (listeners.get(msg.method) || [])) fn(msg.params);
      }
    });
    ws.addEventListener('error', (e) => reject(new Error('ws error ' + (e.message || ''))));
    ws.addEventListener('open', () => {
      const send = (method, params = {}) => new Promise((r, j) => {
        const mid = ++id; pending.set(mid, { resolve: r, reject: j });
        ws.send(JSON.stringify({ id: mid, method, params }));
      });
      const on = (method, fn) => { if (!listeners.has(method)) listeners.set(method, []); listeners.get(method).push(fn); };
      const evalJs = async (expr, awaitPromise = true) => {
        const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise });
        if (res.exceptionDetails) throw new Error('eval: ' + JSON.stringify(res.exceptionDetails).slice(0, 800));
        return res.result.value;
      };
      resolve({ send, on, evalJs, ws, close: () => ws.close() });
    });
  });
}
