# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0

"""Overload-detection helpers over pypowsybl networks.

Three entry points:
  - :func:`get_element_max_currents` — ``{element_id: max(|i1|,|i2|)}``
    for every line and 2-winding transformer. Used as the N-state
    reference for pre-existing-overload filtering.
  - :func:`get_overloaded_lines` — filters the above against the
    permanent current limits, the monitoring set, and an optional
    N-state reference (to exclude pre-existing overloads unless
    worsened).
  - :func:`get_n_state_loading` — the N-state loading of given elements
    (what a contingency's overloads carried before it).

Both use narrow pypowsybl queries (only ``i1``, ``i2``) + numpy
vectorisation — on the 10 k-branch PyPSA-EUR France grid the overload
scan dropped from ~1,170 ms to ~330 ms and the max-currents scan from
~300-700 ms to a few tens of ms.
"""
from __future__ import annotations

from typing import Any

import numpy as np

from expert_backend.services.sanitize import sanitize_for_json

# Default MONITORING_FACTOR / WORSENING_THRESHOLD values that match
# `expert_op4grid_recommender.config` at load time. The mixin overrides
# these per call.
DEFAULT_MONITORING_FACTOR = 0.95
DEFAULT_WORSENING_THRESHOLD = 0.02


def _limit_dict(network: Any) -> dict[str, float]:
    """Build ``{element_id: permanent_current_limit}`` for the network."""
    limits = network.get_operational_limits(attributes=["value"])
    if len(limits.index) == 0:
        return {}
    limits = limits.reset_index()
    current_limits = limits[
        (limits["type"] == "CURRENT") & (limits["acceptable_duration"] == -1)
    ]
    return dict(zip(current_limits["element_id"], current_limits["value"]))


def get_element_max_currents(network: Any) -> dict[str, float]:
    """Return ``{element_id: max(|i1|,|i2|)}`` for all lines + 2-winding transformers.

    Rows where either ``i1`` or ``i2`` is NaN are excluded from the
    returned dict (semantics preserved from the pre-extraction mixin).
    """
    currents: dict[str, float] = {}
    for df in [
        network.get_lines(attributes=["i1", "i2"]),
        network.get_2_windings_transformers(attributes=["i1", "i2"]),
    ]:
        if len(df.index) == 0:
            continue
        i1 = df["i1"].values
        i2 = df["i2"].values
        mask = ~(np.isnan(i1) | np.isnan(i2))
        if not mask.any():
            continue
        idx = df.index.values[mask]
        max_i = np.maximum(np.abs(i1[mask]), np.abs(i2[mask]))
        currents.update(zip(idx, max_i.tolist()))
    return currents


def get_overloaded_lines(
    network: Any,
    n_state_currents: dict[str, float] | None = None,
    lines_we_care_about: set[str] | None = None,
    with_rho: bool = False,
    monitoring_factor: float = DEFAULT_MONITORING_FACTOR,
    worsening_threshold: float = DEFAULT_WORSENING_THRESHOLD,
):
    """Return overloaded element IDs (and optionally their rho values).

    Rules:
      1. Only elements with a permanent current limit are monitored.
      2. Restricted to ``lines_we_care_about`` when provided.
      3. An element is "overloaded" when ``max_i >= limit * monitoring_factor``.
         The ``>=`` comparison aligns the N Overloads UI panel with the
         backend simulation filter (``simulation_helpers.build_care_mask``)
         which uses ``base_rho >= mf``. Without this alignment a line
         sitting just at the threshold would surface as "no N overload"
         in the UI but be silently filtered as "pre-existing overload"
         by the simulation.
      4. When ``n_state_currents`` is provided, pre-existing overloads
         (elements already overloaded in N) are excluded UNLESS the
         current moved outside the symmetric ``±worsening_threshold``
         band around its N value. This keeps lines in the action's
         sensitive area (whether worsened or improved) while still
         filtering out lines that belong to other issues.

    Returns a sanitised list by default; with ``with_rho=True`` returns
    ``(names, rhos)`` parallel lists.
    """
    limit_dict = _limit_dict(network)

    lines = network.get_lines(attributes=["i1", "i2"])
    trafos = network.get_2_windings_transformers(attributes=["i1", "i2"])

    overloaded: list[str] = []
    overloaded_rho: list[float] = []

    for df in (lines, trafos):
        if len(df.index) == 0:
            continue
        idx = df.index.values
        i1_arr = np.nan_to_num(df["i1"].values, nan=0.0)
        i2_arr = np.nan_to_num(df["i2"].values, nan=0.0)
        max_i_arr = np.maximum(np.abs(i1_arr), np.abs(i2_arr))

        for j, element_id in enumerate(idx):
            if lines_we_care_about is not None and element_id not in lines_we_care_about:
                continue
            limit = limit_dict.get(element_id)
            if limit is None:
                continue

            max_i = max_i_arr[j]
            if max_i >= limit * monitoring_factor:
                if n_state_currents is not None and element_id in n_state_currents:
                    n_max_i = n_state_currents[element_id]
                    if n_max_i >= limit * monitoring_factor:
                        # Was already overloaded in N — keep only if the
                        # action moved the line outside the symmetric
                        # ±worsening_threshold band around its N value.
                        lower = n_max_i * (1 - worsening_threshold)
                        upper = n_max_i * (1 + worsening_threshold)
                        if lower <= max_i <= upper:
                            continue
                overloaded.append(element_id)
                overloaded_rho.append(float(max_i / limit) if limit else 0.0)

    if with_rho:
        return sanitize_for_json(overloaded), sanitize_for_json(overloaded_rho)
    return sanitize_for_json(overloaded)


def get_branch_loading(network: Any) -> dict[str, float]:
    """Loading rate, in percent of the permanent current limit, of every
    line and 2-winding transformer that has one — ``max(|i1|, |i2|) / limit``,
    the same measure as the overload scan. A disconnected branch (NaN
    currents) reads 0 %. Rounded to 0.1 % to keep the payload light: the
    whole grid rides in every NAD response for the Loading view."""
    limit_dict = _limit_dict(network)
    loading: dict[str, float] = {}
    if not limit_dict:
        return loading
    for df in (
        network.get_lines(attributes=["i1", "i2"]),
        network.get_2_windings_transformers(attributes=["i1", "i2"]),
    ):
        if len(df.index) == 0:
            continue
        idx = df.index.values
        max_i = np.maximum(
            np.abs(np.nan_to_num(df["i1"].values, nan=0.0)),
            np.abs(np.nan_to_num(df["i2"].values, nan=0.0)),
        )
        limits = np.array([limit_dict.get(e, np.nan) for e in idx], dtype=float)
        mask = np.isfinite(limits) & (limits > 0)
        if not mask.any():
            continue
        pct = np.round(max_i[mask] / limits[mask] * 100.0, 1)
        loading.update(zip(idx[mask].tolist(), pct.tolist()))
    return loading


def get_n_state_loading(
    network: Any,
    element_ids: list[str],
    n_state_currents: dict[str, float] | None,
) -> list[float | None]:
    """Loading (``max_i / permanent limit``) of each element in the N state,
    parallel to ``element_ids`` — the "before" of a contingency's overloads.
    ``None`` where the N currents or the limit are unknown."""
    if not n_state_currents:
        return [None] * len(element_ids)
    limit_dict = _limit_dict(network)
    loading: list[float | None] = []
    for element_id in element_ids:
        limit = limit_dict.get(element_id)
        current = n_state_currents.get(element_id)
        loading.append(float(current / limit) if limit and current is not None else None)
    return sanitize_for_json(loading)
