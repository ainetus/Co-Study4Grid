// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import React, { useState, useRef, useCallback } from 'react';
import type { ActionOverviewFilters } from '../types';
import { colors, radius, space, text } from '../styles/tokens';
import ActionFilterRings from './ActionFilterRings';

interface SidebarSummaryProps {
  /** Currently APPLIED contingency — list of element IDs disconnected. */
  selectedContingency: string[];
  n1LinesOverloaded: string[] | undefined;
  n1LinesOverloadedRho: number[] | undefined;
  /** N-state pre-existing overloads. Surfaced via the info bubble next to
   *  the Overloads label, since they are no longer shown in a dedicated
   *  OverloadPanel card. */
  nLinesOverloaded?: string[];
  nLinesOverloadedRho?: number[];
  selectedOverloads: Set<string> | null | undefined;
  displayName: (id: string) => string;
  onContingencyZoom: (assetName: string) => void;
  onOverloadClick: (actionId: string, assetName: string, tab: 'n' | 'contingency') => void;
  /** Toggle an N-1 overload's inclusion in the analysis monitoring set. */
  onToggleOverload?: (overload: string) => void;
  /** Whether deselected overloads are still kept in the monitoring scope. */
  monitorDeselected?: boolean;
  onToggleMonitorDeselected?: () => void;
  /** Optional one-line monitoring coverage hint (replaces the legacy
   *  OverloadPanel hint when present). */
  monitoringHint?: string | null;
  /** Drop the current contingency and return to the contingency picker.
   *  Triggers the confirmation dialog at the call site. */
  onClearContingency?: () => void;
  /** Shared severity + action-type filters; forwarded to the inline
   *  ActionFilterRings row. */
  overviewFilters?: ActionOverviewFilters;
  onOverviewFiltersChange?: (next: ActionOverviewFilters) => void;
  /** Whether the action feed has any card to filter right now. */
  hasActions?: boolean;
}

/**
 * Compact sticky strip at the top of the sidebar that keeps the
 * clickable fields of interest visible while the rest of the sidebar
 * scrolls. Shows the selected contingency (with zoom-to shortcut)
 * and the contingency-state overloaded lines (with per-line
 * navigation + rho percentages). Rendered only when at least one of
 * those pieces of state is present.
 *
 * Hosts:
 * - a Clear button next to the Contingency label so the operator
 *   can drop the current contingency and go investigate another
 *   one (confirmation dialog handled by the parent);
 * - an info bubble next to the Overloads label that opens a small
 *   popover listing N-state pre-existing overloads, letting the
 *   operator deselect N-1 overloads (toggling their inclusion in
 *   the analysis monitoring set) and flip the "monitor deselected"
 *   switch — the former OverloadPanel functionality folded into
 *   the sticky banner.
 */
export default function SidebarSummary({
  selectedContingency,
  n1LinesOverloaded,
  n1LinesOverloadedRho,
  nLinesOverloaded,
  nLinesOverloadedRho,
  selectedOverloads,
  displayName,
  onContingencyZoom,
  onOverloadClick,
  onToggleOverload,
  monitorDeselected = false,
  onToggleMonitorDeselected,
  monitoringHint,
  onClearContingency,
  overviewFilters,
  onOverviewFiltersChange,
  hasActions,
}: SidebarSummaryProps) {
  const hasOverloads = (n1LinesOverloaded?.length ?? 0) > 0;
  const hasContingency = selectedContingency.length > 0;
  const hasFilters = !!hasActions && !!overviewFilters && !!onOverviewFiltersChange;
  const [popoverOpen, setPopoverOpen] = useState(false);
  const hideTimerRef = useRef<number | null>(null);

  const cancelHide = useCallback(() => {
    if (hideTimerRef.current != null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }, []);
  const scheduleHide = useCallback(() => {
    cancelHide();
    hideTimerRef.current = window.setTimeout(() => setPopoverOpen(false), 180);
  }, [cancelHide]);

  if (!hasContingency && !hasOverloads && !hasFilters) return null;

  const hasNOverloads = (nLinesOverloaded?.length ?? 0) > 0;
  const overloadsBubbleEnabled = hasOverloads || hasNOverloads || !!monitoringHint;

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
          style={{ display: 'flex', alignItems: 'baseline', gap: space[1], flexWrap: 'wrap', width: '100%' }}
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
          {onClearContingency && (
            <button
              data-testid="sidebar-summary-clear"
              onClick={(e) => { e.stopPropagation(); onClearContingency(); }}
              title="Clear the current contingency and pick a new one"
              style={{
                marginLeft: 'auto',
                background: 'none',
                border: `1px solid ${colors.border}`,
                borderRadius: radius.sm,
                padding: `0 ${space[1]}`,
                cursor: 'pointer',
                fontSize: '10px',
                color: colors.textSecondary,
                fontWeight: 600,
                lineHeight: 1.5,
                whiteSpace: 'nowrap',
              }}
            >
              ✕ Clear
            </button>
          )}
        </div>
      )}
      {hasOverloads && (
        <div
          data-testid="sidebar-summary-overloads"
          style={{ display: 'flex', alignItems: 'baseline', gap: space[1], position: 'relative' }}
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
          {overloadsBubbleEnabled && (
            <span
              data-testid="sidebar-summary-overloads-bubble-wrap"
              style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}
              onMouseEnter={() => { cancelHide(); setPopoverOpen(true); }}
              onMouseLeave={scheduleHide}
            >
              <button
                data-testid="sidebar-summary-overloads-bubble"
                onClick={(e) => { e.stopPropagation(); setPopoverOpen(o => !o); }}
                aria-label="Overload details"
                title="Show N-state overloads, toggle N-1 overload selection, and monitor-deselected"
                style={{
                  background: colors.chromeSoft,
                  color: colors.textOnBrand,
                  border: 'none',
                  borderRadius: '50%',
                  width: '14px',
                  height: '14px',
                  fontSize: '10px',
                  lineHeight: 1,
                  cursor: 'pointer',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: 0,
                  marginLeft: space[1],
                }}
              >
                ?
              </button>
              {popoverOpen && (
                <OverloadInfoPopover
                  nLinesOverloaded={nLinesOverloaded ?? []}
                  nLinesOverloadedRho={nLinesOverloadedRho}
                  n1LinesOverloaded={n1LinesOverloaded ?? []}
                  n1LinesOverloadedRho={n1LinesOverloadedRho}
                  selectedOverloads={selectedOverloads}
                  onToggleOverload={onToggleOverload}
                  monitorDeselected={monitorDeselected}
                  onToggleMonitorDeselected={onToggleMonitorDeselected}
                  monitoringHint={monitoringHint}
                  onAssetClick={onOverloadClick}
                  displayName={displayName}
                />
              )}
            </span>
          )}
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

interface OverloadInfoPopoverProps {
  nLinesOverloaded: string[];
  nLinesOverloadedRho?: number[];
  n1LinesOverloaded: string[];
  n1LinesOverloadedRho?: number[];
  selectedOverloads: Set<string> | null | undefined;
  onToggleOverload?: (overload: string) => void;
  monitorDeselected: boolean;
  onToggleMonitorDeselected?: () => void;
  monitoringHint?: string | null;
  onAssetClick: (actionId: string, assetName: string, tab: 'n' | 'contingency') => void;
  displayName: (id: string) => string;
}

function OverloadInfoPopover({
  nLinesOverloaded,
  nLinesOverloadedRho,
  n1LinesOverloaded,
  n1LinesOverloadedRho,
  selectedOverloads,
  onToggleOverload,
  monitorDeselected,
  onToggleMonitorDeselected,
  monitoringHint,
  onAssetClick,
  displayName,
}: OverloadInfoPopoverProps) {
  const formatRho = (v: number | undefined) =>
    v == null || Number.isNaN(v) ? null : `${(v * 100).toFixed(1)}%`;
  const hasDeselected = n1LinesOverloaded.some(name => !(selectedOverloads?.has(name) ?? true));

  return (
    <div
      data-testid="overload-info-popover"
      role="dialog"
      style={{
        position: 'absolute',
        top: '100%',
        left: 0,
        marginTop: space[1],
        zIndex: 50,
        background: colors.surface,
        border: `1px solid ${colors.border}`,
        borderRadius: radius.md,
        boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
        padding: `${space[2]} ${space[3]}`,
        minWidth: '240px',
        maxWidth: '320px',
        fontSize: text.xs,
        color: colors.textPrimary,
        lineHeight: 1.5,
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {monitoringHint && (
        <div
          data-testid="overload-info-monitoring-hint"
          style={{
            marginBottom: space[1],
            fontSize: '11px',
            color: colors.textTertiary,
            fontStyle: 'italic',
          }}
        >
          {monitoringHint}
        </div>
      )}
      <div style={{ marginBottom: space[1] }}>
        <strong style={{ color: colors.textSecondary }}>N Overloads:</strong>{' '}
        {nLinesOverloaded.length > 0 ? (
          <span style={{ wordBreak: 'break-word' }}>
            {nLinesOverloaded.map((name, i) => {
              const rhoPct = formatRho(nLinesOverloadedRho?.[i]);
              return (
                <React.Fragment key={name}>
                  {i > 0 && ', '}
                  <button
                    onClick={(e) => { e.stopPropagation(); onAssetClick('', name, 'n'); }}
                    title={`Open N tab and zoom to ${name}`}
                    style={{
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      padding: 0,
                      fontSize: 'inherit',
                      color: colors.brand,
                      fontWeight: 600,
                      textDecoration: 'underline dotted',
                    }}
                  >
                    {displayName(name)}
                  </button>
                  {rhoPct && <span style={{ marginLeft: space.half }}>({rhoPct})</span>}
                </React.Fragment>
              );
            })}
          </span>
        ) : (
          <span style={{ color: colors.textTertiary, fontStyle: 'italic' }}>None</span>
        )}
      </div>
      <div>
        <strong style={{ color: colors.textSecondary }}>N-1 Overloads:</strong>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', marginTop: space.half }}>
          {n1LinesOverloaded.map((name, i) => {
            const rhoPct = formatRho(n1LinesOverloadedRho?.[i]);
            const isSelected = selectedOverloads?.has(name) ?? true;
            return (
              <label
                key={name}
                data-testid={`overload-info-toggle-${name}`}
                title={isSelected
                  ? `Uncheck to exclude ${displayName(name)} from monitoring`
                  : `Check to include ${displayName(name)} in monitoring`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: space[1],
                  cursor: onToggleOverload ? 'pointer' : 'default',
                  color: isSelected ? colors.textPrimary : colors.borderStrong,
                }}
              >
                <input
                  type="checkbox"
                  checked={isSelected}
                  disabled={!onToggleOverload}
                  onChange={() => onToggleOverload?.(name)}
                  onClick={(e) => e.stopPropagation()}
                  style={{ margin: 0, cursor: onToggleOverload ? 'pointer' : 'default' }}
                />
                <button
                  onClick={(e) => { e.stopPropagation(); onAssetClick('', name, 'contingency'); }}
                  title={`Open Contingency tab and zoom to ${name}`}
                  style={{
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    padding: 0,
                    fontSize: 'inherit',
                    color: isSelected ? colors.brand : colors.borderStrong,
                    fontWeight: isSelected ? 600 : 400,
                    textDecoration: isSelected ? 'underline dotted' : 'none',
                  }}
                >
                  {displayName(name)}
                </button>
                {rhoPct && (
                  <span style={{ color: isSelected ? colors.textPrimary : colors.borderStrong }}>
                    ({rhoPct})
                  </span>
                )}
              </label>
            );
          })}
        </div>
        {hasDeselected && onToggleMonitorDeselected && (
          <label
            data-testid="overload-info-monitor-deselected"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '4px',
              cursor: 'pointer',
              fontSize: '11px',
              color: monitorDeselected ? colors.brandStrong : colors.textSecondary,
              fontWeight: monitorDeselected ? 600 : 400,
              marginTop: space[1],
            }}
            title="When checked, deselected overloads are still included in the analysis monitoring scope"
          >
            <input
              type="checkbox"
              checked={monitorDeselected}
              onChange={onToggleMonitorDeselected}
              onClick={(e) => e.stopPropagation()}
              style={{ margin: 0, cursor: 'pointer' }}
            />
            monitor deselected
          </label>
        )}
      </div>
    </div>
  );
}
