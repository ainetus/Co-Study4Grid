# Machine-checking the API contract (D2, 2026-07)

Deep revision **D2** from
[`2026-07-full-repo-review.md`](2026-07-full-repo-review.md). Addresses
finding #2 ("nothing machine-checks the API contract") and cross-cutting
theme **T2** (hand-maintained mirrors that drift — here, `types.ts`
mirroring undeclared response shapes and five client-visible error
shapes).

This document tracks what landed and what remains, so the incremental
rollout stays honest.

## Landed

### 1. Unified error envelope — `{ detail, code }`

`expert_backend/services/api_errors.py` installs three FastAPI
exception handlers (once, via `install_error_handlers(app)`):

- **Every `HTTPException`** renders as `{"detail": <human string>,
  "code": <STABLE_SLUG>}`. `detail` is unchanged (existing clients and
  tests that read `response.json()["detail"]` keep working); `code` is
  additive. Callers that need the discriminator raise
  `AppHTTPException(status, detail, code)`; everything else gets a code
  derived from the status (`400→BAD_REQUEST`, `404→NOT_FOUND`,
  `409→STUDY_BUSY`, `422→VALIDATION`, `500→INTERNAL`).
- **Request-validation errors (422)** keep their rich `detail` list and
  gain `code="VALIDATION"`, so the frontend extractor is universal.
- **Any uncaught exception** becomes a clean `500` with a GENERIC detail
  (`"Internal server error."`) — no more `detail=str(e)` leaking
  absolute server paths (the QW6 / security-review finding) — plus a
  server-side `logger.exception`.

The one error the frontend branches on — the post-reload
`action-variant-diagram` failure that triggers a live re-simulation —
now carries an explicit `code="ACTION_RESULT_UNAVAILABLE"` instead of
being an indistinguishable `400` (the review's explicit requirement:
"preserve the 400-triggers-resimulate dependency via an explicit error
code").

**Frontend side**: `frontend/src/utils/apiError.ts` is the single
reader — `extractApiError` / `apiErrorMessage` / `hasErrorCode` — that
replaced ~10 scattered `err?.response?.data?.detail || '…'` call sites
across `App.tsx`, `useSession`, `useSldOverlay`, `ActionFeed`,
`CombinedActionsModal`. It copes with the axios shape, the `{detail,
code}` body, FastAPI's 422 `detail` array, and a plain `Error`.

### 2. OpenAPI contract snapshot + CI diff

`scripts/check_openapi_contract.py` renders `app.openapi()` to a
normalized, key-sorted document and diffs it against the committed
`expert_backend/openapi.snapshot.json`. `test_openapi_contract.py` runs
the same check inside the pytest suite (so it gates in CI alongside the
backend tests). A deliberate endpoint / request-model / response-model /
status change fails the check until the author regenerates the snapshot:

```bash
python scripts/check_openapi_contract.py --write
```

The diff is the reviewable record of every contract change — the thing
that was previously invisible until `types.ts` silently diverged.

### 3. Pydantic response models (seed)

Response models are attached to the small, native-Python-dict control
endpoints where the full field set is stable and carries no NumPy, so
`response_model` serialization can neither drop a field nor reject a
coercion: `POST /api/recommender-model`
(`RecommenderModelResponse`), `POST /api/restore-analysis-context`
(`RestoreAnalysisContextResponse`), `POST /api/save-session`
(`SaveSessionResponse`). These now appear in the OpenAPI snapshot with a
concrete response schema.

## Remaining (tracked follow-ups)

- **Response models on the diagram / analysis / SLD endpoints.** These
  return bespoke gzipped `Response` objects (`_maybe_gzip_json`), for
  which `response_model` does not run at runtime — and their payloads
  carry NumPy that must be `sanitize_for_json`-coerced before a
  `response_model` could validate them. Rolling models onto them
  requires, per endpoint: (a) a Pydantic model matching the exact field
  set, (b) a field-completeness test proving no field is dropped, (c)
  routing the coerced dict through `response_model` while keeping the
  gzip fast path. Do it endpoint-by-endpoint behind that test.
- **Generate `types.ts` from the snapshot.** The committed
  `openapi.snapshot.json` is the input; wire `openapi-typescript` (or
  similar) to emit `src/types.generated.ts` and migrate `types.ts`
  consumers onto it incrementally, retiring the hand-mirror a slice at a
  time. Until then the snapshot check at least makes any drift *visible*.
- **Delete the ~26 blanket `except Exception → HTTP 400` handlers.** The
  envelope unifies the *shape* today, but genuine bugs still surface as
  `400` (with `str(e)`) from the per-endpoint handlers rather than as a
  logged `500`. Converting each to raise a typed domain error (mapped by
  the middleware to the right status) is a coordinated backend + test +
  frontend change — several endpoint tests currently assert `400` with
  the exception string.

## Tests

- `test_api_errors.py` — the envelope module directly: `AppHTTPException`
  + `_code_for` (explicit + status-default + unmapped), the three
  handlers, the **security-critical** "uncaught exception → generic 500,
  no `str(exc)` leak", handler wiring on the app, the
  `ACTION_RESULT_UNAVAILABLE` discriminator reaching the client, and a
  response-validation-failure → generic-500 integration proof.
- `test_openapi_contract.py` — snapshot-matches-live + the error
  envelope on 422 / 404.
- `test_api_endpoints.py::TestStudyMutationBusyGate` — the `409` /
  `STUDY_BUSY` envelope; `::TestResponseModels` — the D2 response models
  serialize the exact field set (no drop / add).
- `frontend/src/utils/apiError.test.ts` — the extractor across every
  input shape (envelope, discriminators, 422 array, fallback chain).
