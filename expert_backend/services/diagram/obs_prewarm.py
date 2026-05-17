# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0

"""Post-contingency observation pre-warm helper.

Builds a ``PypowsyblObservation`` while the network is already
positioned on a contingency variant — so the analysis side
(``run_analysis_step1``) can skip re-running the AC load flow. The
helper lives outside ``diagram_mixin.py`` to keep that orchestrator
under the function-LoC ceiling guarded by the code-quality gate.

Stateless: takes the SimulationEnvironment resolution callables as
arguments and returns the obs tuple. The mixin owns the writes to
``_cached_obs_n1*`` so the cache invariants stay in one place.

See ``docs/backend/recommender_models.md`` § "Execution-time
breakdown" for the wider context.
"""
from __future__ import annotations

import logging
from typing import Any, Callable, Optional, Tuple

logger = logging.getLogger(__name__)


def build_prewarmed_obs(
    *,
    cached_env_context: Optional[dict],
    get_simulation_env: Callable[[], Any],
    variant_id: str,
    disconnected_elements,
) -> Optional[Tuple[Any, str, Tuple[str, ...]]]:
    """Build a ``PypowsyblObservation`` for the currently-active variant.

    Resolves the SimulationEnvironment from
    ``cached_env_context['env']`` when present (the env that
    ``run_analysis_step1`` will reuse — keeps the obs byte-for-byte
    equivalent to what ``simulate_contingency_pypowsybl`` would have
    produced), else falls back to ``get_simulation_env()``. Returns
    ``(obs, variant_id, elements_tuple)`` on success and ``None`` when
    no env is reachable — best-effort: callers ignore the failure and
    leave the cache untouched.

    The caller is responsible for positioning the shared pypowsybl
    network on ``variant_id`` BEFORE calling. The obs is stamped with
    ``obs._variant_id = variant_id`` so downstream action-variant code
    branches from the same variant.
    """
    env = (cached_env_context or {}).get("env")
    if env is None:
        try:
            env = get_simulation_env()
        except Exception as exc:
            logger.debug("[RECO] no simulation env yet for prewarm: %s", exc)
            return None
    if env is None:
        return None
    obs = env.get_obs()
    obs._variant_id = variant_id
    elements = tuple(disconnected_elements or ())
    logger.info(
        "[RECO] Pre-warmed post-contingency obs for %s (variant=%s)",
        list(elements), variant_id,
    )
    return obs, variant_id, elements
