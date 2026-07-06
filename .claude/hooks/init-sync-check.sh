#!/usr/bin/env bash
#
# SessionStart init check — git sync verification for marota-fork sessions.
#
# Runs automatically at the start of every Claude Code session. It performs a
# REAL `git fetch` of the repository's default branch and reports whether the
# current working branch is in sync with it (ahead / behind counts), so a new
# session never assumes it is up to date based on a possibly-stale local
# `origin/<default>` ref.
#
# Design contract:
#   * READ-ONLY   — never mutates the working tree, index, or any branch
#                   (only `git fetch`, which updates remote-tracking refs).
#   * NON-FATAL   — any failure (no network, no git, detached HEAD, …) exits 0
#                   so it can never block or break session startup.
#   * SCOPED      — only emits the detailed check for `marota/*` origins, per
#                   the "starting a new session from a marota fork" request;
#                   a no-op for every other remote.
#   * SYNCHRONOUS — fast (one time-boxed fetch); stdout is surfaced to the
#                   session as startup context.
#
set -uo pipefail

# Drain hook stdin (SessionStart passes a JSON payload we don't need) so the
# pipe closes cleanly.
cat >/dev/null 2>&1 || true

repo_root="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || true)}"
[ -z "${repo_root}" ] && exit 0
cd "${repo_root}" 2>/dev/null || exit 0

# Only act inside a git work tree.
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0

origin_url="$(git remote get-url origin 2>/dev/null || true)"

# Guard: only run for marota forks. Everything else is a silent no-op.
case "${origin_url}" in
  *marota/*) : ;;
  *) exit 0 ;;
esac

# Resolve the default branch: origin/HEAD -> `git remote show` -> main.
default_branch="$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##')"
if [ -z "${default_branch}" ]; then
  default_branch="$(git remote show origin 2>/dev/null | sed -n 's/.*HEAD branch: //p' | head -1)"
fi
[ -z "${default_branch}" ] && default_branch="main"

current_branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '(detached)')"

# Do a REAL fetch — never trust the local origin ref. Time-boxed + non-fatal.
fetch_status="ok"
if command -v timeout >/dev/null 2>&1; then
  timeout 60 git fetch --quiet origin "${default_branch}" 2>/dev/null || fetch_status="failed"
else
  git fetch --quiet origin "${default_branch}" 2>/dev/null || fetch_status="failed"
fi

counts="$(git rev-list --left-right --count "origin/${default_branch}...HEAD" 2>/dev/null || true)"
behind="$(printf '%s' "${counts}" | awk '{print $1}')"
ahead="$(printf '%s' "${counts}" | awk '{print $2}')"

echo "── Session init: git sync check (marota fork) ─────────────────────────"
echo "repo:            $(basename "${repo_root}")"
echo "current branch:  ${current_branch}"
echo "default branch:  origin/${default_branch}"
echo "origin fetch:    ${fetch_status}"
if [ -n "${counts}" ]; then
  echo "vs origin/${default_branch}:  ${behind:-?} behind, ${ahead:-?} ahead"
  if [ "${behind:-0}" -gt 0 ] 2>/dev/null; then
    echo "ACTION: branch is BEHIND origin/${default_branch} by ${behind} commit(s)."
    echo "        Rebase onto the latest default before pushing follow-up work:"
    echo "          git fetch origin ${default_branch} && git rebase origin/${default_branch}"
  elif [ "${ahead:-0}" -eq 0 ] 2>/dev/null; then
    echo "STATUS: in sync — branch tip equals origin/${default_branch}"
    echo "        (fresh branch, no unmerged work). If a prior PR for this branch"
    echo "        was already merged, treat new work as a fresh change on this base."
  else
    echo "STATUS: ${ahead} local commit(s) ahead of origin/${default_branch}, 0 behind — up to date."
  fi
else
  echo "NOTE: could not compute ahead/behind (origin/${default_branch} missing or fetch failed)."
fi
echo "PRINCIPLE: always run a real 'git fetch' to confirm sync against the remote —"
echo "           do not rely on a possibly-stale local origin ref."
echo "───────────────────────────────────────────────────────────────────────"

exit 0
