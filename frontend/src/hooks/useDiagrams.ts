// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study. 

import { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef, type Dispatch, type SetStateAction, type RefObject, type MutableRefObject } from 'react';
import { api } from '../api';
import { usePanZoom } from './usePanZoom';
import {
  buildMetadataIndex,
  getIdMap, invalidateIdMapCache,
} from '../utils/svgUtils';
import { processSvg } from '../utils/svgUtils';
import { cloneBaseSvg, applyPatchToClone } from '../utils/svgPatch';
import type { DiagramData, ViewBox, MetadataIndex, TabId, VlOverlay, SldTab, AnalysisResult, ActionDetail } from '../types';
import { interactionLogger } from '../utils/interactionLogger';
import { useSldOverlay } from './useSldOverlay';

/**
 * Compute the set of equipment IDs the auto-zoom effect is allowed to
 * target. Includes:
 *
 *  - `branches` — disconnectable N-1 targets (so typing "LIN"
 *    in the inspect input is rejected until the user commits a full
 *    equipment name).
 *  - `voltageLevels` — same rationale.
 *  - Every equipment ID present in any loaded NAD metadata index
 *    (nodes + edges), which is what makes explicit asset clicks
 *    work for elements that are NOT in the disconnectable branch
 *    list — for instance, an action's re-distributed `max_rho_line`
 *    (a line that is newly overloaded after a remedial action but is
 *    not itself a contingency target).  Without these extra entries
 *    the effect would reject the click and leave the diagram centered
 *    on whatever element was zoomed last (typically the previous
 *    pre-action overload), giving the impression that the
 *    Max-loading link is "stuck".
 *
 * Exported for tests; consumed internally by {@link useDiagrams}.
 */
export function computeKnownItemsSet(
  branches: string[],
  voltageLevels: string[],
  indices: (MetadataIndex | null | undefined)[],
): Set<string> {
  const s = new Set<string>([...branches, ...voltageLevels]);
  for (const idx of indices) {
    if (!idx) continue;
    for (const k of idx.edgesByEquipmentId.keys()) s.add(k);
    for (const k of idx.nodesByEquipmentId.keys()) s.add(k);
  }
  return s;
}

export interface DiagramsState {
  // Tab
  activeTab: TabId;
  setActiveTab: (v: TabId) => void;

  // Diagrams
  nDiagram: DiagramData | null;
  setNDiagram: (v: DiagramData | null) => void;
  n1Diagram: DiagramData | null;
  setN1Diagram: (v: DiagramData | null) => void;
  n1Loading: boolean;
  setN1Loading: (v: boolean) => void;

  // Action variant
  selectedActionId: string | null;
  setSelectedActionId: (v: string | null) => void;
  actionDiagram: DiagramData | null;
  setActionDiagram: (v: DiagramData | null) => void;
  actionDiagramLoading: boolean;
  setActionDiagramLoading: (v: boolean) => void;

  // View mode
  actionViewMode: 'network' | 'delta';
  setActionViewMode: (v: 'network' | 'delta') => void;
  handleViewModeChange: (mode: 'network' | 'delta') => void;

  // Voltage-level name labels: when false, the per-node labels rendered
  // by pypowsybl inside the NAD's `<foreignObject class="nad-text-nodes">`
  // are hidden via CSS, and the equipment id is exposed as a native
  // `<title>` tooltip on hover instead. Defaults to true.
  showVoltageLevelNames: boolean;
  setShowVoltageLevelNames: (v: boolean) => void;

  // Overflow-graph layout toggle (Hierarchical / Geo).
  // Per-session state; the backend keeps a cache keyed by mode so
  // subsequent toggles are instant.
  overflowLayoutMode: 'hierarchical' | 'geo';
  setOverflowLayoutMode: (v: 'hierarchical' | 'geo') => void;
  overflowLayoutLoading: boolean;
  handleOverflowLayoutChange: (
    mode: 'hierarchical' | 'geo',
    setResult: Dispatch<SetStateAction<AnalysisResult | null>>,
    setError: (v: string) => void,
  ) => Promise<void>;


  // ViewBox
  originalViewBox: ViewBox | null;
  setOriginalViewBox: (v: ViewBox | null) => void;
  inspectQuery: string;
  setInspectQuery: (v: string) => void;
  /**
   * Sets `inspectQuery` AND records which tab the auto-zoom effect
   * should target on its next tick. Used by per-tab inspect overlays
   * rendered inside a detached popup — they need to zoom their own
   * tab, not the main window's `activeTab`.
   */
  setInspectQueryForTab: (targetTab: TabId, query: string) => void;

  // SVG Container Refs
  nSvgContainerRef: RefObject<HTMLDivElement | null>;
  n1SvgContainerRef: RefObject<HTMLDivElement | null>;
  actionSvgContainerRef: RefObject<HTMLDivElement | null>;

  // Pan/Zoom instances
  nPZ: ReturnType<typeof usePanZoom>;
  n1PZ: ReturnType<typeof usePanZoom>;
  actionPZ: ReturnType<typeof usePanZoom>;

  // Metadata
  nMetaIndex: MetadataIndex | null;
  n1MetaIndex: MetadataIndex | null;
  actionMetaIndex: MetadataIndex | null;

  // Voltage filter
  nominalVoltageMap: Record<string, number>;
  setNominalVoltageMap: (v: Record<string, number>) => void;
  uniqueVoltages: number[];
  setUniqueVoltages: (v: number[]) => void;
  voltageRange: [number, number];
  setVoltageRange: (v: [number, number]) => void;

  // SLD overlay
  vlOverlay: VlOverlay | null;
  setVlOverlay: (v: VlOverlay | null) => void;

  // Contingency refs
  /** Last APPLIED contingency (list of element IDs). Empty = N state. */
  committedBranchRef: MutableRefObject<string[]>;
  restoringSessionRef: MutableRefObject<boolean>;
  lastZoomState: MutableRefObject<{ query: string; branch: string }>;
  actionSyncSourceRef: MutableRefObject<ViewBox | null>;

  // Handlers
  fetchBaseDiagram: (vlCount: number) => void;
  /**
   * Consume a pre-fetched base-diagram payload (processSvg + state set).
   * Used by callers that fire `api.getNetworkDiagram()` themselves in
   * parallel with `branches`/`voltage-levels`/`nominal-voltages` to
   * shave the serial-dependency gap off the initial load.
   */
  ingestBaseDiagram: (raw: DiagramData & { svg: string }, vlCount: number) => void;
  handleActionSelect: (
    actionId: string | null,
    result: AnalysisResult | null,
    selectedContingency: string[],
    voltageLevelsLength: number,
    setResult: Dispatch<SetStateAction<AnalysisResult | null>>,
    setError: (v: string) => void,
    force?: boolean,
  ) => Promise<void>;
  handleManualZoomIn: (targetTab?: TabId) => void;
  handleManualZoomOut: (targetTab?: TabId) => void;
  handleManualReset: (targetTab?: TabId) => void;
  handleVlDoubleClick: (actionId: string, vlName: string, forceTab?: SldTab) => void;
  handleOverlaySldTabChange: (sldTab: SldTab) => void;
  handleOverlayClose: () => void;
  handleAssetClick: (
    actionId: string,
    assetName: string,
    tab: 'action' | 'n' | 'contingency',
    selectedActionId: string | null,
    handleActionSelectFn: (actionId: string | null) => void,
  ) => void;
  zoomToElement: (targetId: string, targetTab?: TabId) => void;

  // Computed
  inspectableItems: string[];

  // Internal ref carrying the currently-applied contingency for SLD
  // overlay re-fetches. Holds the element-ID list directly so the
  // SLD endpoint can drive both the legacy N-1 and N-K cases.
  selectedContingencyForSld: MutableRefObject<string[]>;

  // Cache primer — ActionFeed calls this with the diagram event from the
  // streamed simulate-and-variant-diagram endpoint. A subsequent click
  // on the same action card is served from cache (no XHR, no pypowsybl).
  // Cache is automatically cleared when `selectedBranch` changes.
  primeActionDiagram: (actionId: string, diagram: DiagramData & { svg: string }, voltageLevelsLength: number) => void;

  /**
   * Re-fetch the SLD overlay if it is currently open on the given
   * action. Wired by App.tsx into the re-simulate flow so editable
   * actions (load-shedding MW, curtailment MW, PST tap) refresh the
   * SLD's per-equipment highlights and flow deltas after a user edit.
   */
  refreshSldIfAction: (actionId: string) => void;
}

export function useDiagrams(
  branches: string[],
  voltageLevels: string[],
  selectedContingency: string[],
  // Optional map of tabs that are currently "detached" into a secondary
  // browser window. A detached tab must be treated as interactive for
  // pan/zoom purposes even though it is not the `activeTab` in the main
  // window — otherwise its event listeners are never bound and the
  // popup looks frozen. Only the keys are read (truthiness check).
  detachedTabs?: Partial<Record<TabId, unknown>>,
): DiagramsState {
  // Tab
  const [activeTab, setActiveTab] = useState<TabId>('n');
  const activeTabRef = useRef<TabId>(activeTab);
  useLayoutEffect(() => { activeTabRef.current = activeTab; }, [activeTab]);
  const prevTabRef = useRef<TabId>(activeTab);

  // Diagrams
  const [nDiagram, setNDiagram] = useState<DiagramData | null>(null);
  const [n1Diagram, setN1Diagram] = useState<DiagramData | null>(null);
  const [n1Loading, setN1Loading] = useState(false);

  // Action variant
  const [selectedActionId, setSelectedActionId] = useState<string | null>(null);
  const [actionDiagram, setActionDiagram] = useState<DiagramData | null>(null);
  const [actionDiagramLoading, setActionDiagramLoading] = useState(false);

  // View mode
  const [actionViewMode, setActionViewMode] = useState<'network' | 'delta'>('network');
  // Pure state setter — no interaction-log emission here. The
  // spec-conformant event (`view_mode_changed` with `{ mode, tab,
  // scope }`) is emitted by `App.tsx::handleViewModeChangeForTab`,
  // which has access to the `detachedTabs` map needed to compute
  // `scope`. Emitting from the hook would require passing that map
  // into every caller, and would risk drifting from the spec if
  // someone forgets one of the fields — see the regression caught
  // by `utils/specConformance.test.ts`.
  const handleViewModeChange = useCallback((mode: 'network' | 'delta') => {
    setActionViewMode(mode);
  }, []);


  const [showVoltageLevelNames, setShowVoltageLevelNames] = useState<boolean>(true);

  // Overflow-graph layout toggle state. `overflowLayoutLoading` is
  // true only during a cache-miss regeneration (graphviz re-run);
  // cache hits resolve synchronously so the UI doesn't flash a
  // spinner for instant switches.
  const [overflowLayoutMode, setOverflowLayoutMode] =
    useState<'hierarchical' | 'geo'>('hierarchical');
  const [overflowLayoutLoading, setOverflowLayoutLoading] = useState(false);
  const handleOverflowLayoutChange = useCallback(async (
    mode: 'hierarchical' | 'geo',
    setResult: Dispatch<SetStateAction<AnalysisResult | null>>,
    setError: (v: string) => void,
  ) => {
    // Consult the latest state from React — bail out if the user
    // clicked the currently-active button (prevents a pointless
    // backend round-trip).
    setOverflowLayoutMode((current) => {
      if (current === mode) return current;
      return current;  // actual change happens after the request resolves
    });
    const correlationId = interactionLogger.record('overflow_layout_mode_toggled', {
      to: mode,
    });
    const startTs = new Date().toISOString();
    setOverflowLayoutLoading(true);
    try {
      const response = await api.regenerateOverflowGraph(mode);
      setResult((prev) => {
        if (!prev) return prev;
        return { ...prev, pdf_url: response.pdf_url, pdf_path: response.pdf_path };
      });
      setOverflowLayoutMode(mode);
      interactionLogger.recordCompletion('overflow_layout_mode_toggled', correlationId, {
        to: mode,
        cached: response.cached,
      }, startTs);
    } catch (e) {
      const msg = (e instanceof Error) ? e.message : String(e);
      setError(`Failed to regenerate overflow graph in ${mode} mode: ${msg}`);
      interactionLogger.recordCompletion('overflow_layout_mode_toggled', correlationId, {
        to: mode,
        error: msg,
      }, startTs);
    } finally {
      setOverflowLayoutLoading(false);
    }
  }, []);

  // ViewBox
  const [originalViewBox, setOriginalViewBox] = useState<ViewBox | null>(null);
  const [inspectQuery, setInspectQuery] = useState('');

  // SVG Refs
  const nSvgContainerRef = useRef<HTMLDivElement>(null);
  const n1SvgContainerRef = useRef<HTMLDivElement>(null);
  const actionSvgContainerRef = useRef<HTMLDivElement>(null);

  // Pan/Zoom — a tab is interactive when it is the active tab in the
  // main window OR when it has been detached into its own popup window
  // (in the latter case the main-window `activeTab` may be pointing at
  // a different tab, but the detached popup still needs live pan/zoom).
  const nPZ = usePanZoom(
    nSvgContainerRef,
    nDiagram?.originalViewBox,
    activeTab === 'n' || !!detachedTabs?.['n'],
  );
  const n1PZ = usePanZoom(
    n1SvgContainerRef,
    n1Diagram?.originalViewBox,
    activeTab === 'contingency' || !!detachedTabs?.['contingency'],
  );
  const actionPZ = usePanZoom(
    actionSvgContainerRef,
    actionDiagram?.originalViewBox,
    activeTab === 'action' || !!detachedTabs?.['action'],
  );

  // Ref mirror of the `detachedTabs` map so stable callbacks (notably
  // `handleActionSelect`) can read the latest detached state without
  // having to be re-bound on every map change. This is the same pattern
  // used for `activeTabRef` above. When the action tab is detached, the
  // selecting-an-action flow must NOT switch the main window's active
  // tab to 'action' — the main window should keep showing whatever tab
  // the user had open (typically N or N-1), and only the popup gets the
  // updated diagram.
  const detachedTabsRef = useRef<Partial<Record<TabId, unknown>> | undefined>(detachedTabs);
  useLayoutEffect(() => { detachedTabsRef.current = detachedTabs; }, [detachedTabs]);

  // Zoom state
  const lastZoomState = useRef({ query: '', branch: '' });
  const actionSyncSourceRef = useRef<ViewBox | null>(null);
  // When a detached-tab overlay drives an inspect query, it records
  // which tab the auto-zoom should target here (rather than the
  // main-window `activeTab`). Cleared when the query changes via the
  // main-window overlay or when inspect is cleared. Using a ref
  // rather than state avoids triggering an extra render just to
  // carry the target forward into the effect.
  const inspectFocusTabRef = useRef<TabId | null>(null);

  // Contingency refs
  const committedBranchRef = useRef<string[]>([]);
  const restoringSessionRef = useRef(false);

  // Action-variant diagram cache. Populated by ActionFeed when it adds or
  // re-simulates a manual action through the streamed
  // `simulateAndVariantDiagramStream` endpoint — the `{type:"diagram",...}`
  // event yields a ready-to-render diagram while the user is still reading
  // the sidebar card. If the user subsequently clicks that card,
  // `handleActionSelect` reads the cache and paints the SVG instantly,
  // saving the 5-7 s server-side pypowsybl NAD regeneration that the fast
  // path (`getActionVariantDiagram`) would otherwise trigger.
  //
  // Keyed by action id. Values are ALREADY processed (processSvg ran, so
  // the entry has `originalViewBox` and the scaled SVG). Cleared whenever
  // the contingency changes so a stale post-action NAD from a previous
  // N-1 can't leak through.
  const actionDiagramCacheRef = useRef<Map<string, DiagramData>>(new Map());
  // Joined string for the dependency check — useEffect needs a stable
  // primitive, but the contingency state is a list.
  const selectedContingencyKey = selectedContingency.join('+');
  useEffect(() => {
    actionDiagramCacheRef.current.clear();
  }, [selectedContingencyKey]);

  // Tracks the last actionId the user clicked. Written synchronously
  // at the top of `handleActionSelect`, read after each async await
  // inside the selector: if the id diverged, the handler drops the
  // in-flight response so a late-arriving patch can't override a
  // more recent user click (the "blank flash" symptom on large
  // grids — `setActionDiagram(stale)` would repaint the action tab
  // with the previous selection for a moment, or, worse, overwrite
  // the current one with an older version).
  const latestActionSelectRef = useRef<string | null>(null);

  // Exposed to ActionFeed via App.tsx props: processes the raw NDJSON
  // diagram event's SVG and stores it for later click-to-view.
  const primeActionDiagram = useCallback((actionId: string, raw: DiagramData & { svg: string }, voltageLevelsLength: number) => {
    try {
      const { svg, viewBox } = processSvg(raw.svg, voltageLevelsLength);
      actionDiagramCacheRef.current.set(actionId, { ...raw, svg, originalViewBox: viewBox });
    } catch (e) {
      console.warn('[primeActionDiagram] processSvg failed for', actionId, e);
    }
  }, []);

  // Voltage filter
  const [nominalVoltageMap, setNominalVoltageMap] = useState<Record<string, number>>({});
  const [uniqueVoltages, setUniqueVoltages] = useState<number[]>([]);
  const [voltageRange, setVoltageRange] = useState<[number, number]>([0, 400]);

  // SLD overlay (extracted to useSldOverlay hook). Passing
  // `selectedActionId` lets the overlay fall back to the live
  // value when the user switches to the 'action' sub-tab of an
  // SLD that was opened from the N or N-1 tab (the stored
  // vlOverlay.actionId is '' in that case).
  const sldOverlay = useSldOverlay(activeTab, selectedActionId);
  const {
    vlOverlay,
    setVlOverlay,
    selectedContingencyForSld,
    handleVlDoubleClick,
    handleOverlaySldTabChange,
    handleOverlayClose,
    refreshCurrentIfAction: refreshSldIfAction,
  } = sldOverlay;

  // Metadata
  const nMetaIndex = useMemo(() => buildMetadataIndex(nDiagram?.metadata), [nDiagram?.metadata]);
  const n1MetaIndex = useMemo(() => buildMetadataIndex(n1Diagram?.metadata), [n1Diagram?.metadata]);
  const actionMetaIndex = useMemo(() => buildMetadataIndex(actionDiagram?.metadata), [actionDiagram?.metadata]);

  // Invalidate DOM id-map cache when SVG content changes
  useEffect(() => {
    if (nSvgContainerRef.current) invalidateIdMapCache(nSvgContainerRef.current);
  }, [nDiagram]);
  useEffect(() => {
    if (n1SvgContainerRef.current) invalidateIdMapCache(n1SvgContainerRef.current);
  }, [n1Diagram]);
  useEffect(() => {
    if (actionSvgContainerRef.current) invalidateIdMapCache(actionSvgContainerRef.current);
  }, [actionDiagram]);

  // ===== Fetch Base Diagram =====
  const fetchBaseDiagram = useCallback(async (vlCount: number) => {
    try {
      const res = await api.getNetworkDiagram();
      const { svg, viewBox } = processSvg(res.svg, vlCount || 0);
      if (viewBox) setOriginalViewBox(viewBox);
      setNDiagram({ ...res, svg, originalViewBox: viewBox });
    } catch (err) {
      console.error('Failed to fetch diagram:', err);
      throw err; // Re-throw so App.tsx can handle it
    }
  }, []);

  // Consume a pre-fetched base-diagram payload. Split from `fetchBaseDiagram`
  // so callers can fire `api.getNetworkDiagram()` in parallel with
  // branches/voltage-levels/nominal-voltages (serveur NAD ~6.6s dwarfs the
  // other three calls — parallelising shaves the ~0.8s branches gap off
  // the critical path of the initial load).
  const ingestBaseDiagram = useCallback((raw: DiagramData & { svg: string }, vlCount: number) => {
    const { svg, viewBox } = processSvg(raw.svg, vlCount || 0);
    if (viewBox) setOriginalViewBox(viewBox);
    setNDiagram({ ...raw, svg, originalViewBox: viewBox });
  }, []);

  // ===== Action Select =====
  // When `force` is true, skip the "already-selected → deselect" toggle path
  // and always re-fetch the action diagram. Used after a fresh (re)simulation
  // so the newly simulated network state is always shown.
  const handleActionSelect = useCallback(async (
    actionId: string | null,
    result: AnalysisResult | null,
    selectedContingencyArg: string[],
    voltageLevelsLength: number,
    setResult: React.Dispatch<React.SetStateAction<AnalysisResult | null>>,
    setError: (v: string) => void,
    force: boolean = false,
  ) => {
    const isActionDetached = !!detachedTabsRef.current?.['action'];

    if (!force && actionId === selectedActionId) {
      // Replay contract (docs/features/interaction-logging.md): after this
      // event fires no action is selected any more, so the id
      // carried is the PREVIOUSLY-selected action, not the current.
      interactionLogger.record('action_deselected', { previous_action_id: actionId });
      setSelectedActionId(null);
      setActionDiagram(null);
      // Stay on the current tab. When the user was on the action tab,
      // clearing `selectedActionId` naturally falls back to the
      // ActionOverviewDiagram (pin view) — same UX as clicking the
      // ✕ chip on the action tab header, which also just nulls the
      // selection without switching tabs. We used to force-switch to
      // N-1 here, which was surprising: it erased the pin overview
      // the user had just returned to. See VisualizationPanel tab
      // label for the matching ✕-chip path.
      return;
    }

    // Preserve the current viewBox across action switches. When the
    // action tab is inline in the main window, `activeTab === 'action'`
    // tells us the user is currently looking at the action diagram and
    // `actionPZ.viewBox` is the right source. When the action tab is
    // DETACHED into a popup, `activeTab` is 'n' or 'contingency' (the main
    // window's current tab) but the popup is still showing the action
    // diagram — so `actionPZ.viewBox` is STILL the correct source and
    // we must use it even though `activeTab` is not 'action'. Without
    // this branch, clicking a different action card in a detached
    // popup would snap the popup back to the N / N-1 viewBox instead
    // of preserving the zoom the user had on the previous action.
    const actionTabShowsActionDiagram = activeTabRef.current === 'action' || isActionDetached;
    actionSyncSourceRef.current =
      (actionTabShowsActionDiagram ? actionPZ.viewBox : null)
      || n1PZ.viewBox || nPZ.viewBox;

    if (actionId !== null) {
      interactionLogger.record('action_selected', { action_id: actionId });
    }
    setSelectedActionId(actionId);
    // Do NOT clear actionDiagram synchronously here — the patch path
    // is fast enough that nulling the diagram just to repopulate
    // ~200-500 ms later causes a visible "blank flash" on large
    // grids. Leave the previous action's SVG in place; the new
    // cloned+patched DOM atomically replaces it when setActionDiagram
    // is called with the fresh payload below.
    if (actionId === null) {
      setActionDiagram(null);
      return;
    }

    latestActionSelectRef.current = actionId;
    setActionDiagramLoading(true);
    // Switching the main window's activeTab to 'action' would blank the
    // current N or N-1 view and replace it with the "Detached" placeholder.
    // When the action tab lives in a popup, keep the main window where the
    // user left it and let the popup pick up the new diagram via its
    // existing render path.
    if (!isActionDetached) {
      setActiveTab('action');
    }
    // Fast path #0: ActionFeed may have already fetched and processed
    // the post-action diagram while the user was still reading the
    // sidebar card (via the streamed simulate-and-variant-diagram
    // endpoint). If so, paint it instantly — no XHR, no extra pypowsybl.
    const cached = actionDiagramCacheRef.current.get(actionId);
    if (cached) {
      console.log('[svgPatch] action cache HIT — no network call', actionId);
      setActionDiagram(cached);
      setActionDiagramLoading(false);
      return;
    }
    // Fast path — svgPatch DOM-recycling for actions. Clone the
    // already-loaded N-1 SVG (fall back to N if N-1 is not loaded)
    // and mutate only the flow labels for the action state. The
    // backend flags topology-changing actions with `patchable: false`,
    // in which case we fall back to the full /api/action-variant-diagram
    // endpoint. See docs/performance/history/svg-dom-recycling.md.
    const baseSvgEl =
      (n1SvgContainerRef.current?.querySelector('svg') as SVGSVGElement | null) ??
      (nSvgContainerRef.current?.querySelector('svg') as SVGSVGElement | null);
    const baseMeta = n1MetaIndex ?? nMetaIndex;
    const baseMetadataRaw = n1Diagram?.metadata ?? nDiagram?.metadata ?? null;
    const baseViewBoxRaw = n1Diagram?.originalViewBox ?? nDiagram?.originalViewBox ?? null;
    // Fresh object reference per patch — usePanZoom re-caches
    // svgElRef via useLayoutEffect([initialViewBox]).
    const baseViewBox = baseViewBoxRaw ? { ...baseViewBoxRaw } : null;
    if (baseSvgEl && baseMeta && !restoringSessionRef.current) {
      console.log('[svgPatch] action patch PATH — calling /api/action-variant-diagram-patch', actionId);
      try {
        const patch = await api.getActionVariantDiagramPatch(actionId);
        if (patch.patchable) {
          // Stale-response guard: if the user clicked a newer action
          // while this patch was in flight, drop the response without
          // touching state — the newer click is already running.
          if (latestActionSelectRef.current !== actionId) {
            console.log('[svgPatch] action patch response dropped (stale)', actionId);
            return;
          }
          console.log('[svgPatch] action patch applied (patchable=true)', actionId);
          const cloned = cloneBaseSvg(baseSvgEl);
          applyPatchToClone(cloned, baseMeta, patch);
          setActionDiagram({
            svg: cloned,
            metadata: baseMetadataRaw,
            originalViewBox: baseViewBox,
            action_id: actionId,
            lines_overloaded: patch.lines_overloaded,
            lines_overloaded_rho: patch.lines_overloaded_rho,
            flow_deltas: patch.flow_deltas,
            reactive_flow_deltas: patch.reactive_flow_deltas,
            asset_deltas: patch.asset_deltas,
            lf_converged: patch.lf_converged,
            lf_status: patch.lf_status,
          });
          setActionDiagramLoading(false);
          return;
        } else {
          console.log('[svgPatch] action patch REJECTED — falling back to full NAD', actionId, 'reason:', patch.reason);
        }
      } catch (e) {
        console.warn('[svgPatch] action patch threw — falling back', actionId, e);
      }
    } else {
      console.log('[svgPatch] action patch SKIPPED — no base SVG/meta in DOM yet. baseSvgEl:', !!baseSvgEl, 'baseMeta:', !!baseMeta, 'restoring:', restoringSessionRef.current);
    }

    try {
      const res = await api.getActionVariantDiagram(actionId);
      // Stale-response guard: see the patch-path comment above.
      if (latestActionSelectRef.current !== actionId) {
        console.log('[svgPatch] full-NAD response dropped (stale)', actionId);
        return;
      }
      const { svg, viewBox } = processSvg(res.svg, voltageLevelsLength);
      setActionDiagram({ ...res, svg, originalViewBox: viewBox });
    } catch {
      if (selectedContingencyArg.length > 0) {
        // Fallback path: action isn't in the recommender's prioritised list yet
        // so the backend has no post-action observation cached. Previously this
        // was a two-shot HTTP call (simulateManualAction then getActionVariantDiagram),
        // which serialised the grid2op simulation and the pypowsybl NAD
        // generation across two round-trips. We now use the combined streamed
        // endpoint: the action card's rho numbers update as soon as the
        // simulation completes (≈5 s earlier than the diagram on large grids).
        try {
          let actionContent: Record<string, unknown> | null = null;
          if (actionId.includes('+')) {
            const parts = actionId.split('+');
            const perAction: Record<string, unknown> = {};
            for (const part of parts) {
              const partDetail = result?.actions?.[part];
              if (partDetail?.action_topology) perAction[part] = partDetail.action_topology;
            }
            if (Object.keys(perAction).length > 0) actionContent = perAction;
          } else {
            const detail = result?.actions?.[actionId];
            actionContent = (detail?.action_topology as unknown as Record<string, unknown>) ?? null;
          }
          const linesOvl = result?.lines_overloaded?.length ? result.lines_overloaded : null;

          const response = await api.simulateAndVariantDiagramStream({
            action_id: actionId,
            disconnected_elements: selectedContingencyArg,
            action_content: actionContent,
            lines_overloaded: linesOvl,
          });
          const reader = response.body!.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          let streamErr: string | null = null;
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop()!;
            for (const line of lines) {
              if (!line.trim()) continue;
              let event: Record<string, unknown>;
              try {
                event = JSON.parse(line);
              } catch {
                continue; // incomplete row
              }
              if (event.type === 'metrics') {
                const simRes = event as unknown as {
                  description_unitaire: string;
                  rho_before: number[] | null;
                  rho_after: number[] | null;
                  max_rho: number | null;
                  max_rho_line: string;
                  is_rho_reduction: boolean;
                  non_convergence: string | null;
                  is_islanded?: boolean;
                  n_components?: number;
                  disconnected_mw?: number;
                };
                setResult(prev => {
                  if (!prev) return prev;
                  const existing = prev.actions[actionId] || {} as Partial<ActionDetail>;
                  const hasRho = (existing.rho_before?.length ?? 0) > 0;
                  return {
                    ...prev,
                    actions: {
                      ...prev.actions,
                      [actionId]: {
                        ...existing,
                        description_unitaire: existing.description_unitaire || simRes.description_unitaire,
                        rho_before: hasRho ? existing.rho_before : simRes.rho_before,
                        rho_after: hasRho ? existing.rho_after : simRes.rho_after,
                        max_rho: hasRho ? existing.max_rho : simRes.max_rho,
                        max_rho_line: hasRho ? existing.max_rho_line : simRes.max_rho_line,
                        is_rho_reduction: hasRho ? existing.is_rho_reduction : simRes.is_rho_reduction,
                        non_convergence: simRes.non_convergence,
                        is_islanded: simRes.is_islanded,
                        n_components: simRes.n_components,
                        disconnected_mw: simRes.disconnected_mw,
                      } as ActionDetail,
                    },
                  };
                });
              } else if (event.type === 'diagram') {
                const diag = event as unknown as DiagramData & { svg: string };
                const { svg, viewBox } = processSvg(diag.svg, voltageLevelsLength);
                setActionDiagram({ ...diag, svg, originalViewBox: viewBox });
              } else if (event.type === 'error') {
                streamErr = (event.message as string) || 'stream error';
              }
            }
          }
          if (streamErr) {
            throw new Error(streamErr);
          }
        } catch (simErr) {
          console.error('Failed to simulate and fetch diagram for', actionId, simErr);
          setError('Failed to load action diagram for ' + actionId);
        }
      } else {
        setError('Failed to fetch action variant diagram for ' + actionId);
      }
    } finally {
      setActionDiagramLoading(false);
    }
  }, [selectedActionId, actionPZ.viewBox, n1PZ.viewBox, nPZ.viewBox, nDiagram, n1Diagram, nMetaIndex, n1MetaIndex]);

  // Helper used by per-tab inspect overlays: records which tab
  // should be zoomed on the auto-zoom effect's next tick, then
  // updates the shared inspect query so the effect sees the change.
  const setInspectQueryForTab = useCallback((targetTab: TabId, query: string) => {
    inspectFocusTabRef.current = targetTab;
    setInspectQuery(query);
  }, []);

  // ===== Zoom Controls =====
  // These accept an optional `targetTab` so that a zoom button
  // rendered inside a detached-tab overlay can operate on that
  // specific tab's pan/zoom instance rather than on the main
  // window's `activeTab` (the two may be different while the tab is
  // detached into a popup).
  const handleManualZoomIn = useCallback((targetTab?: TabId) => {
    const tab = targetTab ?? activeTab;
    if (tab === 'overflow') return;
    interactionLogger.record('zoom_in', { tab });
    const pz = tab === 'action' ? actionPZ : tab === 'n' ? nPZ : n1PZ;
    const vb = pz?.viewBox;
    if (pz && vb) {
      const scale = 0.8;
      pz.setViewBox({
        x: vb.x + vb.w * (1 - scale) / 2,
        y: vb.y + vb.h * (1 - scale) / 2,
        w: vb.w * scale,
        h: vb.h * scale,
      });
    }
  }, [activeTab, actionPZ, nPZ, n1PZ]);

  const handleManualZoomOut = useCallback((targetTab?: TabId) => {
    const tab = targetTab ?? activeTab;
    if (tab === 'overflow') return;
    interactionLogger.record('zoom_out', { tab });
    const pz = tab === 'action' ? actionPZ : tab === 'n' ? nPZ : n1PZ;
    const vb = pz?.viewBox;
    if (pz && vb) {
      const scale = 1.25;
      pz.setViewBox({
        x: vb.x + vb.w * (1 - scale) / 2,
        y: vb.y + vb.h * (1 - scale) / 2,
        w: vb.w * scale,
        h: vb.h * scale,
      });
    }
  }, [activeTab, actionPZ, nPZ, n1PZ]);

  const handleManualReset = useCallback((targetTab?: TabId) => {
    const tab = targetTab ?? activeTab;
    if (tab === 'overflow') return;
    interactionLogger.record('zoom_reset', { tab });
    setInspectQuery('');

    const pz = tab === 'action' ? actionPZ : tab === 'n' ? nPZ : n1PZ;
    const diagram = tab === 'action' ? actionDiagram : tab === 'n' ? nDiagram : n1Diagram;
    const viewBox = diagram?.originalViewBox || originalViewBox;

    if (pz && viewBox) {
      pz.setViewBox(viewBox);
      // Record the current contingency anchor (not an empty branch) so the
      // auto-zoom effect does NOT see a "branch change" and immediately
      // re-zoom back onto the contingency — Unzoom must fully unzoom to the
      // whole-network view and stay there.
      lastZoomState.current = { query: '', branch: selectedContingency[0] || '' };
    }

    const container = tab === 'action' ? actionSvgContainerRef.current
      : tab === 'n' ? nSvgContainerRef.current : n1SvgContainerRef.current;
    if (container) {
      container.querySelectorAll('.nad-highlight').forEach(el => el.classList.remove('nad-highlight'));
    }
  }, [activeTab, actionPZ, nPZ, n1PZ, actionDiagram, nDiagram, n1Diagram, originalViewBox, selectedContingency]);

  // ===== Tab Synchronization =====
  useLayoutEffect(() => {
    const prevTab = prevTabRef.current;
    if (prevTab === activeTab) return;
    prevTabRef.current = activeTab;

    if (prevTab === 'overflow' || activeTab === 'overflow') return;

    const sourceVB = prevTab === 'n' ? nPZ.viewBox
      : prevTab === 'contingency' ? n1PZ.viewBox
        : prevTab === 'action' ? actionPZ.viewBox
          : null;
    if (!sourceVB) return;

    if (activeTab === 'n') nPZ.setViewBox(sourceVB);
    else if (activeTab === 'contingency') n1PZ.setViewBox(sourceVB);
    else if (activeTab === 'action') actionPZ.setViewBox(sourceVB);
  }, [activeTab, nPZ, n1PZ, actionPZ]);

  // Re-sync after action diagram loads. Fires when the action tab is
  // currently inline in the main window OR detached into a popup —
  // both cases need the captured viewBox to be re-applied over the
  // native one usePanZoom resets to on every new diagram load.
  // Without the detached branch, switching actions inside a detached
  // popup would lose the user's zoom every time (see
  // handleActionSelect for the capture side of the same pattern).
  useEffect(() => {
    const isActionDetached = !!detachedTabsRef.current?.['action'];
    const captured = actionSyncSourceRef.current;
    if (actionDiagram && captured && (activeTab === 'action' || isActionDetached)) {
      actionPZ.setViewBox(captured);
      actionSyncSourceRef.current = null;
    }
  }, [actionDiagram, activeTab, actionPZ, detachedTabs]);

  // ===== Asset Click =====
  const handleAssetClick = useCallback((
    actionId: string,
    assetName: string,
    tab: 'action' | 'n' | 'contingency' = 'action',
    currentSelectedActionId: string | null,
    handleActionSelectFn: (actionId: string | null) => void,
  ) => {
    interactionLogger.record('asset_clicked', { action_id: actionId, asset_name: assetName, tab });
    // Route the auto-zoom to the clicked tab explicitly — the
    // auto-zoom effect reads `inspectFocusTabRef` and falls back to
    // `activeTab` only when no explicit target is set. Routing here
    // is what lets the zoom happen on the correct (detached) tab
    // even when we DO NOT switch the main window's `activeTab`.
    setInspectQueryForTab(tab, assetName);

    // A tab that lives in a detached popup must NOT force the main
    // window's `activeTab` — doing so blanks whatever tab the user
    // had open and replaces it with the "Detached" placeholder. The
    // detached popup is already re-rendering the correct diagram via
    // the shared React subtree, so we just update inspect state and
    // leave `activeTab` alone.
    const isTabDetached = !!detachedTabsRef.current?.[tab];

    if (tab === 'n') {
      if (!isTabDetached) setActiveTab('n');
    } else if (tab === 'contingency') {
      if (!isTabDetached) setActiveTab('contingency');
    } else if (actionId !== currentSelectedActionId) {
      // Selecting a different action card. `handleActionSelect`
      // already has its own detached-tab guard (it refrains from
      // switching activeTab to 'action' when the tab is detached),
      // so we just forward the call.
      handleActionSelectFn(actionId);
    } else {
      // Same action, user is re-focusing an asset within it. Only
      // force `activeTab` to 'action' when the tab is inline — for
      // the detached case we keep the main window where it is.
      if (!isTabDetached) setActiveTab('action');
    }
  }, [setInspectQueryForTab]);

  // ===== Zoom to Element =====
  // Accepts an optional `targetTab` so an in-tab inspect overlay can
  // zoom its OWN tab rather than the main-window `activeTab` — this
  // is what makes asset focus work inside a detached popup for a
  // tab that isn't currently the main activeTab.
  const zoomToElement = useCallback((targetId: string, targetTab?: TabId) => {
    const tab = targetTab ?? activeTab;
    if (tab === 'overflow') return;
    const currentPZ = tab === 'action' ? actionPZ : tab === 'n' ? nPZ : n1PZ;
    const container = tab === 'action' ? actionSvgContainerRef.current
      : tab === 'n' ? nSvgContainerRef.current : n1SvgContainerRef.current;
    const index = tab === 'action' ? actionMetaIndex : tab === 'n' ? nMetaIndex : n1MetaIndex;
    if (!currentPZ || !container || !index) return;

    try {
      const { nodesByEquipmentId, edgesByEquipmentId } = index;
      const points: { x: number; y: number }[] = [];

      let targetNode = nodesByEquipmentId.get(targetId);
      let targetEdge = edgesByEquipmentId.get(targetId);
      let targetSvgId: string | undefined;

      let usingFallbackIndex = false;
      let effectiveIndex = index;

      if (!targetNode && !targetEdge) {
        const dotIdx = targetId.indexOf('.');
        if (dotIdx >= 0) {
          const suffix = targetId.substring(dotIdx + 1);
          targetNode = nodesByEquipmentId.get(suffix) ?? undefined;
          if (!targetNode) targetEdge = edgesByEquipmentId.get(suffix) ?? undefined;
        }
      }

      if (!targetNode && !targetEdge && index !== nMetaIndex && nMetaIndex) {
        let nNode = nMetaIndex.nodesByEquipmentId.get(targetId);
        let nEdge = nMetaIndex.edgesByEquipmentId.get(targetId);
        if (!nNode && !nEdge) {
          const dotIdx = targetId.indexOf('.');
          if (dotIdx >= 0) {
            const suffix = targetId.substring(dotIdx + 1);
            nNode = nMetaIndex.nodesByEquipmentId.get(suffix) ?? undefined;
            if (!nNode) nEdge = nMetaIndex.edgesByEquipmentId.get(suffix) ?? undefined;
          }
        }
        if (nNode || nEdge) {
          targetNode = nNode;
          targetEdge = nEdge;
          usingFallbackIndex = true;
          effectiveIndex = nMetaIndex;
        }
      }

      // Guard against NaN/Infinity coordinates: pypowsybl strips NaN
      // SVG elements (services/diagram/nad_render.py:_strip_nan_elements)
      // but leaves the corresponding metadata entry intact. Accumulating
      // a non-finite point would propagate NaN through Math.min/max into
      // the viewBox, yielding `<svg viewBox="NaN … NaN …">` and a blank
      // diagram on tab switch.
      const addNodePointsBySvgId = (svgId: string) => {
        const n = effectiveIndex.nodesBySvgId.get(svgId);
        if (n && Number.isFinite(n.x) && Number.isFinite(n.y)) {
          points.push({ x: n.x, y: n.y });
        }
        return n;
      };

      if (targetNode) {
        if (!usingFallbackIndex) targetSvgId = targetNode.svgId;
        if (Number.isFinite(targetNode.x) && Number.isFinite(targetNode.y)) {
          points.push({ x: targetNode.x, y: targetNode.y });
        }
        (effectiveIndex.edgesByNode.get(targetNode.svgId) || []).forEach(e => {
          addNodePointsBySvgId(e.node1);
          addNodePointsBySvgId(e.node2);
        });
      } else if (targetEdge) {
        if (!usingFallbackIndex) targetSvgId = targetEdge.svgId;
        const n1 = addNodePointsBySvgId(targetEdge.node1);
        const n2 = addNodePointsBySvgId(targetEdge.node2);
        if (n1) (effectiveIndex.edgesByNode.get(n1.svgId) || []).forEach(e => { addNodePointsBySvgId(e.node1); addNodePointsBySvgId(e.node2); });
        if (n2) (effectiveIndex.edgesByNode.get(n2.svgId) || []).forEach(e => { addNodePointsBySvgId(e.node1); addNodePointsBySvgId(e.node2); });
      }

      if (points.length > 0) {
        const minX = Math.min(...points.map(p => p.x));
        const maxX = Math.max(...points.map(p => p.x));
        const minY = Math.min(...points.map(p => p.y));
        const maxY = Math.max(...points.map(p => p.y));

        const centerX = (minX + maxX) / 2;
        const centerY = (minY + maxY) / 2;
        const boxW = Math.max(maxX - minX, 50);
        const boxH = Math.max(maxY - minY, 50);

        const padding = 1.8;
        const screenW = container.getBoundingClientRect().width;
        const screenH = container.getBoundingClientRect().height;
        const screenAR = screenW / screenH;

        let targetW = boxW * padding;
        let targetH = boxH * padding;

        if (targetW / targetH > screenAR) {
          targetH = targetW / screenAR;
        } else {
          targetW = targetH * screenAR;
        }

        const targetX = centerX - targetW / 2;
        const targetY = centerY - targetH / 2;

        currentPZ.setViewBox({ x: targetX, y: targetY, w: targetW, h: targetH });

        container.querySelectorAll('.nad-highlight').forEach(el => el.classList.remove('nad-highlight'));
        if (targetSvgId) {
          const el = container.querySelector(`[id="${targetSvgId}"]`);
          if (el) el.classList.add('nad-highlight');
        }
      }
    } catch (e) {
      console.error('Zoom failed:', e);
    }
  }, [activeTab, actionPZ, nPZ, n1PZ, actionMetaIndex, nMetaIndex, n1MetaIndex]);

  // Inspectable items
  const inspectableItems = useMemo(() =>
    [...branches, ...voltageLevels].sort(),
    [branches, voltageLevels]
  );

  // Set for O(1) lookup used by the zoom guard.  See
  // `computeKnownItemsSet` for the why.
  const knownItemsSet = useMemo(
    () => computeKnownItemsSet(branches, voltageLevels, [nMetaIndex, n1MetaIndex, actionMetaIndex]),
    [branches, voltageLevels, nMetaIndex, n1MetaIndex, actionMetaIndex],
  );

  // ===== Voltage Range Filter =====
  const staleVoltageFilter = useRef<Set<TabId>>(new Set());
  const prevVFTabRef = useRef<TabId>(activeTab);
  // Track, per tab, whether the last applied filter actually hid
  // something. We can only safely skip the filter loop on a
  // fully-open range when the previous range was ALSO fully open —
  // otherwise we'd leave previously-hidden elements (e.g. all 400 kV
  // nodes/edges when the user was pinned to 225 kV) invisible after
  // the user expands the range back out.
  const prevFilterHadHidden = useRef<Record<TabId, boolean>>({
    n: false,
    'contingency': false,
    action: false,
    overflow: false,
  });

  const applyVoltageFilter = useCallback((tab: TabId, container: HTMLElement | null, metaIndex: MetadataIndex | null) => {
    if (!container || !metaIndex) return;
    if (uniqueVoltages.length === 0 || Object.keys(nominalVoltageMap).length === 0) return;

    const [minKv, maxKv] = voltageRange;
    const fullyOpen = minKv <= uniqueVoltages[0] && maxKv >= uniqueVoltages[uniqueVoltages.length - 1];
    if (fullyOpen && !prevFilterHadHidden.current[tab]) return;

    const isInRange = (vlId: string) => {
      const kv = nominalVoltageMap[vlId];
      return kv != null && kv >= minKv && kv <= maxKv;
    };

    const { nodesByEquipmentId, nodesBySvgId, edgesByEquipmentId } = metaIndex;
    const idMap = getIdMap(container);
    let anyHidden = false;

    for (const [vlId, node] of nodesByEquipmentId) {
      const visible = isInRange(vlId);
      if (!visible) anyHidden = true;
      const show = visible ? '' : 'none';
      const el = idMap.get(node.svgId) as HTMLElement | undefined;
      if (el) el.style.display = show;
      if (node.legendSvgId) {
        const leg = idMap.get(node.legendSvgId as string) as HTMLElement | undefined;
        if (leg) leg.style.display = show;
      }
      if (node.legendEdgeSvgId) {
        const legE = idMap.get(node.legendEdgeSvgId as string) as HTMLElement | undefined;
        if (legE) legE.style.display = show;
      }
    }

    for (const [, edge] of edgesByEquipmentId) {
      const node1 = nodesBySvgId.get(edge.node1);
      const node2 = nodesBySvgId.get(edge.node2);
      const vl1InRange = node1 ? isInRange(node1.equipmentId) : true;
      const vl2InRange = node2 ? isInRange(node2.equipmentId) : true;
      const edgeVisible = vl1InRange || vl2InRange;
      if (!edgeVisible) anyHidden = true;
      const show = edgeVisible ? '' : 'none';

      const el = idMap.get(edge.svgId) as HTMLElement | undefined;
      if (el) el.style.display = show;
      if (edge.edgeInfo1?.svgId) {
        const ei = idMap.get(edge.edgeInfo1.svgId) as HTMLElement | undefined;
        if (ei) ei.style.display = show;
      }
      if (edge.edgeInfo2?.svgId) {
        const ei = idMap.get(edge.edgeInfo2.svgId) as HTMLElement | undefined;
        if (ei) ei.style.display = show;
      }
    }

    prevFilterHadHidden.current[tab] = anyHidden;
  }, [voltageRange, nominalVoltageMap, uniqueVoltages]);

  useEffect(() => {
    if (uniqueVoltages.length === 0 || Object.keys(nominalVoltageMap).length === 0) return;

    const isTabSwitch = prevVFTabRef.current !== activeTab;
    prevVFTabRef.current = activeTab;

    const runFilter = () => {
      if (activeTab === 'n' || activeTab === 'overflow') {
        applyVoltageFilter('n', nSvgContainerRef.current, nMetaIndex);
        staleVoltageFilter.current.delete('n');
        staleVoltageFilter.current.add('contingency');
        staleVoltageFilter.current.add('action');
      } else if (activeTab === 'contingency') {
        applyVoltageFilter('contingency', n1SvgContainerRef.current, n1MetaIndex);
        staleVoltageFilter.current.delete('contingency');
        staleVoltageFilter.current.add('n');
        staleVoltageFilter.current.add('action');
      } else if (activeTab === 'action') {
        applyVoltageFilter('action', actionSvgContainerRef.current, actionMetaIndex);
        staleVoltageFilter.current.delete('action');
        staleVoltageFilter.current.add('n');
        staleVoltageFilter.current.add('contingency');
      }
    };

    if (isTabSwitch) {
      const id = requestAnimationFrame(runFilter);
      return () => cancelAnimationFrame(id);
    } else {
      runFilter();
    }
  }, [voltageRange, nDiagram, n1Diagram, actionDiagram, nMetaIndex, n1MetaIndex, actionMetaIndex, nominalVoltageMap, uniqueVoltages, activeTab, applyVoltageFilter]);

  // Auto-zoom to selected element via viewBox
  useEffect(() => {
    // Resolve which tab to zoom on. A detached-tab overlay can
    // override the default (the main-window activeTab) by setting
    // `inspectFocusTabRef.current` just before updating the inspect
    // query. This is how asset focus works inside a detached popup
    // for a tab that isn't currently activeTab.
    const focusTab = inspectFocusTabRef.current ?? activeTab;
    if (focusTab === 'overflow') return;

    // For zoom-target purposes the contingency is summarised as its
    // first element — multi-element contingencies don't have a
    // single anchor target on the NAD anyway. Using the joined key
    // would still work but the zoom helpers expect a single id.
    const contingencyAnchor = selectedContingency[0] || '';
    const queryChanged = inspectQuery !== lastZoomState.current.query;
    const branchChanged = !inspectQuery && contingencyAnchor !== lastZoomState.current.branch;

    if (!queryChanged && !branchChanged) return;

    const targetId = inspectQuery || contingencyAnchor;

    // Cleared inspect → reset view
    if (!targetId && queryChanged) {
      lastZoomState.current = { query: inspectQuery, branch: contingencyAnchor };
      handleManualReset(focusTab);
      // Clear the focus override once the query has been consumed.
      inspectFocusTabRef.current = null;
      return;
    }

    if (!targetId) return;

    // Only zoom when targetId is a confirmed known element (exact match).
    // Partial keystrokes like "LIN" won't match → zoom skipped.
    // Datalist selection sets the input to the full exact value → match fires.
    if (!knownItemsSet.has(targetId)) return;

    // Branch changes should zoom on the contingency tab, not N.
    // In the same render cycle, setActiveTab('contingency') is batched
    // but not committed — this effect still sees activeTab='n'. Skip
    // here; the effect re-runs when activeTab changes to 'contingency'.
    if (branchChanged && focusTab === 'n') return;

    // Only consume the zoom intent when the container has SVG content.
    // If not ready (e.g. contingency NAD still loading), skip — the
    // effect re-runs when the diagram changes, and branchChanged will
    // still be true.
    const container = focusTab === 'action' ? actionSvgContainerRef.current
      : focusTab === 'n' ? nSvgContainerRef.current : n1SvgContainerRef.current;
    if (!container || !container.querySelector('svg')) return;

    lastZoomState.current = { query: inspectQuery, branch: contingencyAnchor };
    zoomToElement(targetId, focusTab);
    inspectFocusTabRef.current = null;

  }, [activeTab, nDiagram, n1Diagram, actionDiagram, inspectQuery, selectedContingency, handleManualReset, zoomToElement, knownItemsSet]);

  return useMemo(() => ({
    activeTab, setActiveTab,
    nDiagram, setNDiagram,
    n1Diagram, setN1Diagram,
    n1Loading, setN1Loading,
    selectedActionId, setSelectedActionId,
    actionDiagram, setActionDiagram,
    actionDiagramLoading, setActionDiagramLoading,
    actionViewMode, setActionViewMode,
    handleViewModeChange,
    showVoltageLevelNames, setShowVoltageLevelNames,
    overflowLayoutMode, setOverflowLayoutMode,
    overflowLayoutLoading,
    handleOverflowLayoutChange,
    originalViewBox, setOriginalViewBox,
    inspectQuery, setInspectQuery,
    setInspectQueryForTab,
    nSvgContainerRef, n1SvgContainerRef, actionSvgContainerRef,
    nPZ, n1PZ, actionPZ,
    nMetaIndex, n1MetaIndex, actionMetaIndex,
    nominalVoltageMap, setNominalVoltageMap,
    uniqueVoltages, setUniqueVoltages,
    voltageRange, setVoltageRange,
    vlOverlay, setVlOverlay,
    committedBranchRef, restoringSessionRef,
    lastZoomState, actionSyncSourceRef,
    fetchBaseDiagram,
    ingestBaseDiagram,
    handleActionSelect,
    handleManualZoomIn,
    handleManualZoomOut,
    handleManualReset,
    handleVlDoubleClick,
    handleOverlaySldTabChange,
    handleOverlayClose,
    handleAssetClick,
    zoomToElement,
    inspectableItems,
    selectedContingencyForSld,
    primeActionDiagram,
    refreshSldIfAction,
  }), [
    activeTab, nDiagram, n1Diagram, n1Loading,
    selectedActionId, actionDiagram, actionDiagramLoading, actionViewMode, handleViewModeChange,
    showVoltageLevelNames,
    overflowLayoutMode, overflowLayoutLoading, handleOverflowLayoutChange,
    originalViewBox, inspectQuery,
    nPZ, n1PZ, actionPZ,
    nMetaIndex, n1MetaIndex, actionMetaIndex,
    nominalVoltageMap, uniqueVoltages, voltageRange,
    vlOverlay, fetchBaseDiagram, ingestBaseDiagram, handleActionSelect,
    handleManualZoomIn, handleManualZoomOut, handleManualReset,
    handleVlDoubleClick, handleOverlaySldTabChange, handleOverlayClose,
    handleAssetClick, zoomToElement, inspectableItems,
    selectedContingencyForSld, setVlOverlay,
    setInspectQueryForTab,
    primeActionDiagram,
    refreshSldIfAction,
  ]);
}
