# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0

"""Unit tests for the Co-Study4Grid overflow-graph overlay injector and
the dynamic ``/results/pdf/{filename}`` route that serves it.

The overlay is plain string substitution by design (no HTML parser
dependency) — exercising it is therefore deterministic and fast.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from expert_backend.main import app
from expert_backend.services.overflow_overlay import inject_overlay


_BASE_HTML = (
    '<!doctype html><html><head><title>x</title></head>'
    '<body><div id="stage"><svg></svg></div></body></html>'
)


# ---------------------------------------------------------------------
# inject_overlay — pure-string injector
# ---------------------------------------------------------------------

class TestInjectOverlay:
    def test_injects_style_and_script_before_closing_body(self) -> None:
        out = inject_overlay(_BASE_HTML)
        # The original body content must still be there.
        assert '<div id="stage"><svg></svg></div>' in out
        # Both blocks must appear AND be positioned before </body>.
        style_at = out.find('<style id="cs4g-overlay-style">')
        script_at = out.find('<script id="cs4g-overlay-script">')
        body_close = out.find('</body>')
        assert 0 < style_at < body_close
        assert 0 < script_at < body_close

    def test_synthetic_grid_source_node_is_hidden(self) -> None:
        # The recommender injects a synthetic "__GRID_SOURCE__" upstream node
        # into an islanded-pocket ("antenne") overflow graph. It is a modelling
        # artifact and must be hidden by the viewer overlay CSS.
        out = inject_overlay(_BASE_HTML)
        assert '.node[data-name="__GRID_SOURCE__"]' in out
        assert '.edge[data-attr-name="__GRID_SOURCE__"]' in out

    def test_pin_message_listener_is_injected(self) -> None:
        out = inject_overlay(_BASE_HTML)
        assert "cs4g:pins" in out
        assert "cs4g:pin-clicked" in out
        assert "cs4g:overlay-ready" in out


class TestDarkTheme:
    """The overlay carries the dark-theme contract: a ``cs4g:theme``
    message handler that flips ``<html data-cs4g-theme>`` plus the CSS
    that keys off it (chrome surfaces + graphviz edge legibility)."""

    def test_theme_message_handler_sets_data_attribute(self) -> None:
        out = inject_overlay(_BASE_HTML)
        assert "cs4g:theme" in out
        # The handler must set the data attribute the dark CSS keys off.
        assert "data-cs4g-theme" in out
        assert "setAttribute('data-cs4g-theme'" in out

    def test_dark_chrome_surfaces_are_styled(self) -> None:
        out = inject_overlay(_BASE_HTML)
        # Body / sidebar / stage all get a dark surface under the theme.
        assert 'html[data-cs4g-theme="dark"] body' in out
        assert 'html[data-cs4g-theme="dark"] #sidebar' in out
        assert 'html[data-cs4g-theme="dark"] #stage' in out

    def test_white_graphviz_canvas_polygon_is_repainted_dark(self) -> None:
        out = inject_overlay(_BASE_HTML)
        assert 'polygon[fill="white" i]' in out
        assert 'polygon[fill="#ffffff" i]' in out
        # Case-insensitive + <rect> coverage so #FFFFFF / WHITE / a flow
        # "%…" label chip drawn as a <rect> are caught too.
        assert 'rect[fill="white" i]' in out

    def test_sidebar_selection_box_is_darkened(self) -> None:
        out = inject_overlay(_BASE_HTML)
        # The white "SELECTION" info panel must be retargeted dark.
        assert 'html[data-cs4g-theme="dark"] #sidebar [id*="selection" i]' in out
        assert 'html[data-cs4g-theme="dark"] #sidebar pre' in out

    def test_edge_flow_value_labels_are_lightened(self) -> None:
        out = inject_overlay(_BASE_HTML)
        assert 'html[data-cs4g-theme="dark"] #stage svg g.edge text' in out

    def test_grey_null_edges_are_lightened(self) -> None:
        out = inject_overlay(_BASE_HTML)
        # Both the line stroke and the arrowhead fill are retargeted.
        assert 'g.edge path[stroke="grey"]' in out
        assert 'g.edge polygon[fill="grey"]' in out

    def test_black_overload_edges_become_red(self) -> None:
        out = inject_overlay(_BASE_HTML)
        assert 'g.edge path[stroke="black"]' in out
        assert 'g.edge path[stroke="#000000"]' in out
        # The retarget colour is the danger red.
        assert "#ef4444" in out

    def test_edge_rules_are_scoped_to_edges_not_nodes(self) -> None:
        """Node ellipses must keep their authored colours — every edge
        recolour rule must be qualified by ``g.edge`` so a black node
        border or a white node fill is never caught."""
        out = inject_overlay(_BASE_HTML)
        for needle in ('path[stroke="black"]', 'polygon[fill="grey"]',
                       'g.edge text'):
            idx = out.find(needle)
            assert idx != -1
            # The selector segment leading up to the needle includes g.edge.
            seg_start = out.rfind('html[data-cs4g-theme="dark"]', 0, idx)
            assert 'g.edge' in out[seg_start:idx + len(needle)]

    def test_single_click_is_debounced_against_double_click(self) -> None:
        """The pin's click handler must defer firing
        ``cs4g:pin-clicked`` via a setTimeout so that a follow-up
        dblclick can cancel it. Without the debounce, a real
        double-click sequence (click, click, dblclick) would always
        fire the single-click first — that switched the React tab
        and prevented the dblclick from drilling into the SLD
        overlay."""
        out = inject_overlay(_BASE_HTML)
        # The setTimeout call gating the single click must be present.
        assert "SINGLE_CLICK_DELAY_MS" in out
        assert "setTimeout" in out
        # And the dblclick handler must clear that timer before
        # posting its own message.
        assert "clearTimeout(clickTimer)" in out

    def test_pin_double_click_listener_is_injected(self) -> None:
        """Pins must emit ``cs4g:pin-double-clicked`` carrying both
        the action id AND its substation, so the parent React app can
        open the SLD overlay on the post-action sub-tab for that
        substation."""
        out = inject_overlay(_BASE_HTML)
        assert "cs4g:pin-double-clicked" in out
        assert "actionId: pin.actionId" in out
        assert "substation: pin.substation" in out
        assert "addEventListener('dblclick'" in out

    def test_shared_pin_glyph_module_is_inlined(self) -> None:
        """``createPinGlyph`` and the severity palette must be
        present in the injected script — the iframe shares the
        rendering code with the React Action Overview pins by
        inlining ``frontend/src/utils/svg/pinGlyph.js``."""
        out = inject_overlay(_BASE_HTML)
        assert "function createPinGlyph(" in out
        assert "const SEVERITY_FILL" in out
        assert "const SEVERITY_FILL_HIGHLIGHTED" in out
        # ESM ``export`` keyword must have been stripped — the iframe
        # runtime is a bare <script> with no module loader.
        assert "export const SEVERITY_FILL" not in out
        assert "export function createPinGlyph" not in out

    def test_injected_script_parses_as_valid_js(self) -> None:
        """The whole overlay <script> must parse cleanly. A duplicate
        ``const`` (e.g. ``SVG_NS`` declared by both the inlined
        ``pinGlyph.js`` and the wrapper IIFE) silently disables every
        listener — no pins render, no postMessage handler. We use
        Python's bundled ``js2py``-free check by exercising the
        offset that pinGlyph.js sits in the script and asserting
        ``SVG_NS`` is declared exactly once."""
        out = inject_overlay(_BASE_HTML)
        # Extract the injected <script> body.
        m = re.search(
            r'<script id="cs4g-overlay-script">([\s\S]*?)</script>',
            out,
        )
        assert m, "no overlay <script> tag found"
        body = m.group(1)
        # The actual declaration must appear exactly once — if it's
        # duplicated the whole IIFE fails with ``Identifier 'SVG_NS'
        # has already been declared``. Match the assignment form
        # specifically so the wording-only mention in a comment
        # doesn't false-positive.
        decls = re.findall(r"^\s*const\s+SVG_NS\s*=", body, re.MULTILINE)
        assert len(decls) == 1, (
            f"const SVG_NS declared {len(decls)}× in overlay (must be 1)"
        )

    def test_overflow_meta_subtitle_handler_is_injected(self) -> None:
        """The overlay reacts to ``cs4g:overflow-meta`` envelopes by
        inserting / updating a ``#cs4g-overflow-meta`` subtitle right
        after the sidebar ``<h1>``. The React parent posts the message
        once the step-2 ``result`` event arrives — the overlay does the
        DOM mutation. Smoke-checks the message wiring + the DOM hook
        + the CSS hook are all in the injected block."""
        out = inject_overlay(_BASE_HTML)
        # Inbound wire-format constant.
        assert "cs4g:overflow-meta" in out
        # JS function name that owns the DOM mutation.
        assert "function renderOverflowMeta(" in out
        # The subtitle DOM hook.
        assert "id=\"cs4g-overflow-meta\"" in out or "'cs4g-overflow-meta'" in out
        # CSS rule for the subtitle.
        assert "#cs4g-overflow-meta" in out
        # User-facing label embedded in the JS body.
        assert "Total execution time:" in out

    def test_action_filters_section_is_injected(self) -> None:
        """The overlay must inject an ``Action pins filters`` section.
        The section is ALWAYS visible — it carries the canonical pins
        on/off toggle in its header, so it must be reachable before
        any pin has been requested. The severity (action-card colour)
        and action-type filters were removed — they are driven solely
        by the sidebar's ActionFilterRings — so this panel keeps only
        the threshold / show-unsimulated / combined-only controls."""
        out = inject_overlay(_BASE_HTML)
        # CSS hook + JS builder.
        assert "#cs4g-filters" in out
        assert "function buildFiltersPanel(" in out
        # The legacy ``.visible`` show/hide gate is gone — the panel
        # is always visible now that the pins toggle lives inside it.
        assert "#cs4g-filters.visible" not in out
        # Wire-format: outbound message type for filter changes.
        assert "cs4g:overflow-filter-changed" in out
        # Wire-format: inbound message type from the parent.
        assert "cs4g:filters" in out
        # Clear, action-pin-scoped header text.
        assert "Action pins filters" in out
        # Pin-counter UI surfaces the number of currently-rendered
        # pins, mirroring the Action Overview's pin counter.
        assert "data-counter-value" in out
        assert "function updatePinCounter(" in out
        # The retained controls.
        assert "Show unsimulated" in out
        # The removed severity / action-type / threshold controls
        # must be gone. The Max-loading threshold lives in the
        # parent React app's ActionFilterRings strip; the iframe
        # still receives the value via ``cs4g:filters`` but no
        # longer renders an input for it.
        assert "Max loading" not in out
        assert 'data-filter="threshold"' not in out
        assert "data-category=" not in out
        assert "data-action-type=" not in out
        assert 'data-action="select-all"' not in out

    def test_pins_toggle_lives_inside_filter_panel_header(self) -> None:
        """The pins on/off toggle was moved out of the React
        VisualizationPanel header into the iframe's filter-panel
        header so the operator can flip pins from the same widget
        that hosts the threshold / show-unsimulated / combined-only
        controls. The toggle posts ``cs4g:overflow-pins-toggled`` so
        the parent flips its own ``overflowPinsEnabled`` state."""
        out = inject_overlay(_BASE_HTML)
        # The toggle DOM element is built into the filters header.
        assert "data-pins-toggle" in out
        assert "pins-toggle" in out
        # Outbound message — parent flips overflowPinsEnabled.
        assert "cs4g:overflow-pins-toggled" in out
        # The parent React app remains the source of truth — toggle
        # posts up the change, doesn't mutate local state directly.
        assert "enabled: !!ev.target.checked" in out

    def test_filter_rows_disabled_when_pins_toggle_off(self) -> None:
        """When pins are off the remaining filter inputs render
        disabled so they can't be edited until the operator turns
        the overlay on. The ``data-pins-enabled`` attribute on the
        panel drives the CSS dim/disable rule; the JS sets the
        ``disabled`` attribute on each surviving input
        (show-unsimulated + combined-only — the Max-loading
        threshold widget moved to the React-side ActionFilterRings)."""
        out = inject_overlay(_BASE_HTML)
        # CSS hook for dim/disable when pins are off.
        assert '#cs4g-filters[data-pins-enabled="false"]' in out
        # JS reflects the pins state on the panel attribute + on the
        # disabled attr of each surviving filter input.
        assert "data-pins-enabled" in out
        # The threshold input no longer renders inside the iframe —
        # any leftover ``thr.disabled`` line would be dead code.
        assert "thr.disabled" not in out
        assert "showU.disabled = !lastVisible" in out
        assert "combinedOnly.disabled = !lastVisible" in out

    def test_pin_counter_shows_displayable_count_when_pins_off(self) -> None:
        """The counter must remain informative when pins are off — it
        shows the count of pins that WOULD render if the operator
        flipped the toggle on, so the operator can decide whether
        enabling pins is worth the visual cost."""
        out = inject_overlay(_BASE_HTML)
        # Counter falls back to lastPins.length when not visible.
        assert "lastVisible ? count : (Array.isArray(lastPins) ? lastPins.length : 0)" in out

    def test_action_filters_section_is_appended_below_existing_sections(self) -> None:
        """The pins filter panel is appended at the END of the
        sidebar so the existing layer toggles keep their top-of-list
        position. ``sidebar.appendChild`` is the sentinel."""
        out = inject_overlay(_BASE_HTML)
        assert "sidebar.appendChild(panel)" in out
        # And no longer inserted before the layers <h2>.
        assert "sidebar.insertBefore(panel, layersHeader)" not in out

    def test_filter_panel_does_not_render_a_threshold_input(self) -> None:
        """The Max-loading threshold control moved into the parent
        React app's ActionFilterRings strip — the iframe filter panel
        no longer renders a ``<input data-filter="threshold">``. The
        threshold value still travels through ``cs4g:filters`` (the
        iframe applies it for pin filtering) but the operator-facing
        widget lives elsewhere."""
        out = inject_overlay(_BASE_HTML)
        assert 'data-filter="threshold"' not in out
        # Operator-facing label is gone.
        assert "Max loading" not in out
        # The wire-format roundtrip ``filterState.threshold`` is
        # still parsed from the inbound ``cs4g:filters`` payload —
        # but no clamping / outbound math runs from the iframe side.
        assert "msg.filters.threshold" in out

    def test_filter_panel_show_unsimulated_checkbox(self) -> None:
        """The Show-unsimulated checkbox carries ``showUnsimulated``
        and round-trips boolean to / from the parent."""
        out = inject_overlay(_BASE_HTML)
        assert 'data-filter="show-unsimulated"' in out
        assert "showUnsimulated: !!ev.target.checked" in out
        assert "showUnsimulated: !!msg.filters.showUnsimulated" in out

    def test_filter_panel_combined_only_checkbox(self) -> None:
        """The Combined-only checkbox lets operators restrict the
        overflow graph to combined-action pins (computed pairs) plus
        their two constituents (dimmed for context). Mirrors the
        React Action Overview's ``showCombinedOnly`` filter so both
        surfaces stay in lock-step. Round-trips the boolean to / from
        the parent through the cs4g:filters envelope."""
        out = inject_overlay(_BASE_HTML)
        assert 'data-filter="combined-only"' in out
        # Outbound — user clicks the checkbox, iframe posts the new
        # filter state to the parent.
        assert "showCombinedOnly: !!ev.target.checked" in out
        # Inbound — parent broadcasts overviewFilters; the iframe
        # parses ``showCombinedOnly`` from the message and updates
        # its local mirror.
        assert "showCombinedOnly: !!msg.filters.showCombinedOnly" in out
        # Default value matches DEFAULT_ACTION_OVERVIEW_FILTERS.
        assert "showCombinedOnly: false," in out
        # The chip is rendered with a clear label.
        assert "Combined only" in out

    def test_filter_panel_pin_counter_starts_at_zero(self) -> None:
        """The injected counter element starts at 0 and is updated by
        ``updatePinCounter`` from the render loop after pin
        anchor-resolution — mirrors the Action Overview's
        ``overview-pin-counter``."""
        out = inject_overlay(_BASE_HTML)
        # Initial DOM string carries 0.
        assert "data-counter-value>0</span>" in out
        # The drawn counter is updated AFTER the pin loop.
        assert "updatePinCounter(drawn)" in out

    def test_filter_state_default_matches_action_overview(self) -> None:
        """The iframe's local default ``filterState`` matches
        ``DEFAULT_ACTION_OVERVIEW_FILTERS`` in ``actionTypes.ts``.
        If they drift, the iframe panel would briefly show the wrong
        chips on first paint before the parent's broadcast catches up."""
        out = inject_overlay(_BASE_HTML)
        # All four categories enabled.
        assert (
            "categories: { green: true, orange: true, red: true, grey: true }"
        ) in out
        # Threshold default 1.5 (mirrors DEFAULT_ACTION_OVERVIEW_FILTERS).
        assert "threshold: 1.5," in out
        # showUnsimulated false by default.
        assert "showUnsimulated: false," in out
        # actionType 'all' by default.
        assert "actionType: 'all'," in out
        # showCombinedOnly false by default — pin-only "combined
        # actions only" toggle (PR adding combined-only filter).
        assert "showCombinedOnly: false," in out

    def test_overlay_listens_for_parent_filter_broadcasts(self) -> None:
        """Bidirectional sync — the parent posts ``cs4g:filters``
        whenever its ``overviewFilters`` change. The iframe must
        accept that broadcast and replace its local state without
        echoing back (otherwise we'd loop)."""
        out = inject_overlay(_BASE_HTML)
        # The branch must NOT call postFilters — only render.
        # Look for the inbound branch and assert it returns BEFORE
        # posting back.
        m = re.search(
            r"if \(msg\.type === 'cs4g:filters'.*?return;",
            out, re.DOTALL,
        )
        assert m, "missing inbound cs4g:filters branch"
        body = m.group(0)
        assert "buildFiltersPanel()" in body
        assert "renderFilterState()" in body
        assert "postFilters" not in body, (
            "parent broadcast must NOT trigger an outbound "
            "cs4g:overflow-filter-changed echo"
        )

    def test_unsimulated_pins_get_dashed_stroke_and_dim_opacity(self) -> None:
        """Pins flagged ``unsimulated: true`` must render with a
        dashed outline + reduced opacity, mirroring the Action
        Overview's ``renderUnsimulatedPin`` visual."""
        out = inject_overlay(_BASE_HTML)
        assert "const isUnsim = !!pin.unsimulated;" in out
        # ``dimmed`` flag forwarded to the shared glyph factory so
        # the body fill uses the dimmed palette.
        assert "dimmed: isUnsim," in out
        # And the explicit dashed stroke + opacity overrides.
        assert "setAttribute('stroke-dasharray'," in out
        assert "setAttribute('opacity', '0.5')" in out
        assert "setAttribute('data-unsimulated', 'true')" in out

    def test_overlay_uses_pin_title_field_when_present(self) -> None:
        """The native ``<title>`` tooltip rendered inside each pin
        prefers the parent-supplied ``pin.title`` field over the bare
        action id. Un-simulated pins use this to surface the same
        multi-line score / rank / MW-start tooltip the Action
        Overview NAD pins show."""
        out = inject_overlay(_BASE_HTML)
        # The createPinGlyph call site reads pin.title with a fallback
        # to pin.actionId.
        assert "typeof pin.title === 'string' && pin.title" in out
        assert ": pin.actionId," in out

    def test_edge_midpoint_uses_getPointAtLength_on_curved_path(self) -> None:
        """Branch-action pins land on the actual visual midpoint of
        the curved graphviz edge path, NOT on the geometric mean of
        the two endpoint nodes. Without ``getPointAtLength`` a
        bow-shaped edge (parallel transformer, line skirting an
        obstacle) puts the pin off-curve.
        """
        out = inject_overlay(_BASE_HTML)
        # Preferred path uses the SVG ``<path>``'s mid-arc.
        assert "edge.querySelector('path')" in out
        assert "path.getTotalLength()" in out
        assert "path.getPointAtLength(total / 2)" in out
        # The bbox-midpoint formula remains as a fallback for paths
        # that don't expose getTotalLength (jsdom older builds).
        assert "(sp.x + tp.x) / 2" in out

    def test_combined_pin_curve_connector_is_injected(self) -> None:
        """Pins flagged ``isCombined: true`` cause the overlay to
        draw a dashed quadratic-Bézier connector between the two
        constituent unitary pins and place the combined pin at the
        curve midpoint, mirroring the Action Overview NAD's
        ``renderCombinedPin`` behaviour."""
        out = inject_overlay(_BASE_HTML)
        # Combined-pin branching is recognised in the render loop.
        assert "pin.isCombined && pin.action1Id && pin.action2Id" in out
        # Quadratic-Bézier midpoint helper mirroring curveMidpoint
        # in actionPinData.ts.
        assert "function combinedCurveMidpoint(p1, p2, offsetFraction)" in out
        # Dashed connector path with the SVG-quadratic ``Q ctrl`` form.
        assert "cs4g-overflow-combined-curve" in out
        assert "stroke-dasharray" in out
        # "+" badge mirroring the Action Overview's combined-pin badge.
        assert "plus.textContent = '+';" in out

    def test_combined_pin_does_not_auto_dim_unitary_constituents(self) -> None:
        """The Action-Overview pin layer applies dimming through the
        active filter pipeline (severity category / max-loading
        threshold / action-type chip), NOT as a side effect of a
        combined pair being present. The iframe overlay follows the
        same contract: the unitary render loop must NOT carry an
        automatic opacity / data-combined-constituent override —
        that would over-dim a constituent the operator explicitly
        kept above their loading threshold."""
        out = inject_overlay(_BASE_HTML)
        assert "dimmedConstituents" not in out
        assert "data-combined-constituent" not in out
        # The unitary render loop defers dimming to renderFilterState.
        assert "renderFilterState" in out

    def test_pins_fan_out_when_colocated(self) -> None:
        """Two pins resolving to the same anchor must be spread on a
        small circle around the anchor so they remain individually
        clickable. Mirrors ``fanOutColocatedPins`` in actionPinData.ts."""
        out = inject_overlay(_BASE_HTML)
        assert "function fanOutColocated(positions, baseR)" in out
        # Same hash key the Action Overview uses (round * 100).
        assert "Math.round(p.x * 100) + ':' + Math.round(p.y * 100)" in out
        assert "(2 * Math.PI) / ids.length" in out

    def test_unsimulated_pin_dblclick_kicks_off_manual_simulation(self) -> None:
        """Un-simulated pins do NOT open the SLD overlay on dblclick;
        they post a distinct message that the parent routes through
        ``onSimulateUnsimulatedAction`` instead."""
        out = inject_overlay(_BASE_HTML)
        assert "cs4g:overflow-unsimulated-pin-double-clicked" in out
        # The branch must be guarded by isUnsim (so simulated pins
        # still go through the normal SLD path).
        m = re.search(
            r"if \(isUnsim\) \{\s*window\.parent\.postMessage\(\{\s*"
            r"type:\s*'cs4g:overflow-unsimulated-pin-double-clicked'",
            out, re.DOTALL,
        )
        assert m, (
            "the unsimulated-dblclick post must be gated on isUnsim"
        )

    def test_pin_layer_lives_inside_graph_group(self) -> None:
        """The pin layer is appended to ``g.graph`` (which carries the
        graphviz transform) rather than the SVG root, so pin BBox
        coordinates from ``getBBox()`` line up with the rendered
        graph instead of floating outside it."""
        out = inject_overlay(_BASE_HTML)
        assert "cs4g-pin-layer" in out
        assert "root.appendChild(layer)" in out

    def test_dim_styling_classes_injected(self) -> None:
        out = inject_overlay(_BASE_HTML)
        assert ".cs4g-pin" in out
        assert "cs4g-pin-layer" in out

    def test_idempotent_re_injection_replaces_previous_block(self) -> None:
        once = inject_overlay(_BASE_HTML)
        twice = inject_overlay(once)
        # Exactly one occurrence of each id, even after a second pass.
        assert twice.count('<style id="cs4g-overlay-style">') == 1
        assert twice.count('<script id="cs4g-overlay-script">') == 1
        # Body content survived.
        assert '<div id="stage"><svg></svg></div>' in twice

    def test_raises_on_missing_body_tag(self) -> None:
        with pytest.raises(ValueError):
            inject_overlay("<html><head></head></html>")


# ---------------------------------------------------------------------
# /results/pdf/{filename} dynamic route
# ---------------------------------------------------------------------

@pytest.fixture()
def overflow_dir(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    """Redirect the route to a temp directory so the suite can drop
    fixture files without polluting the project's `Overflow_Graph/`."""
    import expert_backend.main as backend_main

    monkeypatch.setattr(backend_main, "_OVERFLOW_DIR", tmp_path)
    return tmp_path


def test_route_serves_html_with_overlay_injected(overflow_dir: Path) -> None:
    fixture = overflow_dir / "Overflow_demo.html"
    fixture.write_text(_BASE_HTML, encoding="utf-8")

    client = TestClient(app)
    response = client.get("/results/pdf/Overflow_demo.html")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/html")
    assert '<style id="cs4g-overlay-style">' in response.text
    assert '<script id="cs4g-overlay-script">' in response.text


def test_route_serves_pdf_unchanged(overflow_dir: Path) -> None:
    fixture = overflow_dir / "Overflow_demo.pdf"
    fixture.write_bytes(b"%PDF-1.4\n%fake\n%%EOF")

    client = TestClient(app)
    response = client.get("/results/pdf/Overflow_demo.pdf")

    assert response.status_code == 200
    assert response.content.startswith(b"%PDF-1.4")


def test_route_404_on_missing_file(overflow_dir: Path) -> None:
    client = TestClient(app)
    response = client.get("/results/pdf/does-not-exist.html")
    assert response.status_code == 404


def test_route_blocks_path_traversal(overflow_dir: Path) -> None:
    # Drop an HTML so the route would return 200 if traversal succeeded.
    sibling = overflow_dir.parent / "leaked.html"
    sibling.write_text("secret", encoding="utf-8")

    client = TestClient(app)
    response = client.get("/results/pdf/../leaked.html")
    # FastAPI/starlette may rewrite '..' before our handler sees it; if
    # the resolved path leaves the root we MUST return 404 rather than
    # serve the foreign file. Either rejection path is acceptable.
    assert response.status_code in (404, 400)


def test_route_html_without_body_tag_serves_raw(overflow_dir: Path, caplog: pytest.LogCaptureFixture) -> None:
    fixture = overflow_dir / "no_body.html"
    fixture.write_text("<html><head></head></html>", encoding="utf-8")

    client = TestClient(app)
    response = client.get("/results/pdf/no_body.html")

    assert response.status_code == 200
    # The raw content was returned without injection.
    assert "cs4g-overlay" not in response.text
