# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0
# This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

"""Context tab HTTP routes — the Carte-Front situation map.

Registered on the app via :func:`install_context_map_routes` (same
install-once pattern as ``game_api``), kept out of ``main.py`` for the
module-size ceiling. Service: ``services/context_map``.

Neither route takes the network lock: the map is built from the snapshot
``/api/config`` captured at load, so it is served while the NAD prefetch
still holds the shared ``Network``.
"""
from __future__ import annotations

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel

from expert_backend.services.context_map import context_map_service
from expert_backend.services.gzip_response import maybe_gzip_json

_NO_STUDY_DETAIL = "No network loaded — load a study first."
#: Bound on one element lookup (contingency + its overloads, with margin).
MAX_ELEMENT_IDS = 500


class ContextMapElementsRequest(BaseModel):
    element_ids: list[str]


class ContextMapElementsResponse(BaseModel):
    elements: list[dict]


def install_context_map_routes(app: FastAPI) -> None:
    """Register the Context-tab routes on ``app`` (call once at import)."""

    @app.get("/api/context-map")
    def get_context_map(http_request: Request) -> Response:
        """Zones, production mix, consumption and inter-zone transfers of
        the loaded network, on a European basemap (see services/context_map)."""
        cmap = context_map_service.get_map()
        if cmap is None:
            raise HTTPException(status_code=404, detail=_NO_STUDY_DETAIL)
        # The basemap makes the payload ~100 kB, which gzip divides by four.
        return maybe_gzip_json(cmap.payload, http_request)

    @app.post("/api/context-map/elements", response_model=ContextMapElementsResponse)
    def get_context_map_elements(request: ContextMapElementsRequest) -> dict:
        """Map position of the elements the operator studies — the
        contingency and its overloads — in the frame of the context map."""
        if len(request.element_ids) > MAX_ELEMENT_IDS:
            raise HTTPException(status_code=400, detail=f"At most {MAX_ELEMENT_IDS} element ids.")
        if context_map_service.get_map() is None:
            raise HTTPException(status_code=404, detail=_NO_STUDY_DETAIL)
        return {"elements": context_map_service.elements(request.element_ids)}
