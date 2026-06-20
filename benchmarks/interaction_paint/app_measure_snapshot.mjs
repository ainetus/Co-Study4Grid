// Measure where the bitmap-mode snapshot cost goes (clone / serialize / decode
// / draw) on the live N NAD — to size the gesture-start blocking problem.
const PORT = 9444; const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function findTarget(){for(let i=0;i<40;i++){const l=await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();const t=l.find(x=>x.type==='page'&&/localhost:5173/.test(x.url));if(t&&t.webSocketDebuggerUrl)return t;await sleep(250);}throw new Error('no app target');}
function connect(wsUrl){return new Promise(res=>{const ws=new WebSocket(wsUrl);let id=0;const p=new Map();ws.addEventListener('message',ev=>{const m=JSON.parse(ev.data);if(m.id&&p.has(m.id)){const{r,j}=p.get(m.id);p.delete(m.id);m.error?j(new Error(JSON.stringify(m.error))):r(m.result);}});ws.addEventListener('open',()=>{const send=(method,params={})=>new Promise((r,j)=>{const mid=++id;p.set(mid,{r,j});ws.send(JSON.stringify({id:mid,method,params}));});const evalJs=async(e,a=false)=>{const r=await send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:a});if(r.exceptionDetails)throw new Error('eval:'+JSON.stringify(r.exceptionDetails).slice(0,300));return r.result.value;};res({send,evalJs});});});}
const { evalJs, send } = await connect((await findTarget()).webSocketDebuggerUrl);
await send('Runtime.enable');
const log=(...a)=>console.error(...a);
await evalJs(`window.__setInput=(s,v)=>{const el=document.querySelector(s);if(!el)return;const x=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;x.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));};window.__btn=(t)=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===t);if(b){b.click();return true;}return false;};'ok';`);
const mounted0 = await evalJs(`document.querySelector('.svg-container svg')?.querySelectorAll('*').length||0`);
if (mounted0 < 5000) {
  if (!(await evalJs(`!!document.querySelector('#networkPathInput')`))) { await evalJs(`window.__btn('⚙')`); await sleep(600); }
  await evalJs(`window.__setInput('#networkPathInput','data/pypsa_eur_eur220_225_380_400/network.xiidm')`);
  await evalJs(`window.__setInput('#actionPathInput','data/pypsa_eur_eur220_225_380_400/actions.json')`);
  await evalJs(`(()=>{const l=[...document.querySelectorAll('label')].find(x=>/layout/i.test(x.textContent));const inp=l&&(l.parentElement.querySelector('input[type=text]')||l.closest('div').querySelector('input[type=text]'));if(inp){const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;s.call(inp,'data/pypsa_eur_eur220_225_380_400/grid_layout.json');inp.dispatchEvent(new Event('input',{bubbles:true}));}})()`);
  await evalJs(`window.__btn('Apply')`); log('loading…');
  for (let i=0;i<120;i++){ const n=await evalJs(`document.querySelector('.svg-container svg')?.querySelectorAll('*').length||0`).catch(()=>0); if(n>5000)break; await sleep(1000); }
}
await sleep(800);
const m = await evalJs(`(async()=>{
  const svg=document.querySelector('.svg-container svg');
  const W=svg.clientWidth, H=svg.clientHeight, dpr=window.devicePixelRatio||1;
  const t0=performance.now();
  const clone=svg.cloneNode(true);
  const t1=performance.now();
  clone.querySelectorAll('foreignObject').forEach(n=>n.remove());
  clone.setAttribute('width',W); clone.setAttribute('height',H);
  const xml=new XMLSerializer().serializeToString(clone);
  const t2=performance.now();
  const url=URL.createObjectURL(new Blob([xml],{type:'image/svg+xml;charset=utf-8'}));
  const img=new Image(); img.width=W; img.height=H;
  const t3=performance.now();
  try{ await new Promise((res,rej)=>{img.onload=res;img.onerror=()=>rej(new Error('decode fail'));img.src=url;}); }catch(e){ return {error:String(e)}; }
  const t4=performance.now();
  const cv=document.createElement('canvas'); cv.width=Math.round(W*dpr); cv.height=Math.round(H*dpr); const ctx=cv.getContext('2d'); ctx.setTransform(dpr,0,0,dpr,0,0); ctx.drawImage(img,0,0,W,H);
  const t5=performance.now();
  URL.revokeObjectURL(url);
  return {W,H,dpr, cloneMs:+(t1-t0).toFixed(0), stripSerializeMs:+(t2-t1).toFixed(0), decodeMs:+(t4-t3).toFixed(0), drawMs:+(t5-t4).toFixed(0), syncBlockMs:+(t2-t0).toFixed(0), totalMs:+(t5-t0).toFixed(0), xmlMB:+(xml.length/1e6).toFixed(1)};
})()`, true);
console.log(JSON.stringify(m));
process.exit(0);
