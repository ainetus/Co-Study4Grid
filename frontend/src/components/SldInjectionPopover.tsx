// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0

import React, { useState } from 'react';
import { colors, space, text, radius } from '../styles/tokens';
import type { VlInjection } from '../types';

export interface SldInjectionPopoverProps {
    equipmentId: string;
    injection: VlInjection;
    /** Seed value for the input: the staged override, or the baseline setpoint. */
    currentValue: number;
    /** True when a setpoint override is already staged (enables "Reset"). */
    staged: boolean;
    /** Position within the overlay body (px), pre-clamped to stay visible. */
    position: { x: number; y: number };
    onApply: (targetP: number) => void;
    onRemove: () => void;
    onClose: () => void;
}

const fmtMw = (v: number | null | undefined): string =>
    v == null ? '—' : `${v.toFixed(1)} MW`;

/** Active-power setpoints are edited to a single decimal place. */
const roundMw = (v: number): number => Math.round(v * 10) / 10;

/**
 * Floating editor for a load / generator active-power setpoint, opened by
 * clicking the element on the SLD while in edit mode. Surfaces the
 * baseline setpoint and — for a generator — its Pmin / Pmax capability
 * range, then lets the operator stage a new setpoint that simulates as a
 * manual action (same path as a topology toggle). Mirrors the
 * ``petite bulle d'information`` requested for injection editing.
 */
const SldInjectionPopover: React.FC<SldInjectionPopoverProps> = ({
    equipmentId, injection, currentValue, staged, position, onApply, onRemove, onClose,
}) => {
    // Seed (and edit) to a single decimal — the backend setpoints can carry
    // many digits, but the operator tunes in 0.1 MW steps.
    const [value, setValue] = useState<string>(
        Number.isFinite(currentValue) ? String(roundMw(currentValue)) : '',
    );

    const isGen = injection.kind === 'generator';
    const minP = injection.min_p;
    const maxP = injection.max_p;
    const hasBounds = isGen && minP != null && maxP != null;

    const parsed = parseFloat(value);
    const valid = value.trim() !== '' && !Number.isNaN(parsed);
    const outOfBounds = valid && hasBounds && (parsed < (minP as number) || parsed > (maxP as number));

    const commit = () => {
        if (!valid) return;
        // One-decimal setpoint, then clamp generators to their capability
        // range (loads have no bounds).
        let target = roundMw(parsed);
        if (hasBounds) target = Math.min(Math.max(target, minP as number), maxP as number);
        onApply(roundMw(target));
    };

    return (
        <div
            data-testid="sld-injection-popover"
            // Stop the body's pan / capture-click handlers from firing on
            // interactions inside the bubble.
            onMouseDown={e => e.stopPropagation()}
            onClick={e => e.stopPropagation()}
            style={{
                position: 'absolute', left: position.x + 'px', top: position.y + 'px',
                width: '210px', zIndex: 60,
                background: colors.surface, border: `1px solid ${colors.border}`,
                borderRadius: radius.md, boxShadow: '0 4px 16px rgba(0,0,0,0.22)',
                padding: space[2], display: 'flex', flexDirection: 'column', gap: space.half,
                fontSize: text.xs,
            }}
        >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: space[1] }}>
                <strong
                    data-testid="sld-injection-name"
                    style={{ fontSize: text.sm, color: colors.textPrimary, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    title={equipmentId}
                >{equipmentId}</strong>
                <span style={{
                    fontSize: text.xs, fontWeight: 700, padding: `0 ${space.half}`, borderRadius: radius.sm,
                    background: colors.brandSoft, color: colors.brandStrong, whiteSpace: 'nowrap',
                }}>{isGen ? 'générateur' : 'charge'}</span>
            </div>

            <div style={{ color: colors.textTertiary, display: 'flex', flexDirection: 'column', gap: space[0] }}>
                {isGen && injection.energy_source && (
                    <span data-testid="sld-injection-source">{injection.energy_source}</span>
                )}
                <span>P actuelle : <strong style={{ color: colors.textSecondary }}>{fmtMw(injection.p)}</strong></span>
                {hasBounds && (
                    <span data-testid="sld-injection-bounds">
                        Pmin / Pmax : <strong style={{ color: colors.textSecondary }}>{fmtMw(minP)}</strong> / <strong style={{ color: colors.textSecondary }}>{fmtMw(maxP)}</strong>
                    </span>
                )}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: space[1], marginTop: space.half }}>
                <input
                    data-testid="sld-injection-input"
                    type="number"
                    step={0.1}
                    min={isGen && minP != null ? minP : undefined}
                    max={isGen && maxP != null ? maxP : undefined}
                    value={value}
                    autoFocus
                    onChange={e => setValue(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') onClose(); }}
                    style={{
                        flex: 1, fontFamily: 'monospace', fontSize: text.sm,
                        padding: `${space.half} ${space[1]}`, textAlign: 'right',
                        border: `1px solid ${outOfBounds ? colors.warningBorder : colors.border}`,
                        borderRadius: radius.sm, background: colors.surface, color: colors.textPrimary,
                    }}
                />
                <span style={{ color: colors.textTertiary }}>MW</span>
            </div>
            {outOfBounds && (
                <span data-testid="sld-injection-clamp-note" style={{ color: colors.warningText, fontSize: text.xs }}>
                    Hors bornes — sera ramené dans [{minP?.toFixed(0)}, {maxP?.toFixed(0)}].
                </span>
            )}

            <div style={{ display: 'flex', gap: space[1], justifyContent: 'flex-end', marginTop: space.half, flexWrap: 'wrap' }}>
                {staged && (
                    <button
                        data-testid="sld-injection-remove"
                        onClick={onRemove}
                        style={{
                            padding: `${space.half} ${space[1]}`, fontSize: text.xs,
                            background: colors.surface, color: colors.danger,
                            border: `1px solid ${colors.danger}`, borderRadius: radius.sm, cursor: 'pointer',
                        }}
                    >Annuler le réglage</button>
                )}
                <button
                    data-testid="sld-injection-cancel"
                    onClick={onClose}
                    style={{
                        padding: `${space.half} ${space[1]}`, fontSize: text.xs,
                        background: colors.surface, color: colors.textPrimary,
                        border: `1px solid ${colors.border}`, borderRadius: radius.sm, cursor: 'pointer',
                    }}
                >Fermer</button>
                <button
                    data-testid="sld-injection-apply"
                    onClick={commit}
                    disabled={!valid}
                    style={{
                        padding: `${space.half} ${space[2]}`, fontSize: text.xs, fontWeight: 600,
                        background: valid ? colors.brand : colors.disabled, color: colors.textOnBrand,
                        border: 'none', borderRadius: radius.sm, cursor: valid ? 'pointer' : 'not-allowed',
                    }}
                >Appliquer</button>
            </div>
        </div>
    );
};

export default SldInjectionPopover;
