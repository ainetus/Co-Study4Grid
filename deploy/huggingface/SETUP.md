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

The Dockerfile sets `VITE_API_BASE_URL=""` and `VITE_GAME_MODE="1"` for the
frontend build. Local dev (`npm run dev`) and the Vitest suite are unaffected
(both variables are unset there, so the old `:8000` + `?game=1` behavior holds).

## Deploy steps

1. **Create the Space** — on huggingface.co: *New → Space → Docker → Blank*.
   Note its git remote, e.g. `https://huggingface.co/spaces/<user>/<space>`.

2. **The Space needs its README at the repo root with the frontmatter.** The
   project's root `README.md` is the GitHub readme and does *not* carry the
   `sdk: docker` / `app_port: 7860` block, so do **one** of these when pushing
   to the Space remote:
   - copy `deploy/huggingface/README.md` over the root `README.md` on the
     branch you push to the Space, **or**
   - prepend just the `--- … ---` frontmatter block from
     `deploy/huggingface/README.md` to the existing root `README.md`.

   (Keep the GitHub `README.md` unchanged on `main`.)

3. **Push the repo to the Space.**

   ```bash
   git remote add space https://huggingface.co/spaces/<user>/<space>
   git push space <your-branch>:main
   ```

   HuggingFace reads the root `Dockerfile` + the frontmatter and builds. First
   build is long (heavy scientific wheels); subsequent builds reuse layers.

4. **Play** — open the Space. It boots into the game shell. To force the bare
   tool instead, append `?game=0` is *not* supported once `VITE_GAME_MODE=1` is
   baked in; build without that flag for the plain workspace.

## Test the image locally first (recommended)

```bash
docker build -t costudy4grid-game .
docker run --rm -p 7860:7860 costudy4grid-game
# → open http://localhost:7860
```

If a dependency lacks a prebuilt wheel on the build host, add `build-essential`
to the `apt-get install` line in the runtime stage and rebuild.

## Caveat: one active study per instance

`network_service` and `recommender_service` are module-level singletons holding
one study's state, so a single Space is effectively **single-tenant**. Two
players hitting the same Space concurrently will clobber each other's network
load. For a public competition, prefer **Duplicate this Space** per player, or
refactor the backend to be session-scoped before a shared multi-player launch.
