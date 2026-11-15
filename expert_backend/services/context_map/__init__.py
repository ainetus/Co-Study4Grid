# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0
# This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study.

"""Context tab — the Carte-Front situation map, ported into Co-Study4Grid.

Zones (RTE regions, else countries) with their production mix,
consumption and the transfers between them, drawn on a European basemap;
plus the map position of the elements the operator studies (contingency,
overloads). See ``docs/features/context-tab.md``.
"""
from expert_backend.services.context_map.service import ContextMapService, context_map_service

__all__ = ["ContextMapService", "context_map_service"]
