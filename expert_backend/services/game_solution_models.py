# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0
"""Wire models of the Game Mode solution-capitalisation endpoints.

Pydantic request/response models normally live at the top of ``main.py``;
the game group sits here to keep ``main.py`` under the module-size ceiling
(scripts/check_code_quality.py). The store logic itself is in
``services/game_solutions.py``; the frontend mirror is
``frontend/src/types.ts`` (LogGameSolutionRequest / LogGameSolutionResponse
/ GameLeverStatsResponse), machine-checked via ``openapi.snapshot.json``.
"""
from __future__ import annotations

from pydantic import BaseModel


class GameSolutionAction(BaseModel):
    """One retained (starred) remedial action of a Game Mode study.

    ``levers`` are magnitude-free unitary signatures computed by the
    frontend (``redispatch:<gen>``, ``ls:<load>``, ``switch:<id>=<state>``,
    …); an empty list means the catalogue identity ``action:<action_id>``
    is used instead. See services/game_solutions.py.
    """
    action_id: str
    description: str | None = None
    action_type: str | None = None
    levers: list[str] = []
    # True when the action is effective (reduces the baseline worst
    # loading; a combined action must also beat its underlying actions by
    # ≥ 1 loading-point). The novelty bonus is only paid when EVERY
    # retained action is effective.
    effective: bool = True


class LogGameSolutionRequest(BaseModel):
    player: str | None = None
    session_name: str | None = None
    study_id: str | None = None
    study_label: str | None = None
    network_path: str
    contingency_id: str
    solved: bool = False
    final_max_rho: float | None = None
    baseline_max_rho: float | None = None
    actions: list[GameSolutionAction]


class GameSolutionNovelty(BaseModel):
    new_proposition: bool
    new_levers: list[str]
    # False when at least one retained action was not effective — novelty
    # is still reported but bonus_points stays 0.
    effective: bool
    bonus_points: int


class GameSolutionFrequency(BaseModel):
    action_id: str | None
    description: str | None
    signatures: list[str]
    count: int
    total: int
    share: float


class GameSolutionContextStats(BaseModel):
    distinct_propositions: int
    total_retentions: int


class LogGameSolutionResponse(BaseModel):
    stored: bool
    duplicate: bool
    context_key: str
    signature: str
    novelty: GameSolutionNovelty
    frequencies: list[GameSolutionFrequency]
    context_stats: GameSolutionContextStats


class GameLeverStat(BaseModel):
    signature: str
    label: str
    category: str
    count: int
    share: float
    sample_description: str | None


class GameLeverStatsResponse(BaseModel):
    context_key: str
    total_retentions: int
    levers: list[GameLeverStat]


class PlayerSessionsResponse(BaseModel):
    player: str
    # Distinct sessions this player already recorded in the shared base;
    # seeds the default session name (`<player> — session <count+1>`).
    session_count: int
