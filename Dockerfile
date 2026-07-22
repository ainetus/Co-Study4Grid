# Co-Study4Grid — single-container image for a HuggingFace Docker Space.
#
# The frontend (built same-origin) and the FastAPI backend are served by one
# uvicorn process on port 7860. Bundled sample grids (data/) let the Game Mode
# presets resolve out of the box. See deploy/huggingface/ for the Space README
# and step-by-step setup.
#
# Build context = repo root:  docker build -t costudy4grid .

# ---------------------------------------------------------------------------
# Stage 1 — build the React SPA (same-origin API, game mode on by default).
# ---------------------------------------------------------------------------
FROM node:20-bookworm-slim AS frontend

WORKDIR /build
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

COPY frontend/ ./
# Empty base URL → relative `/api/...` requests, served by the backend below.
# VITE_GAME_MODE=1 → the Space boots straight into the timed game shell.
ENV VITE_API_BASE_URL="" \
    VITE_GAME_MODE="1"
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 2 — Python runtime serving API + built SPA + bundled grids.
# ---------------------------------------------------------------------------
FROM python:3.11-slim-bookworm AS runtime

# graphviz `dot`: overflow-graph rendering. libgomp1: OpenMP runtime that the
# scientific wheels (numpy / scipy / lightsim2grid) link against.
RUN apt-get update && apt-get install -y --no-install-recommends \
        graphviz \
        libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# HuggingFace Spaces run the container as uid 1000 ("user"). Keep the app under
# its home so runtime writes (Overflow_Graph/, config.json, session folders)
# land on a writable path.
RUN useradd -m -u 1000 user
USER user
ENV HOME=/home/user \
    PATH=/home/user/.local/bin:$PATH \
    PYTHONUNBUFFERED=1
WORKDIR /home/user/app

# --- Python dependencies (own layer for caching) ---------------------------
# `pip install .` pulls the declared runtime deps (ExpertOp4Grid, pypowsybl,
# fastapi, …). The recommender ships with `--no-deps` — mirroring CI — because
# its own dependency tree is self-conflicting (it wants numpy>=2 while its
# transitive `pypowsybl2grid` pins numpy==1.26.4); the working runtime deps
# come from `pip install .`. It is pinned via recommender-pin.txt (QW8) — the
# SAME file CI installs — so a zero-change rebuild can't drift to a new
# release. overrides.txt forces the pinned transitive versions last.
COPY --chown=user pyproject.toml README.md overrides.txt recommender-pin.txt ./
COPY --chown=user expert_backend/ ./expert_backend/
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir . \
    && pip install --no-cache-dir --no-deps -r recommender-pin.txt \
    && pip install --no-cache-dir -r overrides.txt

# --- Application code, bundled grids, built SPA ----------------------------
# Seed the default user config (recommender params + the fr225_400 paths);
# the backend copies it to config.json on first boot.
COPY --chown=user config.default.json ./
COPY --chown=user data/ ./data/
COPY --chown=user scripts/ ./scripts/
# The European grid ships compressed (its raw .xiidm exceeds HuggingFace's
# 10 MiB git file limit, so it travels as a Git-LFS .zip). Validate + decompress
# it so pypowsybl can load network.xiidm directly — the "Medium" game difficulty.
# The helper FAILS LOUDLY on an un-smudged LFS pointer or a corrupt archive
# (QW25) instead of silently baking a broken grid into the image.
RUN python scripts/extract_network_zip.py data/pypsa_eur_eur220_225_380_400/network.xiidm.zip
# The 4 France THT grids (Game Mode "France THT" tiers) ship each ~8.8 MB
# network.xiidm compressed + text-encoded as network.xiidm.gz.b64 (gzip+base64) —
# small, and pushes without Git-LFS. Decode them all back to network.xiidm.
RUN python scripts/game_mode/decode_tht_grids.py
COPY --chown=user --from=frontend /build/dist ./frontend/dist
# The overflow-viewer overlay (services/overflow_overlay.py) inlines this
# shared pin-glyph source module at request time, so it must exist at the
# path it expects even though the rest of frontend/src is not shipped.
COPY --chown=user frontend/src/utils/svg/pinGlyph.js ./frontend/src/utils/svg/pinGlyph.js

# The backend serves this directory at "/" (same origin as the API).
#
# EXPERT_OP4GRID_REASSESSMENT_PARALLEL=0 forces the per-action reassessment to
# run SERIALLY. The Space runs on 2 vCPUs; the recommender's container-aware
# detection already picks serial there, but pinning it makes the guarantee
# explicit and independent of the host's cgroup exposure — parallel worker
# threads each clone a full pypowsybl network, so on 2 vCPUs they over-subscribe
# the CPU and are far SLOWER than serial (the 47 s → ~15 s assessment win).
ENV COSTUDY4GRID_FRONTEND_DIST=/home/user/app/frontend/dist \
    EXPERT_OP4GRID_REASSESSMENT_PARALLEL=0 \
    PORT=7860 \
    COSTUDY4GRID_LOCKDOWN=1
# COSTUDY4GRID_LOCKDOWN=1 (D7): this is a public, anonymous-visitor
# deployment, so the desktop-era filesystem RPCs (custom config path,
# session save/list/load, native file picker) are disabled — see the
# lockdown profile in expert_backend/main.py.

EXPOSE 7860

# Liveness probe (QW25): the read-only app-config endpoint stays available even
# under lockdown (D7), so it's a safe heartbeat. The long start-period covers
# the slow first network load. Uses $PORT so it tracks a non-default port.
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
    CMD python -c "import os,sys,urllib.request; urllib.request.urlopen('http://127.0.0.1:%s/api/user-config' % os.environ.get('PORT','7860')).read(); sys.exit(0)"

# Shell form so ${PORT} expands (QW25: PORT was decorative before); `exec`
# keeps uvicorn as PID 1 so it receives SIGTERM directly for clean shutdown.
CMD ["sh", "-c", "exec uvicorn expert_backend.main:app --host 0.0.0.0 --port ${PORT:-7860}"]
