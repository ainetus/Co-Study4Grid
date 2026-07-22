# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0
# This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study. 

"""Tests for NetworkService."""

import os
import pytest
from unittest.mock import patch, MagicMock
import pandas as pd

from expert_backend.services.network_service import NetworkService


class TestNetworkServiceInit:
    def test_initial_state(self):
        service = NetworkService()
        assert service.network is None


class TestLoadNetwork:
    def test_load_network_file_not_found(self):
        service = NetworkService()
        with pytest.raises(FileNotFoundError, match="not found"):
            service.load_network("/nonexistent/path")

    @patch("expert_backend.services.network_service.pn")
    def test_load_network_from_file(self, mock_pn, tmp_path):
        # Create a fake xiidm file
        xiidm = tmp_path / "test.xiidm"
        xiidm.write_text("<network/>")

        mock_network = MagicMock()
        mock_network.id = "test_net"
        mock_pn.load.return_value = mock_network

        service = NetworkService()
        result = service.load_network(str(xiidm))

        mock_pn.load.assert_called_once_with(str(xiidm))
        assert result["message"] == "Network loaded successfully"
        assert result["id"] == "test_net"
        assert service.network is mock_network

    @patch("expert_backend.services.network_service.pn")
    def test_load_network_keeps_multi_thread_variant_flag_off(self, mock_pn, tmp_path):
        """Regression guard for the `allow_variant_multi_thread_access` path.

        pypowsybl exposes this flag to unlock concurrent variant ops, but
        enabling it requires every thread that touches the Network to
        explicitly set its working variant first — otherwise pypowsybl
        raises "Variant index not set for current thread".

        FastAPI serves each read-only endpoint (`/api/branches`, …) on an
        arbitrary thread-pool worker without a variant-set guard, so the
        flag MUST stay off. See docs/performance/history/concurrent-variants.md."""
        xiidm = tmp_path / "grid.xiidm"
        xiidm.write_text("<network/>")

        mock_pn.load.return_value = MagicMock(id="x")

        NetworkService().load_network(str(xiidm))

        _, kwargs = mock_pn.load.call_args
        assert kwargs.get("allow_variant_multi_thread_access") in (None, False), (
            "Flag must remain OFF — see docs/performance/history/concurrent-variants.md."
        )


class TestLoadNetworkZip:
    """Auto-decompression of zipped networks (e.g. a shipped network.xiidm.zip)."""

    @staticmethod
    def _make_zip(dir_path, zip_name="network.xiidm.zip", member="network.xiidm"):
        import zipfile
        zpath = os.path.join(str(dir_path), zip_name)
        with zipfile.ZipFile(zpath, "w") as zf:
            zf.writestr(member, "<network/>")
        return zpath

    @patch("expert_backend.services.network_service.pn")
    def test_loads_from_explicit_zip(self, mock_pn, tmp_path):
        zpath = self._make_zip(tmp_path)
        mock_pn.load.return_value = MagicMock(id="z")

        NetworkService().load_network(zpath)

        loaded = mock_pn.load.call_args[0][0]
        assert loaded.endswith("network.xiidm")
        assert os.path.isfile(loaded)

    @patch("expert_backend.services.network_service.pn")
    def test_loads_xiidm_when_only_sibling_zip_exists(self, mock_pn, tmp_path):
        self._make_zip(tmp_path)
        requested = os.path.join(str(tmp_path), "network.xiidm")  # absent on disk
        assert not os.path.exists(requested)
        mock_pn.load.return_value = MagicMock(id="z")

        NetworkService().load_network(requested)

        loaded = mock_pn.load.call_args[0][0]
        assert os.path.isfile(loaded) and loaded.endswith("network.xiidm")

    def test_resolve_is_cached(self, tmp_path):
        self._make_zip(tmp_path)
        requested = os.path.join(str(tmp_path), "network.xiidm")
        svc = NetworkService()
        first = svc._resolve_network_file(requested)
        second = svc._resolve_network_file(requested)
        assert first == second and os.path.isfile(first)

    def test_zip_without_network_raises(self, tmp_path):
        import zipfile
        zpath = os.path.join(str(tmp_path), "bad.zip")
        with zipfile.ZipFile(zpath, "w") as zf:
            zf.writestr("readme.txt", "no network here")
        with pytest.raises(FileNotFoundError):
            NetworkService().load_network(zpath)

    @patch("expert_backend.services.network_service.pn")
    def test_load_network_from_directory(self, mock_pn, tmp_path):
        # Create a directory with a xiidm file inside
        xiidm = tmp_path / "grid.xiidm"
        xiidm.write_text("<network/>")

        mock_network = MagicMock()
        mock_network.id = "dir_net"
        mock_pn.load.return_value = mock_network

        service = NetworkService()
        result = service.load_network(str(tmp_path))

        mock_pn.load.assert_called_once_with(str(xiidm))
        assert result["id"] == "dir_net"

    @patch("expert_backend.services.network_service.pn")
    def test_load_network_from_directory_xml(self, mock_pn, tmp_path):
        xml_file = tmp_path / "network.xml"
        xml_file.write_text("<network/>")

        mock_network = MagicMock()
        mock_network.id = "xml_net"
        mock_pn.load.return_value = mock_network

        service = NetworkService()
        result = service.load_network(str(tmp_path))
        assert result["id"] == "xml_net"

    def test_load_network_directory_no_xiidm(self, tmp_path):
        # Empty directory
        service = NetworkService()
        with pytest.raises(FileNotFoundError, match="No .xiidm or .xml"):
            service.load_network(str(tmp_path))


class TestLoadNetworkGzB64:
    """Decode of a ``network.xiidm.gz.b64`` companion (the France THT game grids
    ship the network compressed + text-encoded so it rides Git without LFS; the
    Docker build normally decodes it, but the backend also decodes on demand so
    the grids load in local dev / any build that skipped the decode step)."""

    @staticmethod
    def _make_gz_b64(dir_path, member="network.xiidm", xml=b"<network/>"):
        import base64
        import gzip
        b64_path = os.path.join(str(dir_path), member + ".gz.b64")
        with open(b64_path, "wb") as f:
            f.write(base64.b64encode(gzip.compress(xml)))
        return b64_path

    @patch("expert_backend.services.network_service.pn")
    def test_loads_xiidm_when_only_companion_gz_b64_exists(self, mock_pn, tmp_path):
        self._make_gz_b64(tmp_path)
        requested = os.path.join(str(tmp_path), "network.xiidm")  # absent on disk
        assert not os.path.exists(requested)
        mock_pn.load.return_value = MagicMock(id="g")

        NetworkService().load_network(requested)

        loaded = mock_pn.load.call_args[0][0]
        assert loaded.endswith("network.xiidm")
        assert os.path.isfile(loaded)
        assert open(loaded, "rb").read() == b"<network/>"

    def test_resolve_decodes_and_is_cached(self, tmp_path):
        self._make_gz_b64(tmp_path)
        requested = os.path.join(str(tmp_path), "network.xiidm")
        svc = NetworkService()
        first = svc._resolve_network_file(requested)
        # Second resolve reuses the already-decoded .xiidm (no re-decode).
        second = svc._resolve_network_file(requested)
        assert first == second and os.path.isfile(first)
        assert first.endswith("network.xiidm")

    @patch("expert_backend.services.network_service.pn")
    def test_redecodes_when_present_xiidm_is_invalid(self, mock_pn, tmp_path):
        # A stale / truncated network.xiidm (e.g. an un-smudged LFS pointer)
        # sits next to a valid .gz.b64 — the resolver must re-decode rather
        # than hand pypowsybl the unparseable file.
        self._make_gz_b64(tmp_path)
        bad = tmp_path / "network.xiidm"
        bad.write_text("version https://git-lfs.github.com/spec/v1\noid sha256:deadbeef\n")
        mock_pn.load.return_value = MagicMock(id="g")

        NetworkService().load_network(str(bad))

        loaded = mock_pn.load.call_args[0][0]
        assert open(loaded, "rb").read() == b"<network/>"  # the decoded XML, not the pointer

    @patch("expert_backend.services.network_service.pn")
    def test_loads_when_given_the_gz_b64_path_directly(self, mock_pn, tmp_path):
        b64_path = self._make_gz_b64(tmp_path)
        mock_pn.load.return_value = MagicMock(id="g")

        NetworkService().load_network(b64_path)

        loaded = mock_pn.load.call_args[0][0]
        assert loaded.endswith("network.xiidm")
        assert open(loaded, "rb").read() == b"<network/>"

    def test_decode_falls_back_to_tempdir_when_grid_dir_readonly(self, tmp_path):
        # Force the in-place write to fail (a read-only grid dir can't be
        # simulated as root, so raise OSError on the target open instead).
        b64_path = self._make_gz_b64(tmp_path)
        out_target = os.path.join(str(tmp_path), "network.xiidm")
        real_open = open

        def fake_open(path, *a, **k):
            if os.path.abspath(path) == os.path.abspath(out_target) and "w" in (a[0] if a else k.get("mode", "")):
                raise OSError("read-only")
            return real_open(path, *a, **k)

        with patch("builtins.open", side_effect=fake_open):
            out = NetworkService()._decode_network_gz_b64(b64_path)
        assert os.path.isfile(out)
        assert real_open(out, "rb").read() == b"<network/>"
        assert not out.startswith(str(tmp_path))  # landed in a temp dir


class TestGetDisconnectableElements:
    def test_network_not_loaded(self):
        service = NetworkService()
        with pytest.raises(ValueError, match="Network not loaded"):
            service.get_disconnectable_elements()

    def test_returns_sorted_elements(self, mock_network_service):
        elements = mock_network_service.get_disconnectable_elements()
        # Should include all lines and transformers, sorted
        assert elements == ["LINE_A", "LINE_B", "LINE_C", "TRAFO_1", "TRAFO_2"]

    def test_empty_lines_and_transformers(self):
        service = NetworkService()
        service.network = MagicMock()
        service.network.get_lines.return_value = pd.DataFrame()
        service.network.get_2_windings_transformers.return_value = pd.DataFrame()
        assert service.get_disconnectable_elements() == []

    def test_only_lines(self):
        service = NetworkService()
        service.network = MagicMock()
        service.network.get_lines.return_value = pd.DataFrame(
            {"dummy": [1, 2]}, index=["B_LINE", "A_LINE"]
        )
        service.network.get_2_windings_transformers.return_value = pd.DataFrame()
        assert service.get_disconnectable_elements() == ["A_LINE", "B_LINE"]


class TestGetVoltageLevels:
    def test_network_not_loaded(self):
        service = NetworkService()
        with pytest.raises(ValueError, match="Network not loaded"):
            service.get_voltage_levels()

    def test_returns_sorted_voltage_levels(self, mock_network_service):
        vls = mock_network_service.get_voltage_levels()
        assert vls == ["VL1", "VL2", "VL3", "VL4", "VL5"]

    def test_empty_voltage_levels(self):
        service = NetworkService()
        service.network = MagicMock()
        service.network.get_voltage_levels.return_value = pd.DataFrame()
        assert service.get_voltage_levels() == []


class TestGetNominalVoltages:
    def test_network_not_loaded(self):
        service = NetworkService()
        with pytest.raises(ValueError, match="Network not loaded"):
            service.get_nominal_voltages()

    def test_returns_mapping(self, mock_network_service):
        mapping = mock_network_service.get_nominal_voltages()
        assert mapping == {
            "VL1": 400.0,
            "VL2": 225.0,
            "VL3": 90.0,
            "VL4": 63.0,
            "VL5": 25.0,
        }

    def test_empty_voltage_levels(self):
        service = NetworkService()
        service.network = MagicMock()
        service.network.get_voltage_levels.return_value = pd.DataFrame()
        assert service.get_nominal_voltages() == {}


class TestGetElementVoltageLevels:
    def test_network_not_loaded(self):
        service = NetworkService()
        with pytest.raises(ValueError, match="Network not loaded"):
            service.get_element_voltage_levels("VL1")

    def test_voltage_level_id(self, mock_network_service):
        """A voltage level ID should resolve to itself."""
        result = mock_network_service.get_element_voltage_levels("VL1")
        assert result == ["VL1"]

    def test_line_resolves_to_two_vls(self, mock_network_service):
        """A line should resolve to its two endpoint voltage levels."""
        result = mock_network_service.get_element_voltage_levels("LINE_A")
        assert result == ["VL1", "VL2"]

    def test_transformer_resolves_to_two_vls(self, mock_network_service):
        result = mock_network_service.get_element_voltage_levels("TRAFO_1")
        assert result == ["VL1", "VL4"]

    def test_unknown_element_returns_empty(self, mock_network_service):
        result = mock_network_service.get_element_voltage_levels("NONEXISTENT")
        assert result == []
