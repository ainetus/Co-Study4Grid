#!/usr/bin/env python3
# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0
"""Gate pull requests on code-quality thresholds.

Exits non-zero when any threshold is violated. The numbers encode the
reductions won in `docs/architecture/code-quality-analysis.md` and are
intentionally a ceiling, not a target — lowering them is welcome,
raising them is a regression.

Thresholds (see also CONTRIBUTING.md):

| Metric                                       |  Max  |
|----------------------------------------------|-------|
| `print(` calls in backend sources            |   0   |
| `traceback.print_exc()` calls in backend     |   0   |
| Bare `except Exception: pass` patterns        |   0   |
| Backend module size (lines)                  | 1150  |
| Backend function size (lines)                |  240  |
| Backend function cyclomatic complexity       |   38  |
| Backend function nesting depth               |    8  |
| `noqa` / `type: ignore` markers (ratchet)    |   3   |
| Backend functions missing return ann (ratchet)| 60   |
| Frontend component size (lines)              | 1450  |
| `frontend/src/utils/**` module size (lines)  | 1000  |
| `App.tsx` hub size (lines)                    | 2100  |
| `any` / `as any` annotations in frontend      |   0   |
| `@ts-ignore` / `-expect-error` / `-nocheck`  |   0   |
| `as unknown as` casts (ratchet)              |  12   |
| `Record<string, unknown>` usages (ratchet)   |  46   |
| Hex color literals outside tokens.{css,ts}   |   0   |

Scope: the backend scan now covers ALL of `expert_backend/` except
the `tests/` suite, the ad-hoc `test_backend.py`, and the setup-time
`install_graphviz.py` — previously only `main.py` + `services/` were
scanned, leaving the whole `recommenders/` package ungated.

`App.tsx` is the state-orchestration hub by design, but "by design"
is not a blank cheque: it gets a generous *bounded* ceiling
(`APP_TSX_MAX`) rather than a blanket exemption, so unbounded growth
still trips the gate. `tokens.css` / `tokens.ts` are the
token-source-of-truth files, exempt from the hex-literal count.

Two kinds of allowance, kept deliberately small:
  * Per-function exemptions — the iframe-overlay template f-string and
    the lxml geo-layout transform (size + complexity), and
    `sanitize_for_json` (nesting — its depth is the recursion shape).
    New offenders are not welcome.
  * Ratchets — `as unknown as`, `Record<string, unknown>`, and backend
    lint suppressions exist today in non-trivial, often-legitimate
    counts. The gate FREEZES them at the current level (lowering is
    welcome; raising is a regression) instead of forcing a big-bang
    cleanup.

The hex-literal ceiling is now zero — every colour in frontend
source must come from a named token in
`frontend/src/styles/tokens.{css,ts}`. Adding a new colour means
defining it in tokens first, then importing it; raising this ceiling
is a regression.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from code_quality_report import build_report  # type: ignore[import-not-found]

BACKEND_MODULE_MAX = 1150
BACKEND_FUNCTION_MAX = 240
FRONTEND_COMPONENT_MAX = 1450
FRONTEND_UTIL_MAX = 1000

# Functions exempt from `BACKEND_FUNCTION_MAX`. The first is a
# template f-string that produces the iframe overlay's <style>+<script>
# block; AST sees it as a 900+-line function, but it is template content.
# The second is the lxml geo-layout transform. New entries are NOT
# welcome here. (The former `diagram_mixin.get_action_variant_diagram_patch`
# overrun was retired in 0.8.0 — it is back under the ceiling after the
# action_patch.py decomposition.)
BACKEND_FUNCTION_EXEMPTIONS = {
    "expert_backend/services/overflow_overlay.py::_build_overlay_block",
    "expert_backend/services/analysis/overflow_geo_transform.py::transform_html",
}
# Ratchets — frozen at the current count (see module docstring).
BACKEND_LINT_SUPPRESSION_MAX = 3  # `noqa` / `type: ignore` markers
# Functions missing a return annotation. Freeze + ratchet down: new
# functions must be annotated (mypy gates that the annotation is correct).
# The residual ~60 delegate to untyped pypowsybl / recommender helpers, so
# their honest type is `Any` — left unannotated rather than padded with
# `-> Any` (which would inflate this metric without mypy verifying anything).
# Lowering further means typing those helpers bottom-up first.
BACKEND_MISSING_RETURN_MAX = 60

# Cyclomatic complexity (McCabe) + max nesting depth per backend
# function, computed from the AST — no external dependency. Ratchets
# toward the current maxima; lower over time, don't raise.
BACKEND_FUNCTION_CC_MAX = 38       # current non-exempt max 35 (update_config)
BACKEND_FUNCTION_NESTING_MAX = 8   # current non-exempt max 7
BACKEND_CC_EXEMPTIONS = {
    # lxml geo-layout transform — a long flat dispatch, already
    # function-size-exempt. Decompose to retire.
    "expert_backend/services/analysis/overflow_geo_transform.py::transform_html",
}
BACKEND_NESTING_EXEMPTIONS = {
    # recursive NumPy→native coercion; the depth is its recursion shape.
    "expert_backend/services/sanitize.py::sanitize_for_json",
}
# Ceiling on hex color literals in frontend source. The
# token-source-of-truth files (`frontend/src/styles/tokens.css` and
# `frontend/src/styles/tokens.ts`) are exempt — they ARE the named
# palette every other file consumes. Phase A + B + C of the
# design-token migration drove this to zero; new colours must be
# added to the token files first, then imported.
FRONTEND_HEX_LITERAL_MAX = 0
# Ratchets — frozen at the current count (see module docstring). Weak
# typing surface; lowering is welcome, raising is a regression.
FRONTEND_WEAK_CAST_MAX = 12       # `as unknown as` (was 19; SVG-DOM casts simplified)
FRONTEND_RECORD_UNKNOWN_MAX = 46  # `Record<string, unknown>`
# `App.tsx` is the state-orchestration hub by design, but gets a
# generous *bounded* ceiling rather than a blanket exemption — so it
# can't grow without bound. `utils/**` modules are gated by the
# (looser) `FRONTEND_UTIL_MAX`; everything else by `FRONTEND_COMPONENT_MAX`.
APP_TSX_PATH = "frontend/src/App.tsx"
APP_TSX_MAX = 2100
FRONTEND_UTIL_PREFIX = "frontend/src/utils/"


def main() -> int:
    report = build_report()
    errors: list[str] = []

    be = report.backend
    if be.print_calls:
        errors.append(f"backend: {be.print_calls} `print(` calls — use `logging`")
    if be.traceback_prints:
        errors.append(
            f"backend: {be.traceback_prints} `traceback.print_exc()` calls — "
            "use `logger.exception(...)`"
        )
    if be.silent_excepts:
        errors.append(
            f"backend: {be.silent_excepts} silent `except Exception: pass` blocks — "
            "log the exception"
        )
    if be.lint_suppressions > BACKEND_LINT_SUPPRESSION_MAX:
        errors.append(
            f"backend: {be.lint_suppressions} `# noqa` / `# type: ignore` "
            f"suppressions (ratchet {BACKEND_LINT_SUPPRESSION_MAX}) — each must be "
            "justified inline; don't add new ones"
        )
    if be.functions_missing_return > BACKEND_MISSING_RETURN_MAX:
        errors.append(
            f"backend: {be.functions_missing_return} functions missing a return "
            f"annotation (ratchet {BACKEND_MISSING_RETURN_MAX}) — annotate new "
            "functions; mypy gates that the annotation is correct"
        )
    for mod in be.modules:
        if mod.lines > BACKEND_MODULE_MAX:
            errors.append(
                f"backend: `{mod.path}` is {mod.lines} lines "
                f"(ceiling {BACKEND_MODULE_MAX}) — split into focused modules"
            )
    for fn in be.all_functions:
        key = f"{fn.file}::{fn.name}"
        if fn.lines > BACKEND_FUNCTION_MAX and key not in BACKEND_FUNCTION_EXEMPTIONS:
            errors.append(
                f"backend: `{key}` is {fn.lines} lines "
                f"(ceiling {BACKEND_FUNCTION_MAX}) — extract helpers"
            )
        if fn.complexity > BACKEND_FUNCTION_CC_MAX and key not in BACKEND_CC_EXEMPTIONS:
            errors.append(
                f"backend: `{key}` has cyclomatic complexity {fn.complexity} "
                f"(ceiling {BACKEND_FUNCTION_CC_MAX}) — split branches / extract helpers"
            )
        if (
            fn.max_nesting > BACKEND_FUNCTION_NESTING_MAX
            and key not in BACKEND_NESTING_EXEMPTIONS
        ):
            errors.append(
                f"backend: `{key}` nesting depth {fn.max_nesting} "
                f"(ceiling {BACKEND_FUNCTION_NESTING_MAX}) — use guard clauses / extract"
            )

    fe = report.frontend
    if fe.any_types:
        errors.append(
            f"frontend: {fe.any_types} `any` type annotations — model the shape in `types.ts`"
        )
    if fe.ts_ignores:
        errors.append(
            f"frontend: {fe.ts_ignores} `@ts-ignore` / `@ts-expect-error` / "
            "`@ts-nocheck` directives — fix the type, don't suppress it"
        )
    if fe.weak_casts > FRONTEND_WEAK_CAST_MAX:
        errors.append(
            f"frontend: {fe.weak_casts} `as unknown as` casts "
            f"(ratchet {FRONTEND_WEAK_CAST_MAX}) — model the shape in `types.ts`"
        )
    if fe.record_str_unknown > FRONTEND_RECORD_UNKNOWN_MAX:
        errors.append(
            f"frontend: {fe.record_str_unknown} `Record<string, unknown>` usages "
            f"(ratchet {FRONTEND_RECORD_UNKNOWN_MAX}) — prefer a typed interface"
        )
    if fe.hex_literals > FRONTEND_HEX_LITERAL_MAX:
        worst = ", ".join(
            f"{fm.path}({fm.lines})" for fm in fe.hex_literals_by_file[:3]
        )
        errors.append(
            f"frontend: {fe.hex_literals} hex color literals "
            f"(ceiling {FRONTEND_HEX_LITERAL_MAX}) — replace with tokens "
            f"from `frontend/src/styles/tokens.css`. Worst offenders: {worst}"
        )
    for comp in fe.components:
        if comp.path == APP_TSX_PATH:
            if comp.lines > APP_TSX_MAX:
                errors.append(
                    f"frontend: `{comp.path}` is {comp.lines} lines "
                    f"(hub ceiling {APP_TSX_MAX}) — extract a hook or sub-component"
                )
            continue
        is_util = comp.path.startswith(FRONTEND_UTIL_PREFIX)
        ceiling = FRONTEND_UTIL_MAX if is_util else FRONTEND_COMPONENT_MAX
        if comp.lines > ceiling:
            suggestion = (
                "split into focused modules"
                if is_util
                else "extract sub-components"
            )
            errors.append(
                f"frontend: `{comp.path}` is {comp.lines} lines "
                f"(ceiling {ceiling}) — {suggestion}"
            )

    if errors:
        print("Code-quality gate FAILED:")
        for err in errors:
            print(f"  - {err}")
        print(
            "\nRun `python scripts/code_quality_report.py` for the full report, "
            "and see docs/architecture/code-quality-analysis.md for context."
        )
        return 1

    print("Code-quality gate OK.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
