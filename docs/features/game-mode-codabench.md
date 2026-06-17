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

1. **Config screen** — name the session, set the per-study timer (min/sec) and
   the action cap (≤ 3), and build the ordered study list. Pre-filled with the
   3-study warm-up; add more from the **preset contingency** dropdown (the
   fr225_400 set from `data/pypsa_eur_fr225_400/n1_overload_contingencies.json`)
   or add custom studies (network + action file + contingency id).
2. **Play** — a fixed HUD shows the study, a live countdown, the action
   counter (`X/3`), and the current best resulting loading. The workspace
   underneath is the unchanged Co-Study4Grid tool. **Star** the actions you
   commit to (the star is capped at the configured max). Click **Next study →**
   (or let the timer expire) to advance.
3. **Results** — per-study table + final score, with **⬇ JSON (Codabench)** and
   **⬇ CSV** exports.

## Architecture

The whole feature is additive and inert unless `?game=1` is set.

| File | Role |
|---|---|
| `frontend/src/game/GameShell.tsx` | Entry point (mounted by `main.tsx`); state machine config → playing → results, hosts `<App/>` below a fixed HUD |
| `frontend/src/game/useGameSession.ts` | Session state machine: load study, timer countdown, commit + advance, build log |
| `frontend/src/game/gameBridge.ts` | Decoupling singleton (mirrors `interactionLogger`): App registers a study loader + publishes the physical snapshot; the shell drives loads + reads results + enforces the action cap |
| `frontend/src/game/GameConfigScreen.tsx` | Session/study configuration UI |
| `frontend/src/game/GameHud.tsx` | Timer / action-counter / Next-study HUD bar |
| `frontend/src/game/GameResults.tsx` | Results table + score preview + JSON/CSV export |
| `frontend/src/game/scoring.ts` | Shared scoring model (twin of the Python scorer) |
| `frontend/src/game/gameLog.ts` | `GameSessionLog` assembly + CSV + download helpers |
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
