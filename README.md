# auto-claude-code

OpenClaw plugin that launches a persistent Claude Code worker inside a
tmux session and babysits it from outside — so long-running tasks
("refactor X", "migrate Y", "build the Z pipeline") run autonomously
while you check in from chat.

One plugin, one worker. `openclaw` chat messages route `/acc …`
(alias for `/auto-claude-code …`) to the plugin, which drives a single
`auto-claude-worker` tmux session, watches its state, and streams new
output back to whatever channel you launched from (Feishu / Telegram /
terminal).

---

## Quick start

```bash
git clone <this repo>
openclaw plugins install ./auto-claude-code-plugin
openclaw daemon restart     # gateway caches plugin modules — restart after install / updates
```

Prerequisites:

- `tmux` on PATH
- `claude` CLI (Claude Code 2.x) on PATH
- Node.js ≥ 20
- `openclaw` CLI + gateway installed (this plugin runs inside openclaw —
  it does not stand alone; openclaw provides the slash-command routing,
  cron scheduler, and chat-channel delivery)

Verify:

```bash
openclaw plugins list | grep auto-claude-code
openclaw auto-claude-code help
```

---

## Usage

Every command works as either `/acc <sub> …` in chat or
`openclaw auto-claude-code <sub> …` on the CLI.

| Subcommand | What it does |
|---|---|
| `launch "<task>"` | start a worker, install watchdog, begin streaming |
| `status` | tmux alive? task progress? heartbeat age? |
| `attach` | print the `tmux attach` command |
| `stop` | soft-exit the worker (Ctrl-C ladder), retire state, remove cron |
| `send <msg>` | paste a free-form message into the running REPL |
| `form <csv>` | answer a multi-tab form in one shot (also auto-invoked when a chat reply looks like form answers) |

`launch` flags: `--cwd <path>`, `--model <name>`, `--force`,
`--instant` / `--summary`, `--resume <sessionId>`, `--continue`,
`--max-continues <n>`, `--every <dur>`.

### Answering Claude Code's multi-tab forms from chat

Claude Code's `AskUserQuestion` tool renders a tab bar like
`← ☐ Scope  ☒ Format  ✔ Submit →`. The watcher detects the bar, walks
each tab capturing the question + options, and pushes the whole thing
to your chat channel. You reply with a CSV:

```
/acc 1, 2, 3, 4             # pick numbered options per tab
/acc 1, "my-repo", skip, submit
```

Tokens: `\d{1,2}` (numbered option), `"quoted text"` (text fields),
`skip`, `submit`. The last answer auto-Enters, so `submit` is optional.
Malformed tokens are rejected with a specific position error — you get
a retry prompt instead of garbage in the TUI.

In `--force` mode the watcher skips the chat round-trip and answers the
form itself via a one-shot `openclaw agent` call.

---

## Architecture

```
┌──────────────────────┐  /acc launch ...
│  Chat (Feishu/TG/…)  │─────────────────┐
└──────────────────────┘                 │
                                         ▼
           ┌──────────────────────────────────────────────┐
           │  openclaw-gateway (long-running systemd svc) │
           │   ├─ routes /acc → index.js                  │
           │   ├─ spawns watcher, schedules cron          │
           │   └─ forwards plain chat → `acc send`        │
           └───────────────┬──────────────────────────────┘
                           │
             ┌─────────────┼────────────────────┐
             ▼             ▼                    ▼
      ┌─────────────┐  ┌────────────────┐  ┌──────────────────┐
      │ tmux pane   │  │ bin/watcher.mjs│  │ openclaw system  │
      │ auto-claude-│◄─┤ (one per       │─▶│ event → chat     │
      │ worker      │  │  launch)       │  │ channel          │
      │  running    │  │                │  └──────────────────┘
      │  `claude`   │  │ tails jsonl,   │
      │             │─▶│ parses TUI,    │
      │ (dangerously│  │ auto-fills     │
      │  skip perms)│  │ forms, reports │
      └─────────────┘  │ DONE / DEAD    │
                       └────────────────┘
```

### Components

- **`index.js`** — subcommand router. Parses `/acc <sub> <args>` and
  dispatches to `src/commands.js`.
- **`src/commands.js`** — `cmdLaunch`, `cmdStatus`, `cmdAttach`,
  `cmdStop`, `cmdSend`, `cmdForm`. Decides when to spawn a fresh
  watcher / install a cron / stream or batch.
- **`src/launch.js`** — creates (or reuses) the `auto-claude-worker`
  tmux session, pre-accepts Claude Code's per-project trust prompt in
  `~/.claude.json`, runs `claude --dangerously-skip-permissions`, waits
  until a session jsonl appears.
- **`src/tmux.js`** — typed wrapper around the `tmux` CLI. Every
  recoverable failure becomes a `TmuxError` with a `.kind` discriminator
  (`no-session`, `timeout`, `buffer`, `permission`, …). The key
  primitive `paneCurrentCommand()` reads `#{pane_current_command}` —
  used to answer *is claude still running in this pane?* without
  guessing from pane text (which the old sentinel-based check got wrong
  when claude echoed the sentinel).
- **`src/tui.js`** — pane-text parsers: `detectMultiStepForm(pane)`
  recognises the `←  ☐ tab  ☒ tab  ✔ Submit →` bar; `extractModalBlock`
  pulls the modal question + options; `modalSignature` gives a compact
  fingerprint used to detect TUI auto-advance across keypresses.
- **`src/claude-state.js`** — reads
  `~/.claude/projects/<slug>/<sessionId>.jsonl` (turn stream) and
  `~/.claude/tasks/<sessionId>/*.json` (Claude Code 2.1's TaskCreate
  store; the old TodoWrite-todos path is gone).
- **`bin/watcher.mjs`** — one long-running subprocess per launch. Tails
  the jsonl every `POLL_MS`, batches per-turn output, pushes chat
  events through openclaw, detects modals / forms and either surfaces
  them for the user (non-force) or auto-fills them (force). Enforces
  single-instance via `state.watcherPid` + `process.kill(pid, 0)` probe
  at startup.
- **`bin/tick.mjs`** — cron entry for `--summary` mode. Called every
  `every` (default 5 min), produces a digest of progress + a
  QUIET/AWAITING/DONE branch report.
- **`src/decide.js`** — decides the branch (`DEAD`, `AWAITING`,
  `DONE`) from a jsonl+tasks+tmux snapshot.
- **`src/poke.js`** — builds the "keep working" prompt; used by
  force-continue and recovery pokes.
- **`src/state.js`** — JSON state file at
  `~/.state/auto_claude_code/state.json`: `workerSessionId`,
  `workerTmuxName`, `watcherPid`, `autoContinueCount`, cursors. One
  writer (watcher) + many readers (status commands, tick script).

### Delivery modes

| Mode | Trigger | Loop |
|---|---|---|
| `instant` (default) | live stream | `bin/watcher.mjs` tails jsonl, pushes per-event |
| `summary` | `--summary` | `bin/tick.mjs` on `*/5 * * * *` cron, digests since last cursor |

The watcher is the source of truth for force-continue; the tick script
is a pure reporter in both modes.

### `--force` mode

Watcher reacts in real time. When a Claude turn ends with `end_turn`
but tasks aren't all `completed`, it pastes a "continue" prompt into
the tmux. When a multi-tab form appears, it asks `openclaw agent` for
each tab's answer (with jsonl context) and drives the form
automatically. Hard cap: `--max-continues` (default 5).

---

## Configuration

Set via `openclaw config set` or the plugin config block. All keys
optional.

| Key | Default | Meaning |
|---|---|---|
| `stateDir` | `~/.state/auto_claude_code` | State dir |
| `defaultCwd` | `$HOME` | Fallback `cwd` when launch has none |
| `defaultModel` | — | `--model` default |
| `tmuxName` | `auto-claude-worker` | Shared tmux session name |
| `force` | `false` | Default for `--force` |
| `maxAutoContinues` | `5` | Force-mode circuit breaker |
| `instant` | `true` | Stream vs. digest |
| `sticky` | `true` | Auto-forward plain chat → worker after launch |
| `every` | `*/5 * * * *` | Summary-mode cron interval |
| `nudgeAfterSec` | `600` | Stale-jsonl threshold for nudge |
| `recoverAfterSec` | `1800` | Stale-jsonl threshold for recover |
| `notify.channel` | — | `feishu` / `telegram` / … |
| `notify.to` | — | channel-specific target (open_id, chat_id) |

Env-var overrides for the watcher:

- `AUTO_CLAUDE_CODE_STATE_DIR`
- `AUTO_CLAUDE_CODE_FORCE` (`1` / `0`)
- `AUTO_CLAUDE_CODE_MAX_CONTINUES`
- `AUTO_CLAUDE_CODE_WATCHER_POLL_MS` (default `2000`)
- `AUTO_CLAUDE_CODE_NOTIFY_CHANNEL` / `_TO` / `_ACCOUNT`

---

## Safety

`claude` starts with `--dangerously-skip-permissions`. The worker can
run **any shell command in its cwd without asking**. Scope each
`launch` to a known-safe `cwd`; don't point it at your home directory
unless you're OK with that blast radius.

`/acc stop` sends Ctrl-C to the pane (up to 3×) before falling back to
`tmux kill-session`. The Ctrl-C path lets Claude flush its session
jsonl cleanly so you can `--resume` it later.

---

## Development

```bash
node --test test/*.test.mjs                     # full suite
node --check src/commands.js bin/watcher.mjs    # catch ParseError
openclaw cron list                              # smoke-load plugin in a fresh subprocess
openclaw daemon restart                         # reload the gateway's cached modules
```

The gateway is a long-running systemd service. Without a restart it
keeps running the plugin code from when it was last started — so after
every JS edit, run `openclaw daemon restart`, otherwise chat commands
exercise stale code.

### Layout

```
auto-claude-code-plugin/
├── index.js                   # subcommand router
├── openclaw.plugin.json       # manifest + configSchema
├── skills/auto-claude-code/   # SKILL.md (hints for the host LLM)
├── bin/
│   ├── watcher.mjs            # per-launch tailer + form driver
│   └── tick.mjs               # cron tick (summary mode)
├── src/
│   ├── commands.js            # /acc subcommand handlers
│   ├── launch.js              # tmux bring-up + trust-prompt bypass
│   ├── tmux.js                # tmux CLI wrapper + typed errors
│   ├── tui.js                 # pane-text parsers (forms, modals)
│   ├── claude-state.js        # jsonl + tasks/ readers
│   ├── decide.js              # branch decision
│   ├── tick/plan.js           # summary-mode planner
│   ├── poke.js                # continue-prompt builder
│   ├── cron.js                # cron install/remove via openclaw
│   ├── state.js               # state.json I/O
│   ├── watcher-format.js      # assistant text → chat formatter
│   ├── env.js
│   └── util.js
└── test/                      # node --test suite
```

---

## License

MIT
