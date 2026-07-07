# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0
"""Filter action-dictionary candidates to those touching overflow-graph paths.

``ActionRuleValidator.categorize_actions`` (the expert library's rule
filter) removes broadly invalid entries (wrong shape, already-open
lines, missing devices, ...) but does NOT narrow the action set to
ones relevant to the current overflow analysis — that *targeting*
happens inside :class:`ActionDiscoverer`'s per-type ``find_relevant_*``
mixins (line reconnection / disconnection / node merging / splitting /
PST / load shedding / curtailment), each consuming the path lists
built from ``g_distribution_graph``.

Sampling models like :class:`RandomOverflowRecommender` don't call
the per-type mixins, so they need an explicit path filter to stay
inside the reduced action space the operator expects. This module
implements that filter as a pure function the recommender invokes
before sampling.
"""
from __future__ import annotations

import logging
from typing import Any, Iterable, Optional

import numpy as np

logger = logging.getLogger(__name__)


def _resolve_node_to_name(node: Any, name_sub_arr: Any, n_subs: int) -> Optional[str]:
    """Coerce a node reference from the distribution graph to a substation name.

    Different builds of ``Structured_Overload_Distribution_Graph`` expose
    nodes either as integer indices into ``obs.name_sub`` (legacy) or
    directly as substation-name strings (current). Both shapes are
    accepted; anything that fails the dual coercion returns ``None``.
    """
    if node is None:
        return None
    # Native Python int OR any numpy integer.
    if isinstance(node, (int, np.integer)):
        if name_sub_arr is not None and int(node) < n_subs:
            return str(name_sub_arr[int(node)])
        return None
    # Numpy / Python strings, plus the rare bytes case.
    if isinstance(node, (str, np.str_)):
        return str(node)
    if isinstance(node, bytes):
        try:
            return node.decode("utf-8")
        except Exception:
            return None
    # Last-ditch attempt.
    try:
        return str(node)
    except Exception:
        return None


def _extract_path_targets(
    distribution_graph: Any,
    obs: Any,
    hubs: Optional[Iterable[str]],
) -> Optional[tuple[set, set]]:
    """Read the path-level targets the expert pipeline computes.

    Mirrors the extraction done by ``OrchestratorMixin.discover_and_prioritize``:

    - dispatch path (line reconnection / disconnection candidates) +
      constrained path (disconnection / PST candidates) → ``relevant_lines``
    - dispatch loop nodes (close coupling candidates) +
      blue path nodes (open coupling / PST candidates) + hub
      substations (node splitting candidates) → ``relevant_subs``

    Returns ``None`` when the graph is missing or extraction fails —
    callers treat that as "can't narrow, keep everything". Node-id
    coercion handles both integer-indexed and string-name graphs.
    """
    if distribution_graph is None:
        return None
    try:
        name_sub_arr = None
        n_subs = 0
        if obs is not None:
            try:
                name_sub_arr = np.array(obs.name_sub)
                n_subs = len(name_sub_arr)
            except Exception as e:
                logger.debug(
                    "overflow-path-filter: obs.name_sub unavailable (%s); "
                    "node coercion will rely on already-named entries.", e,
                )

        lines_dispatch, _ = distribution_graph.get_dispatch_edges_nodes(
            only_loop_paths=False
        )
        _, nodes_dispatch_loop = distribution_graph.get_dispatch_edges_nodes(
            only_loop_paths=True
        )
        (
            lines_constrained,
            nodes_constrained,
            _other_blue_edges,
            other_blue_nodes,
        ) = distribution_graph.get_constrained_edges_nodes()

        relevant_lines: set = set()
        for line in lines_dispatch:
            if line is not None:
                relevant_lines.add(str(line))
        for line in lines_constrained:
            if line is not None:
                relevant_lines.add(str(line))

        relevant_subs: set = set()
        for node in nodes_dispatch_loop:
            resolved = _resolve_node_to_name(node, name_sub_arr, n_subs)
            if resolved:
                relevant_subs.add(resolved)
        for node in list(nodes_constrained) + list(other_blue_nodes):
            resolved = _resolve_node_to_name(node, name_sub_arr, n_subs)
            if resolved:
                relevant_subs.add(resolved)
        for hub in hubs or []:
            if hub is not None:
                relevant_subs.add(str(hub))

        return relevant_lines, relevant_subs
    except Exception as e:
        logger.warning(
            "overflow-path-filter: could not extract path targets (%s); "
            "skipping narrow filter.", e,
        )
        return None


def _action_touches_path(
    action_id: str,
    entry: Any,
    relevant_lines: set,
    relevant_subs: set,
) -> bool:
    """Return True when the action's declared target is on an overflow path."""
    if not isinstance(entry, dict):
        return False

    # 1. Voltage level hint (pypowsybl switch-based actions). Coupling /
    # node-splitting actions land here when their VoltageLevelId is
    # part of the blue / dispatch-loop path or a hub.
    vl = entry.get("VoltageLevelId") or entry.get("voltage_level_id")
    if vl and str(vl) in relevant_subs:
        return True

    # 2. set_bus line ids (grid2op-style line actions). Disco / reco
    # / PST actions land here when their lines are on the dispatch or
    # constrained path.
    content = entry.get("content")
    if isinstance(content, dict):
        set_bus = content.get("set_bus")
        if isinstance(set_bus, dict):
            for key in ("lines_or_id", "lines_ex_id"):
                ids = set_bus.get(key)
                if isinstance(ids, dict):
                    for line_id in ids:
                        if str(line_id) in relevant_lines:
                            return True
        # PST tap entries also count.
        pst_tap = content.get("pst_tap")
        if isinstance(pst_tap, dict):
            for line_id in pst_tap:
                if str(line_id) in relevant_lines:
                    return True

    # 3. action-id suffix heuristic for synthetic / auto-generated
    # disco_/reco_ entries whose `content` is built lazily and may not
    # be loaded at filter time.
    for prefix in ("disco_", "reco_"):
        if action_id.startswith(prefix):
            line_candidate = action_id[len(prefix):]
            if line_candidate in relevant_lines:
                return True
            break

    # 4. UUID-prefixed coupling action IDs of the form
    # ``<uuid>_<VL>_<switch>`` or ``<uuid>_<VL>_coupling``. Check whether
    # any relevant substation appears as an underscore-delimited segment
    # of the action id. Substation names themselves routinely contain
    # underscores (``VL_LOOP``), so a naive per-chunk split would never
    # match them — pad both sides with ``_`` and substring-match instead
    # (the padding keeps the match anchored to segment boundaries, so
    # ``VL_LOOP`` cannot fire on ``XVL_LOOPY``). Conservative: a hit on
    # a relevant_sub is enough.
    padded_id = f"_{action_id}_"
    for sub in relevant_subs:
        if sub and f"_{sub}_" in padded_id:
            return True

    return False


def restrict_to_overflow_paths(
    candidate_ids: Iterable[str],
    dict_action: Any,
    distribution_graph: Any,
    obs: Any,
    hubs: Optional[Iterable[str]] = None,
) -> list[str]:
    """Keep only candidates that touch an overflow-graph path target.

    Conservative when the path extraction itself fails (returns the
    input list unchanged) — never silently empties the candidate
    pool because the filter errored.
    """
    targets = _extract_path_targets(distribution_graph, obs, hubs)
    if targets is None:
        return list(candidate_ids)
    relevant_lines, relevant_subs = targets

    if not relevant_lines and not relevant_subs:
        logger.info(
            "overflow-path-filter: distribution graph yielded empty path "
            "target sets; returning []."
        )
        return []

    if not dict_action:
        return list(candidate_ids)

    kept: list[str] = []
    dropped: list[str] = []
    for aid in candidate_ids:
        entry = dict_action.get(aid)
        if entry is None:
            continue
        if _action_touches_path(aid, entry, relevant_lines, relevant_subs):
            kept.append(aid)
        else:
            dropped.append(aid)

    logger.info(
        "overflow-path-filter: kept %d / dropped %d action(s) "
        "(relevant lines=%d, subs=%d).",
        len(kept), len(dropped), len(relevant_lines), len(relevant_subs),
    )
    if dropped:
        logger.debug("overflow-path-filter: sample dropped: %s", dropped[:5])
    return kept
