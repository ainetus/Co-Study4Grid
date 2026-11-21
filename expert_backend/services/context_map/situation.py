# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0
# This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

"""The real hour a rebuilt PyPSA-EUR situation reproduces — ``situation.json``.

``scripts/pypsa_eur/build_situation.py`` rebuilds a bundle's loads and
dispatch on an observed hour and writes, beside the network, the hour, the
dispatch method (``observed`` or a PyPSA ``opf``) and the data it used. The
Context tab names the hour and credits those sources (Energy-Charts, ENTSO-E's
unit outputs, powerplantmatching).
"""
from __future__ import annotations

import json
import logging
from pathlib import Path

logger = logging.getLogger(__name__)

SITUATION_FILE_NAME = "situation.json"
SCHEMA = "costudy4grid-situation/1"


def resolve_situation_path(network_path: str | None) -> Path | None:
    """``situation.json`` beside the network file, when there is one."""
    if not network_path:
        return None
    network = Path(network_path)
    candidate = (network if network.is_dir() else network.parent) / SITUATION_FILE_NAME
    return candidate if candidate.is_file() else None


def load_situation(path: Path | None) -> dict | None:
    """``{"at_utc", "dispatch", "sources": [{name, url, licence}]}``, or
    ``None`` when absent or unreadable."""
    if path is None:
        return None
    try:
        record = json.loads(Path(path).read_text(encoding="utf-8"))
        if record.get("schema") != SCHEMA:
            logger.warning("Context map: %s has schema %r, expected %r — ignored",
                           path, record.get("schema"), SCHEMA)
            return None
        return {
            "at_utc": str(record["at_utc"]),
            "dispatch": str(record.get("dispatch", "observed")),
            "sources": [{k: s.get(k) for k in ("name", "url", "licence")}
                        for s in record.get("sources", []) if isinstance(s, dict)],
        }
    except (OSError, ValueError, TypeError, AttributeError, KeyError):
        logger.warning("Context map: could not read %s — hour not shown", path, exc_info=True)
        return None
