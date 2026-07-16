# Deploying the Co-Study4Grid game to a HuggingFace Docker Space

This scaffolds a **single-container** deployment: one uvicorn process serves the
FastAPI backend *and* the built React frontend (same origin) on port **7860**,
with the sample grids bundled so Game Mode works out of the box.

It is sized for **one player per running Space** (the backend holds a single
active study — see the caveat at the bottom). For more players, each person
clicks **Duplicate this Space** to get an isolated instance.

## What was wired up

| File | Role |
|---|---|
| `Dockerfile` (repo root) | Multi-stage build: Vite SPA → Python runtime serving API + SPA + grids on `:7860`. |
| `.dockerignore` (repo root) | Trims the build context (no `node_modules`, `.git`, `Overflow_Graph`, …). |
| `deploy/huggingface/README.md` | The **Space README** (YAML frontmatter `sdk: docker`, `app_port: 7860`) + landing page. |
| `frontend/src/api.ts` | API base URL is now `VITE_API_BASE_URL ?? http://127.0.0.1:8000` → empty in the image = same-origin. |
| `frontend/src/game/gameBridge.ts` | `isGameMode()` also honors `VITE_GAME_MODE=1`, so the Space boots straight into the game. |
| `expert_backend/main.py` | Serves the built SPA at `/` when `COSTUDY4GRID_FRONTEND_DIST` exists; honors `$PORT`. |
| `.gitattributes` (repo root) | Tracks `*.zip` / `*.png` / `*.jpg` via Git LFS so binaries can be pushed to the HF Space (its git endpoint rejects non-LFS binaries). |
| `config.default.json` (repo root) | Seeded into the image; the backend copies it to `config.json` on first boot (recommender defaults). |

The Dockerfile sets `VITE_API_BASE_URL=""` and `VITE_GAME_MODE="1"` for the
frontend build. Local dev (`npm run dev`) and the Vitest suite are unaffected
(both variables are unset there, so the old `:8000` + `?game=1` behavior holds).

## Large binaries: Git LFS / Xet

HuggingFace's git endpoint rejects files **> 10 MiB** *and* non-LFS **binary**
files. The European grid (`pypsa_eur_eur220_225_380_400/network.xiidm`, ~22 MB)
therefore travels as a Git-LFS **`.zip`** (~2 MB), and the doc images travel as
LFS too. `.gitattributes` (repo root) declares this. The Dockerfile decompresses
the `.zip` back to `network.xiidm` at build time.

One-time, on your machine:

```bash
git lfs install
```

If your existing binaries were committed before `.gitattributes` existed,
migrate them once so they become LFS objects:

```bash
git add --renormalize . && git commit -m "migrate binaries to LFS"
```

## Deploy steps

1. **Create the Space** — on huggingface.co: *New → Space → Docker → Blank*.

2. **Push a single orphan snapshot to the Space.** The branch *history* still
   contains the > 10 MiB raw `.xiidm` from older commits, which HF would reject,
   so push **one squashed commit** of the current tree (binaries ride along via
   LFS — no need to delete them anymore):

   ```bash
   git lfs install                                                    # once
   git remote add space https://huggingface.co/spaces/<user>/<space>  # once

   git checkout --orphan hf-deploy
   cp deploy/huggingface/README.md README.md   # HF needs the frontmatter at root
   git add -A
   git commit -m "Deploy Co-Study4Grid game"
   git log --oneline hf-deploy                  # MUST be a single commit
   git -c protocol.version=0 push -f space hf-deploy:main
   git checkout -f claude/cool-bell-783agy
   git branch -D hf-deploy
   ```

   (`protocol.version=0` works around a `fatal: expected 'acknowledgments'`
   negotiation error some networks hit against HF.) HuggingFace reads the root
   `Dockerfile` + the README frontmatter and builds; the first build is long
   (heavy scientific wheels), later builds reuse layers.

3. **Play** — open the Space. It boots straight into the game shell (the
   `VITE_GAME_MODE=1` build flag); the default session is the three European
   reference studies (Medium difficulty). Build without that flag for the bare
   workspace.

## Persistent storage — the shared solution base survives restarts

Game Mode **capitalises every retained proposition** (signed with the player
name) into a shared solution base — `POST /api/game/log-solution` →
`expert_backend/services/game_solutions.py` — which powers the novelty bonus
and the end-of-session usage-frequency feedback. The mechanism mirrors the
manoeuvre IHM scenario base of `expert_op4grid_recommender`:

| Variable | Default | Role |
|---|---|---|
| `COSTUDY4GRID_DATA_DIR` | *(unset)* | Persistent **data root**. Set it to `/data` on a Space with persistent storage; the base lands in `/data/game_solutions`. |
| `COSTUDY4GRID_GAME_SOLUTIONS_DIR` | `$COSTUDY4GRID_DATA_DIR/game_solutions`, else repo-local `game_solutions/` | Explicit override of the base directory. |

To enable on the Space:

1. Space → **Settings → Persistent storage** → choose a volume (paid HF
   feature). It is mounted at **`/data`**.
2. Space → **Settings → Variables** → *New variable*
   **`COSTUDY4GRID_DATA_DIR` = `/data`**.

Without persistent storage the base still works (players get novelty /
frequency feedback within the life of the container) but **resets on every
Space restart**. The store is tiny (one small JSON per unique proposition),
so it will not crowd a volume.

## Automated redeploy on merge to `main` (GitHub Action)

`.github/workflows/deploy-huggingface.yml` runs the same orphan-snapshot push
automatically on every merge to `main` (and on manual `workflow_dispatch`). It
checks out the current tree with LFS, squashes it to one history-free commit,
and force-pushes it to the Space's `main`.

Opt in by setting, in the GitHub repo **Settings → Secrets and variables →
Actions**:

| Kind | Name | Value |
|---|---|---|
| Secret | `HF_TOKEN` | a HuggingFace **write** access token with access to the Space |
| Variable | `HF_SPACE` | the Space path, e.g. `your-user/co-study4grid-game` |
| Variable | `HF_USERNAME` | *(optional)* the token owner's HF username — only when the Space is under an **org** and so differs from the owner part of `HF_SPACE` |

The job is inert (it logs a notice and exits cleanly) until both `HF_TOKEN` and
`HF_SPACE` are set, so merging the workflow doesn't break anything before you
opt in. The push reuses LFS objects already on the Space, so repeat deploys only
upload what changed. If you want the deploy gated on green tests, change the
trigger to a `workflow_run` on the **Tests** workflow instead of `push`.

## Test the image locally first (recommended)

```bash
docker build -t costudy4grid-game .
docker run --rm -p 7860:7860 costudy4grid-game
# → open http://localhost:7860
```

The build has been validated end to end: the frontend bundle, the full
scientific stack (`pypowsybl`, `ExpertOp4Grid`, `grid2op`, `pandapower`,
`lightsim2grid`), backend import (42 routes), uvicorn on `:7860`, same-origin
SPA + `/api/models`, and the bundled fr225_400 grid loading via pypowsybl all
work. Image is ~370 MB.

Notes if you reproduce the build:

- The recommender is installed with `--no-deps` on purpose — its own dependency
  tree is self-conflicting (`numpy>=2` vs its transitive `pypowsybl2grid`'s
  `numpy==1.26.4`). The working runtime deps come from `pip install .` +
  `overrides.txt`. This mirrors CI.
- If `docker pull` of the base images hits Docker Hub's anonymous rate limit,
  either `docker login` or point the daemon at a pull-through mirror
  (`/etc/docker/daemon.json`: `{"registry-mirrors": ["https://mirror.gcr.io"]}`)
  and restart it.
- If a dependency lacks a prebuilt wheel on the build host, add `build-essential`
  to the `apt-get install` line in the runtime stage and rebuild.

## Caveat: one active study per instance

`network_service` and `recommender_service` are module-level singletons holding
one study's state, so a single Space is effectively **single-tenant**. Two
players hitting the same Space concurrently will clobber each other's network
load. For a public competition, prefer **Duplicate this Space** per player, or
refactor the backend to be session-scoped before a shared multi-player launch.
