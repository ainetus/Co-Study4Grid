// On the N-1 (Contingency) tab in BITMAP mode, capture a MID-gesture screenshot
// (live SVG hidden, canvas bitmap showing) and a static one, to confirm the
// overload/contingency halos + flow-delta colours survive in the rasterised
// bitmap — the N-1/action fidelity prerequisite (App.css class paint inlined).
import { writeFileSync } from 'fs';
const PORT = 9444;
const BRANCH = process.env.BRANCH || 'T_relation_13260100-400-225';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function findTarget(){for(let i=0;i<40;i++){const l=await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();const t=l.find(x=>x.type==='page'&&/localhost:5173/.test(x.url));if(t&&t.webSocketDebuggerUrl)return t;await sleep(250);}throw new Error('no app target');}
function connect(wsUrl){return new Promise(res=>{const ws=new WebSocket(wsUrl);let id=0;const p=new Map();
  ws.addEventListener('message',ev=>{const m=JSON.parse(ev.data);if(m.id&&p.has(m.id)){const{r,j}=p.get(m.id);p.delete(m.id);m.error?j(new Error(JSON.stringify(m.error))):r(m.result);}});
  ws.addEventListener('open',()=>{const send=(method,params={})=>new Promise((r,j)=>{const mid=++id;p.set(mid,{r,j});ws.send(JSON.stringify({id:mid,method,params}));});
    const evalJs=async(e,a=false)=>{const r=await send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:a});if(r.exceptionDetails)throw new Error('eval:'+JSON.stringify(r.exceptionDetails).slice(0,400));return r.result.value;};res({send,evalJs});});});}
const { send, evalJs } = await connect((await findTarget()).webSocketDebuggerUrl);
await send('Runtime.enable'); await send('Page.enable');
const log=(...a)=>console.error(...a);
const shot = async (path) => { const { data } = await send('Page.captureScreenshot', { format: 'jpeg', quality: 82 }); writeFileSync(path, Buffer.from(data, 'base64')); log('saved', path); };

await evalJs(`
window.__btn=(txt)=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===txt);if(b){b.click();return true;}return false;};
window.__setMode=async(mode)=>{window.__btn('⚙');await new Promise(r=>setTimeout(r,400));window.__btn('Configurations');await new Promise(r=>setTimeout(r,300));const sel=document.querySelector('[data-testid=pan-zoom-mode-select]');if(sel){const s=Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value').set;s.call(sel,mode);sel.dispatchEvent(new Event('change',{bubbles:true}));}const ls=localStorage.getItem('cs4g-smooth-pan-zoom');if(!window.__btn('✕')){const fb=[...document.querySelectorAll('button')].find(b=>/cancel|close/i.test(b.textContent));if(fb)fb.click();}await new Promise(r=>setTimeout(r,300));return ls;};
// hold a drag for durationMs (mousedown + rAF mousemoves + mouseup); exposes state.
window.__holdDrag=(d)=>{const c=[...document.querySelectorAll('.svg-container')].find(e=>e.offsetParent!==null&&e.querySelector('svg'));if(!c){window.__drag={error:'no-container'};return;}const r=c.getBoundingClientRect(),cx=r.left+r.width/2,cy=r.top+r.height/2;c.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,clientX:cx,clientY:cy,button:0}));window.__dragDone=false;const t0=performance.now();function f(now){const e=now-t0;const dx=Math.sin(e/400)*180;window.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:cx+dx,clientY:cy,button:0}));if(e<d)requestAnimationFrame(f);else{window.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,clientX:cx+dx,clientY:cy,button:0}));window.__dragDone=true;}}requestAnimationFrame(f);};
'ok';`);

log('mode:', await evalJs(`window.__setMode('bitmap')`, true));

// Select contingency + trigger (react-select then Trigger button).
await evalJs(`(()=>{const inp=document.querySelector('#react-select-3-input');if(!inp)return;inp.focus();const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;s.call(inp,${JSON.stringify(BRANCH)});inp.dispatchEvent(new Event('input',{bubbles:true}));})()`);
await sleep(1300);
await evalJs(`(()=>{const o=document.querySelector('[class*=cs4g-contingency__option]');if(o){o.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));o.click();}})()`);
await sleep(600);
await evalJs(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>/trigger/i.test(b.textContent));if(b)b.click();})()`);
await sleep(5000);
await evalJs(`window.__btn('Contingency')`);
let st=null;
for(let i=0;i<60;i++){st=await evalJs(`(()=>{const c=[...document.querySelectorAll('.svg-container')].find(e=>e.offsetParent!==null&&e.querySelector('svg'));return c?{nodes:c.querySelector('svg').querySelectorAll('*').length,halos:c.querySelectorAll('.nad-contingency-highlight,.nad-overloaded,.nad-delta-positive,.nad-delta-negative').length}:null;})()`).catch(()=>null);if(st&&st.nodes>5000)break;await sleep(1000);}
log('N-1 visible svg:', JSON.stringify(st));
await sleep(800);

// Zoom into the contingency area so halos are visible, then static screenshot.
await evalJs(`(()=>{const svg=document.querySelector('.svg-container svg');const hl=svg.querySelector('.nad-contingency-highlight, .nad-delta-positive');const v=svg.getAttribute('viewBox').split(/\\s+/).map(Number);let cx=v[0]+v[2]/2, cy=v[1]+v[3]/2;if(hl){try{const b=hl.getBBox();cx=b.x+b.width/2;cy=b.y+b.height/2;}catch{}}const W=v[2]*0.05,H=W*0.66;svg.setAttribute('viewBox',(cx-W/2)+' '+(cy-H/2)+' '+W+' '+H);const c=svg.closest('.svg-container');if(c)c.setAttribute('data-zoom-tier','detail');})()`);
await sleep(800);
await shot('/tmp/cs4g_bitmap_n1_static.jpg');

// Start a held drag; mid-gesture (canvas mounted) capture, then let it finish.
await evalJs(`window.__holdDrag(3000)`);
await sleep(1500); // raster + mount window
const midState = await evalJs(`(()=>{const c=document.querySelector('.svg-container canvas');const svg=document.querySelector('.svg-container svg');return {canvasMounted:!!c, svgHidden: svg? getComputedStyle(svg).visibility==='hidden':null};})()`);
log('mid-gesture:', JSON.stringify(midState));
await shot('/tmp/cs4g_bitmap_n1_mid.jpg');
// wait for the drag to finish + settle
for(let i=0;i<30;i++){ if(await evalJs(`window.__dragDone===true`)) break; await sleep(200); }
await sleep(500);
console.log(JSON.stringify({ n1: st, midState }));
process.exit(0);
