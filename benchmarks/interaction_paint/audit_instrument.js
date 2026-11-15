// Part of the 2026-11 large-network interaction audit — see
// docs/performance/large-grid-interaction-audit-2026-11.md
// Injected before the app boots (Page.addScriptToEvaluateOnNewDocument).
// Records, only while a measurement window is open:
//   - every rAF callback timestamp (main-thread frame cadence)
//   - per frame: the active NAD's viewBox / CSS transform / interacting flag
//   - long-animation-frame entries (LoAF) with their style/layout/render split
// Nothing runs between measurement windows, so idle behaviour is untouched.
(() => {
  if (window.__cs4gPerf) return;
  const P = (window.__cs4gPerf = { recording: false });
  let loafBuf = [];
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        loafBuf.push({
          start: e.startTime, dur: e.duration, renderStart: e.renderStart,
          styleStart: e.styleAndLayoutStart, blocking: e.blockingDuration,
          scripts: (e.scripts || []).map((s) => ({
            inv: s.invoker, dur: Math.round(s.duration), fs: Math.round(s.forcedStyleAndLayoutDuration || 0),
            fn: s.sourceFunctionName || '',
          })),
        });
      }
    }).observe({ type: 'long-animation-frame', buffered: true });
  } catch { /* LoAF unsupported */ }

  const activeSvgState = () => {
    // Resolved once per measurement window: a document-wide attribute
    // selector per frame cost ~5 ms on the 250k-node page and skewed fast frames.
    const c = P.container && P.container.isConnected ? P.container : (P.container = document.querySelector('.svg-container:not([style*="display: none"])'));
    if (!c) return null;
    // Walk the container's few direct children: a ':scope > x' selector still
    // matches against every descendant (~10 ms/frame on the 99k-node NAD).
    let svg = null, proxy = null, canvas = null;
    for (const ch of c.children) {
      if (ch.tagName === 'svg' || ch.tagName === 'SVG') { if (ch.classList.contains('nad-vector-proxy')) proxy = ch; else if (!svg) svg = ch; }
      else if (ch.tagName === 'CANVAS') canvas = ch;
    }
    return {
      id: c.id,
      vb: svg ? svg.getAttribute('viewBox') : null,
      tf: svg && svg.style ? svg.style.transform : '',
      cv: canvas ? (canvas.__cs4gDraws || canvas.dataset.vb || canvas.style.transform || 'mounted') + (canvas.style.display === 'none' ? '' : '+') : '',
      it: c.classList.contains('svg-interacting'),
      tier: c.getAttribute('data-zoom-tier'),
      pv: proxy && proxy.style.display !== 'none' ? proxy.getAttribute('viewBox') : '',
    };
  };

  const tick = (t) => {
    if (!P.recording) return;
    const s = activeSvgState();
    P.frames.push(t);
    P.states.push(s ? `${s.vb}|${s.tf}|${s.cv}|${s.it ? 1 : 0}|${s.tier}|${s.id}|${s.pv}` : '');
    requestAnimationFrame(tick);
  };

  // Canvas gesture proxy frames: the proxy clears its canvas with one fillRect
  // per draw, so count those on `canvas.nad-canvas-proxy` to see each frame.
  try {
    const proto = window.CanvasRenderingContext2D && window.CanvasRenderingContext2D.prototype;
    if (proto && !proto.__cs4gWrapped) {
      const fillRect = proto.fillRect;
      proto.fillRect = function (...args) {
        const c = this.canvas;
        if (c && c.classList && c.classList.contains('nad-canvas-proxy')) c.__cs4gDraws = (c.__cs4gDraws || 0) + 1;
        return fillRect.apply(this, args);
      };
      proto.__cs4gWrapped = true;
    }
  } catch { /* no canvas support */ }

  const evRec = (e) => { if (P.recording) P.inputs.push([e.type, Math.round(performance.now() - P.t0), Math.round(e.timeStamp - P.t0)]); };
  for (const ty of ['mousedown', 'mousemove', 'mouseup', 'wheel']) window.addEventListener(ty, evRec, { capture: true, passive: true });
  P.begin = (label) => {
    P.inputs = [];
    P.container = null;
    P.label = label;
    P.frames = []; P.states = []; P.marks = [];
    loafBuf = [];
    P.t0 = performance.now();
    P.recording = true;
    requestAnimationFrame(tick);
    return P.t0;
  };
  P.mark = (name) => { if (P.marks) P.marks.push([name, performance.now()]); };
  P.end = () => {
    P.recording = false;
    return { inputs: P.inputs, label: P.label, t0: P.t0, t1: performance.now(), frames: P.frames, states: P.states, marks: P.marks, loaf: loafBuf.filter((l) => l.start + l.dur >= P.t0) };
  };
  P.state = activeSvgState;
})();
