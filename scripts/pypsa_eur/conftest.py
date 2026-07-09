"""
conftest.py for PyPSA-EUR network tests.

Centralizes fixtures shared by test_pipeline.py, test_n1_calibration.py and
test_grid_layout.py so each file stops re-defining its own copy.

Key features:

* ``--pypsa-network`` CLI option picks which network dataset the tests run
  against. Defaults to the canonical ``pypsa_eur_fr225_400`` target.
* All counts (lines, buses, contingencies, …) are derived from the dataset
  on disk via the ``expected_counts`` fixture — tests never hard-code 398
  or 192 anymore.
* Slow pypowsybl fixtures (``network``) are session-scoped so a single load
  is shared across every class in every test module.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest


BASE_DIR = Path(__file__).resolve().parent.parent.parent
OSM_DIR = BASE_DIR / "data" / "pypsa_eur_osm"
DEFAULT_NETWORK = "pypsa_eur_fr225_400"


# ---------------------------------------------------------------------------
# CLI options + marker registration
# ---------------------------------------------------------------------------
def pytest_addoption(parser):
    parser.addoption(
        "--pypsa-network",
        action="store",
        default=DEFAULT_NETWORK,
        help=(
            "Which data/<name> directory the PyPSA-EUR tests run against "
            f"(default: {DEFAULT_NETWORK})."
        ),
    )


def pytest_configure(config):
    config.addinivalue_line(
        "markers", "slow: marks tests requiring pypowsybl-heavy computation"
    )


# ---------------------------------------------------------------------------
# Path fixtures
# ---------------------------------------------------------------------------
@pytest.fixture(scope="session")
def network_name(pytestconfig) -> str:
    return pytestconfig.getoption("--pypsa-network")


@pytest.fixture(scope="session")
def data_dir(network_name) -> Path:
    d = BASE_DIR / "data" / network_name
    if not d.is_dir():
        pytest.skip(f"Dataset not available on disk: {d}")
    return d


@pytest.fixture(scope="session")
def osm_dir() -> Path:
    # The raw PyPSA-EUR OSM CSVs (buses/lines/transformers) are the pipeline
    # INPUT and are not committed (only the built bundles are). Skip the tests
    # that read them when they are absent, so the hermetic slice of this suite
    # still passes from a fresh clone / in CI (D8).
    if not (OSM_DIR / "buses.csv").exists():
        pytest.skip("raw PyPSA-EUR OSM CSVs (data/pypsa_eur_osm/) not committed")
    return OSM_DIR


@pytest.fixture(scope="session")
def network_file(data_dir) -> Path:
    path = data_dir / "network.xiidm"
    if not path.is_file():
        pytest.skip(f"network.xiidm not found at {path}")
    return path


# ---------------------------------------------------------------------------
# JSON artefact fixtures — each skips if the file is absent
# ---------------------------------------------------------------------------
def _load_json(path: Path):
    if not path.is_file():
        pytest.skip(f"Missing artefact: {path}")
    with open(path, encoding="utf-8") as f:
        return json.load(f)


@pytest.fixture(scope="session")
def actions(data_dir):
    return _load_json(data_dir / "actions.json")


@pytest.fixture(scope="session")
def osm_names(data_dir):
    return _load_json(data_dir / "osm_names.json")


@pytest.fixture(scope="session")
def bus_id_mapping(data_dir):
    return _load_json(data_dir / "bus_id_mapping.json")


@pytest.fixture(scope="session")
def line_id_names(data_dir):
    return _load_json(data_dir / "line_id_names.json")


@pytest.fixture(scope="session")
def vl_next_node(data_dir):
    return _load_json(data_dir / "vl_next_node.json")


@pytest.fixture(scope="session")
def grid_layout(data_dir):
    return _load_json(data_dir / "grid_layout.json")


@pytest.fixture(scope="session")
def contingencies(data_dir):
    return _load_json(data_dir / "n1_overload_contingencies.json")


# ---------------------------------------------------------------------------
# pypowsybl network — session-scoped so every test re-uses the same instance
# ---------------------------------------------------------------------------
@pytest.fixture(scope="session")
def network(network_file):
    pp = pytest.importorskip("pypowsybl")
    return pp.network.load(str(network_file))


@pytest.fixture(scope="session")
def has_double_busbar(network) -> bool:
    """Detect whether the network includes the double-busbar topology."""
    bbs = network.get_busbar_sections()
    return any(idx.endswith("_BBS2") or "_BBS2" in idx for idx in bbs.index)


@pytest.fixture(scope="session")
def has_limits(network) -> bool:
    """Detect whether the network has operational limits."""
    return len(network.get_operational_limits()) > 0


# ---------------------------------------------------------------------------
# Expected counts — derived from the actual dataset files so tests stay
# network-agnostic. Each test asserts against these values (not literals).
# ---------------------------------------------------------------------------
@pytest.fixture(scope="session")
def expected_counts(
    line_id_names, bus_id_mapping, vl_next_node, contingencies, actions
) -> dict:
    """Dict of expected counts derived from the artefacts on disk.

    Tests use these as the source of truth rather than magic numbers so the
    suite works on both ``pypsa_eur_fr400`` and ``pypsa_eur_fr225_400`` (and
    any future variant) without per-network forks.
    """
    disco = sum(1 for k in actions if k.startswith("disco_"))
    coupler = sum(1 for k in actions if k.startswith("open_coupler_"))
    return {
        "n_lines": len(line_id_names),
        "n_buses": len(bus_id_mapping),
        "n_vls": len(vl_next_node),
        "n_contingencies_tested": contingencies.get("total_contingencies_tested", 0),
        "n_contingencies_overload": contingencies.get("total_with_overload", 0),
        "peak_loading_pct": contingencies.get("peak_loading_pct", 0.0),
        "n_actions_total": len(actions),
        "n_actions_disco": disco,
        "n_actions_coupler": coupler,
    }
