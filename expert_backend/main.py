# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0
# This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

import gzip
from collections.abc import Iterator
from typing import Any
import json as json_module
import logging
import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path

from fastapi import Body, FastAPI, HTTPException, Query, Request
from fastapi.encoders import jsonable_encoder
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from expert_backend.services.api_errors import (
    AppHTTPException,
    CODE_ACTION_RESULT_UNAVAILABLE,
    CODE_LOCKED_DOWN,
    CODE_STUDY_BUSY,
    install_error_handlers,
)
from expert_backend.services.diagram_mixin import ActionResultUnavailableError
from expert_backend.services.network_service import network_service
from expert_backend.services.overflow_overlay import inject_overlay
from expert_backend.services.paths import OVERFLOW_DIR
from expert_backend.services.recommender_service import recommender_service

# Importing `expert_backend.recommenders` registers ExpertRecommender,
# RandomRecommender and RandomOverflowRecommender at import time (pure
# registration — the service integration is explicit composition on
# RecommenderService, not an import side-effect). The registry is
# queried by `run_analysis_step2` (model dispatch) and by the
# `/api/models` endpoint below.
from expert_backend.recommenders import list_models as _list_recommender_models

logger = logging.getLogger(__name__)

app = FastAPI()

# Unified error contract (D2): every HTTPException renders as
# {detail, code}; uncaught exceptions → clean 500 (no path leak) +
# server-side logger.exception. See services/api_errors.py.
install_error_handlers(app)


# --- Per-endpoint JSON gzip helper ---
_GZIP_MIN_BYTES = 10_000
_GZIP_LEVEL = 5

# Study-mutation busy-gate detail (HTTP 409). Study-level operations
# (config load + the analysis pipeline) mutate the shared singleton
# state, so at most one runs at a time; a second is rejected rather
# than queued behind seconds of work (D3, 2026-07).
_STUDY_BUSY_DETAIL = (
    "Another study operation (configuration load or analysis) is already "
    "in progress. Retry when it completes."
)


def _maybe_gzip_svg_text(diagram: dict, request: Request) -> Response:
    diagram = dict(diagram)
    svg = diagram.pop("svg", "")
    meta_line = json_module.dumps(
        jsonable_encoder(diagram), separators=(",", ":"), ensure_ascii=False
    )
    body = (meta_line + "\n" + svg).encode("utf-8")
    accept = request.headers.get("accept-encoding", "")
    if len(body) < _GZIP_MIN_BYTES or "gzip" not in accept.lower():
        return Response(
            content=body,
            media_type="text/plain; charset=utf-8",
            headers={"Vary": "Accept-Encoding"},
        )
    compressed = gzip.compress(body, compresslevel=_GZIP_LEVEL)
    return Response(
        content=compressed,
        media_type="text/plain; charset=utf-8",
        headers={
            "Content-Encoding": "gzip",
            "Vary": "Accept-Encoding",
        },
    )


def _maybe_gzip_json(payload, request: Request) -> Response:
    data = jsonable_encoder(payload)
    body = json_module.dumps(data, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    accept = request.headers.get("accept-encoding", "")
    if len(body) < _GZIP_MIN_BYTES or "gzip" not in accept.lower():
        return Response(
            content=body,
            media_type="application/json",
            headers={"Vary": "Accept-Encoding"},
        )
    compressed = gzip.compress(body, compresslevel=_GZIP_LEVEL)
    return Response(
        content=compressed,
        media_type="application/json",
        headers={
            "Content-Encoding": "gzip",
            "Vary": "Accept-Encoding",
        },
    )

# --- User config file management ---
_PROJECT_ROOT = Path(__file__).resolve().parent.parent
_CONFIG_DEFAULT = _PROJECT_ROOT / "config.default.json"
_CONFIG_PATH_FILE = _PROJECT_ROOT / "config_path.txt"


def _get_active_config_path() -> Path:
    if _CONFIG_PATH_FILE.exists():
        stored = _CONFIG_PATH_FILE.read_text(encoding="utf-8").strip()
        if stored:
            return Path(stored)
    return _PROJECT_ROOT / "config.json"


def _set_active_config_path(new_path: str) -> None:
    _CONFIG_PATH_FILE.write_text(new_path.strip(), encoding="utf-8")


def _ensure_user_config() -> None:
    active = _get_active_config_path()
    if not active.exists() and _CONFIG_DEFAULT.exists():
        active.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(_CONFIG_DEFAULT, active)


def _load_user_config() -> dict:
    _ensure_user_config()
    active = _get_active_config_path()
    try:
        with open(active, "r", encoding="utf-8") as f:
            return json_module.load(f)
    except (FileNotFoundError, json_module.JSONDecodeError):
        if _CONFIG_DEFAULT.exists():
            with open(_CONFIG_DEFAULT, "r", encoding="utf-8") as f:
                return json_module.load(f)
        return {}


def _save_user_config(data: dict) -> None:
    active = _get_active_config_path()
    active.parent.mkdir(parents=True, exist_ok=True)
    with open(active, "w", encoding="utf-8") as f:
        json_module.dump(data, f, indent=4, ensure_ascii=False)
        f.write("\n")


_ensure_user_config()

# CORS. The dev frontend (Vite) hits the backend cross-origin, so some
# origins must be allowed — but a wildcard *default* is a drive-by
# local-file-read vector: any web page the operator happens to visit
# could read `/api/*` (including the filesystem RPCs) off the localhost
# backend. So the default is now the local dev-server origins on
# loopback; the wildcard is explicit opt-in via CORS_ALLOWED_ORIGINS="*".
# A comma-separated list overrides both for a specific deployment. The
# same-origin HuggingFace Space needs no entry here (same-origin requests
# don't trigger CORS).
_CORS_DEFAULT_ORIGINS = [
    "http://localhost:5173", "http://127.0.0.1:5173",  # Vite dev server
    "http://localhost:4173", "http://127.0.0.1:4173",  # Vite preview
]


def _resolve_cors_origins(env_value: str | None) -> list[str]:
    """Map the ``CORS_ALLOWED_ORIGINS`` env value to an allow-list:
    ``"*"`` → wildcard (explicit opt-in), a comma-separated list → that
    list, and unset/empty → the loopback dev-server default."""
    env = (env_value or "").strip()
    if env == "*":
        return ["*"]
    if env:
        return [o.strip() for o in env.split(",") if o.strip()]
    return list(_CORS_DEFAULT_ORIGINS)


_CORS_ORIGINS = _resolve_cors_origins(os.environ.get("CORS_ALLOWED_ORIGINS"))
app.add_middleware(
    CORSMiddleware,
    allow_origins=_CORS_ORIGINS,
    allow_credentials=_CORS_ORIGINS != ["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- Deployment lockdown profile (D7, 2026-07) ---------------------------
# The filesystem RPCs (custom config-file path, session save/list/load,
# native file picker) assume "the client is the operator on their own
# machine". That assumption breaks on the public HuggingFace Space, where
# they would give an anonymous visitor read/write access to the container
# filesystem. When COSTUDY4GRID_LOCKDOWN is set (the Dockerfile sets it),
# those endpoints are disabled with a 403 `{code: "LOCKED_DOWN"}`. Local
# and dev installs leave it unset, so nothing changes there. The read-only
# app config (`GET /api/user-config`, `GET /api/config-file-path`) stays
# available so the SPA still boots.
_LOCKDOWN = os.environ.get("COSTUDY4GRID_LOCKDOWN", "").strip().lower() in ("1", "true", "yes", "on")


def _reject_when_locked_down() -> None:
    """Guard the desktop-era filesystem RPCs on a hosted deployment."""
    if _LOCKDOWN:
        raise AppHTTPException(
            status_code=403,
            detail="This operation is disabled on the hosted deployment.",
            code=CODE_LOCKED_DOWN,
        )


# Single shared anchor for the overflow-graph artifacts (QW17) — the read
# (static serve here) and the writes (analysis output + load-session copy)
# now agree regardless of the process CWD. See services/paths.py.
_OVERFLOW_DIR = OVERFLOW_DIR
_OVERFLOW_DIR.mkdir(parents=True, exist_ok=True)


@app.get("/results/pdf/{filename:path}")
def serve_overflow_artifact(filename: str) -> Response:
    candidate = (_OVERFLOW_DIR / filename).resolve()
    try:
        candidate.relative_to(_OVERFLOW_DIR)
    except ValueError:
        raise HTTPException(status_code=404, detail="Not found")
    if not candidate.is_file():
        raise HTTPException(status_code=404, detail="Not found")

    suffix = candidate.suffix.lower()
    if suffix == ".html":
        try:
            html = candidate.read_text(encoding="utf-8")
        except OSError:
            raise HTTPException(status_code=500, detail="Cannot read overflow file")
        try:
            html = inject_overlay(html)
        except ValueError:
            logger.warning("inject_overlay skipped: no </body> in %s", filename)
        return Response(content=html, media_type="text/html; charset=utf-8")

    return FileResponse(str(candidate))

@app.get("/api/user-config")
def get_user_config() -> dict:
    return _load_user_config()


@app.post("/api/user-config")
def save_user_config(config: dict = Body(...)) -> dict:
    try:
        _save_user_config(config)
        return {"status": "success"}
    except Exception:
        logger.exception("Failed to save user config")
        raise HTTPException(status_code=400, detail="Failed to save configuration.")


@app.get("/api/config-file-path")
def get_config_file_path() -> dict:
    return {"config_file_path": str(_get_active_config_path())}


@app.post("/api/config-file-path")
def set_config_file_path(path: str = Body(..., embed=True)) -> dict:
    _reject_when_locked_down()
    try:
        new_path = Path(path.strip())
        if not new_path.suffix:
            raise HTTPException(status_code=400, detail="Config path must point to a .json file")
        _set_active_config_path(str(new_path))
        _ensure_user_config()
        return {"status": "success", "config_file_path": str(new_path), "config": _load_user_config()}
    except HTTPException:
        raise
    except Exception:
        logger.exception("Failed to set config file path")
        raise HTTPException(status_code=400, detail="Failed to set the config file path.")


class ConfigRequest(BaseModel):
    network_path: str
    action_file_path: str
    min_line_reconnections: float = 2.0
    min_close_coupling: float = 3.0
    min_open_coupling: float = 2.0
    min_line_disconnections: float = 3.0
    min_pst: float = 1.0
    min_load_shedding: float = 0.0
    min_renewable_curtailment_actions: int | None = 0
    min_redispatch: int | None = 0
    redispatch_default_delta_mw: float | None = 10.0
    # When non-empty, restrict the recommender to ONLY these action families
    # (tokens: reco/close/open/disco/pst/ls/rc/redispatch). Empty = all.
    allowed_action_types: list[str] | None = None
    n_prioritized_actions: int = 10
    lines_monitoring_path: str | None = None
    monitoring_factor: float = 0.95
    pre_existing_overload_threshold: float = 0.02
    ignore_reconnections: bool = False
    pypowsybl_fast_mode: bool = True
    layout_path: str | None = None
    # Pluggable recommender selection. ``model`` is the name registered
    # in :mod:`expert_backend.recommenders`; ``compute_overflow_graph``
    # toggles the (expensive) step-2 graph build for models that flag
    # ``requires_overflow_graph=True``. Both default to the legacy
    # expert behaviour so existing clients keep working.
    model: str = "expert"
    compute_overflow_graph: bool = True

class AnalysisRequest(BaseModel):
    disconnected_elements: list[str]

class AnalysisStep2Request(BaseModel):
    selected_overloads: list[str]
    all_overloads: list[str] = []
    monitor_deselected: bool = False
    additional_lines_to_cut: list[str] = []

class RegenerateOverflowGraphRequest(BaseModel):
    mode: str

class FocusedDiagramRequest(BaseModel):
    element_id: str
    depth: int = 1
    disconnected_elements: list[str] | None = None

class ActionVariantRequest(BaseModel):
    action_id: str
    mode: str = "network"

class ComputeSuperpositionRequest(BaseModel):
    action1_id: str
    action2_id: str
    disconnected_elements: list[str]

class RestoreAnalysisContextRequest(BaseModel):
    lines_we_care_about: list[str] | None = None
    disconnected_elements: list[str] | None = None
    lines_overloaded: list[str] | None = None
    computed_pairs: dict | None = None

class ManualActionRequest(BaseModel):
    action_id: str
    disconnected_elements: list[str]
    action_content: dict | None = None
    lines_overloaded: list[str] | None = None
    target_mw: float | None = None
    target_tap: int | None = None
    voltage_level_id: str | None = None

class SaveSessionRequest(BaseModel):
    session_name: str
    json_content: str
    pdf_path: str | None = None
    output_folder_path: str
    interaction_log: str | None = None


# --- Response models (D2, 2026-07) ---
# Applied to the small, native-Python-dict control endpoints where the
# full field set is stable and carries no NumPy (so response_model
# serialization can't drop a field or reject a coercion). The multi-MB
# diagram / analysis payloads keep returning bespoke gzipped Response
# objects — response_model doesn't run for a raw Response — and are
# machine-checked structurally by the OpenAPI snapshot instead. Rolling
# further response models onto the streaming / diagram endpoints is
# tracked in docs/architecture/api-contract-machine-check.md.
class RecommenderModelResponse(BaseModel):
    status: str
    active_model: str
    compute_overflow_graph: bool


class RestoreAnalysisContextResponse(BaseModel):
    status: str
    lines_we_care_about_count: int
    computed_pairs_count: int


class SaveSessionResponse(BaseModel):
    session_folder: str
    pdf_copied: bool


last_network_path = None


@app.get("/api/models")
def list_models() -> dict:
    """Return the list of available recommendation models.

    The frontend reads this on startup so the model dropdown in the
    Settings → Recommender tab can be populated dynamically AND only
    show the parameters each model actually consumes (`params_spec`).
    """
    return {"models": _list_recommender_models()}


@app.post("/api/config")
def update_config(config: ConfigRequest) -> dict:
    global last_network_path
    # Study-level mutation gate: reject (409) a concurrent config load or
    # in-flight analysis rather than tearing down the shared Network while
    # another request is mid-analysis on it (D3, 2026-07).
    if not recommender_service.try_begin_study_mutation("config"):
        raise AppHTTPException(status_code=409, detail=_STUDY_BUSY_DETAIL, code=CODE_STUDY_BUSY)
    try:
        # Hold the network lock across the whole reset → load → update
        # sequence so no diagram request can interleave and observe (or
        # re-populate) torn state between the reset and the reload.
        with recommender_service.network_lock():
            recommender_service.reset()
            network_service.load_network(config.network_path)
            last_network_path = config.network_path
            recommender_service.update_config(config)

        from expert_op4grid_recommender import config as recommender_config
        total_lines = len(network_service.get_disconnectable_elements())
        if getattr(recommender_config, 'IGNORE_LINES_MONITORING', True):
            monitored_lines = len(network_service.get_monitored_elements())
        else:
            monitored_lines = getattr(recommender_config, 'MONITORED_LINES_COUNT', total_lines)

        import os as _os
        from expert_op4grid_recommender.action_evaluation.classifier import ActionClassifier

        action_dict = recommender_service._dict_action or {}
        action_file_name = _os.path.basename(config.action_file_path)

        n_reco = n_disco = n_pst = n_open_coupling = n_close_coupling = 0
        classifier = ActionClassifier()

        for k, v in action_dict.items():
            action_id = str(k).lower()
            action_desc = str(v.get("description_unitaire", v.get("description", ""))).lower()
            t = str(classifier.identify_action_type(v) or "unknown").lower()

            is_disco = 'disco' in t or 'open_line' in t or 'open_load' in t or 'ouverture' in action_desc
            is_reco = 'reco' in t or 'close_line' in t or 'close_load' in t or 'fermeture' in action_desc
            is_open_coupling = 'open_coupling' in t
            is_close_coupling = 'close_coupling' in t
            is_pst_action = ('pst' in action_id or 'pst' in action_desc or 'pst' in t) and not is_disco and not is_reco and not is_open_coupling and not is_close_coupling

            if is_disco: n_disco += 1
            if is_reco: n_reco += 1
            if is_open_coupling: n_open_coupling += 1
            if is_close_coupling: n_close_coupling += 1
            if is_pst_action: n_pst += 1

        return {
            "status": "success",
            "message": "Configuration updated and network loaded",
            "total_lines_count": total_lines,
            "monitored_lines_count": monitored_lines,
            "action_dict_file_name": action_file_name,
            "action_dict_stats": {
                "reco": n_reco,
                "disco": n_disco,
                "pst": n_pst,
                "open_coupling": n_open_coupling,
                "close_coupling": n_close_coupling,
                "total": len(action_dict)
            },
            # Surface the active model so the frontend can confirm what's
            # in effect; helpful when an unknown name was passed and the
            # service silently fell back to the default.
            "active_model": recommender_service.get_active_model_name(),
            "compute_overflow_graph": recommender_service.get_compute_overflow_graph(),
        }
    except Exception:
        logger.exception("Config load failed")
        raise HTTPException(status_code=400, detail="Failed to load the network configuration.")
    finally:
        recommender_service.end_study_mutation()


class RecommenderModelRequest(BaseModel):
    model: str
    compute_overflow_graph: bool | None = None


@app.post("/api/recommender-model", response_model=RecommenderModelResponse)
def set_recommender_model(req: RecommenderModelRequest) -> dict:
    """Swap the active recommender model on the running service.

    Lightweight counterpart to ``POST /api/config``: only updates the
    model + ``compute_overflow_graph`` toggle, leaves the loaded
    network, action dictionary, and analysis context untouched. The
    Step-2 graph cache (`_last_step2_signature`) is also left intact —
    the overflow graph itself doesn't depend on the model, only the
    discovery step does, so a model swap can reuse the cached graph
    and re-run only ``run_analysis_step2_discovery``.
    """
    try:
        recommender_service._apply_model_settings(req)
        return {
            "status": "success",
            "active_model": recommender_service.get_active_model_name(),
            "compute_overflow_graph": recommender_service.get_compute_overflow_graph(),
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/api/branches")
def get_branches() -> dict:
    try:
        branches = network_service.get_disconnectable_elements()
        name_map = network_service.get_element_names()
        return {"branches": branches, "name_map": name_map}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.get("/api/voltage-levels")
def get_voltage_levels() -> dict:
    try:
        voltage_levels = network_service.get_voltage_levels()
        name_map = network_service.get_voltage_level_names()
        return {"voltage_levels": voltage_levels, "name_map": name_map}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.get("/api/nominal-voltages")
def get_nominal_voltages() -> dict:
    try:
        mapping = network_service.get_nominal_voltages()
        unique_kv = sorted(set(mapping.values()))
        return {"mapping": mapping, "unique_kv": unique_kv}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/api/voltage-level-substations")
def get_voltage_level_substations() -> dict:
    try:
        return {"mapping": network_service.get_voltage_level_substations()}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.get("/api/pick-path")
def pick_path(type: str = Query("file", enum=["file", "dir"])) -> dict:
    _reject_when_locked_down()
    try:
        if platform.system() == "Darwin":
            return _pick_path_macos(type)
        return _pick_path_tkinter(type)
    except subprocess.TimeoutExpired:
        return {"path": "", "error": "File picker timed out (no selection made)."}
    except Exception:
        logger.exception("Error picking path")
        return {"path": "", "error": "File picker failed."}


def _pick_path_macos(kind: str) -> dict:
    if kind == "dir":
        applescript = 'POSIX path of (choose folder with prompt "Select folder")'
    else:
        applescript = 'POSIX path of (choose file with prompt "Select file")'
    try:
        proc = subprocess.run(
            ["osascript", "-e", applescript],
            capture_output=True,
            text=True,
            timeout=300,
        )
    except FileNotFoundError:
        return {"path": "", "error": "osascript not available — paste the path manually."}
    if proc.returncode != 0:
        stderr = (proc.stderr or "").strip()
        if "User canceled" in stderr or "User cancelled" in stderr or "(-128)" in stderr:
            return {"path": ""}
        return {
            "path": "",
            "error": stderr or f"osascript exited with status {proc.returncode}",
        }
    return {"path": proc.stdout.strip()}


def _pick_path_tkinter(kind: str) -> dict:
    script = f"""
import tkinter as tk
from tkinter import filedialog

root = tk.Tk()
root.geometry('1x1+0+0')
root.attributes('-topmost', True)
root.lift()
root.focus_force()
root.update()
if "{kind}" == "dir":
    path = filedialog.askdirectory(parent=root)
else:
    path = filedialog.askopenfilename(parent=root)
root.destroy()
if path:
    print(path)
"""
    proc = subprocess.run(
        [sys.executable, "-c", script],
        capture_output=True,
        text=True,
        timeout=300,
    )
    if proc.returncode != 0:
        err = (proc.stderr or "").strip() or f"file picker exited with status {proc.returncode}"
        logger.warning("Error picking path: %s", err)
        return {"path": "", "error": err}
    return {"path": proc.stdout.strip()}

def _safe_session_dir(base_folder: str, session_name: str) -> str:
    """Resolve ``<base_folder>/<session_name>`` while rejecting any
    ``session_name`` that escapes ``base_folder`` — path separators,
    ``..``, or an absolute path (``os.path.join`` silently drops the base
    when the second arg is absolute). Mirrors the ``/results/pdf``
    traversal guard. Returns the resolved absolute session directory."""
    name = (session_name or "").strip()
    # A session name is a single path component. basename() strips any
    # directory part; '.' / '..' are rejected explicitly (basename keeps
    # them). The resolve()+relative_to() below is the defense-in-depth
    # backstop that also catches separators basename doesn't split on.
    if not name or name in (".", "..") or os.path.basename(name) != name:
        raise HTTPException(status_code=400, detail="Invalid session name")
    base = Path(base_folder).resolve()
    candidate = (base / name).resolve()
    try:
        candidate.relative_to(base)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid session name")
    return str(candidate)

@app.post("/api/save-session", response_model=SaveSessionResponse)
def save_session(request: SaveSessionRequest) -> dict:
    _reject_when_locked_down()
    import shutil

    if not request.output_folder_path:
        raise HTTPException(status_code=400, detail="output_folder_path is required")

    session_dir = _safe_session_dir(request.output_folder_path, request.session_name)
    try:
        os.makedirs(session_dir, exist_ok=True)
    except OSError:
        logger.exception("Cannot create session directory")
        raise HTTPException(status_code=400, detail="Cannot create the session directory.")

    json_file = os.path.join(session_dir, "session.json")
    with open(json_file, "w", encoding="utf-8") as f:
        f.write(request.json_content)

    pdf_copied = False
    if request.pdf_path:
        if os.path.isfile(request.pdf_path):
            pdf_dest = os.path.join(session_dir, os.path.basename(request.pdf_path))
            try:
                shutil.copy2(request.pdf_path, pdf_dest)
                pdf_copied = True
            except Exception as e:
                logger.warning("Failed to copy PDF from %s to %s: %s", request.pdf_path, pdf_dest, e)
        else:
            logger.warning("PDF path provided but file not found: %s", request.pdf_path)

    if request.interaction_log:
        log_file = os.path.join(session_dir, "interaction_log.json")
        with open(log_file, "w", encoding="utf-8") as f:
            f.write(request.interaction_log)

    return {
        "session_folder": session_dir,
        "pdf_copied": pdf_copied
    }

@app.get("/api/list-sessions")
def list_sessions(folder_path: str = Query(...)) -> dict:
    _reject_when_locked_down()
    if not folder_path or not os.path.isdir(folder_path):
        raise HTTPException(status_code=400, detail=f"Invalid folder path: {folder_path}")

    sessions = []
    try:
        for entry in os.listdir(folder_path):
            entry_path = os.path.join(folder_path, entry)
            if os.path.isdir(entry_path) and (entry.startswith("costudy4grid_session") or entry.startswith("expertassist_session")):
                json_path = os.path.join(entry_path, "session.json")
                if os.path.isfile(json_path):
                    sessions.append(entry)
    except OSError:
        logger.exception("Cannot read sessions folder")
        raise HTTPException(status_code=400, detail="Cannot read the sessions folder.")

    sessions.sort(reverse=True)
    return {"sessions": sessions}

@app.post("/api/load-session")
def load_session(folder_path: str = Body(...), session_name: str = Body(...)) -> dict:
    _reject_when_locked_down()
    import json as json_module
    import shutil
    import glob

    session_dir = _safe_session_dir(folder_path, session_name)
    json_path = os.path.join(session_dir, "session.json")

    if not os.path.isfile(json_path):
        raise HTTPException(status_code=404, detail=f"Session file not found: {json_path}")

    try:
        with open(json_path, "r", encoding="utf-8") as f:
            content = json_module.load(f)

        overflow = content.get("overflow_graph")
        if overflow and overflow.get("pdf_url"):
            pdf_filename = os.path.basename(overflow["pdf_url"])
            target_path = str(OVERFLOW_DIR / pdf_filename)
            if not os.path.isfile(target_path):
                session_files = (
                    glob.glob(os.path.join(session_dir, "*.html"))
                    + glob.glob(os.path.join(session_dir, "*.pdf"))
                )
                if session_files:
                    OVERFLOW_DIR.mkdir(parents=True, exist_ok=True)
                    picked = next(
                        (f for f in session_files if os.path.basename(f) == pdf_filename),
                        max(session_files, key=os.path.getmtime),
                    )
                    shutil.copy2(picked, target_path)

        return content
    except Exception:
        logger.exception("Failed to read session")
        raise HTTPException(status_code=400, detail="Failed to read the session file.")

@app.post("/api/restore-analysis-context", response_model=RestoreAnalysisContextResponse)
def restore_analysis_context(request: RestoreAnalysisContextRequest) -> dict:
    try:
        recommender_service.restore_analysis_context(
            lines_we_care_about=request.lines_we_care_about,
            disconnected_elements=request.disconnected_elements,
            lines_overloaded=request.lines_overloaded,
            computed_pairs=request.computed_pairs,
        )
        return {
            "status": "success",
            "lines_we_care_about_count": len(request.lines_we_care_about) if request.lines_we_care_about else 0,
            "computed_pairs_count": len(request.computed_pairs) if request.computed_pairs else 0,
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

from fastapi.responses import StreamingResponse
import json
@app.post("/api/run-analysis")
async def run_analysis(request: AnalysisRequest) -> StreamingResponse:
    # Study-mutation gate (D3): reject a second analysis / config load
    # in flight rather than queueing it behind this one. Held for the
    # whole stream; released in the generator's finally.
    if not recommender_service.try_begin_study_mutation("run-analysis"):
        raise AppHTTPException(status_code=409, detail=_STUDY_BUSY_DETAIL, code=CODE_STUDY_BUSY)

    def event_generator() -> Iterator[Any]:
        try:
            for event in recommender_service.run_analysis(request.disconnected_elements):
                if event.get("pdf_path"):
                    filename = os.path.basename(event["pdf_path"])
                    event["pdf_url"] = f"/results/pdf/{filename}"

                yield json.dumps(event) + "\n"
        except Exception as e:
            yield json.dumps({"type": "error", "message": str(e)}) + "\n"
        finally:
            recommender_service.end_study_mutation()

    return StreamingResponse(event_generator(), media_type="application/x-ndjson")

# NB: sync `def` (not `async def`) — this endpoint runs seconds of
# synchronous pypowsybl / grid2op work (contingency simulation + overload
# detection). A `def` route is dispatched to Starlette's threadpool, so
# it does NOT block the event loop; an `async def` would freeze every
# other request for the duration (QW2, 2026-07). The other analysis
# routes stay `async def` because they return a StreamingResponse
# immediately and their sync generators are iterated in the threadpool.
@app.post("/api/run-analysis-step1")
def run_analysis_step1(request: AnalysisRequest) -> dict:
    if not recommender_service.try_begin_study_mutation("run-analysis-step1"):
        raise AppHTTPException(status_code=409, detail=_STUDY_BUSY_DETAIL, code=CODE_STUDY_BUSY)
    try:
        result = recommender_service.run_analysis_step1(request.disconnected_elements)
        return result
    except Exception as e:
        logger.exception("API boundary error")
        raise HTTPException(status_code=400, detail=str(e))
    finally:
        recommender_service.end_study_mutation()

@app.post("/api/run-analysis-step2")
async def run_analysis_step2(request: AnalysisStep2Request) -> StreamingResponse:
    if not recommender_service.try_begin_study_mutation("run-analysis-step2"):
        raise AppHTTPException(status_code=409, detail=_STUDY_BUSY_DETAIL, code=CODE_STUDY_BUSY)

    def event_generator() -> Iterator[Any]:
        try:
            for event in recommender_service.run_analysis_step2(
                request.selected_overloads,
                all_overloads=request.all_overloads,
                monitor_deselected=request.monitor_deselected,
                additional_lines_to_cut=request.additional_lines_to_cut,
            ):
                if event.get("pdf_path"):
                    filename = os.path.basename(event["pdf_path"])
                    event["pdf_url"] = f"/results/pdf/{filename}"

                yield json.dumps(event) + "\n"
        except Exception as e:
            yield json.dumps({"type": "error", "message": str(e)}) + "\n"
        finally:
            recommender_service.end_study_mutation()

    return StreamingResponse(event_generator(), media_type="application/x-ndjson")

@app.post("/api/regenerate-overflow-graph")
def regenerate_overflow_graph(request: RegenerateOverflowGraphRequest) -> dict:
    try:
        result = recommender_service.regenerate_overflow_graph(request.mode)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("Backend error in /api/regenerate-overflow-graph")
        raise HTTPException(status_code=500, detail=str(e))

    if result.get("pdf_path"):
        result["pdf_url"] = f"/results/pdf/{os.path.basename(result['pdf_path'])}"
    return result

@app.get("/api/network-diagram")
def get_network_diagram(http_request: Request, format: str = Query("json")) -> Response:
    try:
        diagram = recommender_service.get_prefetched_base_nad()
        if diagram is None:
            diagram = recommender_service.get_network_diagram()
        if format == "text":
            return _maybe_gzip_svg_text(diagram, http_request)
        return _maybe_gzip_json(diagram, http_request)
    except Exception as e:
        logger.exception("API boundary error")
        raise HTTPException(status_code=400, detail=str(e))

@app.post("/api/contingency-diagram")
def get_contingency_diagram(request: AnalysisRequest, http_request: Request) -> Response:
    try:
        diagram = recommender_service.get_contingency_diagram(request.disconnected_elements)
        return _maybe_gzip_json(diagram, http_request)
    except Exception as e:
        logger.exception("API boundary error")
        raise HTTPException(status_code=400, detail=str(e))

@app.post("/api/action-variant-diagram")
def get_action_variant_diagram(request: ActionVariantRequest, http_request: Request) -> Response:
    try:
        diagram = recommender_service.get_action_variant_diagram(
            request.action_id, mode=request.mode
        )
        return _maybe_gzip_json(diagram, http_request)
    except ActionResultUnavailableError as e:
        # Expected after a session reload (and for any manually-added
        # action): the backend has no cached observation, so it can't
        # render the post-action NAD. Still a 400 — the frontend needs
        # it to trigger the `/api/simulate-and-variant-diagram` fallback
        # — but tagged with an EXPLICIT code so the client branches on the
        # code, not the (shared) 400 status, and logged quietly instead of
        # as an ERROR-level traceback.
        logger.info(
            "action-variant-diagram: %s — client falls back to live simulation", e
        )
        raise AppHTTPException(
            status_code=400, detail=str(e), code=CODE_ACTION_RESULT_UNAVAILABLE,
        )
    except Exception as e:
        logger.exception("API boundary error")
        raise HTTPException(status_code=400, detail=str(e))

@app.post("/api/contingency-diagram-patch")
def get_contingency_diagram_patch(request: AnalysisRequest, http_request: Request) -> Response:
    try:
        payload = recommender_service.get_contingency_diagram_patch(request.disconnected_elements)
        return _maybe_gzip_json(payload, http_request)
    except Exception as e:
        logger.exception("API boundary error")
        raise HTTPException(status_code=400, detail=str(e))

@app.post("/api/action-variant-diagram-patch")
def get_action_variant_diagram_patch(request: ActionVariantRequest, http_request: Request) -> Response:
    try:
        payload = recommender_service.get_action_variant_diagram_patch(request.action_id)
        return _maybe_gzip_json(payload, http_request)
    except Exception as e:
        logger.exception("API boundary error")
        raise HTTPException(status_code=400, detail=str(e))

@app.get("/api/element-voltage-levels")
def get_element_voltage_levels(element_id: str = Query(...)) -> dict:
    try:
        vls = network_service.get_element_voltage_levels(element_id)
        return {"voltage_level_ids": vls}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
@app.post("/api/focused-diagram")
def get_focused_diagram(request: FocusedDiagramRequest, http_request: Request) -> Response:
    try:
        vl_ids = network_service.get_element_voltage_levels(request.element_id)
        if not vl_ids:
            raise HTTPException(status_code=404, detail=f"No voltage levels found for {request.element_id}")

        if request.disconnected_elements:
            diagram = recommender_service.get_contingency_diagram(
                request.disconnected_elements,
                voltage_level_ids=vl_ids,
                depth=request.depth
            )
        else:
            diagram = recommender_service.get_network_diagram(
                voltage_level_ids=vl_ids,
                depth=request.depth
            )
        diagram["voltage_level_ids"] = vl_ids
        diagram["depth"] = request.depth
        return _maybe_gzip_json(diagram, http_request)
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("API boundary error")
        raise HTTPException(status_code=400, detail=str(e))

class ActionVariantFocusedRequest(BaseModel):
    action_id: str
    element_id: str
    depth: int = 1

@app.post("/api/action-variant-focused-diagram")
def get_action_variant_focused_diagram(request: ActionVariantFocusedRequest, http_request: Request) -> Response:
    try:
        vl_ids = network_service.get_element_voltage_levels(request.element_id)
        if not vl_ids:
            raise HTTPException(status_code=404, detail=f"No voltage levels found for {request.element_id}")
        diagram = recommender_service.get_action_variant_diagram(
            request.action_id,
            voltage_level_ids=vl_ids,
            depth=request.depth,
        )
        diagram["voltage_level_ids"] = vl_ids
        return _maybe_gzip_json(diagram, http_request)
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("API boundary error")
        raise HTTPException(status_code=400, detail=str(e))

class ActionVariantSldRequest(BaseModel):
    action_id: str
    voltage_level_id: str

@app.post("/api/action-variant-sld")
def get_action_variant_sld(request: ActionVariantSldRequest, http_request: Request) -> Response:
    try:
        diagram = recommender_service.get_action_variant_sld(
            request.action_id,
            request.voltage_level_id,
        )
        return _maybe_gzip_json(diagram, http_request)
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("API boundary error")
        raise HTTPException(status_code=400, detail=str(e))

class NSldRequest(BaseModel):
    voltage_level_id: str

@app.post("/api/n-sld")
def get_n_sld(request: NSldRequest, http_request: Request) -> Response:
    try:
        diagram = recommender_service.get_n_sld(request.voltage_level_id)
        return _maybe_gzip_json(diagram, http_request)
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("API boundary error")
        raise HTTPException(status_code=400, detail=str(e))

class ContingencySldRequest(BaseModel):
    disconnected_elements: list[str]
    voltage_level_id: str

class SldTopologyPreviewRequest(BaseModel):
    voltage_level_id: str
    disconnected_elements: list[str]
    switches: dict
    base_action_id: str | None = None

@app.post("/api/contingency-sld")
def get_contingency_sld(request: ContingencySldRequest, http_request: Request) -> Response:
    try:
        diagram = recommender_service.get_contingency_sld(
            request.disconnected_elements,
            request.voltage_level_id,
        )
        return _maybe_gzip_json(diagram, http_request)
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("API boundary error")
        raise HTTPException(status_code=400, detail=str(e))

@app.post("/api/sld-topology-preview")
def sld_topology_preview(request: SldTopologyPreviewRequest, http_request: Request) -> Response:
    try:
        diagram = recommender_service.get_topology_preview_sld(
            request.disconnected_elements,
            request.voltage_level_id,
            request.switches,
            base_action_id=request.base_action_id,
        )
        return _maybe_gzip_json(diagram, http_request)
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("API boundary error")
        raise HTTPException(status_code=400, detail=str(e))

@app.get("/api/actions")
def get_actions(http_request: Request) -> Response:
    try:
        actions = recommender_service.get_all_action_ids()
        return _maybe_gzip_json({"actions": actions}, http_request)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.post("/api/simulate-manual-action")
def simulate_manual_action(request: ManualActionRequest) -> dict:
    try:
        result = recommender_service.simulate_manual_action(
            request.action_id, request.disconnected_elements,
            action_content=request.action_content,
            lines_overloaded=request.lines_overloaded,
            target_mw=request.target_mw,
            target_tap=request.target_tap,
            voltage_level_id=request.voltage_level_id,
        )
        return result
    except Exception as e:
        logger.exception("API boundary error")
        raise HTTPException(status_code=400, detail=str(e))


class SimulateAndVariantDiagramRequest(BaseModel):
    action_id: str
    disconnected_elements: list[str]
    action_content: dict | None = None
    lines_overloaded: list[str] | None = None
    target_mw: float | None = None
    target_tap: int | None = None
    voltage_level_id: str | None = None
    mode: str = "network"


@app.post("/api/simulate-and-variant-diagram")
async def simulate_and_variant_diagram(request: SimulateAndVariantDiagramRequest) -> StreamingResponse:
    def event_generator() -> Iterator[Any]:
        try:
            sim_result = recommender_service.simulate_manual_action(
                request.action_id, request.disconnected_elements,
                action_content=request.action_content,
                lines_overloaded=request.lines_overloaded,
                target_mw=request.target_mw,
                target_tap=request.target_tap,
                voltage_level_id=request.voltage_level_id,
            )
            yield json.dumps({"type": "metrics", **sim_result}) + "\n"

            diagram = recommender_service.get_action_variant_diagram(
                request.action_id, mode=request.mode,
            )
            yield json.dumps({"type": "diagram", **diagram}) + "\n"
        except Exception as e:
            logger.exception("API boundary error")

            yield json.dumps({"type": "error", "message": str(e)}) + "\n"

    return StreamingResponse(event_generator(), media_type="application/x-ndjson")

@app.post("/api/compute-superposition")
def compute_superposition(request: ComputeSuperpositionRequest) -> dict:
    try:
        result = recommender_service.compute_superposition(
            request.action1_id, request.action2_id, request.disconnected_elements
        )
        return result
    except Exception as e:
        logger.exception("API boundary error")
        raise HTTPException(status_code=400, detail=str(e))

# ---------------------------------------------------------------------------
# Static frontend (same-origin SPA hosting — e.g. a HuggingFace Docker Space).
#
# Mounted LAST so every `/api/*` and `/results/*` route declared above keeps
# priority over the catch-all. The mount is OPTIONAL: in local dev and in the
# test suite the built bundle is absent, so the backend stays a pure API
# server and the Vite dev server (:5173) serves the SPA instead. Point
# `COSTUDY4GRID_FRONTEND_DIST` at the `vite build` output to enable it.
# ---------------------------------------------------------------------------
_FRONTEND_DIST = Path(
    os.environ.get(
        "COSTUDY4GRID_FRONTEND_DIST",
        str(Path(__file__).resolve().parent.parent / "frontend" / "dist"),
    )
).resolve()
if (_FRONTEND_DIST / "index.html").is_file():
    app.mount(
        "/", StaticFiles(directory=str(_FRONTEND_DIST), html=True), name="frontend"
    )
    logger.info("Serving frontend SPA from %s", _FRONTEND_DIST)


if __name__ == "__main__":
    import uvicorn

    # Honour $PORT (HuggingFace Spaces / generic PaaS) with the local default.
    port = int(os.environ.get("PORT", "8000"))
    uvicorn.run(app, host="0.0.0.0", port=port)
