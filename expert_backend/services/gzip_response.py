# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0
# This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

"""Per-endpoint gzip of large non-streaming responses.

Moved out of ``main.py`` (module-size ceiling) unchanged; ``main.py``
re-imports them under their historical ``_maybe_gzip_*`` names. Streaming
(NDJSON) endpoints must NOT go through these — see ``expert_backend/CLAUDE.md``.
"""
from __future__ import annotations

import gzip
import json as json_module
from typing import Any

from fastapi import Request
from fastapi.encoders import jsonable_encoder
from fastapi.responses import Response

GZIP_MIN_BYTES = 10_000
GZIP_LEVEL = 5


def maybe_gzip_svg_text(diagram: dict, request: Request) -> Response:
    diagram = dict(diagram)
    svg = diagram.pop("svg", "")
    meta_line = json_module.dumps(
        jsonable_encoder(diagram), separators=(",", ":"), ensure_ascii=False
    )
    body = (meta_line + "\n" + svg).encode("utf-8")
    accept = request.headers.get("accept-encoding", "")
    if len(body) < GZIP_MIN_BYTES or "gzip" not in accept.lower():
        return Response(
            content=body,
            media_type="text/plain; charset=utf-8",
            headers={"Vary": "Accept-Encoding"},
        )
    compressed = gzip.compress(body, compresslevel=GZIP_LEVEL)
    return Response(
        content=compressed,
        media_type="text/plain; charset=utf-8",
        headers={
            "Content-Encoding": "gzip",
            "Vary": "Accept-Encoding",
        },
    )


def maybe_gzip_json(payload: Any, request: Request) -> Response:
    data = jsonable_encoder(payload)
    body = json_module.dumps(data, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    accept = request.headers.get("accept-encoding", "")
    if len(body) < GZIP_MIN_BYTES or "gzip" not in accept.lower():
        return Response(
            content=body,
            media_type="application/json",
            headers={"Vary": "Accept-Encoding"},
        )
    compressed = gzip.compress(body, compresslevel=GZIP_LEVEL)
    return Response(
        content=compressed,
        media_type="application/json",
        headers={
            "Content-Encoding": "gzip",
            "Vary": "Accept-Encoding",
        },
    )
