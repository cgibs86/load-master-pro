#!/bin/bash
set -euo pipefail

# Only run in remote (Claude Code on the web) sessions — local machines
# manage their own ~/.claude/CLAUDE.md.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"

mkdir -p "$HOME/.claude"
cp "$PROJECT_DIR/.claude/global-CLAUDE.md" "$HOME/.claude/CLAUDE.md"
echo "Installed global instructions to ~/.claude/CLAUDE.md"
