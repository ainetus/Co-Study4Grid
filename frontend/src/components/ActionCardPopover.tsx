// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import React, { useCallback, type CSSProperties, type Ref } from 'react';
import type { ActionDetail, MetadataIndex } from '../types';
import ActionCard from './ActionCard';
import { colors } from '../styles/tokens';

/**
 * Floating ActionCard popover — shared between the action
 * overview view (single-click on a pin) and any future callsite
 * that needs a read-only-ish "peek" at an action's details
 * without opening the full drill-down diagram.
 *
 * The popover intentionally reuses the SAME `ActionCard`
 * component that the sidebar feed renders, so card visuals,
 * severity palette, badge resolution and tooltip text all stay
 * in lock-step with the feed — we only need to change the
 * component in ONE place. Re-simulate / edit controls are wired
 * to no-op stubs because the popover is a preview, not an
 * editor; callers that need those interactions should open the
 * drill-down view (which is what a double-click on the pin
 * already does).
 *
 * The chrome (floating card frame + close button) is owned by
 * this component so every callsite gets identical affordances.
 */
interface ActionCardPopoverProps {
    actionId: string;
    details: ActionDetail;
    /** Visual index shown in the card header (e.g. "#3"). */
    index: number;
    /**
     * Absolute-positioning style (including `position: fixed`,
     * top/bottom/left/right anchors). Typically produced by
     * `utils/popoverPlacement.computePopoverStyle` so the
     * popover lands next to the anchor element.
     */
    style: CSSProperties;
    /** Overloaded lines used for the "Loading after" rendering. */
    linesOverloaded: readonly string[];
    /** Monitoring factor — drives the severity badge. */
    monitoringFactor: number;
    /** N-1 metadata index used by badge resolution. */
    metaIndex: MetadataIndex | null;
    /** Selected-action set (for the card's `isSelected` styling). */
    selectedActionIds?: Set<string>;
    /** Rejected-action set (for the card's `isRejected` styling). */
    rejectedActionIds?: Set<string>;
    /**
     * Called when the user activates the card (clicks the card
     * body or the dedicated "view" affordance). Parent typically
     * closes the popover and switches to the action drill-down
     * view.
     */
    onActivateAction: (actionId: string) => void;
    /** Toggle favourite status. */
    onActionFavorite?: (actionId: string) => void;
    /** Reject the action. */
    onActionReject?: (actionId: string) => void;
    /** Close the popover. */
    onClose: () => void;
    /**
     * Optional ref on the popover root so the parent can detect
     * outside clicks.
     */
    popoverRef?: Ref<HTMLDivElement>;
    /**
     * Optional test id on the popover root (defaults to
     * "action-card-popover"). Kept overridable so multiple
     * callsites can disambiguate their popovers in tests.
     */
    testId?: string;
    /**
     * Optional data-attributes to forward onto the popover root —
     * used by `ActionOverviewDiagram` to record the placement
     * decision on the DOM for its unit tests.
     */
    extraDataAttributes?: Record<string, string>;
    /** Resolve an element/VL ID to its human-readable display name. */
    displayName?: (id: string) => string;
}

const NOOP = () => { /* intentional no-op */ };

const ActionCardPopover: React.FC<ActionCardPopoverProps> = ({
    actionId,
    details,
    index,
    style,
    linesOverloaded,
    monitoringFactor,
    metaIndex,
    selectedActionIds,
    rejectedActionIds,
    onActivateAction,
    onActionFavorite,
    onActionReject,
    onClose,
    popoverRef,
    testId = 'action-card-popover',
    extraDataAttributes,
    displayName,
}) => {
    // Wrap the "activate the action" intent so both the card
    // body click and any future explicit affordance flow through
    // the same path — and the popover always auto-dismisses.
    const handleActivate = useCallback((id: string | null) => {
        onClose();
        if (id) onActivateAction(id);
    }, [onActivateAction, onClose]);

    return (
        <div
            ref={popoverRef}
            data-testid={testId}
            data-action-id={actionId}
            {...(extraDataAttributes ?? {})}
            style={{
                ...style,
                background: colors.surface,
                border: `1px solid ${colors.border}`,
                borderRadius: 8,
                boxShadow: '0 10px 24px rgba(0, 0, 0, 0.25)',
                zIndex: 300,
            }}
            onMouseDown={e => e.stopPropagation()}
        >
            <button
                data-testid={`${testId}-close`}
                onClick={onClose}
                title="Close"
                style={{
                    position: 'absolute',
                    top: 6,
                    right: 8,
                    zIndex: 2,
                    background: colors.surface,
                    border: `1px solid ${colors.border}`,
                    borderRadius: '50%',
                    width: 22,
                    height: 22,
                    cursor: 'pointer',
                    fontSize: 12,
                    color: colors.textSecondary,
                    boxShadow: '0 1px 3px rgba(0,0,0,0.15)',
                    lineHeight: 1,
                }}
            >
                {'\u2715'}
            </button>
            <ActionCard
                id={actionId}
                details={details}
                index={index}
                isViewing={false}
                isSelected={selectedActionIds?.has(actionId) ?? false}
                isRejected={rejectedActionIds?.has(actionId) ?? false}
                linesOverloaded={Array.from(linesOverloaded)}
                monitoringFactor={monitoringFactor}
                nodesByEquipmentId={metaIndex?.nodesByEquipmentId ?? null}
                edgesByEquipmentId={metaIndex?.edgesByEquipmentId ?? null}
                cardEditMw={{}}
                cardEditTap={{}}
                resimulating={null}
                onActionSelect={handleActivate}
                onActionFavorite={onActionFavorite ?? NOOP}
                onActionReject={onActionReject ?? NOOP}
                onAssetClick={handleActivate}
                onCardEditMwChange={NOOP}
                onCardEditTapChange={NOOP}
                onResimulate={NOOP}
                onResimulateTap={NOOP}
                displayName={displayName}
            />
        </div>
    );
};

export default React.memo(ActionCardPopover);
