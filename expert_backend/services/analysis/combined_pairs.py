# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0
# This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

"""Combined-action (superposition pair) payload shaping.

Pure helper kept out of ``analysis_mixin`` / ``_service_integration`` so it is
independently testable (no pypowsybl / recommender import chain).
"""
from __future__ import annotations

from typing import Any, Dict, Optional

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
