# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0
# This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study. 

"""Shared fixtures for backend tests.

The domain-specific packages (pypowsybl, expert_op4grid_recommender) are not
available in CI/test environments.  We install lightweight mocks into
``sys.modules`` *before* any production module is imported so that collection
and import succeed without the real packages.

When the real packages *are* installed (e.g. local development), we prefer
them over mocks so that integration-style tests (TestRecommenderSimulationRealData)
can run against the real implementations.
"""

import sys
import importlib
from unittest.mock import MagicMock

# ---------------------------------------------------------------------------
# Mock heavy domain packages that are not available in test environments.
# Try to import each package first; only install a mock when the real package
# cannot be found.
# ---------------------------------------------------------------------------
_MOCK_MODULES = [
    "pypowsybl",
    "pypowsybl.network",
    "pypowsybl.loadflow",
    "pypowsybl_jupyter",
    "pypowsybl_jupyter.util",
    "expert_op4grid_recommender",
    "expert_op4grid_recommender.config",
    "expert_op4grid_recommender.main",
    "expert_op4grid_recommender.data_loader",
    "expert_op4grid_recommender.utils",
    "expert_op4grid_recommender.utils.make_env_utils",
    "expert_op4grid_recommender.action_evaluation",
    "expert_op4grid_recommender.action_evaluation.classifier",
    "expert_op4grid_recommender.environment_pypowsybl",
    # utils.simulation is the single backend-agnostic simulation module since the
    # recommender's R4 refactor unified the grid2op/pypowsybl pair (the old
    # utils.simulation_pypowsybl was deleted).
    "expert_op4grid_recommender.utils.simulation",
    "expert_op4grid_recommender.environment",
    "expert_op4grid_recommender.pypowsybl_backend",
    "expert_op4grid_recommender.pypowsybl_backend.simulation_env",
    "expert_op4grid_recommender.utils.superposition",
]

for mod_name in _MOCK_MODULES:
    if mod_name not in sys.modules:
        try:
            importlib.import_module(mod_name)
        except (ImportError, ModuleNotFoundError):
            sys.modules[mod_name] = MagicMock()

# ---------------------------------------------------------------------------
# Ensure the mock config has the standard attributes the production code
# expects.  ``from expert_op4grid_recommender import config`` resolves via
# sys.modules["expert_op4grid_recommender.config"], so we set them there.
# ---------------------------------------------------------------------------
_mock_config = sys.modules["expert_op4grid_recommender.config"]
_mock_config.MONITORING_FACTOR_THERMAL_LIMITS = 0.95
_mock_config.PRE_EXISTING_OVERLOAD_WORSENING_THRESHOLD = 0.02
_mock_config.IGNORE_LINES_MONITORING = True
_mock_config.PYPOWSYBL_FAST_MODE = True
_mock_config.MAX_RHO_BOTH_EXTREMITIES = True
_mock_config.CHECK_ACTION_SIMULATION = False
_mock_config.IGNORE_RECONNECTIONS = False
_mock_config.DATE = None
_mock_config.TIMESTEP = 0
_mock_config.MONITORED_LINES_COUNT = 0
_mock_config.DO_VISUALIZATION = True
_mock_config.USE_DC_LOAD_FLOW = False
from pathlib import Path as _Path

# Also set on the parent mock's attribute so both import paths work
sys.modules["expert_op4grid_recommender"].config = _mock_config

# ---------------------------------------------------------------------------
# Now it is safe to import production code
# ---------------------------------------------------------------------------
import pytest
import pandas as pd
import numpy as np


@pytest.fixture
def mock_network():
    """Create a mock pypowsybl network with realistic data."""
    network = MagicMock()
    network.id = "test_network"

    lines_data = pd.DataFrame(
        {
            "voltage_level1_id": ["VL1", "VL1", "VL2"],
            "voltage_level2_id": ["VL2", "VL3", "VL3"],
            "i1": [100.0, 200.0, 150.0],
            "i2": [95.0, 190.0, 148.0],
            "p1": [50.0, 80.0, 60.0],
            "p2": [-48.0, -78.0, -58.0],
        },
        index=["LINE_A", "LINE_B", "LINE_C"],
    )

    transformers_data = pd.DataFrame(
        {
            "voltage_level1_id": ["VL1", "VL3"],
            "voltage_level2_id": ["VL4", "VL5"],
            "i1": [300.0, 250.0],
            "i2": [290.0, 245.0],
            "p1": [120.0, 100.0],
            "p2": [-118.0, -98.0],
        },
        index=["TRAFO_1", "TRAFO_2"],
    )

    voltage_levels_data = pd.DataFrame(
        {"nominal_v": [400.0, 225.0, 90.0, 63.0, 20.0]},
        index=["VL1", "VL2", "VL3", "VL4", "VL5"],
    )

    network.get_lines.return_value = lines_data
    network.get_2_windings_transformers.return_value = transformers_data
    network.get_voltage_levels.return_value = voltage_levels_data

    return network


@pytest.fixture
def mock_network_service(mock_network):
    """Create a NetworkService with a pre-loaded mock network."""
    from expert_backend.services.network_service import NetworkService

    service = NetworkService()
    service.network = mock_network
    return service


# Only numeric/boolean config attributes need re-application after
# each test because patch.object may remove them.  Path-like attributes
# (ENV_PATH, ACTION_FILE_PATH etc.) are left to MagicMock auto-creation
# so they don't trigger real filesystem access during tests.
_CONFIG_DEFAULTS = {
    "MONITORING_FACTOR_THERMAL_LIMITS": 0.95,
    "PRE_EXISTING_OVERLOAD_WORSENING_THRESHOLD": 0.02,
    "IGNORE_LINES_MONITORING": True,
    "PYPOWSYBL_FAST_MODE": True,
    "MAX_RHO_BOTH_EXTREMITIES": True,
    "CHECK_ACTION_SIMULATION": False,
    "IGNORE_RECONNECTIONS": False,
    "DATE": None,
    "TIMESTEP": 0,
    "MONITORED_LINES_COUNT": 0,
    "DO_VISUALIZATION": True,
    "USE_DC_LOAD_FLOW": False,
}


@pytest.fixture(autouse=True)
def reset_config():
    """Snapshot and restore the expert_op4grid_recommender.config state after each test."""
    from expert_op4grid_recommender import config

    # Snapshot all attributes that don't start with __
    snapshot = {k: v for k, v in vars(config).items() if not k.startswith("__")}

    yield

    # Restore from snapshot
    for k, v in snapshot.items():
        setattr(config, k, v)

    # Remove any attributes that were added during the test
    current_keys = [k for k in vars(config).keys() if not k.startswith("__")]
    for k in current_keys:
        if k not in snapshot:
            delattr(config, k)

    # Re-apply standard defaults that the production code expects.
    # Some tests (via patch.object) remove attributes during cleanup;
    # this ensures every test starts with a consistent config state.
    # Use vars(config) check to avoid overwriting values that were
    # intentionally set by test modules (e.g. PYPOWSYBL_FAST_MODE = False).
    config_dict = vars(config)
    for k, v in _CONFIG_DEFAULTS.items():
        if k not in config_dict:
            setattr(config, k, v)


@pytest.fixture
def recommender_service_instance():
    """Create a fresh RecommenderService instance."""
    from expert_backend.services.recommender_service import RecommenderService

    return RecommenderService()
