# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0

"""SLD (Single Line Diagram) extraction helpers."""
from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)


def extract_vl_switch_states(network: Any, voltage_level_id: str) -> dict[str, bool]:
    """Return ``{switch_id: is_open}`` for every operable switch on a VL.

    Source of truth for the frontend's SLD-edit baseline: the operator
    can only toggle a switch the user-built action then sends back as
    ``{"switches": {id: bool}}`` to ``simulate_manual_action``, so the
    payload here is the contract — any switch missing from this map is
    not editable. Filters out fictitious / retained switches that
    pypowsybl exposes for internal bookkeeping (they cannot be
    manoeuvred). Returns ``{}`` rather than raising on any pypowsybl
    failure: switch editing is an additive feature, the SLD must still
    render.
    """
    try:
        df = network.get_switches(
            attributes=["open", "voltage_level_id", "kind", "fictitious", "retained"]
        )
    except Exception as e:
        logger.debug("get_switches failed for VL %s: %s", voltage_level_id, e)
        try:
            df = network.get_switches(attributes=["open", "voltage_level_id"])
        except Exception as e2:
            logger.debug("get_switches fallback also failed for VL %s: %s", voltage_level_id, e2)
            return {}

    try:
        sub = df[df["voltage_level_id"] == voltage_level_id]
    except Exception as e:
        logger.debug("Switch VL filter failed for %s: %s", voltage_level_id, e)
        return {}

    if "fictitious" in sub.columns:
        sub = sub[~sub["fictitious"].astype(bool)]

    states: dict[str, bool] = {}
    for sw_id, row in sub.iterrows():
        try:
            states[str(sw_id)] = bool(row["open"])
        except Exception:
            continue
    return states


def extract_sld_svg_and_metadata(sld: Any) -> tuple:
    """Extract ``(svg, metadata)`` from a pypowsybl SLD diagram object.

    The metadata JSON contains ``feederNodes`` with ``{id, equipmentId}``
    entries that map SVG element IDs back to network equipment IDs.
    Falls back to ``sld._repr_svg_()`` / ``sld._metadata`` when the
    primary extraction raises.
    """
    try:
        from pypowsybl_jupyter.util import _get_svg_metadata, _get_svg_string
        svg = _get_svg_string(sld)
        metadata = _get_svg_metadata(sld)
    except Exception as e:
        logger.debug("Primary SLD extraction failed, trying fallback: %s", e)
        try:
            svg = sld._repr_svg_()
        except Exception as e:
            logger.debug("SVG extraction fallback: %s", e)
            svg = str(sld)
        metadata = getattr(sld, "_metadata", None)
    return svg, metadata
