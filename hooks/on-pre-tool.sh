#!/usr/bin/env bash
# PreToolUse hook: forward to watcher. Watcher inspects tool_name and
# may return a deny + reason redirecting AskUserQuestion → acc_ask_user.
# All other tools pass through (watcher returns {}).
set -euo pipefail
PORT="${ACC_HOOK_PORT:-7779}"
URL="http://127.0.0.1:${PORT}/hooks/pre-tool"

input=$(cat 2>/dev/null || true)
resp=$(curl -sf --max-time 5 --noproxy '*' -X POST "$URL" \
       -H 'Content-Type: application/json' \
       -d "$input" 2>/dev/null) || resp="{}"
echo "${resp:-{}}"
exit 0
