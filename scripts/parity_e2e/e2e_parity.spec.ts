/**
 * Layer-3 parity E2E spec.
 *
 * Drives BOTH the React frontend (`frontend/dist/`, served statically)
 * AND the standalone (`standalone_interface.html`, loaded via
 * `file://`) through an identical canonical gesture sequence.  Both
 * runs hit a MOCKED backend via `page.route('/api/** / *', ...)` — so
 * the spec is independent of pypowsybl / expert_op4grid_recommender,
 * and can run in any CI environment where Playwright can install a
 * browser.
 *
 * After each run the spec captures:
 *   - The ordered list of `interactionLogger.record(...)` events.
 *   - The `session.json` payload that `buildSessionResult` writes
 *     when the user clicks Save.
 *
 * It then diffs the two runs along three axes:
 *   1. Event-type sequence (order-sensitive).
 *   2. `details` keys per event (order-insensitive).
 *   3. `session.json` shape (top-level + nested field presence;
 *      values are ignored because timestamps / durations differ).
 *
 * The spec is the authoritative "behavioural" check that complements
 * the static Layer-1 (`scripts/check_standalone_parity.py`) and the
 * session-reload fidelity Layer-2 (`scripts/check_session_fidelity.py`).
 *
 * ----------------------------------------------------------------
 * Running locally
 * ----------------------------------------------------------------
 *
 *   # Prereq: a browser for Playwright to drive.
 *   cd scripts/parity_e2e
 *   npm install
 *   npx playwright install chromium
 *
 *   # Build the React app once (so we can serve its /dist statically).
 *   cd ../../frontend
 *   npm install && npm run build
 *
 *   cd ../scripts/parity_e2e
 *   npx playwright test
 *
 * ----------------------------------------------------------------
 * CI wiring
 * ----------------------------------------------------------------
 *
 *   - uses: actions/checkout@v4
 *   - uses: actions/setup-node@v4
 *   - run: cd frontend && npm ci && npm run build
 *   - run: cd scripts/parity_e2e && npm ci
 *   - run: cd scripts/parity_e2e && npx playwright install --with-deps chromium
 *   - run: cd scripts/parity_e2e && npx playwright test
 *
 * The spec is deliberately kept at per-PR cost (~90 s) — see
 * `scripts/PARITY_README.md` for why we don't run it on every
 * commit and what it catches that Layers 1 + 2 miss.
 */
import { test, expect, type Page, type Route, type Browser } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';

// ---------------------------------------------------------------------
// Mock backend — minimal, just enough that both UIs can run the
// canonical gesture sequence without crashing.
// ---------------------------------------------------------------------

const MOCK_BRANCHES = ['LINE_A', 'LINE_B', 'LINE_C'];
const MOCK_VLS = ['VL_1', 'VL_2'];
const MOCK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <g id="nad">
    <g class="nad-vl" id="VL_1"><circle cx="30" cy="30" r="5"/></g>
    <g class="nad-vl" id="VL_2"><circle cx="70" cy="70" r="5"/></g>
  </g>
</svg>`;

async function registerMockBackend(page: Page): Promise<void> {
  await page.route('**/api/config', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'success',
        message: 'loaded',
        total_lines_count: MOCK_BRANCHES.length,
        monitored_lines_count: MOCK_BRANCHES.length,
        action_dict_file_name: 'mock_actions.json',
        action_dict_stats: { reco: 1, disco: 2, pst: 0, open_coupling: 0, close_coupling: 0, total: 3 },
      }),
    })
  );

  await page.route('**/api/branches', (route) =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        branches: MOCK_BRANCHES,
        name_map: Object.fromEntries(MOCK_BRANCHES.map(b => [b, b])),
      }),
    })
  );

  await page.route('**/api/voltage-levels', (route) =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        voltage_levels: MOCK_VLS,
        name_map: Object.fromEntries(MOCK_VLS.map(v => [v, v])),
      }),
    })
  );

  await page.route('**/api/nominal-voltages', (route) =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        mapping: Object.fromEntries(MOCK_VLS.map(v => [v, 400])),
        unique_kv: [400],
      }),
    })
  );

  // Base NAD — React uses `format=text` so the body is a JSON header
  // line + raw SVG body (see api.ts::getNetworkDiagram).
  await page.route('**/api/network-diagram**', (route) => {
    const header = JSON.stringify({
      metadata: {},
      lines_overloaded: [],
      lines_overloaded_rho: [],
    });
    const body = `${header}\n${MOCK_SVG}`;
    route.fulfill({ status: 200, contentType: 'text/plain; charset=utf-8', body });
  });

  await page.route('**/api/contingency-diagram', (route) =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        svg: MOCK_SVG,
        metadata: {},
        lines_overloaded: ['LINE_B'],
        lines_overloaded_rho: [1.15],
        flow_deltas: {},
        reactive_flow_deltas: {},
        asset_deltas: {},
        lf_converged: true,
        lf_status: 'CONVERGED',
      }),
    })
  );

  await page.route('**/api/run-analysis-step1', (route) =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        lines_overloaded: ['LINE_B'],
        message: '1 overloaded line detected',
        can_proceed: true,
      }),
    })
  );

  // NDJSON stream — two events.
  await page.route('**/api/run-analysis-step2', (route) => {
    const pdfEvent = JSON.stringify({ type: 'pdf', pdf_url: '/results/pdf/mock.pdf' });
    const resultEvent = JSON.stringify({
      type: 'result',
      actions: {
        disco_LINE_C: {
          description_unitaire: 'Disconnect LINE_C',
          rho_before: [1.15], rho_after: [0.85],
          max_rho: 0.85, max_rho_line: 'LINE_B',
          is_rho_reduction: true,
        },
      },
      action_scores: {},
      lines_overloaded: ['LINE_B'],
      combined_actions: {},
      message: '1 action found',
      dc_fallback: false,
    });
    route.fulfill({
      status: 200, contentType: 'application/x-ndjson',
      body: `${pdfEvent}\n${resultEvent}\n`,
    });
  });

  await page.route('**/api/action-variant-diagram', (route) =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        svg: MOCK_SVG, metadata: {}, action_id: 'disco_LINE_C',
        flow_deltas: {}, reactive_flow_deltas: {}, asset_deltas: {},
        lf_converged: true, lf_status: 'CONVERGED',
      }),
    })
  );

  await page.route('**/api/save-session', (route) =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        session_folder: '/tmp/session_mock',
        pdf_copied: false,
      }),
    })
  );

  await page.route('**/api/user-config', (route) =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        network_path: '', action_file_path: '', layout_path: '',
        output_folder_path: '', lines_monitoring_path: '',
        min_line_reconnections: 2.0, min_close_coupling: 3.0,
        min_open_coupling: 2.0, min_line_disconnections: 3.0,
        min_pst: 1.0, min_load_shedding: 0.0,
        min_renewable_curtailment_actions: 0.0,
        n_prioritized_actions: 10, monitoring_factor: 0.95,
        pre_existing_overload_threshold: 0.02,
        ignore_reconnections: false, pypowsybl_fast_mode: true,
      }),
    })
  );

  await page.route('**/api/config-file-path', (route) =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ config_file_path: '/tmp/config.json' }),
    })
  );
}

// ---------------------------------------------------------------------
// Interaction-log capture
// ---------------------------------------------------------------------

async function captureInteractionLog(page: Page): Promise<Array<Record<string, unknown>>> {
  // Both UIs expose `interactionLogger` on `window` (React via a
  // `useEffect` bridge, standalone via its inline class definition).
  // If the React app doesn't expose it, uncomment the helper below
  // and add `window.__interactionLogger = interactionLogger` inside
  // a `useEffect` in App.tsx guarded by `process.env.VITEST === 'e2e'`.
  return await page.evaluate(() => {
    // @ts-expect-error — interactionLogger is a runtime singleton.
    const logger = window.interactionLogger || window.__interactionLogger;
    return logger ? logger.getLog() : [];
  });
}

// ---------------------------------------------------------------------
// Canonical gesture sequence — the same 11 steps on both UIs.
// ---------------------------------------------------------------------

async function runCanonicalSession(page: Page): Promise<{
  events: Array<Record<string, unknown>>;
  sessionPayload: unknown;
}> {
  // 1. Load Study — the UI reads a cached config on mount and (in
  //    the React app) auto-opens Settings if paths are blank. For
  //    this test we preset paths via localStorage then click Load.
  await page.evaluate(() => {
    localStorage.setItem('networkPath', '/mock/network.xiidm');
    localStorage.setItem('actionPath', '/mock/actions.json');
    localStorage.setItem('layoutPath', '/mock/grid_layout.json');
    localStorage.setItem('outputFolderPath', '/mock/output');
  });
  await page.reload();
  await page.getByRole('button', { name: /Load Study/i }).click();
  await page.waitForResponse((r) => r.url().includes('/api/network-diagram'));

  // 2. Select contingency LINE_A.
  const contingencyInput = page.getByPlaceholder(/Search line\/bus/i);
  await contingencyInput.fill('LINE_A');
  await contingencyInput.press('Enter');
  await page.waitForResponse((r) => r.url().includes('/api/contingency-diagram'));

  // 3. Run step 1.
  await page.getByRole('button', { name: /Detect Overloads/i }).click();
  await page.waitForResponse((r) => r.url().includes('/api/run-analysis-step1'));

  // 4. Toggle overload LINE_B off then on (exercises the checkbox).
  const olCheckbox = page.getByLabel(/LINE_B/);
  await olCheckbox.uncheck();
  await olCheckbox.check();

  // 5. Run step 2.
  await page.getByRole('button', { name: /Resolve|Run Analysis/i }).click();
  await page.waitForResponse((r) => r.url().includes('/api/run-analysis-step2'));

  // 6. Display prioritized actions (if a separate button exists;
  //    otherwise the action feed populates automatically).
  const displayBtn = page.getByRole('button', { name: /Display Prioritized/i });
  if (await displayBtn.count() > 0) await displayBtn.click();

  // 7. Select (click) the first action card.
  const actionCard = page.locator('[data-action-id="disco_LINE_C"]').first();
  if (await actionCard.count() > 0) {
    await actionCard.click();
    await page.waitForResponse((r) => r.url().includes('/api/action-variant-diagram'));
  }

  // 8. Favorite the action.
  const starBtn = page.locator('[aria-label*="favorite"]').first();
  if (await starBtn.count() > 0) await starBtn.click();

  // 9. Change tab to N, then back to N-1.
  await page.getByRole('button', { name: /^N$/ }).click();
  await page.getByRole('button', { name: /^N-1$/ }).click();

  // 10. Zoom in/out on the active tab.
  const zoomIn = page.locator('[aria-label*="zoom in" i]').first();
  const zoomOut = page.locator('[aria-label*="zoom out" i]').first();
  if (await zoomIn.count() > 0) await zoomIn.click();
  if (await zoomOut.count() > 0) await zoomOut.click();

  // 11. Save session.
  await page.getByRole('button', { name: /Save Results|Save Session/i }).click();
  const saveResponse = await page.waitForResponse((r) =>
    r.url().includes('/api/save-session') && r.request().method() === 'POST'
  );

  const requestBody = saveResponse.request().postData();
  const sessionPayload = requestBody
    ? JSON.parse(JSON.parse(requestBody).json_content || '{}')
    : null;

  const events = await captureInteractionLog(page);
  return { events, sessionPayload };
}

// ---------------------------------------------------------------------
// Normaliser + diff helpers
// ---------------------------------------------------------------------

interface NormalisedEvent {
  type: string;
  detailKeys: string[];
}

function normaliseEvents(events: Array<Record<string, unknown>>): NormalisedEvent[] {
  return events.map((e) => ({
    type: String(e.type),
    detailKeys: Object.keys((e.details ?? {}) as Record<string, unknown>).sort(),
  }));
}

function collectFieldPaths(obj: unknown, prefix = ''): string[] {
  if (obj === null || typeof obj !== 'object') return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const p = prefix ? `${prefix}.${k}` : k;
    out.push(p);
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out.push(...collectFieldPaths(v, p));
    }
  }
  return out.sort();
}

// ---------------------------------------------------------------------
// Tests — one spec, two runs, three assertions.
// ---------------------------------------------------------------------

interface Artefacts {
  events: NormalisedEvent[];
  sessionFields: string[];
}

async function runUI(browser: Browser, url: string): Promise<Artefacts> {
  const page = await browser.newPage();
  await registerMockBackend(page);
  await page.goto(url);
  const { events, sessionPayload } = await runCanonicalSession(page);
  await page.close();
  return {
    events: normaliseEvents(events),
    sessionFields: collectFieldPaths(sessionPayload),
  };
}

test.describe('Layer-3 parity: React frontend vs standalone HTML', () => {
  test('identical event-type sequence on the canonical gesture script', async ({ browser }) => {
    const REACT_URL = process.env.REACT_URL ?? 'http://localhost:4173/';
    const STANDALONE_URL = process.env.STANDALONE_URL
      ?? `file://${path.resolve(__dirname, '../../standalone_interface.html')}`;

    const react = await runUI(browser, REACT_URL);
    const standalone = await runUI(browser, STANDALONE_URL);

    // Persist artefacts for post-mortem.
    await fs.writeFile('artefacts.json', JSON.stringify({ react, standalone }, null, 2));

    // 1. Event-type sequence — order-sensitive.
    const reactSeq = react.events.map((e) => e.type);
    const standaloneSeq = standalone.events.map((e) => e.type);
    expect.soft(standaloneSeq).toEqual(reactSeq);

    // 2. Details-keys per event — order-insensitive.
    for (let i = 0; i < Math.min(react.events.length, standalone.events.length); i++) {
      expect.soft(standalone.events[i].detailKeys, `event #${i} (${react.events[i].type})`)
        .toEqual(react.events[i].detailKeys);
    }

    // 3. Session-payload field paths.
    expect.soft(standalone.sessionFields).toEqual(react.sessionFields);
  });
});
