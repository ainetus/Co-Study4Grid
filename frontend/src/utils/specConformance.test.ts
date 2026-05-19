// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid.

/**
 * Runtime spec-conformance check — the Vitest mirror of
 * `scripts/check_standalone_parity.py`'s three-way diff.
 *
 * Walks every ``interactionLogger.record(...)`` call site in the
 * React sources and verifies that the `details` object-literal keys
 * match the replay contract in ``docs/features/interaction-logging.md``.
 * Runs as part of the normal ``npm run test`` suite, so spec drift
 * is caught BEFORE a PR lands — not just when the Python parity
 * script happens to be run.
 *
 * The SPEC table below is the TypeScript twin of the Python
 * ``SPEC_DETAILS`` dict in ``scripts/check_standalone_parity.py``.
 * When the replay contract changes:
 *   - update ``docs/features/interaction-logging.md`` (source of truth),
 *   - update this SPEC table,
 *   - update the Python one.
 * Keeping the two in sync is the cost of redundant enforcement; the
 * benefit is a per-test-run gate that the dev feedback loop uses.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

interface SpecRow {
  required: ReadonlySet<string>;
  optional?: ReadonlySet<string>;
}

const CONFIG_FIELDS = new Set([
  'network_path', 'action_file_path', 'layout_path', 'output_folder_path',
  'min_line_reconnections', 'min_close_coupling', 'min_open_coupling',
  'min_line_disconnections', 'min_pst', 'min_load_shedding',
  'min_renewable_curtailment_actions', 'n_prioritized_actions',
  'lines_monitoring_path', 'monitoring_factor',
  'pre_existing_overload_threshold', 'ignore_reconnections',
  'pypowsybl_fast_mode',
]);

const SPEC: Record<string, SpecRow> = {
  // --- Configuration & Study Loading ---
  config_loaded:                  { required: CONFIG_FIELDS },
  settings_opened:                { required: new Set(['tab']) },
  settings_tab_changed:           { required: new Set(['from_tab', 'to_tab']) },
  settings_applied:               { required: CONFIG_FIELDS },
  settings_cancelled:             { required: new Set() },
  path_picked:                    { required: new Set(['type', 'path']) },
  // --- Contingency (single + N-K multi-element) ---
  contingency_selected:           { required: new Set(['element']) },
  contingency_confirmed:          { required: new Set(['type']), optional: new Set(['pending_branch']) },
  contingency_element_added:      { required: new Set(['element']) },
  contingency_element_removed:    { required: new Set(['element']) },
  contingency_applied:            { required: new Set(['elements']) },
  // --- Two-Step Analysis ---
  analysis_step1_started:         { required: new Set(['element']) },
  overload_toggled:               { required: new Set(['overload', 'selected']) },
  additional_line_to_cut_toggled: { required: new Set(['line', 'selected']) },
  recommender_model_changed:      { required: new Set(['model']), optional: new Set(['source']) },
  suggested_actions_cleared:      { required: new Set(['n_cleared']) },
  analysis_step2_started:         { required: new Set(['element', 'selected_overloads', 'all_overloads', 'monitor_deselected']), optional: new Set(['additional_lines_to_cut']) },
  prioritized_actions_displayed:  { required: new Set(['n_actions']) },
  // --- Action ---
  action_selected:                { required: new Set(['action_id']) },
  action_deselected:              { required: new Set(['previous_action_id']) },
  action_favorited:               { required: new Set(['action_id']) },
  action_unfavorited:             { required: new Set(['action_id']) },
  action_rejected:                { required: new Set(['action_id']) },
  action_unrejected:              { required: new Set(['action_id']) },
  manual_action_simulated:        { required: new Set(['action_id']) },
  action_mw_resimulated:          { required: new Set(['action_id', 'target_mw']) },
  pst_tap_resimulated:            { required: new Set(['action_id', 'target_tap']) },
  // --- Combined Actions ---
  combine_modal_opened:           { required: new Set() },
  combine_modal_closed:           { required: new Set() },
  combine_pair_toggled:           { required: new Set(['action_id', 'selected']) },
  combine_pair_estimated:         { required: new Set(['action1_id', 'action2_id', 'estimated_max_rho', 'estimated_max_rho_line']) },
  combine_pair_simulated:         { required: new Set(['combined_id', 'action1_id', 'action2_id', 'simulated_max_rho']) },
  // --- Visualization ---
  diagram_tab_changed:            { required: new Set(['tab']) },
  tab_detached:                   { required: new Set(['tab']) },
  tab_reattached:                 { required: new Set(['tab']) },
  tab_tied:                       { required: new Set(['tab']) },
  tab_untied:                     { required: new Set(['tab']) },
  view_mode_changed:              { required: new Set(['mode', 'tab', 'scope']) },
  // Overflow Analysis tab layout toggle. `to` = target mode ('hierarchical' | 'geo');
  // start event only. Completion event carries `cached` or `error`.
  overflow_layout_mode_toggled:   { required: new Set(['to']) },
  // Overflow Analysis tab — Co-Study4Grid pin overlay toggle.
  overflow_pins_toggled:          { required: new Set(['enabled']) },
  // Click on a pin overlaid on the overflow graph (forwarded from
  // the iframe via postMessage).
  overflow_pin_clicked:           { required: new Set(['actionId']) },
  // Double-click on an action pin in the overflow graph — drills
  // into the SLD overlay on the post-action ('action') sub-tab for
  // that pin's substation.
  overflow_pin_double_clicked:    { required: new Set(['actionId', 'substation']) },
  // Layer-toggle gesture inside the overflow-graph viewer (forwarded
  // from the iframe). `key` = layer key (e.g. "color:coral",
  // "semantic:is_hub"); `visible` = checkbox new state.
  overflow_layer_toggled:         { required: new Set(['key', 'label', 'visible']) },
  // Select-all / Unselect-all on the overflow-graph layer list.
  overflow_select_all_layers:     { required: new Set(['visible']) },
  // Double-click on a node in the overflow-graph viewer — forwarded
  // from the iframe; opens the SLD overlay for that voltage level.
  overflow_node_double_clicked:   { required: new Set(['name']) },
  voltage_range_changed:          { required: new Set(['min', 'max']) },
  asset_clicked:                  { required: new Set(['action_id', 'asset_name', 'tab']) },
  zoom_in:                        { required: new Set(['tab']) },
  zoom_out:                       { required: new Set(['tab']) },
  zoom_reset:                     { required: new Set(['tab']) },
  inspect_query_changed:          { required: new Set(['query']), optional: new Set(['target_tab']) },
  vl_names_toggled:               { required: new Set(['show']) },
  // --- Action Overview Diagram ---
  overview_shown:                 { required: new Set(['has_pins', 'pin_count']) },
  overview_hidden:                { required: new Set() },
  overview_pin_clicked:           { required: new Set(['action_id']) },
  overview_pin_double_clicked:    { required: new Set(['action_id']) },
  overview_popover_closed:        { required: new Set(['reason']) },
  overview_zoom_in:               { required: new Set() },
  overview_zoom_out:              { required: new Set() },
  overview_zoom_fit:              { required: new Set() },
  overview_inspect_changed:       { required: new Set(['query', 'action']) },
  overview_filter_changed:        { required: new Set(['kind']), optional: new Set(['category', 'enabled', 'threshold', 'action_type']) },
  overview_unsimulated_toggled:   { required: new Set(['enabled']) },
  overview_unsimulated_pin_simulated: { required: new Set(['action_id']) },
  // --- SLD Overlay ---
  sld_overlay_opened:             { required: new Set(['vl_name', 'action_id']) },
  sld_overlay_tab_changed:        { required: new Set(['tab', 'vl_name']) },
  sld_overlay_closed:             { required: new Set() },
  // --- Session Management ---
  session_saved:                  { required: new Set(['output_folder']) },
  session_reload_modal_opened:    { required: new Set() },
  session_reloaded:               { required: new Set(['session_name']) },
  // --- Sidebar layout / contingency clear ---
  sidebar_collapsed_toggled:      { required: new Set(['collapsed']) },
  contingency_clear_requested:    { required: new Set(['had_analysis_state']) },
};

// ---------------------------------------------------------------------
// Source walker
// ---------------------------------------------------------------------

function collectTsSources(root: string, out: string[] = []): string[] {
  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      collectTsSources(full, out);
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

interface CallSite {
  file: string;
  line: number;
  eventType: string;
  detailKeys: Set<string>;
  isBareIdentifier: boolean;
}

// Matches: interactionLogger.record('type', { ... })
// Also tolerates a bare-identifier second arg (e.g. buildConfigInteractionDetails()).
const RECORD_RE = /interactionLogger\.record\(\s*['"]([a-z0-9_]+)['"]\s*(?:,\s*(\{[^{}]*?\}|\w+[^,)]*))?\s*[,)]/gs;

// Matches a property key at the start of an object-literal property:
//   { name: value, ... }   → name
//   { name, ... }          → name (shorthand)
//   { ...spread }          → ignored
const KEY_RE = /[{,]\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?=[:,}])/g;

function extractCallSites(src: string, file: string): CallSite[] {
  const sites: CallSite[] = [];
  let m: RegExpExecArray | null;
  while ((m = RECORD_RE.exec(src)) !== null) {
    const eventType = m[1];
    const secondArg = m[2] ?? '';
    const line = src.slice(0, m.index).split('\n').length;
    const isObjectLiteral = secondArg.trim().startsWith('{');
    const detailKeys = new Set<string>();
    if (isObjectLiteral) {
      let km: RegExpExecArray | null;
      while ((km = KEY_RE.exec(secondArg)) !== null) {
        detailKeys.add(km[1]);
      }
    }
    sites.push({
      file,
      line,
      eventType,
      detailKeys,
      isBareIdentifier: !isObjectLiteral && secondArg.trim().length > 0,
    });
  }
  return sites;
}

// ---------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------

describe('interactionLogger.record — spec conformance', () => {
  // __dirname during Vitest run is `frontend/src/utils`; walk from
  // `frontend/src` downwards so the test finds every call site.
  const ROOT = join(__dirname, '..');
  const allSites: CallSite[] = collectTsSources(ROOT)
    .flatMap((file) => extractCallSites(readFileSync(file, 'utf-8'), file));

  it('walks at least one source file', () => {
    // Smoke test for the walker itself — if the directory layout
    // changes, this fails fast rather than silently passing no sites.
    expect(allSites.length).toBeGreaterThan(10);
  });

  it('every recorded event type is declared in the InteractionType union + SPEC', () => {
    const unknown = allSites
      .map((s) => s.eventType)
      .filter((t) => !(t in SPEC));
    expect(unknown, 'Add missing rows to SPEC above AND the Python SPEC_DETAILS')
      .toEqual([]);
  });

  // Each event type gets its own per-call-site conformance check —
  // Vitest reports them individually, so a single drift doesn't mask
  // all the others.
  for (const [eventType, row] of Object.entries(SPEC)) {
    const known = new Set([...row.required, ...(row.optional ?? new Set())]);
    it(`${eventType}: emitted keys match the replay contract`, () => {
      const sites = allSites.filter((s) => s.eventType === eventType && !s.isBareIdentifier);
      if (sites.length === 0) return; // event never emitted; covered by Layer-1 missing-event check

      for (const site of sites) {
        const rel = site.file.slice(site.file.indexOf('frontend/'));
        const missing = [...row.required].filter((k) => !site.detailKeys.has(k));
        const extras = [...site.detailKeys].filter((k) => !known.has(k));
        expect(
          missing,
          `${rel}:${site.line} — ${eventType} missing required key(s). Details: ${[...site.detailKeys].join(', ') || '(empty)'}`,
        ).toEqual([]);
        expect(
          extras,
          `${rel}:${site.line} — ${eventType} has extra key(s) not in required|optional: ${extras.join(', ')}`,
        ).toEqual([]);
      }
    });
  }
});
