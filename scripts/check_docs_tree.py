#!/usr/bin/env python3
# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0
"""D9 — docs as a checked artifact.

The hand-maintained ``CLAUDE.md`` inventory docs (root + per-subtree) carry an
elaborate file tree and hundreds of ``path/like/this.py`` references. They drift:
files get renamed / removed and the prose keeps pointing at the old name, and
``file.py:352`` line-number anchors rot on the very next edit. This gate keeps
that inventory layer honest with two checks:

  A. **Referenced-path existence.** Every backtick-quoted, directory-qualified
     path with a source/asset extension must resolve to a real file (under any
     sensible base dir — the docs write paths relative to their own subtree),
     UNLESS it is a known generated/runtime artifact or is referenced *as
     removed* (its line says "removed / former / renamed / superseded / …").

  B. **No stale line-number anchors.** ``foo.py:352`` anchors are forbidden;
     the convention is a **symbol anchor** — name the function / class instead,
     which survives edits. (The review's own anchors had already rotted by
     hundreds of lines; this stops that class of drift recurring.)

Usage::

    python scripts/check_docs_tree.py             # gate: non-zero on any finding
    python scripts/check_docs_tree.py --warn-only # report only, always exit 0
    python scripts/check_docs_tree.py --json      # machine-readable findings

The module also exposes ``scan_docs(repo_root)`` returning structured findings so
``scripts/test_check_docs_tree.py`` can drive it hermetically on tmp fixtures.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

# The inventory docs this gate guards. Add a doc here to bring it under the gate.
DOC_FILES = [
    "CLAUDE.md",
    "expert_backend/CLAUDE.md",
    "expert_backend/tests/CLAUDE.md",
    "frontend/CLAUDE.md",
]

# Paths in these docs are written relative to a contextual base (a frontend doc
# says ``components/Foo.tsx`` meaning ``frontend/src/components/Foo.tsx``). A
# reference is satisfied if it exists under ANY of these bases — we care that the
# file EXISTS somewhere sensible, not that its relative form is canonical.
BASE_DIRS = [
    ".",
    "frontend",
    "frontend/src",
    "expert_backend",
    "expert_backend/tests",
    "scripts",
    "scripts/game_mode",
    "scripts/pypsa_eur",
    "docs",
    "data",
    "deploy",
]

# A directory-qualified path with a source/asset extension, in backticks.
PATH_RE = re.compile(r"`([A-Za-z0-9_./-]+/[A-Za-z0-9_./-]+\.(?:py|ts|tsx|css|json|html|md))`")

# A rotting line-number anchor: ``file.py:352`` or ``file.tsx:310-324``.
ANCHOR_RE = re.compile(r"\b([A-Za-z0-9_./-]+\.(?:py|ts|tsx|css|json|html)):(\d+(?:-\d+)?)\b")

# Generated / runtime artifacts that legitimately do not exist in a fresh clone.
# Matched as a suffix of the referenced path.
GENERATED_SUFFIXES = (
    "dist-standalone/standalone.html",
    "frontend/dist/index.html",
    "reports/code-quality.json",
    "reports/code-quality.md",
)
# Generated / runtime path segments (matched anywhere in the reference).
GENERATED_SEGMENTS = (
    "Overflow_Graph/",
    "/dist/",
    "test-results/",
    "node_modules/",
)

# When a reference's own line carries one of these words it is being described
# AS gone (a removed module, a renamed file) — existence must NOT be asserted.
REMOVED_RE = re.compile(
    r"\b(removed|former|formerly|deleted|decommission|decommissioned|renamed|"
    r"superseded|supersedes|no longer|legacy|replaced by|replaces the|frozen)\b",
    re.IGNORECASE,
)


@dataclass
class Findings:
    missing_paths: list[tuple[str, int, str]] = field(default_factory=list)
    line_anchors: list[tuple[str, int, str]] = field(default_factory=list)

    @property
    def total(self) -> int:
        return len(self.missing_paths) + len(self.line_anchors)

    def as_dict(self) -> dict:
        return {
            "missing_paths": [
                {"doc": d, "line": ln, "ref": r} for d, ln, r in self.missing_paths
            ],
            "line_anchors": [
                {"doc": d, "line": ln, "anchor": a} for d, ln, a in self.line_anchors
            ],
            "total": self.total,
        }


def _is_generated(ref: str) -> bool:
    if any(ref.endswith(sfx) for sfx in GENERATED_SUFFIXES):
        return True
    return any(seg in ref for seg in GENERATED_SEGMENTS)


def _resolves(ref: str, repo_root: Path) -> bool:
    return any((repo_root / base / ref).exists() for base in BASE_DIRS)


def scan_docs(repo_root: Path, doc_files: list[str] | None = None) -> Findings:
    """Scan the inventory docs and return structured findings.

    Pure and side-effect free (no printing) so tests can drive it on fixtures.
    """
    findings = Findings()
    for doc in doc_files if doc_files is not None else DOC_FILES:
        doc_path = repo_root / doc
        if not doc_path.exists():
            continue
        lines = doc_path.read_text(encoding="utf-8").splitlines()
        for lineno, line in enumerate(lines, 1):
            # Prose wraps, so a "removed / renamed / …" qualifier can sit on the
            # line before or after the reference itself — scan a ±1 window.
            window = " ".join(lines[max(0, lineno - 2):lineno + 1])
            removed_context = bool(REMOVED_RE.search(window))
            for m in PATH_RE.finditer(line):
                ref = m.group(1)
                if removed_context or _is_generated(ref):
                    continue
                if not _resolves(ref, repo_root):
                    findings.missing_paths.append((doc, lineno, ref))
            for m in ANCHOR_RE.finditer(line):
                findings.line_anchors.append((doc, lineno, f"{m.group(1)}:{m.group(2)}"))
    return findings


def _report(findings: Findings) -> None:
    if findings.missing_paths:
        print("Docs reference files that do not exist (rename/remove drift):")
        for doc, ln, ref in findings.missing_paths:
            print(f"  - {doc}:{ln}  →  `{ref}`")
        print("  Fix: update the path, or note it as removed/generated on the same line.")
    if findings.line_anchors:
        print("Docs use stale line-number anchors (they rot on every edit):")
        for doc, ln, anchor in findings.line_anchors:
            print(f"  - {doc}:{ln}  →  `{anchor}`")
        print("  Fix: replace `file.ext:NNN` with a SYMBOL anchor (name the "
              "function/class), e.g. `network_service.py` (`load_network`).")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="D9 docs-as-checked-artifact gate.")
    ap.add_argument("--warn-only", action="store_true",
                    help="Report findings but always exit 0 (roll-in mode).")
    ap.add_argument("--json", action="store_true", help="Emit findings as JSON.")
    args = ap.parse_args(argv)

    findings = scan_docs(REPO_ROOT)

    if args.json:
        print(json.dumps(findings.as_dict(), indent=2))
    else:
        _report(findings)
        if findings.total == 0:
            print("Docs-tree gate OK — every referenced path exists, no stale line anchors.")

    if findings.total and not args.warn_only:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
