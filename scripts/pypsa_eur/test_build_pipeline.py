"""
test_build_pipeline.py
======================

Unit tests for ``build_pipeline.py`` — the end-to-end PyPSA-EUR orchestrator.

We don't actually run the five pipeline steps (they take minutes of compute
and need pypowsybl). Instead we monkey-patch ``subprocess.run`` to record the
commands the orchestrator would dispatch, then assert on:

* ``--steps`` / ``--from-step`` / ``--skip-osm`` selection logic
* default output directory derived from ``--voltages``
* propagation of ``--n1-peak-pct`` and ``--min-branches`` into sub-calls
* ``--help`` exits cleanly

Usage::

    pytest scripts/pypsa_eur/test_build_pipeline.py -v
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_pipeline as bp  # noqa: E402


BASE_DIR = Path(__file__).resolve().parent.parent.parent


class _FakeResult:
    """Stand-in for ``subprocess.CompletedProcess`` with returncode=0."""

    returncode = 0


@pytest.fixture
def captured_runs(monkeypatch):
    """Capture each call to subprocess.run made by build_pipeline.run_step."""
    calls: list[list[str]] = []

    def fake_run(cmd, cwd=None):  # noqa: ARG001
        calls.append(list(cmd))
        return _FakeResult()

    monkeypatch.setattr(subprocess, "run", fake_run)
    # Stub the provenance write so the step-selection tests don't touch the
    # filesystem or shell out to git. write_provenance_manifest is covered
    # directly in TestProvenanceManifest below.
    monkeypatch.setattr(
        bp, "write_provenance_manifest",
        lambda out_dir, params, steps: Path(out_dir) / "provenance.json",
    )
    return calls


def _step_script_names(calls: list[list[str]]) -> list[str]:
    """Extract the name of the script invoked on each subprocess call."""
    names = []
    for cmd in calls:
        # cmd = [python, "/abs/path/to/script.py", ...flags]
        names.append(Path(cmd[1]).stem)
    return names


# ===========================================================================
# Step-selection logic
# ===========================================================================

class TestStepSelection:
    """Verify which step scripts run under various CLI combinations."""

    def test_default_runs_all_six_steps(self, captured_runs, monkeypatch):
        monkeypatch.setattr(sys, "argv", ["build_pipeline.py"])
        bp.main()
        assert _step_script_names(captured_runs) == [
            "fetch_osm_names",
            "convert_pypsa_to_xiidm",
            "calibrate_thermal_limits",
            "add_detailed_topology",
            "generate_n1_overloads",
            "separate_voltage_levels",
        ]

    def test_skip_osm_drops_step_1(self, captured_runs, monkeypatch):
        monkeypatch.setattr(sys, "argv", ["build_pipeline.py", "--skip-osm"])
        bp.main()
        names = _step_script_names(captured_runs)
        assert "fetch_osm_names" not in names
        assert names == [
            "convert_pypsa_to_xiidm",
            "calibrate_thermal_limits",
            "add_detailed_topology",
            "generate_n1_overloads",
            "separate_voltage_levels",
        ]

    def test_from_step_3_runs_3_to_6(self, captured_runs, monkeypatch):
        monkeypatch.setattr(
            sys, "argv", ["build_pipeline.py", "--from-step", "3"]
        )
        bp.main()
        assert _step_script_names(captured_runs) == [
            "calibrate_thermal_limits",
            "add_detailed_topology",
            "generate_n1_overloads",
            "separate_voltage_levels",
        ]

    def test_steps_explicit_list(self, captured_runs, monkeypatch):
        monkeypatch.setattr(
            sys, "argv", ["build_pipeline.py", "--steps", "3,5"]
        )
        bp.main()
        assert _step_script_names(captured_runs) == [
            "calibrate_thermal_limits",
            "generate_n1_overloads",
        ]

    def test_steps_single(self, captured_runs, monkeypatch):
        monkeypatch.setattr(sys, "argv", ["build_pipeline.py", "--steps", "4"])
        bp.main()
        assert _step_script_names(captured_runs) == ["add_detailed_topology"]

    def test_unknown_step_errors(self, captured_runs, monkeypatch):
        monkeypatch.setattr(sys, "argv", ["build_pipeline.py", "--steps", "7"])
        with pytest.raises(SystemExit):
            bp.main()

    def test_skip_osm_with_steps_containing_1(self, captured_runs, monkeypatch):
        """--skip-osm wins even when --steps explicitly lists 1."""
        monkeypatch.setattr(
            sys, "argv", ["build_pipeline.py", "--steps", "1,2", "--skip-osm"]
        )
        bp.main()
        names = _step_script_names(captured_runs)
        assert names == ["convert_pypsa_to_xiidm"]


# ===========================================================================
# Argument propagation
# ===========================================================================

class TestArgumentPropagation:
    """Verify that CLI flags are forwarded to the correct sub-scripts."""

    def test_voltages_and_output_passed_to_step_2(self, captured_runs, monkeypatch):
        monkeypatch.setattr(
            sys,
            "argv",
            [
                "build_pipeline.py",
                "--voltages", "400",
                "--steps", "2",
                "--output", "data/pypsa_eur_fr400",
            ],
        )
        bp.main()
        assert len(captured_runs) == 1
        cmd = captured_runs[0]
        assert "--voltages" in cmd
        assert cmd[cmd.index("--voltages") + 1] == "400"
        assert "--output-dir" in cmd
        # Output path must be absolute.
        out = cmd[cmd.index("--output-dir") + 1]
        assert Path(out).is_absolute()

    def test_n1_peak_pct_forwarded_to_step_3(self, captured_runs, monkeypatch):
        monkeypatch.setattr(
            sys,
            "argv",
            [
                "build_pipeline.py",
                "--steps", "3",
                "--n1-peak-pct", "125",
            ],
        )
        bp.main()
        cmd = captured_runs[0]
        assert "--n1-peak-pct" in cmd
        # argparse type=float → str(125.0) == "125.0"
        assert float(cmd[cmd.index("--n1-peak-pct") + 1]) == pytest.approx(125.0)

    def test_min_branches_forwarded_to_step_4(self, captured_runs, monkeypatch):
        monkeypatch.setattr(
            sys,
            "argv",
            [
                "build_pipeline.py",
                "--steps", "4",
                "--min-branches", "5",
            ],
        )
        bp.main()
        cmd = captured_runs[0]
        assert "--min-branches" in cmd
        assert cmd[cmd.index("--min-branches") + 1] == "5"

    def test_default_output_from_voltages(self, captured_runs, monkeypatch):
        """Without --output, the pipeline derives data/pypsa_eur_fr<slug>."""
        monkeypatch.setattr(
            sys,
            "argv",
            ["build_pipeline.py", "--steps", "2", "--voltages", "225,400"],
        )
        bp.main()
        cmd = captured_runs[0]
        out = cmd[cmd.index("--output-dir") + 1]
        assert out.endswith("pypsa_eur_fr225_400")

    def test_voltages_single_value_default_output(self, captured_runs, monkeypatch):
        monkeypatch.setattr(
            sys, "argv", ["build_pipeline.py", "--steps", "2", "--voltages", "400"]
        )
        bp.main()
        cmd = captured_runs[0]
        out = cmd[cmd.index("--output-dir") + 1]
        assert out.endswith("pypsa_eur_fr400")

    def test_country_empty_gives_eur_output_dir(self, captured_runs, monkeypatch):
        """--country '' (all countries) should produce data/pypsa_eur_eur<slug>."""
        monkeypatch.setattr(
            sys, "argv",
            ["build_pipeline.py", "--steps", "2", "--voltages", "400", "--country", ""],
        )
        bp.main()
        cmd = captured_runs[0]
        out = cmd[cmd.index("--output-dir") + 1]
        assert out.endswith("pypsa_eur_eur400")

    def test_country_all_gives_eur_output_dir(self, captured_runs, monkeypatch):
        """--country ALL should also produce data/pypsa_eur_eur<slug>."""
        monkeypatch.setattr(
            sys, "argv",
            ["build_pipeline.py", "--steps", "2", "--voltages", "400", "--country", "ALL"],
        )
        bp.main()
        cmd = captured_runs[0]
        out = cmd[cmd.index("--output-dir") + 1]
        assert out.endswith("pypsa_eur_eur400")

    def test_country_passed_to_step_2(self, captured_runs, monkeypatch):
        """--country value must be forwarded to step 2 via --country flag."""
        monkeypatch.setattr(
            sys, "argv",
            ["build_pipeline.py", "--steps", "2", "--country", "DE"],
        )
        bp.main()
        cmd = captured_runs[0]
        assert "--country" in cmd
        assert cmd[cmd.index("--country") + 1] == "DE"

    def test_country_empty_forwarded_as_empty_string_to_step_2(self, captured_runs, monkeypatch):
        """--country '' must forward an empty string to step 2."""
        monkeypatch.setattr(
            sys, "argv",
            ["build_pipeline.py", "--steps", "2", "--country", ""],
        )
        bp.main()
        cmd = captured_runs[0]
        assert "--country" in cmd
        assert cmd[cmd.index("--country") + 1] == ""

    def test_osm_cache_flag_passed_to_step_1(self, captured_runs, monkeypatch, tmp_path):
        cache = tmp_path / "osm_cache.json"
        cache.write_text("{}")
        monkeypatch.setattr(
            sys,
            "argv",
            ["build_pipeline.py", "--steps", "1", "--osm-cache", str(cache)],
        )
        bp.main()
        cmd = captured_runs[0]
        assert "--cache-from" in cmd
        assert cmd[cmd.index("--cache-from") + 1] == str(cache)


# ===========================================================================
# Subprocess failure handling
# ===========================================================================

class TestFailureHandling:
    """Verify that a failing sub-step aborts the pipeline."""

    def test_non_zero_exit_raises_system_exit(self, monkeypatch):
        class _FailResult:
            returncode = 1

        def fail_run(cmd, cwd=None):  # noqa: ARG001
            return _FailResult()

        monkeypatch.setattr(subprocess, "run", fail_run)
        monkeypatch.setattr(sys, "argv", ["build_pipeline.py", "--steps", "2"])
        with pytest.raises(SystemExit) as excinfo:
            bp.main()
        assert excinfo.value.code == 1


# ===========================================================================
# CLI surface
# ===========================================================================

class TestCLISurface:
    """Verify the CLI boundary (help output, argparse)."""

    def test_help_exits_cleanly(self):
        """`build_pipeline.py --help` should exit 0 and print usage."""
        result = subprocess.run(
            [sys.executable, str(BASE_DIR / "scripts" / "pypsa_eur" / "build_pipeline.py"), "--help"],
            capture_output=True, text=True,
        )
        assert result.returncode == 0
        assert "Steps:" in result.stdout
        assert "--voltages" in result.stdout
        assert "--from-step" in result.stdout


# ===========================================================================
# Provenance manifest (D8)
# ===========================================================================

class TestProvenanceManifest:
    """write_provenance_manifest links a bundle to the pipeline that made it."""

    def test_manifest_structure_and_checksums(self, tmp_path):
        import hashlib
        import json

        (tmp_path / "network.xiidm").write_text("<iidm/>", encoding="utf-8")
        (tmp_path / "grid_layout.json").write_text('{"VL_a": [0, 0]}', encoding="utf-8")
        # bus_id_mapping.json / actions.json intentionally absent — only present
        # artifacts are checksummed.

        path = bp.write_provenance_manifest(
            tmp_path,
            params={"country": "FR", "voltages": "225,400", "n1_peak_pct": 130.0, "min_branches": 4},
            steps=[2, 6],
        )
        assert path == tmp_path / "provenance.json"

        manifest = json.loads(path.read_text(encoding="utf-8"))
        assert manifest["schema"] == "costudy4grid-bundle-provenance/1"
        assert manifest["generated_at"]  # ISO timestamp present
        assert manifest["pipeline"]["params"]["country"] == "FR"
        assert manifest["pipeline"]["steps"] == [
            {"n": 2, "name": "convert_pypsa_to_xiidm"},
            {"n": 6, "name": "separate_voltage_levels"},
        ]
        # Only the two present outputs are recorded, with correct sha256.
        assert set(manifest["outputs"]) == {"network.xiidm", "grid_layout.json"}
        expected = hashlib.sha256((tmp_path / "network.xiidm").read_bytes()).hexdigest()
        assert manifest["outputs"]["network.xiidm"]["sha256"] == expected
        assert manifest["outputs"]["network.xiidm"]["bytes"] == len("<iidm/>")

    def test_manifest_checksum_changes_when_output_changes(self, tmp_path):
        import json

        (tmp_path / "grid_layout.json").write_text("A", encoding="utf-8")
        first = json.loads(
            bp.write_provenance_manifest(tmp_path, params={}, steps=[6]).read_text()
        )["outputs"]["grid_layout.json"]["sha256"]

        (tmp_path / "grid_layout.json").write_text("B", encoding="utf-8")
        second = json.loads(
            bp.write_provenance_manifest(tmp_path, params={}, steps=[6]).read_text()
        )["outputs"]["grid_layout.json"]["sha256"]

        assert first != second


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
