# Copyright (c) 2025-2026, RTE (https://www.rte-france.com)
# This Source Code Form is subject to the terms of the Mozilla Public License, version 2.0.
# If a copy of the Mozilla Public License, version 2.0 was not distributed with this file,
# you can obtain one at http://mozilla.org/MPL/2.0/.
# SPDX-License-Identifier: MPL-2.0
"""Unit tests for the D9 docs-as-checked-artifact gate (scripts/check_docs_tree.py).

Two layers:
  1. Fixture-driven: build a throwaway doc + tree under tmp_path and assert
     scan_docs() classifies each reference (exists / missing / removed-context /
     generated / line-anchor) correctly. Hermetic.
  2. Self-guard: the REAL repo's inventory docs must pass the gate (main() == 0),
     so any future drift fails this test too — not just the CI step.
"""
import importlib.util
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def _load():
    spec = importlib.util.spec_from_file_location(
        "check_docs_tree", os.path.join(HERE, "check_docs_tree.py")
    )
    mod = importlib.util.module_from_spec(spec)
    # Register before exec so the dataclass's `from __future__ import annotations`
    # field resolution can find the module in sys.modules.
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


mod = _load()


def _write(root, rel, text):
    p = root / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")
    return p


def test_existing_reference_passes(tmp_path):
    _write(tmp_path, "expert_backend/services/foo.py", "x = 1\n")
    _write(tmp_path, "doc.md", "See `services/foo.py` for details.\n")
    f = mod.scan_docs(tmp_path, doc_files=["doc.md"])
    assert f.total == 0


def test_missing_reference_is_flagged(tmp_path):
    _write(tmp_path, "doc.md", "See `services/ghost.py` for details.\n")
    f = mod.scan_docs(tmp_path, doc_files=["doc.md"])
    assert [r for _, _, r in f.missing_paths] == ["services/ghost.py"]


def test_removed_context_same_line_is_exempt(tmp_path):
    _write(tmp_path, "doc.md", "The `recommenders/_service_integration.py` module was removed.\n")
    f = mod.scan_docs(tmp_path, doc_files=["doc.md"])
    assert f.missing_paths == []


def test_removed_context_wrapped_line_is_exempt(tmp_path):
    # The "former … removed" qualifier wraps onto neighbouring lines.
    _write(tmp_path, "doc.md",
           "the former\n`recommenders/_service_integration.py` module\nwas removed in D1.\n")
    f = mod.scan_docs(tmp_path, doc_files=["doc.md"])
    assert f.missing_paths == []


def test_generated_artifact_is_exempt(tmp_path):
    _write(tmp_path, "doc.md",
           "Build produces `frontend/dist-standalone/standalone.html` and `Overflow_Graph/x.pdf`.\n")
    f = mod.scan_docs(tmp_path, doc_files=["doc.md"])
    # standalone.html (generated suffix) is exempt; Overflow_Graph/x.pdf has no
    # tracked extension so it's not a candidate at all — either way, no finding.
    assert f.missing_paths == []


def test_line_number_anchor_is_flagged(tmp_path):
    _write(tmp_path, "services/foo.py", "x = 1\n")
    _write(tmp_path, "doc.md", "See the singleton at `services/foo.py:352` for details.\n")
    f = mod.scan_docs(tmp_path, doc_files=["doc.md"])
    assert [a for _, _, a in f.line_anchors] == ["services/foo.py:352"]


def test_line_range_anchor_is_flagged(tmp_path):
    _write(tmp_path, "doc.md", "`App.tsx:310-324` resets state.\n")
    f = mod.scan_docs(tmp_path, doc_files=["doc.md"])
    assert [a for _, _, a in f.line_anchors] == ["App.tsx:310-324"]


def test_bare_filename_without_slash_is_ignored(tmp_path):
    # Bare names (`main.py`, `App.tsx`) are illustrative and too ambiguous to
    # resolve — only directory-qualified paths are existence-checked.
    _write(tmp_path, "doc.md", "Edit `main.py` and `types.ts` as needed.\n")
    f = mod.scan_docs(tmp_path, doc_files=["doc.md"])
    assert f.missing_paths == []


def test_gate_returns_nonzero_only_without_warn_only(tmp_path, monkeypatch, capsys):
    _write(tmp_path, "doc.md", "Broken `services/ghost.py`.\n")
    monkeypatch.setattr(mod, "REPO_ROOT", tmp_path)
    monkeypatch.setattr(mod, "DOC_FILES", ["doc.md"])
    assert mod.main([]) == 1
    assert mod.main(["--warn-only"]) == 0
    out = capsys.readouterr().out
    assert "services/ghost.py" in out


def test_real_repo_inventory_docs_are_clean():
    # Self-guard: the committed CLAUDE.md tree must stay drift-free, so a future
    # rename that forgets the docs fails HERE, not only in the CI gate step.
    assert mod.main([]) == 0
