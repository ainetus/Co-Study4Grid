// Assumes the N NAD is already loaded in the app. For each mode (off/on),
// set the real "Smooth pan/zoom (GPU)" toggle via Settings -> Configurations,
// then measure a real drag-pan + wheel-zoom through usePanZoom.
const PORT = 9444;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function findTarget() { for (let i=0;i<40;i++){const l=await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();const t=l.find(x=>x.type==='page'&&/localhost:5173/.test(x.url));if(t&&t.webSocketDebuggerUrl)return t;await sleep(250);} throw new Error('no app target'); }
function connect(wsUrl){return new Promise(res=>{const ws=new WebSocket(wsUrl);let id=0;const p=new Map();ws.addEventListener('message',ev=>{const m=JSON.parse(ev.data);if(m.id&&p.has(m.id)){const{r,j}=p.get(m.id);p.delete(m.id);m.error?j(new Error(JSON.stringify(m.error))):r(m.result);}});ws.addEventListener('open',()=>{const send=(method,params={})=>new Promise((r,j)=>{const mid=++id;p.set(mid,{r,j});ws.send(JSON.stringify({id:mid,method,params}));});const evalJs=async(e,a=false)=>{const r=await send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:a});if(r.exceptionDetails)throw new Error('eval:'+JSON.stringify(r.exceptionDetails).slice(0,300));return r.result.value;};res({send,evalJs});});});}
const { send, evalJs } = await connect((await findTarget()).webSocketDebuggerUrl);
await send('Runtime.enable');
const log=(...a)=>console.error(...a);

const HELPERS=`
window.__btn=(txt)=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===txt);if(b){b.click();return true;}return false;};
window.__summarize=(a)=>{if(!a.length)return null;const s=a.slice().sort((x,y)=>x-y);const n=s.length,mean=a.reduce((p,v)=>p+v,0)/n;const pct=p=>s[Math.min(n-1,Math.floor(p*n))];const drop=a.filter(d=>d>14).length;return{frames:n,mean:+mean.toFixed(2),median:+pct(0.5).toFixed(2),p95:+pct(0.95).toFixed(2),max:+s[n-1].toFixed(2),fps_median:+(1000/pct(0.5)).toFixed(1),dropPct:+(100*drop/n).toFixed(1)};};
window.__dragPan=(d)=>new Promise(resolve=>{const c=[...document.querySelectorAll('.svg-container')].find(e=>e.offsetParent!==null&&e.querySelector('svg'));if(!c)return resolve({error:'no-container'});const r=c.getBoundingClientRect(),cx=r.left+r.width/2,cy=r.top+r.height/2;c.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,clientX:cx,clientY:cy,button:0}));const iv=[];let last=performance.now();const t0=last;function f(now){iv.push(now-last);last=now;const e=now-t0,t=e/d,dx=Math.sin(t*Math.PI*4)*250;window.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:cx+dx,clientY:cy,button:0}));if(e<d)requestAnimationFrame(f);else{window.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,clientX:cx+dx,clientY:cy,button:0}));iv.shift();resolve(window.__summarize(iv));}}requestAnimationFrame(f);});
window.__wheelZoom=(d)=>new Promise(resolve=>{const c=[...document.querySelectorAll('.svg-container')].find(e=>e.offsetParent!==null&&e.querySelector('svg'));if(!c)return resolve({error:'no-container'});const r=c.getBoundingClientRect(),cx=r.left+r.width/2,cy=r.top+r.height/2;const iv=[];let last=performance.now();const t0=last;function f(now){iv.push(now-last);last=now;const e=now-t0;const dir=Math.sin(e/250)>0?-1:1;c.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,clientX:cx,clientY:cy,deltaY:dir*100}));if(e<d)requestAnimationFrame(f);else{iv.shift();resolve(window.__summarize(iv));}}requestAnimationFrame(f);});
// open Settings -> Configurations tab, set toggle to desired, read state, close.
window.__setToggle=async(desired)=>{
  window.__btn('⚙'); await new Promise(r=>setTimeout(r,400));
  window.__btn('Configurations'); await new Promise(r=>setTimeout(r,300));
  const t=document.querySelector('[data-testid=smooth-pan-zoom-toggle]');
  if(!t) return 'NO-TOGGLE';
  if(t.checked!==desired) t.click();
  const state={checked:document.querySelector('[data-testid=smooth-pan-zoom-toggle]').checked, ls:localStorage.getItem('cs4g-smooth-pan-zoom')};
  if(!window.__btn('✕')){const fb=[...document.querySelectorAll('button')].find(b=>/cancel|close/i.test(b.textContent));if(fb)fb.click();}
  await new Promise(r=>setTimeout(r,400));
  return state;
};
'ok';`;
await evalJs(HELPERS);
const TAB = process.env.TAB || 'Network (N)';
await evalJs(`window.__btn(${JSON.stringify(TAB)})`); await sleep(600);
log('tab:', TAB, 'visible svg:', await evalJs(`(()=>{const c=[...document.querySelectorAll('.svg-container')].find(e=>e.offsetParent!==null&&e.querySelector('svg'));return c?{nodes:c.querySelector('svg').querySelectorAll('*').length, halos:c.querySelectorAll('.nad-overloaded,.nad-contingency-highlight,.nad-delta-positive,.nad-delta-negative,.nad-action-target').length}:null;})()`));

const out={};
for (const mode of ['off','on']) {
  const st = await evalJs(`window.__setToggle(${mode==='on'})`, true);
  log(mode,'toggle state:', JSON.stringify(st));
  await sleep(400);
  await evalJs(`window.__btn(${JSON.stringify(TAB)})`); await sleep(400);
  const pan = await evalJs(`window.__dragPan(2500)`, true);
  await sleep(300);
  const zoom = await evalJs(`window.__wheelZoom(2500)`, true);
  out[mode]={toggle:st, pan, zoom};
  log(mode,'pan',JSON.stringify(pan),'zoom',JSON.stringify(zoom));
}
console.log(JSON.stringify(out));
process.exit(0);
