// Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
// This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
// If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
// you can obtain one at http://mozilla.org/MPL/2.0/.
// SPDX-License-Identifier: MPL-2.0
// This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study. 

export interface ConfigRequest {
    network_path: string;
    action_file_path: string;
    min_line_reconnections: number;
    min_close_coupling: number;
    min_open_coupling: number;
    min_line_disconnections: number;
    min_pst?: number;
    min_load_shedding?: number;
    min_renewable_curtailment_actions?: number;
    min_redispatch?: number;
    allowed_action_types?: string[];
    n_prioritized_actions: number;
    lines_monitoring_path?: string;
    monitoring_factor: number;
    pre_existing_overload_threshold?: number;
    ignore_reconnections?: boolean;
    pypowsybl_fast_mode?: boolean;
    layout_path?: string;
    // Pluggable recommender selection. ``model`` is the registry key
    // (e.g. "expert", "random", "random_overflow" or a third-party
    // plugin name); ``compute_overflow_graph`` toggles the (expensive)
    // step-2 graph build for models that don't strictly require it.
    model?: string;
    compute_overflow_graph?: boolean;
}

export interface AnalysisRequest {
    /**
     * Ordered list of element IDs to disconnect simultaneously. A
     * single-item list is the legacy N-1 case; longer lists drive
     * N-K (multi-element) contingency studies.
     */
    disconnected_elements: string[];
}

export interface ActionTopology {
    lines_ex_bus: Record<string, number>;
    lines_or_bus: Record<string, number>;
    gens_bus: Record<string, number>;
    loads_bus: Record<string, number>;
    pst_tap?: Record<string, number>;
    substations?: Record<string, unknown>;
    switches?: Record<string, unknown>;
    loads_p?: Record<string, number>;
    gens_p?: Record<string, number>;
    // Backend-supplied VoltageLevelId hint surfaced from the
    // dict_action entry for pypowsybl switch-based / coupling
    // actions. Highest-priority signal for the Action Overview pin
    // anchor and the ActionCard VL chip.
    voltage_level_id?: string;
}

export interface LoadSheddingDetail {
    load_name: string;
    voltage_level_id: string | null;
    shedded_mw: number;
}
export interface CurtailmentDetail {
    gen_name: string;
    voltage_level_id: string | null;
    curtailed_mw: number;
}
export interface PstDetail {
    pst_name: string;
    tap_position: number;
    low_tap: number | null;
    high_tap: number | null;
}
export interface RedispatchDetail {
    gen_name: string;
    voltage_level_id: string | null;
    // Signed MW change applied to the generator: > 0 raises production,
    // < 0 lowers it.
    delta_mw: number;
    // Resulting production magnitude (MW) after the redispatch.
    target_mw: number;
    direction: 'up' | 'down';
    // Current production (MW) before the redispatch.
    current_mw?: number;
    // Maximum further raise / lower (MW) bounded by the generator's
    // [min_p, max_p] active-power limits. Null when unknown.
    max_raise_mw?: number | null;
    max_lower_mw?: number | null;
}

export interface ActionDetail {
    description_unitaire: string;
    rho_before: number[] | null;
    rho_after: number[] | null;
    max_rho: number | null;
    max_rho_line: string;
    is_rho_reduction: boolean;
    estimated_max_rho?: number | null;
    estimated_max_rho_line?: string;
    is_manual?: boolean;
    is_estimated?: boolean;
    is_islanded?: boolean;
    n_components?: number;
    disconnected_mw?: number;
    non_convergence?: string | null;
    action_topology?: ActionTopology;
    lines_overloaded_after?: string[];
    /**
     * ``{line_name: live_end_reactive_mvar}`` for still-"overloaded" lines the
     * action leaves open at ONE end with a loading above ~1 %. Such a line is
     * out of service for active power (the SLD / NAD show p = 0) but its
     * capacitance draws reactive charging current from the live end, so its
     * current-based loading stays non-zero (the reported ~33 %). The ActionCard
     * annotates the loading with the reactive amount so it reads as charging
     * current, not a residual overload. Backend: ``half_open_branch_reactive_from_obs``.
     */
    half_open_overloads?: Record<string, number>;
    load_shedding_details?: LoadSheddingDetail[];
    curtailment_details?: CurtailmentDetail[];
    redispatch_details?: RedispatchDetail[];
    pst_details?: PstDetail[];
    /**
     * Provenance of the action card — distinct from `is_manual`, which
     * is an overloaded UI-state flag (it's also stamped `true` when the
     * operator stars a recommender suggestion). `origin` records where
     * the action *came from* and never changes after creation:
     *   - `"user"`      — the operator simulated it themselves (manual
     *                     search dropdown, "Make a first guess").
     *   - `<model id>`  — produced / scored by a recommender model
     *                     (e.g. `"expert"`, `"random_overflow"`); this
     *                     is the `active_model` echoed by the step-2
     *                     `result` event, and also covers an
     *                     unsimulated pin the operator materialised
     *                     (it was scored by that model).
     * Optional for backward compat: legacy sessions that predate the
     * field get an `origin` derived from their saved status flags on
     * reload (see `useSession.handleRestoreSession`).
     */
    origin?: string;
}

export interface CombinedAction {
    action1_id: string;
    action2_id: string;
    betas: number[];
    p_or_combined: number[];
    max_rho: number;
    max_rho_line: string;
    is_rho_reduction: boolean;
    description: string;
    rho_after: number[];
    rho_before: number[];
    is_islanded?: boolean;
    disconnected_mw?: number;
    estimated_max_rho?: number | null;
    estimated_max_rho_line?: string;
    target_max_rho?: number | null;
    target_max_rho_line?: string;
    error?: string;
}

export interface AnalysisResult {
    pdf_path: string | null;
    pdf_url: string | null;
    actions: Record<string, ActionDetail>;
    action_scores?: Record<string, { scores: Record<string, number>; mw_start?: Record<string, number | null>; tap_start?: Record<string, { pst_name: string; tap: number; low_tap: number | null; high_tap: number | null } | null> }>;
    lines_overloaded: string[];
    combined_actions?: Record<string, CombinedAction>;
    message: string;
    dc_fallback: boolean;
    lines_we_care_about?: string[];
    computed_pairs?: Record<string, unknown>;
    // Identifier of the recommender model that produced the
    // suggestions in this result (e.g. "expert", "random",
    // "random_overflow", or a third-party plugin name). Echoed by
    // the backend in every `result` SSE event from
    // `/api/run-analysis-step2`; persisted in the saved session so
    // a reload shows which model was active for the run.
    active_model?: string;
    // Whether the step-2 overflow-graph build actually ran for this
    // analysis. True when the chosen model declares
    // `requires_overflow_graph=true` OR the operator opted in via
    // the Compute Overflow Graph toggle.
    compute_overflow_graph?: boolean;
    // Per-stage execution times (seconds), reported by the backend.
    // `overflow_graph_time` is null when the active model does not
    // consume the overflow graph (no time was spent building it); it is
    // 0.0 on a cached re-run, so a model swap can be distinguished from
    // a fresh run. Used by the ActionFeed reminder and the iframe's
    // header to show the operator how long each stage took.
    overflow_graph_time?: number | null;
    action_prediction_time?: number;
    assessment_time?: number;
    // Step 1 (contingency simulation + overload detection) ran in a
    // separate HTTP call before step 2. The backend echoes its
    // wall-clock here so the breakdown can show the full pipeline.
    step1_time?: number | null;
    // Co-Study4Grid post-processing after assessment (action enrichment
    // + combined-pair target_max_rho augmentation + MW-start scoring).
    enrichment_time?: number;
    // Frontend wall-clock from the "Analyze & Suggest" click until the
    // result event arrives ("Display N prioritized actions" appears).
    // Captures backend stages + network round-trip + NDJSON streaming
    // overhead. Difference vs. the sum of the per-stage timings above
    // is the "transit" overhead.
    wall_clock_time?: number;
    // Present only when the contingency islands a radial ("antenne")
    // pocket: the overflow graph is a synthetic downstream graph of the
    // disconnected zone and recommendations are injection-only (load
    // shedding / curtailment / redispatch). Null/absent otherwise.
    antenna_meta?: AntennaMeta | null;
}

// Describes the disconnected radial pocket of an islanded-contingency
// ("antenne") analysis. Mirrors the recommender's antenna_meta dict.
export interface AntennaMeta {
    constraint_line_name: string;
    root_sub_name: string;
    antenna_sub_names: string[];
    n_subs: number;
    total_prod_mw: number;
    total_load_mw: number;
    net_mw: number;
    // "producer" (net export → curtailment / redispatch-down) or
    // "consumer" (net import → load shedding / redispatch-up).
    direction: 'producer' | 'consumer';
}

export interface BranchResponse {
    branches: string[];
    /** Optional mapping from element ID to human-readable display name. */
    name_map?: Record<string, string>;
}

/**
 * Mapping from element/VL ID to a human-readable display name.
 * Used throughout the UI to show real substation/circuit names.
 */
export type NameMap = Record<string, string>;

export interface DiagramData {
    svg: string | SVGSVGElement;
    metadata: unknown;
    lf_converged?: boolean;
    lf_status?: string;
    action_id?: string;
    flow_deltas?: Record<string, FlowDelta>;
    reactive_flow_deltas?: Record<string, FlowDelta>;
    asset_deltas?: Record<string, AssetDelta>;
    originalViewBox?: ViewBox | null;
    lines_overloaded?: string[];
    lines_overloaded_rho?: number[];
}

export interface FlowDelta {
    delta: number;
    category: 'positive' | 'negative' | 'grey';
    flip_arrow?: boolean;
}

export interface AssetDelta {
    delta_p: number;
    delta_q: number;
    category: 'positive' | 'negative' | 'grey';
    category_p?: 'positive' | 'negative' | 'grey';
    category_q?: 'positive' | 'negative' | 'grey';
}

export interface ViewBox {
    x: number;
    y: number;
    w: number;
    h: number;
}

export interface NodeMeta {
    equipmentId: string;
    svgId: string;
    x: number;
    y: number;
    legendSvgId?: string;
    legendEdgeSvgId?: string;
    [key: string]: unknown;
}

export interface EdgeInfoMeta {
    svgId: string;
    infoType?: string;
    direction?: string;
    externalLabel?: string;
}

export interface EdgeMeta {
    equipmentId: string;
    svgId: string;
    node1: string;
    node2: string;
    edgeInfo1?: EdgeInfoMeta;
    edgeInfo2?: EdgeInfoMeta;
    [key: string]: unknown;
}

export interface MetadataIndex {
    nodesByEquipmentId: Map<string, NodeMeta>;
    nodesBySvgId: Map<string, NodeMeta>;
    edgesByEquipmentId: Map<string, EdgeMeta>;
    edgesByNode: Map<string, EdgeMeta[]>;
    /** VL text-label (name box) svgId → its VL NodeMeta, so the label box can
     *  be interactive (open the SLD) exactly like the VL disk. Optional because
     *  the many hand-built MetadataIndex test fixtures omit it. */
    textNodesBySvgId?: Map<string, NodeMeta>;
}

export interface DiagramPatch {
    patchable: boolean;
    reason?: string;
    contingency_id?: string;
    action_id?: string;
    lf_converged: boolean;
    lf_status: string;
    non_convergence?: string | null;
    disconnected_edges?: string[];
    absolute_flows?: {
        p1: Record<string, number>;
        p2: Record<string, number>;
        q1: Record<string, number>;
        q2: Record<string, number>;
        vl1: Record<string, string>;
        vl2: Record<string, string>;
    };
    lines_overloaded?: string[];
    lines_overloaded_rho?: number[];
    flow_deltas?: Record<string, FlowDelta>;
    reactive_flow_deltas?: Record<string, FlowDelta>;
    asset_deltas?: Record<string, AssetDelta>;
    vl_subtrees?: Record<string, {
        node_svg: string;
        node_sub_svg_id: string;
        edge_fragments?: Record<string, { svg: string; sub_svg_id: string }>;
    }>;
    meta?: {
        base_state?: 'N' | 'contingency';
        elapsed_ms?: number;
    };
}

export type TabId = 'n' | 'contingency' | 'action' | 'overflow';

export interface SettingsBackup {
    networkPath?: string;
    actionPath?: string;
    outputFolderPath?: string;
    minLineReconnections: number;
    minCloseCoupling: number;
    minOpenCoupling: number;
    minLineDisconnections: number;
    minLoadShedding: number;
    minRenewableCurtailmentActions: number;
    minRedispatch: number;
    allowedActionTypes: string[];
    nPrioritizedActions: number;
    linesMonitoringPath: string;
    monitoringFactor: number;
    preExistingOverloadThreshold: number;
    ignoreReconnections?: boolean;
    pypowsyblFastMode?: boolean;
    layoutPath?: string;
}

export interface RecommenderDisplayConfig {
    minLineReconnections: number;
    minCloseCoupling: number;
    minOpenCoupling: number;
    minLineDisconnections: number;
    minPst: number;
    minLoadShedding: number;
    minRenewableCurtailmentActions: number;
    minRedispatch: number;
    nPrioritizedActions: number;
    ignoreReconnections: boolean;
}

export interface AvailableAction {
    id: string;
    description: string;
    type?: string;
}

export type SldTab = 'n' | 'contingency' | 'action';

export interface SldFeederNode {
    id: string;
    equipmentId: string;
    componentType?: string;
    direction?: string;
}

/**
 * Baseline descriptor for one editable active-power injection (a load or
 * generator) on the displayed SLD. Drives the interactive injection-edit
 * bubble in ``useSldTopologyEdit`` / ``SldInjectionPopover``: the operator
 * retunes ``p`` and the user-built action sends back the absolute setpoint
 * as ``{loads_p|gens_p: {id: MW}}``. Backend populates this on every SLD
 * endpoint via ``extract_vl_injections``.
 */
export interface VlInjection {
    kind: 'generator' | 'load';
    /** Current active-power setpoint (MW): ``target_p`` (gen) / ``p0`` (load). */
    p: number | null;
    /** Generator active-power capability bounds (MW); absent for loads. */
    min_p?: number | null;
    max_p?: number | null;
    /** Generator energy source (e.g. ``WIND`` / ``NUCLEAR``); absent for loads. */
    energy_source?: string;
}

/**
 * Identity + display label for one branch feeder on the displayed SLD.
 * Backend populates this on every SLD endpoint via ``build_feeder_labels``.
 *
 * ``label`` is the **name of the voltage level at the OTHER end** of the
 * branch (+ a parallel-circuit index when several branches of this VL reach
 * the same far-end VL) — far more interpretable than pypowsybl's default raw
 * IIDM branch id. ``name`` carries the branch's friendly / operator name
 * (e.g. ``MARSIL61PRAGN``) so an overloaded line reported by friendly name
 * can be mapped back to its IIDM-id-keyed SLD cell for the overload halo.
 */
export interface FeederLabel {
    /** Branch friendly (operator / grid2op) name; ``null`` when none. */
    name: string | null;
    /** Voltage-level id at the far end of the branch; ``null`` when unknown. */
    other_vl: string | null;
    /** Display label (far-end VL name + index); ``null`` → keep the default id. */
    label: string | null;
}

export interface VlOverlay {
    vlName: string;
    actionId: string | null;
    svg: string | null;
    sldMetadata: string | null;
    loading: boolean;
    error: string | null;
    tab: SldTab;
    flow_deltas?: Record<string, FlowDelta>;
    reactive_flow_deltas?: Record<string, FlowDelta>;
    asset_deltas?: Record<string, AssetDelta>;
    changed_switches?: Record<string, { from_open: boolean; to_open: boolean }>;
    /**
     * Branch feeder identities + relabel targets for the displayed VL, keyed
     * by IIDM equipment id. Drives the feeder relabelling (other-end VL name)
     * and the friendly-name → IIDM-id resolution that lets the overload halo
     * land on the right cell. Backend populates via ``build_feeder_labels``.
     */
    feeder_labels?: Record<string, FeederLabel>;
    /**
     * Baseline switch states for the displayed VL (``{switch_id:
     * is_open}``). Drives the interactive SLD-edit feature in
     * ``useSldTopologyEdit``: only switches present in this map are
     * editable, and a toggle is computed as ``user_state !== baseline``.
     * Backend populates this on every SLD endpoint via
     * ``extract_vl_switch_states``.
     */
    switch_states?: Record<string, boolean>;
    /**
     * Baseline active-power injections (loads + generators) for the
     * displayed VL, keyed by equipment id. Drives the interactive
     * injection-edit bubble: only equipment present here is editable, and
     * a staged change is computed as ``user_setpoint !== baseline.p``.
     * Backend populates this on every SLD endpoint via
     * ``extract_vl_injections``.
     */
    injections?: Record<string, VlInjection>;
}

// ===== Session Save =====

export interface SavedActionStatus {
    is_selected: boolean;
    is_suggested: boolean;
    is_rejected: boolean;
    is_manually_simulated: boolean;
}

export interface SavedActionEntry {
    description_unitaire: string;
    rho_before: number[] | null;
    rho_after: number[] | null;
    max_rho: number | null;
    max_rho_line: string;
    is_rho_reduction: boolean;
    is_estimated?: boolean;
    estimated_max_rho?: number | null;
    estimated_max_rho_line?: string;
    is_islanded?: boolean;
    n_components?: number;
    disconnected_mw?: number;
    non_convergence?: string | null;
    action_topology?: ActionTopology;
    lines_overloaded_after?: string[];
    /**
     * ``{line_name: live_end_reactive_mvar}`` for still-"overloaded" lines the
     * action leaves open at ONE end with a loading above ~1 %. Such a line is
     * out of service for active power (the SLD / NAD show p = 0) but its
     * capacitance draws reactive charging current from the live end, so its
     * current-based loading stays non-zero (the reported ~33 %). The ActionCard
     * annotates the loading with the reactive amount so it reads as charging
     * current, not a residual overload. Backend: ``half_open_branch_reactive_from_obs``.
     */
    half_open_overloads?: Record<string, number>;
    load_shedding_details?: LoadSheddingDetail[];
    curtailment_details?: CurtailmentDetail[];
    redispatch_details?: RedispatchDetail[];
    pst_details?: PstDetail[];
    /**
     * Provenance of the action — `"user"` or a recommender model id.
     * Mirrors `ActionDetail.origin`. Optional: legacy session dumps
     * that predate the field get an `origin` derived from the saved
     * status flags + `analysis.active_model` on reload.
     */
    origin?: string;
    status: SavedActionStatus;
}

export interface SavedCombinedAction {
    action1_id: string;
    action2_id: string;
    betas: number[];
    max_rho: number;
    max_rho_line: string;
    is_rho_reduction: boolean;
    description: string;
    estimated_max_rho?: number | null;
    estimated_max_rho_line?: string;
    is_islanded?: boolean;
    disconnected_mw?: number;
    simulated_max_rho?: number | null;
    simulated_max_rho_line?: string;
    is_simulated: boolean;
}

export interface SessionResult {
    saved_at: string;
    configuration: {
        network_path: string;
        action_file_path: string;
        layout_path: string;
        min_line_reconnections: number;
        min_close_coupling: number;
        min_open_coupling: number;
        min_line_disconnections: number;
        min_pst: number;
        min_load_shedding: number;
        min_renewable_curtailment_actions?: number;
        min_redispatch?: number;
        allowed_action_types?: string[];
        n_prioritized_actions: number;
        lines_monitoring_path: string;
        monitoring_factor: number;
        pre_existing_overload_threshold: number;
        ignore_reconnections: boolean;
        pypowsybl_fast_mode: boolean;
        // Registry key of the recommender model selected at the time
        // the session was saved (e.g. "expert", "random",
        // "random_overflow"). Persisted so a reload shows which model
        // produced the suggestions.
        model?: string;
        // Whether the operator had the Compute Overflow Graph toggle
        // on at save time. For models with
        // `requires_overflow_graph=true` this is always effectively
        // true; for opt-in models it captures the user choice.
        compute_overflow_graph?: boolean;
    };
    contingency: {
        disconnected_elements: string[];
        disconnected_element?: string;
        selected_overloads: string[];
        monitor_deselected: boolean;
        additional_lines_to_cut?: string[];
    };
    overloads: {
        n_overloads: string[];
        n1_overloads: string[];
        resolved_overloads: string[];
        n_overloads_rho?: number[];
        n1_overloads_rho?: number[];
    };
    overflow_graph: {
        pdf_url: string | null;
        pdf_path: string | null;
    } | null;
    analysis: {
        message: string;
        dc_fallback: boolean;
        action_scores: Record<string, Record<string, unknown>> | undefined;
        actions: Record<string, SavedActionEntry>;
        combined_actions: Record<string, SavedCombinedAction>;
        lines_we_care_about?: string[] | null;
        computed_pairs?: Record<string, unknown> | null;
        // Model that produced this analysis result. Mirrors
        // `configuration.model` but captured from the result event
        // (= the model the backend actually executed, which may
        // differ from the configured one when an unknown name
        // silently falls back to the default).
        active_model?: string | null;
        // Whether step-2 overflow graph was actually computed for
        // this run. Useful when reloading a session to know whether
        // the Overflow Analysis tab will have content.
        compute_overflow_graph?: boolean | null;
        // Per-stage execution times (seconds), captured at run time.
        // Optional for backward compatibility with sessions saved before
        // the breakdown was added.
        overflow_graph_time?: number | null;
        action_prediction_time?: number | null;
        assessment_time?: number | null;
        step1_time?: number | null;
        enrichment_time?: number | null;
        wall_clock_time?: number | null;
    } | null;
    interaction_log?: InteractionLogEntry[];
}

// ===== Interaction Logging =====

export type InteractionType =
    | 'config_loaded'
    | 'settings_opened'
    | 'settings_tab_changed'
    | 'settings_applied'
    | 'settings_cancelled'
    | 'path_picked'
    | 'contingency_selected'
    | 'contingency_confirmed'
    | 'contingency_element_added'
    | 'contingency_element_removed'
    | 'contingency_applied'
    | 'analysis_step1_started'
    | 'analysis_step1_completed'
    | 'overload_toggled'
    | 'additional_line_to_cut_toggled'
    | 'recommender_model_changed'
    | 'suggested_actions_cleared'
    | 'analysis_step2_started'
    | 'analysis_step2_completed'
    | 'prioritized_actions_displayed'
    | 'action_selected'
    | 'action_deselected'
    | 'action_favorited'
    | 'action_unfavorited'
    | 'action_rejected'
    | 'action_unrejected'
    | 'manual_action_simulated'
    | 'action_mw_resimulated'
    | 'pst_tap_resimulated'
    | 'combine_modal_opened'
    | 'combine_modal_closed'
    | 'combine_pair_toggled'
    | 'combine_pair_estimated'
    | 'combine_pair_simulated'
    | 'diagram_tab_changed'
    | 'tab_detached'
    | 'tab_reattached'
    | 'tab_tied'
    | 'tab_untied'
    | 'view_mode_changed'
    | 'overflow_layout_mode_toggled'
    | 'overflow_pins_toggled'
    | 'overflow_pin_clicked'
    | 'overflow_pin_double_clicked'
    | 'overflow_layer_toggled'
    | 'overflow_select_all_layers'
    | 'overflow_node_double_clicked'
    | 'voltage_range_changed'
    | 'asset_clicked'
    | 'zoom_in'
    | 'zoom_out'
    | 'zoom_reset'
    | 'inspect_query_changed'
    | 'vl_names_toggled'
    | 'sld_overlay_opened'
    | 'sld_overlay_tab_changed'
    | 'sld_overlay_closed'
    | 'sld_edit_mode_toggled'
    | 'sld_switch_toggled'
    | 'sld_maneuver_removed'
    | 'sld_maneuver_focused'
    | 'sld_edit_reset'
    | 'sld_injection_staged'
    | 'sld_injection_removed'
    | 'sld_topology_simulated'
    | 'overview_shown'
    | 'overview_hidden'
    | 'overview_pin_clicked'
    | 'overview_pin_double_clicked'
    | 'overview_popover_closed'
    | 'overview_zoom_in'
    | 'overview_zoom_out'
    | 'overview_zoom_fit'
    | 'overview_inspect_changed'
    | 'overview_filter_changed'
    | 'overview_unsimulated_toggled'
    | 'overview_unsimulated_pin_simulated'
    | 'session_saved'
    | 'session_reload_modal_opened'
    | 'session_reloaded'
    | 'sidebar_collapsed_toggled'
    | 'contingency_clear_requested'
    | 'theme_toggled'
    | 'smooth_pan_zoom_toggled';

export interface InteractionLogEntry {
    seq: number;
    timestamp: string;
    type: InteractionType;
    details: Record<string, unknown>;
    correlation_id?: string;
    duration_ms?: number;
}

// ===== Action Overview Filters =====

export type ActionSeverityCategory = 'green' | 'orange' | 'red' | 'grey';

export type ActionTypeFilterToken = 'all' | 'disco' | 'reco' | 'ls' | 'rc' | 'redispatch' | 'open' | 'close' | 'pst';

export interface ActionOverviewFilters {
    categories: Record<ActionSeverityCategory, boolean>;
    threshold: number;
    showUnsimulated: boolean;
    actionType: ActionTypeFilterToken;
    showCombinedOnly: boolean;
}

export interface UnsimulatedActionScoreInfo {
    type: string;
    score: number;
    mwStart?: number | null;
    tapStart?: {
        pst_name: string;
        tap: number;
        low_tap: number | null;
        high_tap: number | null;
    } | null;
    rankInType: number;
    countInType: number;
    maxScoreInType: number;
}

// =====================================================================
// Overflow-iframe postMessage envelope
// =====================================================================

export interface OverflowIframeScreenRect {
    left: number;
    top: number;
    width: number;
    height: number;
}

export type IframeToParentMessage =
    | { type: 'cs4g:overlay-ready' }
    | {
        type: 'cs4g:pin-clicked';
        actionId: string;
        screenRect?: OverflowIframeScreenRect;
    }
    | {
        type: 'cs4g:pin-double-clicked';
        actionId: string;
        substation: string;
    }
    | {
        type: 'cs4g:overflow-unsimulated-pin-double-clicked';
        actionId: string;
    }
    | {
        type: 'cs4g:overflow-filter-changed';
        filters: ActionOverviewFilters;
    }
    | {
        type: 'cs4g:overflow-layer-toggled';
        key: string;
        label: string;
        visible: boolean;
    }
    | {
        type: 'cs4g:overflow-select-all-layers';
        visible: boolean;
    }
    | {
        type: 'cs4g:overflow-node-double-clicked';
        name: string;
    }
    | {
        type: 'cs4g:overflow-pins-toggled';
        enabled: boolean;
    };

export type IframeToParentMessageType = IframeToParentMessage['type'];

export type ParentToIframeMessage =
    | {
        type: 'cs4g:pins';
        visible: boolean;
        pins: ReadonlyArray<unknown>;
    }
    | {
        type: 'cs4g:filters';
        filters: ActionOverviewFilters;
    }
    | {
        // Total execution time (seconds) for creating + generating the
        // overflow analysis graph. Posted by the React parent once the
        // step-2 ``result`` event arrives — the overlay JS renders it
        // as a subtitle just below the sidebar ``<h1>`` so the operator
        // can see how long the graph took to produce.
        type: 'cs4g:overflow-meta';
        overflowGraphTime: number | null;
    }
    | {
        // Light/dark theme of the host app. Posted on overlay-ready and
        // whenever the parent's `<html data-theme>` flips, so the
        // embedded overflow viewer can match the surrounding chrome.
        type: 'cs4g:theme';
        theme: 'light' | 'dark';
    };
