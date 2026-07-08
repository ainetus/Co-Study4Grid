# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0
# This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

"""Combined-action (superposition pair) payload shaping.

Pure helpers kept out of ``analysis_mixin`` so they are independently
testable and so the mixin stays under its module-size ceiling.
"""
from __future__ import annotations

import logging
from typing import Any, Dict, Optional

from expert_op4grid_recommender import config

from expert_backend.services.simulation_helpers import (
    compute_combined_rho,
    compute_target_max_rho,
)

logger = logging.getLogger(__name__)

# Per-branch full-grid vectors the recommender embeds in every combined pair
# (``p_or_combined`` / ``p_ex_combined`` = one float PER LINE of the grid,
# ~6–8k on the PyPSA-EUR grids). The Co-Study4Grid frontend reads NONE of them
# — ``CombinedAction`` uses only betas / max_rho / rho_before / rho_after, and
# session-reload rebuilds these as ``[]`` — yet at ~100 pairs they are the bulk
# of the step-2 result payload (≈ 29 MB on the European grid), inflating both
# ``sanitize_for_json`` and the browser transfer (the "Other (network /
# streaming)" bucket in the execution-time breakdown).
HEAVY_PAIR_ARRAY_KEYS = ("p_or_combined", "p_ex_combined")


def slim_combined_actions_for_payload(
    combined_actions: Optional[Dict[str, Any]],
) -> Optional[Dict[str, Any]]:
    """Empty the full-grid per-branch arrays from each combined pair in place.

    Empties (does NOT delete) the keys so the payload shape is unchanged and any
    consumer probing for the key still finds it — matching exactly what a
    saved-then-reloaded session already looks like. Returns the same mapping for
    call-site convenience; safe on ``None`` / non-dict entries.
    """
    if not combined_actions:
        return combined_actions
    for pair in combined_actions.values():
        if isinstance(pair, dict):
            for key in HEAVY_PAIR_ARRAY_KEYS:
                if pair.get(key):
                    pair[key] = []
    return combined_actions


def augment_combined_actions_with_target_max_rho(results: dict, context: dict) -> None:
    """Add ``target_max_rho`` / ``target_max_rho_line`` to each pre-computed
    pair in ``results['combined_actions']`` (mutated in place).

    The target max is computed over ``context['lines_overloaded_ids']``
    only — the user-selected overloads that the pair is meant to
    resolve — using the same formula as the on-demand
    ``compute_superposition`` path.  Leaves ``max_rho`` /
    ``max_rho_line`` untouched so the global-scan warning for
    newly-introduced overloads is preserved (see
    ``test_superposition_max_rho_filtering_regression``).
    """
    combined_actions = results.get("combined_actions") or {}
    if not combined_actions:
        return
    obs_start = context.get("obs_simu_defaut")
    lines_overloaded_ids = context.get("lines_overloaded_ids") or []
    prioritized = results.get("prioritized_actions") or {}
    if obs_start is None or not lines_overloaded_ids:
        return

    try:
        name_line_list = list(obs_start.name_line)
    except Exception as e:
        logger.debug("target max_rho: cannot read name_line: %s", e)
        return
    monitoring_factor = float(getattr(config, "MONITORING_FACTOR_THERMAL_LIMITS", 0.95))

    for pair_id, pair in combined_actions.items():
        if not isinstance(pair, dict) or "error" in pair:
            continue
        betas = pair.get("betas")
        if not betas or len(betas) != 2:
            continue
        try:
            aid1, aid2 = [p.strip() for p in pair_id.split("+", 1)]
        except ValueError:
            continue
        obs1 = (prioritized.get(aid1) or {}).get("observation")
        obs2 = (prioritized.get(aid2) or {}).get("observation")
        if obs1 is None or obs2 is None:
            continue
        try:
            rho_combined = compute_combined_rho(obs_start, obs1, obs2, list(betas))
        except Exception as e:
            logger.debug("target max_rho: rho_combined failed for %s: %s", pair_id, e)
            continue
        target_max, target_line = compute_target_max_rho(
            rho_combined, name_line_list, list(lines_overloaded_ids),
        )
        pair["target_max_rho"] = target_max * monitoring_factor if target_max else 0.0
        pair["target_max_rho_line"] = target_line
