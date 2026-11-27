// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import type { FlowMetric, TabId, ViewMode } from '../types';
import { colors } from '../styles/tokens';

interface Option<T extends string> {
    value: T;
    label: string;
    title: string;
}

const VIEW_MODES: Option<ViewMode>[] = [
    { value: 'network', label: 'Flows', title: 'Absolute values of this network state' },
    { value: 'delta', label: 'Impacts', title: 'Change vs the reference state (N for N-1, N-1 for an action)' },
];

const METRICS: Option<FlowMetric>[] = [
    { value: 'p', label: 'MW', title: 'Active power on the branches' },
    { value: 'loading', label: 'Loading %', title: 'Loading rate of the branches, in % of their permanent limit' },
];

function Segmented<T extends string>({ options, value, onChange, testId }: {
    options: Option<T>[];
    value: T;
    onChange: (v: T) => void;
    testId: string;
}) {
    return (
        <div data-testid={testId} style={{
            display: 'flex',
            borderRadius: '6px',
            overflow: 'hidden',
            border: `1px solid ${colors.border}`,
            boxShadow: '0 2px 5px rgba(0,0,0,0.15)',
            fontSize: '12px',
            fontWeight: 600,
            backgroundColor: colors.surface,
        }}>
            {options.map((opt, i) => (
                <button
                    key={opt.value}
                    onClick={() => onChange(opt.value)}
                    title={opt.title}
                    aria-pressed={value === opt.value}
                    style={{
                        padding: '4px 12px', border: 'none', cursor: 'pointer',
                        borderLeft: i > 0 ? `1px solid ${colors.border}` : 'none',
                        backgroundColor: value === opt.value ? colors.brand : colors.surface,
                        color: value === opt.value ? colors.textOnBrand : colors.textSecondary,
                        transition: 'all 0.15s ease',
                    }}
                >
                    {opt.label}
                </button>
            ))}
        </div>
    );
}

/**
 * Top-right toggles of a diagram tab, one under the other: MW / Loading %
 * (active power vs loading rate) and Flows / Impacts (absolute state vs
 * change) — the latter left out where there is no reference state to
 * compare with (the N tab). Both are per tab and per window — the handlers
 * route the change.
 */
export default function FlowViewToggles({ tabId, viewMode, onViewModeChange, metric, onMetricChange, impacts = true }: {
    tabId: TabId;
    viewMode: ViewMode;
    onViewModeChange: (tab: TabId, mode: ViewMode) => void;
    metric: FlowMetric;
    onMetricChange: (tab: TabId, metric: FlowMetric) => void;
    /** Offer Flows / Impacts: false on the N tab, the reference state itself. */
    impacts?: boolean;
}) {
    return (
        <div style={{
            position: 'absolute', top: '10px', right: '10px', zIndex: 100,
            display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '6px',
        }}>
            <Segmented testId={`flow-metric-toggle-${tabId}`} options={METRICS} value={metric}
                onChange={m => onMetricChange(tabId, m)} />
            {impacts && (
                <Segmented testId={`view-mode-toggle-${tabId}`} options={VIEW_MODES} value={viewMode}
                    onChange={m => onViewModeChange(tabId, m)} />
            )}
        </div>
    );
}
