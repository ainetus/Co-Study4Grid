// Launch a headed Chrome via --remote-debugging-pipe (CDP over stdio fds 3/4,
// NO TCP port — so the IDE's preview/live-reload can't discover and hijack it)
// and run the fluidity harness. Fully isolated + real GPU (headed on macOS).
import { spawn } from 'child_process';
import { openSync } from 'fs';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.URL || 'http://127.0.0.1:8901/real.html';
const EXPR = process.env.EXPR || `window.__runSuite(${+(process.env.DUR || 2500)}, ${+(process.env.REPS || 3)})`;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const log = openSync('/tmp/cs4g_pipe_chrome.log', 'a');
const child = spawn(CHROME, [
  '--user-data-dir=/tmp/cs4g-bench-pipe',
  '--remote-debugging-pipe',
  '--no-first-run', '--no-default-browser-check', '--no-startup-window=false',
  '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling', '--disable-features=CalculateNativeWinOcclusion',
  '--window-size=1500,1000', URL,
], { stdio: ['ignore', log, log, 'pipe', 'pipe'] });

const wr = child.stdio[3], rd = child.stdio[4];
let id = 0; const pending = new Map();
const events = [];
let buf = Buffer.alloc(0);
rd.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  let i;
  while ((i = buf.indexOf(0)) !== -1) {
    const msg = JSON.parse(buf.slice(0, i).toString('utf8'));
    buf = buf.slice(i + 1);
    if (msg.id && pending.has(msg.id)) { const { res, rej } = pending.get(msg.id); pending.delete(msg.id); msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result); }
    else if (msg.method) events.push(msg);
  }
});
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const mid = ++id; pending.set(mid, { res, rej });
  const m = { id: mid, method, params }; if (sessionId) m.sessionId = sessionId;
  wr.write(JSON.stringify(m) + '\0');
});

// Discover the page target and attach (flattened sessions).
await send('Target.setDiscoverTargets', { discover: true });
let targetId = null;
for (let i = 0; i < 80 && !targetId; i++) {
  const { targetInfos } = await send('Target.getTargets');
  const t = targetInfos.find(x => x.type === 'page' && /^https?:/.test(x.url));
  if (t) targetId = t.targetId; else await sleep(250);
}
if (!targetId) { console.error('no page target'); child.kill(); process.exit(1); }
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const evalJs = async (expr, awaitPromise = false) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise }, sessionId);
  if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r.result.value;
};
await send('Runtime.enable', {}, sessionId);

// If the page isn't on our URL yet (fresh profile may show a default), navigate once.
const cur = await evalJs('location.href');
if (!cur.includes(URL.split('/').pop())) { await send('Page.enable', {}, sessionId); await send('Page.navigate', { url: URL }, sessionId); await sleep(2500); }

for (let i = 0; i < 80; i++) {
  const ready = await evalJs(`(typeof window.__runSuite==='function' && typeof window.__runExtra==='function' && document.getElementById('out') && document.getElementById('out').textContent.startsWith('ready'))`).catch(() => false);
  if (ready) break; await sleep(500);
}
const env = await evalJs(`(()=>{const gl=document.createElement('canvas').getContext('webgl');const d=gl&&gl.getExtension('WEBGL_debug_renderer_info');return {visibility:document.visibilityState,dpr:window.devicePixelRatio,gpu:d?gl.getParameter(d.UNMASKED_RENDERER_WEBGL):'n/a',svgChildren:document.querySelectorAll('#c svg *').length, url:location.href};})()`);
console.error('ENV', JSON.stringify(env));

const result = await evalJs(EXPR, true);
console.log(JSON.stringify(result));
child.kill();
process.exit(0);
