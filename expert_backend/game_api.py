# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0
"""Game Mode HTTP routes — solution capitalisation + lever hints.

Registered on the app via :func:`install_game_routes` (same install-once
pattern as ``services/api_errors.install_error_handlers``); kept out of
``main.py`` so it stays under the module-size ceiling
(scripts/check_code_quality.py). Store logic: ``services/game_solutions.py``;
wire models: ``services/game_solution_models.py``.

These routes are NOT lockdown-gated (D7): unlike the desktop-era filesystem
RPCs, they never touch a client-supplied path — the store root is fixed
server-side (``COSTUDY4GRID_DATA_DIR`` cascade) and ids are slugged, so they
stay available on the public HuggingFace Space where the shared base lives.
"""
from __future__ import annotations

from fastapi import FastAPI, HTTPException, Query

from expert_backend.services import game_solutions
from expert_backend.services.game_solution_models import (
    GameLeverStatsResponse,
    LogGameSolutionRequest,
    LogGameSolutionResponse,
    PlayerSessionsResponse,
)


def install_game_routes(app: FastAPI) -> None:
    """Register the Game Mode routes on ``app`` (call once at import)."""

    @app.post("/api/game/log-solution", response_model=LogGameSolutionResponse)
    def log_game_solution(request: LogGameSolutionRequest) -> dict:
        """Capitalise a Game Mode retained proposition into the shared
        solution base and report novelty (bonus points) + per-action usage
        frequencies.

        Pure file IO on the store directory — no network state involved, so
        no network lock / busy gate; the store serializes its own
        read-modify-write with a module-level lock.
        """
        try:
            return game_solutions.log_solution(request.model_dump())
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))

    @app.get("/api/game/lever-stats", response_model=GameLeverStatsResponse)
    def game_lever_stats(
        network_path: str = Query(""),
        contingency_id: str = Query(...),
        top_n: int = Query(5, ge=1, le=20),
    ) -> dict:
        """Most-used unitary levers of a (network, contingency) context in
        the shared solution base — the Game Mode beginner-assistance hints.
        Read-only scan of the store."""
        try:
            return game_solutions.lever_stats(
                network_path, contingency_id, top_n=top_n)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))

    @app.get("/api/game/player-sessions", response_model=PlayerSessionsResponse)
    def game_player_sessions(player: str = Query("")) -> dict:
        """Distinct sessions a player has already recorded in the shared
        solution base — seeds the default session name / index on the Game
        Mode config screen. Read-only store scan; an empty handle → zero."""
        return game_solutions.player_session_count(player)
