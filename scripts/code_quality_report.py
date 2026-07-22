#!/usr/bin/env python3
# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0
"""Aggregate code-quality metrics for Co-Study4Grid.

Runs entirely offline against the repo source tree:

    python scripts/code_quality_report.py                      # stdout JSON
    python scripts/code_quality_report.py --markdown REPORT.md # also emit markdown
    python scripts/code_quality_report.py --output report.json

The report is the ground truth for the "Metrics Summary" table in
`docs/architecture/code-quality-analysis.md` and feeds the PR gate in
`scripts/check_code_quality.py`.

Metrics:
- Per-module backend LoC + largest file + per-function length (top-N)
- Per-component frontend LoC + largest file
- Count of `print(` / `traceback.print_exc` / bare `except Exception: pass`
- Count of `any`-typed fields / `@ts-ignore` / `as unknown as` / `Record<string, unknown>`
  in frontend source
- Test-file counts for backend + frontend
"""
from __future__ import annotations

import argparse
import ast
import json
import re
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
BACKEND_ROOT = REPO_ROOT / "expert_backend"
BACKEND_TEST_ROOT = BACKEND_ROOT / "tests"
# Backend Python deliberately OUTSIDE the runtime code-quality gate.
# `test_backend.py` is an ad-hoc integration script (not pytest), and
# `install_graphviz.py` is a setup-time installer invoked from setup.py
# that legitimately prints install progress to the console. Everything
# else under `expert_backend/` (incl. `__init__.py` and any future
# top-level module) is now scanned — previously only `main.py` +
# `services/` were, which let smells in sibling modules slip past unseen.
BACKEND_EXCLUDED_NAMES = {"test_backend.py", "install_graphviz.py"}
FRONTEND_SRC_ROOT = REPO_ROOT / "frontend" / "src"

# Frontend regex patterns — TS/TSX parsing is out of scope so we
# scan source text directly. Python smells are parsed through `ast`
# (see `_count_python_smells`) to avoid false positives from string
# literals and comments.
# `: any`, `<any>`, `any[]`, and `as any`. The last (assertion casts)
# was previously a blind spot — only annotation positions were caught.
ANY_TYPE_RE = re.compile(r":\s*any\b|<\s*any\s*>|\bany\[\]|\bas\s+any\b")
# `@ts-ignore` plus its equivalents `@ts-expect-error` / `@ts-nocheck`
# — all three suppress the type checker, so they are gated together.
TS_IGNORE_RE = re.compile(r"@ts-(?:ignore|expect-error|nocheck)\b")
AS_UNKNOWN_RE = re.compile(r"as\s+unknown\s+as\b")
RECORD_STR_UNK_RE = re.compile(r"Record<string,\s*unknown>")
# `console.log` in frontend source (excl. tests). Left over from perf
# instrumentation in the SVG / diagram hot paths; noisy in production. Gated as
# a ratchet (freeze at the current count, lower over time) — `console.warn` /
# `console.error` stay allowed for genuine diagnostics.
CONSOLE_LOG_RE = re.compile(r"\bconsole\.log\b")
# Backend lint / type suppressions ("noqa" / "type: ignore" markers).
# Often legitimate (a re-exported import, a logged broad except) so they
# are reported + ratcheted rather than hard-zeroed.
BACKEND_SUPPRESSION_RE = re.compile(r"#\s*(?:noqa|type:\s*ignore)")
# Hex color literals: #RGB, #RGBA, #RRGGBB, #RRGGBBAA. Excludes HTML
# numeric entities like `&#9881;` via the negative lookbehind.
# Token-source-of-truth files are exempt from the count (see
# FRONTEND_HEX_EXEMPT_FILES).
HEX_LITERAL_RE = re.compile(
    r"(?<![\w&#])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b"
)
FRONTEND_HEX_EXEMPT_FILES = {
    "frontend/src/styles/tokens.css",
    # `tokens.ts` carries the raw-hex pin palette consumed by
    # `setAttribute('fill', …)` calls in utils/svg/actionPin*.ts,
    # which can't reliably resolve var() inside SVG presentation
    # attributes. See the comment block in tokens.ts.
    "frontend/src/styles/tokens.ts",
}


def _count_python_smells(tree: ast.AST) -> tuple[int, int, int]:
    """Return (print_calls, traceback_print_exc_calls, silent_except_blocks)."""
    prints = tracebacks = silent = 0
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            func = node.func
            if isinstance(func, ast.Name) and func.id == "print":
                prints += 1
            elif (
                isinstance(func, ast.Attribute)
                and func.attr == "print_exc"
                and isinstance(func.value, ast.Name)
                and func.value.id == "traceback"
            ):
                tracebacks += 1
        elif isinstance(node, ast.ExceptHandler):
            exc_type = node.type
            is_broad = (
                exc_type is None
                or (isinstance(exc_type, ast.Name) and exc_type.id == "Exception")
            )
            body = node.body
            if (
                is_broad
                and len(body) == 1
                and isinstance(body[0], ast.Pass)
            ):
                silent += 1
    return prints, tracebacks, silent


def _pct(num: int, denom: int) -> int:
    return round(100 * num / denom) if denom else 0


def count_lines(path: Path) -> int:
    try:
        return sum(1 for _ in path.open("r", encoding="utf-8"))
    except OSError:
        return 0


def count_code_lines(
    path: Path,
    line_comments: tuple[str, ...],
    block: tuple[str, str] | None = None,
) -> int:
    """Logical (code) lines: non-blank, non-comment physical lines.

    A deliberately simple heuristic shared by backend (`#`) and frontend
    (`//` + `/* … */`). It does not strip trailing inline comments or
    code that shares a line with a closing block comment, so it slightly
    over-counts — fine for an *informational* metric (the gated ceilings
    stay on raw `count_lines`). Reported alongside raw LoC so a dense
    600-line module reads differently from a 600-line file that is half
    blanks and docstrings.
    """
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return 0
    code = 0
    in_block = False
    bstart, bend = block if block else (None, None)
    for raw in text.splitlines():
        s = raw.strip()
        if not s:
            continue
        if in_block:
            if bend and bend in s:
                in_block = False
            continue
        if bstart and s.startswith(bstart):
            if bend and bend not in s:
                in_block = True
            continue
        if any(s.startswith(c) for c in line_comments):
            continue
        code += 1
    return code


# Cyclomatic complexity (McCabe) + max nesting depth, computed from the
# AST we already parse — no external dependency (radon et al. not
# required). A function's complexity is 1 + each decision point; nesting
# is the deepest stack of compound statements.
_CC_DECISION = (ast.If, ast.For, ast.AsyncFor, ast.While, ast.ExceptHandler,
                ast.IfExp, ast.Assert)
_NEST_NODES = (ast.If, ast.For, ast.AsyncFor, ast.While, ast.With,
               ast.AsyncWith, ast.Try)


def _cyclomatic_complexity(fn: ast.AST) -> int:
    cc = 1
    for node in ast.walk(fn):
        if isinstance(node, _CC_DECISION):
            cc += 1
        elif isinstance(node, ast.BoolOp):
            cc += len(node.values) - 1
        elif isinstance(node, ast.comprehension):
            cc += 1 + len(node.ifs)
    return cc


def _max_nesting(fn: ast.AST) -> int:
    best = 0

    def walk(node: ast.AST, depth: int) -> None:
        nonlocal best
        for child in ast.iter_child_nodes(node):
            d = depth + 1 if isinstance(child, _NEST_NODES) else depth
            if d > best:
                best = d
            walk(child, d)

    walk(fn, 0)
    return best


@dataclass
class FileMetric:
    path: str
    lines: int


@dataclass
class FunctionMetric:
    file: str
    name: str
    lines: int
    complexity: int = 1
    max_nesting: int = 0
    has_return_annotation: bool = False
    is_dunder: bool = False


@dataclass
class BackendReport:
    modules: list[FileMetric] = field(default_factory=list)
    largest_module: FileMetric | None = None
    longest_functions: list[FunctionMetric] = field(default_factory=list)
    most_complex: list[FunctionMetric] = field(default_factory=list)
    deepest_nested: list[FunctionMetric] = field(default_factory=list)
    all_functions: list[FunctionMetric] = field(default_factory=list)
    total_lines: int = 0
    code_lines: int = 0
    print_calls: int = 0
    traceback_prints: int = 0
    silent_excepts: int = 0
    lint_suppressions: int = 0
    functions_annotatable: int = 0
    functions_missing_return: int = 0
    test_files: int = 0
    source_files: int = 0


@dataclass
class FrontendReport:
    components: list[FileMetric] = field(default_factory=list)
    largest_component: FileMetric | None = None
    total_lines: int = 0
    code_lines: int = 0
    any_types: int = 0
    ts_ignores: int = 0
    weak_casts: int = 0
    record_str_unknown: int = 0
    console_logs: int = 0
    test_files: int = 0
    source_files: int = 0
    hex_literals: int = 0
    hex_literals_by_file: list[FileMetric] = field(default_factory=list)


@dataclass
class QualityReport:
    backend: BackendReport = field(default_factory=BackendReport)
    frontend: FrontendReport = field(default_factory=FrontendReport)


def iter_backend_modules() -> list[Path]:
    if not BACKEND_ROOT.is_dir():
        return []
    files: list[Path] = []
    for p in BACKEND_ROOT.rglob("*.py"):
        parts = p.relative_to(BACKEND_ROOT).parts
        if "__pycache__" in parts or "tests" in parts:
            continue
        if p.name in BACKEND_EXCLUDED_NAMES:
            continue
        files.append(p)
    return sorted(files)


def _is_frontend_test_path(p: Path) -> bool:
    """True for test files (`*.test.*`) and the `src/test/` infra dir.

    Test infrastructure (e.g. `src/test/setup.ts`, which carries the
    `@ts-expect-error` mocks) is not product source and must not count
    toward component LoC or the type-suppression gates.
    """
    return ".test." in p.name or "test" in p.relative_to(FRONTEND_SRC_ROOT).parts


def iter_frontend_sources() -> list[Path]:
    if not FRONTEND_SRC_ROOT.is_dir():
        return []
    files = []
    for p in FRONTEND_SRC_ROOT.rglob("*"):
        if p.suffix not in {".ts", ".tsx"}:
            continue
        if _is_frontend_test_path(p):
            continue
        files.append(p)
    return sorted(files)


def iter_frontend_tests() -> list[Path]:
    if not FRONTEND_SRC_ROOT.is_dir():
        return []
    return sorted(p for p in FRONTEND_SRC_ROOT.rglob("*") if ".test." in p.name)


def iter_frontend_styled_sources() -> list[Path]:
    """Source files where hex-color literals can occur — .ts/.tsx/.css."""
    if not FRONTEND_SRC_ROOT.is_dir():
        return []
    files = []
    for p in FRONTEND_SRC_ROOT.rglob("*"):
        if p.suffix not in {".ts", ".tsx", ".css"}:
            continue
        if _is_frontend_test_path(p):
            continue
        files.append(p)
    return sorted(files)


def extract_all_functions(path: Path) -> list[FunctionMetric]:
    """Return every top-level + nested function in `path` with its LoC.

    Used by both the per-file top-N display and the function-LoC gate
    in `check_code_quality.py` (which iterates the full list).
    """
    try:
        src = path.read_text(encoding="utf-8")
    except OSError:
        return []
    try:
        tree = ast.parse(src, filename=str(path))
    except SyntaxError:
        return []
    out: list[FunctionMetric] = []
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            start = node.lineno
            end = getattr(node, "end_lineno", start) or start
            length = max(0, end - start + 1)
            name = node.name
            out.append(
                FunctionMetric(
                    file=str(path.relative_to(REPO_ROOT)),
                    name=name,
                    lines=length,
                    complexity=_cyclomatic_complexity(node),
                    max_nesting=_max_nesting(node),
                    has_return_annotation=node.returns is not None,
                    is_dunder=name.startswith("__") and name.endswith("__"),
                )
            )
    return out


def extract_longest_functions(path: Path, top_n: int = 5) -> list[FunctionMetric]:
    out = extract_all_functions(path)
    out.sort(key=lambda m: m.lines, reverse=True)
    return out[:top_n]


def scan_backend() -> BackendReport:
    rep = BackendReport()
    for path in iter_backend_modules():
        rel = str(path.relative_to(REPO_ROOT))
        lines = count_lines(path)
        rep.modules.append(FileMetric(path=rel, lines=lines))
        rep.total_lines += lines
        rep.code_lines += count_code_lines(path, ("#",))
        rep.source_files += 1

        try:
            src = path.read_text(encoding="utf-8")
        except OSError:
            continue
        try:
            tree = ast.parse(src, filename=str(path))
        except SyntaxError:
            continue
        prints, tracebacks, silent = _count_python_smells(tree)
        rep.print_calls += prints
        rep.traceback_prints += tracebacks
        rep.silent_excepts += silent
        rep.lint_suppressions += len(BACKEND_SUPPRESSION_RE.findall(src))

        rep.all_functions.extend(extract_all_functions(path))

    rep.modules.sort(key=lambda m: m.lines, reverse=True)
    if rep.modules:
        rep.largest_module = rep.modules[0]
    rep.all_functions.sort(key=lambda m: m.lines, reverse=True)
    rep.longest_functions = rep.all_functions[:5]
    rep.most_complex = sorted(
        rep.all_functions, key=lambda m: m.complexity, reverse=True
    )[:5]
    rep.deepest_nested = sorted(
        rep.all_functions, key=lambda m: m.max_nesting, reverse=True
    )[:5]
    annotatable = [f for f in rep.all_functions if not f.is_dunder]
    rep.functions_annotatable = len(annotatable)
    rep.functions_missing_return = sum(
        1 for f in annotatable if not f.has_return_annotation
    )

    if BACKEND_TEST_ROOT.is_dir():
        rep.test_files = sum(
            1 for p in BACKEND_TEST_ROOT.rglob("test_*.py") if "__pycache__" not in p.parts
        )
    return rep


def scan_frontend() -> FrontendReport:
    rep = FrontendReport()
    for path in iter_frontend_sources():
        rel = str(path.relative_to(REPO_ROOT))
        lines = count_lines(path)
        rep.components.append(FileMetric(path=rel, lines=lines))
        rep.total_lines += lines
        rep.code_lines += count_code_lines(path, ("//",), block=("/*", "*/"))
        rep.source_files += 1

        try:
            src = path.read_text(encoding="utf-8")
        except OSError:
            continue
        rep.any_types += len(ANY_TYPE_RE.findall(src))
        rep.ts_ignores += len(TS_IGNORE_RE.findall(src))
        rep.weak_casts += len(AS_UNKNOWN_RE.findall(src))
        rep.record_str_unknown += len(RECORD_STR_UNK_RE.findall(src))
        rep.console_logs += len(CONSOLE_LOG_RE.findall(src))

    rep.components.sort(key=lambda m: m.lines, reverse=True)
    if rep.components:
        rep.largest_component = rep.components[0]
    rep.test_files = len(iter_frontend_tests())

    # Count hex literals across .ts/.tsx/.css sources, excluding the
    # token-definition file (the source of truth for hex values).
    for path in iter_frontend_styled_sources():
        rel = str(path.relative_to(REPO_ROOT))
        if rel in FRONTEND_HEX_EXEMPT_FILES:
            continue
        try:
            src = path.read_text(encoding="utf-8")
        except OSError:
            continue
        hits = len(HEX_LITERAL_RE.findall(src))
        if hits:
            rep.hex_literals += hits
            rep.hex_literals_by_file.append(FileMetric(path=rel, lines=hits))
    rep.hex_literals_by_file.sort(key=lambda m: m.lines, reverse=True)
    return rep


def build_report() -> QualityReport:
    return QualityReport(backend=scan_backend(), frontend=scan_frontend())


def to_markdown(report: QualityReport) -> str:
    be = report.backend
    fe = report.frontend
    lines = [
        "# Code-Quality Report",
        "",
        "_Auto-generated by `scripts/code_quality_report.py`. Do not edit by hand._",
        "",
        "## Backend (`expert_backend/`)",
        "",
        f"- Source files (non-test): **{be.source_files}**",
        f"- Total lines: **{be.total_lines}** (code lines, excl. blank/comment: "
        f"**{be.code_lines}**)",
    ]
    if be.largest_module:
        lines.append(
            f"- Largest module: `{be.largest_module.path}` ({be.largest_module.lines} lines)"
        )
    lines.extend(
        [
            f"- Test files: **{be.test_files}**",
            f"- `print(` calls in source: **{be.print_calls}**",
            f"- `traceback.print_exc()` calls: **{be.traceback_prints}**",
            f"- Bare `except Exception: pass` patterns: **{be.silent_excepts}**",
            f"- `# noqa` / `# type: ignore` suppressions (ratcheted): **{be.lint_suppressions}**",
            f"- Return-annotation coverage: **{be.functions_annotatable - be.functions_missing_return}"
            f"/{be.functions_annotatable}** "
            f"({_pct(be.functions_annotatable - be.functions_missing_return, be.functions_annotatable)}%) "
            f"— missing **{be.functions_missing_return}** (ratcheted)",
            "",
            "### Top-5 longest functions",
            "",
            "| File | Function | Lines |",
            "|------|----------|-------|",
        ]
    )
    for fn in be.longest_functions:
        lines.append(f"| `{fn.file}` | `{fn.name}` | {fn.lines} |")
    lines.extend(
        [
            "",
            "### Most complex functions (cyclomatic)",
            "",
            "| File | Function | Complexity | Nesting |",
            "|------|----------|-----------:|--------:|",
        ]
    )
    for fn in be.most_complex:
        lines.append(
            f"| `{fn.file}` | `{fn.name}` | {fn.complexity} | {fn.max_nesting} |"
        )
    lines.extend(
        [
            "",
            "### Deepest nesting",
            "",
            "| File | Function | Nesting | Complexity |",
            "|------|----------|--------:|-----------:|",
        ]
    )
    for fn in be.deepest_nested:
        lines.append(
            f"| `{fn.file}` | `{fn.name}` | {fn.max_nesting} | {fn.complexity} |"
        )
    lines.extend(
        [
            "",
            "## Frontend (`frontend/src/`)",
            "",
            f"- Source files (non-test): **{fe.source_files}**",
            f"- Total lines: **{fe.total_lines}** (code lines, excl. blank/comment: "
            f"**{fe.code_lines}**)",
        ]
    )
    if fe.largest_component:
        lines.append(
            f"- Largest component: `{fe.largest_component.path}` "
            f"({fe.largest_component.lines} lines)"
        )
    lines.extend(
        [
            f"- Test files: **{fe.test_files}**",
            f"- `any` type annotations: **{fe.any_types}**",
            f"- `@ts-ignore` directives: **{fe.ts_ignores}**",
            f"- `as unknown as` casts: **{fe.weak_casts}**",
            f"- `Record<string, unknown>` usages: **{fe.record_str_unknown}**",
            f"- `console.log` calls (ratcheted): **{fe.console_logs}**",
            f"- Hex color literals (outside tokens.css): **{fe.hex_literals}**",
            "",
        ]
    )
    if fe.hex_literals_by_file:
        lines.extend(
            [
                "### Top files by hex-literal count",
                "",
                "| File | Hex literals |",
                "|------|-------------:|",
            ]
        )
        for fm in fe.hex_literals_by_file[:10]:
            lines.append(f"| `{fm.path}` | {fm.lines} |")
        lines.append("")
    return "\n".join(lines)


def _report_to_jsonable(report: QualityReport) -> dict:
    return {
        "backend": asdict(report.backend),
        "frontend": asdict(report.frontend),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, help="Write JSON report to this path")
    parser.add_argument(
        "--markdown",
        type=Path,
        help="Also write a human-readable Markdown report to this path",
    )
    parser.add_argument(
        "--summary",
        action="store_true",
        help="Print a one-line summary to stdout instead of the full JSON",
    )
    args = parser.parse_args(argv)

    report = build_report()
    payload = _report_to_jsonable(report)

    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    if args.markdown:
        args.markdown.parent.mkdir(parents=True, exist_ok=True)
        args.markdown.write_text(to_markdown(report), encoding="utf-8")

    if args.summary:
        be = report.backend
        fe = report.frontend
        print(
            f"backend: {be.source_files} files, {be.total_lines} LoC, "
            f"largest={be.largest_module.lines if be.largest_module else 0} | "
            f"frontend: {fe.source_files} files, {fe.total_lines} LoC, "
            f"largest={fe.largest_component.lines if fe.largest_component else 0}"
        )
    elif not args.output:
        print(json.dumps(payload, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
