# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# SPDX-License-Identifier: MPL-2.0
"""Convert a MATPOWER-derived pypowsybl network's APPARENT_POWER (MVA)
permanent limits into CURRENT (A) permanent limits.

The pypowsybl MATPOWER importer materialises each branch's RATE_A/B/C as
APPARENT_POWER operational limits, but Co-Study4Grid's backend and the
``expert_op4grid_recommender`` grid2op layer both read **CURRENT** permanent
limits (``type == 'CURRENT' & acceptable_duration == -1``; see
``expert_backend/services/network_service.py``). Without them a matpower
network reports zero line loadings. Conversion per side:

    I[A] = S[MVA] * 1000 / (sqrt(3) * V[kV])

using the side's nominal voltage. Branches whose RATE_A is 0 (unlimited in
the matpower convention) get no current limit and are therefore not monitored.
"""
from __future__ import annotations

import math

import pandas as pd


def add_current_limits(net) -> int:
    """Add CURRENT permanent limits derived from APPARENT_POWER ones. Returns
    the number of (element, side) current limits created."""
    ol = net.get_operational_limits(all_attributes=True).reset_index()
    perm = ol[(ol["type"] == "APPARENT_POWER")
              & (ol["acceptable_duration"] == -1)
              & (ol["name"] == "permanent_limit")]
    lines = net.get_lines()
    t2 = net.get_2_windings_transformers()
    nom = net.get_voltage_levels()["nominal_v"].to_dict()
    l_v1 = lines["voltage_level1_id"].to_dict()
    l_v2 = lines["voltage_level2_id"].to_dict()
    t_v1 = t2["voltage_level1_id"].to_dict()
    t_v2 = t2["voltage_level2_id"].to_dict()

    def side_v(eid, side):
        if eid in l_v1:
            vl = l_v1[eid] if side == "ONE" else l_v2[eid]
        elif eid in t_v1:
            vl = t_v1[eid] if side == "ONE" else t_v2[eid]
        else:
            return None
        return nom.get(vl)

    rows = []
    for r in perm.itertuples(index=False):
        v = side_v(r.element_id, r.side)
        if not v or v <= 0 or r.value <= 0:
            continue
        amps = float(r.value) * 1000.0 / (math.sqrt(3.0) * float(v))
        rows.append((str(r.element_id), str(r.side), "permanent_limit",
                     "CURRENT", float(amps), -1))
    if not rows:
        return 0
    df = pd.DataFrame(
        rows,
        columns=["element_id", "side", "name", "type", "value", "acceptable_duration"],
    ).set_index("element_id")
    net.create_operational_limits(df)
    return len(df)
