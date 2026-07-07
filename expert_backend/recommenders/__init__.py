# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0
"""Recommendation models exposed by the Co-Study4Grid backend.

This package is the *canonical* place where recommendation models are
registered for this app. The registry is deliberately tiny:

- :func:`register` decorator                 — add a model class
- :func:`build_recommender`                  — instantiate by name
- :func:`list_models`                        — introspect for the UI
- :data:`DEFAULT_MODEL`                      — default selection (expert)

Third-party packages can register additional models by importing
:func:`register` and decorating their :class:`RecommenderModel`
subclass at import time. The library
(``expert_op4grid_recommender``) only defines the base contract; the
registry lives here so the app stays in control of which models are
offered to operators.
"""
from expert_op4grid_recommender.models.expert import ExpertRecommender

from expert_backend.recommenders.random_basic import RandomRecommender
from expert_backend.recommenders.random_overflow import RandomOverflowRecommender
from expert_backend.recommenders.registry import (
    DEFAULT_MODEL,
    build_recommender,
    get_model_class,
    list_models,
    register,
    unregister,
)

# Register the default (expert) and canonical random examples.
# This module is imported by the FastAPI startup path — and lazily by
# ``AnalysisMixin.run_analysis_step2`` via
# ``expert_backend.recommenders.registry`` — so every consumer of
# ``build_recommender`` sees the three built-in models registered.
#
# The service-side integration is EXPLICIT composition (no import-time
# monkey-patching): ``RecommenderService`` inherits
# ``ModelSelectionMixin`` directly, ``update_config`` / ``reset`` call
# ``_apply_model_settings`` / ``_reset_model_settings`` themselves, and
# the single model-aware ``run_analysis_step2`` lives on
# ``AnalysisMixin``. (The former ``_service_integration.py`` module that
# grafted all of this onto the class at import time was removed in the
# 2026-07 D1 revision.)
register(ExpertRecommender)
register(RandomRecommender)
register(RandomOverflowRecommender)

__all__ = [
    "DEFAULT_MODEL",
    "build_recommender",
    "get_model_class",
    "list_models",
    "register",
    "unregister",
]
