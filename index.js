import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { cmdLaunch, cmdStop, cmdStatus, cmdAttach, cmdSend, cmdResume } from "./src/commands.js";
import { loadState, resolveStateDir } from "./src/state.js";

const VALUE_FLAGS = new Set(["--cwd", "--model", "--every", "--interval", "--resume", "--max-continues"]);
const BOOL_FLAGS = new Set(["--kill-tmux", "--continue", "--fork", "--resume-last", "--force", "--instant", "--summary"]);

function tokenize(raw) {
  const s = raw ?? "";
  const tokens = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;
    const q = s[i];
    if (q === '"' || q === "'") {
      const end = s.indexOf(q, i + 1);
      if (end === -1) { tokens.push(s.slice(i + 1)); i = s.length; }
      else { tokens.push(s.slice(i + 1, end)); i = end + 1; }
    } else {
      let j = i;
      while (j < s.length && !/\s/.test(s[j])) j++;
      tokens.push(s.slice(i, j));
      i = j;
    }
  }
  return tokens;
}

function parseArgs(raw) {
  const tokens = tokenize(raw);
  const options = {};
  const positional = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (VALUE_FLAGS.has(t)) {
      options[t.slice(2)] = tokens[++i] ?? "";
    } else if (BOOL_FLAGS.has(t)) {
      options[t.slice(2)] = true;
    } else {
      positional.push(t);
    }
  }
  return { options, positional, task: positional.join(" ") };
}

function usage() {
  return [
    "auto-claude-code — run a persistent Claude Code worker in tmux",
    "",
    "Usage:  /acc <sub>    (long alias: /auto-claude-code)",
    "",
    "Subcommands",
    "  launch <task>       start / reuse a worker on <task>",
    "  status              one-line health of the current worker",
    "  attach              print the tmux attach command",
    "  stop [--kill-tmux]  stop watcher/cron; tmux stays unless --kill-tmux",
    "  send <text>         paste <text> into the running worker",
    "  resume [n|sid|last] list recent sessions (no arg) or resume one",
    "  help                show this help",
    "  <prose>             implicit send — forwarded to the worker",
    "  <n>|<n,n,…,submit>  reply to a Claude Code modal/form (auto-routed)",
    "",
    "Launch flags",
    "  --cwd <dir>            working directory (default: config or process cwd)",
    "  --model <id>           override claude model for this worker",
    "  --every <dur>          watchdog tick: 30s | 5m | 2h | raw cron  (default 5m)",
    "  --resume <sid>         resume a specific claude session id",
    "  --resume-last          resume the most recently auto-retired session",
    "  --continue             claude --continue (most recent session in this cwd)",
    "  --fork                 with --resume/--continue, fork into a new session id",
    "  --force                auto-poke claude when a turn ends mid-task",
    "  --max-continues N      circuit-breaker for --force  (default 5)",
    "  --instant              stream events live (default)",
    "  --summary              use the legacy cron+LLM-summary delivery path",
    "",
    "Examples",
    "  /acc launch refactor src/auth to use the new JWT helper",
    "  /acc resume                            # list recent sessions",
    "  /acc resume 2                          # resume the 2nd from the list",
    "  /acc resume last keep going on tests   # resume + inject a new prompt",
    "  /acc status",
    "  /acc 1                                 # answers a pending acc_ask_user question",
    "  /acc how is it going?                  # plain prose — sticky paste",
    "  /acc stop",
  ].join("\n");
}

// Infer where the watchdog should announce STATUS back to, based on the
// channel/user that invoked `/auto-claude-code launch`.
function buildNotifyFromCtx(ctx) {
  const channel = ctx?.channel;
  const senderId = ctx?.senderId ?? ctx?.from;
  if (!channel || !senderId) return null;
  let to = senderId;
  // Feishu's cron --to expects "user:ou_..." for DMs (seen from existing cron jobs).
  if (channel === "feishu" && !to.startsWith("user:")) to = `user:${senderId}`;
  const account =
    ctx?.accountId ?? ctx?.account ?? ctx?.channelAccountId ?? null;
  const out = { channel, to };
  if (account) out.account = account;
  return out;
}

export default definePluginEntry({
  id: "auto-claude-code",
  name: "Auto Claude Code",
  description:
    "Launch persistent Claude Code workers in tmux (--dangerously-skip-permissions) and watchdog them via openclaw cron.",
  register(api) {
    const handler = async (ctx) => {
        const raw = (ctx.args ?? "").trim();
        if (!raw) return { text: usage() };

        const firstSpace = raw.search(/\s/);
        const sub = (firstSpace === -1 ? raw : raw.slice(0, firstSpace)).toLowerCase();
        const subArgs = firstSpace === -1 ? "" : raw.slice(firstSpace + 1);
        const { options, task } = parseArgs(subArgs);
        const pluginConfig = api.pluginConfig ?? {};

        switch (sub) {
          case "launch": {
            const cwd = options.cwd || pluginConfig.defaultCwd || ctx.cwd || process.cwd();
            const model = options.model || pluginConfig.defaultModel;
            const notifyFromCtx = buildNotifyFromCtx(ctx);
            const resume = options.resume || (options["resume-last"] ? "last" : null);
            const instantOpt = options.instant
              ? true
              : (options.summary ? false : undefined);
            const r = await cmdLaunch({
              pluginConfig,
              cwd,
              task,
              model,
              interval: options.every || options.interval,
              notify: notifyFromCtx,
              resume,
              continueLatest: !!options.continue,
              fork: !!options.fork,
              // Pass through tri-state: only override config when the flag is
              // present. `!!options.force` would coerce "absent" to false and
              // shadow `pluginConfig.force = true` set in the openclaw config.
              force: options.force ? true : undefined,
              maxContinues: options["max-continues"] ? Number(options["max-continues"]) : undefined,
              instant: instantOpt,
            });
            const text = r.ok && pluginConfig.sticky !== false
              ? `${r.text}\n💬 plain messages auto-forward to the worker  ·  /acc stop to release`
              : r.text;
            return { text };
          }
          case "status": {
            const r = await cmdStatus({ pluginConfig });
            return { text: r.text };
          }
          case "attach": {
            const r = await cmdAttach({ pluginConfig });
            return { text: r.text };
          }
          case "stop": {
            const r = await cmdStop({ pluginConfig, killTmux: !!options["kill-tmux"] });
            if (typeof ctx.detachConversationBinding === "function") {
              try { await ctx.detachConversationBinding(); } catch {}
            }
            return { text: r.text };
          }
          case "send": {
            const r = await cmdSend({ pluginConfig, message: subArgs });
            return { text: r.text };
          }
          case "resume": {
            // /acc resume                — list recent sessions
            // /acc resume <n|sid|last>   — resume that session
            // Trailing prose is forwarded as a fresh prompt to inject.
            const r = await cmdResume({ pluginConfig, args: subArgs });
            return { text: r.text };
          }
          case "help":
          case "-h":
          case "--help":
          case "?": {
            return { text: usage() };
          }
          default: {
            // No recognised subcommand — treat the entire input as a message
            // to paste into the running worker. This lets the user do
            // `/auto-claude-code keep going` without remembering a verb.
            const r = await cmdSend({ pluginConfig, message: raw });
            return { text: r.text };
          }
        }
      };

    // Register both the long name and the short alias `/acc` with the same
    // handler so users can type whichever is faster.
    const cmdSpec = {
      description: "Control an auto-claude-code tmux worker (launch|status|attach|resume|stop|send)",
      acceptsArgs: true,
      handler,
    };
    api.registerCommand({ name: "auto-claude-code", ...cmdSpec });
    api.registerCommand({ name: "acc", ...cmdSpec });

    // Sticky-mode hook: after `/acc launch` from a chat, plain (non-slash)
    // messages from the same chat get auto-routed into the worker's tmux
    // until the worker stops. This lets the user have a natural conversation
    // with their background claude without prefixing every turn.
    // Sticky mode via before_dispatch — fires before the agent sees the
    // message, so no binding/approval UI is needed. If a worker is active
    // and the sender matches the chat that ran /acc launch, paste the text
    // into tmux and tell the dispatcher we handled it.
    api.on("before_dispatch", async (event, hookCtx) => {
      const pluginConfig = api.pluginConfig ?? {};
      if (pluginConfig.sticky === false) return;
      const stateDir = resolveStateDir(pluginConfig);
      let state;
      try { state = loadState(stateDir); } catch { return; }
      if (!state.workerSessionId || !state.workerTmuxName) return;
      if (!state.stickyChannel) return;
      if (event.channel !== state.stickyChannel) return;
      const normStored = (state.stickySender || "").replace(/^user:/, "");
      const normIncoming = (event.senderId || hookCtx?.senderId || "").replace(/^user:/, "");
      if (normStored && normStored !== normIncoming) return;
      if (event.isGroup) return; // never hijack group chats
      const content = (event.content || event.body || "").trim();
      if (!content || content.startsWith("/")) return;
      const r = await cmdSend({ pluginConfig, message: content });
      if (!r.ok) return;
      return { handled: true };
    });

    api.registerCli(
      async ({ program }) => {
        const group = program
          .command("auto-claude-code")
          .alias("acc")
          .description("Launch a tmux Claude Code worker with watchdog (alias: acc)");

        const cfg = () => api.pluginConfig ?? {};

        group
          .command("launch <task...>")
          .description("Launch a Claude Code worker in tmux and start the watchdog")
          .option("--cwd <dir>", "Working directory (default: config.defaultCwd or process.cwd())")
          .option("--model <id>", "Model override (default: config.defaultModel)")
          .option("--every <duration>", "Watchdog interval — '30s', '5m', '2h', or raw cron (default: 5m)")
          .option("--interval <expr>", "[deprecated] alias for --every")
          .option("--resume <sid>", "Resume a specific claude session ID")
          .option("--resume-last", "Resume the most recently auto-retired session")
          .option("--continue", "Use claude --continue (most recent session in cwd)")
          .option("--fork", "With --resume/--continue, fork into a new session ID")
          .option("--force", "Auto-nudge claude to keep working when it goes quiet mid-task")
          .option("--max-continues <n>", "Circuit-breaker limit for --force (default: 5)")
          .option("--instant", "Force instant streaming (default already on; overrides config)")
          .option("--summary", "Use the legacy cron+LLM-summary delivery instead of instant")
          .action(async (taskParts, opts) => {
            const pc = cfg();
            const cwd = opts.cwd || pc.defaultCwd || process.cwd();
            const resume = opts.resume || (opts.resumeLast ? "last" : null);
            const r = await cmdLaunch({
              pluginConfig: pc,
              cwd,
              task: taskParts.join(" "),
              model: opts.model || pc.defaultModel,
              interval: opts.every || opts.interval,
              resume,
              continueLatest: !!opts.continue,
              fork: !!opts.fork,
              // Tri-state — undefined means "fall through to pluginConfig.force".
              force: opts.force ? true : undefined,
              maxContinues: opts.maxContinues ? Number(opts.maxContinues) : undefined,
              instant: opts.instant ? true : (opts.summary ? false : undefined),
            });
            console.log(r.text);
            process.exitCode = r.ok ? 0 : 1;
          });

        group
          .command("status")
          .description("Print one-line STATUS for the current worker")
          .action(async () => {
            const r = await cmdStatus({ pluginConfig: cfg() });
            console.log(r.text);
            process.exitCode = r.ok ? 0 : 1;
          });

        group
          .command("attach")
          .description("Print the tmux attach command for the current worker")
          .action(async () => {
            const r = await cmdAttach({ pluginConfig: cfg() });
            console.log(r.text);
            process.exitCode = r.ok ? 0 : 1;
          });

        group
          .command("send <msg...>")
          .description("Paste a message into the running worker's claude REPL")
          .action(async (msgParts) => {
            const r = await cmdSend({ pluginConfig: cfg(), message: msgParts.join(" ") });
            console.log(r.text);
            process.exitCode = r.ok ? 0 : 1;
          });

        group
          .command("stop")
          .description("Remove watchdog cron (--kill-tmux also terminates worker)")
          .option("--kill-tmux", "Also kill the worker's tmux session")
          .action(async (opts) => {
            const r = await cmdStop({ pluginConfig: cfg(), killTmux: !!opts.killTmux });
            console.log(r.text);
            process.exitCode = r.ok ? 0 : 1;
          });
      },
      {
        descriptors: [
          {
            name: "auto-claude-code",
            description: "Tmux-backed Claude Code worker + watchdog",
            hasSubcommands: true,
          },
          {
            name: "acc",
            description: "Short alias for `auto-claude-code`",
            hasSubcommands: true,
          },
        ],
      },
    );
  },
});
