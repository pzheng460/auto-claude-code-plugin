#!/usr/bin/env bash
# Stop hook: claude finished a turn. Forward the event to the watcher
# so it can decide whether to force-continue. The watcher returns
# {"decision":"block","reason":"..."} to keep claude alive, or {} to
# let it exit. We pass through whatever JSON the watcher returns.
set -euo pipefail
PORT="${ACC_HOOK_PORT:-7779}"
URL="http://127.0.0.1:${PORT}/hooks/stop"

input=$(cat 2>/dev/null || true)
# Short timeout — if the watcher isn't responding, fail open (let claude exit).
resp=$(curl -sf --max-time 5 --noproxy '*' -X POST "$URL" \
       -H 'Content-Type: application/json' \
       -d "$input" 2>/dev/null) || resp=""
if [[ -n "$resp" ]]; then echo "$resp"; fi
exit 0
