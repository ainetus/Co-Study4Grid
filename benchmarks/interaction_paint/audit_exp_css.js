// Part of the 2026-11 large-network interaction audit — see
// docs/performance/large-grid-interaction-audit-2026-11.md
// Runtime CSSOM edits for A/B experiments (injected on new document).
// Flags come from localStorage 'cs4g-exp' (comma separated). Rules are
// DELETED / REPLACED in the live App.css sheet (not overridden), so the
// selector-invalidation cost of the original rule really disappears.
(() => {
  let flags = [];
  try { flags = (localStorage.getItem('cs4g-exp') || '').split(',').filter(Boolean); } catch { /* none */ }
  if (!flags.length) return;
  const has = (f) => flags.includes(f);
  const apply = () => {
    let sheet = null;
    for (const s of Array.from(document.styleSheets)) {
      try { if (Array.from(s.cssRules).some(r => r.selectorText && r.selectorText.includes('svg-interacting'))) { sheet = s; break; } } catch { /* cross-origin */ }
    }
    if (!sheet) return false;
    const rules = () => Array.from(sheet.cssRules);
    const del = (pred) => { for (let i = sheet.cssRules.length - 1; i >= 0; i--) if (pred(sheet.cssRules[i])) sheet.deleteRule(i); };
    const done = [];
    if (has('css-ptr-root')) {
      del(r => r.selectorText === '.svg-container.svg-interacting svg *');
      sheet.insertRule('.svg-container.svg-interacting > svg { pointer-events: none !important; }', sheet.cssRules.length);
      done.push('ptr-root');
    }
    const cullSel = (r) => r.selectorText && r.selectorText.startsWith('.svg-container.svg-interacting .nad-edge-infos');
    if (has('css-cull-off')) { del(cullSel); done.push('cull-off'); }
    if (has('css-cull-vis')) {
      const r = rules().find(cullSel);
      if (r) { const sel = r.selectorText; del(cullSel); sheet.insertRule(`${sel} { visibility: hidden !important; }`, sheet.cssRules.length); done.push('cull-vis'); }
    }
    if (has('css-no-select')) {
      // A drag-pan otherwise starts a text selection over flows / labels:
      // selection work on every dragged mousemove, and dragging an existing
      // selection starts a native drag-and-drop that swallows the gesture.
      sheet.insertRule('.svg-container { -webkit-user-select: none; user-select: none; }', sheet.cssRules.length);
      done.push('no-select');
    }
    if (has('css-text-geo')) {
      // Blink re-lays out SVG <text> at the on-screen font size whenever the
      // CTM scale changes, unless text-rendering is geometricPrecision.
      sheet.insertRule('.svg-container svg text { text-rendering: geometricPrecision; }', sheet.cssRules.length);
      done.push('text-geo');
    }
    if (has('css-labels-tier')) {
      sheet.insertRule('[data-zoom-tier="overview"] .nad-text-nodes, [data-zoom-tier="overview"] .nad-text-edges { display: none; }', sheet.cssRules.length);
      done.push('labels-tier');
    }
    window.__cs4gExpCss = done;
    return true;
  };
  const tryApply = () => { if (!apply()) setTimeout(tryApply, 50); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', tryApply); else tryApply();
})();
