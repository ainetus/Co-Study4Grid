# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0
# This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

"""``context_map_service`` — the per-study state behind the Context tab.

Lifecycle: ``/api/config`` calls ``capture`` right after loading the
network (snapshot of the file's state, see ``snapshot``); the first
``GET /api/context-map`` builds the map from that snapshot and the
study's layout, and caches it until the next capture. That GET may come
while ``/api/config`` is still loading the action space: the frontend
polls as soon as it sends the config, and recognises the new study's
map by its ``capture_id``. Building never
touches the shared ``Network``, so it needs no network lock and never
waits behind a NAD generation — which is what lets the Context tab show
up well before the N-state diagram.
"""
from __future__ import annotations

import logging
import threading
import time
from pathlib import Path
from typing import Any

from expert_backend.services.context_map.builder import (
    ContextMap,
    build_context_map,
    element_geometry,
)
from expert_backend.services.context_map.georef import load_layout_points
from expert_backend.services.context_map.plants import load_plant_matching, resolve_plants_path
from expert_backend.services.context_map.situation import load_situation, resolve_situation_path
from expert_backend.services.context_map.snapshot import NetworkSnapshot, capture_snapshot

logger = logging.getLogger(__name__)

LAYOUT_FILE_NAME = "grid_layout.json"


def resolve_layout_path(layout_path: str | None, network_path: str | None) -> Path | None:
    """The study's layout: the configured one, else a ``grid_layout.json``
    beside the network file (as the bundled grids ship it)."""
    if layout_path:
        return Path(layout_path)
    if not network_path:
        return None
    network = Path(network_path)
    candidate = (network if network.is_dir() else network.parent) / LAYOUT_FILE_NAME
    return candidate if candidate.is_file() else None


class ContextMapService:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._snapshot: NetworkSnapshot | None = None
        self._layout_path: Path | None = None
        self._map: ContextMap | None = None
        #: Bumped by every successful capture and stamped on the payload, so
        #: a client polling during ``/api/config`` can tell the new study's
        #: map from the previous one (served until the reset).
        self._capture_id = 0

    def reset(self) -> None:
        with self._lock:
            self._snapshot, self._layout_path, self._map = None, None, None

    def capture(self, network: Any, layout_path: str | None = None,
                network_path: str | None = None) -> None:
        """Snapshot a freshly loaded network. Never raises: a failure only
        leaves the Context tab empty, it must not fail the study load."""
        self.reset()
        try:
            start = time.perf_counter()
            snapshot = capture_snapshot(network)
            snapshot.plants = load_plant_matching(resolve_plants_path(network_path))
            snapshot.situation = load_situation(resolve_situation_path(network_path))
            logger.info("Context map: network captured in %.3fs%s", time.perf_counter() - start,
                        " (+ matched power plants)" if snapshot.plants else "")
        except Exception:
            logger.exception("Context map: network capture failed")
            return
        with self._lock:
            self._snapshot = snapshot
            self._layout_path = resolve_layout_path(layout_path, network_path)
            self._capture_id += 1

    def get_map(self) -> ContextMap | None:
        """The built map (lazily, once per capture); ``None`` before a load."""
        with self._lock:
            if self._map is None and self._snapshot is not None:
                start = time.perf_counter()
                layout = load_layout_points(self._layout_path)
                self._map = build_context_map(self._snapshot, layout)
                self._map.payload["capture_id"] = self._capture_id
                payload = self._map.payload
                if payload["available"]:
                    logger.info("Context map: built in %.3fs (%s mesh, georef=%s)",
                                time.perf_counter() - start, payload["mesh"], payload["georef"])
                else:
                    logger.info("Context map: none for this network — %s", payload["unavailable_reason"])
            return self._map

    def elements(self, element_ids: list[str]) -> list[dict]:
        """Map geometry of the given elements (unknown ids are skipped)."""
        cmap = self.get_map()
        if cmap is None or self._snapshot is None or not cmap.payload["available"]:
            return []
        found = (element_geometry(cmap, self._snapshot, eid) for eid in element_ids)
        return [g for g in found if g is not None]


context_map_service = ContextMapService()
