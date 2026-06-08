# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0

"""MW-at-start computation per action type — pure numerical helpers.

Each action type has a different rule for "what is the starting
megawatt exposure":

  line_disconnection: |p_or| of the disconnected line in N-1 state
  pst_tap_change:     |p_or| of the PST line in N-1 state
  load_shedding:      load_p of the load in N-1 state
  renewable_curtail.: prod_p of the generator in N-1 state
  open_coupling:      virtual-line MW of the elements moved to bus 1
  line_reconnection:  N/A
  close_coupling:     N/A

The formerly-instance methods live here as plain functions so they
can be tested with tiny mock observations.
"""
from __future__ import annotations

import logging
from typing import Any, Callable

from expert_op4grid_recommender.utils.superposition import (
    get_virtual_line_flow as _default_virtual_line_flow,
)

logger = logging.getLogger(__name__)


def _gen_active_power(obs: Any, idx: int) -> float:
    """Return ``abs(gen_p[idx])`` preferring ``gen_p`` (new) over ``prod_p`` (legacy)."""
    if hasattr(obs, "gen_p"):
        return abs(float(obs.gen_p[idx]))
    return abs(float(obs.prod_p[idx]))


def is_na_action_type(action_type: str) -> bool:
    """Return True for action types where MW-at-start is not defined."""
    t = action_type.lower()
    return "reco" in t or "line_reconnection" in t or "close_coupling" in t


def classify_action_type(action_type: str) -> str:
    """Return a normalised tag: 'disco' | 'pst' | 'load_shedding' | 'curtail' | 'redispatch' | 'open' | 'other'."""
    t = action_type.lower()
    if "load_shedding" in t or "ls" in t:
        return "load_shedding"
    if "redispatch" in t:
        return "redispatch"
    if "renewable_curtailment" in t or "curtail" in t:
        return "curtail"
    if "disco" in t or "line_disconnection" in t:
        return "disco"
    if "pst" in t:
        return "pst"
    if "open_coupling" in t:
        return "open"
    return "other"


def mw_start_load_shedding(
    action_id: str,
    action_entry: dict | None,
    obs_n1: Any,
    load_idx_map: dict[str, int],
) -> float | None:
    """MW at start for a load-shedding action.

    Tries, in order:
      1a. ``content.set_load_p`` (new power-reduction format)
      1b. ``content.set_bus.loads_id`` with bus = -1 (legacy format)
      2.  ``load_shedding_<name>`` action-ID pattern
    """
    if action_entry is not None:
        content = action_entry.get("content", {})
        if content:
            set_load_p = content.get("set_load_p", {})
            if set_load_p:
                total_mw = 0.0
                found = False
                for load_name in set_load_p:
                    if load_name in load_idx_map:
                        total_mw += abs(float(obs_n1.load_p[load_idx_map[load_name]]))
                        found = True
                if found:
                    return round(total_mw, 1)

            set_bus = content.get("set_bus", {})
            loads = set_bus.get("loads_id", {})
            total_mw = 0.0
            found = False
            for load_name, bus in loads.items():
                if int(bus) == -1 and load_name in load_idx_map:
                    total_mw += abs(float(obs_n1.load_p[load_idx_map[load_name]]))
                    found = True
            if found:
                return round(total_mw, 1)

    if action_id.startswith("load_shedding_"):
        load_name = action_id[len("load_shedding_"):]
        if load_name in load_idx_map:
            return round(abs(float(obs_n1.load_p[load_idx_map[load_name]])), 1)
    return None


def mw_start_curtailment(
    action_id: str,
    action_entry: dict | None,
    obs_n1: Any,
    gen_idx_map: dict[str, int],
) -> float | None:
    """MW at start for a renewable-curtailment action."""
    if action_entry is not None:
        content = action_entry.get("content", {})
        if content:
            set_gen_p = content.get("set_gen_p", {})
            if set_gen_p:
                total_mw = 0.0
                found = False
                for gen_name in set_gen_p:
                    if gen_name in gen_idx_map:
                        total_mw += _gen_active_power(obs_n1, gen_idx_map[gen_name])
                        found = True
                if found:
                    return round(total_mw, 1)

            set_bus = content.get("set_bus", {})
            gens = set_bus.get("generators_id", {})
            total_mw = 0.0
            found = False
            for gen_name, bus in gens.items():
                if int(bus) == -1 and gen_name in gen_idx_map:
                    total_mw += _gen_active_power(obs_n1, gen_idx_map[gen_name])
                    found = True
            if found:
                return round(total_mw, 1)

    if action_id.startswith("curtail_"):
        gen_name = action_id[len("curtail_"):]
        if gen_name in gen_idx_map:
            return round(_gen_active_power(obs_n1, gen_idx_map[gen_name]), 1)
    return None


def mw_start_redispatch(
    action_id: str,
    action_entry: dict | None,
    obs_n1: Any,
    gen_idx_map: dict[str, int],
) -> float | None:
    """MW at start for a redispatching action.

    Like curtailment, this is the generator's current active power in N-1
    state — the baseline the operator raises/lowers from. Resolves the
    generator from ``content.set_gen_p`` or the ``redispatch_<name>`` id.
    """
    if action_entry is not None:
        content = action_entry.get("content", {})
        if content:
            set_gen_p = content.get("set_gen_p", {})
            if set_gen_p:
                total_mw = 0.0
                found = False
                for gen_name in set_gen_p:
                    if gen_name in gen_idx_map:
                        total_mw += _gen_active_power(obs_n1, gen_idx_map[gen_name])
                        found = True
                if found:
                    return round(total_mw, 1)

    if action_id.startswith("redispatch_"):
        gen_name = action_id[len("redispatch_"):]
        if gen_name in gen_idx_map:
            return round(_gen_active_power(obs_n1, gen_idx_map[gen_name]), 1)
    return None


def mw_start_line_disconnection(
    action_entry: dict,
    obs_n1: Any,
    line_idx_map: dict[str, int],
) -> float | None:
    """Return |p_or| of the line the action disconnects (bus = -1)."""
    content = action_entry.get("content", {}) or {}
    set_bus = content.get("set_bus", {})
    for field in ("lines_or_id", "lines_ex_id"):
        bus_map = set_bus.get(field, {})
        for name, bus in bus_map.items():
            if int(bus) == -1 and name in line_idx_map:
                return round(abs(float(obs_n1.p_or[line_idx_map[name]])), 1)
    return None


def mw_start_pst(
    action_entry: dict,
    obs_n1: Any,
    line_idx_map: dict[str, int],
) -> float | None:
    """Return |p_or| of the PST transformer line (lookup by pst_tap name)."""
    content = action_entry.get("content", {}) or {}
    pst_tap = content.get("pst_tap", {})
    if not pst_tap:
        pst_tap = content.get("redispatch", {}).get("pst_tap", {})
    for pst_name in pst_tap:
        if pst_name in line_idx_map:
            return round(abs(float(obs_n1.p_or[line_idx_map[pst_name]])), 1)
    return None


def mw_start_open_coupling(
    set_bus: dict,
    obs_n1: Any,
    line_idx_map: dict[str, int],
    load_idx_map: dict[str, int],
    virtual_line_flow_fn: Callable | None = None,
) -> float | None:
    """Virtual-line MW for a node-splitting / open-coupling action.

    Delegates to ``virtual_line_flow_fn`` (defaults to the upstream
    ``expert_op4grid_recommender.utils.superposition.get_virtual_line_flow``)
    after partitioning ``set_bus`` elements by target bus and collecting
    observation indices for "bus 1" elements (the smallest positive bus
    number). Elements on bus -1 (disconnected) are excluded.

    The callable is injected so callers (the mixin, tests) can swap in
    a reference library implementation without monkey-patching at
    import time.
    """
    vlf = virtual_line_flow_fn or _default_virtual_line_flow

    all_buses = set()
    for key in ("lines_or_id", "lines_ex_id", "generators_id", "loads_id"):
        for _name, bus in set_bus.get(key, {}).items():
            b = int(bus)
            if b > 0:
                all_buses.add(b)
    if not all_buses:
        return None

    bus1 = min(all_buses)
    ind_lor = [line_idx_map[name] for name, bus in set_bus.get("lines_or_id", {}).items()
               if int(bus) == bus1 and name in line_idx_map]
    ind_lex = [line_idx_map[name] for name, bus in set_bus.get("lines_ex_id", {}).items()
               if int(bus) == bus1 and name in line_idx_map]

    gen_name_to_idx = {name: i for i, name in enumerate(obs_n1.name_gen)} if hasattr(obs_n1, "name_gen") else {}
    ind_prod = [gen_name_to_idx[name] for name, bus in set_bus.get("generators_id", {}).items()
                if int(bus) == bus1 and name in gen_name_to_idx]
    ind_load = [load_idx_map[name] for name, bus in set_bus.get("loads_id", {}).items()
                if int(bus) == bus1 and name in load_idx_map]

    if not (ind_lor or ind_lex or ind_prod or ind_load):
        return None

    flow = vlf(obs_n1, ind_load, ind_prod, ind_lor, ind_lex)
    return round(abs(flow), 1)


def get_action_mw_start(
    action_id: str,
    action_type: str,
    obs_n1: Any,
    line_idx_map: dict[str, int],
    load_idx_map: dict[str, int],
    gen_idx_map: dict[str, int],
    action_entry: dict | None,
    virtual_line_flow_fn: Callable | None = None,
) -> float | None:
    """Dispatch ``action_id`` to the right ``mw_start_*`` helper.

    Returns ``None`` when the action entry is missing for non-LS /
    non-curtailment types, or when the per-type math cannot locate the
    element in ``obs_n1``.
    """
    tag = classify_action_type(action_type)

    if tag == "load_shedding":
        return mw_start_load_shedding(action_id, action_entry, obs_n1, load_idx_map)
    if tag == "curtail":
        return mw_start_curtailment(action_id, action_entry, obs_n1, gen_idx_map)
    if tag == "redispatch":
        return mw_start_redispatch(action_id, action_entry, obs_n1, gen_idx_map)

    if action_entry is None:
        return None

    if tag == "disco":
        return mw_start_line_disconnection(action_entry, obs_n1, line_idx_map)
    if tag == "pst":
        return mw_start_pst(action_entry, obs_n1, line_idx_map)
    if tag == "open":
        content = action_entry.get("content", {}) or {}
        set_bus = content.get("set_bus", {})
        return mw_start_open_coupling(
            set_bus, obs_n1, line_idx_map, load_idx_map, virtual_line_flow_fn
        )
    return None


def get_pst_tap_start(
    action_entry: dict | None,
    initial_pst_taps: dict | None,
    pst_tap_info_fn: Any,
) -> dict | None:
    """Resolve the N-state PST tap + bounds for a PST action.

    Priority:
      1. ``parameters["previous tap"]`` inside the action entry (the
         authoritative N-state tap stored at action-dict load time),
         paired with bounds from ``initial_pst_taps`` or the live
         network manager.
      2. The full ``initial_pst_taps`` cache captured at network load
         time (tap + low_tap + high_tap).
      3. Live network manager fallback via ``pst_tap_info_fn``.
    """
    if action_entry is None:
        return None
    content = action_entry.get("content", {})
    if not content:
        return None
    pst_tap = content.get("pst_tap", {})
    if not pst_tap:
        pst_tap = content.get("redispatch", {}).get("pst_tap", {})
    if not pst_tap:
        return None

    pst_name = next(iter(pst_tap))

    params = action_entry.get("parameters", {})
    if params:
        prev_tap = params.get("previous tap")
        if prev_tap is not None:
            low_tap, high_tap = None, None
            if initial_pst_taps and pst_name in initial_pst_taps:
                low_tap = initial_pst_taps[pst_name].get("low_tap")
                high_tap = initial_pst_taps[pst_name].get("high_tap")
            elif pst_tap_info_fn is not None:
                try:
                    info = pst_tap_info_fn(pst_name)
                    if info:
                        low_tap = info.get("low_tap")
                        high_tap = info.get("high_tap")
                except Exception as e:
                    logger.debug("Suppressed exception: %s", e)
            return {
                "pst_name": pst_name,
                "tap": int(prev_tap),
                "low_tap": low_tap,
                "high_tap": high_tap,
            }

    if initial_pst_taps and pst_name in initial_pst_taps:
        info = initial_pst_taps[pst_name]
        return {
            "pst_name": pst_name,
            "tap": info["tap"],
            "low_tap": info["low_tap"],
            "high_tap": info["high_tap"],
        }

    if pst_tap_info_fn is not None:
        try:
            info = pst_tap_info_fn(pst_name)
            if info:
                return {
                    "pst_name": pst_name,
                    "tap": info.get("tap"),
                    "low_tap": info.get("low_tap"),
                    "high_tap": info.get("high_tap"),
                }
        except Exception as e:
            logger.debug("Suppressed exception: %s", e)
    return None
