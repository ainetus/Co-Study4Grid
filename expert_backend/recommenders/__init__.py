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
from expert_backend.recommenders.toop import ToOpRecommender

# Register the default (expert) and canonical random examples.
# This module is imported by the FastAPI startup path so every server
# process has the three built-in models available immediately.
register(ExpertRecommender)
register(RandomRecommender)
register(RandomOverflowRecommender)
# ToOp is an OPTIONAL install (Python 3.11 + heavy GPU deps). The
# class itself only lazy-imports toop_engine_topology_optimizer inside
# `recommend()`, so registering it here costs nothing when ToOp isn't
# installed — the model just produces an empty recommendation with a
# clear log line.
register(ToOpRecommender)

# Side-effect: patches RecommenderService to consume the registry
# (state + getters + update_config wrap + reset wrap + model-aware
# run_analysis_step2). Imported AFTER the models are registered so the
# patched method can find them. See _service_integration.py for the
# full integration.
from expert_backend.recommenders import _service_integration  # noqa: F401, E402

__all__ = [
    "DEFAULT_MODEL",
    "build_recommender",
    "get_model_class",
    "list_models",
    "register",
    "unregister",
]
