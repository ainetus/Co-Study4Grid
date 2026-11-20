# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0

"""Decomposition helpers for ``diagram_mixin.py``.

The mixin used to be ~975 lines of NAD/SLD generation, flow queries
and delta math; pulling the heavy lifting into focused modules here
keeps the orchestrator small and lets each concern be unit-tested
independently.

Modules:
  - :mod:`layout_cache` — `(path, mtime)`-keyed layout DataFrame loader
  - :mod:`layout_completion` — positions for the voltage levels the layout misses
  - :mod:`nad_params` — default ``NadParameters`` factory
  - :mod:`nad_render` — ``generate_diagram`` + NaN stripping + root viewBox repair
  - :mod:`sld_render` — SLD SVG + metadata extraction
  - :mod:`overloads` — per-element current queries + overload filtering
  - :mod:`flows` — branch and asset flow extractors
  - :mod:`deltas` — terminal-aware delta math (pure)
"""
