#!/usr/bin/env python3
# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0
"""Machine-check the API contract (D2, 2026-07).

The FastAPI app is the single source of truth for the request/response
schema. This script renders ``app.openapi()`` to a stable, normalized
JSON document and either:

- ``--write``: writes it to ``expert_backend/openapi.snapshot.json``
  (run this whenever an endpoint or a Pydantic model changes on purpose), or
- default (check mode): diffs the freshly-rendered spec against the
  committed snapshot and FAILS (exit 1) on any drift — so a
  response-/request-shape change becomes a reviewable diff in the PR
  instead of silently diverging from the hand-mirrored ``types.ts``.

Wired into CI alongside the other gate scripts. The snapshot is also
the input for generating the frontend types (see
``docs/architecture/api-contract-machine-check.md``).

Normalization: the OpenAPI version string and FastAPI's auto-generated
``title`` / ``version`` are pinned so an unrelated FastAPI upgrade
doesn't churn the snapshot; ``paths`` and ``components.schemas`` are
key-sorted for a deterministic, minimal diff.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
_SNAPSHOT = _REPO_ROOT / "expert_backend" / "openapi.snapshot.json"


def _render_spec() -> dict:
    # Import lazily so the heavy backend import cost is only paid when
    # this script actually runs (not at module import for --help).
    sys.path.insert(0, str(_REPO_ROOT))
    from expert_backend.main import app

    spec = app.openapi()
    # Pin the FastAPI-generated metadata so a framework upgrade or a
    # default-title change doesn't churn the contract snapshot.
    spec["openapi"] = "3.1.0"
    spec["info"] = {"title": "Co-Study4Grid API", "version": "contract"}
    return spec


def _normalize(spec: dict) -> str:
    """Deterministic JSON: recursively key-sorted, stable separators."""
    return json.dumps(spec, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--write",
        action="store_true",
        help="Overwrite the committed snapshot with the current spec.",
    )
    args = parser.parse_args()

    rendered = _normalize(_render_spec())

    if args.write:
        _SNAPSHOT.write_text(rendered, encoding="utf-8")
        print(f"Wrote OpenAPI snapshot → {_SNAPSHOT.relative_to(_REPO_ROOT)}")
        return 0

    if not _SNAPSHOT.exists():
        print(
            "OpenAPI snapshot missing. Generate it with:\n"
            "  python scripts/check_openapi_contract.py --write",
            file=sys.stderr,
        )
        return 1

    committed = _SNAPSHOT.read_text(encoding="utf-8")
    if rendered == committed:
        print("OpenAPI contract OK — spec matches the committed snapshot.")
        return 0

    # Show a compact unified diff so the reviewer sees exactly what moved.
    import difflib

    diff = difflib.unified_diff(
        committed.splitlines(keepends=True),
        rendered.splitlines(keepends=True),
        fromfile="openapi.snapshot.json (committed)",
        tofile="app.openapi() (current)",
        n=2,
    )
    sys.stdout.writelines(diff)
    print(
        "\nOpenAPI contract DRIFT: the live spec differs from the committed "
        "snapshot.\nIf this change is intentional, regenerate the snapshot:\n"
        "  python scripts/check_openapi_contract.py --write\n"
        "and review the diff (it mirrors what the frontend types must track).",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
