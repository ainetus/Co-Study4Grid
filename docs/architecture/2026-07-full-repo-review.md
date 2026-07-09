# Co-Study4Grid — Full Repository Review (2026-07)

**Scope**: code architecture (backend + frontend), interface & interaction design,
performance quality & bottlenecks, documentation, maintainability & delivery,
robustness/security, plus three gap areas (PyPSA-EUR data pipeline, Game Mode /
Codabench, deployment & release engineering).

**Method**: 12 independent dimension reviews executed by parallel agents reading the
actual code (not the docs), followed by an adversarial verification pass in which
every high/medium-severity finding was attacked by a skeptic instructed to refute
it, and a completeness critic that identified uncovered subsystems. 22 agents,
~490 tool invocations, ~1.46 M tokens of analysis.

**Verification outcome**: 57 high/medium findings verified — **34 confirmed,
23 partially confirmed (corrected below), 0 refuted**. Low-severity findings and
the three gap reviews were not adversarially verified and are flagged as such.

---

## Part I — Principles and method behind this review

A large review is only useful if its findings survive scrutiny and its proposals
can be sequenced. Seven principles structured this one:

1. **Evidence over impression.** Every strength and weakness must cite
   `file:line`, a measured count, or a commit hash. "App.tsx feels big" is not a
   finding; "App.tsx is 2,076 lines against its own CI ceiling of 2,100
   (`scripts/check_code_quality.py:128`), while three docs claim ~1,400" is.

2. **Documentation is a claim to test, not a source of truth.** Reviewers were
   explicitly forbidden from trusting the CLAUDE.md files. Every doc-vs-code
   disagreement is itself a finding (this surfaced the invisible
   `expert_backend/recommenders/` subsystem).

3. **Independent lenses, then convergence as signal.** Nine reviewers each saw
   one dimension and none saw the others' output. When four independent lenses
   (backend architecture, maintainability, docs, API) all land on the same root
   cause — the monkey-patched recommender integration — that convergence is
   strong evidence the issue is structural, not stylistic.

4. **Adversarial verification.** Optimistic reviewers over-report. Every
   high/medium finding was handed to a verifier whose instruction was to *refute*
   it: re-open the cited lines, hunt for mitigations the reviewer missed (caches,
   guards, CI steps, docs), and deflate severity where the deployment reality
   doesn't support it. 40 % of findings came back corrected — several materially
   (e.g. "four NDJSON parser copies" is actually **five**; the "300 s tkinter
   hang" doesn't occur on the headless image because tkinter is absent).

5. **Calibration to purpose.** This is a research/operator tool with two real
   deployment modes (localhost single-user; one-player HuggingFace Space), not a
   multi-tenant SaaS. Severity was judged against fitness-for-purpose: "no
   authentication" is not automatically high; "any web page can read local files
   through the default CORS wildcard" is.

6. **Strengths carry the same evidentiary burden.** A review that only lists
   deficits misleads: it invites "fixing" things that are load-bearing. The
   strengths below are verified in code, and several proposals deliberately
   *extend existing patterns* the repo already proved (helper extraction,
   ratcheting gates, token discipline) rather than importing foreign ones.

7. **Completeness check + honest limits.** A critic agent scanned for subsystems
   no reviewer covered and spawned three gap reviews (data pipeline, Game Mode,
   deployment). What remains uncovered is stated in Part VII rather than implied
   to be fine.

Process: scout (repo inventory, line counts, CI wiring) → nine parallel dimension
reviews → per-dimension adversarial verification → completeness critic → three gap
reviews → synthesis with cross-dimension deduplication.

---

## Part II — Executive summary

**Overall verdict**: Co-Study4Grid is a *far better engineered* codebase than its
category (2-person research tool) predicts — measurement-driven performance work
with committed benchmarks, dual test suites larger than the code they test, a
genuinely enforced quality ratchet, and unusually deliberate interaction design.
Its debts are equally real and cluster around five root causes, four of which are
different faces of the same phenomenon: **hand-maintained mirrors that have
drifted** (service composition vs. its docs, backend JSON vs. `types.ts`, five
copies of one stream parser, two copies of the step-2 generator, two copies of the
scoring function, annotated file trees vs. the tree).

The five headline issues, all verified:

> **Remediation status (2026-07-08).** Headline **#1** (D1), **#3** (D3)
> and **#4** (invisible failures — D5, one NDJSON reader + typed
> notification store + cancellable analysis) are **fixed**. **#5** (trust
> model — D7) is **mostly fixed**: loopback-default CORS (QW3), a
> session-path traversal guard (QW7), and the **lockdown profile** that
> disables the filesystem RPCs on the hosted Space now close it (the
> pinned-Python-closure lockfile is the tracked remainder). **#2** (D2 —
> error contract + machine-checked OpenAPI snapshot) is **partly fixed**;
> TS-generation and blanket-handler removal remain. See Part V for
> per-item detail and Part VI for the quick wins.

1. **The pluggable-recommender subsystem is a ghost.**
   `expert_backend/recommenders/_service_integration.py` rewrites
   `RecommenderService` at import time (setattr-grafts a mixin, wraps
   `update_config`/`reset`, wholesale-replaces `run_analysis_step2`), leaving a
   ~190-line near-duplicate legacy generator that already caused one shipped bug
   (commit `401045f`). The 8-file root `tests/` package (144 test functions) that
   covers exactly this integration is collected by no pytest config and no CI
   pipeline — green-by-omission. The subsystem is absent from both CLAUDE.md
   architecture trees. *(confirmed by 4 independent reviewers + verifiers)*

2. **Nothing machine-checks the API contract.** Zero `response_model` on 37
   routes; the 825-line `types.ts` is a hand-maintained mirror; ~26 blanket
   `except Exception → HTTP 400` blocks collapse the error space into five
   different client-visible error shapes; the NDJSON parser is hand-copied five
   times with divergent robustness fixes (only the two App.tsx copies flush an
   unterminated final event).

3. **Concurrency is unguarded where it is now real.** Zero locks in the backend;
   the shared pypowsybl `Network` is variant-switched from FastAPI threadpool
   workers (`Promise.all` batches, detached tabs, second Space visitor), one
   diagram path switches variants without try/finally
   (`diagram_mixin.py:151-160`), and `/api/run-analysis-step1` is `async def`
   running seconds of synchronous pypowsybl work — it blocks the entire event
   loop, freezing every other request. The single-user assumption is documented
   (`docs/performance/history/grid2op-shared-network.md`) but no longer holds on
   the Space.

4. **Failures are invisible to the operator.** The analysis hook's `error` state
   is never rendered anywhere: a backend 500 or a dropped connection mid-stream
   ends the "Analyzing…" spinner with zero feedback. Two re-simulation catch
   blocks swallow errors to `console.error`. There is no cancel for any
   long-running operation.

5. **The trust model no longer matches deployment.** Desktop-era filesystem RPCs
   (`config-file-path` reads any JSON, `save-session` writes to any path,
   `list-sessions` enumerates any directory) ship unauthenticated behind a
   default CORS wildcard — a drive-by local file read/write vector on localhost
   installs, and open filesystem access on the public Space (Game Mode gates only
   the UI, not the API).

Counterweights, equally verified: variant-lifecycle discipline is rigorous
(clone-from-clean-N, finally-restore, drain-before-mutate); svgPatch DOM recycling
is load-bearing and measured (3.01 s → 0.49 s, 27.1 MB → 5.5 MB); the API endpoint
table is 100 % accurate (37/37); the quality gate has historically been ratcheted
*down*, not up; the parity harness documents its own blind spots; security basics
(path traversal, zip-slip, XSS in the injected overlay, shell injection) are all
handled correctly.

---

## Part III — Cross-cutting themes

### T1. The recommenders epicenter *(backend, maintainability, docs, API)*
One root cause, four symptoms: import-time monkey-patching makes the production
code path undiscoverable from the service sources; the shadowed legacy generator
invites divergence (and has already diverged once); the covering tests never run;
the docs don't admit the subsystem exists. Any fix that addresses only one symptom
leaves the trap armed. → Deep revision **D1**. ✅ **Resolved 2026-07-07** —
and the port surfaced a second shipped bug from the same root cause
(`antenna_meta`); see Part V Observations.

### T2. Hand-maintained mirrors as the dominant failure mode
Count the copies: 2× `run_analysis_step2`, 5× NDJSON parser, 2× scoring function
(one of them outside the repo, at a hardcoded developer home path), 2× CI pipeline
(GH Actions + CircleCI, already drifted), `types.ts` mirroring undeclared response
shapes, annotated file trees mirroring the tree, 3× calibration logic in the data
pipeline, Docker install recipe claiming to "mirror CI" while it doesn't. The repo
is disciplined, so the mirrors were *initially* faithful — but every one of them
has drifted, and two drifts already shipped bugs. The systemic fix is to replace
mirrors with either a single source (extract the shared parser; delete the
shadowed generator; one CI) or a machine check (OpenAPI artifact diff; docs-tree
checker; scoring golden fixture). → **D1, D2, D8, D9** + quick wins.
✅ **Partly addressed 2026-07-07**: the shadowed step-2 generator is gone
(D1) and the OpenAPI artifact diff now exists (D2). The five NDJSON parser
copies (QW10/D5), the two CIs (D8/QW23), and the scoring golden fixture
(D8) are still open.

### T3. Concurrency debt meeting a new deployment reality
The single-user, single-flight assumption was a documented, reasonable 2025
decision. The 0.8.0 Space deployment and the frontend's own `Promise.all` batches
invalidated it. The event-loop-blocking `async def` is a one-keyword fix; the
missing coarse lock is a day; the variant/observation lifecycle (unbounded growth
within a session) is the longer tail. → **D3** + quick wins QW2, QW5.
✅ **D3 resolved 2026-07-07** (lock + 409 gate + variant LRU; the
lock-ordering caveat turned out to be a latent reset/prefetch deadlock —
see Part V). **QW5** (try/finally on `diagram_mixin._get_contingency_flows`)
was folded into D3 and is done. **QW2** (`async def`→`def` on
`run_analysis_step1` to stop blocking the event loop) was also landed
(2026-07-07) as a follow-up — the endpoint is now a sync `def` route,
guarded by `TestEventLoopSafety`.

### T4. Error paths were never designed as UX
Backend: everything → 400, details leak absolute paths. Contract: five error
shapes. Frontend: one error state rendered, one never rendered, catches swallowed,
no cancellation, no aria-live. Each layer made a locally-reasonable choice; the
composition means the operator sees either nothing or a raw exception string.
→ **D5** + quick wins QW4, QW6. ✅ **Frontend half resolved 2026-07-08 (D5)**:
one NDJSON reader, one typed notification store (dismiss / severity /
`aria-live`, no `'SUCCESS'` protocol), and cancellable analysis. The backend
half (everything→400, `str(e)` leaks) is D2's tracked blanket-handler removal.

### T5. Scale strain on the two coordination hubs
`App.tsx` (2,076 lines, 24 under its ceiling, hosting multi-hundred-line business
flows and two stream parsers) and `useDiagrams` (1,225 lines, six domains) are the
only two places where the otherwise-excellent decomposition discipline stopped.
State management is 100 % props (zero React context): an 88-prop
`VisualizationPanel`, a 44-prop `ActionFeed`, a 44-setter session-restore bag.
The repo's own deferred "Option 3" plan (`docs/architecture/app-refactoring-plan.md`)
already scopes the fix. → **D4**. 🟡 **Stages 1–3 done 2026-07-08**: the
`useManualSimulation` extraction removed the two stream-parser business
flows from `App.tsx` (2,048 → 1,795; ceiling ratcheted to 1,850); the
decoupled `useDiagrams` domains are now sub-hooks behind the facade
(1,210 → 1,145); and every exploded prop cluster on `VisualizationPanel`
(93 → 41) and `ActionFeed` (44 → 36) collapsed into cohesive state-object
props. Only the deeply-coupled useDiagrams core remains (tracked as FU-1).

### T6. The docs strategy outgrew its maintenance model
The doc *corpus* is a genuine strength (30+ indexed docs, accurate endpoint table,
traced quick start). The failure is concentrated in one genre: hand-maintained
annotated inventories (file trees, line counts, line-number anchors) — 20+
verified mismatches, ghost files (`ActionTypeFilterChips.tsx` documented in two
trees, absent on disk), and an entire subsystem missing. Inventories should be
generated or machine-checked; prose should carry the judgment. → **D9** + QW12.

### T7. The benchmark/data supply chain is unreproducible
Three independent gaps compose badly: `build_pipeline.py` cannot reproduce the
committed grid bundles (hardcoded forbidden 8,000-unit layout scale; two required
post-processing steps not in the pipeline); no provenance manifest links any
bundle to the code that made it; the Codabench scorer that `scoring.ts` must stay
"numerically identical" to lives outside the repo, and the exported session log is
neither replayable nor verifiable — the public ranking scores self-reported
numbers. → **D8**.

---

## Part IV — Findings by dimension

Verification legend: ✅ confirmed · 🟡 partially confirmed (statement corrected) ·
▫ low severity, not adversarially verified.

### 1. Backend architecture

*A well-engineered single-operator analysis server whose central bet — module-level
singletons, mutable state in three layers, zero synchronization — is documented as
unsafe yet unguarded, and whose worst structural decision (import-time
monkey-patching) has already shipped a bug.*

**Strengths**
- Rigorous pypowsybl **variant lifecycle discipline**: every switch paired with a
  finally-restore; contingency variants clone from a clean N baseline; analysis
  entry points drain the NAD-prefetch thread first
  (`recommender_service.py:637-656`, `:802-878`).
- **Measured, layered caching** with documented invalidation rules and a
  drain-first `reset()` ordering that anticipates a subtle poisoning bug
  (`recommender_service.py:59-172`).
- The PR #104/#106 **helper extraction is real dependency injection** — stateless
  helpers taking collaborators as arguments, call-time symbol resolution keeping
  legacy `@patch` seams alive.
- A **textbook plugin registry** (`recommenders/registry.py`): decorator
  registration, per-model degradation, server-side capability enforcement.
- **Error-type discrimination where it matters**: `ActionResultUnavailableError`
  separates the expected post-reload condition from faults while preserving the
  frontend's fallback contract.

**Weaknesses**

| Sev | Finding | Verdict |
|---|---|---|
| high | Production behavior of `run_analysis_step2` defined by import-time monkey-patching (`_service_integration.py:46-88, :323`), with a live ~190-line near-duplicate on `AnalysisMixin` — already caused the shipped cache-drift bug fixed in `401045f` | ✅ → **RESOLVED (D1)**: monkey-patch module deleted; single model-aware method on `AnalysisMixin`. Surfaced a *second* shipped bug from the same cause (`antenna_meta`) — see Part V Observations. |
| high | Zero synchronization on globally-shared mutable state despite real request concurrency (threadpool + `Promise.all` + Space) | ✅ → **RESOLVED (D3)**: service-level `RLock` + 409 study gate + variant LRU (`services/service_lock.py`). |
| high | Root `tests/` package (8 files) covering exactly this integration runs in no pytest config and no CI | ✅ → **RESOLVED (D1)**: rescued into `expert_backend/tests/`; caught a live bug on arrival (Part V Observation 2). |
| med | `reset()` misses `_n_state_currents` and `_last_action_path` | 🟡 — real, but `_last_action_path` is functionally harmless (the reload check also tests `_dict_action is None`); `_n_state_currents` staleness window is narrow. No test guards either. |
| med | `Overflow_Graph` dir resolved three different ways (module path, CWD, relative) | ✅ |
| med | All failures collapse to HTTP 400; broad exception swallowing; three error contracts | ✅ → **PARTLY RESOLVED (D2)**: one `{detail, code}` envelope + non-leaking logged 500 (`services/api_errors.py`); the per-endpoint `str(e)`→400 handlers are not yet deleted (tracked). |
| med | `/api/config` route embeds domain logic, private-attribute reaches, a vestigial global | ✅ |
| med | `update_config` is a ~190-line god-method that silently rewrites the user's action file on disk | ✅ |
| med | Backend CLAUDE.md drifted (composition model wrong, line anchors hundreds off) | ✅ → **PARTLY RESOLVED (D1)**: both CLAUDE.md trees updated for the explicit composition + the `recommenders/` subsystem; broader anchor-staleness is D9. |
| low | Vestigial vertical slice: legacy `/api/run-analysis`, root `inspect_action.py`, hand-maintained type shim | ▫ |
| low | `overflow_overlay.py` embeds ~916 lines of CSS/JS in an f-string, tested via a hand-mirrored Python re-implementation | ▫ |

### 2. Frontend architecture

*Disciplined, test-heavy React 19 with genuinely strong leaf layers; the
coordination layer is under real strain.*

**Strengths**
- **Leaf-layer decomposition**: `utils/svg/` is pure, per-module tested, no React
  or axios imports — the imperative SVG work is quarantined.
- **Game Mode isolation verifiably holds**: three guarded touch points via the
  bridge singleton, exactly as documented.
- **Design-token discipline machine-enforced** — which is what made dark mode a
  token swap.
- Dense co-located tests; App-level integration tests split by domain.
- The **hybrid React/imperative SVG model is deliberate and correctly layered**
  (React owns lifecycle; refs own the hot path).

**Weaknesses**

| Sev | Finding | Verdict |
|---|---|---|
| high | `App.tsx` (2,076 lines; 24 under its CI ceiling introduced under a "lower over time, don't raise" comment) hosts multi-hundred-line business flows incl. two stream parsers | ✅ |
| high | Props-only state at a scale where it stopped working: 88-prop `VisualizationPanel`, 44-prop `ActionFeed`, 44-setter restore bag, zero context | ✅ |
| med | Hook coupling via whole-state-object injection & sibling-setter threading; load-bearing hook instantiation order | 🟡 — worse than claimed in one respect (`DiagramsState` has 57 members, not 40) but hooks *are* individually testable |
| med | `useDiagrams`: 1,225 lines spanning six domains | ✅ |
| med | NDJSON parser hand-copied with divergent fixes | 🟡 — **five** copies, not four (missed `useDiagrams.ts:634-652`); only the two App.tsx copies flush the final unterminated event; failure currently latent because the backend happens to newline-terminate |
| med | CLAUDE.md contradicts the code (App size, "no API calls in components" vs. `ActionFeed`'s six call sites, ghost `ActionTypeFilterChips.tsx`) | 🟡 — 3 of 4 cited contradictions real |
| low | Fragile implicit contracts: comment-by-line-number, no console.log ceiling | ▫ |

### 3. API & interface contract

*A pragmatic RPC-over-HTTP surface of 37 routes, unusually well documented and
test-covered, with genuinely good large-payload engineering — undermined by the
absence of any machine-checked response contract.*

**Strengths**
- **Endpoint table diff-matches `main.py` exactly (37/37)** — the single most
  load-bearing reference is accurate.
- **Three-tier payload strategy** for 12–28 MB SVGs: gzip negotiation, bespoke
  header+text framing, SVG-less patch endpoints with an explicit
  `patchable:false` degrade path.
- Request side is **consistently Pydantic** (typed 422s).
- One simple, ordering-aware **NDJSON event grammar** across the three streams.
- **Real contract tests on both sides** (82 backend endpoint tests, 22 frontend).

**Weaknesses**

| Sev | Finding | Verdict |
|---|---|---|
| high | Error contract collapses to 400 and fragments into five client-visible shapes; backend relies on 400-as-please-resimulate | 🟡 → **PARTLY RESOLVED (D2)**: one `{detail, code}` envelope; resimulate dependency preserved via `code=ACTION_RESULT_UNAVAILABLE`; blanket-handler deletion tracked. |
| high | No `response_model` anywhere; `types.ts` is an unenforced hand mirror; stream events landed via `as unknown as` casts | ✅ → **PARTLY RESOLVED (D2)**: `openapi.snapshot.json` + CI diff now machine-checks the contract; response models on 3 control endpoints; `types.ts` generation still to do. |
| med | Five duplicated NDJSON parsers (see above) | 🟡 |
| med | Desktop-era filesystem RPCs unauthenticated on the public Space | 🟡 — real, but the 300 s tkinter hang doesn't occur headless (tkinter absent, fails in ms); blast radius is one ephemeral single-player container |
| med | Dead surface: 4 of ~34 endpoints have zero callers | 🟡 — the focused-diagram pair backs a documented proposal and its internals are exercised by the live patch pipeline; truly dead ≈ `/api/run-analysis` + `element-voltage-levels` routes |
| med | HTTP layer reaches into service privates; domain logic in routes | ✅ |
| low | Wire types mixed with DOM state; unvalidated string enums | ▫ |
| low | `/api/models` contract tests never collected (root `tests/`) | ▫ |

### 4. Interaction & UX design

*Unusually deliberate for an operator tool — but error surfacing has a real hole,
and five click grammars coexist.*

**Strengths**
- **Every destructive transition routes through one typed `ConfirmationDialog`**
  (six loss-of-work gestures).
- **Two-step analysis with staged reveal** preserves operator investment across
  re-runs; the overflow graph appears as soon as its stream event lands.
- **Notices tier system** deliberately fixes warning fatigue.
- **Detached-tab model survives the detach/reattach round-trip** (viewBox, refs,
  listeners), with triple-redundant window pruning.
- **Transactional SLD edit idiom** (stage → preview → simulate → card) with
  per-row and bulk revert.
- **Replay-ready interaction logging** woven through every gesture.

**Weaknesses**

| Sev | Finding | Verdict |
|---|---|---|
| high | Analysis failures invisible: `useAnalysis`'s `error` state set on three failure paths, rendered nowhere; `App.tsx` destructures a *different* local `error` | ✅ → **RESOLVED (QW4 → D5.2, 2026-07-08)**: the QW4 stopgap surfaced the hook error via `StatusToasts`; D5.2 then folded both error channels into the single `notifications` store rendered by `NotificationHost`, so there is now one error path. |
| med | Re-simulation failures swallowed (`console.error` only) | ✅ → **RESOLVED (QW4, 2026-07-08)**: the pin / SLD-edit catches now `setError`, and the SLD-preview catch was the last silent one — now surfaced too. |
| med | Toast design: error banner has no dismiss & no timeout; info fixed 3 s; no `aria-live`; magic `'SUCCESS'` string protocol | ✅ → **RESOLVED (D5.2)**: typed `notifications` store + `NotificationHost` — per-toast dismiss, severity-typed styling, auto-expiry, `aria-live`; the `'SUCCESS'` prefix is gone (explicit `notifySuccess`). |
| med | Five single-vs-double-click grammars across surfaces; one documented backwards | 🟡 — grammars enumerated & confirmed; "backwards" doc claim narrowed |
| med | No cancellation/abort for any long-running operation | ✅ → **RESOLVED (D5.3)**: analysis runs are cancellable end-to-end (AbortController through step 1 / step 2 fetch / stream) with a visible Cancel; an abort surfaces as a cancellation notice. |
| med | Dark theme doesn't reach detached popups; hardcoded `'white'` literals | ✅ |
| med | Keyboard/AT access near-absent; modals lack Escape & focus management | ✅ |
| med | Divergent NDJSON consumers with different error semantics (cross-ref T2) | ✅ → **RESOLVED (D5.1)**: one `utils/ndjsonStream.ts` reader replaced all five drifted copies. |
| low | Debug console noise in interaction hot paths; `'+'`-joined contingency ids | ▫ |

### 5. Backend performance

*A mature, measurement-driven culture (committed benchmarks, perf-history docs
that match code, vectorized hot paths citing before/after timings). The three big
wall-clock costs — study load ~8.5 s, step-2 stream, cold N-1 view 18.1 s → 4.2 s —
are each substantially mitigated. Residual defects are specific and fixable.*

**Strengths**
- Correct **sync-def threading model** for pypowsybl endpoints + disciplined
  ≥10 KB gzip.
- **Caching mapped to profiled costs** with explicit reset discipline.
- **Committed benchmark suite with recorded numbers**; README tells contributors
  when to re-run what.
- **Vectorized per-branch delta/overload pipelines**; narrow-attribute pypowsybl
  queries (144 ms → 6.6 ms documented).
- **SVG-less patch endpoints** remove the dominant diagram cost from tab
  switches.

**Weaknesses**

| Sev | Finding | Verdict |
|---|---|---|
| high | `/api/run-analysis-step1` is `async def` running seconds of sync pypowsybl/grid2op — blocks the entire event loop (all endpoints freeze) | ✅ → **RESOLVED (QW2, 2026-07-07)**: changed to a sync `def` route (dispatched to the threadpool); guarded by `TestEventLoopSafety`. |
| med | Shared Network variant-switched from threadpool workers, no lock; `diagram_mixin.py:151-160` lacks try/finally | 🟡 → **RESOLVED (D3)**: service-level `RLock` on all variant-switching entry points + try/finally added to `_get_contingency_flows`. |
| med | Pandas row-iteration reintroduced in newer helpers — worst case an 85,304-iteration `.loc` loop per action-SLD view (`_diff_switches`) | ✅ |
| med | Streaming endpoints ship the full 20–28 MB action NAD JSON-escaped, uncompressed | ✅ |
| med | Obs prewarm (`env.get_obs`) runs synchronously inside every contingency-diagram request | ✅ |
| low | Legacy analysis stream busy-polls with no worker timeout; per-study state only grows within a session; N-state reference flows recomputed per patch request; duplicated step-2 generator (T1) | ▫ |

### 6. Frontend performance

*Deep, honest performance engineering (svgPatch recycling measured at
3.01 s → 0.49 s; pan/zoom fully bypasses React; detached tabs move DOM instead of
copying). The remaining costs are concentrated in the full-NAD ingestion path and
render hygiene at the App.tsx level.*

**Strengths**
- **svgPatch DOM recycling is load-bearing and guarded** (server-shipped
  VL-subtree fragments with svgId rewriting).
- **Zero React renders during pan/zoom gestures**: direct viewBox writes, rAF
  batching, cached CTM.
- **Bitmap snapshot mode** is sophisticated (taint handling, stylesheet
  isolation) and honestly benchmarked.
- **O(1) lookup layers** (Map indices) replace repeated DOM scans.
- Hidden-tab **layout-tree cost was profiled and fixed with DevTools evidence**.

**Weaknesses**

| Sev | Finding | Verdict |
|---|---|---|
| high | Full-NAD loads pay an avoidable serialize + re-parse round-trip (`svgBoost.ts:621` serializes; every string path re-parses via innerHTML); `MemoizedSvgContainer`'s "zero extra parse" comment is false on all string paths | 🟡 — avoidable slice is several hundred ms per load, not the full 1.4 s · ✅ **FIXED (D6, 2026-07-09)**: `processSvg` returns the boosted `SVGSVGElement`; `MemoizedSvgContainer` adopts it via `replaceChildren` — no serialize + `innerHTML` re-parse. Comment now accurate. |
| med | Whole-object dependency churn re-runs the entire highlight pipeline after every pan/zoom settle | ✅ |
| med | Default pan/zoom re-rasters the full vector layer per frame (~20 fps on the 5,247-VL grid) while the benchmarked 120 fps bitmap mode ships opt-in | 🟡 — opt-in is the *documented* shipped design pending real-hardware validation; a VL-count auto-enable is a reasonable follow-up, severity low-med |
| med | Memory retention: 3 always-mounted 200k-node DOMs + unbounded per-action processed-SVG string cache + overview clone | 🟡 — bounded in practice (~100–300 MB worst case within one contingency; cache clears on contingency change); LRU cap still warranted |
| med | App.tsx re-render blast radius defeats `React.memo` on the big children (unstable callback identities) | ✅ |
| low | Dead `react-zoom-pan-pinch` dependency; stale perf docs; unminified standalone rationale predates the legacy file's retirement; 25 `console.log` in hot paths | ▫ |

### 7. Documentation

*Extensive and mostly high quality (accurate 37/37 endpoint table, traced quick
start, layered docs/ index, 77 % docstring coverage, invariant-level comments in
the gnarliest modules, disciplined 83 KB CHANGELOG). The failure mode is one
genre: hand-maintained inventories.*

**Weaknesses**

| Sev | Finding | Verdict |
|---|---|---|
| high | Recommenders subsystem invisible/misdescribed in both CLAUDE.md trees; root `tests/` outside the documented test entry point | 🟡 — full map *does* exist at `docs/backend/recommender_models.md` and README's "Plug Your Own Model"; the *canonical onboarding layer* is what's wrong |
| high | Ghost files and materially wrong sizes in both CLAUDE.md trees — inventory layer no longer trustworthy | ✅ |
| med | `.env.example` documents vars the code never reads (`PYPOWSYBL_FAST_MODE`, `LOG_LEVEL`); nothing loads a `.env`; the three actually-read vars are missing | 🟡 — the real vars are documented elsewhere |
| med | `PARITY_AUDIT.md` frozen at 2026-04-20 while root CLAUDE.md calls it a living record | 🟡 — parity truth lives in CI; fix is a one-line reframe |
| med | Hard-coded line-number anchors systematically stale (5 of 6 sampled wrong) | ✅ |
| med | Root CLAUDE.md describes the pre-0.8.0 dependency world (requirements.txt vs. the pyproject reality) | 🟡 |

### 8. Maintainability, testing & delivery

*Testing discipline is exceptional for the team size: 892 backend test functions,
frontend test lines exceed source lines (32,776 vs 27,790, zero snapshots), a
prefer-real-fallback-to-mock conftest, coverage + mypy-at-zero gates, a 4-layer
parity harness with honest blind-spot docs. Delivery is where the debts sit.*

**Weaknesses**

| Sev | Finding | Verdict |
|---|---|---|
| high | Orphaned root `tests/` (1,708 lines, 144 functions) — and two docs present it as the canonical suite (`pytest tests/`); a running test explicitly defers coverage to an orphaned file | 🟡 — one filename collision with the running suite, not three |
| med | No machine-checked backend↔`types.ts` contract | ✅ |
| med | CI resolves the newest unpinned upstream recommender on every run — third-party releases can break unrelated PRs | ✅ |
| med | Full CI duplication GH Actions + CircleCI; CircleCI a strictly weaker drifted copy | 🟡 — documented belt-and-braces choice; real cost is doubled maintenance + one-way drift |
| med | Dependency metadata across four inconsistent files (pyproject the real source; dead stub requirements.txt; `requirements_py310.txt` pins *below* the CI floor; overrides.txt floors misdescribed as pins); no lockfile | 🟡 — README/CONTRIBUTING carry correct commands |
| med | Onboarding-doc drift incl. phantom `fileRegistry` utility | 🟡 |
| med | Mixin-level tests over-rely on patch chains (226 `patch(` / 249 `patch.object`) & private-attribute injection — each further decomposition round gets more expensive | 🟡 — real-stack numerical tests partially mitigate |
| low | Committed litter (`inspect_action.py`, tracked generated outputs); gate ceilings at near-zero headroom (by design); bus factor of one | ▫ |

### 9. Robustness & security

*The classic mistakes are absent — traversal, zip-slip, XSS, shell injection all
correctly handled. The problem is a trust model ("the client is the operator on
their own machine") violated in both real deployment modes.*

**Strengths**: `/results/pdf` confined via `resolve()+relative_to()`; zip-slip-safe
extraction (`basename`); argv-only subprocess; `allow_credentials` correctly
disabled under the wildcard; injected overlay renders untrusted data via
`textContent`/`createElementNS`/`CSS.escape` only.

**Weaknesses**

| Sev | Finding | Verdict |
|---|---|---|
| high | CORS `*` + no auth + arbitrary-file endpoints = drive-by local file read/write from any web page against a localhost install | ✅ → **RESOLVED (QW3 + D7, 2026-07-08)**: the CORS default is loopback dev origins (wildcard explicit opt-in), closing the drive-by cross-origin read; the arbitrary-file RPCs are disabled by the D7 lockdown profile on hosted deployments. |
| high | Unauthenticated arbitrary filesystem access survives on the public Space (Game Mode gates only the UI); `../` traversal in `session_name` | ✅ → **RESOLVED (QW7 + D7, 2026-07-08)**: `session_name` traversal closed (`_safe_session_dir`), and the filesystem RPCs themselves return `403 LOCKED_DOWN` on the Space (`COSTUDY4GRID_LOCKDOWN`, set in the Dockerfile). |
| med | Singleton state shared across concurrent users, no locking (cross-ref T3) | ✅ → **RESOLVED (D3)**: service-level `RLock` + 409 study-mutation gate. |
| med | `detail=str(e)` leaks absolute server paths | ✅ → **PARTLY RESOLVED (D2)**: the global unhandled-exception handler now returns a generic 500 (no `str(e)`); the per-endpoint `except → 400, str(e)` handlers still echo the message and are tracked for removal. |
| med | `/api/pick-path` spawns a subprocess per request | 🟡 — headless child fails in ms (tkinter absent); low-severity dead weight, not a DoS vector |
| low | `load-session` imports arbitrary HTML into the same-origin-served dir; `update_config` writes back to the caller-supplied action path | ▫ |

### 10. *(gap)* PyPSA-EUR data pipeline & grid provenance — *not adversarially verified*

Well-documented five-stage orchestration with an architecturally thoughtful
158-test suite — but: **`build_pipeline.py` cannot reproduce the committed
bundles** (hardcodes the forbidden 8,000-unit layout scale at
`convert_pypsa_to_xiidm.py:876`; omits the two layout post-processing scripts that
produced the committed layouts — a rebuild silently clobbers good layouts);
**the 158 tests run in no CI** and can't pass from a fresh clone; **no provenance
record** links any bundle to the pipeline version that made it (3 commits total
touch the pipeline; 22 MB of outputs arrived wholesale); three overlapping
calibration implementations plus a dead builder (~700 removable lines); six
scripts execute argparse/IO at import; Game Mode presets hardcode contingency ids
with no consistency test against the artifacts they reference.

### 11. *(gap)* Game Mode & Codabench — *not adversarially verified*

Internals better than a 1,690-LoC bolt-on has a right to be (verified isolation;
race bugs fixed with sophisticated CI-run regression tests; pure edge-guarded
scoring). But: **the declared dual-implementation scoring contract has no in-repo
Python twin** — `scoring.test.ts` claims to mirror a `score.py` living at a
hardcoded `~/Dev/codabench/...` path, no parity fixture, no CI guard, and the e2e
script carries a third partially-divergent copy; **the exported session log is
neither replayable nor verifiable**, so the public ranking scores self-reported
numbers; a mid-session backend failure destroys all completed results (the
promised retry doesn't exist); multi-action scoring is physically misleading
(actions are never combined — optimal play is always exactly one star); the e2e
harness covers 1 of 8 FR studies and zero of the shipped default EUR tier.

### 12. *(gap)* Deployment & release engineering — *not adversarially verified*

Mechanics are strong (inert same-origin SPA mount; triple-guarded pinGlyph
coupling; idempotent first-boot seeding; safe-by-default deploy automation). The
fundamentals are missing: **no reproducible Python closure anywhere** (all floors,
recommender floats at build time with `--no-deps`, floating base images, the only
lock-like file is stale and consumed by nothing — a zero-change HF factory rebuild
can produce a different broken image); the Dockerfile's "mirrors CI" claim is
false in the part that matters; **continuous ungated deploy + zero tags +
force-push = no rollback primitive**; the LFS zip-extraction step has two silent
failure modes; the image ships dead weight (jupyter-widget stack, `scripts/`,
tests); `PORT` is decorative; no `HEALTHCHECK`; config upgrades never merge.

> 🟡 **Partly addressed by D7 (2026-07-08)**: the deploy is now test-gated
> (`workflow_run` on a green **Tests** run) and tags each deploy on origin
> (`space-deploy-*`) as a rollback pointer, and the trust hole is closed by
> the lockdown profile. The reproducible-Python-closure lockfile is a
> documented follow-up; the dead-weight / `HEALTHCHECK` / config-merge
> items remain open. See [`deployment-trust.md`](deployment-trust.md).

---

## Part V — Deep revisions (sequenced roadmap)

Ordered by leverage; each unblocks or de-risks the ones after it.

> **Progress (2026-07-09).** D1, D3 and **D5** are **shipped in full**;
> **D6** is **core-done** (the SVG element-adoption pipeline; the VL-count
> bitmap auto-enable is validation-gated). **D7** and **D8** are **mostly
> shipped** — D7: lockdown profile + test-gated deploy + rollback tag (the
> pinned-Python-closure lockfile is a documented follow-up); D8: the
> layout-scale fix + `separate_voltage_levels` step + provenance manifest +
> hermetic pipeline CI + the in-repo Codabench scorer pinned to the frontend
> by a shared golden fixture (physical session-log replay tracked as FU-2).
> **D2** and **D4** are **partially shipped** (D2 — the machine-check backbone
> + error contract; D4 — stages 1–3: the `useManualSimulation` extraction +
> ceiling ratchet, the facade-preserving `useDiagrams` sub-hook split, and the
> full `VisualizationPanel` + `ActionFeed` props consolidation, with only the
> deeply-coupled useDiagrams core still open — tracked as FU-1). Status is
> noted per-item below and mirrored in the dimension-finding tables in
> Part IV. D9 remains open.

### Status at a glance (2026-07-09)

| Rev | Title | Status | What remains |
|-----|-------|--------|--------------|
| D1 | De-ghost the recommender subsystem | ✅ Done | — |
| D2 | API contract machine-check + error envelope | 🟡 Partial | response models on the gzipped endpoints; `types.ts` generation from the snapshot; blanket-handler removal |
| D3 | Shared-`Network` concurrency ownership | ✅ Done | — |
| D4 | Relieve the two frontend hubs | 🟡 Mostly | **FU-1** — the deeply-coupled `useDiagrams` core (`handleActionSelect` / `zoomToElement` / DOM-mutating voltage filter) |
| D5 | One streaming + notification pipeline | ✅ Done | — |
| D6 | SVG element-adoption pipeline | 🟢 Core done | VL-count auto-enable of bitmap pan/zoom (validation-gated on operator hardware) |
| D7 | Deployment trust & reproducibility | 🟡 Mostly | pinned-Python-closure lockfile; Dockerfile dead-weight / `HEALTHCHECK` / config-merge |
| D8 | Reproducible data & benchmark supply chain | ✅ Done | **FU-2** landed — `e2e_game_session.py --replay` re-derives trusted ranking numbers + hermetic `test_replay.py` |
| D9 | Docs as a checked artifact | ✅ Done | `scripts/check_docs_tree.py` gate + symbol anchors + `test_check_docs_tree.py`; CLAUDE.md tree brought green |

Full accounting of every open item — deep-revision tails, follow-ups, and the
remaining quick wins — is in **[§ Part V.5 — What's left](#part-v5--whats-left-2026-07-09)** below.

**D1. De-ghost the recommender subsystem** *(2–3 days — do first)* — ✅ **DONE (2026-07-07)**
Replace import-time monkey-patching with explicit composition:
`RecommenderService` inherits `ModelSelectionMixin` directly (it is already
written as a mixin); `update_config`/`reset` call `_apply_model_settings`/
`_reset_model_settings` explicitly; **delete** the shadowed ~190-line legacy
generator in `analysis_mixin.py:565-756`. Rescue the root `tests/` into
`expert_backend/tests/` (resolving the one filename collision) so CI covers the
integration. Update both CLAUDE.md trees. This closes T1 entirely and removes the
mirror that already shipped a bug.
> **Shipped**: `_service_integration.py` deleted; the single model-aware
> `run_analysis_step2` now lives on `AnalysisMixin` (split into
> `_run_step2_discovery` / `_enrich_step2_results` to stay under the LoC
> ceiling). All 8 root-`tests/` files rescued into `expert_backend/tests/`
> (`test_service_integration.py` → `test_model_composition.py`;
> `test_recommenders_registry.py` merged). **Two extra findings surfaced
> and fixed during the port** (see the Observations note at the end of
> this section): the `antenna_meta` mirror-drift bug and an
> underscore-in-substation-name bug in the overflow-path filter that the
> orphaned test had been silently guarding against with zero CI coverage.

**D2. Machine-check the API contract** *(4–6 days)* — 🟡 **PARTIALLY DONE (2026-07-07)**
(a) Pydantic response models on the ~12 highest-traffic endpoints (preserving
`sanitize_for_json` coercion); (b) commit an `app.openapi()` dump + CI diff so
response-shape changes become reviewable; (c) generate the TS types from OpenAPI
and retire the hand-mirror incrementally; (d) unify the error contract — one
middleware mapping domain errors → 400/404/409 with `{detail, code}`, everything
else → 500 + `logger.exception`, deleting the ~26 blanket handlers; one frontend
error extractor. Note the frontend's documented 400-triggers-resimulate dependency
(`main.py:706-715`) must be preserved via an explicit error code.
> **Shipped**: (d) the unified `{detail, code}` envelope
> (`services/api_errors.py`) — every `HTTPException` carries a code,
> uncaught exceptions → clean logged `500` with no `str(e)` path leak
> (also closes QW6), the resimulate dependency preserved via an explicit
> `ACTION_RESULT_UNAVAILABLE` code, and one frontend extractor
> (`utils/apiError.ts`) replacing ~10 scattered reads; (b) the
> `openapi.snapshot.json` + `check_openapi_contract.py` + a pytest CI
> diff; (a) response models on 3 safe control endpoints (seed).
> **Deferred** (tracked in
> [`api-contract-machine-check.md`](api-contract-machine-check.md)): the
> `str(e)`-preserving per-endpoint 400 handlers are NOT yet deleted (each
> needs a coordinated backend + test + frontend change — the envelope
> unified the *shape* but genuine bugs still surface as 400, not 500);
> response models on the gzipped diagram/analysis endpoints (blocked on
> the `Response`-bypasses-`response_model` + NumPy-coercion constraint);
> and generating `types.ts` from the snapshot.

**D3. Concurrency ownership for the shared Network** *(3–5 days)* — ✅ **DONE (2026-07-07)**
One service-level `RLock` (decorator on the ~12 variant-switching entry points),
a 409 "busy" contract for overlapping study mutations, try/finally on the
unguarded path (`diagram_mixin.py:151-160`), then LRU lifecycle for variants +
cached observations (keep N + last K, `remove_variant` on eviction). Watch
lock-ordering against the NAD-prefetch drain.
> **Shipped**: `services/service_lock.py` — `@with_network_lock` /
> `@with_network_lock_stream` on the 13 variant-switching entry points
> (the streaming decorator holds the lock per-`next()` so Starlette's
> per-step threadpool hopping stays safe), the 409 study-mutation gate,
> the try/finally fix in `_get_contingency_flows`, and the
> `MAX_CONTINGENCY_VARIANTS` LRU with `remove_variant` on eviction.
> **Observation on the lock-ordering warning** (which the roadmap flagged):
> it was worse than a warning — the existing `reset()` **joined** the
> NAD-prefetch worker, and once that worker also takes the network lock
> the join becomes a 60 s deadlock. Resolved by replacing the join with a
> `_prefetch_generation` counter (the worker discards stale results under
> the lock); the drain is now a no-op when the lock is present. Full
> rationale: [`shared-network-concurrency.md`](shared-network-concurrency.md).
> The observation cache LRU was scoped down: the single-slot
> `_cached_obs_n1*` is already bounded (one entry, keyed by contingency),
> so only the unbounded *variant* set needed an LRU — see the doc.

### Observations surfaced while implementing D1–D3

1. **The `antenna_meta` mirror-drift bug (D1) — a second shipped bug from
   the same root cause the review named.** The islanded-pocket metadata
   added to the legacy `AnalysisMixin.run_analysis_step2` in commit
   `2dd2ced` (2026-06-18) was never mirrored into the *production*
   monkey-patched generator in `_service_integration.py`. Because the
   monkey-patch shadowed the legacy method at import, the frontend's
   `AntennaNotice` was **dead in production** for ~3 weeks while looking
   correct in the (shadowed, still-tested) legacy path. This is a
   second instance of exactly the "shadowed generator invites divergence"
   failure the review attributed to `401045f` — the de-ghosting removes
   the trap. Regression-guarded by
   `test_model_composition.py::test_result_event_restores_antenna_meta_from_discovery`.

2. **The orphaned `tests/` were not merely uncollected — one guarded a
   live bug (D1).** `test_overflow_path_filter.py::test_action_matches_by_uuid_segment_scan`
   *failed* against the current code: `_action_touches_path` split action
   ids on `_` and checked each chunk against the relevant-substation set,
   so any substation whose name contains an underscore (`VL_LOOP`, i.e.
   essentially all of them) never matched — UUID-prefixed coupling
   actions were being silently dropped from the `RandomOverflowRecommender`
   candidate set. Fixed with an anchored substring match. The test had
   been asserting the correct behavior all along; nothing ran it. This
   concretely validates the review's "green-by-omission" framing for the
   root `tests/` package.

3. **`run_analysis_step2` was over the function-LoC ceiling after the
   port (D1) and `analysis_mixin.py` was over the module ceiling after
   D3's imports.** Both were resolved by extraction (`_run_step2_discovery`
   / `_enrich_step2_results`; moving `augment_combined_actions_with_target_max_rho`
   into `analysis/combined_pairs.py`) rather than by raising a ceiling —
   consistent with the review's "ratchet down, never up" finding about
   the quality gate.

**D4. Relieve the two frontend hubs** *(6–10 days, stageable)* — 🟡 **STAGES 1–3 DONE (2026-07-08)**
Execute the already-scoped "Option 3" extraction: move
`handleSimulateUnsimulatedAction` / `handleSimulateSldEdit` into a
`useManualSimulation` hook; split `useDiagrams` into per-domain hooks behind the
existing `DiagramsState` facade; replace exploded props with cohesive state-object
props on `VisualizationPanel`/`ActionFeed` (the `SettingsModal` pattern the repo
already uses). Then *lower* `APP_TSX_MAX` to lock in the win.
> **Shipped (stage 1, D4a/D4b)**: `hooks/useManualSimulation.ts` extracts
> the two operator "simulate now" flows + the shared interactive SLD-edit
> state out of App.tsx behind a typed params object. App.tsx **2048 →
> 1795** lines, `APP_TSX_MAX` ratcheted **2100 → 1850**.
> **Shipped (stage 2, D4c — useDiagrams split)**: the two *decoupled*
> domains (no effect-ordering constraint) are now sub-hooks composed
> behind the byte-identical `DiagramsState` facade —
> `hooks/useOverflowLayout.ts` + `hooks/useActionDiagramCache.ts`;
> useDiagrams **1210 → 1145** lines.
> **Shipped (stage 3, D4d + follow-ups — props consolidation)**: every
> exploded prop cluster on the two hub-fed presentational components was
> collapsed into cohesive optional state-object props (the `SettingsModal`
> pattern), each unpacked at the top of the component body so the render
> tree is byte-for-byte unchanged:
> - `VisualizationPanel` (**~93 → 41** props): `sldEdit?: SldEditControls`
>   (the ~22 interactive SLD-edit props), `detach?: DetachControls` (6
>   detached-tabs props), `overflow?: OverflowControls` (8 layout-toggle +
>   action-pin props), `actionOverview?: ActionOverviewControls` (17
>   pin-interaction / selection / filter props).
> - `ActionFeed` (**~44 → 36** props): `additionalLines?: AdditionalLinesControls`
>   (4 picker props), `modelSelector?: ModelSelectorControls` (4 model-dropdown
>   props), `timing?: AnalysisTimingControls` (6 execution-time props).
>
> All behaviour-preserving (full Vitest suite green); guarded by
> `useManualSimulation` / `useOverflowLayout` / `useActionDiagramCache`
> hook tests + explicit `VisualizationPanel` / `ActionFeed` grouped-prop
> contract tests that pass each group object directly and assert both
> field-by-field forwarding **and** the "optional as a whole" omission
> case (detach / overflow / actionOverview + additionalLines /
> modelSelector / timing).
> **Remaining tail**: the deeply-coupled useDiagrams *core*
> (`handleActionSelect`, `zoomToElement`, the DOM-mutating voltage-filter
> effects — moving effect order that tsc can't verify) is deferred and
> tracked as **FU-1** in [`followups.md`](followups.md) (GitHub Issues are
> disabled on the fork).

**D5. One streaming + notification pipeline** *(3–4 days)* — ✅ **DONE (2026-07-08)**
`utils/ndjsonStream.ts` (buffer carry-over, trailing flush, uniform error
semantics, `AbortController`) replacing all five copies; a visible Cancel on
long operations; a typed notification store (severity, sticky, dismiss,
`aria-live`) replacing the dual error states and the `'SUCCESS'` string protocol.
Fixes T4 at the root; QW4 below is the 2-hour stopgap.
> **Shipped** in three slices — full write-up:
> [`notifications-and-streaming.md`](notifications-and-streaming.md). (D5.1)
> `parseNdjsonStream` replaced all five drifted reader loops (also
> closes **QW10**); (D5.2) the `notifications` store singleton +
> `NotificationHost` (severity / sticky / dismiss / `aria-live`, de-dupe)
> replaced `StatusToasts` and the `'SUCCESS'` prefix protocol, and folded
> the two error channels into one — subsuming the QW4 stopgap; (D5.3)
> the analysis run is cancellable end-to-end (AbortController through
> step 1 / step 2 fetch / stream read) with a visible Cancel, an abort
> surfacing as a cancellation notice rather than an error. **QW14**
> (highlight-pipeline pan/zoom churn) is independent and still open.

**D6. Finish the SVG element-adoption pipeline** *(2–4 days)* — 🟢 **CORE DONE (2026-07-09)**
Make `processSvg` return the already-parsed `SVGSVGElement` (adoptNode) instead of
re-serializing; route all ingestion paths through the element path that already
exists for patches; then a VL-count heuristic to auto-select bitmap pan/zoom mode
(or a discoverability nudge) once validated on operator hardware.
> **Shipped (element-adoption core)**: the boost is now element-based —
> `boostSvgToElement(rawSvg, viewBox, vlCount)` parses the pypowsybl SVG once
> and mutates the live `SVGSVGElement` in place (no `XMLSerializer` round-trip),
> and `processSvg` returns that element. `MemoizedSvgContainer` already had the
> `replaceChildren(element)` adoption path (proven by the svgPatch fast-path,
> which sets `n1Diagram.svg` to a cloned `SVGSVGElement`); the full-NAD load
> paths now ride the same rail, so a full load no longer pays the
> serialize + `innerHTML` re-parse the review flagged (`svgBoost.ts:621`).
> Safety: `boostSvgToElement` returns `null` on a parse error **or** a
> non-SVG-namespaced root, so `MemoizedSvgContainer` falls back to `innerHTML`
> (the HTML parser namespaces it) — the SLD-overlay string path is untouched.
> The old `boostSvgForLargeGrid(string) → string` stays as a thin wrapper for
> the serialized-SVG unit tests, returning the input unchanged on skip so no
> re-serialization leaks. Guarded by the element-adoption tests in
> `svgBoost.test.ts` + a `MemoizedSvgContainer` identity test (the mounted
> `<svg>` is the SAME instance `processSvg` returned — impossible via a
> re-parse). Full Vitest suite green.
> **Deferred (validation-gated)**: the VL-count auto-enable of the bitmap
> pan/zoom mode is intentionally left open — the review itself gates it on
> real operator-hardware validation of the bitmap engine (still OFF by
> default), so shipping an auto-enable blind would be premature.

**D7. Deployment trust & reproducibility** *(3–4 days)* — 🟡 **MOSTLY DONE (2026-07-08)**
Lockdown profile (env flag set in the Dockerfile) disabling/confining the
filesystem RPCs on non-local deployments; pin the Python closure (pip-compile
lockfile consumed by both CI and Docker so "mirrors CI" becomes true); version
tags + test-gated deploy + documented Space rollback.
> **Shipped** — full write-up: [`deployment-trust.md`](deployment-trust.md).
> The **lockdown profile** (`COSTUDY4GRID_LOCKDOWN`, set in the Dockerfile)
> disables the filesystem RPCs (config-file path, session save/list/load,
> pick-path) with a `403 {code: LOCKED_DOWN}` while keeping the read-only
> app config reachable so the SPA boots — this closes the still-open half
> of headline #5. The deploy is now **test-gated** (`workflow_run` on a
> successful **Tests** run, not a bare merge) and **tags each deploy on
> origin** (`space-deploy-*`) as the rollback pointer, with a
> `workflow_dispatch` rollback path. Guarded by `TestLockdownProfile`.
> **Remaining**: generate + wire the `requirements.lock` (must be resolved
> on the image's Python 3.10, so documented as a follow-up rather than
> shipped wrong).

**D8. Reproducible data & benchmark supply chain** *(3–5 days)* — 🟢 **MOSTLY DONE (2026-07-09)**
Fix the layout scale in `build_pipeline.py` and absorb the two missing
post-processing steps; write a provenance manifest into every bundle; wire the
hermetic slice of the pipeline suite into CI; bring the Codabench `score.py`
in-repo with a shared golden fixture locking cross-language parity; make the
session log replayable (the e2e harness already contains the replay machinery).
> **Shipped** — four of the five sub-tasks:
> - **Layout scale + post-processing**: `convert_pypsa_to_xiidm.py`'s
>   `step_write_metadata` no longer rescales to the forbidden `TARGET_WIDTH =
>   8_000` — it writes `grid_layout.json` in **raw Mercator metres** (span
>   ~1.4 M), matching `regenerate_grid_layout.py`'s default and the
>   `grid-layout-coordinate-scale.md` contract. `separate_voltage_levels.py`
>   is now **step 6** of `build_pipeline.py` (the VL-disk separation
>   post-process that was previously hand-run). The stale
>   `test_coordinate_spans_in_reasonable_range` that asserted the forbidden
>   `[5000, 20000]` range was corrected to the raw-metres regime.
> - **Provenance manifest**: `build_pipeline.write_provenance_manifest` writes
>   `provenance.json` (git commit, params, per-step list, sha256 of each bundle
>   artifact) into the bundle after the selected steps run — so a bundle traces
>   back to the code + inputs that made it. (Existing committed bundles get one
>   on their next rebuild.)
> - **Hermetic pipeline slice in CI**: the `scripts/pypsa_eur` +
>   `scripts/game_mode` suites now pass from a fresh clone (222→228 pass, 9
>   skip) — the data-dependent tests (raw OSM CSVs / uncommitted inputs) skip
>   gracefully via the `conftest osm_dir` + `regenerate_grid_layout` guards
>   instead of failing — and run in a new `test-data-pipeline` job in
>   `test.yml`.
> - **Codabench scorer parity**: the Python scorer now lives in-repo at
>   `scripts/game_mode/scoring_program/score.py` (a faithful twin of
>   `frontend/src/game/scoring.ts`, incl. `apply_reference` /
>   `score_study` / `score_session`), and `scripts/game_mode/scoring_golden.json`
>   is a **shared golden fixture** both `test_score.py` (Python) and
>   `scoring.test.ts` (frontend) assert against — locking cross-language
>   numerical parity in CI. `e2e_game_session.py` now defaults to the in-repo
>   scorer (no `~/Dev` path).
> **Deferred**: physically replaying the exported session log (so the public
> ranking scores re-driven numbers, not self-reported ones) needs a running
> backend + real grid to verify, so it is tracked as **FU-2** in
> [`followups.md`](followups.md) rather than half-built.

**D9. Docs as checked artifact** *(1–2 days)*
`scripts/check_docs_tree.py` in the existing gate (file-exists / absent-from-tree
/ line-count claims), warn-only first week; replace line-number anchors with
symbol anchors; slim the CLAUDE.md trees to what the checker can verify.

## Part V.5 — What's left (2026-07-09)

The shipped work closed the highest-leverage structural findings — the
monkey-patched recommender (T1 → **D1**), the drifted streaming/notification
copies (T4 → **D5**), shared-`Network` concurrency ownership (**D3**), the two
overloaded frontend hubs (**D4** stages 1–3), the SVG serialize/re-parse
round-trip (**D6**), and the two supply-chain gaps (**D7**/**D8**). What remains,
in rough priority order:

**Deep revisions still open or with a tail**

- **D9 — docs as a checked artifact** *(✅ landed 2026-07-09)*.
  `scripts/check_docs_tree.py` is now a gate step in
  `.github/workflows/code-quality.yml`: it fails when a `CLAUDE.md` reference
  points at a file that no longer exists (with generated-artifact and
  referenced-as-removed exemptions) or reintroduces a rotting `file.py:NNN` line
  anchor. All seven pre-existing line anchors were converted to symbol anchors
  and the two drifted path references fixed, so the tree is green. Unit coverage
  + a real-repo self-guard live in `scripts/test_check_docs_tree.py`; full
  write-up in [`code-quality-analysis.md`](code-quality-analysis.md) §23. This
  closes the recurring inventory-layer drift finding.
- **D2 tail** — the machine-check backbone + `{detail, code}` envelope shipped;
  still open: response models on the gzipped endpoints, generating `types.ts`
  from `openapi.snapshot.json`, and removing the blanket exception handler. See
  [`api-contract-machine-check.md`](api-contract-machine-check.md).
- **D7 tail** — the reproducible-Python-closure lockfile (a `pip-compile` output
  consumed by **both** CI and the Dockerfile, so "mirrors CI" becomes true), plus
  the Dockerfile hygiene items (drop the jupyter/`scripts/`/tests dead weight,
  real `PORT`, `HEALTHCHECK`, config-merge on upgrade — overlaps QW25). See
  [`deployment-trust.md`](deployment-trust.md).

**Tracked follow-ups** (in [`followups.md`](followups.md), since GitHub Issues are
disabled on the fork)

- **FU-1** — split the deeply-coupled `useDiagrams` core (D4's remaining tail:
  `handleActionSelect`, `zoomToElement`, the DOM-mutating voltage filter). Risky
  because it relocates effect-registration order that `tsc` cannot verify — needs
  behavioural coverage in place first.
- **FU-2** — physically replay the exported Game Mode session log (D8's remaining
  sub-task) so the public ranking scores re-driven numbers, not self-reported
  ones. Needs a running backend + real grid to verify, hence deferred.

**Open quick wins** (Part VI, minus the ✅ / subsumed rows)

- *Backend*: QW6 (generic error details + logged traceback — largely subsumed by
  the D2 envelope; audit for any surviving `str(e)`), QW8 (per-PR recommender pin
  + float in a canary job), QW11/QW12 (vectorise the 85 k-iteration
  `_diff_switches`; memoise the per-study N-state snapshot), QW13 (ship the patch
  payload in `simulate-and-variant-diagram`), QW17 (single `Overflow_Graph` path
  constant + automated `reset()`-completeness test), QW22 (watchdog on the legacy
  analysis poll loop, or delete the legacy `/api/run-analysis` slice).
- *Frontend perf/UX*: QW14 (highlight pipeline re-running on every pan/zoom settle
  — overlaps FU-1), QW15 (LRU-cap `actionDiagramCacheRef`), QW19 (theme into
  detached popups), QW20 (`useModalKeyboard`: Escape / focus-trap / `aria-modal`),
  QW21 (frontend `console.log` ceiling in the gate — D6 deliberately kept the boost
  logs, so start the ceiling at the current count and ratchet down).
- *Delivery/docs*: QW9 tail (the `Overflow_Graph/*.html` fixture decision, already
  reasoned), QW16 (batch the 20+ doc mismatches — folds into D9), QW23 (collapse to
  one CI system), QW24 (Game Mode mid-session retry / preset↔artifact test), QW25
  (Dockerfile hygiene — overlaps the D7 tail).

**Already subsumed by shipped deep revisions** (no separate work): QW1 (root
`tests/` rescued by D1), QW5 (variant `try/finally` folded into D3), QW10 (the one
NDJSON reader = D5.1), QW18 (single-flight 409 = the full D3 lock).

**Suggested next step**: **D9** — it is self-contained (≈1–2 days), closes the
recurring doc-drift finding, and makes the inventory trustworthy again; or **FU-1**
paired with its behavioural harness if continuing the frontend track.

## Part VI — Quick wins

Day-one (each ≤ ~2 h, near-zero risk):

| # | Fix | Where |
|---|---|---|
| QW1 | ✅ **DONE (2026-07-07, subsumed by D1)** — all 8 root `tests/` files rescued into `expert_backend/tests/` (the one filename collision resolved), so CI's `pytest.ini` testpaths now cover them | pytest.ini / CI |
| QW2 | ✅ **DONE (2026-07-07)** — `async def` → `def` on `run_analysis_step1` (unblocks the event loop; `TestEventLoopSafety` guard) | `main.py` |
| QW3 | ✅ **DONE (2026-07-08)** — CORS default `*` → loopback dev origins (`localhost`/`127.0.0.1` :5173/:4173); wildcard is explicit opt-in (`CORS_ALLOWED_ORIGINS="*"`) | `main.py` |
| QW4 | ✅ **DONE (2026-07-08)** — `useAnalysis.error` now surfaced through `StatusToasts` (`error \|\| analysis.error`, cleared on contingency-clear); the two `console.error`-only catches already carried `setError`, and the remaining SLD-preview catch got one. Guarded by a new App-integration test | `App.tsx` |
| QW5 | ✅ **DONE (2026-07-07, folded into D3)** — try/finally on the unguarded variant switch | `diagram_mixin.py` `_get_contingency_flows` |
| QW6 | Replace `detail=str(e)` with generic messages + server-side `logger.exception` | `main.py` |
| QW7 | ✅ **DONE (2026-07-08)** — `_safe_session_dir` rejects `..` / path separators / absolute names before any FS write, resolve()+relative_to() backstop (mirrors `/results/pdf`); applied to `save-session` + `load-session`. `TestSessionPathTraversal` guard | `main.py` |
| QW8 | Pin `expert_op4grid_recommender` per-PR; float it in a separate canary job | CI ×3 + Dockerfile |
| QW9 | 🟡 **PARTLY DONE (2026-07-08)** — deleted `inspect_action.py`, the dead `expert_backend/requirements.txt` stub, and the unused `react-zoom-pan-pinch` dep (+ doc/lockfile follow-through). Did **not** untrack the `Overflow_Graph/*.html`: it is a skip-guarded regression fixture (`test_overflow_html_dim_logic.py`) — untracking it would silently drop that CI coverage | repo root / frontend |

Week-one (½–1 day each):

| # | Fix | Where |
|---|---|---|
| QW10 | ✅ **DONE (2026-07-08, D5.1)** — extracted `utils/ndjsonStream.ts`, deleted the five copies | frontend |
| QW11 | Vectorize the reintroduced pandas loops (85 k-iteration `_diff_switches` first) | `diagram_mixin.py:876-892` |
| QW12 | Memoize the per-study N-state flow/asset snapshot for patch + SLD delta endpoints | `diagram_mixin.py` |
| QW13 | Ship the patch payload in `simulate-and-variant-diagram` when patchable (machinery exists in `action_patch.py`) — removes the 20–28 MB uncompressed stream event | backend + fallback wiring |
| QW14 | Fix highlight-pipeline deps so it stops re-running on every pan/zoom settle | `useDiagramHighlights.ts` |
| QW15 | LRU-cap `actionDiagramCacheRef` (2–3 entries); stop duplicate string retention | `useDiagrams.ts` |
| QW16 | Batch-fix the 20+ verified doc mismatches; truthful `.env.example`; symbol anchors; reframe PARITY_AUDIT as closed | docs |
| QW17 | Single `Overflow_Graph` path constant; automate the `reset()` completeness invariant (fresh-instance `__dict__` comparison test) + fix the two leaks | backend |
| QW18 | ✅ **DONE (2026-07-07, subsumed by D3)** — the full service-level lock + HTTP-409 study-mutation gate shipped as D3, superseding this coarse version | backend |
| QW19 | Theme propagation into detached popups; purge `'white'` literals | `useDetachedTabs` |
| QW20 | `useModalKeyboard` hook: Escape, initial focus, focus restore, `aria-modal` | modals |
| QW21 | Frontend `console.log` ceiling in the gate (start at 25, ratchet down) | `check_code_quality.py` |
| QW22 | Watchdog deadline on the legacy analysis poll loop; or delete the legacy `/api/run-analysis` slice outright | `analysis_runner.py` |
| QW23 | Collapse to one CI system (keep GH Actions; reduce CircleCI to an explicit mirror or delete) | `.circleci/` |
| QW24 | Game Mode: retry + finish-with-partial-results on mid-session failure; preset↔artifact consistency test | `game/`, tests |
| QW25 | Dockerfile: real `PORT`, `HEALTHCHECK`, drop jupyter/`uv`/`scripts/` dead weight; loud LFS-pointer validation | Dockerfile |

## Part VII — Limits of this review

- **Static analysis only.** No live backend was run; performance findings rest on
  the repo's own committed benchmarks/docs plus code reading, not fresh profiling.
- **Gap reviews (Parts IV.10–12) were not adversarially verified** — treat their
  specifics as one-reviewer claims, though they follow the same evidence rules.
- **Low-severity findings were not verified** (marked ▫).
- **Not covered**: git-history churn analysis, frontend bundle-size deep dive
  beyond the noted 704 KB chunk, the upstream `expert_op4grid_recommender`
  library itself, accessibility beyond code-level ARIA/keyboard checks, and any
  UX evaluation with real operators — the interaction findings are code-derived.
- Line numbers reference the reviewed commit (`c3f9c00`, 2026-07); they will
  drift — which is, fittingly, one of this review's own findings about the docs.
