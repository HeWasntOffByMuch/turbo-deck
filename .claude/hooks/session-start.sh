#!/bin/bash
# SessionStart hook. Two jobs, both in service of CLAUDE.md.
#
#   1. Report how far this branch has drifted from origin/main, so a session
#      that is about to build on stale history hears about it up front rather
#      than at merge time.
#   2. Install dependencies, so `npm run typecheck`, `npm run lint` and
#      `npm test` — the three commands CI gates on and the only way an agent
#      verifies a change here — actually run in a fresh container.
#
# Runs synchronously: the whole verification story depends on node_modules being
# there before the first tool call, and a race against `npm test` is exactly the
# failure this is meant to prevent.
set -uo pipefail

cd "${CLAUDE_PROJECT_DIR:-$(dirname "${BASH_SOURCE[0]}")/../..}" || exit 0

# --- 1. how far is this branch from main? -------------------------------------

git fetch --quiet origin main >/dev/null 2>&1

if ! git rev-parse --verify --quiet origin/main >/dev/null 2>&1; then
  echo "turbo-deck: could not resolve origin/main. Run 'git fetch origin' before branching."
else
  base=$(git merge-base HEAD origin/main 2>/dev/null)
  behind=$(git rev-list --count "${base}..origin/main" 2>/dev/null || echo 0)

  if [ "$behind" -gt 0 ]; then
    echo "turbo-deck: branch is $behind commit(s) behind origin/main —"
    echo "  merge or rebase if you need what landed since."
  fi
fi

# --- 2. dependencies ----------------------------------------------------------

# Local checkouts manage their own node_modules; only the ephemeral remote
# container starts from nothing.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

if [ -d node_modules ] && [ -x node_modules/.bin/vitest ]; then
  exit 0
fi

log="${TMPDIR:-/tmp}/turbo-deck-npm-install.log"
if npm install --no-audit --no-fund >"$log" 2>&1; then
  echo "turbo-deck: dependencies installed. npm run typecheck / npm run lint / npm test are ready."
else
  echo "turbo-deck: npm install FAILED — typecheck, lint and tests will not run. Last lines:"
  tail -n 15 "$log"
fi
