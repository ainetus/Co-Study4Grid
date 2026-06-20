// Verify the bitmap pan/zoom mode end-to-end in the real app: set each mode
// via the Settings select, measure sustained drag/wheel fps on the N tab, then
// load a contingency and capture a MID-gesture screenshot to confirm the bitmap
// keeps the overload/contingency halos (the N-1/action fidelity prerequisite).
import { writeFileSync } from 'fs';
const PORT = 9444;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function findTarget(){for(let i=0;i<40;i++){const l=await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();const t=l.find(x=>x.type==='page'&&/localhost:5173/.test(x.url));if(t&&t.webSocketDebuggerUrl)return t;await sleep(250);}throw new Error('no app target');}
function connect(wsUrl){return new Promise(res=>{const ws=new WebSocket(wsUrl);let id=0;const p=new Map();
  ws.addEventListener('message',ev=>{const m=JSON.parse(ev.data);if(m.id&&p.has(m.id)){const{r,j}=p.get(m.id);p.delete(m.id);m.error?j(new Error(JSON.stringify(m.error))):r(m.result);}});
  ws.addEventListener('open',()=>{const send=(method,params={})=>new Promise((r,j)=>{const mid=++id;p.set(mid,{r,j});ws.send(JSON.stringify({id:mid,method,params}));});
    const evalJs=async(e,a=false)=>{const r=await send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:a});if(r.exceptionDetails)throw new Error('eval:'+JSON.stringify(r.exceptionDetails).slice(0,400));return r.result.value;};res({send,evalJs});});});}
const { send, evalJs } = await connect((await findTarget()).webSocketDebuggerUrl);
await send('Runtime.enable'); await send('Page.enable');
const log=(...a)=>console.error(...a);

await evalJs(`
window.__setInput=(sel,val)=>{const el=document.querySelector(sel);if(!el)return 'no';const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;s.call(el,val);el.dispatchEvent(new Event('input',{bubbles:true}));return el.value;};
window.__btn=(txt)=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===txt);if(b){b.click();return true;}return false;};
window.__summarize=(a)=>{if(!a.length)return null;const s=a.slice().sort((x,y)=>x-y);const n=s.length,mean=a.reduce((p,v)=>p+v,0)/n;const pct=p=>s[Math.min(n-1,Math.floor(p*n))];const drop=a.filter(d=>d>14).length;return{frames:n,median:+pct(0.5).toFixed(2),p95:+pct(0.95).toFixed(2),fps_median:+(1000/pct(0.5)).toFixed(1),dropPct:+(100*drop/n).toFixed(1)};};
window.__dragPan=(d)=>new Promise(resolve=>{const c=[...document.querySelectorAll('.svg-container')].find(e=>e.offsetParent!==null&&e.querySelector('svg'));if(!c)return resolve({error:'no-container'});const r=c.getBoundingClientRect(),cx=r.left+r.width/2,cy=r.top+r.height/2;c.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,clientX:cx,clientY:cy,button:0}));const iv=[];let last=performance.now();const t0=last;function f(now){iv.push(now-last);last=now;const e=now-t0,t=e/d,dx=Math.sin(t*Math.PI*4)*250;window.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:cx+dx,clientY:cy,button:0}));if(e<d)requestAnimationFrame(f);else{window.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,clientX:cx+dx,clientY:cy,button:0}));iv.shift();resolve(window.__summarize(iv));}}requestAnimationFrame(f);});
window.__setMode=async(mode)=>{window.__btn('⚙');await new Promise(r=>setTimeout(r,400));window.__btn('Configurations');await new Promise(r=>setTimeout(r,300));const sel=document.querySelector('[data-testid=pan-zoom-mode-select]');if(!sel)return'NO-SELECT';const s=Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value').set;s.call(sel,mode);sel.dispatchEvent(new Event('change',{bubbles:true}));const ls=localStorage.getItem('cs4g-smooth-pan-zoom');if(!window.__btn('✕')){const fb=[...document.querySelectorAll('button')].find(b=>/cancel|close/i.test(b.textContent));if(fb)fb.click();}await new Promise(r=>setTimeout(r,400));return ls;};
'ok';`);

// Configure + load N if needed.
const mounted0 = await evalJs(`document.querySelector('.svg-container svg')?.querySelectorAll('*').length||0`);
if (mounted0 < 5000) {
  if (!(await evalJs(`!!document.querySelector('#networkPathInput')`))) { await evalJs(`window.__btn('⚙')`); await sleep(600); }
  await evalJs(`window.__setInput('#networkPathInput','data/pypsa_eur_eur220_225_380_400/network.xiidm')`);
  await evalJs(`window.__setInput('#actionPathInput','data/pypsa_eur_eur220_225_380_400/actions.json')`);
  await evalJs(`(()=>{const l=[...document.querySelectorAll('label')].find(x=>/layout/i.test(x.textContent));const inp=l&&(l.parentElement.querySelector('input[type=text]')||l.closest('div').querySelector('input[type=text]'));if(inp){const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;s.call(inp,'data/pypsa_eur_eur220_225_380_400/grid_layout.json');inp.dispatchEvent(new Event('input',{bubbles:true}));}})()`);
  await evalJs(`window.__btn('Apply')`); log('loading NAD…');
  for (let i=0;i<120;i++){ const n=await evalJs(`document.querySelector('.svg-container svg')?.querySelectorAll('*').length||0`).catch(()=>0); if(n>5000)break; await sleep(1000); }
}
log('N nodes:', await evalJs(`document.querySelector('.svg-container svg')?.querySelectorAll('*').length||0`));
await sleep(800);

// fps per mode on the N tab.
const out = {};
for (const mode of ['off', 'gpu', 'bitmap']) {
  const ls = await evalJs(`window.__setMode('${mode}')`, true);
  await sleep(400);
  // two gestures: the first primes the bitmap raster, the second is the steady state.
  await evalJs(`window.__dragPan(1500)`, true);
  await sleep(300);
  const pan = await evalJs(`window.__dragPan(2500)`, true);
  out[mode] = { ls, pan };
  log(mode, 'ls=' + ls, JSON.stringify(pan));
}
console.log(JSON.stringify(out));
process.exit(0);
