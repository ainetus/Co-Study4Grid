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
  selectedOverloads: Set<string> | null | undefined;
  /** Replace the pending list with the user's current selection. */
  onPendingContingencyChange: (next: string[]) => void;
  /** Commit ``pendingContingency`` as the applied contingency. */
  onContingencyApply: () => void;
  displayName: (id: string) => string;
  onContingencyZoom: (assetName: string) => void;
  onOverloadClick: (actionId: string, assetName: string, tab: 'n' | 'contingency') => void;
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
 *   jump to the contingency tab + zoom).
 * - Everything else — the full Select Contingency card with the
 *   multi-select picker + Apply button, the Overloads panel with its
 *   warnings and N / contingency breakdown, and the ActionFeed —
 *   scrolls together in a single column below (rendered as
 *   ``children``), saving vertical space.
 *
 * The Select Contingency card supports N-1 AND N-K studies: the user
 * picks elements one-by-one from the searchable multi-select (chips
 * appear inline; ✕ removes a chip) and confirms the full list with
 * the Apply button. Pressing Apply commits the pending list to the
 * actual ``selectedContingency`` which then drives the diagram fetch
 * and analysis.
 */
export default function AppSidebar({
  selectedContingency,
  pendingContingency,
  branches,
  nameMap,
  n1LinesOverloaded,
  n1LinesOverloadedRho,
  selectedOverloads,
  onPendingContingencyChange,
  onContingencyApply,
  displayName,
  onContingencyZoom,
  onOverloadClick,
  overviewFilters,
  onOverviewFiltersChange,
  hasActions,
  children,
}: AppSidebarProps) {
  // Pending differs from applied → user has unconfirmed edits to the
  // contingency that won't take effect until they hit Apply.
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

  return (
    <div data-testid="sidebar" style={{ width: '25%', background: colors.borderSubtle, borderRight: `1px solid ${colors.border}`, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <SidebarSummary
        selectedContingency={selectedContingency}
        n1LinesOverloaded={n1LinesOverloaded}
        n1LinesOverloadedRho={n1LinesOverloadedRho}
        selectedOverloads={selectedOverloads}
        displayName={displayName}
        onContingencyZoom={onContingencyZoom}
        onOverloadClick={onOverloadClick}
        overviewFilters={overviewFilters}
        onOverviewFiltersChange={onOverviewFiltersChange}
        hasActions={hasActions}
      />
      <div style={{ flex: 1, overflowY: 'auto', padding: space[4], minHeight: 0, display: 'flex', flexDirection: 'column', gap: space[4] }}>
        {branches.length > 0 && (
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
