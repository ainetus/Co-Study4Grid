# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0
"""Tiny in-memory registry of :class:`RecommenderModel` classes.

Kept intentionally minimal: every concrete model implementation
declares its identifier via the ``name`` class attribute (set on the
:class:`RecommenderModel` base) and registers itself by decorating its
class with :func:`register`. Third-party packages can extend the
registry the same way — they only depend on the library's base ABC,
not on this app.
"""
from __future__ import annotations

import logging
from typing import Dict, List, Type

from expert_op4grid_recommender.models.base import RecommenderModel

logger = logging.getLogger(__name__)

DEFAULT_MODEL = "expert"

_REGISTRY: Dict[str, Type[RecommenderModel]] = {}


def register(cls: Type[RecommenderModel]) -> Type[RecommenderModel]:
    """Register a :class:`RecommenderModel` subclass under its ``name``.

    Usable as a decorator or a plain call:

        @register
        class MyModel(RecommenderModel): ...

        register(MyModel)
    """
    if not hasattr(cls, "name") or not cls.name:
        raise ValueError(
            f"RecommenderModel subclass {cls!r} must declare a non-empty `name`."
        )
    _REGISTRY[cls.name] = cls
    return cls


def unregister(name: str) -> None:
    """Drop a model from the registry. No-op when the name is unknown."""
    _REGISTRY.pop(name, None)


def get_model_class(name: str) -> Type[RecommenderModel] | None:
    """Lookup helper that does not raise on miss."""
    return _REGISTRY.get(name)


def build_recommender(name: str) -> RecommenderModel:
    """Instantiate the model registered under ``name``.

    Falls back to :data:`DEFAULT_MODEL` when ``name`` is falsy so the
    backend can call ``build_recommender(settings.model or '')`` without
    branching.
    """
    key = name or DEFAULT_MODEL
    cls = _REGISTRY.get(key)
    if cls is None:
        raise KeyError(
            f"Unknown recommender model: {key!r}. "
            f"Known: {sorted(_REGISTRY)}"
        )
    return cls()


def list_models() -> List[dict]:
    """Return JSON-ready descriptors of all registered models.

    Consumed by ``GET /api/models`` so the frontend can populate the
    model dropdown and render parameters dynamically.
    """
    out = []
    for cls in _REGISTRY.values():
        # Resilience: a single model whose params_spec() raises (e.g. it
        # references a config attribute missing from a stale install) must
        # NOT take down the whole endpoint — that would blank out every
        # model AND every parameter in the Settings UI. Degrade to an empty
        # param list for the offending model and keep the rest working.
        try:
            params = [
                {
                    "name": p.name,
                    "label": p.label,
                    "kind": p.kind,
                    "default": p.default,
                    "min": p.min,
                    "max": p.max,
                    "description": p.description,
                    "group": p.group,
                }
                for p in cls.params_spec()
            ]
        except Exception as e:
            logger.warning(
                "params_spec() failed for model %r: %s — serving empty param list",
                cls.name, e,
            )
            params = []
        out.append({
            "name": cls.name,
            "label": cls.label,
            "requires_overflow_graph": cls.requires_overflow_graph,
            "is_default": cls.name == DEFAULT_MODEL,
            "params": params,
        })
    return out
