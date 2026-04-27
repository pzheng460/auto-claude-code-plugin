#!/usr/bin/env bash
# UserPromptSubmit hook: ask the watcher if it has a queued
# force-continue prompt to inject. Watcher returns either {} (no-op) or
# {"hookSpecificOutput":{"additionalContext":"..."}} which Claude Code
# will inject into the next turn's context.
set -euo pipefail
PORT="${ACC_HOOK_PORT:-7779}"
URL="http://127.0.0.1:${PORT}/hooks/user-prompt"

resp=$(curl -sf --max-time 5 --noproxy '*' -X POST "$URL" 2>/dev/null) || resp="{}"
echo "${resp:-{}}"
exit 0
