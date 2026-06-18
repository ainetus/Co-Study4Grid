# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0
"""Unit tests for the code-quality reporter.

These exercise the smell-detection AST walker with hand-rolled source
fragments so the checks stay stable even as the repo evolves. The
integration side — "running the script against the whole repo does not
raise" — is covered by `scripts/check_code_quality.py` itself.
"""
from __future__ import annotations

import ast
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from code_quality_report import (  # noqa: E402
    ANY_TYPE_RE,
    BACKEND_SUPPRESSION_RE,
    TS_IGNORE_RE,
    _count_python_smells,
    build_report,
    iter_backend_modules,
    iter_frontend_sources,
)


def _smells(src: str) -> tuple[int, int, int]:
    return _count_python_smells(ast.parse(src))


def test_counts_bare_print_call():
    src = "def f():\n    print('hi')\n"
    prints, tb, silent = _smells(src)
    assert prints == 1 and tb == 0 and silent == 0


def test_does_not_count_print_inside_string_literal():
    # A `print(...)` embedded in a multi-line string — e.g. the tkinter
    # subprocess script in `main.py` — must not be flagged.
    src = 'def f():\n    script = """\nprint(path)\n"""\n    return script\n'
    prints, _, _ = _smells(src)
    assert prints == 0


def test_counts_traceback_print_exc():
    src = "import traceback\ndef f():\n    try: pass\n    except Exception:\n        traceback.print_exc()\n"
    _, tb, _ = _smells(src)
    assert tb == 1


def test_counts_silent_except_pass():
    src = "def f():\n    try: pass\n    except Exception:\n        pass\n"
    _, _, silent = _smells(src)
    assert silent == 1


def test_logged_except_is_not_silent():
    src = (
        "import logging\n"
        "logger = logging.getLogger(__name__)\n"
        "def f():\n"
        "    try: pass\n"
        "    except Exception as e:\n"
        "        logger.debug('suppressed: %s', e)\n"
    )
    _, _, silent = _smells(src)
    assert silent == 0


def test_bare_except_pass_also_counts():
    src = "def f():\n    try: pass\n    except:\n        pass\n"
    _, _, silent = _smells(src)
    assert silent == 1


def test_build_report_against_repo_root():
    """The whole-repo scan returns sane numbers and no exceptions."""
    report = build_report()
    assert report.backend.source_files >= 5
    assert report.backend.total_lines > 0
    assert report.frontend.source_files >= 10
    assert report.frontend.total_lines > 0
    # Gate invariants — if these regress, CI will fail on
    # `check_code_quality.py` anyway.
    assert report.backend.print_calls == 0
    assert report.backend.traceback_prints == 0
    assert report.backend.silent_excepts == 0
    assert report.frontend.any_types == 0
    assert report.frontend.ts_ignores == 0
    # Ratcheted smells stay at or below their frozen ceilings.
    assert report.backend.lint_suppressions <= 3
    assert report.frontend.weak_casts <= 19
    assert report.frontend.record_str_unknown <= 46


def test_any_type_re_catches_as_any_assertion_casts():
    # `as any` (assertion cast) was a blind spot — only annotation
    # positions used to be caught.
    assert ANY_TYPE_RE.search("const x = y as any;")
    assert ANY_TYPE_RE.search("function f(a: any) {}")
    assert ANY_TYPE_RE.search("const xs: any[] = [];")
    assert ANY_TYPE_RE.search("const g: Foo<any> = h;")
    # `any` as a substring of an identifier must not match.
    assert not ANY_TYPE_RE.search("const company = 1;")


def test_ts_ignore_re_catches_expect_error_and_nocheck():
    assert TS_IGNORE_RE.search("// @ts-ignore")
    assert TS_IGNORE_RE.search("// @ts-expect-error: not in global types")
    assert TS_IGNORE_RE.search("// @ts-nocheck")
    assert not TS_IGNORE_RE.search("// eslint-disable-next-line")


def test_backend_suppression_re_catches_noqa_and_type_ignore():
    assert BACKEND_SUPPRESSION_RE.search("import x  # noqa: F401")
    assert BACKEND_SUPPRESSION_RE.search("z = w()  # type: ignore[arg-type]")
    assert not BACKEND_SUPPRESSION_RE.search("# an ordinary comment")


def test_backend_scan_covers_recommenders_but_not_setup_scripts():
    """The widened scan reaches `expert_backend/recommenders/` (gated for
    the first time) while keeping setup-time / ad-hoc scripts and the test
    suite out of scope."""
    mods = {str(p) for p in iter_backend_modules()}
    assert any(f"recommenders{Path('/').as_posix()}" in m.replace("\\", "/")
               for m in mods), "recommenders/ package should now be scanned"
    assert not any(m.endswith("install_graphviz.py") for m in mods)
    assert not any(m.endswith("test_backend.py") for m in mods)
    assert all("/tests/" not in m.replace("\\", "/") for m in mods)


def test_frontend_scan_excludes_test_infra():
    """Test files and the `src/test/` infra dir (which carries the
    `@ts-expect-error` mocks) are not counted as product source."""
    srcs = {str(p).replace("\\", "/") for p in iter_frontend_sources()}
    assert srcs
    assert all("/test/" not in s for s in srcs)
    assert all(".test." not in s for s in srcs)


def test_all_functions_populated():
    """`all_functions` exposes every backend function for the gate."""
    report = build_report()
    # Every entry in the top-5 must also appear in `all_functions`.
    assert len(report.backend.all_functions) >= len(report.backend.longest_functions)
    top_keys = {(fn.file, fn.name) for fn in report.backend.longest_functions}
    all_keys = {(fn.file, fn.name) for fn in report.backend.all_functions}
    assert top_keys.issubset(all_keys)


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__]))
