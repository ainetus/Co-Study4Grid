---
title: Co-Study4Grid Game
emoji: ⚡
colorFrom: blue
colorTo: indigo
sdk: docker
app_port: 7860
pinned: false
license: mpl-2.0
---

# Co-Study4Grid — Game Mode

A timed, scored power-grid contingency game built on
[Co-Study4Grid](https://github.com/marota/Co-Study4Grid). Each **study** is a
grid state with an N-1 line outage that pushes a line past 100 % loading. Your
job: bring every monitored line back under 100 % with **at most 3 remedial
actions** before the per-study timer runs out, then move to the next study.

This Space boots straight into the game (the `VITE_GAME_MODE=1` build flag), so
there is nothing to configure — pick or tweak the study list and play.

## How to play

1. **Configure** — name the session, set the per-study timer and the action cap
   (≤ 3), and review the ordered study list. It is pre-filled with a warm-up
   tour of the bundled PyPSA-EUR France 225/400 kV grid; add more presets or
   custom studies as you like.
2. **Play** — a HUD shows the current study, a live countdown, your action
   counter (`X/3`) and the best resulting line loading. Explore the network,
   simulate actions, and **star** the ones you commit to. Click **Next study →**
   (or let the timer expire) to advance.
3. **Results** — a per-study table plus your final score, with **⬇ JSON
   (Codabench)** and **⬇ CSV** exports. Submit the JSON to the matching
   [Codabench](https://www.codabench.org/) competition to be ranked.

## Scoring

Per study (0–100): `60·R + 25·R·A + 15·R·T` — **R** rewards remediation (worst
line back under 100 %), **A** rewards using fewer actions, **T** rewards speed.
Session score is the mean across studies. The in-browser scorer is a twin of the
Codabench Python scorer, locked by unit tests on both sides.

## One player per instance

The backend keeps a **single active study** in memory (module-level
singletons), so one running Space serves **one player at a time**. For multiple
players, use the **Duplicate this Space** button (top-right) — each duplicate is
an isolated instance. A genuinely concurrent multi-player deployment would need
the backend refactored to be session-scoped; see the repo's deployment notes.

## Resources

Heavy scientific stack (pypowsybl + a JVM-free native lib, grid2op, pandapower,
lightsim2grid). The free CPU tier (2 vCPU / 16 GB) handles the bundled small and
fr225_400 grids; first load after a cold start is slow while the container
boots. Storage is ephemeral — game results are downloaded client-side, so
nothing important lives on the Space disk.

One exception worth persisting: the **shared solution base** (every retained
proposition, signed with the player name, that feeds the novelty bonus and the
usage-frequency feedback). Enable **Settings → Persistent storage** and set the
`COSTUDY4GRID_DATA_DIR=/data` variable so it survives restarts — without it the
base still works but resets on every reboot. See `deploy/huggingface/SETUP.md`.
