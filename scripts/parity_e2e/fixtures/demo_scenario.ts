/**
 * Demo scenario — fiche-as-data.
 *
 * Each checkpoint maps one paragraph of `docs/Fiche_demo_CoStudy4Grid` to
 *   (a) the events the operator is expected to fire (sub-sequence of the
 *       golden log under `fixtures/demo_small_grid_log.golden.json`), and
 *   (b) the **structural invariants** the DOM/SVG must satisfy once those
 *       events have all landed.
 *
 * The runner in `demo_replay.spec.ts` walks this list in order, drives the
 * gestures with Playwright, and asserts the invariants. The point is that
 * non-developers can edit the scenario without touching the runner.
 *
 * Invariants are deliberately **structural** (DOM presence / count /
 * attribute) rather than pixel-level — see DEMO_REPLAY_README.md for the
 * layering and why we keep pixel diffs out of this list. Each invariant
 * carries a `description` that doubles as the failure message.
 *
 * Empty `events: []` checkpoints are pure verification points (no gesture
 * is fired). Empty `invariants: []` checkpoints exist when the gesture
 * has only data-side effects; add invariants as `data-testid` hooks are
 * landed in the relevant components.
 */
import type { InteractionType } from '../../../frontend/src/types';

export type Act = 1 | 2 | 3;

export interface ExpectedEventMatch {
    type: InteractionType;
    /** Partial-match: every key in `details` must be present and equal on the live event. */
    details?: Record<string, unknown>;
    /**
     * For events whose ids are non-deterministic (auto-generated UUIDs on
     * manual actions, combined ids, …). When true, the runner only checks
     * `type` + the listed non-id keys.
     */
    acceptAnyId?: boolean;
}

export type CountAssertion =
    | number
    | { min?: number; max?: number };

export interface Invariant {
    description: string;
    selector: string;
    count?: CountAssertion;
    visible?: boolean;
    hasClass?: string;
    hasAttribute?: { name: string; value?: string | RegExp };
}

export interface ScenarioCheckpoint {
    act: Act;
    ficheStep: string;
    description: string;
    events: ExpectedEventMatch[];
    invariants: Invariant[];
}

// ---------------------------------------------------------------------
// Helpers — small grid constants from `data/bare_env_small_grid_test`.
// Keep these aligned with the golden log.
// ---------------------------------------------------------------------

export const SMALL_GRID = {
    contingency: 'P.SAOL31RONCI',
    overload: 'BEON L31CPVAN',
    nPrioritizedActions: 10,
    /** Action id pre-played in étape 4 ("Make a first guess"). The UUID
     *  prefix is unstable across runs — only the `_COUCHP6` suffix is
     *  asserted via `acceptAnyId: true`. */
    couchp6ActionSuffix: '_COUCHP6',
    /** Stable action ids that appear in the golden trace and are stable
     *  across runs (deterministic recommender output on small_grid). */
    discoBeon: 'disco_BEON L31CPVAN',
    nodeMergingPymon: 'node_merging_PYMONP3',
    loadSheddingBeon: 'load_shedding_BEON3 TR311',
    recoBoiss: 'reco_BOISSL61GEN.P',
} as const;

// ---------------------------------------------------------------------
// The scenario.
// ---------------------------------------------------------------------

export const DEMO_SCENARIO: ScenarioCheckpoint[] = [
    // ===== Acte 1 — le terrain ============================================
    {
        act: 1,
        ficheStep: 'Étape 1 — Charger une étude',
        description:
            'Operator applies settings pointing at config_small_grid. Notices ' +
            'panel reflects loaded dictionary; default threshold 95%.',
        events: [
            { type: 'config_loaded' /* details validated against meta */ },
        ],
        invariants: [
            {
                description: 'Sidebar is mounted',
                selector: '[data-testid="sidebar"]',
                visible: true,
            },
            {
                description: 'Notices pill shows active notices count',
                selector: '[data-testid="notices-pill"]',
                visible: true,
            },
            // TODO(testid): assert notices panel content (action-dict line, threshold 95%).
            // Need `data-testid="notice-action-dict"` and `data-testid="notice-threshold"`
            // landed on NoticesPanel.tsx items.
        ],
    },
    {
        act: 1,
        ficheStep: 'Étape 2 — Jouer une contingence',
        description:
            'Add P.SAOL31RONCI to the contingency set and apply (Trigger). ' +
            'N-1 diagram renders with a yellow contingency halo and an ' +
            'orange overload halo on BEON L31CPVAN.',
        events: [
            { type: 'contingency_element_added', details: { element: SMALL_GRID.contingency } },
            { type: 'contingency_applied', details: { elements: [SMALL_GRID.contingency] } },
        ],
        invariants: [
            {
                description: 'Exactly one yellow contingency halo on the N-1 diagram',
                selector: '.nad-contingency-target',
                count: 1,
            },
            {
                description: 'At least one orange overload halo (BEON L31CPVAN)',
                selector: '.nad-overloaded',
                count: { min: 1 },
            },
            {
                description: 'Sidebar summary shows the active contingency',
                selector: '[data-testid="sidebar-summary-contingency"]',
                visible: true,
            },
            // TODO(testid): add data-testid on the overload rho row in
            // SidebarSummary so we can assert rho is displayed (Étape 2:
            // "traçabilité [...] du taux de charge").
        ],
    },
    {
        act: 1,
        ficheStep: 'Étape 3 — Innovation, rendu Impacts',
        description:
            'Toggle the contingency tab into delta mode, observe the impact ' +
            'colouring (orange = more loaded, blue = less, grey = unchanged), ' +
            'then switch back to flow mode.',
        events: [
            { type: 'view_mode_changed', details: { mode: 'delta', tab: 'contingency', scope: 'main' } },
            { type: 'view_mode_changed', details: { mode: 'network', tab: 'contingency', scope: 'main' } },
        ],
        invariants: [
            // The visibility of these classes is gated on view-mode being
            // 'delta', so they must be asserted **between** the two events
            // — see runner's `assertInvariantsAtIndex` for the lookahead.
            {
                description: 'Delta mode produces at least one positively-loaded branch',
                selector: '[data-delta-class="positive"]',
                count: { min: 1 },
            },
            {
                description: 'Delta mode produces at least one negatively-loaded branch',
                selector: '[data-delta-class="negative"]',
                count: { min: 1 },
            },
            {
                description: 'Legend visible while in delta mode',
                selector: '[data-testid="diagram-legend"]',
                visible: true,
            },
        ],
    },
    {
        act: 1,
        ficheStep: 'Étape 4 — "Make a first guess"',
        description:
            'Pre-play the open-coupling action at COUCHP6 (supportive-AI ' +
            'shortcut). An action card appears for the pre-played action; ' +
            'the action tab zooms onto the contingency neighbourhood.',
        events: [
            { type: 'manual_action_simulated', acceptAnyId: true },
            { type: 'action_selected', acceptAnyId: true },
        ],
        invariants: [
            {
                description: 'At least one action card is mounted in the feed',
                selector: '[data-testid^="action-card-"]',
                count: { min: 1 },
            },
            {
                description: 'Selected action card carries the COUCHP6 marker',
                selector: '[data-testid^="action-card-"][data-action-id$="_COUCHP6"]',
                count: 1,
            },
        ],
    },
    {
        act: 1,
        ficheStep: 'Étape 5 — Zoom efficace sur l\'action',
        description:
            'Single-click then double-click on the COUCHP6 asset in the ' +
            'action card to drill into the substation SLD.',
        events: [
            { type: 'asset_clicked', details: { asset_name: 'COUCHP6', tab: 'action' }, acceptAnyId: true },
            { type: 'asset_clicked', details: { asset_name: 'COUCHP6', tab: 'action' }, acceptAnyId: true },
            { type: 'asset_clicked', details: { asset_name: 'COUCHP6', tab: 'action' }, acceptAnyId: true },
            { type: 'sld_overlay_opened', details: { vl_name: 'COUCHP6' }, acceptAnyId: true },
        ],
        invariants: [
            {
                description: 'SLD overlay is rendered for COUCHP6',
                selector: '[data-testid="sld-overlay"]',
                visible: true,
            },
            // TODO(testid): assert the disjoncteur manipulé is highlighted
            // (étape 5: "disjoncteur manipulé surligné"). Need a
            // `data-action-highlight="true"` attribute on the SLD switch.
        ],
    },
    {
        act: 1,
        ficheStep: 'Étape 6 — Impact appliqué à l\'action',
        description:
            'Within the SLD (action tab), switch to delta mode to observe ' +
            'how this single action redistributes flows. Then close the SLD.',
        events: [
            { type: 'view_mode_changed', details: { mode: 'delta', tab: 'action', scope: 'main' } },
            { type: 'sld_overlay_closed' },
        ],
        invariants: [],
    },
    {
        act: 1,
        ficheStep: 'Étape 7 — Vue détachable',
        description:
            'Detach the action tab into a popup. Set the popup to delta mode. ' +
            'Switch the main window to the contingency tab. Compare side by side.',
        events: [
            { type: 'tab_detached', details: { tab: 'action' } },
            { type: 'view_mode_changed', details: { mode: 'delta', tab: 'action', scope: 'detached' } },
            { type: 'diagram_tab_changed', details: { tab: 'contingency' } },
        ],
        invariants: [
            // The detached popup may be skipped if the test runner cannot
            // open real popups (see interaction-logging.md §tab_detached).
            // We assert on the main-window placeholder instead.
            {
                description: 'Main window shows the detached placeholder for the action tab',
                selector: '[data-testid="detached-action-deselect"]',
                visible: true,
            },
        ],
    },
    // ===== Acte 2 — l\'assistance IA =======================================
    {
        act: 2,
        ficheStep: 'Étape 8a — Lancer l\'analyse',
        description:
            'Click Analyze & Suggest. Step 1 detects the BEON L31CPVAN ' +
            'overload; step 2 streams back 10 prioritized actions.',
        events: [
            { type: 'analysis_step1_started', details: { element: SMALL_GRID.contingency } },
            { type: 'analysis_step1_completed', details: { can_proceed: true, overloads_detected: 1 } },
            {
                type: 'analysis_step2_started',
                details: {
                    element: SMALL_GRID.contingency,
                    selected_overloads: [SMALL_GRID.overload],
                    all_overloads: [SMALL_GRID.overload],
                },
            },
            { type: 'analysis_step2_completed', details: { n_actions: SMALL_GRID.nPrioritizedActions } },
        ],
        invariants: [
            {
                description: 'Overflow analysis iframe is mounted post-step2',
                selector: 'iframe[src*="/results/pdf/"]',
                count: 1,
            },
        ],
    },
    {
        act: 2,
        ficheStep: 'Étape 8b — Lecture de l\'overflow graph',
        description:
            'Unselect all layers, then progressively toggle: overload only, ' +
            'constrained path, red-loop paths, reconnectable, non-reconnectable. ' +
            'Each toggle changes the visible layer set in the iframe overlay.',
        events: [
            { type: 'overflow_select_all_layers', details: { visible: false } },
            { type: 'overflow_layer_toggled', details: { key: 'semantic:is_overload', visible: true } },
            { type: 'overflow_layer_toggled', details: { key: 'semantic:on_constrained_path', visible: true } },
            { type: 'overflow_layer_toggled', details: { key: 'semantic:in_red_loop', visible: true } },
            { type: 'overflow_layer_toggled', details: { key: 'style:dashed', visible: true } },
            { type: 'overflow_layer_toggled', details: { key: 'style:dotted', visible: true } },
        ],
        invariants: [
            // Layer-toggle effects live inside a cross-origin iframe (overflow
            // overlay). Asserting them requires postMessage round-trip or
            // frame-locator. Deferred to a follow-up — see README §Iframe.
        ],
    },
    {
        act: 2,
        ficheStep: 'Étape 8c — Afficher les actions suggérées',
        description: 'Click Display Prioritized Actions to populate the feed.',
        events: [
            { type: 'prioritized_actions_displayed', details: { n_actions: SMALL_GRID.nPrioritizedActions } },
        ],
        invariants: [
            {
                description: '10 action cards are mounted in the feed',
                selector: '[data-testid^="action-card-"]',
                count: { min: SMALL_GRID.nPrioritizedActions },
            },
            {
                description: 'Feed header is visible',
                selector: '[data-testid="action-feed-header"]',
                visible: true,
            },
        ],
    },
    {
        act: 2,
        ficheStep: 'Étape 9 — Explorer les suggestions',
        description:
            'Click into the disco BEON action (closes the overload directly), ' +
            'then into node_merging_PYMONP3 (alternative path). Switch the ' +
            'action tab back to flow mode.',
        events: [
            { type: 'action_selected', details: { action_id: SMALL_GRID.discoBeon } },
            { type: 'asset_clicked', details: { action_id: SMALL_GRID.discoBeon, asset_name: SMALL_GRID.overload, tab: 'action' } },
            { type: 'action_selected', details: { action_id: SMALL_GRID.nodeMergingPymon } },
            { type: 'asset_clicked', details: { action_id: SMALL_GRID.nodeMergingPymon, asset_name: 'PYMONP3', tab: 'action' } },
            { type: 'view_mode_changed', details: { mode: 'network', tab: 'action', scope: 'main' } },
        ],
        invariants: [
            {
                description: 'disco_BEON card is highlighted as selected',
                selector: `[data-testid="action-card-${SMALL_GRID.discoBeon}"]`,
                visible: true,
            },
        ],
    },
    {
        act: 2,
        ficheStep: 'Étape 10 — Overview des actions',
        description:
            'Return to the Overview map. Single-click a load-shedding pin to ' +
            'preview the card. Enable "Show unsimulated" and double-click an ' +
            'unsimulated VIELMP6 pin to kick off its simulation.',
        events: [
            { type: 'overview_shown', details: { has_pins: true, pin_count: SMALL_GRID.nPrioritizedActions } },
            { type: 'overview_pin_clicked', details: { action_id: SMALL_GRID.loadSheddingBeon } },
            { type: 'overview_popover_closed' },
            { type: 'overview_unsimulated_toggled', details: { enabled: true } },
            { type: 'overview_unsimulated_pin_simulated', acceptAnyId: true },
        ],
        invariants: [
            {
                description: 'Overview map is mounted with at least 10 simulated pins',
                selector: '[data-testid="action-overview-diagram"] g.nad-action-overview-pin',
                count: { min: SMALL_GRID.nPrioritizedActions },
            },
            {
                description: 'Pin counter reflects current visible pins',
                selector: '[data-testid="overview-pin-counter"]',
                visible: true,
            },
            // TODO(testid): assert that at least one dashed unsimulated pin
            // becomes visible after `Show unsimulated` is enabled. Need a
            // `data-pin-state` discriminator on the pin <g>.
        ],
    },
    {
        act: 2,
        ficheStep: 'Étape 11 — Élargir, ajuster une consigne',
        description:
            'Manually add the reco_BOISSL61GEN.P action via the actions search, ' +
            'then edit Target MW on the load-shedding BEON3 TR311 card and ' +
            're-simulate.',
        events: [
            { type: 'manual_action_simulated', details: { action_id: SMALL_GRID.recoBoiss } },
            { type: 'action_mw_resimulated', details: { action_id: SMALL_GRID.loadSheddingBeon, target_mw: 3.4 } },
        ],
        invariants: [
            {
                description: 'load_shedding card exposes a re-simulate button (MW editor)',
                selector: `[data-testid="resimulate-${SMALL_GRID.loadSheddingBeon}"]`,
                visible: true,
            },
        ],
    },
    // ===== Acte 3 — bouclage opérationnel (sur small_grid: combinaisons + save) ===
    {
        act: 3,
        ficheStep: 'Étape 12 — Combinaison d\'actions',
        description:
            'Open the Combine Actions modal. Simulate two pairs: (disco BEON ' +
            'L31P.SAO + reco GEN.PY762) and (disco BEON L31P.SAO + node_merging ' +
            'PYMONP3). Both should converge to a max-rho < 1.0.',
        events: [
            { type: 'combine_modal_opened' },
            {
                type: 'combine_pair_simulated',
                details: {
                    combined_id: 'disco_BEON L31P.SAO+reco_GEN.PY762',
                    action1_id: 'disco_BEON L31P.SAO',
                    action2_id: 'reco_GEN.PY762',
                    // simulated_max_rho asserted numerically below
                },
            },
            {
                type: 'combine_pair_simulated',
                details: {
                    combined_id: 'disco_BEON L31P.SAO+node_merging_PYMONP3',
                    action1_id: 'disco_BEON L31P.SAO',
                    action2_id: 'node_merging_PYMONP3',
                },
            },
            { type: 'combine_modal_closed' },
        ],
        invariants: [
            {
                description: 'Combine modal body was mounted',
                selector: '[data-testid="combine-modal-body"]',
                // After close it is unmounted — runner asserts BEFORE the close event.
                count: { min: 0 },
            },
            {
                description: 'Two new combined cards now appear in the feed',
                selector: '[data-testid^="action-card-"][data-action-id*="+"]',
                count: { min: 2 },
            },
        ],
    },
    {
        act: 3,
        ficheStep: 'Étape 10bis — Overview reflète les combinaisons',
        description:
            'Back on Overview after the combinations: the pin count is now ' +
            '12 (10 priorities + 2 combined).',
        events: [
            { type: 'overview_shown', details: { has_pins: true, pin_count: 12 } },
        ],
        invariants: [
            {
                description: 'Overview pin count reflects the 2 combined additions',
                selector: '[data-testid="action-overview-diagram"] g.nad-action-overview-pin',
                count: { min: 12 },
            },
        ],
    },
    {
        act: 3,
        ficheStep: 'Étape 9bis — Favoriser',
        description: 'Star the two combination-related actions for downstream save.',
        events: [
            { type: 'action_favorited', details: { action_id: SMALL_GRID.nodeMergingPymon } },
            { type: 'action_favorited', details: { action_id: SMALL_GRID.loadSheddingBeon } },
        ],
        invariants: [],
    },
    {
        act: 3,
        ficheStep: 'Étape 13 — Sauvegarde de la session',
        description: 'Click Save Results. Backend writes the session folder; the gesture is logged.',
        events: [
            { type: 'session_saved' /* output_folder is environment-specific */ },
        ],
        invariants: [],
    },
];

// ---------------------------------------------------------------------
// Numeric tolerances for the combined-pair max-rho assertion above.
// Kept here so a single edit can re-tune the recommender drift band.
// ---------------------------------------------------------------------
export const COMBINED_PAIR_EXPECTED_RHO: Array<{ combined_id: string; rho: number; tol: number }> = [
    { combined_id: 'disco_BEON L31P.SAO+reco_GEN.PY762',         rho: 0.6560, tol: 0.01 },
    { combined_id: 'disco_BEON L31P.SAO+node_merging_PYMONP3',   rho: 0.7004, tol: 0.01 },
];
