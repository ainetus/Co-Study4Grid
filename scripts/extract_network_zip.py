# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0
"""Validate + extract a Git-LFS-tracked network zip at Docker build time (QW25).

The large grids ship as Git-LFS ``.zip`` files (they exceed HuggingFace's git
file limit). The Dockerfile previously extracted them with a bare one-liner that
had two silent failure modes: an un-smudged LFS *pointer* file (when ``git lfs
pull`` wasn't run) and a corrupt archive both produced a broken image with no
error. This script FAILS LOUDLY on either instead of shipping a broken grid.

    python scripts/extract_network_zip.py <path/to/network.xiidm.zip> [...]
"""
from __future__ import annotations

import sys
import zipfile
from pathlib import Path

# Git-LFS pointer files begin with this line when the object wasn't smudged.
_LFS_POINTER_PREFIX = b"version https://git-lfs"


def validate_and_extract(zip_path: Path) -> bool:
    """Validate and extract one zip. Returns False (skip) if absent; raises
    SystemExit with a loud message on an LFS pointer or a corrupt archive."""
    if not zip_path.exists():
        print(f"{zip_path} absent — skipping")
        return False
    head = zip_path.read_bytes()[:64]
    if head.startswith(_LFS_POINTER_PREFIX):
        raise SystemExit(
            f"FATAL: {zip_path} is an un-smudged Git-LFS pointer, not the real "
            f"archive. Run `git lfs pull` before building the image."
        )
    if not zipfile.is_zipfile(zip_path):
        raise SystemExit(f"FATAL: {zip_path} is not a valid zip archive.")
    zipfile.ZipFile(zip_path).extractall(zip_path.parent)
    print(f"extracted {zip_path} -> {zip_path.parent}")
    return True


def main(argv: list[str]) -> int:
    for arg in argv[1:]:
        validate_and_extract(Path(arg))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
