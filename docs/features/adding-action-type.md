# Adding (or upgrading) a remedial-action type

This is the **integration checklist** for adding a new remedial-action
family to the recommender — or for auditing an existing one when you
touch save / reload / logging. It exists because an action type is a
*cross-cutting* feature: it threads through the `expert_op4grid_recommender`
library, the FastAPI backend, the React frontend, **and** three
easy-to-forget subsystems — **session save, interaction logging, session
reload**. Miss one and the type works live but silently loses data on a
reload (exactly the `redispatch_details` regression this doc was written
after — see the worked example at the bottom).

The current families and their canonical **tokens** are:

| Token | Family | Discovery method (lib) | Detail interface (frontend) |
|-------|--------|------------------------|------------------------------|
| `reco` | line reconnection | `verify_relevant_reconnections` | — |
| `disco` | line disconnection | `find_relevant_disconnections` | — |
| `open` | node split (open coupling) | `find_relevant_node_splitting` | — |
| `close` | node merge (close coupling) | `find_relevant_node_merging` | — |
| `pst` | phase-shifter tap | `find_relevant_pst_actions` | `PstDetail` |
| `ls` | load shedding | `find_relevant_load_shedding` | `LoadSheddingDetail` |
| `rc` | renewable curtailment | `find_relevant_renewable_curtailment` | `CurtailmentDetail` |
| `redispatch` | generator redispatch | `find_relevant_redispatch` | `RedispatchDetail` |

The token vocabulary is shared end-to-end: it is the same string used in
the overflow-graph filter chips, the `ALLOWED_ACTION_TYPES` recommender
restriction, and `classifyActionType` on the frontend. **Use one token,
spelled identically, everywhere.**

---

## 1. Library — `expert_op4grid_recommender`

| # | Where | What |
|---|-------|------|
| 1.1 | `config.py` | Add `MIN_<TYPE>` floor field. |
| 1.2 | `action_evaluation/discovery/_orchestrator.py` | Add `find_relevant_<type>(...)` discovery call. **Gate it** behind `_type_allowed("<token>")` so the `ALLOWED_ACTION_TYPES` restriction skips it. |
| 1.3 | `action_evaluation/discovery/*` | Implement `find_relevant_<type>`, populate `self.identified_<type>` (id → action) and any `self.scores_<type>`. |
| 1.4 | `_orchestrator.py` finalize block | Add an `add_prioritized_actions(..., n_action_max_per_type=config.MIN_<TYPE>)` call. (No-op when discovery was gated off — empty dict.) |
| 1.5 | `action_scores` dict | Add a `"<type>"` key with `scores` + `params` if the UI scores it. |

The **`ALLOWED_ACTION_TYPES` restriction** (lib): `config.ALLOWED_ACTION_TYPES`
is a list of tokens. Empty = all families. When non-empty the orchestrator's
`_type_allowed(token)` returns `True` only for listed tokens, so each family's
discovery call is skipped entirely. A new family MUST add its `_type_allowed`
gate (1.2) or it will ignore the restriction.

**Tests:** `tests/test_ActionDiscoverer.py` — discovery + scoring; the
`test_allowed_action_types_*` tests assert a restricted run discovers only
the allowed families and an empty list keeps all.

---

## 2. Backend — `expert_backend`

| # | Where | What |
|---|-------|------|
| 2.1 | `services/analysis/action_enrichment.py` | `compute_<type>_details(...)` → list of per-asset dicts (must match the frontend `*Detail` interface field-for-field). |
| 2.2 | `services/analysis_mixin.py` | Import + wrap the helper; call it in the enrichment pipeline so each action carries `<type>_details`. |
| 2.3 | `main.py` `ConfigRequest` | Add `min_<type>` and (if restricting) keep `allowed_action_types` as the single list field. |
| 2.4 | `services/recommender_service.py` `update_config` | Map `settings.min_<type>` → `config.MIN_<TYPE>`; map `settings.allowed_action_types` → `config.ALLOWED_ACTION_TYPES` (`list(... or [])`). |

**Tests:** `tests/test_recommender_service.py::test_update_config_*`
(mapping + defaults), `tests/test_api_endpoints.py::test_config_request_defaults`,
`tests/test_<type>.py` for enrichment.

---

## 3. Frontend — `frontend/src`

### 3.1 Types (`types.ts`)
- `<Type>Detail` interface (mirrors the backend dict from 2.1).
- `ActionDetail.<type>_details?: <Type>Detail[]` (live shape).
- `SavedActionEntry.<type>_details?: <Type>Detail[]` (persisted shape).
- `ConfigRequest` / `api.ts UserConfig` / `SessionResult.configuration`: add `min_<type>` (and `allowed_action_types` if new).
- `SettingsBackup` + `sessionUtils.SessionInput` + `useSession.SessionParams` / `RestoreContext`: add the camelCase setting field/setter.

### 3.2 Classification & filters (`utils/actionTypes.ts`)
- Add the token to `ACTION_TYPE_FILTER_TOKENS`.
- Add a label to `ACTION_TYPE_LABELS`.
- Teach `classifyActionType` to detect the family (by `id` prefix, score-type token, and/or description substring).

### 3.3 Rendering
- `components/ActionCard.tsx` (+ popover): render `<type>_details` (editor / headroom display).
- `utils/svg/*` / `svgUtils`: if the card supports zoom-to-asset, extract the VL id from `<type>_details` like the other families.

### 3.4 Settings plumbing (`hooks/useSettings.ts` + `components/modals/SettingsModal.tsx`)
- `useSettings`: state pair, `applyLoadedConfig` hydrate, `configToSave` persist, `buildConfigRequest` payload, `createCurrentBackup` + restore-on-cancel, return object + deps.
- `SettingsModal`: input wired to the setter.

### 3.5 ⚠️ The save / log / reload triad — the part everyone forgets
This is the regression surface. **All three must reference the new field.**

| Subsystem | File | What to add |
|-----------|------|-------------|
| **SAVE** | `utils/sessionUtils.ts` `buildSessionResult` | Copy `<type>_details: detail.<type>_details` into the `SavedActionEntry` map (right next to `pst_details` / `load_shedding_details`). Add config fields to `configuration`. |
| **RELOAD** | `hooks/useSession.ts` `handleRestoreSession` | Restore `<type>_details: entry.<type>_details` into the live `ActionDetail`. Restore config via `ctx.set<Field>(cfg.<field> ?? <default>)` **and** re-send it in the `api.updateConfig({...})` payload. |
| **LOG** | `App.tsx` `buildConfigInteractionDetails` | Add the config field so the `settings_applied` replay event carries it. (Individual chip/checkbox toggles do **not** emit per-toggle events — settings are captured wholesale at Apply time. Follow that pattern.) |

> **Why the triad bites:** the live UI and the restore path can both
> declare a field while `buildSessionResult` silently drops it on save.
> Everything looks fine until you reload — then the editor card renders
> empty. The restore path reading `entry.<type>_details` is *not* enough;
> the save path must write it.

### 3.6 App wiring (`App.tsx`)
Destructure the new setting from `useSettings`; thread it through
`saveParams` (camelCase, → `buildSessionResult`), `restoreContext`
(setter, → `useSession`), and `buildConfigInteractionDetails` (snake_case).

**Tests (Vitest):**
- `utils/actionTypes.test.ts` — `classifyActionType` recognises the token.
- `components/ActionCard.test.tsx` — renders `<type>_details`.
- `utils/sessionUtils.test.ts` — **round-trip guard**: `buildSessionResult`
  serializes `<type>_details` and the config fields.
- `hooks/useSession.test.ts` — restore reinstates `<type>_details` + config.
- `components/modals/SettingsModal.test.tsx` — the input/chip drives the setter.

---

## 4. Regression specs (`scripts/`) — easy to forget, CI-enforced

| Script | Field set | Add |
|--------|-----------|-----|
| `check_session_fidelity.py` | `SESSION_FIELDS` | `{"field": "<type>_details", "restore_token": "<type>_details", ...}` and any new config field. Greps `sessionUtils.ts` (save) + `useSession.ts` (restore) — so it *catches the triad bug*. |
| `check_standalone_parity.py` | `_CONFIG_FIELDS` | `"min_<type>"` (+ `"allowed_action_types"`). Backs the `config_loaded` / `settings_applied` replay spec. |

Run them after any change here:

```bash
python scripts/check_session_fidelity.py
python scripts/check_standalone_parity.py
```

No manual standalone mirror is needed — `npm run build:standalone`
regenerates `frontend/dist-standalone/standalone.html` from the React
source. (The parity grep WARNs on a stale bundle; that is non-blocking,
rebuild when convenient.)

---

## 5. The `ALLOWED_ACTION_TYPES` restriction (recap)

A recommender knob, not an action type, but it touches the same surface:

- **Lib:** `config.ALLOWED_ACTION_TYPES: list[str]` (empty = all). The
  orchestrator's `_type_allowed(token)` gates every family's discovery.
- **Backend:** `ConfigRequest.allowed_action_types` →
  `config.ALLOWED_ACTION_TYPES = list(... or [])`.
- **Frontend:** `allowedActionTypes: string[]` plumbed exactly like a
  setting (3.4) + the chip block in `SettingsModal` (`allowed-type-<token>`),
  persisted/restored through the triad (3.5) and the two specs (§4).

Because it reuses the **token vocabulary**, adding a new action family
auto-extends the restriction UI (the chip row maps over
`ACTION_TYPE_FILTER_TOKENS`). Just make sure the lib gate (1.2) exists.

---

## 6. Worked example — `redispatch` (what was actually wired)

- **Lib:** `MIN_REDISPATCH`, `find_relevant_redispatch`, gated by
  `_type_allowed("redispatch")`, prioritized with `MIN_REDISPATCH`.
- **Backend:** `compute_redispatch_details` (gen_name, voltage_level_id,
  delta_mw, target_mw, direction, current_mw, max_raise_mw, max_lower_mw);
  `ConfigRequest.min_redispatch` + `allowed_action_types`.
- **Frontend:** `RedispatchDetail`; `classifyActionType` → `redispatch`
  on `redispatch_` id / `redispatch` token / description; ActionCard
  editor with headroom; full settings plumbing.
- **Triad fix:** `buildSessionResult` was missing
  `redispatch_details` (load-shedding / curtailment / PST were present) →
  reloaded sessions lost the redispatch editor. Fixed by adding the one
  line, then locked with a `sessionUtils.test.ts` round-trip guard, a
  `useSession.test.ts` restore assertion, and `redispatch_details` /
  `allowed_action_types` entries in `check_session_fidelity.py`.

See also: [`curtailment-loadshedding-pst-actions.md`](curtailment-loadshedding-pst-actions.md)
(per-family algorithm details) and [`save-results.md`](save-results.md)
(session schema + regression-guard matrix).
