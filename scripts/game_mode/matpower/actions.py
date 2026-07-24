# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# SPDX-License-Identifier: MPL-2.0
"""Build the curated topological action space for a node-breaker MATPOWER grid.

The recommender discovers node-splitting (``open_coupling``) actions by scanning
the action dictionary it is configured with — an empty ``actions.json`` yields
only the auto-generated line disconnections. This emits the Co-Study4Grid action
schema (same shape as ``data/rte7000_tht/grids/<id>/actions.json``):

    "<id>": {description, description_unitaire, switches: {<switchId>: true},
             VoltageLevelId: <vl>}

so every coupler breaker built by ``node_breaker.rebuild_node_breaker`` becomes a
playable "open the coupling" lever.
"""
from __future__ import annotations

import collections


def build_action_space(net, include_disco: bool = False) -> dict:
    """Return ``{action_id: action}`` for every coupler breaker (and, optionally,
    a disconnection per line — the backend auto-generates those otherwise)."""
    actions: dict = {}
    sw = net.get_switches(all_attributes=True)
    per_vl: dict = collections.Counter()
    for sid, r in sw.iterrows():
        name = str(r.get("name") or sid).upper()
        if r["kind"] != "BREAKER" or ("COUPL" not in name and "TRO" not in name):
            continue
        vl = r["voltage_level_id"]
        per_vl[vl] += 1
        # RTE7000 uses open_coupler_<vl>; our rebuild can chain several couplers
        # in one VL, so disambiguate from the second onward.
        aid = f"open_coupler_{vl}" if per_vl[vl] == 1 else f"open_coupler_{vl}_{per_vl[vl]}"
        desc = f"Ouverture du couplage '{sid}' dans le poste '{vl}'"
        actions[aid] = {
            "description": desc,
            "description_unitaire": desc,
            "switches": {str(sid): True},
            "VoltageLevelId": str(vl),
        }
    if include_disco:
        for lid in net.get_lines().index:
            actions[f"disco_{lid}"] = {
                "description": f"Ouverture de la ligne '{lid}'",
                "description_unitaire": f"Ouverture de la ligne '{lid}'",
                "switches": {},
                "VoltageLevelId": "",
            }
    return actions
