---
name: auto-claude-code
description: |
  Launch a persistent Claude Code worker in a tmux session (with --dangerously-skip-permissions)
  to work on a task autonomously. A watchdog cron checks on it every few minutes and pokes the
  worker via tmux if it stalls. Human can attach to the tmux at any time to observe / take over.

  Use when the user says:
  - "run this in the background", "auto-run this task", "launch a worker"
  - asks for a multi-step or long-running task ("refactor X", "implement Y", "make a pipeline")
  - wants to hand off autonomous work and check in later
---

# auto-claude-code

## What this plugin does

Spawns a second Claude Code session inside a detached tmux window, with
`--dangerously-skip-permissions` on (no approval prompts). The spawned worker uses
its normal TodoWrite planning and file-editing tools to work on the task. An
openclaw cron watchdog ticks every 5 minutes, reads the worker's state
(TodoWrite file + session jsonl mtime), and:

- If the worker's session is silent too long, pastes a "resume" prompt into
  the tmux to unstick it.
- If the tmux died, reports DEAD status.
- If all TodoWrite tasks are `completed`, reports DONE.

## Safety

- `--dangerously-skip-permissions` means the worker can run **any shell command
  without asking**. Only launch this on tasks scoped to a specific cwd.
- The worker's cwd is fixed at launch time. It won't wander to other projects
  unless you explicitly tell it to.
- You can attach to the tmux session at any time (`tmux attach -t auto-claude-<id>`)
  to watch, interrupt (Ctrl-c), or type into the conversation.

## Commands

| | |
|---|---|
| `/auto-claude-code launch "<task>"` | Spawn a Claude Code worker in tmux, start watchdog |
| `/auto-claude-code status` | Tmux alive? Todos progress? Heartbeat age? |
| `/auto-claude-code attach` | Print the `tmux attach` command |
| `/auto-claude-code stop` | Remove watchdog cron; leave tmux alive (use `--kill-tmux` to also kill worker) |

All commands also exist as `openclaw auto-claude-code <sub>` in the CLI.

## How the watchdog decides "stalled"

Pure JS, runs via a small LLM trampoline that only exists to execute
`node bin/tick.mjs`:

```
                 tmux alive? → no  → DEAD
                 tmux alive  → look at session jsonl mtime:
                   age < 600s  →  OK
                   600–1800s   →  NUDGE (paste a "resume" prompt)
                   ≥ 1800s     →  RECOVER (paste a fuller recovery prompt)
                 all todos done → DONE
                 no todos yet   → IDLE
```

Thresholds come from plugin config (`nudgeAfterSec`, `recoverAfterSec`).

## What each cron tick reports

In addition to the STATUS line, each tick appends the Claude Code worker's
**new output since the last tick** — one block of `[claude] ...` (assistant
text) and `[tool] Name(arg)` lines pulled from the worker's session jsonl.
A cursor in `state.json` (`lastReportedTs`) advances each tick so output isn't
repeated; when the worker is idle, ticks stay single-line.

Tuning env vars (exported through the cron command):

- `AUTO_CLAUDE_CODE_REPORT_MAX_LINES` — cap lines per tick (default 20).
- `AUTO_CLAUDE_CODE_REPORT_MAX_EVENTS` — cap assistant events scanned per tick
  (default 30).

## How the watchdog pokes the worker

It does NOT use openclaw system-events. It directly runs:

```
tmux load-buffer -b <buf> <tmp file with prompt>
tmux paste-buffer -b <buf> -t <tmux-session>
tmux send-keys -t <tmux-session> Enter
```

Effectively typing the prompt into the Claude Code input box. The worker sees
it as a fresh user message mid-conversation.

## What the LLM in this session should do

When the user asks you to "run this in the background" or hands you a
multi-step task they want executed autonomously:

1. Call `/auto-claude-code launch "<clear one-paragraph task description>"`
2. Report back the tmux name and the attach command.
3. Later, if they ask about progress, call `/auto-claude-code status`.
4. If they say "stop", call `/auto-claude-code stop` (ask before passing `--kill-tmux`).

## Configuration keys (openclaw plugin config)

- `stateDir`: where plugin state.json lives (default `~/.state/auto_claude_code`)
- `interval`: cron expression (default `*/5 * * * *`)
- `nudgeAfterSec` / `recoverAfterSec`: heartbeat thresholds
- `notify.channel` / `notify.to`: where to send STATUS announcements

Env override for the tick script: `AUTO_CLAUDE_CODE_STATE_DIR`.
