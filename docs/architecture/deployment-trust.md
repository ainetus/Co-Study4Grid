# Deployment trust & reproducibility (D7, 2026-07)

Deep revision **D7** from
[`2026-07-full-repo-review.md`](2026-07-full-repo-review.md). Addresses
finding #5 ("the trust model no longer matches deployment") and the
deployment gaps in dimension 12: desktop-era filesystem RPCs shipping
unauthenticated on the public Space, and a continuous, ungated,
force-pushed deploy with no rollback primitive.

The security-critical half — the **lockdown profile** — shipped in full.
The reproducibility tail (a pinned Python closure) is a documented
follow-up because it must be resolved on the deployment's interpreter.

## The lockdown profile

The filesystem RPCs assume the caller is the local operator:

| Endpoint | Desktop intent | Risk on the public Space |
|---|---|---|
| `POST /api/config-file-path` | point the app at a custom config JSON | read any JSON on the container |
| `POST /api/save-session` | save a study to a chosen folder | write anywhere on the container |
| `GET /api/list-sessions` | browse saved studies | enumerate any directory |
| `POST /api/load-session` | reload a saved study | read any `session.json` |
| `GET /api/pick-path` | native OS file/dir picker | n/a headless (already a no-op) |

On the Space (anonymous visitors, Game Mode) none of these are needed —
studies come from the bundled presets. So when `COSTUDY4GRID_LOCKDOWN`
is truthy (`1`/`true`/`yes`/`on`), each is **disabled**:

```
403  {"detail": "This operation is disabled on the hosted deployment.",
      "code": "LOCKED_DOWN"}
```

- The flag is read once at import into `main._LOCKDOWN`; the guard
  `_reject_when_locked_down()` is the first statement of each locked
  handler. `LOCKED_DOWN` is a stable code in the D2 error envelope
  (`services/api_errors.py`, mapped from status 403) and the frontend
  `ApiErrorCode` union.
- The **read-only** app config (`GET /api/user-config`, `GET
  /api/config-file-path`) stays available so the SPA still boots and
  reads its bundled `config.json`.
- The `Dockerfile` sets `COSTUDY4GRID_LOCKDOWN=1`. Local dev and the test
  suite leave it unset, so behaviour is unchanged off the Space —
  `TestLockdownProfile` in `test_api_endpoints.py` exercises both states
  (403 + `LOCKED_DOWN` when on; normal 200 when off; read-only config
  reachable either way).

Disabling (rather than confining to a fixed directory) is the
conservative choice for a single-player ephemeral container; confinement
is a possible future refinement if the Space ever needs session
persistence.

## Test-gated deploy + rollback

`.github/workflows/deploy-huggingface.yml` previously fired on every push
to `main` and force-pushed a history-free snapshot to the Space — no test
gate, and (because the Space push is force-pushed + squashed) no rollback
trail. D7 tightens both:

- **Test gate**: the deploy now triggers on `workflow_run` of the
  **Tests** workflow completing *successfully* on `main`. A red build no
  longer ships. `workflow_dispatch` still runs unconditionally (the
  rollback path).
- **Rollback pointer**: every successful deploy tags the exact commit it
  shipped on origin as `space-deploy-<UTC-timestamp>-<shortsha>`. Since
  the Space's own history is squashed away, this origin tag is the only
  durable record of what shipped. Roll back by re-dispatching the
  workflow from a prior `space-deploy-*` tag (`workflow_dispatch` is not
  gated). Full steps in
  [`deploy/huggingface/SETUP.md`](../../deploy/huggingface/SETUP.md) →
  "Rolling back a bad deploy".

## Reproducible Python closure (tracked follow-up)

The image resolves the dependency tree at build time (version *floors* in
`pyproject.toml` plus the `expert_op4grid_recommender` floor), so a
zero-change rebuild can still pick up newer transitive releases — the
Dockerfile's "mirrors CI" claim isn't literally true. The fix is a
committed lockfile consumed by both the `Dockerfile` and the Tests
workflow:

```bash
# on Python 3.10 (the image base — NOT a dev 3.11, or it pins wrong wheels):
pip install pip-tools
pip-compile --output-file requirements.lock pyproject.toml
```

This is left as a follow-up rather than generated in-repo precisely
because it must be resolved on the deployment's 3.10 interpreter; a
lockfile pinned on the wrong Python is worse than none. See
[`SETUP.md`](../../deploy/huggingface/SETUP.md) → "Reproducible Python
closure".

## Remaining (tracked)

- Generate + wire the `requirements.lock` (above).
- Confinement (vs. outright disabling) of the session RPCs if the Space
  ever needs persistence.
- `HEALTHCHECK` in the Dockerfile and dropping the image's dead weight
  (dimension-12 items, independent of the trust model).
