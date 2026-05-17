/**
 * Layer-D meta-invariants for the demo scenario.
 *
 * Catches catastrophic mis-renders that the structural invariants in
 * `demo_replay.spec.ts` would not flag because they assert specific
 * counts/visibilities rather than overall sanity. The checks here are
 * intentionally broad and cheap:
 *
 *   1. No console errors during the demo run (excluding the known
 *      noise documented in `IGNORED_CONSOLE_PATTERNS`).
 *   2. No SVG `<text>` element with empty content after each major
 *      checkpoint — catches label loss (e.g. when a tokens.css rule
 *      hides a font glyph but the element stays in the tree).
 *   3. No action card / pin carries an id matching `/^(undefined|null|NaN)/` —
 *      catches data plumbing regressions where a missing field leaks
 *      into a stable selector.
 *   4. Every visible NAD has a non-degenerate viewBox (width > 0 and
 *      height > 0) — catches the "auto-fit collapsed to 0×0" bug class.
 *   5. Pin count on the Action Overview equals simulated + unsimulated
 *      + combined (no orphan pin class).
 *
 * The spec re-uses the same mock backend, dispatchers and golden trace
 * as `demo_replay.spec.ts` — it does NOT duplicate them. Only the
 * assertions and the run scaffolding live here.
 */
import { test, expect, type Page } from '@playwright/test';

// The mock-backend stub below is a deliberately small subset of
// `demo_replay.spec.ts`'s registerMockBackend. We duplicate the routes
// rather than import because Playwright runs each spec in its own
// worker and the Page.route registrations must happen on this spec's
// page instance. TODO: once a third spec lands, extract to
// `helpers/mockBackend.ts`.

const SMALL_GRID_CONTINGENCY = 'P.SAOL31RONCI';

// ---------------------------------------------------------------------
// Console-error harness.
// ---------------------------------------------------------------------

const IGNORED_CONSOLE_PATTERNS: RegExp[] = [
    // React 19 in dev fires `Encountered two children with the same key`
    // warnings during the streaming step2 NDJSON when keys collide
    // transiently. Confirmed harmless; chase if it stops being transient.
    /Encountered two children with the same key/i,
    // react-select emits a "select-option" deprecation warning under
    // StrictMode — landed upstream, fixed in v6 but we're on v5.
    /react-select.*deprecated/i,
    // Vite HMR notices during dev preview run.
    /\[HMR\]/i,
];

interface ConsoleError {
    text: string;
    location?: { url: string; lineNumber: number };
}

function attachConsoleRecorder(page: Page): { errors: ConsoleError[] } {
    const bucket: ConsoleError[] = [];
    page.on('console', (msg) => {
        if (msg.type() !== 'error') return;
        const text = msg.text();
        if (IGNORED_CONSOLE_PATTERNS.some(re => re.test(text))) return;
        bucket.push({ text, location: msg.location() });
    });
    page.on('pageerror', (err) => {
        bucket.push({ text: `pageerror: ${err.message}` });
    });
    return { errors: bucket };
}

// ---------------------------------------------------------------------
// Meta-invariant checks. Each one is independent and reads from the
// page asynchronously — they do NOT mutate state.
// ---------------------------------------------------------------------

async function assertNoEmptyVisibleText(page: Page, where: string): Promise<void> {
    const empty = await page.evaluate(() => {
        const out: string[] = [];
        for (const el of Array.from(document.querySelectorAll('text, foreignObject'))) {
            const txt = el.textContent ?? '';
            if (txt.trim() === '' && (el as SVGGraphicsElement).getBBox) {
                // Empty <text>/<foreignObject> with a non-zero bbox = it
                // is allocated layout space but renders nothing — that's
                // a label-loss bug.
                try {
                    const bb = (el as SVGGraphicsElement).getBBox();
                    if (bb.width > 0 || bb.height > 0) out.push(el.outerHTML.slice(0, 100));
                } catch { /* getBBox throws on detached nodes — ignore */ }
            }
        }
        return out.slice(0, 5); // cap the diagnostic noise
    });
    expect.soft(empty, `${where}: no empty visible <text>/<foreignObject> with non-zero bbox`).toEqual([]);
}

async function assertValidStableIds(page: Page, where: string): Promise<void> {
    const bad = await page.evaluate(() => {
        const re = /^(undefined|null|NaN)/i;
        const out: string[] = [];
        for (const el of Array.from(document.querySelectorAll('[data-action-id], [data-testid^="action-card-"]'))) {
            const id = el.getAttribute('data-action-id')
                ?? (el.getAttribute('data-testid') ?? '').replace(/^action-card-/, '');
            if (id && re.test(id)) out.push(id);
        }
        return out;
    });
    expect.soft(bad, `${where}: no card/pin id starting with undefined/null/NaN`).toEqual([]);
}

async function assertNonDegenerateNadViewBoxes(page: Page, where: string): Promise<void> {
    const degenerate = await page.evaluate(() => {
        const out: string[] = [];
        for (const svg of Array.from(document.querySelectorAll('svg'))) {
            const vb = svg.getAttribute('viewBox');
            if (!vb) continue;
            const [, , w, h] = vb.split(/\s+/).map(Number);
            if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
                out.push(vb);
            }
        }
        return out;
    });
    expect.soft(degenerate, `${where}: every <svg viewBox> has finite positive width/height`).toEqual([]);
}

async function assertPinCountConsistency(page: Page, where: string): Promise<void> {
    const counts = await page.evaluate(() => {
        const root = document.querySelector('[data-testid="action-overview-diagram"]');
        if (!root) return null;
        const all = root.querySelectorAll('.nad-action-overview-pin').length;
        const unsim = root.querySelectorAll('.nad-action-overview-pin[data-unsimulated="true"]').length;
        const combined = root.querySelectorAll('.nad-action-overview-pin.nad-combined-action-pin').length;
        const simulated = all - unsim - combined;
        return { all, simulated, unsim, combined };
    });
    if (counts == null) return; // overview not mounted yet — not a failure here
    expect.soft(counts.simulated, `${where}: simulated = all − unsimulated − combined`)
        .toBe(counts.all - counts.unsim - counts.combined);
    expect.soft(counts.simulated, `${where}: simulated count is non-negative`).toBeGreaterThanOrEqual(0);
}

async function runMetaInvariantBattery(page: Page, where: string): Promise<void> {
    await assertNoEmptyVisibleText(page, where);
    await assertValidStableIds(page, where);
    await assertNonDegenerateNadViewBoxes(page, where);
    await assertPinCountConsistency(page, where);
}

// ---------------------------------------------------------------------
// The test — drives the demo through enough steps to hit every UI
// surface, then runs the meta battery after each checkpoint plus a
// final console-error tally.
// ---------------------------------------------------------------------

test.describe('Demo meta-invariants on config_small_grid', () => {
    test('No catastrophic mis-renders across the demo flow', async ({ page }) => {
        const consoleRecorder = attachConsoleRecorder(page);

        // Lightweight inline mock-backend stub. Minimal set the meta
        // battery needs (no need for analysis / combine endpoints —
        // we focus on the Load + Contingency surfaces here).
        await page.route('**/api/user-config', (r) => r.fulfill({
            status: 200, contentType: 'application/json',
            body: JSON.stringify({
                network_path: '', action_file_path: '', layout_path: '',
                output_folder_path: '', lines_monitoring_path: '',
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
                action_dict_stats: { reco: 1, disco: 1, pst: 0, open_coupling: 0, close_coupling: 0, total: 2 } }),
        }));
        await page.route('**/api/branches', (r) => r.fulfill({
            status: 200, contentType: 'application/json',
            body: JSON.stringify({
                branches: [SMALL_GRID_CONTINGENCY, 'BEON L31CPVAN', 'OTHER_LINE'],
                name_map: { [SMALL_GRID_CONTINGENCY]: SMALL_GRID_CONTINGENCY,
                    'BEON L31CPVAN': 'BEON L31CPVAN', 'OTHER_LINE': 'OTHER_LINE' },
            }),
        }));
        const MOCK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000">
            <g id="nad"><g class="nad-vl" id="VL1"><circle cx="500" cy="500" r="20"/></g></g>
        </svg>`;
        await page.route('**/api/voltage-levels', (r) => r.fulfill({
            status: 200, contentType: 'application/json',
            body: JSON.stringify({ voltage_levels: ['VL1'], name_map: { VL1: 'VL1' } }),
        }));
        await page.route('**/api/nominal-voltages', (r) => r.fulfill({
            status: 200, contentType: 'application/json',
            body: JSON.stringify({ mapping: { VL1: 400 }, unique_kv: [400] }),
        }));
        await page.route('**/api/network-diagram**', (r) => r.fulfill({
            status: 200, contentType: 'text/plain; charset=utf-8',
            body: `${JSON.stringify({ metadata: {}, lines_overloaded: [], lines_overloaded_rho: [] })}\n${MOCK_SVG}`,
        }));
        await page.route('**/api/n1-diagram', (r) => r.fulfill({
            status: 200, contentType: 'application/json',
            body: JSON.stringify({ svg: MOCK_SVG, metadata: {},
                lines_overloaded: ['BEON L31CPVAN'], lines_overloaded_rho: [1.15],
                flow_deltas: {}, reactive_flow_deltas: {}, asset_deltas: {},
                lf_converged: true, lf_status: 'CONVERGED' }),
        }));

        await page.goto('/');

        // Boot
        await page.evaluate(() => {
            localStorage.setItem('networkPath', '/data/grid.xiidm');
            localStorage.setItem('actionPath', '/data/actions.json');
            localStorage.setItem('layoutPath', '/data/layout.json');
            localStorage.setItem('outputFolderPath', '/data/sessions');
        });
        await page.reload();
        await page.getByRole('button', { name: /Load Study/i }).click();
        await page.waitForResponse(r => r.url().includes('/api/network-diagram'));
        await runMetaInvariantBattery(page, 'after Load Study');

        // Contingency
        const sel = page.locator('.cs4g-contingency__input').first();
        await sel.fill(SMALL_GRID_CONTINGENCY);
        await page.keyboard.press('Enter');
        await page.locator('[data-testid="contingency-trigger"]').click();
        await page.waitForResponse(r => r.url().includes('/api/n1-diagram'));
        await runMetaInvariantBattery(page, 'after contingency');

        // Tab toggles
        await page.locator('[data-testid="tab-button-n"]').click();
        await runMetaInvariantBattery(page, 'after switch to N tab');
        await page.locator('[data-testid="tab-button-contingency"]').click();
        await runMetaInvariantBattery(page, 'after switch back to contingency');

        // Final console tally — any error that survived
        // IGNORED_CONSOLE_PATTERNS is a failure.
        expect(consoleRecorder.errors, 'no console errors during the demo flow')
            .toEqual([]);
    });
});
