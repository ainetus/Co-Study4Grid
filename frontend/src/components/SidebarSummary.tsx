// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import React from 'react';
import type { ActionOverviewFilters } from '../types';
import { colors, space, text } from '../styles/tokens';
import ActionFilterRings from './ActionFilterRings';

interface SidebarSummaryProps {
  /** Currently APPLIED contingency — list of element IDs disconnected. */
  selectedContingency: string[];
  n1LinesOverloaded: string[] | undefined;
  n1LinesOverloadedRho: number[] | undefined;
  selectedOverloads: Set<string> | null | undefined;
  displayName: (id: string) => string;
  onContingencyZoom: (assetName: string) => void;
  onOverloadClick: (actionId: string, assetName: string, tab: 'n' | 'contingency') => void;
  /** Shared severity + action-type filters driving the action feed.
   *  When set together with `hasActions`, the persistent strip grows
   *  a compact two-ring icon filter below the contingency / overload
   *  rows. */
  overviewFilters?: ActionOverviewFilters;
  onOverviewFiltersChange?: (next: ActionOverviewFilters) => void;
  /** Whether the action feed currently holds any card to filter —
   *  the filter rings stay hidden until there is something to act on. */
  hasActions?: boolean;
}

/**
 * Compact sticky strip at the top of the sidebar that keeps the
 * clickable fields of interest visible while the rest of the sidebar
 * scrolls. Shows the selected contingency (with zoom-to shortcut)
 * and the contingency-state overloaded lines (with per-line
 * navigation + rho percentages). Rendered only when at least one of
 * those pieces of state is present.
 */
export default function SidebarSummary({
  selectedContingency,
  n1LinesOverloaded,
  n1LinesOverloadedRho,
  selectedOverloads,
  displayName,
  onContingencyZoom,
  onOverloadClick,
  overviewFilters,
  onOverviewFiltersChange,
  hasActions,
}: SidebarSummaryProps) {
  const hasOverloads = (n1LinesOverloaded?.length ?? 0) > 0;
  const hasContingency = selectedContingency.length > 0;
  const hasFilters = !!hasActions && !!overviewFilters && !!onOverviewFiltersChange;
  if (!hasContingency && !hasOverloads && !hasFilters) return null;

  return (
    <div
      data-testid="sticky-feed-summary"
      style={{
        flexShrink: 0,
        padding: `6px ${space[3]}`,
        background: colors.surfaceMuted,
        borderBottom: `1px solid ${colors.border}`,
        fontSize: text.xs,
        lineHeight: 1.5,
        boxShadow: '0 1px 2px rgba(0,0,0,0.04)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: space.half,
      }}
    >
      {hasContingency && (
        <div
          data-testid="sidebar-summary-contingency"
          style={{ display: 'flex', alignItems: 'baseline', gap: space[1], flexWrap: 'wrap' }}
        >
          <span style={{ color: colors.textSecondary, fontWeight: 600, whiteSpace: 'nowrap' }}>
            ⚡ Contingency{selectedContingency.length > 1 ? ` (N-${selectedContingency.length})` : ''}:
          </span>
          {selectedContingency.map((id, i) => (
            <React.Fragment key={id}>
              {i > 0 && <span style={{ color: colors.textSecondary }}>, </span>}
              <button
                onClick={(e) => { e.stopPropagation(); onContingencyZoom(id); }}
                title={`Zoom to ${id} in the current diagram`}
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  padding: 0,
                  fontSize: text.xs,
                  color: colors.brand,
                  fontWeight: 600,
                  textDecoration: 'underline dotted',
                  wordBreak: 'break-word',
                  textAlign: 'left',
                }}
              >
                {displayName(id)}
              </button>
            </React.Fragment>
          ))}
        </div>
      )}
      {hasOverloads && (
        <div
          data-testid="sidebar-summary-overloads"
          style={{ display: 'flex', alignItems: 'baseline', gap: space[1] }}
        >
          <span style={{ color: colors.dangerStrong, fontWeight: 600, whiteSpace: 'nowrap' }}>⚠️ Overloads:</span>
          <span style={{ wordBreak: 'break-word' }}>
            {n1LinesOverloaded!.map((name, i) => {
              const rho = n1LinesOverloadedRho?.[i];
              const rhoPct = rho != null && !Number.isNaN(rho) ? `${(rho * 100).toFixed(1)}%` : null;
              const isSelected = selectedOverloads?.has(name) ?? true;
              return (
                <React.Fragment key={name}>
                  {i > 0 && ', '}
                  <button
                    onClick={(e) => { e.stopPropagation(); onOverloadClick('', name, 'contingency'); }}
                    title={`Open Contingency tab and zoom to ${name}`}
                    style={{
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      padding: 0,
                      fontSize: text.xs,
                      color: isSelected ? colors.brand : colors.borderStrong,
                      fontWeight: isSelected ? 600 : 400,
                      textDecoration: isSelected ? 'underline dotted' : 'none',
                    }}
                  >
                    {displayName(name)}
                  </button>
                  {rhoPct && (
                    <span style={{ color: isSelected ? colors.textPrimary : colors.borderStrong, marginLeft: space.half }}>
                      ({rhoPct})
                    </span>
                  )}
                </React.Fragment>
              );
            })}
          </span>
        </div>
      )}
      {hasFilters && (
        <ActionFilterRings
          filters={overviewFilters!}
          onFiltersChange={onOverviewFiltersChange!}
        />
      )}
    </div>
  );
}
