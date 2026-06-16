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
# fastapi, …). The recommender ships separately (matches the CI pin), then
# overrides.txt forces the pinned transitive versions last.
COPY --chown=user pyproject.toml README.md overrides.txt ./
COPY --chown=user expert_backend/ ./expert_backend/
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir . \
    && pip install --no-cache-dir "expert_op4grid_recommender==0.2.3.post1" \
    && pip install --no-cache-dir -r overrides.txt

# --- Application code, bundled grids, built SPA ----------------------------
COPY --chown=user data/ ./data/
COPY --chown=user scripts/ ./scripts/
COPY --chown=user --from=frontend /build/dist ./frontend/dist

# The backend serves this directory at "/" (same origin as the API).
ENV COSTUDY4GRID_FRONTEND_DIST=/home/user/app/frontend/dist \
    PORT=7860

EXPOSE 7860
CMD ["uvicorn", "expert_backend.main:app", "--host", "0.0.0.0", "--port", "7860"]
