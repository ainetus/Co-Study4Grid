# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0
# This file is part of Co-Study4Grid a Power Grid Study tool Assistant Interface to help solve contigencies for a grid state under study. 

import pytest
import os
from pathlib import Path
from datetime import datetime
from expert_op4grid_recommender import config
from expert_op4grid_recommender.environment_pypowsybl import setup_environment_configs_pypowsybl

def test_non_reconnectable_detection_with_date():
    """
    Verify that non-reconnectable lines are detected correctly even when an analysis_date is provided.
    This was previously a bug where the detection was bypassed if analysis_date was not None.
    """
    # 1. Setup paths relative to Co-Study4Grid root.
    # `expert_op4grid_recommender.environment_pypowsybl.get_env_first_obs_pypowsybl`
    # joins them as `env_folder / env_name`, so `ENV_PATH` must be the
    # PARENT data folder and `ENV_NAME` the env subdirectory name.
    # Setting ENV_PATH to the full env path produced a doubled suffix
    # (`.../data/bare_env_small_grid_test/bare_env_small_grid_test`)
    # and a FileNotFoundError on the network lookup.
    project_root = Path(__file__).parent.parent.parent
    data_dir = project_root / "data"
    env_subdir = data_dir / "bare_env_small_grid_test"

    if not env_subdir.exists():
        pytest.skip(f"Test data not found at {env_subdir}")

    # 2. Configure the environment
    original_env_name = config.ENV_NAME
    original_env_path = config.ENV_PATH

    config.ENV_NAME = "bare_env_small_grid_test"
    config.ENV_PATH = data_dir
    
    # 3. Use a dummy date - before the fix, this would skip topology-based detection
    dummy_date = datetime(2024, 1, 1)
    
    try:
        # 4. Initialize environment
        # We call the real setup_environment_configs_pypowsybl which now has the fix
        env, obs, env_path, chronic_name, layout, dict_actions, lines_non_reco, lines_care = \
            setup_environment_configs_pypowsybl(analysis_date=dummy_date)
        
        # 5. Verify detected lines
        # Expected lines for bare_env_small_grid_test (from the fix verification)
        expected = {'CRENEL71VIELM', 'GEN.PL73VIELM', 'PYMONL61VOUGL', 'CPVANY632', 'PYMONY632'}
        
        detected_set = set(lines_non_reco)
        
        missing = expected - detected_set
        assert not missing, f"Non-reconnectable lines missing from detection: {missing}. Detected: {detected_set}"
        
        print(f"Verified: {len(expected)} lines correctly detected with date={dummy_date}")
        
    finally:
        # Restore configuration
        config.ENV_NAME = original_env_name
        config.ENV_PATH = original_env_path

if __name__ == "__main__":
    test_non_reconnectable_detection_with_date()
