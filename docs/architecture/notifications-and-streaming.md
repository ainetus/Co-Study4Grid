# One streaming + notification pipeline (D5, 2026-07)

Deep revision **D5** from
[`2026-07-full-repo-review.md`](2026-07-full-repo-review.md). Addresses
cross-cutting theme **T4** ("error paths were never designed as UX") and
finding #4 ("failures are invisible to the operator"): the backend
streamed NDJSON through five hand-copied reader loops that had drifted,
the two toast channels were ad-hoc and inaccessible, and no long-running
operation could be cancelled.

It landed in three slices (D5.1 → D5.3), each independently shippable.

## D5.1 — one NDJSON reader (`utils/ndjsonStream.ts`)

`/api/run-analysis[-step2]` and `/api/simulate-and-variant-diagram`
stream newline-delimited JSON. That body used to be parsed by **five**
hand-copied reader loops (`App.tsx` ×2, `useAnalysis`, `useDiagrams`,
`ActionFeed`) that had diverged — only the two `App.tsx` copies flushed a
final line lacking a trailing newline, and each re-implemented blank-line
and parse-error handling slightly differently.

`parseNdjsonStream(source, { signal? })` is the single implementation — an
async generator with uniform semantics:

- decodes with `TextDecoder({ stream: true })`, carrying the partial line
  across chunk boundaries;
- yields one parsed value per **complete** line; blank lines are skipped;
- a complete line that fails `JSON.parse` is skipped (matches the legacy
  "silent catch for incomplete rows");
- on stream end, flushes the decoder and yields a trailing unterminated
  final line if present;
- honours an `AbortSignal` (see D5.3): aborting cancels the reader and
  ends the iteration **without** flushing the partial buffer, so a
  consumer distinguishes an abort from normal completion via
  `signal.aborted`.

Every caller now consumes it with `for await (const event of
parseNdjsonStream(response, { signal })) { … }` and casts each event to
its own union. Reader cancellation in the generator's `finally` is
defensive (`reader.cancel?.()?.catch(…)`) so it never throws out of
cleanup, even against a test double that omits `cancel`.

## D5.2 — typed notification store (`utils/notifications.ts` + `NotificationHost`)

The old model had **two** ad-hoc toast channels: a sticky-but-
undismissable `error` string, and an `infoMessage` string that auto-hid
after 3 s and whose green-vs-blue colour was decided by a magic
`'SUCCESS'` prefix. `StatusToasts` rendered both; neither was dismissible
and neither was announced to assistive tech.

`utils/notifications.ts` replaces them with one store:

- a **module singleton** (like `interactionLogger`) so any layer — App,
  hooks, non-React helpers — raises a toast without prop-threading a
  setter, bound to React via `useSyncExternalStore` (`useNotifications`);
- each notification carries an explicit `severity` (`error` / `success` /
  `info`), a `sticky` flag (errors sticky by default; info/success
  auto-expire after `DEFAULT_TIMEOUT_MS`), and a stable `id`;
- **de-dupe**: raising an identical (severity, message) refreshes the
  existing toast instead of stacking (stops a debounced/retrying caller
  such as the SLD preview from piling up copies);
- helpers `notifyError` / `notifyInfo` / `notifySuccess` / `dismiss` /
  `clear` / `clearSeverity`.

`components/NotificationHost.tsx` renders the stack bottom-right: every
toast is dismissible (`×`), and the stack is an `aria-live` region —
errors announce assertively (`role="alert"`), info/success politely
(`role="status"`). It replaces `StatusToasts` (deleted).

Migration kept call sites stable where it could:

- `App`'s `setError` and `useAnalysis`'s `setError` / `setInfoMessage` are
  now thin adapters over the store, preserving the historical
  `(v: string) => void` raise/clear contract (a message raises a toast;
  `''` clears that channel). `useAnalysis` dropped its local
  `error` / `infoMessage` state and the bespoke 3 s timer.
- `useSession`'s two `setInfoMessage('SUCCESS: …')` calls became
  `notifySuccess(…)`, retiring the string protocol; the now-unused
  `setInfoMessage` param was removed from its param interfaces.
- The singleton is reset between Vitest tests in `src/test/setup.ts`.

## D5.3 — cancellable analysis (AbortController + visible Cancel)

Analysis is the long-running operation (step 1 detection + step 2 stream).
Each run now creates a fresh `AbortController` (kept on a ref in
`useAnalysis`); its signal is threaded into `runAnalysisStep1` (axios
`signal`), the `runAnalysisStep2Stream` fetch (`signal`), and
`parseNdjsonStream`. `cancelAnalysis()` aborts it.

An abort is treated as a **cancellation, not a failure**: the catch/
completion paths check `controller.signal.aborted` and raise an
`"Analysis cancelled."` info toast (no error toast, no `analysis_step2_
completed` event). `ActionFeed` shows a `✕ Cancel` control beside the
`⚙️ Analyzing…` indicator while a run is in flight (guarded by an optional
`onCancelAnalysis` prop; `App` wires it to `analysis.cancelAnalysis`).

## Tests

- `utils/ndjsonStream.test.ts` — chunk splitting, cross-chunk carry-over,
  trailing-line flush, blank/malformed skipping, null body, and abort
  (pre-aborted → nothing; mid-stream → stops without flushing the partial).
- `utils/notifications.test.ts` — severity/sticky defaults, de-dupe,
  dismiss / clear / clearSeverity, subscriber notification, snapshot
  stability, and auto-expiry under fake timers.
- `components/NotificationHost.test.tsx` — per-severity testids, alert vs
  status roles, and click-to-dismiss.
- `hooks/useAnalysis.test.ts` — errors/info assert against the store;
  cancellation (signal threading, abort → cancellation notice not error,
  no-op when idle).
- `components/ActionFeed.test.tsx` — the Cancel control appears while
  analyzing and invokes `onCancelAnalysis`.

## Remaining (tracked follow-ups)

- **QW14** — the highlight pipeline still re-runs on every pan/zoom
  settle (`useDiagramHighlights.ts` dependency churn); independent of D5.
- Cancellation currently covers the analysis flow (the multi-second
  operation). The shorter `simulate-and-variant-diagram` streams route
  through the same `parseNdjsonStream` and could accept a signal too if a
  cancel affordance is ever wanted there.
