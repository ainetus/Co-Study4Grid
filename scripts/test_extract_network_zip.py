# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0
"""Tests for the Docker-build LFS-zip validator (QW25). Hermetic (stdlib only)."""
import importlib.util
import zipfile
from pathlib import Path

import pytest

_SPEC = importlib.util.spec_from_file_location(
    "extract_network_zip", Path(__file__).resolve().parent / "extract_network_zip.py"
)
mod = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(mod)


def test_extracts_a_real_zip(tmp_path):
    z = tmp_path / "network.xiidm.zip"
    with zipfile.ZipFile(z, "w") as zf:
        zf.writestr("network.xiidm", "<iidm/>")
    assert mod.validate_and_extract(z) is True
    assert (tmp_path / "network.xiidm").read_text() == "<iidm/>"


def test_absent_zip_is_skipped(tmp_path):
    assert mod.validate_and_extract(tmp_path / "missing.zip") is False


def test_lfs_pointer_fails_loudly(tmp_path):
    z = tmp_path / "network.xiidm.zip"
    z.write_bytes(
        b"version https://git-lfs.github.com/spec/v1\n"
        b"oid sha256:deadbeef\nsize 12345\n"
    )
    with pytest.raises(SystemExit, match="Git-LFS pointer"):
        mod.validate_and_extract(z)


def test_corrupt_archive_fails_loudly(tmp_path):
    z = tmp_path / "network.xiidm.zip"
    z.write_bytes(b"not a zip at all")
    with pytest.raises(SystemExit, match="not a valid zip"):
        mod.validate_and_extract(z)
