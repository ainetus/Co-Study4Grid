// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import { useMemo, useState } from 'react';
import type { FlowMetric, TabId } from '../types';
import { colors, radius, space, text } from '../styles/tokens';

interface DiagramLegendProps {
  /** Which diagram tab the legend overlays. Drives which entries
   *  appear: contingency only on N-1 / action, action target only on
   *  action. */
  tabId: TabId;
  /**
   * Voltage levels currently visible in the diagram (kV). Used to
   * render the small voltage-level color swatch row at the bottom of
   * the legend. Pass the same `uniqueVoltages` array the kV slider
   * already consumes.
   */
  uniqueVoltages?: number[];
  /**
   * When true, voltage labels are hidden via the `nad-hide-vl-labels`
   * class. The legend mentions this so a new operator knows the
   * absence of labels is intentional, not a render bug.
   */
  vlNamesHidden?: boolean;
  /** Active power (default) or loading rate: the branch colours the
   *  legend explains. */
  flowMetric?: FlowMetric;
}

interface LegendRow {
  /** Token-resolved color for the swatch. */
  color: string;
  /** What the swatch is — one short phrase. */
  label: string;
  /** Optional sub-label (smaller, italic). Used for "dashed line", etc. */
  detail?: string;
  /** When true, the swatch renders as a dashed segment instead of a
   *  filled square. Used for disconnections. */
  dashed?: boolean;
}

/**
 * Collapsible legend that overlays the bottom-right of each diagram
 * tab. Implements `docs/proposals/ui-design-critique.md`
 * recommendation #5: surface the halo / disconnection / voltage
 * colour conventions on-screen so a new operator does not have to
 * learn them out-of-band.
 *
 * The legend is collapsed by default — the operator clicks a small
 * "Legend" pill to expand it. Closing returns to the pill so the
 * legend never competes with the network when the operator is
 * scanning. State is local; collapse preference is not persisted
 * (across sessions) so each tab open starts in the compact state.
 */
export default function DiagramLegend({ tabId, uniqueVoltages, vlNamesHidden, flowMetric = 'p' }: DiagramLegendProps) {
  const [open, setOpen] = useState(false);

  const rows = useMemo<LegendRow[]>(() => {
    const list: LegendRow[] = [];
    if (tabId === 'contingency' || tabId === 'action') {
      list.push({ color: 'var(--signal-contingency)', label: 'Contingency', detail: 'yellow halo on the disconnected element' });
    }
    if (tabId === 'action') {
      list.push({ color: 'var(--signal-action-target)', label: 'Action target', detail: 'pink halo on the remedial action' });
    }
    list.push({ color: 'var(--signal-overload)', label: 'Overloaded line', detail: 'orange halo (ρ ≥ 100% of monitoring factor)' });
    if (flowMetric === 'loading') {
      list.push({ color: 'var(--signal-loading-low)', label: 'Loading below 50 %', detail: 'grey line, % of the permanent limit' });
      list.push({
        color: 'linear-gradient(90deg, var(--signal-loading-warn-1), var(--signal-loading-warn-5))',
        label: 'Loading 50 % → monitoring factor', detail: 'pale yellow to orange line',
      });
      list.push({ color: 'var(--signal-loading-over)', label: 'Loading ≥ monitoring factor', detail: 'vivid orange line' });
    }
    if (tabId === 'contingency' || tabId === 'action') {
      const what = flowMetric === 'loading' ? 'Loading' : 'Flow';
      list.push({ color: 'var(--signal-delta-positive)', label: `${what} up after change`, detail: 'orange line in Impacts view' });
      list.push({ color: 'var(--signal-delta-negative)', label: `${what} down after change`, detail: 'blue line in Impacts view' });
    }
    list.push({ color: colors.textTertiary, label: 'Disconnected branch', detail: 'dashed grey segment', dashed: true });
    return list;
  }, [tabId, flowMetric]);

  // For voltage levels we restrict to the most populated handful so
  // the legend stays compact. The diagram's pypowsybl palette assigns
  // colours dynamically, so we mention the convention rather than try
  // to mirror every palette entry.
  const showVoltagePalette = (uniqueVoltages?.length ?? 0) > 1;

  if (!open) {
    return (
      <button
        type="button"
        data-testid={`diagram-legend-pill-${tabId}`}
        onClick={() => setOpen(true)}
        title="Show diagram legend"
        aria-expanded={false}
        style={{
          position: 'absolute',
          right: space[3],
          bottom: space[3],
          zIndex: 25,
          display: 'inline-flex',
          alignItems: 'center',
          gap: space[1],
          padding: `4px ${space[2]}`,
          background: colors.surface,
          color: colors.textSecondary,
          border: `1px solid ${colors.border}`,
          borderRadius: radius.lg,
          fontSize: text.xs,
          fontWeight: 600,
          cursor: 'pointer',
          boxShadow: '0 2px 6px rgba(0,0,0,0.12)',
        }}
      >
        <span aria-hidden="true">🗺️</span>
        Legend
      </button>
    );
  }

  return (
    <div
      data-testid={`diagram-legend-${tabId}`}
      role="dialog"
      aria-label="Diagram legend"
      style={{
        position: 'absolute',
        right: space[3],
        bottom: space[3],
        zIndex: 25,
        width: '240px',
        maxHeight: '60%',
        overflowY: 'auto',
        background: colors.surface,
        border: `1px solid ${colors.border}`,
        borderRadius: radius.md,
        boxShadow: '0 4px 14px rgba(0,0,0,0.18)',
        padding: space[2],
        fontSize: text.xs,
        color: colors.textPrimary,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: space[2] }}>
        <strong style={{ fontSize: text.sm }}>Legend</strong>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="Hide diagram legend"
          title="Hide legend"
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            padding: 0,
            fontSize: text.lg,
            lineHeight: 1,
            color: colors.textTertiary,
          }}
        >
          &times;
        </button>
      </div>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: space[1] }}>
        {rows.map(row => (
          <li key={`${row.label}-${row.detail ?? ''}`} style={{ display: 'flex', alignItems: 'flex-start', gap: space[2] }}>
            <span
              aria-hidden="true"
              style={{
                flexShrink: 0,
                marginTop: '2px',
                width: '18px',
                height: '4px',
                borderRadius: '2px',
                background: row.dashed ? 'transparent' : row.color,
                borderTop: row.dashed ? `2px dashed ${row.color}` : 'none',
                boxShadow: row.dashed ? 'none' : `0 0 0 1px rgba(0,0,0,0.05)`,
              }}
            />
            <span style={{ flex: 1 }}>
              <div style={{ fontWeight: 600 }}>{row.label}</div>
              {row.detail && (
                <div style={{ color: colors.textTertiary, fontSize: '10px' }}>{row.detail}</div>
              )}
            </span>
          </li>
        ))}
      </ul>
      {showVoltagePalette && (
        <div style={{ marginTop: space[2], paddingTop: space[2], borderTop: `1px solid ${colors.borderSubtle}` }}>
          <div style={{ fontWeight: 600, marginBottom: space[1] }}>Voltage levels (kV)</div>
          <div style={{ color: colors.textTertiary, fontSize: '10px' }}>
            Buses are coloured by nominal voltage — pypowsybl palette, brighter at higher kV. Use the kV filter on the right edge of the diagram to focus on a slice.
          </div>
        </div>
      )}
      {vlNamesHidden && (
        <div style={{ marginTop: space[1], color: colors.textTertiary, fontSize: '10px', fontStyle: 'italic' }}>
          Voltage-level names are hidden — toggle <strong>VL</strong> next to Inspect to show them.
        </div>
      )}
    </div>
  );
}
