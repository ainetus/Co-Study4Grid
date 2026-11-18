# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0
# This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

"""Evacuation-antenna aggregate actions (expert_op4grid_recommender 0.3.4+).

With ``EVACUATION_ANTENNA_LEVERS`` (on by default since the recommender's
0.3.4), each evacuation antenna gets, besides its per-generator candidates,
one MW-sized option spread pro rata over its generators:
``curtail_<antenna_id>`` (renewables, lowered) or ``redispatch_<antenna_id>``
(dispatchable units, lowered upstream, raised downstream).

Unlike ``curtail_<gen>`` / ``redispatch_<gen>``, the id names the antenna,
not a generator, so the action cannot be rebuilt from its id. Its generators
(``gen_names``) and their new setpoints (``target_p_MW``, a dict) are in the
analysis' ``action_scores[<type>]["params"][<action_id>]``, next to the
antenna (``evacuation_antenna_id``) and the attachment substation it is
sized on (``substation``). See
``docs/features/curtailment-loadshedding-pst-actions.md``.
"""
from __future__ import annotations

from typing import Any

_AGGREGATE_PREFIXES: tuple[str, ...] = ("curtail_", "redispatch_")


def is_antenna_aggregate_params(params: Any) -> bool:
    """True for the score params of an antenna aggregate: several generators
    (``gen_names``) with one setpoint each (``target_p_MW`` is a dict, a
    float for the per-generator candidates)."""
    return (
        isinstance(params, dict)
        and bool(params.get("gen_names"))
        and isinstance(params.get("target_p_MW"), dict)
    )


def antenna_aggregate_params(action_scores: Any, action_id: str) -> dict | None:
    """Score params of the antenna aggregate ``action_id``, or None.

    Looks the id up in every action type's ``params`` of ``action_scores``
    (the analysis result's, or a session's), so callers don't need to know
    which family proposed it.
    """
    if not isinstance(action_scores, dict) or not action_id.startswith(_AGGREGATE_PREFIXES):
        return None
    for type_data in action_scores.values():
        params = type_data.get("params") if isinstance(type_data, dict) else None
        entry = params.get(action_id) if isinstance(params, dict) else None
        if is_antenna_aggregate_params(entry):
            return entry
    return None


def antenna_aggregate_setpoints(params: dict) -> dict[str, float]:
    """New active-power setpoint (MW) of each generator, as the recommender
    sized the aggregate."""
    return {str(gen): float(p) for gen, p in params["target_p_MW"].items()}


def describe_antenna_aggregate(action_id: str, params: dict) -> tuple[str, str]:
    """``(description, description_unitaire)`` of an antenna aggregate, in
    the style of the per-generator dynamic actions (``Effacement '<gen>'``,
    ``Redispatch hausse '<gen>'``)."""
    antenna = params.get("evacuation_antenna_id") or action_id.split("_", 1)[1]
    gens = ", ".join(f"'{gen}'" for gen in params["gen_names"])
    if action_id.startswith("curtail_"):
        description = f"Renewable curtailment on evacuation antenna '{antenna}' (generators {gens})"
        unitaire = f"Effacement antenne '{antenna}' ({gens})"
    else:
        verb = "hausse" if params.get("direction") == "up" else "baisse"
        description = f"Redispatch on evacuation antenna '{antenna}' (generators {gens})"
        unitaire = f"Redispatch {verb} antenne '{antenna}' ({gens})"
    substation = params.get("substation")
    if substation:
        description += f", sized at attachment '{substation}'"
    return description, unitaire


def antenna_aggregate_descriptions(action_scores: Any, action_id: str) -> dict[str, str]:
    """``{"description", "description_unitaire"}`` of ``action_id`` when it is
    an antenna aggregate of ``action_scores`` (the library leaves them empty
    for the actions its discovery creates), else ``{}``."""
    params = antenna_aggregate_params(action_scores, action_id)
    if params is None:
        return {}
    description, unitaire = describe_antenna_aggregate(action_id, params)
    return {"description": description, "description_unitaire": unitaire}


def antenna_aggregate_entry(action_id: str, params: dict) -> dict:
    """Action-dictionary entry of an antenna aggregate, at the recommender's
    setpoints (a ``target_mw`` is spread over its generators afterwards, by
    ``SimulationMixin._apply_target_mw_updates``)."""
    description, unitaire = describe_antenna_aggregate(action_id, params)
    return {
        "description": description,
        "description_unitaire": unitaire,
        "content": {"set_gen_p": antenna_aggregate_setpoints(params)},
    }
