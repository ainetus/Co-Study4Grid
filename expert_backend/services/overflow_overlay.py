# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0
# This file is part of Co-Study4Grid.

"""Co-Study4Grid–specific overlay injected into the upstream alphaDeesp
interactive overflow-graph HTML.

The overlay adds **action overview pins** on top of the overflow graph.
The upstream HTML viewer (rendered by `alphaDeesp.core.interactive_html`)
already provides pan/zoom, layer toggles and click-to-highlight; this
module is a thin add-on that lives ONLY in Co-Study4Grid because it
depends on action-recommendation data that the upstream library has no
knowledge of.

Wire-format (parent React app → iframe via `postMessage`)::

    {
      "type":    "cs4g:pins",
      "visible": true | false,
      "pins":    [
        {
          "actionId":   "f344b…",
          "substation": "BEON",          # primary anchor
          "nodeCandidates": ["VL_1", …], # ordered fallback anchors
          "label":      "90.1%",
          "severity":   "green" | "orange" | "red" | "grey",
          "isSelected": true,
          "isRejected": false
        }, …
      ]
    }

The iframe answers back with::

    { "type": "cs4g:pin-clicked", "actionId": "<id>" }
    { "type": "cs4g:pin-double-clicked", "actionId": "<id>", "substation": "<name>" }

The pin glyph itself is rendered by the SHARED ``pinGlyph.js`` module
(``frontend/src/utils/svg/pinGlyph.js``), inlined verbatim into the
overlay so the iframe's pins are visually identical to the React
Action Overview pins. Single-source palette + single-source SVG path.

The injection is a pure string substitution: we splice ``<style>`` +
``<script>`` blocks immediately before the closing ``</body>`` tag.
Keeping the contract pure-text rather than DOM-aware lets us
unit-test the injector without an HTML parser dependency.
"""

from __future__ import annotations

import logging
import re
from pathlib import Path

logger = logging.getLogger(__name__)

# Path to the shared JS pin-glyph module. Same file is consumed by the
# React/TS bundle (`actionPinRender.ts`) via a normal ES import; here
# we read it as text and inline the body into the iframe's <script>.
_PIN_GLYPH_JS_PATH = (
    Path(__file__).resolve().parent.parent.parent
    / "frontend" / "src" / "utils" / "svg" / "pinGlyph.js"
)


def _load_pin_glyph_js() -> str:
    """Return the contents of ``pinGlyph.js`` with ESM ``export``
    keywords stripped so the body works as a plain inline script.

    The file is intentionally written without ``import`` statements
    (see its module-level comment) so the only ESM artefact is
    ``export const`` / ``export function``. We strip those prefixes
    at runtime — the resulting code is plain ES2015 that runs both
    inside a Vite bundle and inside the iframe overlay.
    """
    text = _PIN_GLYPH_JS_PATH.read_text(encoding="utf-8")
    # ``\bexport\s+(const|function|let|var)\s+`` keeps the keyword
    # after ``export`` intact; the module-scope binding is preserved.
    return re.sub(r"\bexport\s+(const|function|let|var)\s+", r"\1 ", text)


def _build_overlay_block() -> str:
    """Return the literal ``<style>…</style><script>…</script>`` block to
    inject before the iframe's ``</body>``.

    Single function (rather than a top-level constant) so we can
    re-read ``pinGlyph.js`` on every call — useful during dev when the
    shared module is being iterated on. In production the FastAPI
    process is restarted between deployments anyway.
    """
    pin_glyph_js = _load_pin_glyph_js()

    # Note the doubled ``{{ }}`` braces inside the f-string — they
    # encode literal ``{`` / ``}`` so the JS object literals survive
    # f-string formatting unchanged.
    return f"""
<style id="cs4g-overlay-style">
  /* Pin overlay — visual contract is owned by pinGlyph.js below.
     This file only adds interactive affordances (cursor / opacity). */
  .cs4g-pin {{ pointer-events: auto; cursor: pointer; }}

  /* ``ACTION PINS FILTERS`` section appended at the BOTTOM of the
     iframe's sidebar. The section is ALWAYS visible (it carries the
     pins on/off toggle, so it must be reachable before any pin has
     been requested); the section's header hosts the toggle + the live
     count of currently-displayed (or displayable) pins. When the
     toggle is off, the underlying filter inputs render disabled. */
  #cs4g-filters {{
    margin: 14px 0 0; padding: 8px 0 0;
    border-top: 1px solid var(--border, #d1d5db);
  }}
  #cs4g-filters[data-pins-enabled="false"] .row.toggles {{
    opacity: 0.45; pointer-events: none;
  }}
  #cs4g-filters .pins-toggle {{
    display: inline-flex; align-items: center; gap: 4px;
    cursor: pointer; user-select: none;
    color: var(--muted, #6b7280); margin-right: auto;
  }}
  #cs4g-filters .pins-toggle input {{ cursor: pointer; }}
  #cs4g-filters .filters-header {{
    display: flex; align-items: center; gap: 6px;
    font-size: 12px; text-transform: uppercase;
    color: var(--muted, #6b7280); margin: 0 0 6px;
    letter-spacing: 0.04em;
  }}
  #cs4g-filters .filters-counter {{
    margin-left: auto; display: inline-flex; align-items: center;
    gap: 3px; font-weight: 600; color: #111;
    font-variant-numeric: tabular-nums; text-transform: none;
    letter-spacing: 0;
  }}
  #cs4g-filters .row {{
    display: flex; align-items: center; gap: 6px;
    margin-bottom: 4px; font-size: 12px; flex-wrap: wrap;
  }}
  #cs4g-filters label.toggle {{
    display: inline-flex; align-items: center; gap: 4px;
    cursor: pointer; user-select: none;
  }}

  /* Subtitle injected right after the sidebar ``<h1>`` to advertise the
     overflow-graph execution time. The React parent pushes the value via
     ``cs4g:overflow-meta``; the overlay JS creates / updates the node so
     the upstream HTML template stays untouched. */
  #cs4g-overflow-meta {{
    margin: 0 0 8px; padding: 0;
    color: var(--muted, #6b7280);
    font-size: 11px; font-style: italic;
    font-variant-numeric: tabular-nums;
  }}
  #cs4g-overflow-meta strong {{
    font-style: normal; font-weight: 600;
    color: #111;
  }}

  /* ===== Dark theme =====
     Engaged when the React parent posts a ``cs4g:theme`` message and
     the overlay script sets ``<html data-cs4g-theme="dark">``. The
     upstream alphaDeesp viewer drives its palette through CSS custom
     properties (``--border`` / ``--muted`` / …) with light fallbacks,
     so we mostly redefine those + flip the structural surfaces. The
     graphviz canvas is a white background <polygon> — repaint it dark
     so the colour-coded nodes / edges pop. Node/edge label text stays
     as-authored (it sits on light node fills). */
  html[data-cs4g-theme="dark"] {{
    --bg: #0c0f13; --panel: #1b1f24; --border: #3a4049;
    --muted: #9aa1ab; --text: #e6e8eb;
    background: #0c0f13;
    color-scheme: dark;
  }}
  html[data-cs4g-theme="dark"] body {{
    background: #0c0f13 !important;
    color: #e6e8eb !important;
  }}
  html[data-cs4g-theme="dark"] #sidebar {{
    background: #1b1f24 !important;
    color: #e6e8eb !important;
    border-color: #3a4049 !important;
  }}
  html[data-cs4g-theme="dark"] #stage {{
    background: #0c0f13 !important;
  }}
  /* Graphviz emits the canvas (and edge-label backgrounds, e.g. a flow
     "%…" chip) as white-filled shapes. Repaint them dark. Attribute
     matching is case-insensitive (`i`) because graphviz may emit
     `#FFFFFF` / `WHITE` / `#fff`, and covers both <polygon> and <rect>. */
  html[data-cs4g-theme="dark"] #stage svg > g > polygon:first-of-type,
  html[data-cs4g-theme="dark"] #stage svg polygon[fill="#ffffff" i],
  html[data-cs4g-theme="dark"] #stage svg polygon[fill="#fff" i],
  html[data-cs4g-theme="dark"] #stage svg polygon[fill="white" i],
  html[data-cs4g-theme="dark"] #stage svg rect[fill="#ffffff" i],
  html[data-cs4g-theme="dark"] #stage svg rect[fill="#fff" i],
  html[data-cs4g-theme="dark"] #stage svg rect[fill="white" i] {{
    fill: #0c0f13 !important;
  }}
  html[data-cs4g-theme="dark"] a {{ color: #60a5fa !important; }}
  html[data-cs4g-theme="dark"] input,
  html[data-cs4g-theme="dark"] select,
  html[data-cs4g-theme="dark"] textarea {{
    background: #232830 !important; color: #e6e8eb !important;
    border-color: #3a4049 !important;
  }}
  /* The sidebar "SELECTION" info box (and any similar white panel)
     renders on a hard white background that flashes on the dark UI.
     Darken it. Best-effort selectors — the upstream viewer's exact id
     varies, so we cover the common shapes (pre/textarea + any element
     whose id/class mentions "selection"/"info"). */
  html[data-cs4g-theme="dark"] #sidebar pre,
  html[data-cs4g-theme="dark"] #sidebar [id*="selection" i],
  html[data-cs4g-theme="dark"] #sidebar [class*="selection" i],
  html[data-cs4g-theme="dark"] #sidebar [id*="info" i],
  html[data-cs4g-theme="dark"] #sidebar [class*="info" i] {{
    background: #232830 !important; color: #e6e8eb !important;
    border-color: #3a4049 !important;
  }}
  html[data-cs4g-theme="dark"] #cs4g-filters .filters-counter,
  html[data-cs4g-theme="dark"] #cs4g-overflow-meta strong {{
    color: #e6e8eb !important;
  }}

  /* --- Graphviz edge legibility on the dark canvas ---
     Edges live in <g class="edge"> (path = the line, polygon = the
     arrowhead, text = the flow-value label). Scope every rule to
     `g.edge` so node ellipses / their labels are never touched. */
  /* Flow-value labels → light ink (their white background <polygon>
     is already repainted dark by the white-polygon rule above). */
  html[data-cs4g-theme="dark"] #stage svg g.edge text {{
    fill: #e6e8eb !important;
  }}
  /* "Null redispatch" grey edges are near-invisible on dark → lighten
     the line + its arrowhead toward white. */
  html[data-cs4g-theme="dark"] #stage svg g.edge path[stroke="grey"],
  html[data-cs4g-theme="dark"] #stage svg g.edge path[stroke="gray"],
  html[data-cs4g-theme="dark"] #stage svg g.edge path[stroke="#808080"],
  html[data-cs4g-theme="dark"] #stage svg g.edge path[stroke="#999999"],
  html[data-cs4g-theme="dark"] #stage svg g.edge path[stroke="#cccccc"],
  html[data-cs4g-theme="dark"] #stage svg g.edge path[stroke="#c0c0c0"] {{
    stroke: #e6e8eb !important;
  }}
  html[data-cs4g-theme="dark"] #stage svg g.edge polygon[fill="grey"],
  html[data-cs4g-theme="dark"] #stage svg g.edge polygon[fill="gray"],
  html[data-cs4g-theme="dark"] #stage svg g.edge polygon[fill="#808080"],
  html[data-cs4g-theme="dark"] #stage svg g.edge polygon[fill="#999999"],
  html[data-cs4g-theme="dark"] #stage svg g.edge polygon[fill="#cccccc"],
  html[data-cs4g-theme="dark"] #stage svg g.edge polygon[fill="#c0c0c0"] {{
    fill: #e6e8eb !important;
    stroke: #e6e8eb !important;
  }}
  /* "Overload" edges are drawn black → invisible on dark; repaint red. */
  html[data-cs4g-theme="dark"] #stage svg g.edge path[stroke="black"],
  html[data-cs4g-theme="dark"] #stage svg g.edge path[stroke="#000000"] {{
    stroke: #ef4444 !important;
  }}
  html[data-cs4g-theme="dark"] #stage svg g.edge polygon[fill="black"],
  html[data-cs4g-theme="dark"] #stage svg g.edge polygon[fill="#000000"] {{
    fill: #ef4444 !important;
    stroke: #ef4444 !important;
  }}
</style>
<script id="cs4g-overlay-script">
(function() {{
  // ---- Shared glyph builder (inlined from frontend/src/utils/svg/pinGlyph.js)
  // The shared module defines its own private ``const SVG_NS`` at the
  // top of its body — we re-use that here rather than re-declaring it
  // (a duplicate ``const`` would be a parse error and silently disable
  // the entire overlay script).
{pin_glyph_js}
  // ---- /shared

  // Last-known pin payload — re-rendered whenever pin state changes.
  let lastPins = [];
  let lastVisible = false;

  // Last-known Action-Overview filter state (sent by the parent
  // every time it changes). The iframe never reads filter state
  // anywhere else — it just renders the threshold / show-unsimulated
  // / combined-only controls and posts user changes back. The
  // severity (action-card colour) and action-type buckets are NOT
  // editable here anymore — they are kept on ``filterState`` only so
  // the round-trip back to the parent leaves them untouched. The
  // actual pin filtering happens in the React parent
  // (``buildOverflowPinPayload``).
  let filterState = {{
    categories: {{ green: true, orange: true, red: true, grey: true }},
    threshold: 1.5,
    showUnsimulated: false,
    actionType: 'all',
    showCombinedOnly: false,
  }};

  function postFilters() {{
    window.parent.postMessage({{
      type: 'cs4g:overflow-filter-changed',
      filters: filterState,
    }}, '*');
  }}

  function buildFiltersPanel() {{
    const sidebar = document.getElementById('sidebar');
    if (!sidebar) return null;
    let panel = document.getElementById('cs4g-filters');
    if (panel) return panel;
    panel = document.createElement('section');
    panel.id = 'cs4g-filters';
    panel.innerHTML =
      '<div class="filters-header">'
      +   '<label class="pins-toggle" title="Show / hide action pins on the overflow graph">'
      +     '<input type="checkbox" data-pins-toggle />'
      +     '<span aria-hidden>\U0001F4CC</span>'
      +     '<span>Action pins filters</span>'
      +   '</label>'
      +   '<span class="filters-counter" data-counter title="Pins currently rendered (or, when the toggle is off, the count of pins that would be displayed).">'
      +     '<span aria-hidden>\U0001F4CC</span>'
      +     '<span data-counter-value>0</span>'
      +   '</span>'
      + '</div>'
      + '<div class="row toggles">'
      +   '<label class="toggle">'
      +     '<input type="checkbox" data-filter="show-unsimulated" />'
      +     '<span style="color:#6b7280">Show unsimulated</span>'
      +   '</label>'
      +   '<label class="toggle" title="Show only pins related to combined actions (computed pairs). Constituents stay on the graph dimmed for context.">'
      +     '<input type="checkbox" data-filter="combined-only" />'
      +     '<span style="color:#6b7280">Combined only</span>'
      +   '</label>'
      + '</div>';
    // Append to the END of the sidebar so the filter panel reads as
    // a distinct "pin-scoped" widget that follows the existing
    // graph-layer toggles, rather than competing for top-of-list
    // attention before the operator has even enabled pins.
    sidebar.appendChild(panel);
    // Pins on/off toggle — the canonical control for showing the pin
    // overlay. The parent React app remains the source of truth for
    // overflowPinsEnabled: the toggle posts an outbound message so the
    // parent flips its own state, and the inbound ``cs4g:pins`` echo
    // brings the UI back in sync (single round-trip, no local
    // divergence).
    const pinsToggle = panel.querySelector('input[data-pins-toggle]');
    pinsToggle.addEventListener('change', function(ev) {{
      window.parent.postMessage({{
        type: 'cs4g:overflow-pins-toggled',
        enabled: !!ev.target.checked,
      }}, '*');
    }});
    // The Max-loading threshold control moved into the parent React
    // app's ActionFilterRings strip — the iframe still receives the
    // threshold value through the ``cs4g:filters`` envelope (and
    // applies it for pin filtering) but no longer renders a control
    // for it inside the sidebar.
    // Show-unsimulated checkbox.
    const showU = panel.querySelector('input[data-filter="show-unsimulated"]');
    showU.addEventListener('change', function(ev) {{
      filterState = {{ ...filterState, showUnsimulated: !!ev.target.checked }};
      renderFilterState(); postFilters();
    }});
    // Combined-only checkbox — mirrors the React Action Overview's
    // "Combined only" toggle. The pin filtering itself is done in the
    // parent React app (``buildOverflowPinPayload``); the iframe just
    // posts the new flag so the parent recomputes the payload and
    // re-broadcasts pins.
    const combinedOnly = panel.querySelector('input[data-filter="combined-only"]');
    combinedOnly.addEventListener('change', function(ev) {{
      filterState = {{ ...filterState, showCombinedOnly: !!ev.target.checked }};
      renderFilterState(); postFilters();
    }});
    return panel;
  }}

  function renderFilterState() {{
    const panel = document.getElementById('cs4g-filters');
    if (!panel) return;
    // Reflect the pins on/off state on the toggle + on the panel
    // attribute that drives the disabled styling of the underlying
    // filter rows (see ``[data-pins-enabled="false"]`` CSS rules).
    const pinsToggle = panel.querySelector('input[data-pins-toggle]');
    if (pinsToggle) pinsToggle.checked = !!lastVisible;
    panel.setAttribute('data-pins-enabled', lastVisible ? 'true' : 'false');
    const showU = panel.querySelector('input[data-filter="show-unsimulated"]');
    if (showU) {{
      showU.checked = !!filterState.showUnsimulated;
      showU.disabled = !lastVisible;
    }}
    const combinedOnly = panel.querySelector('input[data-filter="combined-only"]');
    if (combinedOnly) {{
      combinedOnly.checked = !!filterState.showCombinedOnly;
      combinedOnly.disabled = !lastVisible;
    }}
  }}

  function updatePinCounter(count) {{
    const panel = document.getElementById('cs4g-filters');
    if (!panel) return;
    // When pins are off the counter advertises the displayable count
    // (i.e. how many pins WOULD render if the toggle were on), so the
    // operator sees at a glance whether enabling the overlay is worth
    // it. When on, the counter reflects the actually-drawn count.
    const shown = lastVisible ? count : (Array.isArray(lastPins) ? lastPins.length : 0);
    const v = panel.querySelector('[data-counter-value]');
    if (v) v.textContent = String(shown);
  }}

  function getSvg() {{
    return document.querySelector('#stage svg');
  }}
  function getRoot(svg) {{
    if (!svg) return null;
    return svg.querySelector('g.graph') || svg.querySelector('g') || svg;
  }}

  // Pin layer lives INSIDE the ``g.graph`` group so it inherits the
  // graphviz transform (graphviz emits ``transform="scale(…) translate(…)"``
  // on ``g.graph``). Without this, ``getBBox()`` coordinates from a
  // ``.node`` would be in the graph's local space but pin coordinates
  // would render against the outer SVG's viewport, leaving pins
  // floating above / outside the actual graph.
  function ensureLayer() {{
    const root = getRoot(getSvg());
    if (!root) return null;
    let layer = root.querySelector('g.cs4g-pin-layer');
    if (!layer) {{
      layer = document.createElementNS(SVG_NS, 'g');
      layer.setAttribute('class', 'cs4g-pin-layer');
      // Append last so pins draw on top of nodes / edges.
      root.appendChild(layer);
    }}
    return layer;
  }}

  // Project a point in a node's local space into the layer's space
  // by composing CTMs. Returns null if either CTM is unavailable.
  function projectToLayer(node, layer, lx, ly) {{
    if (!node.getCTM || !layer.getCTM) return null;
    const nodeCTM = node.getCTM();
    const layerCTM = layer.getCTM();
    if (!nodeCTM || !layerCTM) return null;
    const m = layerCTM.inverse().multiply(nodeCTM);
    return {{
      x: m.a * lx + m.c * ly + m.e,
      y: m.b * lx + m.d * ly + m.f,
    }};
  }}

  // Anchor a pin at the midpoint of the edge whose ``data-attr-name``
  // matches one of the candidate line names. This mirrors the Action
  // Overview NAD pin's edge-midpoint anchor for branch actions —
  // disco / reco / max_rho_line all land on the line's middle, not
  // on either endpoint.
  //
  // Graphviz draws each edge as a quadratic / cubic Bézier ``<path>``;
  // the *visual* midpoint of that curve is generally NOT the geometric
  // midpoint between the two endpoint nodes (e.g. parallel edges,
  // bundled lines, or any edge that bows around an obstacle). We use
  // the SVG DOM ``getTotalLength()`` / ``getPointAtLength()`` to land
  // exactly on the half-way point of the rendered path, projected into
  // the overlay layer's coordinate system. Falls back to the
  // bbox-midpoint of the source/target nodes when the path query
  // fails — same behaviour as before.
  function edgeCentre(lineNames, layer) {{
    const root = getRoot(getSvg());
    if (!root || !lineNames || !lineNames.length) return null;
    for (const name of lineNames) {{
      if (typeof name !== 'string' || !name) continue;
      const safe = (window.CSS && CSS.escape) ? CSS.escape(name) : name.replace(/(["\\\\])/g, '\\\\$1');
      const edge = root.querySelector('.edge[data-attr-name="' + safe + '"]');
      if (!edge) continue;

      // Preferred path: walk the actual edge path's mid-arc.
      const path = edge.querySelector('path');
      if (path && typeof path.getTotalLength === 'function'
          && typeof path.getPointAtLength === 'function') {{
        try {{
          const total = path.getTotalLength();
          if (total > 0 && Number.isFinite(total)) {{
            const pt = path.getPointAtLength(total / 2);
            if (pt && Number.isFinite(pt.x) && Number.isFinite(pt.y)) {{
              const projected = projectToLayer(path, layer, pt.x, pt.y);
              if (projected) {{
                return {{ x: projected.x, y: projected.y, ref: null }};
              }}
            }}
          }}
        }} catch (e) {{
          // Fall through to bbox-midpoint fallback below.
        }}
      }}

      // Fallback: midpoint between the two endpoint NODE bbox
      // centres. Used when the edge has no <path> child or the
      // browser's path-length APIs are unavailable.
      const src = edge.getAttribute('data-source');
      const tgt = edge.getAttribute('data-target');
      if (!src || !tgt) continue;
      const safeSrc = (window.CSS && CSS.escape) ? CSS.escape(src) : src;
      const safeTgt = (window.CSS && CSS.escape) ? CSS.escape(tgt) : tgt;
      const srcNode = root.querySelector('.node[data-name="' + safeSrc + '"]');
      const tgtNode = root.querySelector('.node[data-name="' + safeTgt + '"]');
      if (!srcNode || !tgtNode) continue;
      try {{
        const sb = srcNode.getBBox();
        const tb = tgtNode.getBBox();
        const sp = projectToLayer(srcNode, layer,
          sb.x + sb.width / 2, sb.y + sb.height / 2);
        const tp = projectToLayer(tgtNode, layer,
          tb.x + tb.width / 2, tb.y + tb.height / 2);
        if (!sp || !tp) continue;
        return {{
          x: (sp.x + tp.x) / 2,
          y: (sp.y + tp.y) / 2,
          ref: sb,
        }};
      }} catch (e) {{
        continue;
      }}
    }}
    return null;
  }}

  // Anchor a pin on the centre of the matching node group. ``names``
  // is an ordered list of candidate ``data-name`` values — the
  // substation first, then any voltage-level ids the action targets,
  // so we still find an anchor when the recommender emits a VL-keyed
  // overflow graph rather than a substation-keyed one.
  //
  // ``getBBox()`` returns the node's local-space bounding box —
  // BEFORE the node's own ``transform="translate(...)"`` is applied.
  // Graphviz emits per-node translate transforms, so we must compose
  // the node's CTM with the inverse of the layer's CTM to project
  // the bbox centre into the layer's coordinate system. Otherwise
  // every pin would land at (0, 0) of the graph and stack on top of
  // each other behind the background polygon.
  function nodeCentre(names, layer) {{
    const root = getRoot(getSvg());
    if (!root || !names || !names.length) return null;
    for (const name of names) {{
      if (typeof name !== 'string' || !name) continue;
      const safe = (window.CSS && CSS.escape) ? CSS.escape(name) : name.replace(/(["\\\\])/g, '\\\\$1');
      const node = root.querySelector('.node[data-name="' + safe + '"]');
      if (!node) continue;
      try {{
        const bb = node.getBBox();
        // Pin tip lands at the TOP of the node so the body floats
        // above instead of overlapping the label.
        const projected = projectToLayer(
          node, layer,
          bb.x + bb.width / 2, bb.y,
        );
        if (projected) {{
          return {{ x: projected.x, y: projected.y, ref: bb }};
        }}
        return {{ x: bb.x + bb.width / 2, y: bb.y, ref: bb }};
      }} catch (e) {{
        continue;
      }}
    }}
    return null;
  }}

  // Pick a global pin radius by sampling the FIRST visible node.
  // The bbox is in node-local space; we scale it through the layer's
  // CTM so the radius is expressed in the same coordinate system as
  // the centre we just computed. Cached because every node in a
  // graphviz dot output uses the same shape size class.
  let cachedR = null;
  function basePinRadius(layer) {{
    if (cachedR !== null) return cachedR;
    const root = getRoot(getSvg());
    if (!root) return 14;
    const node = root.querySelector('.node');
    if (!node) return 14;
    try {{
      const bb = node.getBBox();
      let r = Math.min(bb.width, bb.height) * 0.55;
      if (layer && node.getCTM && layer.getCTM) {{
        const nodeCTM = node.getCTM();
        const layerCTM = layer.getCTM();
        if (nodeCTM && layerCTM) {{
          const m = layerCTM.inverse().multiply(nodeCTM);
          // Uniform scale factor (graphviz transforms are
          // axis-aligned scale + translate, so |a| ~= |d|).
          const scale = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1;
          r = r * scale;
        }}
      }}
      cachedR = Math.max(8, r);
    }} catch (e) {{
      cachedR = 14;
    }}
    return cachedR;
  }}

  // Delay used to distinguish a single click from the first click of
  // a double click. Mirrors PIN_SINGLE_CLICK_DELAY_MS in
  // ``actionPinRender.ts`` so both pin layers feel identical.
  const SINGLE_CLICK_DELAY_MS = 250;

  function buildPin(pin, centre, layer) {{
    const r = basePinRadius(layer);
    const isUnsim = !!pin.unsimulated;
    // Reuse the SHARED action-overview glyph builder — same SVG
    // shape, palette, chrome and status symbols. Un-simulated pins
    // ride the ``dimmed`` flag so the body uses the dimmed palette,
    // matching the Action Overview's renderUnsimulatedPin.
    const g = createPinGlyph(document, {{
      severity: pin.severity,
      label: pin.label,
      // Use the explicit ``title`` field when the parent provided
      // one (e.g. multi-line score / rank / MW-start summary for
      // un-simulated pins) so the native <title> tooltip carries
      // the same content as the Action Overview NAD pin. Falls
      // back to the action id for simulated pins.
      title: (typeof pin.title === 'string' && pin.title)
        ? pin.title
        : pin.actionId,
      actionId: pin.actionId,
      isSelected: !!pin.isSelected,
      isRejected: !!pin.isRejected,
      dimmed: isUnsim,
      r: r,
    }});
    g.setAttribute('transform', 'translate(' + centre.x + ' ' + centre.y + ')');
    if (isUnsim) {{
      // Match the Action-Overview unsimulated pin's visual:
      // dashed outline + reduced opacity + ``data-unsimulated``
      // sentinel so unit tests can disambiguate the two layers.
      g.setAttribute('data-unsimulated', 'true');
      g.setAttribute('opacity', '0.5');
      const path = g.querySelector('path');
      if (path) {{
        path.setAttribute('stroke', '#1f2937');
        path.setAttribute('stroke-width', String(r * 0.08));
        path.setAttribute('stroke-dasharray',
          String(r * 0.35) + ' ' + String(r * 0.2));
      }}
    }}

    // Single click vs double click are debounced — exactly the same
    // pattern used by the Action Overview pins. Single click posts
    // ``cs4g:pin-clicked`` (parent focuses the feed card) AFTER the
    // 250 ms timer; double click cancels the timer and posts
    // ``cs4g:pin-double-clicked`` (parent opens the SLD on its
    // action sub-tab). Without this, the click handler would always
    // run before dblclick, switching the React tab and preventing
    // the SLD overlay from materialising on the right tab.
    let clickTimer = null;
    g.addEventListener('click', function(ev) {{
      ev.stopPropagation();
      if (clickTimer !== null) return;
      // Capture the pin's screen-pixel rect at click time so the
      // parent React app can position the floating action-card
      // popover next to the pin (same UX as the Action Overview
      // pin). Coordinates are iframe-screen pixels; the parent
      // adds the iframe's own offset to convert to parent-screen.
      const rect = g.getBoundingClientRect();
      const rectPayload = {{
        left: rect.left, top: rect.top,
        width: rect.width, height: rect.height,
      }};
      clickTimer = setTimeout(function() {{
        clickTimer = null;
        window.parent.postMessage({{
          type: 'cs4g:pin-clicked',
          actionId: pin.actionId,
          screenRect: rectPayload,
        }}, '*');
      }}, SINGLE_CLICK_DELAY_MS);
    }});
    g.addEventListener('dblclick', function(ev) {{
      ev.stopPropagation();
      ev.preventDefault();
      if (clickTimer !== null) {{
        clearTimeout(clickTimer);
        clickTimer = null;
      }}
      // Un-simulated pins kick off a manual simulation rather than
      // open the SLD overlay. Mirrors the Action Overview's
      // ``onUnsimulatedPinDoubleClick`` path.
      if (isUnsim) {{
        window.parent.postMessage({{
          type: 'cs4g:overflow-unsimulated-pin-double-clicked',
          actionId: pin.actionId,
        }}, '*');
      }} else {{
        window.parent.postMessage({{
          type: 'cs4g:pin-double-clicked',
          actionId: pin.actionId,
          substation: pin.substation
        }}, '*');
      }}
    }});
    return g;
  }}

  // Fan out pins that resolved to (almost) the same anchor so they
  // don't stack on top of each other. Mirrors ``fanOutColocatedPins``
  // in ``frontend/src/utils/svg/actionPinData.ts`` — same hash key
  // (round to 0.01) and same evenly-spaced angular fan starting at
  // the top.  Mutates the ``positions`` map in place.
  function fanOutColocated(positions, baseR) {{
    const offsetRadius = (baseR || 14) * 1.6;
    const groups = new Map();
    for (const [id, p] of positions) {{
      const key = Math.round(p.x * 100) + ':' + Math.round(p.y * 100);
      const arr = groups.get(key);
      if (arr) arr.push(id);
      else groups.set(key, [id]);
    }}
    for (const ids of groups.values()) {{
      if (ids.length < 2) continue;
      const angleStep = (2 * Math.PI) / ids.length;
      ids.forEach((id, i) => {{
        const angle = -Math.PI / 2 + i * angleStep;
        const p = positions.get(id);
        positions.set(id, {{
          x: p.x + offsetRadius * Math.cos(angle),
          y: p.y + offsetRadius * Math.sin(angle),
          ref: p.ref,
        }});
      }});
    }}
  }}

  // Quadratic-Bézier midpoint identical to ``curveMidpoint`` in
  // ``actionPinData.ts``: control point offset perpendicular to the
  // chord by ``dist * offsetFraction``, midpoint at t=0.5.
  function combinedCurveMidpoint(p1, p2, offsetFraction) {{
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    const f = (typeof offsetFraction === 'number') ? offsetFraction : 0.3;
    const ctrlX = (p1.x + p2.x) / 2 + (-dy / dist) * dist * f;
    const ctrlY = (p1.y + p2.y) / 2 + (dx / dist) * dist * f;
    const t = 0.5;
    const midX = (1 - t) * (1 - t) * p1.x + 2 * t * (1 - t) * ctrlX + t * t * p2.x;
    const midY = (1 - t) * (1 - t) * p1.y + 2 * t * (1 - t) * ctrlY + t * t * p2.y;
    return {{ ctrlX: ctrlX, ctrlY: ctrlY, midX: midX, midY: midY }};
  }}

  // The shared ``pinGlyph.js`` block above already declares
  // ``const SEVERITY_FILL`` at the top of this same IIFE
  // (pinGlyph.js:33). Re-declaring it here was a duplicate
  // ``const`` and the JS engine threw ``Identifier 'SEVERITY_FILL'
  // has already been declared`` at parse time, silently disabling
  // the entire overlay script — every pin disappeared from the
  // graph in 0.7.0 until this duplicate was removed. We reuse the
  // upstream constant for the dashed connector curve between a
  // combined pin and its unitary constituents.

  function render() {{
    const layer = ensureLayer();
    if (!layer) return;
    while (layer.firstChild) layer.removeChild(layer.firstChild);
    cachedR = null;  // Re-sample radius after every render.
    if (!(lastVisible && lastPins.length)) {{
      updatePinCounter(0);
      return;
    }}

    // Pass 1 — split unitary vs combined and resolve each unitary
    // pin's anchor (edge mid-arc preferred, node fallback).
    const baseR = basePinRadius(layer);
    const unitary = [];
    const combined = [];
    const positions = new Map();   // pin.actionId -> position record
    for (const pin of lastPins) {{
      if (pin && pin.isCombined && pin.action1Id && pin.action2Id) {{
        combined.push(pin);
        continue;
      }}
      let centre = null;
      if (Array.isArray(pin.lineNames) && pin.lineNames.length) {{
        centre = edgeCentre(pin.lineNames, layer);
      }}
      if (!centre) {{
        const candidates = [pin.substation].concat(
          Array.isArray(pin.nodeCandidates) ? pin.nodeCandidates : []
        );
        centre = nodeCentre(candidates, layer);
      }}
      if (!centre) continue;
      positions.set(pin.actionId, centre);
      unitary.push(pin);
    }}

    // Pass 2 — fan out colocated pins so duplicates don't occlude
    // each other. Same rule the Action Overview applies via
    // ``fanOutColocatedPins``.
    fanOutColocated(positions, baseR);

    // NB. The Action-Overview pin layer does NOT auto-dim the
    // unitary constituents of a combined pin — dimming there is
    // driven exclusively by the active filter (severity category /
    // max-loading threshold / action-type chip). We follow the same
    // contract here: a unitary pin's opacity is the filter pipeline's
    // job, not the combined-pin renderer's. The previous auto-dim
    // pass that lived here was removed so an operator can read the
    // constituent's own loading rate at full strength even while a
    // combined pair is highlighted.

    let drawn = 0;
    const svgNs = 'http://www.w3.org/2000/svg';

    // Render combined-pin dashed connectors first so the unitary
    // pins draw on top of the curve at its endpoints. Each iteration
    // is wrapped in try/catch so a single malformed combined pin
    // can't abort the whole render — the unitary loop below MUST
    // always run, otherwise selecting a combined action would
    // silently erase every pin from the graph.
    for (const cp of combined) {{
      try {{
        const p1 = positions.get(cp.action1Id);
        const p2 = positions.get(cp.action2Id);
        if (!p1 || !p2) continue;
        const mid = combinedCurveMidpoint(p1, p2, 0.3);
        const stroke = SEVERITY_FILL[cp.severity] || SEVERITY_FILL.grey;
        const sw = Math.max(2, baseR * 0.18);

        const curve = document.createElementNS(svgNs, 'path');
        curve.setAttribute('class', 'cs4g-overflow-combined-curve');
        curve.setAttribute('d',
          'M ' + p1.x + ' ' + p1.y +
          ' Q ' + mid.ctrlX + ' ' + mid.ctrlY +
          ' ' + p2.x + ' ' + p2.y);
        curve.setAttribute('fill', 'none');
        curve.setAttribute('stroke', stroke);
        curve.setAttribute('stroke-width', String(sw));
        curve.setAttribute('stroke-dasharray', String(sw * 2.5) + ' ' + String(sw * 1.5));
        curve.setAttribute('stroke-linecap', 'round');
        curve.setAttribute('pointer-events', 'none');
        curve.setAttribute('opacity', '0.85');
        layer.appendChild(curve);

        // Combined pin sits at the curve midpoint. Wrap as a normal
        // pin descriptor so ``buildPin`` reuses the click / dblclick
        // semantics — the parent receives ``cs4g:pin-clicked`` /
        // ``cs4g:pin-double-clicked`` keyed on the pair id.
        const pinDesc = {{
          actionId: cp.actionId,
          substation: cp.substation || '',
          label: cp.label,
          severity: cp.severity,
          title: cp.title || cp.actionId,
          isSelected: !!cp.isSelected,
          isRejected: !!cp.isRejected,
        }};
        const g = buildPin(pinDesc, {{ x: mid.midX, y: mid.midY }}, layer);
        g.setAttribute('data-combined-pair', '1');

        // "+" badge on top of the body, mirroring renderCombinedPin
        // in ``actionPinRender.ts``. Falls back to appending on the
        // group itself when ``createPinGlyph`` doesn't expose a
        // ``.cs4g-pin-body`` inner group.
        const r = baseR;
        const tail = r * 0.9;
        const badgeCy = -r - tail - r * 0.95;
        const body = g.querySelector('.cs4g-pin-body') || g;
        const badge = document.createElementNS(svgNs, 'circle');
        badge.setAttribute('cx', '0');
        badge.setAttribute('cy', String(badgeCy));
        badge.setAttribute('r', String(r * 0.35));
        badge.setAttribute('fill', stroke);
        badge.setAttribute('stroke', 'white');
        badge.setAttribute('stroke-width', String(r * 0.06));
        badge.setAttribute('pointer-events', 'none');
        body.appendChild(badge);
        const plus = document.createElementNS(svgNs, 'text');
        plus.setAttribute('x', '0');
        plus.setAttribute('y', String(badgeCy));
        plus.setAttribute('text-anchor', 'middle');
        plus.setAttribute('dominant-baseline', 'central');
        plus.setAttribute('font-size', String(r * 0.5));
        plus.setAttribute('font-weight', '900');
        plus.setAttribute('font-family', 'system-ui, -apple-system, Arial, sans-serif');
        plus.setAttribute('fill', 'white');
        plus.setAttribute('pointer-events', 'none');
        plus.textContent = '+';
        body.appendChild(plus);

        layer.appendChild(g);
        drawn += 1;
      }} catch (e) {{
        // Combined-pin rendering must never block unitary pins.
      }}
    }}

    // Render unitary pins. Pins flagged ``dimmedByFilter`` by the
    // payload builder failed the active overview filter but were
    // kept on the wire because a passing combined-action pin
    // references them — render with reduced opacity so they read
    // as "context for the combined glyph" instead of as first-class
    // actions. Same contract as the ``dimmedByFilter`` branch in
    // ``renderUnitaryPin`` (frontend/src/utils/svg/actionPinRender.ts).
    for (const pin of unitary) {{
      try {{
        const centre = positions.get(pin.actionId);
        if (!centre) continue;
        const g = buildPin(pin, centre, layer);
        if (pin.dimmedByFilter && !pin.unsimulated) {{
          g.setAttribute('opacity', '0.35');
          g.setAttribute('data-dimmed-by-filter', 'true');
        }}
        layer.appendChild(g);
        drawn += 1;
      }} catch (e) {{
        // Skip the offending pin and keep rendering the rest.
      }}
    }}

    updatePinCounter(drawn);
  }}

  // The pins-filter panel is ALWAYS visible (the on/off toggle now
  // lives inside it), so syncFilterPanelVisibility was retired. Calls
  // that previously toggled the ``.visible`` class are replaced by a
  // single buildFiltersPanel() call that guarantees the section is
  // mounted before any state-sync runs.

  // Render / update the subtitle line that lives just below the
  // sidebar's ``<h1>`` filename. ``seconds`` may be a number (rendered
  // verbatim) or null / undefined (subtitle removed). The DOM mutation
  // is idempotent so re-broadcasting the same value is a no-op.
  function renderOverflowMeta(seconds) {{
    const sidebar = document.getElementById('sidebar');
    if (!sidebar) return;
    const heading = sidebar.querySelector('h1');
    if (!heading) return;
    let meta = document.getElementById('cs4g-overflow-meta');
    if (typeof seconds !== 'number' || !isFinite(seconds)) {{
      if (meta && meta.parentNode) meta.parentNode.removeChild(meta);
      return;
    }}
    if (!meta) {{
      meta = document.createElement('div');
      meta.id = 'cs4g-overflow-meta';
      // Place it as the immediate sibling after the <h1>.
      heading.parentNode.insertBefore(meta, heading.nextSibling);
    }}
    const formatted = seconds >= 10
      ? seconds.toFixed(1) + 's'
      : seconds.toFixed(2) + 's';
    meta.textContent = '';
    const label = document.createTextNode('Total execution time: ');
    const value = document.createElement('strong');
    value.textContent = formatted;
    meta.appendChild(label);
    meta.appendChild(value);
  }}

  window.addEventListener('message', function(ev) {{
    const msg = ev && ev.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'cs4g:filters' && msg.filters && typeof msg.filters === 'object') {{
      // Parent broadcasts the live overviewFilters value. We only
      // overwrite our local copy — the parent is the single source
      // of truth and re-emits this whenever its state changes.
      filterState = {{
        categories: {{
          green: !!msg.filters.categories?.green,
          orange: !!msg.filters.categories?.orange,
          red: !!msg.filters.categories?.red,
          grey: !!msg.filters.categories?.grey,
        }},
        threshold: typeof msg.filters.threshold === 'number'
          ? msg.filters.threshold : 1.5,
        showUnsimulated: !!msg.filters.showUnsimulated,
        actionType: typeof msg.filters.actionType === 'string'
          ? msg.filters.actionType : 'all',
        showCombinedOnly: !!msg.filters.showCombinedOnly,
      }};
      buildFiltersPanel();
      renderFilterState();
      return;
    }}
    if (msg.type === 'cs4g:overflow-meta') {{
      renderOverflowMeta(msg.overflowGraphTime);
      return;
    }}
    if (msg.type === 'cs4g:theme') {{
      // Parent broadcasts its light/dark theme. Flip a data attribute
      // on <html>; the dark CSS in the injected <style> keys off it.
      const t = msg.theme === 'dark' ? 'dark' : 'light';
      document.documentElement.setAttribute('data-cs4g-theme', t);
      return;
    }}
    if (msg.type !== 'cs4g:pins') return;
    lastVisible = !!msg.visible;
    if (Array.isArray(msg.pins)) lastPins = msg.pins;
    buildFiltersPanel();
    renderFilterState();
    render();
  }});

  // Notify the parent that the overlay is wired up so it can post
  // pins immediately rather than waiting for a poll.
  window.addEventListener('load', function() {{
    // The pins-filter panel hosts the on/off toggle and is always
    // visible — mount it on first paint so the operator finds the
    // control before any pin payload arrives.
    buildFiltersPanel();
    renderFilterState();
    window.parent.postMessage({{ type: 'cs4g:overlay-ready' }}, '*');
  }});
}})();
</script>
"""


def inject_overlay(html: str) -> str:
    """Splice the Co-Study4Grid overlay block before the closing
    ``</body>`` of an upstream alphaDeesp overflow-graph HTML.

    Idempotent: re-injection on an already-augmented file replaces the
    previous block (matched by its ``id`` attributes) so successive
    cache fetches do not accumulate duplicate listeners.

    Raises ``ValueError`` if the input lacks a ``</body>`` tag.
    """
    closing = "</body>"
    if closing not in html:
        raise ValueError(
            "Overflow HTML has no </body> tag — refusing to inject overlay."
        )

    # Strip any prior injection so a re-fetch of the same file doesn't
    # accumulate duplicate event listeners (cheap string match — both
    # blocks carry deterministic ids).
    for marker in ('<style id="cs4g-overlay-style">', '<script id="cs4g-overlay-script">'):
        start = html.find(marker)
        if start == -1:
            continue
        # Find the closing tag that matches the marker's element.
        end_tag = "</style>" if marker.startswith("<style") else "</script>"
        end = html.find(end_tag, start)
        if end == -1:
            continue
        html = html[:start] + html[end + len(end_tag):]

    # The overlay inlines pinGlyph.js (a frontend source file). If that file
    # is unavailable — e.g. a runtime image that ships only the built bundle —
    # degrade gracefully: serve the upstream viewer unchanged rather than 500.
    try:
        block = _build_overlay_block()
    except OSError:
        logger.warning(
            "pinGlyph.js unavailable — serving the overflow viewer without the "
            "Co-Study4Grid pin overlay."
        )
        return html
    return html.replace(closing, block + closing, 1)


__all__ = ["inject_overlay"]
