// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study. 

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import './App.css';
import VisualizationPanel from './components/VisualizationPanel';
import ActionFeed from './components/ActionFeed';
import AntennaNotice from './components/AntennaNotice';
import Header from './components/Header';
import AppSidebar from './components/AppSidebar';
import StatusToasts from './components/StatusToasts';
import type { Notice } from './components/NoticesPanel';
import SettingsModal from './components/modals/SettingsModal';
import ReloadSessionModal from './components/modals/ReloadSessionModal';
import ConfirmationDialog from './components/modals/ConfirmationDialog';
import type { ConfirmDialogState } from './components/modals/ConfirmationDialog';
import { api } from './api';
import type { ActionDetail, ActionOverviewFilters, DiagramData, TabId, MetadataIndex, RecommenderDisplayConfig, UnsimulatedActionScoreInfo } from './types';
import { useSettings } from './hooks/useSettings';
import { useActions } from './hooks/useActions';
import { useAnalysis } from './hooks/useAnalysis';
import { useDiagrams } from './hooks/useDiagrams';
import { useSession } from './hooks/useSession';
import { useDetachedTabs } from './hooks/useDetachedTabs';
import { useTiedTabsSync, type PZInstance } from './hooks/useTiedTabsSync';
import { useContingencyFetch } from './hooks/useContingencyFetch';
import { useDiagramHighlights } from './hooks/useDiagramHighlights';
import { useSldTopologyEdit } from './hooks/useSldTopologyEdit';
import { interactionLogger } from './utils/interactionLogger';
import { gameBridge } from './game/gameBridge';
import type { GameStudy } from './game/types';
import { DEFAULT_ACTION_OVERVIEW_FILTERS } from './utils/actionTypes';
import { attachVlInteractions } from './utils/svgUtils';
import {
    buildOverflowPinPayload,
    buildOverflowUnsimulatedPinPayload,
} from './utils/svg/overflowPinPayload';

function App() {
  // ===== Settings Hook =====
  const settings = useSettings();
  const {
    // Paths and values used in App-level logic (handleApplySettings, handleLoadConfig, wrappedSaveResults/RestoreSession)
    configFilePath, changeConfigFilePath, lastActiveConfigFilePath,
    networkPath, setNetworkPath, actionPath, setActionPath,
    layoutPath, setLayoutPath, outputFolderPath,
    minLineReconnections, setMinLineReconnections,
    minCloseCoupling, setMinCloseCoupling,
    minOpenCoupling, setMinOpenCoupling,
    minLineDisconnections, setMinLineDisconnections,
    nPrioritizedActions, setNPrioritizedActions,
    minPst, setMinPst,
    minLoadShedding, setMinLoadShedding,
    minRenewableCurtailmentActions, setMinRenewableCurtailmentActions,
    minRedispatch, setMinRedispatch,
    allowedActionTypes, setAllowedActionTypes,
    ignoreReconnections, setIgnoreReconnections,
    linesMonitoringPath, setLinesMonitoringPath,
    monitoredLinesCount, totalLinesCount,
    showMonitoringWarning, setShowMonitoringWarning,
    monitoringFactor, setMonitoringFactor,
    preExistingOverloadThreshold, setPreExistingOverloadThreshold,
    pypowsyblFastMode, setPypowsyblFastMode,
    actionDictFileName, actionDictStats,
    setIsSettingsOpen, setSettingsTab,
    pickSettingsPath,
    handleOpenSettings,
    recommenderModel, setRecommenderModel, availableModels,
    buildConfigRequest, configRequestFromUserConfig, applyConfigResponse, createCurrentBackup, setSettingsBackup
  } = settings;

  /**
   * Currently APPLIED contingency — ordered list of element IDs to
   * disconnect simultaneously. Empty list means N state. Single-item
   * list is the legacy N-1 case; longer lists drive N-K studies.
   * The user builds the list via ``pendingContingency`` and commits
   * it with the Apply button in the Header.
   */
  const [selectedContingency, setSelectedContingency] = useState<string[]>([]);
  /**
   * Pending element IDs the user is composing in the Header before
   * pressing Apply. Confirming applies the list to
   * ``selectedContingency`` and triggers the diagram fetch.
   */
  const [pendingContingency, setPendingContingency] = useState<string[]>([]);
  const [branches, setBranches] = useState<string[]>([]);
  const [voltageLevels, setVoltageLevels] = useState<string[]>([]);
  /** ID → human-readable name for branches (lines + transformers) and VLs. */
  const [nameMap, setNameMap] = useState<Record<string, string>>({});
  /** VL id → substation id. Loaded once after config-load and used to
   *  anchor the action-overview pins on the overflow graph (whose
   *  nodes are pypowsybl substation ids). */
  const [vlToSubstation, setVlToSubstation] = useState<Record<string, string>>({});
  /** Whether the user has switched ON the pin overlay on the overflow
   *  graph. Default OFF; toggle is disabled until Step 2 has produced
   *  a non-empty `result.actions` map. */
  const [overflowPinsEnabled, setOverflowPinsEnabled] = useState(false);
  const [configLoading, setConfigLoading] = useState(false);
  const [error, setError] = useState('');

  /** Resolve an element or VL ID to its display name. Falls back to the ID. */
  const displayName = useCallback((id: string) => nameMap[id] || id, [nameMap]);

  // ===== Detached Visualization Tabs (must be instantiated BEFORE useDiagrams
  // so that the detached-tabs map can be threaded into useDiagrams → usePanZoom,
  // keeping a detached tab interactive even when it's not the main `activeTab`.)
  const detachedTabsHook = useDetachedTabs({
    onPopupBlocked: () => setError('Popup blocked by the browser. Please allow popups for this site to detach tabs.'),
  });
  const { detachedTabs, detach: detachTab, reattach: reattachTab, focus: focusDetachedTab } = detachedTabsHook;

  const diagrams = useDiagrams(branches, voltageLevels, selectedContingency, detachedTabs);

  // ===== Action Overview PZ (for tied-tab sync) =====
  // The action overview has its own independent usePanZoom instance
  // (it renders the N-1 NAD as a background with pins).  We need to
  // include it in the tie system so that when the action tab is
  // detached and showing the overview (no selectedActionId), zoom /
  // focus changes are mirrored to the main window.
  //
  // This MUST be React state (not a ref) so that when the overview's
  // viewBox changes inside ActionOverviewDiagram, the new PZ instance
  // propagates up to App via the onPzChange callback, triggering a
  // re-render.  That re-render updates `actionVb` inside
  // useTiedTabsSync's deps, letting it detect the change and mirror
  // it to the main window.  A ref would silently hold the new value
  // without triggering the sync hook — making detached→main sync
  // one-directional.
  const [overviewPz, setOverviewPz] = useState<PZInstance | null>(null);
  const handleOverviewPzChange = useCallback((pz: PZInstance) => {
    setOverviewPz(pz);
  }, []);

  // When the overview is visible (no selected action), use its PZ
  // for the 'action' slot in the tie map.  Otherwise fall back to
  // the action-variant diagram's PZ.
  const actionPZForTie = (!diagrams.selectedActionId && overviewPz)
    ? overviewPz
    : diagrams.actionPZ;

  // ===== Tied Detached Tabs =====
  // When a detached tab is "tied", its viewBox is mirrored one-way
  // into the main window's active tab on every pan/zoom change —
  // supporting side-by-side comparison workflows. See
  // docs/features/detachable-viz-tabs.md#tied-detached-tabs for the full
  // design rationale.
  const tiedTabsHook = useTiedTabsSync(
    { 'n': diagrams.nPZ, 'contingency': diagrams.n1PZ, 'action': actionPZForTie },
    diagrams.activeTab,
    detachedTabs,
  );
  const { isTied: isTabTied, toggleTie: toggleTabTie } = tiedTabsHook;

  // Confirmation dialog state for contingency change / load study /
  // apply settings / change network path.
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState>(null);

  // Collapsed mode for the left sidebar. When true the sidebar shrinks
  // to a thin strip and the visualization panel takes the full width.
  // Toggleable from the Clear/Collapse caret rendered by `AppSidebar`.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const handleToggleSidebarCollapsed = useCallback(() => {
    setSidebarCollapsed(c => {
      const next = !c;
      interactionLogger.record('sidebar_collapsed_toggled', { collapsed: next });
      return next;
    });
  }, []);

  // Path of the network file the currently-loaded study was loaded from.
  // Updated after every successful handleLoadConfig / applySettings, used
  // by requestNetworkPathChange to detect "user is switching to a
  // different network while a study is already loaded" and prompt for
  // confirmation before silently dropping the in-flight work.
  const committedNetworkPathRef = useRef('');

  // ===== Hook integrations =====
  const actionsHook = useActions();
  const {
    selectedActionIds, manuallyAddedIds, rejectedActionIds, suggestedByRecommenderIds
  } = actionsHook;

  const analysis = useAnalysis();
  const {
    result, setResult, pendingAnalysisResult, analysisLoading,
    infoMessage, selectedOverloads, monitorDeselected,
    additionalLinesToCut, committedAdditionalLinesToCut,
  } = analysis;

  const {
    activeTab, nDiagram, n1Diagram, n1Loading,
    selectedActionId, actionDiagram, actionDiagramLoading, actionViewMode,
    inspectQuery, uniqueVoltages, voltageRange,
    vlOverlay, handleViewModeChange, handleManualZoomIn, handleManualZoomOut,
    handleManualReset, handleVlDoubleClick, handleOverlaySldTabChange, handleOverlayClose,
    inspectableItems,
    nSvgContainerRef, n1SvgContainerRef, actionSvgContainerRef,
    showVoltageLevelNames, setShowVoltageLevelNames,
  } = diagrams;

  // When a pin on the overview is single-clicked we want the sidebar
  // action feed to scroll to the matching card without selecting it
  // (which would drill into the action-variant view).  This counter-
  // based state lets ActionFeed react on every click even if the same
  // pin is tapped twice in a row (a plain id string would not trigger
  // a re-render on the second identical value).
  const [scrollTarget, setScrollTarget] = useState<{ id: string; seq: number } | null>(null);
  const scrollSeqRef = useRef(0);
  const handlePinPreview = useCallback((actionId: string) => {
    scrollSeqRef.current += 1;
    setScrollTarget({ id: actionId, seq: scrollSeqRef.current });
  }, []);

  // Shared filter state for the Remedial Action overview. The same
  // `ActionOverviewFilters` drives (a) the pin visibility + dimmed
  // un-simulated pins on ActionOverviewDiagram and (b) the card
  // visibility in the sidebar ActionFeed, so both views stay in
  // lock-step regardless of which entry point the operator uses.
  const [overviewFilters, setOverviewFilters] = useState<ActionOverviewFilters>(DEFAULT_ACTION_OVERVIEW_FILTERS);

  // Flat list of action ids that appear in `action_scores` but are
  // not yet simulated. Feeds ActionOverviewDiagram's un-simulated pin
  // layer. We dedupe across action_scores.<type>.scores to avoid
  // pinning the same id twice. Computed alongside `unsimulatedActionInfo`
  // so the two structures always stay in sync.
  const { unsimulatedActionIds, unsimulatedActionInfo } = useMemo(() => {
    const scores = analysis.result?.action_scores;
    if (!scores) return { unsimulatedActionIds: [] as string[], unsimulatedActionInfo: {} as Record<string, UnsimulatedActionScoreInfo> };
    const simulated = new Set(Object.keys(analysis.result?.actions ?? {}));
    const ids: string[] = [];
    const info: Record<string, UnsimulatedActionScoreInfo> = {};
    const seen = new Set<string>();
    for (const [type, rawData] of Object.entries(scores)) {
      const data = rawData as {
        scores?: Record<string, number>;
        mw_start?: Record<string, number | null>;
        tap_start?: Record<string, { pst_name: string; tap: number; low_tap: number | null; high_tap: number | null } | null>;
      };
      const per = data.scores ?? {};
      const mwStartMap = data.mw_start ?? {};
      const tapStartMap = data.tap_start ?? {};
      // Rank is assigned by descending score so the operator sees
      // the top-scoring un-simulated candidate as "rank 1".
      const rankedEntries = Object.entries(per).sort(([, a], [, b]) => b - a);
      const maxScoreInType = rankedEntries.length > 0 ? rankedEntries[0][1] : 0;
      const countInType = rankedEntries.length;
      for (let i = 0; i < rankedEntries.length; i++) {
        const [id, score] = rankedEntries[i];
        if (simulated.has(id) || seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
        info[id] = {
          type,
          score,
          mwStart: mwStartMap[id] ?? null,
          tapStart: tapStartMap[id] ?? null,
          rankInType: i + 1,
          countInType,
          maxScoreInType,
        };
      }
    }
    return { unsimulatedActionIds: ids, unsimulatedActionInfo: info };
  }, [analysis.result?.action_scores, analysis.result?.actions]);

  const recommenderConfig = useMemo<RecommenderDisplayConfig>(() => ({
    minLineReconnections, minCloseCoupling, minOpenCoupling,
    minLineDisconnections, minPst, minLoadShedding,
    minRenewableCurtailmentActions, minRedispatch, nPrioritizedActions, ignoreReconnections,
  }), [
    minLineReconnections, minCloseCoupling, minOpenCoupling,
    minLineDisconnections, minPst, minLoadShedding,
    minRenewableCurtailmentActions, minRedispatch, nPrioritizedActions, ignoreReconnections,
  ]);

  const session = useSession();
  const {
    showReloadModal, setShowReloadModal, sessionList, sessionListLoading, sessionRestoring
  } = session;

  // ===== Detached Visualization Tabs =====
  // `useDetachedTabs` is instantiated higher up so its map can be passed
  // into `useDiagrams` (see above). Here we wire the detach/reattach
  // callbacks that depend on diagrams (activeTab fallback logic) and
  // the interaction logger.
  const handleDetachTab = useCallback((tabId: TabId) => {
    interactionLogger.record('tab_detached', { tab: tabId });
    const entry = detachTab(tabId);
    // If the user detached the currently-active tab, switch the main
    // window to any other available tab so the main panel doesn't show
    // an empty slot by default. Prefers the first tab that is not itself
    // detached; falls back to 'n' (which is always available).
    if (entry && diagrams.activeTab === tabId) {
      const order: TabId[] = ['n', 'contingency', 'action', 'overflow'];
      const fallback = order.find(t => t !== tabId && !detachedTabs[t]);
      diagrams.setActiveTab(fallback ?? 'n');
    }
  }, [detachTab, diagrams, detachedTabs]);

  const handleReattachTab = useCallback((tabId: TabId) => {
    interactionLogger.record('tab_reattached', { tab: tabId });
    reattachTab(tabId);
  }, [reattachTab]);

  // ===== Cross-Hook Wiring wrappers (all memoized) =====

  // Clear all contingency-related analysis state (preserves network/config)
  const clearContingencyState = useCallback(() => {
    analysis.setResult(null);
    analysis.setPendingAnalysisResult(null);
    analysis.setSelectedOverloads(new Set());
    analysis.setMonitorDeselected(false);
    analysis.setAdditionalLinesToCut(new Set());
    analysis.setCommittedAdditionalLinesToCut(new Set());
    actionsHook.clearActionState();
    diagrams.setSelectedActionId(null);
    diagrams.setActionDiagram(null);
    // Do NOT reset activeTab to 'n' here — the caller (fetchN1) sets
    // it to 'contingency' immediately. Resetting to 'n' interfered with the
    // auto-zoom effect on the second contingency change.
    diagrams.setVlOverlay(null);
    // Fresh contingency / study starts in hierarchical mode so the
    // toggle matches the backend's freshly-cleared overflow cache.
    diagrams.setOverflowLayoutMode('hierarchical');
    setError('');
    analysis.setInfoMessage('');
    diagrams.setInspectQuery('');
    // Do NOT reset lastZoomState here.  Resetting it causes the auto-zoom
    // effect to detect a spurious "branch change" during the same render
    // cycle in which the old n1Diagram SVG is still mounted, firing the
    // zoom on stale data and consuming the intent before the new diagram
    // loads.  Leaving lastZoomState intact lets the natural selectedContingency
    // change trigger the zoom correctly after the new SVG is ready.
  }, [setError, actionsHook, analysis, diagrams]);

  // Narrower reset used when re-running the analysis on the SAME
  // contingency. Unlike `clearContingencyState`, this preserves any
  // manually-added ("first guess") actions so they stay in the
  // Selected Actions section through the analysis run — mirroring the
  // standalone interface, which filters result.actions down to the
  // is_manual=true subset on Analyze & Suggest instead of wiping
  // everything.
  //
  // Specifically: keeps manuallyAddedIds, keeps the selected-action
  // set restricted to manually-added IDs, and filters result.actions
  // to the is_manual subset (with pdf / lines_overloaded cleared so
  // the UI correctly shows the "analysis in progress" state).
  const resetForAnalysisRun = useCallback(() => {
    // Keep entries the operator has invested in across a re-run:
    //   - manually-added "first guess" actions (`is_manual=true`),
    //   - starred recommender suggestions (handleActionFavorite stamps
    //     `is_manual=true` on those too — but the `selectedActionIds`
    //     trim below also has to keep them for the post-step2 merge
    //     to recognise them as Selected),
    //   - rejected recommender suggestions (so the operator's veto
    //     survives the re-run — the new step2 may re-emit the id but
    //     the rejected-id set still rules).
    // Wipe pdf / lines_overloaded so the UI renders the
    // "analysis in progress" state.
    analysis.setResult(prev => {
      if (!prev) return null;
      const kept: Record<string, import('./types').ActionDetail> = {};
      for (const [id, data] of Object.entries(prev.actions || {})) {
        const userTouched =
          data.is_manual
          || actionsHook.selectedActionIds.has(id)
          || actionsHook.rejectedActionIds.has(id)
          || actionsHook.manuallyAddedIds.has(id);
        if (userTouched) kept[id] = data;
      }
      return {
        ...prev,
        actions: kept,
        lines_overloaded: [],
        pdf_url: null,
        pdf_path: null,
      };
    });
    analysis.setPendingAnalysisResult(null);
    analysis.setMonitorDeselected(false);
    // Preserve the full starred / rejected sets — only the
    // recommender-only suggestions set is wiped (step2 rebuilds it).
    actionsHook.setSuggestedByRecommenderIds(new Set());
    // Don't wipe selectedActionId if it points to an action the
    // operator has invested in — keeps the variant diagram mounted
    // through the re-run.
    const sel = diagrams.selectedActionId;
    if (
      sel
      && !actionsHook.manuallyAddedIds.has(sel)
      && !actionsHook.selectedActionIds.has(sel)
    ) {
      diagrams.setSelectedActionId(null);
      diagrams.setActionDiagram(null);
    }
    diagrams.setVlOverlay(null);
    setError('');
    analysis.setInfoMessage('');
    diagrams.setInspectQuery('');
  }, [setError, actionsHook, analysis, diagrams]);

  // Full reset: contingency state + network/diagram state
  const resetAllState = useCallback(() => {
    clearContingencyState();
    diagrams.setActiveTab('n');
    diagrams.setNDiagram(null);
    diagrams.setN1Diagram(null);
    diagrams.setOriginalViewBox(null);
    diagrams.setActionViewMode('network');
    diagrams.setShowVoltageLevelNames(true);
    diagrams.setN1Loading(false);
    diagrams.setActionDiagramLoading(false);
    diagrams.committedBranchRef.current = [];
    diagrams.actionSyncSourceRef.current = null;
    diagrams.lastZoomState.current = { query: '', branch: '' };
    setSelectedContingency([]);
    setPendingContingency([]);
    setShowMonitoringWarning(false);
    setVlToSubstation({});
    setOverflowPinsEnabled(false);
    // Dismiss any in-flight confirmation dialog. A stale "Change
    // Contingency?" dialog left over from a prior gesture (or a
    // session reload race that briefly flipped the ref window) must
    // not survive a fresh reset.
    setConfirmDialog(null);
  }, [clearContingencyState, diagrams, setShowMonitoringWarning]);

  // Sidebar visibility gates. The picker card and the action feed
  // flip together at the moment the operator has played a contingency.
  // From that point on the sticky banner echoes the contingency +
  // overload labels with its own Clear shortcut, so the picker would
  // just duplicate state — and the feed becomes useful (Analyze &
  // Suggest, manual selection, …). Pre-trigger states keep the picker
  // visible and the feed hidden so the sidebar stays focused.
  const hasCommittedContingency = selectedContingency.length > 0;
  const sidebarSwitchedToFeed = hasCommittedContingency;

  // Pre-compute the pin descriptors posted to the overflow-graph
  // iframe. Memoised so unrelated re-renders don't churn the iframe
  // postMessage. The toggle is gated on Step 2 having delivered at
  // least one action — the iframe overlay is otherwise useless.
  const overflowPinsAvailable = useMemo(
    () => !analysisLoading && !!result?.actions && Object.keys(result.actions).length > 0,
    [analysisLoading, result?.actions],
  );
  const overflowPins = useMemo(
    () => overflowPinsAvailable
      ? buildOverflowPinPayload(
          result?.actions ?? null,
          diagrams.n1MetaIndex ?? null,
          vlToSubstation,
          monitoringFactor,
          selectedActionIds,
          rejectedActionIds,
          undefined,
          overviewFilters,
        )
      : [],
    [overflowPinsAvailable, result?.actions, diagrams.n1MetaIndex, vlToSubstation,
     monitoringFactor, selectedActionIds, rejectedActionIds, overviewFilters],
  );

  // Un-simulated overflow pins. Built only when the operator has
  // ticked ``Show unsimulated`` in the Action-Overview filter row
  // (which is mirrored in the iframe sidebar's filter panel).
  // Identical contract to the Action Overview pin layer:
  //   - dimmed grey pin with '?' label,
  //   - dblclick triggers a manual simulation rather than the SLD
  //     drill-down,
  //   - skipped when the id is already in ``result.actions``.
  const overflowUnsimulatedPins = useMemo(
    () => (overflowPinsAvailable && overviewFilters?.showUnsimulated)
      ? buildOverflowUnsimulatedPinPayload(
          unsimulatedActionIds,
          new Set(Object.keys(result?.actions ?? {})),
          diagrams.n1MetaIndex ?? null,
          vlToSubstation,
          unsimulatedActionInfo,
          undefined,
          overviewFilters,
        )
      : [],
    [overflowPinsAvailable, overviewFilters,
     unsimulatedActionIds, unsimulatedActionInfo,
     result?.actions, diagrams.n1MetaIndex, vlToSubstation],
  );

  // Pin payload posted to the iframe is the union of simulated +
  // un-simulated pins. The overlay differentiates them via the
  // ``unsimulated`` flag on each pin.
  const allOverflowPins = useMemo(
    () => [...overflowPins, ...overflowUnsimulatedPins],
    [overflowPins, overflowUnsimulatedPins],
  );

  // Auto-disable the toggle when the gate goes away (e.g. user
  // applied new settings, which clears the result). Without this,
  // the toggle would stay ON but the toolbar would show 'OFF' style
  // because `overflowPinsAvailable` is false.
  useEffect(() => {
    if (!overflowPinsAvailable && overflowPinsEnabled) {
      setOverflowPinsEnabled(false);
    }
  }, [overflowPinsAvailable, overflowPinsEnabled]);

  const wrappedActionSelect = useCallback(
    (actionId: string | null) =>
      diagrams.handleActionSelect(actionId, result, selectedContingency, voltageLevels.length, setResult, setError),
    [diagrams, result, selectedContingency, voltageLevels.length, setResult, setError]
  );

  // Overflow Analysis tab's Hierarchical / Geo toggle — the hook's
  // handler needs `setResult` / `setError` to merge the new
  // pdf_url back into `analysisHook.result`, same pattern as
  // `handleActionSelect` above.
  const wrappedOverflowLayoutChange = useCallback(
    (mode: 'hierarchical' | 'geo') =>
      diagrams.handleOverflowLayoutChange(mode, setResult, setError),
    [diagrams, setResult, setError]
  );

  // Force-select variant used after a (re)simulation. This skips the
  // "already selected → deselect" toggle path in handleActionSelect so the
  // newly-simulated action diagram is always re-fetched.
  const wrappedForcedActionSelect = useCallback(
    (actionId: string | null) =>
      diagrams.handleActionSelect(actionId, result, selectedContingency, voltageLevels.length, setResult, setError, true),
    [diagrams, result, selectedContingency, voltageLevels.length, setResult, setError]
  );

  const wrappedActionFavorite = useCallback(
    (actionId: string) => {
      // Game Mode caps the number of committed (starred) actions per study.
      // Block starring a *new* action once the cap is reached; un-starring
      // and re-starring an existing pick stays allowed.
      if (
        !actionsHook.selectedActionIds.has(actionId) &&
        !gameBridge.canStarAnotherAction(actionsHook.selectedActionIds.size)
      ) {
        setError(
          `Game Mode: at most ${gameBridge.getMaxActions()} actions per study — un-star one to pick another.`,
        );
        return;
      }
      actionsHook.handleActionFavorite(actionId, setResult);
    },
    [actionsHook, setResult, setError]
  );

  // Manually-added (first-time simulated) action. Same SLD refresh
  // rationale as `wrappedActionResimulated` below: the new detail
  // carries fresh `load_shedding_details` / `curtailment_details` /
  // `pst_details` arrays which the SLD highlight pass needs to see.
  const wrappedManualActionAdded = useCallback(
    (actionId: string, detail: ActionDetail, linesOverloaded: string[], origin: string = 'user') => {
      actionsHook.handleManualActionAdded(actionId, detail, linesOverloaded, setResult, wrappedForcedActionSelect, origin);
      diagrams.refreshSldIfAction(actionId);
    },
    [actionsHook, setResult, wrappedForcedActionSelect, diagrams]
  );

  // Double-click on an un-simulated pin in ActionOverviewDiagram —
  // mirrors the Manual Selection flow in ActionFeed but without the
  // editable MW / tap inputs (those aren't available on the overview
  // pin). Uses the diagram-priming streaming endpoint so the
  // subsequent action-variant render is paint-ready instantly, same
  // as the feed add path.
  const handleSimulateUnsimulatedAction = useCallback(
    async (actionId: string) => {
      if (selectedContingency.length === 0) {
        setError('Select a contingency first.');
        return;
      }
      try {
        const response = await api.simulateAndVariantDiagramStream({
          action_id: actionId,
          disconnected_elements: selectedContingency,
          action_content: null,
          lines_overloaded: result?.lines_overloaded ?? null,
          target_mw: null,
          target_tap: null,
        });
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let metrics: Awaited<ReturnType<typeof api.simulateManualAction>> | null = null;
        let streamErr: string | null = null;
        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            // Flush any trailing content that lacked a final \n.
            // Backend always appends \n today, but this guard keeps
            // the path robust if a future change emits a final
            // event without one.
            if (buffer.trim()) {
              try {
                const event = JSON.parse(buffer) as Record<string, unknown>;
                if (event.type === 'metrics') {
                  const { type: _t, ...rest } = event;
                  void _t;
                  metrics = rest as Awaited<ReturnType<typeof api.simulateManualAction>>;
                } else if (event.type === 'diagram') {
                  const { type: _t, ...rest } = event;
                  void _t;
                  diagrams.primeActionDiagram(actionId, rest as unknown as DiagramData & { svg: string }, voltageLevels.length);
                } else if (event.type === 'error') {
                  streamErr = (event.message as string) || 'stream error';
                }
              } catch { /* ignore malformed trailing bytes */ }
            }
            break;
          }
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop()!;
          for (const line of lines) {
            if (!line.trim()) continue;
            let event: Record<string, unknown>;
            try { event = JSON.parse(line); } catch { continue; }
            if (event.type === 'metrics') {
              const { type: _t, ...rest } = event;
              void _t;
              metrics = rest as Awaited<ReturnType<typeof api.simulateManualAction>>;
            } else if (event.type === 'diagram') {
              const { type: _t, ...rest } = event;
              void _t;
              diagrams.primeActionDiagram(actionId, rest as unknown as DiagramData & { svg: string }, voltageLevels.length);
            } else if (event.type === 'error') {
              streamErr = (event.message as string) || 'stream error';
            }
          }
        }
        if (streamErr) throw new Error(streamErr);
        if (!metrics) throw new Error('Stream ended without metrics event');
        const detail: ActionDetail = {
          description_unitaire: metrics.description_unitaire,
          rho_before: metrics.rho_before,
          rho_after: metrics.rho_after,
          max_rho: metrics.max_rho,
          max_rho_line: metrics.max_rho_line,
          is_rho_reduction: metrics.is_rho_reduction,
          is_islanded: metrics.is_islanded,
          n_components: metrics.n_components,
          disconnected_mw: metrics.disconnected_mw,
          non_convergence: metrics.non_convergence,
          lines_overloaded_after: metrics.lines_overloaded_after,
          load_shedding_details: metrics.load_shedding_details,
          curtailment_details: metrics.curtailment_details,
          redispatch_details: metrics.redispatch_details,
          pst_details: metrics.pst_details,
        };
        // An unsimulated pin is a scored-but-not-yet-materialised
        // action from the recommender's score table — the operator
        // only triggered its simulation, so its provenance is the
        // model that scored it, NOT "user".
        wrappedManualActionAdded(
          actionId, detail, metrics.lines_overloaded || [], result?.active_model || 'expert',
        );
      } catch (e: unknown) {
        console.error('Unsimulated pin simulation failed:', e);
        const err = e as { response?: { data?: { detail?: string } } };
        setError(err?.response?.data?.detail || 'Simulation failed');
      }
    },
    [selectedContingency, result?.lines_overloaded, result?.active_model, diagrams, voltageLevels.length, wrappedManualActionAdded]
  );

  // Interactive SLD topology edit (useSldTopologyEdit). The baseline
  // is the ``switch_states`` map the backend stamps on every SLD
  // response; the hook drops stale toggles when it changes (VL switch,
  // tab switch, action variant change).
  const sldTopologyEdit = useSldTopologyEdit(diagrams.vlOverlay?.switch_states, diagrams.vlOverlay?.injections);
  const [sldEditBusy, setSldEditBusy] = useState(false);
  // Auto-enable edit mode the first time an editable SLD (a non-N tab
  // carrying operable switches or editable injections) loads, so the
  // operator can manipulate breakers / loads / generators straight from
  // the opened diagram without first clicking "Manual action". Keyed on
  // the SLD identity so turning edit off stays sticky until the VL / tab
  // / action changes.
  const autoEnabledSldSigRef = useRef<string | null>(null);
  useEffect(() => {
    const ov = diagrams.vlOverlay;
    if (!ov || ov.loading) return;
    const editable = ov.tab !== 'n' && (
      (!!ov.switch_states && Object.keys(ov.switch_states).length > 0)
      || (!!ov.injections && Object.keys(ov.injections).length > 0)
    );
    if (editable) {
      const sig = `${ov.vlName}|${ov.tab}|${ov.actionId ?? ''}`;
      if (autoEnabledSldSigRef.current !== sig) {
        autoEnabledSldSigRef.current = sig;
        sldTopologyEdit.setEditMode(true);
      }
    } else {
      autoEnabledSldSigRef.current = null;
      // The N state can't host a manual action — keep it read-only.
      if (ov.tab === 'n' && sldTopologyEdit.editMode) sldTopologyEdit.setEditMode(false);
    }
    // `setEditMode` is a stable useCallback and `editMode` is read for the
    // N-tab reset guard; depending on the whole `sldTopologyEdit` object
    // (recreated each render) would only add churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diagrams.vlOverlay, sldTopologyEdit.setEditMode, sldTopologyEdit.editMode]);
  const sldEditBaseActionId = useMemo(() => {
    const overlay = diagrams.vlOverlay;
    if (!overlay) return null;
    if (overlay.tab !== 'action') return null;
    return overlay.actionId && overlay.actionId.length > 0 ? overlay.actionId : null;
  }, [diagrams.vlOverlay]);

  // Target-topology preview: when the operator has staged switch
  // toggles, fetch a re-rendered SLD (target switch states +
  // topological-colouring connectivity, no load flow) and show it in
  // place of the baseline. Debounced so dragging through several
  // toggles fires one request; a sequence guard drops stale responses.
  const [sldPreview, setSldPreview] = useState<{ svg: string; metadata: string | null } | null>(null);
  const [sldPreviewLoading, setSldPreviewLoading] = useState(false);
  const sldPreviewSeqRef = useRef(0);
  const changedSwitchesKey = useMemo(
    () => JSON.stringify(sldTopologyEdit.changedSwitches),
    [sldTopologyEdit.changedSwitches],
  );
  useEffect(() => {
    const overlay = diagrams.vlOverlay;
    const switches = sldTopologyEdit.changedSwitches;
    const vlName = overlay?.vlName;
    if (!overlay || !sldTopologyEdit.editMode || !vlName || Object.keys(switches).length === 0) {
      setSldPreview(null);
      setSldPreviewLoading(false);
      return;
    }
    const seq = ++sldPreviewSeqRef.current;
    setSldPreviewLoading(true);
    const timer = setTimeout(async () => {
      try {
        const res = await api.getSldTopologyPreview({
          voltageLevelId: vlName,
          disconnectedElements: selectedContingency,
          switches,
          baseActionId: sldEditBaseActionId,
        });
        if (seq !== sldPreviewSeqRef.current) return;
        setSldPreview({ svg: res.svg, metadata: res.sld_metadata ?? null });
      } catch (e) {
        if (seq !== sldPreviewSeqRef.current) return;
        console.error('SLD topology preview failed:', e);
        setSldPreview(null);
      } finally {
        if (seq === sldPreviewSeqRef.current) setSldPreviewLoading(false);
      }
    }, 280);
    return () => clearTimeout(timer);
    // changedSwitchesKey captures the switches dict by value; vlName +
    // editMode + baseAction are the other inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [changedSwitchesKey, sldTopologyEdit.editMode, diagrams.vlOverlay?.vlName, sldEditBaseActionId, selectedContingency]);

  const handleSimulateSldEdit = useCallback(async () => {
    const overlay = diagrams.vlOverlay;
    const switches = sldTopologyEdit.changedSwitches;
    const injections = sldTopologyEdit.changedInjections;
    const hasSwitches = Object.keys(switches).length > 0;
    const hasInjections = Object.keys(injections).length > 0;
    if (!overlay || (!hasSwitches && !hasInjections)) return;
    if (selectedContingency.length === 0) {
      setError('Select a contingency first.');
      return;
    }
    const vlName = overlay.vlName;
    const ts = Date.now();
    const userPart = `user_topo_${vlName}_${ts}`;
    const baseActionId = sldEditBaseActionId;
    const actionId = baseActionId ? `${baseActionId}+${userPart}` : userPart;
    // Split the staged injection retunes into the per-kind content keys the
    // backend expects (gens_p / loads_p → set_gen_p / set_load_p).
    const gensP: Record<string, number> = {};
    const loadsP: Record<string, number> = {};
    for (const ic of sldTopologyEdit.injectionChanges) {
      if (ic.kind === 'generator') gensP[ic.equipmentId] = ic.targetP;
      else loadsP[ic.equipmentId] = ic.targetP;
    }
    const actionContent: {
      switches?: Record<string, boolean>;
      gens_p?: Record<string, number>;
      loads_p?: Record<string, number>;
    } = {};
    if (hasSwitches) actionContent.switches = switches;
    if (Object.keys(gensP).length > 0) actionContent.gens_p = gensP;
    if (Object.keys(loadsP).length > 0) actionContent.loads_p = loadsP;
    interactionLogger.record('sld_topology_simulated', {
      voltage_level_id: vlName,
      switches,
      injections,
      combined_with: baseActionId,
    });
    setSldEditBusy(true);
    try {
      const response = await api.simulateAndVariantDiagramStream({
        action_id: actionId,
        disconnected_elements: selectedContingency,
        action_content: actionContent,
        lines_overloaded: result?.lines_overloaded ?? null,
        target_mw: null,
        target_tap: null,
        voltage_level_id: vlName,
      });
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let metrics: Awaited<ReturnType<typeof api.simulateManualAction>> | null = null;
      let streamErr: string | null = null;
      const parseEvent = (line: string) => {
        if (!line.trim()) return;
        let event: Record<string, unknown>;
        try { event = JSON.parse(line); } catch { return; }
        if (event.type === 'metrics') {
          const { type: _t, ...rest } = event;
          void _t;
          metrics = rest as Awaited<ReturnType<typeof api.simulateManualAction>>;
        } else if (event.type === 'diagram') {
          const { type: _t, ...rest } = event;
          void _t;
          // The backend canonicalises combined ids (sorts the "+"
          // parts), so register the diagram under the id it actually
          // stored — taken from the metrics event that always precedes
          // the diagram event — not the raw request id.
          const registeredId = metrics?.action_id ?? actionId;
          diagrams.primeActionDiagram(registeredId, rest as unknown as DiagramData & { svg: string }, voltageLevels.length);
        } else if (event.type === 'error') {
          streamErr = (event.message as string) || 'stream error';
        }
      };
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          if (buffer.trim()) parseEvent(buffer);
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop()!;
        for (const line of lines) parseEvent(line);
      }
      if (streamErr) throw new Error(streamErr);
      if (!metrics) throw new Error('Stream ended without metrics event');
      const m = metrics as Awaited<ReturnType<typeof api.simulateManualAction>>;
      // Backend-canonical id (sorted "+" parts) — use it for the card
      // and the action-tab focus so every later lookup matches.
      const registeredId = m.action_id || actionId;
      const detail: ActionDetail = {
        description_unitaire: m.description_unitaire,
        rho_before: m.rho_before,
        rho_after: m.rho_after,
        max_rho: m.max_rho,
        max_rho_line: m.max_rho_line,
        is_rho_reduction: m.is_rho_reduction,
        is_islanded: m.is_islanded,
        n_components: m.n_components,
        disconnected_mw: m.disconnected_mw,
        non_convergence: m.non_convergence,
        lines_overloaded_after: m.lines_overloaded_after,
        load_shedding_details: m.load_shedding_details,
        curtailment_details: m.curtailment_details,
        redispatch_details: m.redispatch_details,
        pst_details: m.pst_details,
      };
      wrappedManualActionAdded(registeredId, detail, m.lines_overloaded || [], 'user');
      sldTopologyEdit.reset();
      sldTopologyEdit.setEditMode(false);
      // Switch the SLD overlay straight to the ACTION tab for the
      // freshly-computed action so the operator sees the post-action
      // state instead of staying on N-1.
      handleVlDoubleClick(registeredId, vlName, 'action');
    } catch (e: unknown) {
      console.error('SLD topology edit simulation failed:', e);
      const err = e as { response?: { data?: { detail?: string } } };
      setError(err?.response?.data?.detail || 'Simulation failed');
    } finally {
      setSldEditBusy(false);
    }
  }, [
    diagrams, sldTopologyEdit, selectedContingency, sldEditBaseActionId,
    result?.lines_overloaded, voltageLevels.length, wrappedManualActionAdded,
    handleVlDoubleClick,
  ]);

  // Re-simulation of an already-present action (edit Target MW / tap on a
  // suggested card). Does NOT move the action into the selected bucket.
  //
  // When the SLD overlay is open on this action, refresh it so the
  // per-equipment load-shedding / curtailment / PST highlights (and the
  // flow deltas baked into the backend SLD response) reflect the new
  // simulation result instead of the pre-resimulation snapshot.
  // Covers all three editable action families: MW edits on load-shedding
  // and renewable-curtailment, and tap edits on PST — all three flow
  // through `onActionResimulated` in ActionFeed.tsx, so one refresh
  // hook-up covers them.
  const wrappedActionResimulated = useCallback(
    (actionId: string, detail: ActionDetail, linesOverloaded: string[]) => {
      actionsHook.handleActionResimulated(actionId, detail, linesOverloaded, setResult, wrappedForcedActionSelect);
      diagrams.refreshSldIfAction(actionId);
    },
    [actionsHook, setResult, wrappedForcedActionSelect, diagrams]
  );

  const handleUpdateCombinedEstimation = useCallback(
    (pairId: string, estimation: { estimated_max_rho: number; estimated_max_rho_line: string }) => {
      console.log('[handleUpdateCombinedEstimation] called with pairId:', pairId, 'estimation:', estimation);
      setResult(prev => {
        console.log('[handleUpdateCombinedEstimation] prev combined_actions keys:',
          prev?.combined_actions ? Object.keys(prev.combined_actions) : 'null',
          'pairId exists:', !!prev?.combined_actions?.[pairId]);
        if (!prev?.combined_actions?.[pairId]) return prev;
        return {
          ...prev,
          combined_actions: {
            ...prev.combined_actions,
            [pairId]: { ...prev.combined_actions[pairId], ...estimation },
          },
        };
      });
    },
    [setResult]
  );

  const wrappedRunAnalysis = useCallback(
    () => analysis.handleRunAnalysis(selectedContingency, resetForAnalysisRun, actionsHook.setSuggestedByRecommenderIds, diagrams.setActiveTab),
    [analysis, selectedContingency, resetForAnalysisRun, actionsHook.setSuggestedByRecommenderIds, diagrams.setActiveTab]
  );

  // Wipe recommender-produced suggestions the operator has NOT
  // interacted with. Keeps starred (selectedActionIds), rejected
  // (rejectedActionIds) and manually-added (manuallyAddedIds /
  // is_manual) entries intact so the user can re-run with a
  // different model without losing their decisions. Tracking
  // ``suggestedByRecommenderIds`` (the source-of-truth set populated
  // during the step-2 stream) keeps us from accidentally dropping
  // manual-only entries that happen to share an id with a previous
  // recommender suggestion. This does NOT re-run the analysis — the
  // operator clears, optionally swaps the model, then presses
  // Analyze & Suggest themselves.
  const performClearSuggested = useCallback(() => {
    interactionLogger.record('suggested_actions_cleared', {
      n_cleared: Array.from(suggestedByRecommenderIds).filter(id =>
        !selectedActionIds.has(id) && !rejectedActionIds.has(id) && !manuallyAddedIds.has(id)
      ).length,
    });
    setResult(prev => {
      if (!prev?.actions) return prev;
      const filtered: Record<string, import('./types').ActionDetail> = {};
      for (const [id, data] of Object.entries(prev.actions)) {
        const userTouched = selectedActionIds.has(id) || rejectedActionIds.has(id) || manuallyAddedIds.has(id) || data.is_manual;
        const isSuggested = suggestedByRecommenderIds.has(id);
        if (userTouched || !isSuggested) filtered[id] = data;
      }
      return { ...prev, actions: filtered, active_model: undefined };
    });
    actionsHook.setSuggestedByRecommenderIds(prev => {
      const next = new Set<string>();
      for (const id of prev) {
        if (selectedActionIds.has(id) || rejectedActionIds.has(id) || manuallyAddedIds.has(id)) next.add(id);
      }
      return next;
    });
    analysis.setPendingAnalysisResult(null);
  }, [setResult, actionsHook, analysis, selectedActionIds, rejectedActionIds, manuallyAddedIds, suggestedByRecommenderIds]);

  // The Clear button opens a confirmation dialog first (reusing the
  // shared <ConfirmationDialog/> template) so the operator sees
  // exactly what is removed and what is kept before committing.
  const requestClearSuggested = useCallback(() => {
    setConfirmDialog({ type: 'clearSuggested' });
  }, []);

  const wrappedDisplayPrioritized = useCallback(
    () => analysis.handleDisplayPrioritizedActions(selectedActionIds, diagrams.setActiveTab),
    [analysis, selectedActionIds, diagrams.setActiveTab]
  );

  const wrappedAssetClick = useCallback(
    (actionId: string, assetName: string, tab: 'action' | 'n' | 'contingency' = 'action') =>
      diagrams.handleAssetClick(actionId, assetName, tab, diagrams.selectedActionId, wrappedActionSelect),
    [diagrams, wrappedActionSelect]
  );

  // Zoom the currently-active diagram tab on a named asset without
  // switching tabs. Used by the sticky Contingency and Overloads
  // sections: operators want to keep the view they're on (N / N-1 /
  // Action) and just focus the clicked line in place.
  const handleZoomOnActiveTab = useCallback((assetName: string) => {
    if (!assetName) return;
    const tab = diagrams.activeTab;
    if (tab === 'overflow') return;
    interactionLogger.record('asset_clicked', { action_id: '', asset_name: assetName, tab });
    // Update inspectQuery (so the inspect overlay, if open, reflects
    // the focus) AND call zoomToElement directly — the auto-zoom effect
    // skips no-op query changes, whereas we want re-clicking the same
    // line to re-center the view.
    diagrams.setInspectQueryForTab(tab, assetName);
    diagrams.zoomToElement(assetName, tab);
  }, [diagrams]);

  const saveParams = useMemo(() => ({
    networkPath, actionPath, layoutPath, outputFolderPath,
    minLineReconnections, minCloseCoupling, minOpenCoupling,
    minLineDisconnections, minPst, minLoadShedding,
    minRenewableCurtailmentActions, minRedispatch, allowedActionTypes, nPrioritizedActions,
    linesMonitoringPath, monitoringFactor,
    preExistingOverloadThreshold, ignoreReconnections, pypowsyblFastMode,
    selectedBranch: selectedContingency.join('+'),
    selectedContingency,
    selectedOverloads, monitorDeselected,
    committedAdditionalLinesToCut,
    nOverloads: nDiagram?.lines_overloaded ?? [],
    n1Overloads: n1Diagram?.lines_overloaded ?? [],
    nOverloadsRho: nDiagram?.lines_overloaded_rho,
    n1OverloadsRho: n1Diagram?.lines_overloaded_rho,
    result, selectedActionIds, rejectedActionIds,
    manuallyAddedIds, suggestedByRecommenderIds,
    setError, setInfoMessage: analysis.setInfoMessage,
  }), [
    networkPath, actionPath, layoutPath, outputFolderPath,
    minLineReconnections, minCloseCoupling, minOpenCoupling,
    minLineDisconnections, minPst, minLoadShedding,
    minRenewableCurtailmentActions, minRedispatch, allowedActionTypes, nPrioritizedActions,
    linesMonitoringPath, monitoringFactor,
    preExistingOverloadThreshold, ignoreReconnections, pypowsyblFastMode,
    selectedContingency, selectedOverloads, monitorDeselected,
    committedAdditionalLinesToCut,
    nDiagram, n1Diagram,
    result, selectedActionIds, rejectedActionIds,
    manuallyAddedIds, suggestedByRecommenderIds,
    setError, analysis.setInfoMessage,
  ]);

  const wrappedSaveResults = useCallback(
    () => session.handleSaveResults(saveParams),
    [session, saveParams]
  );

  const wrappedOpenReloadModal = useCallback(
    () => session.handleOpenReloadModal(outputFolderPath, setError),
    [session, outputFolderPath, setError]
  );

  const restoreContext = useMemo(() => ({
    outputFolderPath,
    setNetworkPath, setActionPath, setLayoutPath,
    setMinLineReconnections, setMinCloseCoupling, setMinOpenCoupling,
    setMinLineDisconnections, setMinPst, setMinLoadShedding,
    setMinRenewableCurtailmentActions, setMinRedispatch, setAllowedActionTypes, setNPrioritizedActions,
    setLinesMonitoringPath, setMonitoringFactor, setPreExistingOverloadThreshold,
    setIgnoreReconnections, setPypowsyblFastMode,
    setMonitorDeselected: analysis.setMonitorDeselected,
    setSelectedOverloads: analysis.setSelectedOverloads,
    setCommittedAdditionalLinesToCut: analysis.setCommittedAdditionalLinesToCut,
    setResult,
    setSelectedActionIds: actionsHook.setSelectedActionIds,
    setRejectedActionIds: actionsHook.setRejectedActionIds,
    setManuallyAddedIds: actionsHook.setManuallyAddedIds,
    setSuggestedByRecommenderIds: actionsHook.setSuggestedByRecommenderIds,
    setSelectedContingency,
    setPendingContingency,
    resetAllState,
    restoringSessionRef: diagrams.restoringSessionRef,
    committedBranchRef: diagrams.committedBranchRef,
    committedNetworkPathRef,
    setError, setInfoMessage: analysis.setInfoMessage,
    applyConfigResponse, setBranches, setVoltageLevels, setNameMap,
    setNominalVoltageMap: diagrams.setNominalVoltageMap,
    setUniqueVoltages: diagrams.setUniqueVoltages,
    fetchBaseDiagram: diagrams.fetchBaseDiagram,
    ingestBaseDiagram: diagrams.ingestBaseDiagram,
    setVoltageRange: diagrams.setVoltageRange,
  }), [
    outputFolderPath,
    setNetworkPath, setActionPath, setLayoutPath,
    setMinLineReconnections, setMinCloseCoupling, setMinOpenCoupling,
    setMinLineDisconnections, setMinPst, setMinLoadShedding,
    setMinRenewableCurtailmentActions, setMinRedispatch, setAllowedActionTypes, setNPrioritizedActions,
    setLinesMonitoringPath, setMonitoringFactor, setPreExistingOverloadThreshold,
    setIgnoreReconnections, setPypowsyblFastMode,
    analysis, actionsHook, setResult, setSelectedContingency, setPendingContingency, resetAllState,
    diagrams, setError, applyConfigResponse, setBranches, setVoltageLevels, setNameMap,
  ]);

  const wrappedRestoreSession = useCallback(
    (sessionName: string) => session.handleRestoreSession(sessionName, restoreContext),
    [session, restoreContext]
  );

  // Check if there is any analysis state that would be lost on contingency change
  const hasAnalysisState = useCallback(() => {
    return !!(result || pendingAnalysisResult || selectedActionId || actionDiagram || manuallyAddedIds.size > 0 || selectedActionIds.size > 0 || rejectedActionIds.size > 0);
  }, [result, pendingAnalysisResult, selectedActionId, actionDiagram, manuallyAddedIds, selectedActionIds, rejectedActionIds]);

  // Sidebar-banner Clear button: drops the current contingency and
  // returns to the picker. Routes through the contingency confirmation
  // dialog when analysis state would otherwise be lost; clears
  // directly otherwise (mirroring the picker-driven flow's gating).
  const requestClearContingency = useCallback(() => {
    interactionLogger.record('contingency_clear_requested', {
      had_analysis_state: hasAnalysisState(),
    });
    if (hasAnalysisState()) {
      setConfirmDialog({ type: 'contingency', pendingBranch: '' });
      return;
    }
    clearContingencyState();
    setSelectedContingency([]);
    setPendingContingency([]);
  }, [hasAnalysisState, clearContingencyState]);

  // Full-fidelity snapshot of every parameter an agent would need to
  // replay a config-loaded / settings-applied gesture. Per the
  // interaction-logging replay contract each event must carry ALL
  // inputs — "click Load Study" alone is not enough, the agent has
  // to know which paths and recommender thresholds to type in first.
  const buildConfigInteractionDetails = useCallback((): Record<string, unknown> => ({
    network_path: networkPath,
    action_file_path: actionPath,
    layout_path: layoutPath,
    output_folder_path: outputFolderPath,
    min_line_reconnections: minLineReconnections,
    min_close_coupling: minCloseCoupling,
    min_open_coupling: minOpenCoupling,
    min_line_disconnections: minLineDisconnections,
    min_pst: minPst,
    min_load_shedding: minLoadShedding,
    min_renewable_curtailment_actions: minRenewableCurtailmentActions,
    min_redispatch: minRedispatch,
    allowed_action_types: allowedActionTypes,
    n_prioritized_actions: nPrioritizedActions,
    lines_monitoring_path: linesMonitoringPath,
    monitoring_factor: monitoringFactor,
    pre_existing_overload_threshold: preExistingOverloadThreshold,
    ignore_reconnections: ignoreReconnections,
    pypowsybl_fast_mode: pypowsyblFastMode,
  }), [
    networkPath, actionPath, layoutPath, outputFolderPath,
    minLineReconnections, minCloseCoupling, minOpenCoupling,
    minLineDisconnections, minPst, minLoadShedding,
    minRenewableCurtailmentActions, minRedispatch, allowedActionTypes, nPrioritizedActions,
    linesMonitoringPath, monitoringFactor, preExistingOverloadThreshold,
    ignoreReconnections, pypowsyblFastMode,
  ]);


  const applySettingsImmediate = useCallback(async () => {
    // settings_applied carries the full settings payload so a replay
    // agent can populate every field before clicking Apply. It's
    // treated as a wait-point by consumers of the log: the next
    // action must wait until the network reload (network, branches,
    // voltage levels) has finished.
    interactionLogger.record('settings_applied', buildConfigInteractionDetails());
    try {
      resetAllState();

      if (!networkPath || !actionPath) {
        setSettingsBackup(createCurrentBackup());
        setIsSettingsOpen(false);
        return;
      }

      // If the config file path changed, load the new file FIRST and use
      // the resolved `UserConfig` directly to drive `api.updateConfig` —
      // the React state queued by `applyLoadedConfig` inside
      // `changeConfigFilePath` has not flushed yet, so reading via
      // `buildConfigRequest()` here would replay the previous render's
      // values and silently send the OLD config to the backend (which
      // the auto-save effect would then persist back into the loaded
      // file, undoing the operator's selection — see the regression
      // test in `configUpload.repro.test.tsx`, fixed 2026-05-08).
      let freshlyLoadedCfg: import('./api').UserConfig | null = null;
      if (configFilePath && configFilePath !== lastActiveConfigFilePath) {
        freshlyLoadedCfg = await changeConfigFilePath(configFilePath);
      }

      const configRequest = freshlyLoadedCfg
        ? configRequestFromUserConfig(freshlyLoadedCfg)
        : buildConfigRequest();
      const configRes = await api.updateConfig(configRequest);
      applyConfigResponse(configRes as Record<string, unknown>);

      // Fire the 4 post-config XHRs in parallel. The base-diagram call is
      // the slowest (~6-7s pypowsybl NAD on large grids) and previously
      // only started after branches resolved — wasting the ~0.8s branches
      // gap off the critical path of the initial load.
      // See docs/performance/history/loading-parallel.md.
      const [branchRes, vlRes, nomVRes, diagramRaw, vlSubRes] = await Promise.all([
        api.getBranches(),
        api.getVoltageLevels(),
        api.getNominalVoltages(),
        api.getNetworkDiagram(),
        // Cheap query (~1 ms even on PyPSA-EUR France); pulled in
        // parallel so it never extends the critical path. Used to
        // anchor overflow-graph action pins on substations.
        api.getVoltageLevelSubstations().catch(() => ({ mapping: {} as Record<string, string> })),
      ]);

      setBranches(branchRes.branches);
      setVoltageLevels(vlRes.voltage_levels);
      // Merge element + VL name maps into a single lookup
      setNameMap({ ...branchRes.name_map, ...vlRes.name_map });
      setSelectedContingency([]);
      setPendingContingency([]);

      diagrams.setNominalVoltageMap(nomVRes.mapping);
      diagrams.setUniqueVoltages(nomVRes.unique_kv);
      if (nomVRes.unique_kv.length > 0) {
        diagrams.setVoltageRange([nomVRes.unique_kv[0], nomVRes.unique_kv[nomVRes.unique_kv.length - 1]]);
      }

      diagrams.ingestBaseDiagram(diagramRaw, vlRes.voltage_levels.length);
      setVlToSubstation(vlSubRes.mapping || {});

      committedNetworkPathRef.current = networkPath;
      interactionLogger.record('config_loaded', buildConfigInteractionDetails());
      setSettingsBackup(createCurrentBackup());
      setIsSettingsOpen(false);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { detail?: string } }; message?: string };
      setError('Failed to apply settings: ' + (e.response?.data?.detail || e.message));
    }
  }, [networkPath, actionPath, buildConfigRequest, configRequestFromUserConfig, applyConfigResponse, createCurrentBackup, setError, setSettingsBackup, setIsSettingsOpen, diagrams, configFilePath, lastActiveConfigFilePath, changeConfigFilePath, resetAllState, buildConfigInteractionDetails]);

  // Apply Settings entry point used by the Settings modal. If a study
  // is already loaded — whether or not analysis has been run yet — we
  // route through the same confirmation dialog as the "Load Study"
  // button. Applying any settings (in particular changing the config
  // file path) silently reloads the network and drops the in-flight
  // study, so the user must be warned even when only a base network
  // is loaded with no analysis state.
  const handleApplySettingsClick = useCallback(() => {
    if (hasAnalysisState() || committedNetworkPathRef.current) {
      setConfirmDialog({ type: 'applySettings' });
      return;
    }
    applySettingsImmediate();
  }, [hasAnalysisState, applySettingsImmediate]);



  const handleLoadConfig = useCallback(async () => {
    setConfigLoading(true);
    resetAllState();

    try {
      // Same stale-closure trap as applySettingsImmediate — see the long
      // comment there. After `changeConfigFilePath` resolves, the fresh
      // `UserConfig` it returns is the source of truth for
      // `api.updateConfig`; `buildConfigRequest()` would silently replay
      // the previous render's React state.
      let freshlyLoadedCfg: import('./api').UserConfig | null = null;
      if (configFilePath && configFilePath !== lastActiveConfigFilePath) {
        freshlyLoadedCfg = await changeConfigFilePath(configFilePath);
      }
      const configRequest = freshlyLoadedCfg
        ? configRequestFromUserConfig(freshlyLoadedCfg)
        : buildConfigRequest();
      const configRes = await api.updateConfig(configRequest);
      applyConfigResponse(configRes as Record<string, unknown>);

      // See the sibling call site in `applySettingsImmediate` for context:
      // fire 4 XHRs in parallel so the slow base-diagram call overlaps
      // with branches/voltage-levels/nominal-voltages.
      const [branchRes, vlRes, nomVRes, diagramRaw, vlSubRes] = await Promise.all([
        api.getBranches(),
        api.getVoltageLevels(),
        api.getNominalVoltages(),
        api.getNetworkDiagram(),
        // Cheap query (~1 ms even on PyPSA-EUR France); pulled in
        // parallel so it never extends the critical path. Used to
        // anchor overflow-graph action pins on substations.
        api.getVoltageLevelSubstations().catch(() => ({ mapping: {} as Record<string, string> })),
      ]);

      setBranches(branchRes.branches);
      setVoltageLevels(vlRes.voltage_levels);
      setNameMap({ ...branchRes.name_map, ...vlRes.name_map });
      setSelectedContingency([]);
      setPendingContingency([]);

      diagrams.setNominalVoltageMap(nomVRes.mapping);
      diagrams.setUniqueVoltages(nomVRes.unique_kv);
      if (nomVRes.unique_kv.length > 0) {
        diagrams.setVoltageRange([nomVRes.unique_kv[0], nomVRes.unique_kv[nomVRes.unique_kv.length - 1]]);
      }

      diagrams.ingestBaseDiagram(diagramRaw, vlRes.voltage_levels.length);
      setVlToSubstation(vlSubRes.mapping || {});
      committedNetworkPathRef.current = networkPath;
      interactionLogger.record('config_loaded', buildConfigInteractionDetails());
    } catch (err: unknown) {
      const e = err as { response?: { data?: { detail?: string } }; message?: string };
      setError('Failed to load config: ' + (e.response?.data?.detail || e.message));
    } finally {
      setConfigLoading(false);
    }
  }, [buildConfigRequest, configRequestFromUserConfig, applyConfigResponse, setError, diagrams, networkPath, configFilePath, lastActiveConfigFilePath, changeConfigFilePath, resetAllState, buildConfigInteractionDetails]);


  const handleLoadStudyClick = useCallback(() => {
    if (hasAnalysisState()) {
      setConfirmDialog({ type: 'loadStudy' });
    } else {
      handleLoadConfig();
    }
  }, [hasAnalysisState, handleLoadConfig]);

  // Network path commit pipeline used by the Header (file picker AND
  // input blur). When a study is already loaded and the path is being
  // changed to a different value, prompt for confirmation before
  // silently dropping the in-flight study. The setNetworkPath call is
  // optimistic — it makes the input immediately reflect the new path
  // even while the dialog is open — and is reverted by
  // handleCancelDialog if the user backs out.
  const requestNetworkPathChange = useCallback((newPath: string) => {
    setNetworkPath(newPath);
    const trimmed = newPath.trim();
    if (!trimmed) return;
    if (trimmed === committedNetworkPathRef.current) return;
    // Only warn once a study has actually been loaded — initial path
    // entry on an empty session must not trigger the dialog.
    if (!committedNetworkPathRef.current) return;
    setConfirmDialog({ type: 'changeNetwork', pendingNetworkPath: trimmed });
  }, [setNetworkPath]);

  const handleConfirmDialog = useCallback(() => {
    if (!confirmDialog) return;
    // `clearSuggested` is not a study-reset gesture — it keeps the
    // network, the contingency, and the operator's decisions. It logs
    // its own `suggested_actions_cleared` event inside
    // `performClearSuggested`, so skip the `contingency_confirmed` log.
    if (confirmDialog.type === 'clearSuggested') {
      performClearSuggested();
      setConfirmDialog(null);
      return;
    }
    interactionLogger.record('contingency_confirmed', { type: confirmDialog.type, pending_branch: confirmDialog.pendingBranch });
    if (confirmDialog.type === 'contingency') {
      clearContingencyState();
      const pending = confirmDialog.pendingBranch
        ? confirmDialog.pendingBranch.split('+').filter(Boolean)
        : [];
      setSelectedContingency(pending);
      setPendingContingency(pending);
    } else if (confirmDialog.type === 'applySettings') {
      applySettingsImmediate();
    } else if (confirmDialog.type === 'changeNetwork') {
      // pendingNetworkPath was already setNetworkPath'd by
      // requestNetworkPathChange. Reload the config so the backend
      // picks up the new file.
      handleLoadConfig();
    } else {
      handleLoadConfig();
    }
    setConfirmDialog(null);
  }, [confirmDialog, clearContingencyState, handleLoadConfig, applySettingsImmediate, performClearSuggested]);


  // ===== App-Level Effects =====

  useEffect(() => {
    diagrams.selectedContingencyForSld.current = selectedContingency;
  }, [selectedContingency, diagrams.selectedContingencyForSld]);


  useContingencyFetch({
    selectedContingency,
    branches,
    voltageLevelsLength: voltageLevels.length,
    diagrams,
    analysisLoading,
    hasAnalysisState,
    clearContingencyState,
    setSelectedContingency,
    setConfirmDialog,
    setError,
  });

  // ===== Game Mode integration =====
  // Drives the workspace from the Game shell (load a study's network +
  // contingency) and publishes the physical result back so the shell can
  // score it. The whole block is inert unless launched with `?game=1`.

  // Load a study: swap network + action catalogue, then arm its contingency.
  // Mirrors handleLoadConfig but builds the config request explicitly from
  // the study so it doesn't depend on not-yet-flushed settings state.
  const loadGameStudy = useCallback(async (study: GameStudy) => {
    setConfigLoading(true);
    resetAllState();
    // Reflect the study paths in Settings so save/persist stays coherent.
    setNetworkPath(study.networkPath);
    setActionPath(study.actionFilePath);
    if (study.layoutPath !== undefined) setLayoutPath(study.layoutPath);
    if (study.linesMonitoringPath !== undefined) setLinesMonitoringPath(study.linesMonitoringPath);
    try {
      const configRequest = {
        ...buildConfigRequest(),
        network_path: study.networkPath,
        action_file_path: study.actionFilePath,
        layout_path: study.layoutPath ?? '',
        ...(study.linesMonitoringPath !== undefined
          ? { lines_monitoring_path: study.linesMonitoringPath }
          : {}),
      };
      const configRes = await api.updateConfig(configRequest);
      applyConfigResponse(configRes as Record<string, unknown>);

      const [branchRes, vlRes, nomVRes, diagramRaw, vlSubRes] = await Promise.all([
        api.getBranches(),
        api.getVoltageLevels(),
        api.getNominalVoltages(),
        api.getNetworkDiagram(),
        api.getVoltageLevelSubstations().catch(() => ({ mapping: {} as Record<string, string> })),
      ]);

      setBranches(branchRes.branches);
      setVoltageLevels(vlRes.voltage_levels);
      setNameMap({ ...branchRes.name_map, ...vlRes.name_map });
      setPendingContingency([]);

      diagrams.setNominalVoltageMap(nomVRes.mapping);
      diagrams.setUniqueVoltages(nomVRes.unique_kv);
      if (nomVRes.unique_kv.length > 0) {
        diagrams.setVoltageRange([nomVRes.unique_kv[0], nomVRes.unique_kv[nomVRes.unique_kv.length - 1]]);
      }
      diagrams.ingestBaseDiagram(diagramRaw, vlRes.voltage_levels.length);
      setVlToSubstation(vlSubRes.mapping || {});
      committedNetworkPathRef.current = study.networkPath;
      interactionLogger.record('config_loaded', buildConfigInteractionDetails());

      // Arm the contingency — useContingencyFetch picks this up and fetches
      // the N-1 diagram (no analysis state yet, so no confirm dialog).
      if (study.contingencyElementId) {
        setSelectedContingency([study.contingencyElementId]);
      }
    } catch (err: unknown) {
      const e = err as { response?: { data?: { detail?: string } }; message?: string };
      const msg = 'Failed to load study: ' + (e.response?.data?.detail || e.message);
      setError(msg);
      throw new Error(msg);
    } finally {
      setConfigLoading(false);
    }
  }, [
    buildConfigRequest, applyConfigResponse, resetAllState, diagrams,
    setNetworkPath, setActionPath, setLayoutPath, setLinesMonitoringPath,
    setBranches, setVoltageLevels, setNameMap, setPendingContingency,
    setVlToSubstation, setSelectedContingency, setConfigLoading, setError,
    buildConfigInteractionDetails,
  ]);

  useEffect(() => {
    if (!gameBridge.isGameMode()) return;
    gameBridge.registerLoader(loadGameStudy);
  }, [loadGameStudy]);

  // Publish the physical result of the current study to the Game shell.
  useEffect(() => {
    if (!gameBridge.isGameMode()) return;
    const chosenActions = [...selectedActionIds].map((id) => {
      const d = result?.actions[id];
      const maxRho = d?.max_rho ?? null;
      const after = d?.lines_overloaded_after;
      const solved = maxRho != null && maxRho < 1.0 && (!after || after.length === 0);
      return {
        actionId: id,
        description: d?.description_unitaire,
        maxRho,
        linesOverloadedAfter: after,
        solved,
      };
    });
    const rhoArr = n1Diagram?.lines_overloaded_rho;
    const baselineMaxRho = rhoArr && rhoArr.length ? Math.max(...rhoArr) : null;
    gameBridge.publishSnapshot({
      contingencyElementIds: selectedContingency,
      baselineMaxRho,
      chosenActions,
    });
  }, [result, selectedActionIds, selectedContingency, n1Diagram]);

  // Re-seed selectedOverloads with the full N-1 overload list only when a
  // new n1Diagram is loaded. Comparing against the live selectedOverloads
  // would clobber user-initiated double-click unselects: the analysis memo
  // refreshes on every toggle, retriggering this effect and re-adding the
  // overload the user just removed.
  const prevN1DiagramRef = useRef<typeof n1Diagram>(null);
  useEffect(() => {
    if (prevN1DiagramRef.current === n1Diagram) return;
    prevN1DiagramRef.current = n1Diagram;
    const nextSet = n1Diagram?.lines_overloaded ? new Set(n1Diagram.lines_overloaded) : new Set<string>();
    analysis.setSelectedOverloads(nextSet);
  }, [n1Diagram, analysisLoading, n1Loading, analysis]);




  const { viewModeForTab, handleViewModeChangeForTab } = useDiagramHighlights({
    diagrams,
    result,
    selectedContingency,
    selectedOverloads,
    monitoringFactor,
    detachedTabs,
  });

  // ===== Extracted JSX callbacks (stable references for React.memo) =====

  /**
   * Replace the pending list with whatever the multi-select dropdown
   * currently shows. We diff against the previous pending list to
   * emit a single ``contingency_element_added`` /
   * ``contingency_element_removed`` event per change so the
   * interaction log stays replay-friendly even when the user picks
   * several elements before pressing Apply.
   */
  const handlePendingContingencyChange = useCallback((next: string[]) => {
    const prev = pendingContingency;
    const prevSet = new Set(prev);
    const nextSet = new Set(next);
    for (const id of next) {
      if (!prevSet.has(id)) interactionLogger.record('contingency_element_added', { element: id });
    }
    for (const id of prev) {
      if (!nextSet.has(id)) interactionLogger.record('contingency_element_removed', { element: id });
    }
    setPendingContingency(next);
  }, [pendingContingency]);

  /**
   * Commit the pending list. Triggers the contingency-state confirm
   * dialog when an analysis already exists (same routing as today's
   * single-element flow).
   */
  const handleContingencyApply = useCallback(() => {
    const next = [...pendingContingency];
    interactionLogger.record('contingency_applied', { elements: next });
    setSelectedContingency(next);
  }, [pendingContingency]);

  const handleDismissWarning = useCallback(() => {
    setShowMonitoringWarning(false);
  }, [setShowMonitoringWarning]);

  const handleOpenConfigSettings = useCallback(() => {
    setIsSettingsOpen(true);
    setSettingsTab('configurations');
  }, [setIsSettingsOpen, setSettingsTab]);

  const handleToggleMonitorDeselected = useCallback(() => {
    analysis.setMonitorDeselected(!analysis.monitorDeselected);
  }, [analysis]);

  const handleTabChange = useCallback((tab: TabId) => {
    interactionLogger.record('diagram_tab_changed', { tab });
    diagrams.setActiveTab(tab);
  }, [diagrams]);

  const handleVoltageRangeChange = useCallback((range: [number, number]) => {
    interactionLogger.record('voltage_range_changed', { min: range[0], max: range[1] });
    diagrams.setVoltageRange(range);
  }, [diagrams]);

  const handleInspectQueryChange = useCallback((q: string) => {
    interactionLogger.record('inspect_query_changed', { query: q });
    diagrams.setInspectQuery(q);
  }, [diagrams]);

  const handleToggleVoltageLevelNames = useCallback((show: boolean) => {
    interactionLogger.record('vl_names_toggled', { show });
    setShowVoltageLevelNames(show);
  }, [setShowVoltageLevelNames]);

  // Per-tab inspect variant. Lets a detached tab's overlay zoom its
  // own tab rather than the main-window activeTab — see
  // useDiagrams.setInspectQueryForTab for the full story.
  const handleInspectQueryChangeFor = useCallback((targetTab: TabId, q: string) => {
    interactionLogger.record('inspect_query_changed', { query: q, target_tab: targetTab });
    diagrams.setInspectQueryForTab(targetTab, q);
  }, [diagrams]);

  const handleVlOpen = useCallback((vlName: string) => {
    // Always carry the currently-selected action id into the SLD
    // overlay — NOT just when activeTab === 'action'. The SLD's
    // internal sub-tab buttons let the user switch to the "action"
    // sub-tab from any tab, and if we open the overlay with an
    // empty actionId the backend rejects the switch with
    // "Action '' not found in last analysis result".
    handleVlDoubleClick(selectedActionId || '', vlName);
  }, [handleVlDoubleClick, selectedActionId]);

  // Keep the VL-disk interaction callbacks in refs so the delegated
  // listeners below re-bind ONLY when a diagram / its metadata actually
  // changes — never on an unrelated App render, which would needlessly
  // tear down the listeners and (worse) cancel an in-flight single-click
  // timer mid-window.
  const vlSelectRef = useRef(handleInspectQueryChangeFor);
  const vlOpenSldRef = useRef(handleVlOpen);
  const vlDisplayNameRef = useRef(displayName);
  useEffect(() => {
    vlSelectRef.current = handleInspectQueryChangeFor;
    vlOpenSldRef.current = handleVlOpen;
    vlDisplayNameRef.current = displayName;
  });

  // Voltage-level disk interactions on every NAD tab: hover shows the VL
  // name while the static labels are hidden, single-click selects the VL
  // (drives the Inspect field + auto-zoom), double-click opens its SLD.
  // Delegated listeners only — see `attachVlInteractions` for the
  // performance contract (no per-node / per-frame work; idle during
  // pan/zoom gestures because `.svg-interacting` disables SVG hit-
  // testing). Re-binds only on a diagram / metadata-index refresh.
  useEffect(() => {
    const targets: Array<readonly [HTMLElement | null, MetadataIndex | null, TabId]> = [
      [nSvgContainerRef.current, diagrams.nMetaIndex, 'n'],
      [n1SvgContainerRef.current, diagrams.n1MetaIndex, 'contingency'],
      [actionSvgContainerRef.current, diagrams.actionMetaIndex, 'action'],
    ];
    const teardowns = targets.map(([container, metaIndex, tab]) =>
      attachVlInteractions(container, metaIndex, {
        displayName: (id) => vlDisplayNameRef.current(id),
        onSelect: (vlId) => vlSelectRef.current(tab, vlId),
        onOpenSld: (vlId) => vlOpenSldRef.current(vlId),
      }),
    );
    return () => teardowns.forEach((teardown) => teardown());
  }, [
    nDiagram, n1Diagram, actionDiagram,
    diagrams.nMetaIndex, diagrams.n1MetaIndex, diagrams.actionMetaIndex,
    nSvgContainerRef, n1SvgContainerRef, actionSvgContainerRef,
  ]);

  // Double-click on an action pin in the overflow graph drills into
  // that substation's SLD on the post-action ('action') sub-tab.
  // Guarded on the action being known to the analysis result —
  // double-clicks on stale or unknown pins are silently ignored.
  const handleOverflowPinDoubleClick = useCallback((actionId: string, substation: string) => {
    if (!actionId || !substation) return;
    const knownAction = !!result?.actions?.[actionId];
    if (!knownAction) return;
    interactionLogger.record('overflow_pin_double_clicked', {
      actionId, substation,
    });
    handleVlDoubleClick(actionId, substation, 'action');
  }, [handleVlDoubleClick, result?.actions]);

  const handleCancelDialog = useCallback(() => {
    // Cancelling a "Change Network?" dialog must roll back the
    // optimistic networkPath update done by requestNetworkPathChange,
    // otherwise the Header field would silently diverge from the
    // currently-loaded study's path.
    if (confirmDialog?.type === 'changeNetwork') {
      setNetworkPath(committedNetworkPathRef.current);
    }
    setConfirmDialog(null);
  }, [confirmDialog, setNetworkPath]);

  // ===== Tiered notice system =====
  // The previous UI stacked up to five concurrent yellow banners in
  // the sidebar. They now feed a single "Notices" pill at the top
  // of the sidebar. Each notice owns its dismissal state via the
  // existing showXxxWarning state (kept where it lived to preserve
  // the reset-on-apply-settings behaviour).
  const [showActionDictNotice, setShowActionDictNotice] = useState(true);
  const [showRecommenderNotice, setShowRecommenderNotice] = useState(true);

  // Re-arm the notices whenever a fresh study is loaded — same
  // semantics as the local state ActionFeed used to own.
  useEffect(() => {
    setShowActionDictNotice(true);
    setShowRecommenderNotice(true);
  }, [networkPath, actionPath]);

  const sidebarNotices = useMemo(() => {
    const list: Notice[] = [];

    // Action-dictionary info — shown until the operator dismisses
    // it manually. The previous "auto-clear once an action has been
    // simulated" rule was removed: notices live in the discrete
    // sidebar pill that no longer overloads the main window
    // visually, so the operator should decide when each notice has
    // been read — not the lifecycle of the analysis.
    if (showActionDictNotice && actionDictFileName && actionDictStats) {
      list.push({
        id: 'action-dict',
        severity: 'info',
        title: 'Action dictionary',
        body: (
          <>
            <code style={{ fontFamily: 'monospace', padding: '0 4px' }}>{actionDictFileName}</code>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '4px' }}>
              <span>🔄 Reco: <strong>{actionDictStats.reco}</strong></span>
              <span>⛔ Disco: <strong>{actionDictStats.disco}</strong></span>
              <span>📐 PST: <strong>{actionDictStats.pst}</strong></span>
              <span>🔓 Open coupling: <strong>{actionDictStats.open_coupling}</strong></span>
              <span>🔒 Close coupling: <strong>{actionDictStats.close_coupling}</strong></span>
            </div>
          </>
        ),
        action: { label: 'Change in settings', onClick: () => handleOpenSettings('paths') },
        onDismiss: () => setShowActionDictNotice(false),
      });
    }

    // Monitoring coverage warning — surfaces the reduced monitoring
    // scope before the operator runs an analysis.
    if (showMonitoringWarning && totalLinesCount && totalLinesCount > 0) {
      const monitored = monitoredLinesCount || 0;
      list.push({
        id: 'monitoring-coverage',
        severity: 'warning',
        title: 'Monitoring coverage',
        body: (
          <>
            <strong>{monitored}</strong> of <strong>{totalLinesCount}</strong> lines monitored
            {' '}({totalLinesCount - monitored} without permanent limits). Monitoring factor:
            {' '}{Math.round((monitoringFactor || 0.95) * 100)}%, pre-existing overload threshold:
            {' '}{Math.round((preExistingOverloadThreshold || 0.02) * 100)}%.
          </>
        ),
        action: { label: 'Change in settings', onClick: handleOpenConfigSettings },
        onDismiss: handleDismissWarning,
      });
    }

    // Recommender thresholds — shown until the operator dismisses
    // it manually. The previous "auto-hide once analysis kicks off"
    // rule was removed for consistency with the action-dict notice:
    // the sidebar pill is opt-in and doesn't compete for attention
    // with the main window, so the operator owns the dismiss
    // gesture.
    if (showRecommenderNotice) {
      list.push({
        id: 'recommender-thresholds',
        severity: 'info',
        title: 'Recommender thresholds',
        body: (
          <>
            <div>• Minimum actions: {recommenderConfig.minLineReconnections} reco, {recommenderConfig.minCloseCoupling} close, {recommenderConfig.minOpenCoupling} open, {recommenderConfig.minLineDisconnections} disco, {recommenderConfig.minPst} PST, {recommenderConfig.minLoadShedding} load shedding, {recommenderConfig.minRenewableCurtailmentActions} RC, {recommenderConfig.minRedispatch} redispatch</div>
            <div>• Maximum suggestions: {recommenderConfig.nPrioritizedActions}</div>
            <div>• Ignore reconnections: {recommenderConfig.ignoreReconnections ? 'Yes' : 'No'}</div>
          </>
        ),
        action: { label: 'Change in settings', onClick: () => handleOpenSettings('recommender') },
        onDismiss: () => setShowRecommenderNotice(false),
      });
    }

    // Additional "lines to prevent flow increase" — two complementary
    // notices, one per analysis lifecycle phase:
    //
    //   PRE-RUN  (no result yet, picker non-empty): warning that
    //     surfaces the EXTRA targets the next Analyze & Suggest run
    //     is about to pass to the recommender.
    //   POST-RUN (result present, committed snapshot non-empty):
    //     info that surfaces the EXTRA targets baked into the
    //     CURRENT result, so the operator never loses track of the
    //     hypothesis the recommendations were computed against —
    //     even if the picker has since been edited and a new run is
    //     pending. The committed snapshot is taken inside
    //     ``useAnalysis`` at the moment Step 2 was posted.
    if (additionalLinesToCut.size > 0 && !pendingAnalysisResult && !result) {
      const lines = Array.from(additionalLinesToCut);
      list.push({
        id: 'additional-lines-to-cut',
        severity: 'warning',
        title: 'Additional lines to prevent flow increase',
        body: (
          <>
            <div>
              The next Analyze &amp; Suggest run will treat{' '}
              <strong>{lines.length}</strong> extra line{lines.length === 1 ? '' : 's'} as
              {' '}targets to prevent flow increase on (simulated as disconnected, not rendered as overloads):
            </div>
            <div style={{ marginTop: 4, wordBreak: 'break-word' }}>
              {lines.map(displayName).join(', ')}
            </div>
          </>
        ),
      });
    }
    if (committedAdditionalLinesToCut.size > 0 && !!result) {
      const lines = Array.from(committedAdditionalLinesToCut);
      list.push({
        id: 'additional-lines-to-cut-committed',
        severity: 'info',
        title: 'Additional lines integrated in overflow analysis',
        body: (
          <>
            <div>
              <strong>{lines.length}</strong> additional line
              {lines.length === 1 ? '' : 's'} integrated in overflow
              analysis on which to prevent powerflow increase:
            </div>
            <div style={{ marginTop: 4, wordBreak: 'break-word' }}>
              {lines.map(displayName).join(', ')}
            </div>
          </>
        ),
      });
    }

    return list;
  }, [
    showActionDictNotice, actionDictFileName, actionDictStats, result,
    showMonitoringWarning, monitoredLinesCount, totalLinesCount,
    monitoringFactor, preExistingOverloadThreshold,
    showRecommenderNotice, pendingAnalysisResult, recommenderConfig,
    handleOpenSettings, handleOpenConfigSettings, handleDismissWarning,
    additionalLinesToCut, committedAdditionalLinesToCut, displayName,
  ]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <Header
        networkPath={networkPath}
        setNetworkPath={setNetworkPath}
        onCommitNetworkPath={requestNetworkPathChange}
        configLoading={configLoading}
        result={result}
        selectedContingency={selectedContingency}
        sessionRestoring={sessionRestoring}
        onPickSettingsPath={pickSettingsPath}
        onLoadStudy={handleLoadStudyClick}
        onSaveResults={wrappedSaveResults}
        onOpenReloadModal={wrappedOpenReloadModal}
        onOpenSettings={handleOpenSettings}
        notices={sidebarNotices}
      />

      {/* Settings Modal */}
      <SettingsModal settings={settings} onApply={handleApplySettingsClick} />


      <ReloadSessionModal
        showReloadModal={showReloadModal}
        setShowReloadModal={setShowReloadModal}
        outputFolderPath={outputFolderPath}
        sessionListLoading={sessionListLoading}
        sessionList={sessionList}
        sessionRestoring={sessionRestoring}
        onRestoreSession={wrappedRestoreSession}
      />

      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        <AppSidebar
          selectedContingency={selectedContingency}
          pendingContingency={pendingContingency}
          branches={branches}
          nameMap={nameMap}
          n1LinesOverloaded={n1Diagram?.lines_overloaded}
          n1LinesOverloadedRho={n1Diagram?.lines_overloaded_rho}
          nLinesOverloaded={nDiagram?.lines_overloaded}
          nLinesOverloadedRho={nDiagram?.lines_overloaded_rho}
          selectedOverloads={selectedOverloads}
          onPendingContingencyChange={handlePendingContingencyChange}
          onContingencyApply={handleContingencyApply}
          displayName={displayName}
          onContingencyZoom={handleZoomOnActiveTab}
          onOverloadClick={wrappedAssetClick as (actionId: string, assetName: string, tab: 'n' | 'contingency') => void}
          onToggleOverload={analysis.handleToggleOverload}
          monitorDeselected={monitorDeselected}
          onToggleMonitorDeselected={handleToggleMonitorDeselected}
          monitoringHint={
            showMonitoringWarning && totalLinesCount && totalLinesCount > 0
              ? `${monitoredLinesCount || 0}/${totalLinesCount} lines monitored — see Notices for details.`
              : null
          }
          onClearContingency={requestClearContingency}
          hideContingencyPicker={sidebarSwitchedToFeed}
          collapsed={sidebarCollapsed}
          onToggleCollapsed={handleToggleSidebarCollapsed}
          overviewFilters={overviewFilters}
          onOverviewFiltersChange={setOverviewFilters}
          hasActions={Object.keys(result?.actions || {}).length > 0}
        >
          {sidebarSwitchedToFeed && result?.antenna_meta && (
            <AntennaNotice meta={result.antenna_meta} />
          )}
          {sidebarSwitchedToFeed && (
          <ActionFeed
            actions={result?.actions || {}}
            actionScores={result?.action_scores}
            // Prefer the analysis-result overload list when it carries
            // entries (step1 / session reload populate it with the
            // pypowsybl-style friendly identifiers the rest of the UI
            // is wired against), and fall back to the N-1 diagram's
            // authoritative list otherwise. The fallback matters for
            // the pre-analysis manual-simulation flow: without it the
            // card stack inherits ``simulate_manual_action``'s
            // vectorised obs-based names — grid2op's synthetic
            // ``line_<i>`` strings that ``displayName`` cannot resolve.
            linesOverloaded={
              result?.lines_overloaded && result.lines_overloaded.length > 0
                ? result.lines_overloaded
                : (n1Diagram?.lines_overloaded || [])
            }
            selectedActionId={selectedActionId}
            scrollTarget={scrollTarget}
            selectedActionIds={selectedActionIds}
            rejectedActionIds={rejectedActionIds}
            manuallyAddedIds={manuallyAddedIds}
            combinedActions={result?.combined_actions ?? null}
            pendingAnalysisResult={pendingAnalysisResult}
            onDisplayPrioritizedActions={wrappedDisplayPrioritized}
            onRunAnalysis={wrappedRunAnalysis}
            canRunAnalysis={selectedContingency.length > 0 && !analysisLoading}
            onActionSelect={wrappedActionSelect}
            onActionFavorite={wrappedActionFavorite}
            onActionReject={actionsHook.handleActionReject}
            onAssetClick={wrappedAssetClick}
            nodesByEquipmentId={diagrams.nMetaIndex?.nodesByEquipmentId ?? null}
            edgesByEquipmentId={diagrams.nMetaIndex?.edgesByEquipmentId ?? null}
            disconnectedElement={selectedContingency}
            onManualActionAdded={wrappedManualActionAdded}
            onActionResimulated={wrappedActionResimulated}
            analysisLoading={analysisLoading}
            monitoringFactor={monitoringFactor}
            onVlDoubleClick={handleVlDoubleClick}
            onUpdateCombinedEstimation={handleUpdateCombinedEstimation}
            displayName={displayName}
            onActionDiagramPrimed={diagrams.primeActionDiagram}
            voltageLevelsLength={voltageLevels.length}
            overviewFilters={overviewFilters}
            onOverviewFiltersChange={setOverviewFilters}
            branches={branches}
            additionalLinesToCut={additionalLinesToCut}
            onToggleAdditionalLineToCut={analysis.handleToggleAdditionalLineToCut}
            n1Overloads={n1Diagram?.lines_overloaded || []}
            recommenderModel={recommenderModel}
            setRecommenderModel={setRecommenderModel}
            availableModels={availableModels}
            activeModelLabel={
              result?.active_model
                ? (availableModels?.find(m => m.name === result.active_model)?.label || result.active_model)
                : null
            }
            overflowGraphTime={result?.overflow_graph_time ?? null}
            actionPredictionTime={result?.action_prediction_time ?? null}
            assessmentTime={result?.assessment_time ?? null}
            step1Time={result?.step1_time ?? null}
            enrichmentTime={result?.enrichment_time ?? null}
            wallClockTime={result?.wall_clock_time ?? null}
            onClearSuggested={requestClearSuggested}
          />
          )}
        </AppSidebar>
        <div style={{ flex: 1, background: 'white', display: 'flex', flexDirection: 'column' }}>
          <VisualizationPanel
            activeTab={activeTab}
            configLoading={configLoading}
            onTabChange={handleTabChange}
            nDiagram={nDiagram}
            n1Diagram={n1Diagram}
            n1Loading={n1Loading}
            actionDiagram={actionDiagram}
            actionDiagramLoading={actionDiagramLoading}
            selectedActionId={selectedActionId}
            result={result}
            analysisLoading={analysisLoading}
            nSvgContainerRef={nSvgContainerRef}
            n1SvgContainerRef={n1SvgContainerRef}
            actionSvgContainerRef={actionSvgContainerRef}
            uniqueVoltages={uniqueVoltages}
            voltageRange={voltageRange}
            onVoltageRangeChange={handleVoltageRangeChange}
            actionViewMode={actionViewMode}
            onViewModeChange={handleViewModeChange}
            viewModeForTab={viewModeForTab}
            onViewModeChangeForTab={handleViewModeChangeForTab}
            overflowLayoutMode={diagrams.overflowLayoutMode}
            overflowLayoutLoading={diagrams.overflowLayoutLoading}
            onOverflowLayoutChange={wrappedOverflowLayoutChange}
            inspectQuery={inspectQuery}
            onInspectQueryChange={handleInspectQueryChange}
            onInspectQueryChangeFor={handleInspectQueryChangeFor}
            inspectableItems={inspectableItems}
            onResetView={handleManualReset}
            onZoomIn={handleManualZoomIn}
            onZoomOut={handleManualZoomOut}
            hasBranches={branches.length > 0}
            selectedContingency={selectedContingency}
            vlOverlay={vlOverlay}
            onOverlayClose={handleOverlayClose}
            onOverlaySldTabChange={handleOverlaySldTabChange}
            sldEditMode={sldTopologyEdit.editMode}
            onSldEditModeChange={sldTopologyEdit.setEditMode}
            sldEditPendingSwitches={sldTopologyEdit.pendingStates}
            sldEditPendingChanges={sldTopologyEdit.pendingChanges}
            onSldSwitchClick={sldTopologyEdit.toggleSwitch}
            sldEditPendingInjections={sldTopologyEdit.pendingInjections}
            sldEditInjectionChanges={sldTopologyEdit.injectionChanges}
            onSldInjectionStage={sldTopologyEdit.setInjection}
            onSldInjectionRemove={sldTopologyEdit.removeInjection}
            onSldEditSimulate={handleSimulateSldEdit}
            onSldEditReset={sldTopologyEdit.reset}
            sldEditBusy={sldEditBusy}
            sldEditCombinedWithActionId={sldEditBaseActionId}
            sldPreviewSvg={sldPreview?.svg ?? null}
            sldPreviewMetadata={sldPreview?.metadata ?? null}
            sldPreviewStale={!!sldPreview}
            sldPreviewLoading={sldPreviewLoading}
            sldFocusedSwitchId={sldTopologyEdit.focusedSwitchId}
            onSldSwitchFocus={sldTopologyEdit.setFocusedSwitch}
            onSldSwitchRemove={sldTopologyEdit.removeSwitch}
            onSldSwitchRemoveMany={sldTopologyEdit.removeSwitches}
            voltageLevels={voltageLevels}
            onVlOpen={handleVlOpen}
            onOverflowPinPreview={handlePinPreview}
            onOverflowPinDoubleClick={handleOverflowPinDoubleClick}
            networkPath={networkPath}
            layoutPath={layoutPath}
            onOpenSettings={handleOpenSettings}
            detachedTabs={detachedTabs}
            onDetachTab={handleDetachTab}
            onReattachTab={handleReattachTab}
            onFocusDetachedTab={focusDetachedTab}
            isTabTied={isTabTied}
            onToggleTabTie={toggleTabTie}
            n1MetaIndex={diagrams.n1MetaIndex}
            onActionSelect={wrappedActionSelect}
            onActionFavorite={wrappedActionFavorite}
            onActionReject={actionsHook.handleActionReject}
            selectedActionIds={selectedActionIds}
            rejectedActionIds={rejectedActionIds}
            onPinPreview={handlePinPreview}
            onOverviewPzChange={handleOverviewPzChange}
            monitoringFactor={monitoringFactor}
            displayName={displayName}
            overviewFilters={overviewFilters}
            onOverviewFiltersChange={setOverviewFilters}
            sidebarCollapsed={sidebarCollapsed}
            hasActions={Object.keys(result?.actions || {}).length > 0}
            unsimulatedActionIds={unsimulatedActionIds}
            unsimulatedActionInfo={unsimulatedActionInfo}
            onSimulateUnsimulatedAction={handleSimulateUnsimulatedAction}
            showVoltageLevelNames={showVoltageLevelNames}
            onToggleVoltageLevelNames={handleToggleVoltageLevelNames}
            overflowPins={allOverflowPins}
            overflowPinsEnabled={overflowPinsEnabled}
            onOverflowPinsToggle={setOverflowPinsEnabled}
          />
        </div>
      </div>
      {/* Confirmation Dialog for contingency change / load study */}
      <ConfirmationDialog
        confirmDialog={confirmDialog}
        onCancel={handleCancelDialog}
        onConfirm={handleConfirmDialog}
      />
      <StatusToasts error={error} infoMessage={infoMessage} />
    </div>
  );
}

export default App;
