# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0

"""Terminal-aware flow-delta math — pure numerics.

Two scalar entry points (``terminal_aware_delta``, ``apply_threshold``)
that document the convention, plus the vectorised orchestrator
(``compute_deltas``) used from the mixin hot-path. ``compute_asset_deltas``
is the load/generator-side analogue.

pypowsybl sign convention: positive = power *enters* at that terminal.
Our UI needs a symmetric "did the flow grow or shrink?" answer — the
helpers below pick the state with the stronger absolute value as the
reference direction and transform both terminals into that frame.
"""
from __future__ import annotations

from typing import Any

import numpy as np

# Deltas below 5% of the maximum absolute delta are silenced as "grey"
# — matches the category colouring the frontend uses.
CATEGORY_THRESHOLD_RATIO = 0.05


def terminal_aware_delta(after_val: float, before_val: float) -> tuple[float, bool]:
    """Direction-aware delta at a single observed terminal.

    Algorithm:
      1. Take absolute values of both states at the observed terminal.
      2. Reference direction = sign of the state with the stronger
         absolute value.
      3. Transform each value to match the reference direction:
         ``+abs(val)`` if same direction, ``-abs(val)`` if opposite.
      4. ``delta = transformed_after - transformed_before``.
      5. ``flip_arrow`` = ``True`` when the after state's visual arrow
         (which points based on ``after_val``'s sign) is geometrically
         opposite to the reference arrow.

    Delta sign matches the category colour:
      - positive (orange) = flow increased
      - negative (blue)   = flow decreased
    """
    abs_after = abs(after_val)
    abs_before = abs(before_val)

    if abs_after >= abs_before:
        ref_positive = after_val >= 0
    else:
        ref_positive = before_val >= 0

    def _signed(val) -> float:
        if val == 0:
            return 0.0
        same_dir = (val > 0) == ref_positive
        return abs(val) if same_dir else -abs(val)

    delta = _signed(after_val) - _signed(before_val)
    after_positive = after_val >= 0
    flip_arrow = bool(after_positive != ref_positive)
    return delta, flip_arrow


def select_terminal_for_branch(
    lid: str,
    avl1: dict,
    avl2: dict,
    bvl1: dict,
    bvl2: dict,
    vl_set: set[str] | frozenset[str],
) -> int:
    """Pick which terminal (1 or 2) to observe for a branch.

    Prefers the terminal whose voltage level is in the requested set;
    falls back to terminal 1 when both or neither match.
    """
    if not vl_set:
        return 1
    v1 = avl1.get(lid) or bvl1.get(lid)
    v2 = avl2.get(lid) or bvl2.get(lid)
    if v1 in vl_set and v2 not in vl_set:
        return 1
    if v2 in vl_set and v1 not in vl_set:
        return 2
    return 1


def apply_threshold(deltas: dict[str, float]) -> dict[str, dict]:
    """Categorise raw deltas using a 5% threshold of the max absolute delta.

    Returns ``{id: {"delta", "category"}}`` where category ∈
    ``{"positive", "negative", "grey"}``.
    """
    if deltas:
        max_abs = max(abs(d) for d in deltas.values())
    else:
        max_abs = 0.0
    threshold = max_abs * CATEGORY_THRESHOLD_RATIO

    result: dict[str, dict] = {}
    for lid, delta in deltas.items():
        if abs(delta) < threshold:
            cat = "grey"
        elif delta > 0:
            cat = "positive"
        else:
            cat = "negative"
        result[lid] = {"delta": round(float(delta), 1), "category": cat}
    return result


def _compute_delta_vectorized(after: np.ndarray, before: np.ndarray) -> tuple:
    """Vectorised equivalent of ``terminal_aware_delta`` over parallel arrays.

    Returns ``(delta, flip)`` arrays aligned with the inputs.
    """
    abs_a = np.abs(after)
    abs_b = np.abs(before)
    ref_pos = np.where(abs_a >= abs_b, after >= 0, before >= 0)
    a_ref = np.where(ref_pos, after, -after)
    b_ref = np.where(ref_pos, before, -before)
    delta = a_ref - b_ref
    flip = (after >= 0) != ref_pos
    return delta, flip


def _categorise_vectorized(deltas: np.ndarray) -> np.ndarray:
    """Numpy analogue of :func:`apply_threshold` category assignment."""
    max_abs = float(np.max(np.abs(deltas))) if len(deltas) > 0 else 0.0
    thresh = max_abs * CATEGORY_THRESHOLD_RATIO
    cats = np.full(len(deltas), "grey", dtype=object)
    if max_abs > 0:
        mask_sig = np.abs(deltas) >= thresh
        cats[mask_sig] = np.where(deltas[mask_sig] > 0, "positive", "negative")
    return cats


def compute_deltas(
    after_flows: dict,
    before_flows: dict,
    voltage_level_ids: list[str] | None = None,
) -> dict:
    """Per-branch P and Q deltas between two flow snapshots.

    Terminal-aware: for each branch, picks the terminal whose voltage
    level matches one of ``voltage_level_ids``. P and Q deltas are
    computed independently on that terminal's values.

    Returns ``{"flow_deltas": {id: {delta, category, flip_arrow}},
    "reactive_flow_deltas": {id: ...}}``.
    """
    import pandas as pd

    df_after = pd.DataFrame(after_flows)
    df_before = pd.DataFrame(before_flows)

    all_ids = df_after.index.union(df_before.index)
    df_after = df_after.reindex(all_ids).fillna(0.0)
    df_before = df_before.reindex(all_ids).fillna(0.0)

    vl_set = set(voltage_level_ids) if voltage_level_ids else set()
    terminal_mask = np.ones(len(all_ids), dtype=int)
    if vl_set:
        v1 = df_after["vl1"]
        v2 = df_after["vl2"]
        is_v1 = v1.isin(vl_set)
        is_v2 = v2.isin(vl_set)
        terminal_mask[~is_v1 & is_v2] = 2

    a_p = np.where(terminal_mask == 1, df_after["p1"], df_after["p2"])
    b_p = np.where(terminal_mask == 1, df_before["p1"], df_before["p2"])
    a_q = np.where(terminal_mask == 1, df_after["q1"], df_after["q2"])
    b_q = np.where(terminal_mask == 1, df_before["q1"], df_before["q2"])

    dp, flip_p = _compute_delta_vectorized(a_p, b_p)
    dq, flip_q = _compute_delta_vectorized(a_q, b_q)
    cats_p = _categorise_vectorized(dp)
    cats_q = _categorise_vectorized(dq)

    res_p: dict[str, dict] = {}
    res_q: dict[str, dict] = {}
    for i, lid in enumerate(all_ids):
        res_p[lid] = {
            "delta": round(float(dp[i]), 1),
            "category": cats_p[i],
            "flip_arrow": bool(flip_p[i]),
        }
        res_q[lid] = {
            "delta": round(float(dq[i]), 1),
            "category": cats_q[i],
            "flip_arrow": bool(flip_q[i]),
        }

    return {"flow_deltas": res_p, "reactive_flow_deltas": res_q}


def _categorise_scalar(delta: float, max_abs: float, threshold: float) -> str:
    if max_abs == 0.0 or abs(delta) < threshold:
        return "grey"
    return "positive" if delta > 0 else "negative"


def compute_asset_deltas(after_asset_flows: dict, before_asset_flows: dict) -> dict:
    """Per-asset P and Q deltas between two flow snapshots.

    Returns ``{asset_id: {delta_p, delta_q, category, category_p, category_q}}``.
    The legacy ``category`` field tracks the P delta (kept for frontend
    backwards-compatibility).
    """
    all_ids = set(after_asset_flows.keys()) | set(before_asset_flows.keys())
    raw_p: dict[str, float] = {}
    raw_q: dict[str, float] = {}
    for aid in all_ids:
        a = after_asset_flows.get(aid, {"p": 0.0, "q": 0.0})
        b = before_asset_flows.get(aid, {"p": 0.0, "q": 0.0})
        raw_p[aid] = a["p"] - b["p"]
        raw_q[aid] = a["q"] - b["q"]

    max_abs_p = max((abs(d) for d in raw_p.values()), default=0.0)
    max_abs_q = max((abs(d) for d in raw_q.values()), default=0.0)
    threshold_p = max_abs_p * CATEGORY_THRESHOLD_RATIO
    threshold_q = max_abs_q * CATEGORY_THRESHOLD_RATIO

    result: dict[str, Any] = {}
    for aid in all_ids:
        dp = raw_p[aid]
        dq = raw_q[aid]
        cat_p = _categorise_scalar(dp, max_abs_p, threshold_p)
        cat_q = _categorise_scalar(dq, max_abs_q, threshold_q)
        result[aid] = {
            "delta_p": round(float(dp), 1),
            "delta_q": round(float(dq), 1),
            "category": cat_p,
            "category_p": cat_p,
            "category_q": cat_q,
        }
    return result
