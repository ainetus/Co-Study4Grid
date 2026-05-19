// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import React, { useMemo } from 'react';
import Select, { type MultiValue } from 'react-select';
import type { ActionOverviewFilters } from '../types';
import SidebarSummary from './SidebarSummary';
import { colors, radius, space } from '../styles/tokens';

interface ContingencyOption {
  value: string;
  label: string;
}

interface AppSidebarProps {
  /** Currently APPLIED contingency (list of element IDs disconnected). */
  selectedContingency: string[];
  /** Pending list the user is composing — committed via Apply button. */
  pendingContingency: string[];
  branches: string[];
  nameMap: Record<string, string>;
  n1LinesOverloaded: string[] | undefined;
  n1LinesOverloadedRho: number[] | undefined;
  /** N-state pre-existing overloads, surfaced in the SidebarSummary info bubble. */
  nLinesOverloaded?: string[];
  nLinesOverloadedRho?: number[];
  selectedOverloads: Set<string> | null | undefined;
  /** Replace the pending list with the user's current selection. */
  onPendingContingencyChange: (next: string[]) => void;
  /** Commit ``pendingContingency`` as the applied contingency. */
  onContingencyApply: () => void;
  displayName: (id: string) => string;
  onContingencyZoom: (assetName: string) => void;
  onOverloadClick: (actionId: string, assetName: string, tab: 'n' | 'contingency') => void;
  /** Toggle an N-1 overload's inclusion in the analysis monitoring set.
   *  Forwarded to SidebarSummary's info bubble. */
  onToggleOverload?: (overload: string) => void;
  monitorDeselected?: boolean;
  onToggleMonitorDeselected?: () => void;
  monitoringHint?: string | null;
  /** Drop the current contingency to investigate a new one. Triggers
   *  the confirmation dialog at the call site. */
  onClearContingency?: () => void;
  /** Hide the "Select Contingency" card. Used after a contingency has
   *  been committed AND its overloads detected, since the sticky banner
   *  then carries the same info plus a Clear shortcut. */
  hideContingencyPicker?: boolean;
  /** Collapsed mode: the sidebar shrinks to a thin strip so the
   *  visualization panel can take the full width. */
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  /** Shared severity + action-type filters; forwarded to
   *  SidebarSummary so the persistent strip can host the filter
   *  rings alongside the contingency / overload lines. */
  overviewFilters?: ActionOverviewFilters;
  onOverviewFiltersChange?: (next: ActionOverviewFilters) => void;
  /** Whether the action feed has any card to filter right now. */
  hasActions?: boolean;
  children: React.ReactNode;
}

/**
 * Left-sidebar layout shell:
 *
 * - A COMPACT sticky strip at the top (<SidebarSummary>) keeps only
 *   the clickable fields of interest visible while scrolling
 *   (selected contingency → zoom active tab; contingency overloads →
 *   jump to the contingency tab + zoom). The strip also hosts the
 *   Clear-contingency shortcut and the overload-info bubble.
 * - The Select Contingency card with the multi-select picker + Trigger
 *   button shows below the strip — but only as long as no contingency
 *   has been committed (after that, the strip carries the same info
 *   and the picker would be redundant).
 * - The ActionFeed (rendered as ``children``) sits below.
 *
 * The shell can be collapsed to a thin strip when the operator wants
 * to expand the visualization panel.
 */
export default function AppSidebar({
  selectedContingency,
  pendingContingency,
  branches,
  nameMap,
  n1LinesOverloaded,
  n1LinesOverloadedRho,
  nLinesOverloaded,
  nLinesOverloadedRho,
  selectedOverloads,
  onPendingContingencyChange,
  onContingencyApply,
  displayName,
  onContingencyZoom,
  onOverloadClick,
  onToggleOverload,
  monitorDeselected,
  onToggleMonitorDeselected,
  monitoringHint,
  onClearContingency,
  hideContingencyPicker,
  collapsed,
  onToggleCollapsed,
  overviewFilters,
  onOverviewFiltersChange,
  hasActions,
  children,
}: AppSidebarProps) {
  // Pending differs from applied → user has unconfirmed edits to the
  // contingency that won't take effect until they hit Trigger.
  const samePendingApplied =
    pendingContingency.length === selectedContingency.length &&
    pendingContingency.every((e, i) => e === selectedContingency[i]);
  const dirty = !samePendingApplied;

  const branchOptions: ContingencyOption[] = useMemo(
    () => branches.map(b => ({
      value: b,
      label: nameMap[b] ? `${nameMap[b]}  —  ${b}` : b,
    })),
    [branches, nameMap],
  );
  const optionByValue = useMemo(() => {
    const m = new Map<string, ContingencyOption>();
    for (const o of branchOptions) m.set(o.value, o);
    return m;
  }, [branchOptions]);
  const selectedOptions: ContingencyOption[] = useMemo(
    () => pendingContingency.map(id =>
      optionByValue.get(id) ?? { value: id, label: nameMap[id] ? `${nameMap[id]}  —  ${id}` : id }
    ),
    [pendingContingency, optionByValue, nameMap],
  );

  if (collapsed) {
    return (
      <div
        data-testid="sidebar"
        data-collapsed="true"
        style={{
          width: '32px',
          background: colors.borderSubtle,
          borderRight: `1px solid ${colors.border}`,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          padding: `${space[2]} 0`,
        }}
      >
        <button
          data-testid="sidebar-expand-button"
          onClick={onToggleCollapsed}
          title="Expand sidebar"
          style={{
            background: colors.surface,
            border: `1px solid ${colors.border}`,
            borderRadius: radius.sm,
            cursor: 'pointer',
            width: '24px',
            height: '24px',
            fontSize: '12px',
            color: colors.textSecondary,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 0,
          }}
        >
          ›
        </button>
      </div>
    );
  }

  return (
    <div data-testid="sidebar" style={{ width: '25%', background: colors.borderSubtle, borderRight: `1px solid ${colors.border}`, display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative' }}>
      {onToggleCollapsed && (
        <button
          data-testid="sidebar-collapse-button"
          onClick={onToggleCollapsed}
          title="Collapse sidebar to widen the visualization panel"
          style={{
            position: 'absolute',
            top: '4px',
            right: '4px',
            zIndex: 5,
            background: colors.surface,
            border: `1px solid ${colors.border}`,
            borderRadius: radius.sm,
            cursor: 'pointer',
            width: '20px',
            height: '20px',
            fontSize: '11px',
            color: colors.textSecondary,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 0,
            lineHeight: 1,
          }}
        >
          ‹
        </button>
      )}
      <SidebarSummary
        selectedContingency={selectedContingency}
        n1LinesOverloaded={n1LinesOverloaded}
        n1LinesOverloadedRho={n1LinesOverloadedRho}
        nLinesOverloaded={nLinesOverloaded}
        nLinesOverloadedRho={nLinesOverloadedRho}
        selectedOverloads={selectedOverloads}
        displayName={displayName}
        onContingencyZoom={onContingencyZoom}
        onOverloadClick={onOverloadClick}
        onToggleOverload={onToggleOverload}
        monitorDeselected={monitorDeselected}
        onToggleMonitorDeselected={onToggleMonitorDeselected}
        monitoringHint={monitoringHint}
        onClearContingency={onClearContingency}
        overviewFilters={overviewFilters}
        onOverviewFiltersChange={onOverviewFiltersChange}
        hasActions={hasActions}
      />
      <div style={{ flex: 1, overflowY: 'auto', padding: space[4], minHeight: 0, display: 'flex', flexDirection: 'column', gap: space[4] }}>
        {branches.length > 0 && !hideContingencyPicker && (
          <div style={{ flexShrink: 0, padding: `${space[3]} ${space[4]}`, background: colors.surface, borderRadius: radius.lg, border: `1px solid ${colors.border}`, boxShadow: '0 2px 4px rgba(0,0,0,0.05)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: space[2], marginBottom: '5px' }}>
              <label style={{ fontSize: '0.8rem', fontWeight: 'bold' }}>⚡ Select Contingency</label>
              <button
                type="button"
                data-testid="contingency-trigger"
                onClick={onContingencyApply}
                disabled={pendingContingency.length === 0 || !dirty}
                title={
                  pendingContingency.length === 0
                    ? 'Pick at least one element first'
                    : dirty
                      ? `Trigger contingency (${pendingContingency.length} element${pendingContingency.length > 1 ? 's' : ''})`
                      : 'Already triggered'
                }
                style={{
                  padding: `${space[1]} ${space[3]}`,
                  background: pendingContingency.length === 0 || !dirty ? colors.disabled : colors.accent,
                  color: colors.textOnBrand,
                  border: 'none',
                  borderRadius: radius.sm,
                  cursor: pendingContingency.length === 0 || !dirty ? 'not-allowed' : 'pointer',
                  fontWeight: 'bold',
                  fontSize: '0.78rem',
                  whiteSpace: 'nowrap',
                }}
              >
                ▶ Trigger
              </button>
            </div>
            <Select<ContingencyOption, true>
              isMulti
              isClearable={false}
              options={branchOptions}
              value={selectedOptions}
              onChange={(next: MultiValue<ContingencyOption>) =>
                onPendingContingencyChange(next.map(o => o.value))
              }
              placeholder="Search line/bus…"
              noOptionsMessage={() => 'No matching elements'}
              classNamePrefix="cs4g-contingency"
              styles={{
                control: (base) => ({
                  ...base,
                  minHeight: 36,
                  borderRadius: radius.sm,
                  borderColor: colors.border,
                  fontSize: '0.85rem',
                }),
                multiValue: (base) => ({
                  ...base,
                  background: colors.borderSubtle,
                  border: `1px solid ${colors.border}`,
                }),
                multiValueLabel: (base) => ({
                  ...base,
                  fontSize: '0.78rem',
                }),
                option: (base, state) => ({
                  ...base,
                  fontSize: '0.85rem',
                  background: state.isFocused ? colors.borderSubtle : 'transparent',
                  color: colors.textPrimary,
                  cursor: 'pointer',
                }),
                menu: (base) => ({ ...base, zIndex: 30 }),
              }}
            />
          </div>
        )}
        {children}
      </div>
    </div>
  );
}
