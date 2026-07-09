// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0

/*
 * Barrel file — the SVG utilities were split into focused modules
 * under `./svg/` on 2026-04-20 to shrink the historic 1800-line
 * omnibus file. Import paths stay unchanged:
 *
 *     import { applyOverloadedHighlights } from '../utils/svgUtils';
 *
 * See `docs/architecture/code-quality-analysis.md` for the
 * decomposition rationale and the per-module line budget.
 */

export { getIdMap, invalidateIdMapCache } from './svg/idMap';
export { boostSvgForLargeGrid, boostSvgToElement, processSvg } from './svg/svgBoost';
export { buildMetadataIndex } from './svg/metadataIndex';
export {
    applyOverloadedHighlights,
    isCouplingAction,
    getActionTargetLines,
    getActionTargetVoltageLevels,
    applyActionTargetHighlights,
    applyContingencyHighlight,
} from './svg/highlights';
export { applyDeltaVisuals } from './svg/deltaVisuals';
export { attachVlInteractions } from './svg/vlInteractions';
export {
    severityFill,
    severityFillDimmed,
    severityFillHighlighted,
    computeActionSeverity,
    actionPassesOverviewFilter,
    formatPinLabel,
    formatPinTitle,
    resolveActionAnchor,
    fanOutColocatedPins,
    buildActionOverviewPins,
    buildUnsimulatedActionPins,
    curveMidpoint,
    buildCombinedActionPins,
    type ActionPinInfo,
    type CombinedPinInfo,
} from './svg/actionPinData';
export {
    applyActionOverviewHighlights,
    readPinBaseRadius,
    computePinScale,
    rescaleActionOverviewPins,
    PIN_SINGLE_CLICK_DELAY_MS,
    starPath,
    crossPath,
    applyActionOverviewPins,
    type ApplyPinsOptions,
} from './svg/actionPinRender';
export {
    pushEquipmentPoints,
    computeActionOverviewFitRect,
    computeEquipmentFitRect,
} from './svg/fitRect';
