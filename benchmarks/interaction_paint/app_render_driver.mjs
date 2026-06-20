// Configure the app, load N, capture the de-clutter log, auto-zoom to the
// densest substation cluster, and screenshot it (visual check of flow labels).
import { writeFileSync } from 'fs';
const PORT = 9444;
const OUT = process.env.OUT || '/tmp/cs4g_flowlabels.jpg';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function findTarget(){for(let i=0;i<40;i++){const l=await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();const t=l.find(x=>x.type==='page'&&/localhost:5173/.test(x.url));if(t&&t.webSocketDebuggerUrl)return t;await sleep(250);}throw new Error('no app target');}
function connect(wsUrl){return new Promise(res=>{const ws=new WebSocket(wsUrl);let id=0;const p=new Map();const logs=[];
  ws.addEventListener('message',ev=>{const m=JSON.parse(ev.data);
    if(m.method==='Runtime.consoleAPICalled'){try{logs.push(m.params.args.map(a=>a.value??a.description??'').join(' '));}catch{}}
    if(m.id&&p.has(m.id)){const{r,j}=p.get(m.id);p.delete(m.id);m.error?j(new Error(JSON.stringify(m.error))):r(m.result);}});
  ws.addEventListener('open',()=>{const send=(method,params={})=>new Promise((r,j)=>{const mid=++id;p.set(mid,{r,j});ws.send(JSON.stringify({id:mid,method,params}));});
    const evalJs=async(e,a=false)=>{const r=await send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:a});if(r.exceptionDetails)throw new Error('eval:'+JSON.stringify(r.exceptionDetails).slice(0,300));return r.result.value;};
    res({send,evalJs,logs});});});}
const { send, evalJs, logs } = await connect((await findTarget()).webSocketDebuggerUrl);
await send('Runtime.enable'); await send('Page.enable');
const log=(...a)=>console.error(...a);

await evalJs(`
window.__setInput=(sel,val)=>{const el=document.querySelector(sel);if(!el)return 'no:'+sel;const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;s.call(el,val);el.dispatchEvent(new Event('input',{bubbles:true}));return el.value;};
window.__btn=(txt)=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===txt);if(b){b.click();return true;}return false;};
'ok';`);

// Configure if a fresh NAD is needed.
const mounted0 = await evalJs(`document.querySelector('.svg-container svg')?.querySelectorAll('*').length||0`);
if (mounted0 < 5000) {
  if (!(await evalJs(`!!document.querySelector('#networkPathInput')`))) { await evalJs(`window.__btn('⚙')`); await sleep(600); }
  await evalJs(`window.__setInput('#networkPathInput','data/pypsa_eur_eur220_225_380_400/network.xiidm')`);
  await evalJs(`window.__setInput('#actionPathInput','data/pypsa_eur_eur220_225_380_400/actions.json')`);
  await evalJs(`(()=>{const l=[...document.querySelectorAll('label')].find(x=>/layout/i.test(x.textContent));const inp=l&&(l.parentElement.querySelector('input[type=text]')||l.closest('div').querySelector('input[type=text]'));if(inp){const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;s.call(inp,'data/pypsa_eur_eur220_225_380_400/grid_layout.json');inp.dispatchEvent(new Event('input',{bubbles:true}));}})()`);
  await evalJs(`window.__btn('Apply')`); log('applied; loading NAD…');
  for (let i=0;i<120;i++){ const n=await evalJs(`document.querySelector('.svg-container svg')?.querySelectorAll('*').length||0`).catch(()=>0); if(n>5000)break; await sleep(1000); }
}
const nodes = await evalJs(`document.querySelector('.svg-container svg')?.querySelectorAll('*').length||0`);
log('NAD nodes:', nodes);
await sleep(1000);
log('declutter log:', logs.filter(l=>/De-cluttered|Boosted|declutter pass/.test(l)).slice(-3).join(' || ') || '(none captured)');

// Optionally hide VL-name labels (🏷 VL) to isolate the flow values.
if (process.env.HIDE_VL === '1') { await evalJs(`window.__btn('🏷 VL')`).catch(()=>{}); await sleep(400);
  await evalJs(`(()=>{const c=document.querySelector('.svg-container');if(c)c.classList.add('nad-hide-vl-labels');})()`); await sleep(300); }

const FORCED_VB = process.env.VB || '';
// Find the densest substation cluster and zoom the SVG viewBox onto it.
const vb = await evalJs(`(()=>{
  const FORCED=${JSON.stringify(FORCED_VB)};
  const svg=document.querySelector('.svg-container svg');
  const circles=[...svg.querySelectorAll('.nad-vl-nodes g[transform]')];
  const pts=[];
  for(const g of circles){const m=/translate\\(\\s*([-0-9.eE+]+)\\s*[, ]\\s*([-0-9.eE+]+)/.exec(g.getAttribute('transform')||'');if(m)pts.push([+m[1],+m[2]]);}
  if(!pts.length) return null;
  // grid density
  let minx=1e18,miny=1e18,maxx=-1e18,maxy=-1e18;
  for(const[x,y]of pts){if(x<minx)minx=x;if(x>maxx)maxx=x;if(y<miny)miny=y;if(y>maxy)maxy=y;}
  const span=Math.max(maxx-minx,maxy-miny);
  const cell=span/120;
  const grid=new Map();let best=null;
  for(const[x,y]of pts){const k=Math.floor(x/cell)+','+Math.floor(y/cell);const c=(grid.get(k)||0)+1;grid.set(k,c);if(!best||c>best.c){best={k,c,x,y};}}
  // Tight window (~2.2% of full width) over the densest cell so individual
  // flow values render. Force the detail zoom-tier on the container (we set
  // the viewBox directly, bypassing usePanZoom which normally maintains it).
  let nvb;
  if(FORCED){const p=FORCED.split(/\\s+/).map(Number);nvb={x:p[0],y:p[1],w:p[2],h:p[3]};}
  else{const W=(maxx-minx)*0.022, H=W*0.66;nvb={x:best.x-W/2,y:best.y-H/2,w:W,h:H};}
  svg.setAttribute('viewBox',\`\${nvb.x} \${nvb.y} \${nvb.w} \${nvb.h}\`);
  const cont=svg.closest('.svg-container'); if(cont){cont.setAttribute('data-zoom-tier','detail');cont.classList.remove('svg-interacting');}
  return {densest:best.c, vb:nvb};
})()`);
log('zoomed to densest cluster:', JSON.stringify(vb));
await sleep(1200);

const { data } = await send('Page.captureScreenshot', { format: 'jpeg', quality: 80 });
writeFileSync(OUT, Buffer.from(data, 'base64'));
log('saved', OUT);
process.exit(0);
