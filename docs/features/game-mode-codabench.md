# Game Mode + Codabench benchmark

Game Mode is a timed, scored wrapper around the Co-Study4Grid study workspace.
A *session* is an ordered list of *studies* (a grid state + an N-1 contingency
each). The player must remediate every contingency with **at most 3 remedial
actions** before a per-study **timer** expires, then advances to the next
study. The session exports a `game_session.json` that a
[Codabench](https://www.codabench.org/) competition scores and ranks.

The Codabench bundle lives in a sibling repo:
`~/Dev/codabench/competitions/costudy4grid_game/` (branch
`feature/costudy4grid-game-mode`).

## How to play

Launch the frontend with `?game=1` (e.g. `http://localhost:5173/?game=1`):

1. **Config screen** — name the session, enter your **player name** (required —
   it signs the solutions you retain in the shared solution base, see below),
   set the per-study timer (min/sec) and the action cap (≤ 3), and build the
   ordered study list. Pre-filled with the
   3-study warm-up; add more from the **preset contingency** dropdown (the
   fr225_400 set from `data/pypsa_eur_fr225_400/n1_overload_contingencies.json`)
   or add custom studies (network + action file + contingency id).
2. **Play** — a fixed HUD shows the study, a live countdown, the action
   counter (`X/3`), and the current best resulting loading. The workspace
   underneath is the unchanged Co-Study4Grid tool. **Star** the actions you
   commit to (the star is capped at the configured max). Click **Next study →**
   (or let the timer expire) to advance. If your retained proposition turns
   out to be **new** in the shared base, a 🌟 toast tells you right away and
   you earn bonus points.
3. **Results** — per-study table + final score (+ novelty bonus shown on
   top), the usage frequency of your retained actions across all players'
   stored solutions, with **⬇ JSON (Codabench)** and **⬇ CSV** exports.

## Architecture

The whole feature is additive and inert unless `?game=1` is set.

| File | Role |
|---|---|
| `frontend/src/game/GameShell.tsx` | Entry point (mounted by `main.tsx`); state machine config → playing → results, hosts `<App/>` below a fixed HUD |
| `frontend/src/game/useGameSession.ts` | Session state machine: load study, timer countdown, commit + advance, build log |
| `frontend/src/game/gameBridge.ts` | Decoupling singleton (mirrors `interactionLogger`): App registers a study loader + publishes the physical snapshot; the shell drives loads + reads results + enforces the action cap |
| `frontend/src/game/GameConfigScreen.tsx` | Session/study configuration UI (asks the required player name) |
| `frontend/src/game/GameHud.tsx` | Timer / action-counter / Next-study HUD bar |
| `frontend/src/game/GameResults.tsx` | Results table + score preview (+ novelty bonus + usage-frequency feedback) + JSON/CSV export |
| `frontend/src/game/GameNoveltyToast.tsx` | Transient 🌟 banner when a retained proposition is new in the shared base |
| `frontend/src/game/scoring.ts` | Shared scoring model (twin of the Python scorer) |
| `frontend/src/game/gameLog.ts` | `GameSessionLog` assembly + CSV + download helpers |
| `frontend/src/game/solutionLog.ts` | Solution capitalisation client: lever/signature computation + log payload + feedback mapping |
| `frontend/src/game/presets.ts` | Curated **solvable** fr225_400 contingencies |
| `frontend/src/game/types.ts` | Type contract for the whole module |

### App integration (3 touch points, all guarded by `gameBridge.isGameMode()`)

- `loadGameStudy(study)` — swaps network + action catalogue and arms the
  contingency, registered with `gameBridge` so the shell can drive it.
- A publish effect pushes `{ baselineMaxRho, chosenActions }` (derived from
  `result` + `selectedActionIds` + `n1Diagram.lines_overloaded_rho`) to the
  shell on every change.
- `wrappedActionFavorite` refuses to star a *new* action past the cap.

## Scoring

Per study (0–100): `60·R + 25·R·A + 15·R·T` where **R** is the remediation
fraction (1.0 = worst line back under 100 %), **A** rewards using fewer of the
allowed actions, **T** rewards speed. Session score = mean across studies.
`frontend/src/game/scoring.ts` and the Codabench `scoring_program/score.py`
implement the **identical** formula and are locked by unit tests on both sides.

The **novelty bonus** (below) is displayed *on top of* this score and lives in
separate fields — the twin-locked formula never absorbs it, so Codabench
rankings are unaffected.

## Solution capitalisation (shared solution base)

Every proposition a player retains at a study commit is logged into a
**shared solution base** via `POST /api/game/log-solution`, mirroring the
manoeuvre IHM scenario base of `expert_op4grid_recommender` (JSON records
under a persistent root, exact-duplicate dedup, the player name as author).

- **Store** — `expert_backend/services/game_solutions.py`. One record per
  unique proposition per `(network, contingency)` context under
  `<root>/game_solutions/<context_key>/<sha1>.json`; a repeat retention
  appends `{player, session, timestamp, solved, final_max_rho, …}` to the
  record's `retentions`. Root resolution (manoeuvre-style cascade):
  `COSTUDY4GRID_GAME_SOLUTIONS_DIR` env → `COSTUDY4GRID_DATA_DIR/game_solutions`
  → repo-local `game_solutions/` (dev fallback, gitignored). On a
  HuggingFace Space, enable **Settings → Persistent storage** and set
  `COSTUDY4GRID_DATA_DIR=/data` so the base survives restarts and is shared
  by every player of the Space.
- **Signatures** — novelty is judged on magnitude-free *unitary signatures*
  computed client-side by `frontend/src/game/solutionLog.ts`
  (`buildActionLevers`): injections contribute **levers**
  (`redispatch:<gen>`, `ls:<load>`, `rc:<gen>`, `pst:<pst>`) with **no
  MW/tap value** — retuning a known lever is not novel, *mobilising a new
  lever is*; switch-operating actions decompose into `switch:<id>=<state>`
  levers — that covers manual SLD maneuvers (whose generated ids are not
  stable) *and* catalogue coupling actions whose payload exposes switches,
  so the same physical maneuver signs identically wherever it came from;
  injection retunes without detail arrays sign `load_p:<load>` /
  `gen_p:<gen>` (per element — an element already described by a detail
  array is not double-signed). Actions exposing **no lever** (typically
  catalogue line disconnections / reconnections) keep their stable
  `action:<action_id>` identity. The proposition signature is the sorted
  union of the actions' unitary signatures (order-independent).
- **Novelty & bonus** — a proposition mobilising ≥ 1 never-seen unitary
  signature is *completely new*: **+10 bonus pts** and the in-play
  `GameNoveltyToast` announces it (with the new levers). A new combination
  of already-known unitary actions earns **+5**. Anything else is a
  duplicate: no bonus, but the response carries each retained action's
  **usage frequency** (`count / total` past retentions in the context),
  which the results screen shows as end-of-session feedback.
- **Flow** — `useGameSession` fires the log at every study commit,
  fire-and-forget (a failed log never blocks or breaks the game — the study
  simply carries no `solutionFeedback`). The session log is *derived* from
  the results state, so feedback landing after the last commit still reaches
  the exported JSON. The export stays `schemaVersion: "1.0"` — the new
  per-study `solutionFeedback` field and the CSV `novelty_bonus` column are
  additive and ignored by the Codabench scorer.

## Local end-to-end check

`scripts/game_mode/e2e_game_session.py` drives the real FastAPI backend
(`/api/config` → `/api/run-analysis-step1` → `/api/run-analysis-step2`) for the
preset studies, plays a greedy operator (lowest-rho actions, ≤ cap), writes a
`game_session.json`, and scores it with the Codabench scorer:

```bash
python3 scripts/game_mode/e2e_game_session.py --max-studies 3
# → writes test-results/e2e_*.json and prints the Codabench score
```

This requires pypowsybl + expert_op4grid_recommender in the environment (the
same deps the backend needs). The preset contingencies in `presets.ts` are all
verified `can_proceed=True` by this script, so the game stays winnable.

## Tests

- Frontend: `frontend/src/game/scoring.test.ts` (Vitest) — scoring + log/CSV.
- Codabench: `scoring_program/test_score.py` (pytest) — scoring + reference
  integrity clamps. Run the scorer locally with
  `competitions/costudy4grid_game/local_harness/run_local.py`.
