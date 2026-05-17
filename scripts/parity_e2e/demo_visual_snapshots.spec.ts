/**
 * Layer-B normalised SVG / HTML snapshots for the demo scenario.
 *
 * Captures the rendered HTML of 3 stable surfaces and diffs against a
 * versioned text golden:
 *
 *   1. The Action Overview map (`[data-testid="action-overview-diagram"]`)
 *      after étape 10 — exercises every pin variant.
 *   2. The disco_BEON action card after étape 9 — exercises the rho
 *      block, severity pictogram, action chip rail.
 *   3. The Combine Actions modal body (`[data-testid="combine-modal-body"]`)
 *      after étape 12 — exercises the table rendering.
 *
 * Why text snapshots and not pixel diffs:
 *   - Stable across antialias / font-render variance (the only thing
 *     that matters here is the DOM/SVG structure + attribute values).
 *   - Diffs are human-readable when something changes — you see the
 *     missing class, the renamed attribute, the lost child.
 *   - Cheap to maintain: re-run with `--update-snapshots` to bless a
 *     new baseline.
 *
 * Normalisation rules (see `normaliseHtml`):
 *   - Strip auto-generated react keys and HMR id suffixes.
 *   - Round float coords (x, y, cx, cy, d, transform) to 1 decimal.
 *   - Strip inline `style` attributes (they vary by viewport / token
 *     cache state; the visual contract is tracked by class + data-*
 *     attributes, not inline styles, in this codebase).
 *   - Sort element attributes alphabetically so attribute-order churn
 *     doesn't show up in diffs.
 *
 * The mock backend is intentionally minimal — same shape as
 * `demo_meta_invariants.spec.ts`. Snapshots live alongside this spec
 * in `__snapshots__/`.
 */
import { test, expect, type Page } from '@playwright/test';

const SMALL_GRID = {
    contingency: 'P.SAOL31RONCI',
    overload: 'BEON L31CPVAN',
    discoBeon: 'disco_BEON L31CPVAN',
    nodeMergingPymon: 'node_merging_PYMONP3',
    loadSheddingBeon: 'load_shedding_BEON3 TR311',
};

const MOCK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000">
  <g id="nad">
    <g class="nad-vl" id="COUCHP6"><circle cx="200" cy="200" r="10"/></g>
    <g class="nad-vl" id="PYMONP3"><circle cx="400" cy="400" r="10"/></g>
    <g class="nad-vl" id="BEON3"><circle cx="600" cy="600" r="10"/></g>
  </g>
</svg>`;

function mockActionsPayload() {
    const ids = [SMALL_GRID.discoBeon, SMALL_GRID.nodeMergingPymon, SMALL_GRID.loadSheddingBeon,
                 'disco_BEON L31P.SAO', 'reco_GEN.PY762', 'pst_DUMMY_TAP'];
    const actions: Record<string, unknown> = {};
    for (const id of ids) {
        actions[id] = {
            description_unitaire: `Action ${id}`,
            rho_before: [1.15], rho_after: [0.85],
            max_rho: 0.85, max_rho_line: SMALL_GRID.overload,
            is_rho_reduction: true,
        };
    }
    return actions;
}

async function registerMockBackend(page: Page): Promise<void> {
    await page.route('**/api/user-config', (r) => r.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
            // Non-empty paths so the Settings modal does NOT auto-open
            // on boot — otherwise it stays mounted over the sidebar and
            // blocks every interaction with the contingency combobox.
            network_path: '/data/bare_env_small_grid_test/grid.xiidm',
            action_file_path: '/data/action_space/reduced_model_actions_test.json',
            layout_path: '/data/bare_env_small_grid_test/grid_layout.json',
            output_folder_path: '/data/sessions',
            lines_monitoring_path: '',
            min_line_reconnections: 2.0, min_close_coupling: 3.0,
            min_open_coupling: 2.0, min_line_disconnections: 3.0,
            min_pst: 1.0, min_load_shedding: 2.0,
            min_renewable_curtailment_actions: 0.0,
            n_prioritized_actions: 10, monitoring_factor: 0.95,
            pre_existing_overload_threshold: 0.02,
            ignore_reconnections: false, pypowsybl_fast_mode: true,
        }),
    }));
    await page.route('**/api/config-file-path', (r) => r.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ config_file_path: '/tmp/c.json' }),
    }));
    await page.route('**/api/config', (r) => r.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ status: 'success', message: 'loaded',
            total_lines_count: 7, monitored_lines_count: 7,
            action_dict_file_name: 'x.json',
            action_dict_stats: { reco: 1, disco: 1, pst: 0, open_coupling: 0, close_coupling: 0, total: 2 }}),
    }));
    await page.route('**/api/branches', (r) => r.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ branches: [SMALL_GRID.contingency, SMALL_GRID.overload],
            name_map: { [SMALL_GRID.contingency]: SMALL_GRID.contingency,
                        [SMALL_GRID.overload]: SMALL_GRID.overload }}),
    }));
    await page.route('**/api/voltage-levels', (r) => r.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ voltage_levels: ['COUCHP6', 'PYMONP3', 'BEON3'],
            name_map: { COUCHP6: 'COUCHP6', PYMONP3: 'PYMONP3', BEON3: 'BEON3' }}),
    }));
    await page.route('**/api/nominal-voltages', (r) => r.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ mapping: { COUCHP6: 400, PYMONP3: 225, BEON3: 90 }, unique_kv: [400, 225, 90] }),
    }));
    await page.route('**/api/network-diagram**', (r) => r.fulfill({
        status: 200, contentType: 'text/plain; charset=utf-8',
        body: `${JSON.stringify({ metadata: {}, lines_overloaded: [], lines_overloaded_rho: [] })}\n${MOCK_SVG}`,
    }));
    await page.route('**/api/n1-diagram', (r) => r.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ svg: MOCK_SVG, metadata: {},
            lines_overloaded: [SMALL_GRID.overload], lines_overloaded_rho: [1.15],
            flow_deltas: {}, reactive_flow_deltas: {}, asset_deltas: {},
            lf_converged: true, lf_status: 'CONVERGED' }),
    }));
    await page.route('**/api/run-analysis-step1', (r) => r.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ lines_overloaded: [SMALL_GRID.overload], message: 'ok', can_proceed: true }),
    }));
    await page.route('**/api/run-analysis-step2', (r) => r.fulfill({
        status: 200, contentType: 'application/x-ndjson',
        body: `${JSON.stringify({ type: 'pdf', pdf_url: '/results/pdf/m.html' })}\n${JSON.stringify({ type: 'result', actions: mockActionsPayload(), action_scores: {}, lines_overloaded: [SMALL_GRID.overload], combined_actions: {}, message: 'ok', dc_fallback: false, active_model: 'expert', compute_overflow_graph: true })}\n`,
    }));
    await page.route('**/api/action-variant-diagram', (r) => r.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ svg: MOCK_SVG, metadata: {}, action_id: SMALL_GRID.discoBeon,
            flow_deltas: {}, reactive_flow_deltas: {}, asset_deltas: {},
            lf_converged: true, lf_status: 'CONVERGED' }),
    }));
    await page.route('**/api/compute-superposition', (r) => {
        const body = r.request().postDataJSON() as { action1_id?: string; action2_id?: string };
        r.fulfill({
            status: 200, contentType: 'application/json',
            body: JSON.stringify({ combined_id: `${body.action1_id}+${body.action2_id}`,
                action1_id: body.action1_id, action2_id: body.action2_id,
                simulated_max_rho: 0.7, simulated_max_rho_line: SMALL_GRID.overload,
                estimated_max_rho: 0.7 }),
        });
    });
}

// ---------------------------------------------------------------------
// Normalisation.
// ---------------------------------------------------------------------

const FLOAT_COORD_ATTRS = ['x', 'y', 'cx', 'cy', 'x1', 'y1', 'x2', 'y2', 'r', 'rx', 'ry',
                            'width', 'height', 'transform', 'd', 'points', 'viewBox'];

async function captureNormalisedHtml(page: Page, selector: string): Promise<string> {
    const raw = await page.locator(selector).first().innerHTML();
    // Normalisation runs IN the page context — DOMParser is a browser
    // API not available in Playwright's Node runtime by default. Cheap
    // to inline; no need for a Node-side jsdom dependency.
    return await page.evaluate(({ html, floatAttrs }) => {
        const roundFloats = (value: string) =>
            value.replace(/-?\d+\.\d+/g, (m) => {
                const n = Number(m);
                return Number.isFinite(n) ? n.toFixed(1) : m;
            });
        const parser = new DOMParser();
        const doc = parser.parseFromString(`<root>${html}</root>`, 'text/html');
        const root = doc.querySelector('root')!;
        const walk = (el: Element): void => {
            el.removeAttribute('style');
            const id = el.getAttribute('id');
            if (id && /-(?:[0-9a-f]{6,}|\d{4,})$/.test(id)) el.setAttribute('id', 'STABLE');
            for (const name of floatAttrs) {
                const v = el.getAttribute(name);
                if (v) el.setAttribute(name, roundFloats(v));
            }
            const attrs = Array.from(el.attributes).map(a => [a.name, a.value] as const);
            const sorted = [...attrs].sort(([a], [b]) => a.localeCompare(b));
            for (const [name] of attrs) el.removeAttribute(name);
            for (const [name, value] of sorted) el.setAttribute(name, value);
            for (const child of Array.from(el.children)) walk(child);
        };
        for (const child of Array.from(root.children)) walk(child);
        return root.innerHTML.replace(/></g, '>\n<').replace(/\s+\n/g, '\n');
    }, { html: raw, floatAttrs: FLOAT_COORD_ATTRS });
}

// ---------------------------------------------------------------------
// The tests.
// ---------------------------------------------------------------------

test.describe('Demo visual snapshots', () => {
    test.beforeEach(async ({ page }) => {
        await registerMockBackend(page);
        await page.goto('/');
        await page.evaluate(() => {
            localStorage.setItem('networkPath', '/data/grid.xiidm');
            localStorage.setItem('actionPath', '/data/actions.json');
            localStorage.setItem('layoutPath', '/data/layout.json');
            localStorage.setItem('outputFolderPath', '/data/sessions');
        });
        await page.reload();
        await page.getByRole('button', { name: /Load Study/i }).click();
        await page.waitForResponse(r => r.url().includes('/api/network-diagram'));

        // Set the contingency + run analysis to get the action feed + overview populated.
        // react-select pattern — see demo_replay.spec.ts:addContingencyAndApply
        // for the rationale (click-type-clickOption beats fill-Enter).
        const combobox = page.getByRole('combobox').first();
        await combobox.waitFor({ state: 'visible', timeout: 10000 });
        await combobox.click();
        await combobox.pressSequentially(SMALL_GRID.contingency, { delay: 30 });
        const option = page.locator('.cs4g-contingency__option', { hasText: SMALL_GRID.contingency }).first();
        await option.waitFor({ state: 'visible', timeout: 5000 });
        await option.click();
        const trigger = page.locator('[data-testid="contingency-trigger"]');
        await expect(trigger).toBeEnabled({ timeout: 5000 });
        await trigger.click();
        await page.waitForResponse(r => r.url().includes('/api/n1-diagram'));

        await page.locator('[data-testid="analyze-suggest"]').click();
        await page.waitForResponse(r => r.url().includes('/api/run-analysis-step2'));
        await page.locator('[data-testid="display-prioritized-actions"]').click();
    });

    test('action card disco_BEON L31CPVAN — structural snapshot', async ({ page }) => {
        const html = await captureNormalisedHtml(
            page,
            `[data-testid="action-card-${SMALL_GRID.discoBeon}"]`,
        );
        expect(html).toMatchSnapshot('action-card-disco-beon.txt');
    });

    test('action overview map — structural snapshot', async ({ page }) => {
        // Click into the action then back to overview so pins are rendered.
        await page.locator(`[data-testid="action-card-${SMALL_GRID.discoBeon}"]`).click();
        await page.locator('[data-testid="tab-button-action"]').click();
        const html = await captureNormalisedHtml(page, '[data-testid="action-overview-diagram"]');
        expect(html).toMatchSnapshot('action-overview-map.txt');
    });

    test('combine modal body — structural snapshot', async ({ page }) => {
        await page.getByRole('button', { name: /Combine Actions/i }).click();
        await expect(page.locator('[data-testid="combine-modal-body"]')).toBeVisible();
        const html = await captureNormalisedHtml(page, '[data-testid="combine-modal-body"]');
        expect(html).toMatchSnapshot('combine-modal-body.txt');
    });
});
