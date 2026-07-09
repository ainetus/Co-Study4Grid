# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0
"""Shared filesystem paths for the backend (QW17).

`OVERFLOW_DIR` is the single anchor for the overflow-graph artifacts. It was
previously spelled three different ways across two anchors: `main.py` served
`/results/pdf/` from a repo-root-anchored path, while the analysis writer
(`config.SAVE_FOLDER_VISUALIZATION`) and the load-session copy target were
`os.getcwd()`-relative. They only coincided because uvicorn happens to run from
the repo root — a different CWD silently split read from write. Anchoring every
caller here removes that latent dependency on the process CWD.
"""
from __future__ import annotations

from pathlib import Path

# Repo root = expert_backend/services/paths.py -> services -> expert_backend -> root.
OVERFLOW_DIR = (Path(__file__).resolve().parent.parent.parent / "Overflow_Graph").resolve()
