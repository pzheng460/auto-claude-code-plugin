import {
  resolveStateDir,
  ensureStateDir,
  loadState,
  saveState,
  updateState,
  clearWorker,
  retireWorker,
} from "./state.js";
import { inspectWorker, locateSessionJsonl, listRecentSessions, readFirstUserMessage } from "./claude-state.js";
import { decideBranch, formatStatusLine } from "./decide.js";
import { installCron, removeCronJob, isCronInstalled, parseInterval } from "./cron.js";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve as pathResolve, join } from "node:path";
import { openSync, closeSync } from "node:fs";
import { launchWorker } from "./launch.js";
import {
  hasSession as tmuxHasSession,
  killSession as tmuxKillSession,
  paneCurrentCommand,
  ensurePaneAtShell,
  DEFAULT_TMUX_NAME,
} from "./tmux.js";
import { pokeTmuxWorker } from "./poke.js";
import { oneLine } from "./util.js";

// Pool / lease integration -------------------------------------------------
import { homedir } from "node:os";
import { BrokerClient } from "./broker-client.js";
import { syncSshBundle } from "./ssh-sync.js";
import {
  acquireGroup,
  buildLeaseEnv,
  explicitPoolRequests,
  pluginManifestRequests,
  releaseAll,
  retryOrphans,
} from "./lease-manager.js";

const DEFAULT_CRON_EXPR = "*/5 * * * *";
const DEFAULT_NUDGE_AFTER_SEC = 600;
const DEFAULT_RECOVER_AFTER_SEC = 1800;
const TASK_SUMMARY_CHARS = 80;

const DEFAULT_BROKER_URL = "http://100.106.133.58:7778"; // jcl Tailscale IP
const DEFAULT_LEASE_TTL_SEC = 600;
const DEFAULT_CLAUDE_PLUGINS_DIR = `${homedir()}/.claude/plugins`;

// Build a BrokerClient from plugin config + env overrides. Returns null
// when no broker URL is configured (so callers can keep pool-mode optional).
function makeBrokerClient(pluginConfig = {}) {
  const url =
    process.env.AUTO_CLAUDE_CODE_BROKER_URL ||
    pluginConfig?.broker?.url ||
    DEFAULT_BROKER_URL;
  if (!url) return null;
  const token =
    process.env.AUTO_CLAUDE_CODE_BROKER_TOKEN ||
    pluginConfig?.broker?.token ||
    null;
  return new BrokerClient({ baseUrl: url, token });
}

// Resolve a Claude Code plugin's manifest dir from a plugin name. Honors
// pluginConfig.claudePluginsDir override; default ~/.claude/plugins.
function resolveClaudePluginRoot(pluginConfig, pluginName) {
  const base = pluginConfig?.claudePluginsDir || DEFAULT_CLAUDE_PLUGINS_DIR;
  return join(base, pluginName);
}

// Owner string for the broker (audit trail, who's holding this lease).
// Prefers chat ctx (feishu user / TG chat id) → falls back to host:user.
function deriveLeaseOwner(ctx, pluginConfig) {
  const stickyTo = ctx?.notify?.to;
  if (stickyTo) return `chat:${stickyTo}`;
  const cfgOwner = pluginConfig?.broker?.owner;
  if (cfgOwner) return cfgOwner;
  return `cli:${process.env.USER || "openclaw"}`;
}

/**
 * Acquire pool leases when /acc launch was invoked with --plugin or
 * --pool. Returns null when no pool mode is requested. Throws (caller
 * surfaces to chat) on broker failures or manifest mistakes.
 *
 * On success: { broker, leases: [...] }
 *
 * Side effects: ensures ~/.ssh/config.d/harness + ~/.ssh/harness/ are
 * up to date with the broker's ssh-bundle (only re-fetched when ETag
 * changes).
 */
async function acquireLeasesIfRequested({
  pluginConfig,
  pluginName,
  poolList,
  stateDir,
  owner,
  purpose,
}) {
  if (!pluginName && !poolList) return null;

  const broker = makeBrokerClient(pluginConfig);
  if (!broker) {
    throw new Error("broker URL not configured (set pluginConfig.broker.url or AUTO_CLAUDE_CODE_BROKER_URL)");
  }

  // Sweep stale orphans first — entries that piled up from prior
  // unreachable-broker shutdowns. Best-effort; remaining ones stay on
  // disk for the next sweep.
  try {
    const swept = await retryOrphans({ broker, stateDir });
    if (swept.retried > 0) {
      log(`orphan sweep: released ${swept.released}/${swept.retried}, still pending ${swept.stillFailed}`);
    }
  } catch (err) {
    log(`orphan sweep failed: ${err?.message || err}`);
  }

  // Pull / refresh the ssh bundle FIRST so the keys + config.d/harness exist
  // before any cc subprocess tries to ssh.
  const sync = await syncSshBundle({ broker, stateDir });
  if (sync.changed) {
    log(`ssh-sync: installed bundle v${sync.version || "?"} (${sync.keyCount} keys)`);
  }

  // Build the request list: --plugin wins, --pool is the explicit fallback.
  let requests;
  if (pluginName) {
    const pluginRoot = resolveClaudePluginRoot(pluginConfig, pluginName);
    const fromManifest = pluginManifestRequests(pluginRoot);
    if (!fromManifest) {
      throw new Error(`plugin '${pluginName}' has no harness.json at ${pluginRoot}/.claude-plugin/`);
    }
    requests = fromManifest;
  } else if (poolList) {
    requests = explicitPoolRequests(poolList);
  } else {
    requests = [];
  }

  if (!requests.length) return null;

  const result = await acquireGroup({
    broker, requests, owner, purpose,
    ttlSec: DEFAULT_LEASE_TTL_SEC,
  });
  if (!result.ok) {
    throw new Error(`broker acquire failed for ${result.failedPool}: ${result.error}`);
  }
  return { broker, leases: result.leases };
}

function log(msg) {
  // commands.js doesn't have a real logger; drop into stderr for now.
  process.stderr.write(`[acc] ${msg}\n`);
}

function buildCtx(pluginConfig = {}) {
  const parsed = parseInterval(pluginConfig.every || pluginConfig.interval);
  return {
    stateDir: resolveStateDir(pluginConfig),
    cronExpr: parsed?.cron || DEFAULT_CRON_EXPR,
    thresholds: {
      nudgeAfterSec: pluginConfig.nudgeAfterSec ?? DEFAULT_NUDGE_AFTER_SEC,
      recoverAfterSec: pluginConfig.recoverAfterSec ?? DEFAULT_RECOVER_AFTER_SEC,
    },
    notify: pluginConfig.notify ?? null,
  };
}

const summarizeTask = (s) => oneLine(s, TASK_SUMMARY_CHARS);

// Decide whether the watchdog cron should be installed for a launch.
// The watcher is always spawned (it owns Stop hook + acc_ask_user MCP);
// the cron is only installed in non-instant mode for LLM summary
// rendering. Force mode swaps the cron template for a slim variant
// that drops branch/progress/heartbeat fields and skips the
// long-silence nudge — the watcher's Stop hook already drives forward.
//
//   instant  force | watcher                            | cron
//   ---------------+------------------------------------+----------------
//   true     no    | streams chat live                  | (none)
//   true     yes   | streams chat + Stop-hook continues | (none)
//   false    no    | force-off, summarizer feeds tick   | full template
//   false    yes   | force-on, drives every end_turn    | slim template
export function planCronInstall({ instant, notify }) {
  if (instant) return null;
  return { notify: notify ?? null };
}

const WATCHER_SCRIPT = pathResolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "bin",
  "watcher.mjs",
);

function spawnWatcher({ stateDir, notify, streamLiveEvents = false, force = false, maxContinues } = {}) {
  const env = {
    ...process.env,
    AUTO_CLAUDE_CODE_STATE_DIR: stateDir,
  };
  // Watcher always needs a notify target so acc_ask_user, completion
  // reports, and retire alerts can reach the user. Live event streaming
  // (the per-turn assistant text + tool_use push) is gated separately by
  // STREAM_LIVE_EVENTS — disabled in summary mode where the cron's LLM
  // summary is the digest path.
  if (notify?.channel) env.AUTO_CLAUDE_CODE_NOTIFY_CHANNEL = notify.channel;
  if (notify?.to) env.AUTO_CLAUDE_CODE_NOTIFY_TO = notify.to;
  if (notify?.account) env.AUTO_CLAUDE_CODE_NOTIFY_ACCOUNT = notify.account;
  if (streamLiveEvents) env.AUTO_CLAUDE_CODE_STREAM_LIVE_EVENTS = "1";
  if (force) env.AUTO_CLAUDE_CODE_FORCE = "1";
  if (Number.isFinite(maxContinues)) {
    env.AUTO_CLAUDE_CODE_MAX_CONTINUES = String(maxContinues);
  }

  // Log watcher stderr to state dir so it survives across reboots.
  const logPath = join(stateDir, "watcher.log");
  let logFd;
  try { logFd = openSync(logPath, "a"); } catch { logFd = "ignore"; }

  const child = spawn(process.execPath, [WATCHER_SCRIPT], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: env,
  });
  if (typeof logFd === "number") { try { closeSync(logFd); } catch {} }
  child.unref();
  return child.pid;
}

export async function cmdLaunch({
  pluginConfig = {},
  cwd,
  task,
  model,
  interval,
  notify: notifyOverride,
  resume,          // null | string sid | "last" | true (→ "last")
  continueLatest,  // boolean — use `claude --continue` (most recent in cwd)
  fork,            // boolean — pair with resume/continue to --fork-session
  force,           // boolean — enable force-continue; watcher pokes on AWAITING
  maxContinues,    // number  — circuit-breaker limit; falls back to config or 5
  instant,         // boolean — skip LLM summary, forward tick.mjs output verbatim
  taskLabel,       // optional display-only override for state.workerTask;
                   // /acc resume passes the picked session's title so the
                   // status line still reads usefully when task is empty
                   // (pure resume sends no fresh prompt to claude).
  plugin,          // Claude Code plugin name; reads its harness.json for pools
  pool,            // explicit pool list (string, comma-separated)
} = {}) {
  const isResumeOrContinue = !!resume || !!continueLatest;
  if (!isResumeOrContinue && (!task || !task.trim())) {
    return { ok: false, text: "usage: /auto-claude-code launch <task description>" };
  }
  if (!cwd) {
    return { ok: false, text: "launch: cwd is required" };
  }

  // Validate inputs BEFORE any destructive cleanup. The priorActive
  // branch below retires the live worker, so a typo'd resume / --continue
  // / --fork combo would otherwise kill the running session and leave
  // the user with no way out but /acc exit.

  // Explicit resume sid must point to an actual jsonl. `last`/`latest`
  // is resolved later against prior.lastSessionId and re-checked there.
  if (
    typeof resume === "string" &&
    resume.trim() &&
    resume !== "last" &&
    resume !== "latest"
  ) {
    const probe = resume.trim();
    if (!locateSessionJsonl(cwd, probe)) {
      return {
        ok: false,
        text: `resume failed: no claude session ${probe} under ${cwd}`,
      };
    }
  }

  // --continue needs at least one historical session under cwd, otherwise
  // claude CLI errors out and the worker tmux sits at the shell.
  //
  // We also REWRITE --continue into an explicit --resume <latest sid>: the
  // downstream launchWorker generates a random session id when only
  // continueLatest is set, which then mismatches the real jsonl claude
  // touches when continuing — waitForClaudeReady times out, state's
  // workerSessionId becomes a ghost UUID, and the watcher reports DEAD
  // forever. Pre-resolving to the latest session id makes --continue
  // behave identically to /acc resume <latest>.
  if (continueLatest && !resume) {
    const recent = listRecentSessions(cwd, { limit: 1 });
    if (!recent.length) {
      return {
        ok: false,
        text: `--continue failed: no claude sessions found under ${cwd} to continue`,
      };
    }
    resume = recent[0].sessionId;
    continueLatest = false;
    // Carry the picked session's title forward so the status line shows
    // something meaningful when --continue replaces a typed task.
    if (!taskLabel && recent[0].title) taskLabel = recent[0].title;
  }

  // --fork-session is only meaningful when paired with resume/continue.
  // launch.js silently drops it otherwise; surface that as an error so
  // the user knows their flag had no effect.
  if (fork && !resume && !continueLatest) {
    return {
      ok: false,
      text: "--fork requires --resume <id>, --resume last, or --continue",
    };
  }

  const ctx = buildCtx(pluginConfig);
  if (interval) {
    const parsed = parseInterval(interval);
    if (parsed.error) return { ok: false, text: parsed.error };
    ctx.cronExpr = parsed.cron;
  }
  // notify override takes precedence over pluginConfig.notify
  if (notifyOverride && (notifyOverride.channel || notifyOverride.to)) {
    ctx.notify = { ...(ctx.notify || {}), ...notifyOverride };
  }
  ensureStateDir(ctx.stateDir);

  const prior = loadState(ctx.stateDir);

  // If a previous worker is still tracked, take it down implicitly so a new
  // launch always feels fresh. tmux is reused; we just signal the watcher,
  // remove the cron, and stash the prior session_id so `--resume-last` can
  // still pick it up.
  const priorActive = !!(prior.workerSessionId || prior.workerTmuxName || prior.watcherPid);
  if (priorActive) {
    if (prior.watcherPid) {
      try { process.kill(prior.watcherPid, "SIGTERM"); } catch {}
    }
    // removeCronJob is itself idempotent (alreadyRemoved when no job).
    await removeCronJob().catch(() => {});
    retireWorker(ctx.stateDir, {
      lastSessionId: prior.workerSessionId,
      lastCwd: prior.workerCwd,
      lastTask: prior.workerTask,
      lastRetiredAt: new Date().toISOString(),
      lastRetireReason: "superseded by new launch",
    });
  }

  // Resolve resume sentinel: `resume === true` or "last" → use lastSessionId
  // from state (most recent auto-retired session). Explicit sid passes through.
  let resumeSessionId = null;
  if (resume === true || resume === "last" || resume === "latest") {
    if (!prior.lastSessionId) {
      return {
        ok: false,
        text: "no previous session recorded — start one with /auto-claude-code launch <task>",
      };
    }
    resumeSessionId = prior.lastSessionId;
    // also reuse the last cwd unless the caller passed an explicit one
    if (!cwd || cwd === process.cwd()) cwd = prior.lastCwd || cwd;
  } else if (typeof resume === "string" && resume.trim()) {
    resumeSessionId = resume.trim();
  }

  const tmuxName = pluginConfig.tmuxName || DEFAULT_TMUX_NAME;
  const resolvedForce = force ?? !!pluginConfig.force;
  const resolvedMaxContinues =
    maxContinues ?? pluginConfig.maxAutoContinues ?? undefined;
  const configInstant = pluginConfig.instant !== false;
  const resolvedInstant = instant !== undefined ? instant : configInstant;

  // Spawn the watcher BEFORE launchWorker so its hook server is bound on
  // :7779 by the time claude initializes its MCP client. Otherwise claude
  // hits ConnectionRefused, marks acc_ask_user "failed", and falls back to
  // native AskUserQuestion (the TUI form we're trying to bypass).
  // Watcher polls for state.workerSessionId for a few seconds before
  // exiting, so the gap between this spawn and the updateState below is fine.
  // Always give the watcher the notify channel — it pushes acc_ask_user
  // questions, DONE/BLOCKED reports, circuit-breaker, and retire alerts
  // through it regardless of mode. Live event streaming (per-turn
  // assistant text & tool calls) is gated by streamLiveEvents — only on
  // in instant mode where the cron LLM summary isn't the digest path.
  // Pool / lease setup — runs before the watcher spawn so a broker failure
  // surfaces immediately to the user instead of silently leaving them with
  // a half-launched worker. extraLeaseEnv carries the alias env vars into
  // the claude shell so plugins can `ssh $REMOTE_SSH_ALIAS_NPU` directly.
  let leasePack = null;
  let extraLeaseEnv = null;
  try {
    leasePack = await acquireLeasesIfRequested({
      pluginConfig,
      pluginName: plugin,
      poolList: pool,
      stateDir: ctx.stateDir,
      owner: deriveLeaseOwner(ctx, pluginConfig),
      purpose: task ? oneLine(task, 80) : "auto-claude-code launch",
    });
    if (leasePack?.leases?.length) {
      extraLeaseEnv = buildLeaseEnv(leasePack.leases);
    }
  } catch (err) {
    return { ok: false, text: `pool mode aborted: ${err?.message || err}` };
  }

  const watcherPid = spawnWatcher({
    stateDir: ctx.stateDir,
    notify: ctx.notify,
    streamLiveEvents: resolvedInstant,
    force: resolvedForce,
    maxContinues: resolvedMaxContinues,
  });

  const launched = await launchWorker({
    cwd,
    task,
    model,
    tmuxName,
    resumeSessionId,
    continueLatest: !!continueLatest,
    forkOnResume: !!fork,
    extraEnv: extraLeaseEnv,
  });
  if (!launched.ok) {
    // Watcher was spawned ahead of us — kill it so it doesn't sit polling
    // for state that will never come.
    try { process.kill(watcherPid, "SIGTERM"); } catch {}
    // Also release any leases we just acquired — otherwise they sit on the
    // broker until TTL expires.
    if (leasePack?.leases?.length) {
      try {
        await releaseAll({ broker: leasePack.broker, leases: leasePack.leases, stateDir: ctx.stateDir });
      } catch {}
    }
    return { ok: false, text: `launch failed: ${launched.error}` };
  }

  // Pure resume sends no fresh prompt — `launched.task` is empty in that
  // case, so fall back to the explicit display label (set by /acc resume),
  // or the retired session's last task when resuming "last".
  const recordedTask =
    launched.task ||
    taskLabel ||
    (resume === true || resume === "last" || resume === "latest"
      ? prior.lastTask
      : null) ||
    null;

  updateState(ctx.stateDir, (prev) => ({
    ...prev,
    workerSessionId: launched.sessionId,
    workerTmuxName: launched.tmuxName,
    workerCwd: launched.cwd,
    workerTask: recordedTask,
    workerSessionJsonl: locateSessionJsonl(cwd, launched.sessionId),
    launchedAt: launched.launchedAt,
    // Sticky routing: chats that launched this worker should have their
    // follow-up messages auto-pasted to the worker without needing /acc.
    stickyChannel: pluginConfig.sticky === false ? null : (ctx.notify?.channel ?? null),
    stickySender: pluginConfig.sticky === false ? null : (ctx.notify?.to ?? null),
    stickyAccount: pluginConfig.sticky === false ? null : (ctx.notify?.account ?? null),
    watcherPid,
    watcherStartedAt: watcherPid ? new Date().toISOString() : null,
    leases: leasePack?.leases || [],
    leaseHeartbeatLastOkAt: leasePack?.leases?.length ? new Date().toISOString() : null,
    leaseHeartbeatFailCount: 0,
  }));

  const cronPlan = planCronInstall({
    instant: resolvedInstant,
    notify: ctx.notify,
  });
  if (cronPlan) {
    const inst = await installCron({
      cronExpr: ctx.cronExpr,
      stateDir: ctx.stateDir,
      thresholds: ctx.thresholds,
      notify: cronPlan.notify,
      force: resolvedForce,
    });
    if (!inst.ok) {
      return {
        ok: false,
        text: `worker launched (tmux=${launched.tmuxName}), but cron install failed: ${inst.stderr || "unknown"}`,
      };
    }
  }
  // Instant mode needs no cron — the watcher streams chat and drives force.
  // The supersede path above already removed any lingering cron job.

  const headerEmoji = launched.resumed ? "↩️" : "🚀";
  const headerVerb = launched.resumed
    ? (launched.forked ? "forked" : "resumed")
    : "launched";
  const shortSid = (launched.sessionId || "").slice(0, 8);
  const readyFailed = launched.ready?.ok === false;

  const summaryLabel = launched.task || recordedTask || `session ${shortSid}`;
  const lines = [
    `${headerEmoji} ${headerVerb} — ${summarizeTask(summaryLabel)}`,
    `↳ session: ${shortSid}  ·  tmux: ${launched.tmuxName}`,
  ];
  if (leasePack?.leases?.length) {
    const summary = leasePack.leases
      .map((l) => `${l.alias}=${l.hostAlias}`)
      .join(", ");
    lines.push(`↳ leases: ${summary} (TTL ${DEFAULT_LEASE_TTL_SEC}s)`);
  }
  if (readyFailed) {
    // If waitForClaudeReady timed out, the watchdog would otherwise sit on a
    // NONE/IDLE branch forever without ever reaching the worker — tell the
    // user plainly instead of pretending the launch succeeded.
    lines.unshift(
      `⚠️  Claude session jsonl never appeared (${launched.ready.reason}).`,
      `    tmux session is still up — run \`tmux attach -t ${launched.tmuxName}\` to see why Claude didn't start.`,
    );
  }

  return {
    ok: !readyFailed,
    text: lines.join("\n"),
  };
}

export async function cmdStop({ pluginConfig = {}, killTmux = false } = {}) {
  const ctx = buildCtx(pluginConfig);
  const st = loadState(ctx.stateDir);

  let watcherKilled = false;
  if (st.watcherPid) {
    try {
      process.kill(st.watcherPid, "SIGTERM");
      watcherKilled = true;
    } catch (err) {
      // ESRCH = process already gone, treat as success
      watcherKilled = err?.code === "ESRCH";
    }
  }

  // Release pool leases BEFORE we kill cron / tmux. Failures land in
  // orphan_leases.json so cmdGc / next launch can retry — never block
  // the stop on broker errors.
  let leaseReport = null;
  if (Array.isArray(st.leases) && st.leases.length > 0) {
    const broker = makeBrokerClient(pluginConfig);
    if (broker) {
      try {
        leaseReport = await releaseAll({ broker, leases: st.leases, stateDir: ctx.stateDir });
      } catch (err) {
        leaseReport = { released: [], orphaned: st.leases.map((l) => l.leaseId), err: err?.message };
      }
    } else {
      leaseReport = { released: [], orphaned: st.leases.map((l) => l.leaseId), err: "no broker configured" };
    }
  }

  let cronRemoved = false;
  if (await isCronInstalled()) {
    const r = await removeCronJob();
    if (!r.ok) return { ok: false, text: `failed to remove cron: ${r.stderr || "unknown"}` };
    cronRemoved = true;
  }

  // Figure out the tmux name to operate on. Usually it's the worker we
  // recorded in state, but if the worker was already retired (or we cleared
  // it) while the user's Claude is still alive in the default tmux, fall
  // back to the configured/default session name so `/acc exit` can still
  // do its job.
  const tmuxCandidate = st.workerTmuxName
    || pluginConfig.tmuxName
    || DEFAULT_TMUX_NAME;

  // Soft-exit ladder lives in softExitClaude (Ctrl-C until pane_current_command
  // ≠ claude). If that doesn't release the pane, escalate to kill-session —
  // stop must actually stop. --kill-tmux shortcuts straight to kill.
  let exitOutcome = "no-tmux";
  let exitError = null;
  if (tmuxCandidate) {
    try {
      if (!(await tmuxHasSession(tmuxCandidate))) {
        exitOutcome = "no-session";
      } else {
        const paneCmd = await paneCurrentCommand(tmuxCandidate).catch(() => null);
        if (paneCmd && paneCmd !== "claude") {
          // tmux is up but claude isn't foregrounded — nothing to exit.
          exitOutcome = "already-shell";
        } else if (killTmux) {
          await tmuxKillSession(tmuxCandidate);
          exitOutcome = "killed";
        } else {
          exitOutcome = await softExitClaude(tmuxCandidate);
          if (!exitOutcome) {
            await tmuxKillSession(tmuxCandidate);
            exitOutcome = "killed-escalated";
          }
        }
      }
    } catch (err) {
      exitError = err?.message || String(err);
    }
  }

  clearWorker(ctx.stateDir);

  const lines = [];
  lines.push(stopHeadline(exitOutcome, exitError));
  lines.push(`↳ tmux '${tmuxCandidate}'`);
  if (st.watcherPid) {
    lines.push(`↳ watcher pid=${st.watcherPid} ${watcherKilled ? "signalled" : "already gone"}`);
  }
  lines.push(`↳ ${cronRemoved ? "watchdog cron removed" : "no watchdog cron to remove"}`);
  lines.push(`↳ ${describeExitOutcome(exitOutcome, exitError, tmuxCandidate)}`);
  if (leaseReport) {
    const okN = leaseReport.released?.length || 0;
    const orphanN = leaseReport.orphaned?.length || 0;
    if (orphanN > 0) {
      lines.push(`↳ leases: released ${okN}, orphaned ${orphanN} (saved for retry)`);
    } else if (okN > 0) {
      lines.push(`↳ leases: released ${okN}`);
    }
  }
  return { ok: true, text: lines.join("\n") };
}

// One-line summary that makes it obvious whether Claude Code actually
// exited. Appears at the top of `/acc exit` output.
function stopHeadline(outcome, error) {
  if (error) return `❌ /acc exit: error (${error})`;
  switch (outcome) {
    case "ctrl-c":
    case "killed":
    case "killed-escalated":
    case "session-gone":
      return "✅ Claude Code exited";
    case "already-shell":
      return "ℹ️ Claude Code was not running in the tmux";
    case "no-session":
      return "ℹ️ tmux session wasn't running";
    case "no-tmux":
      return "ℹ️ no worker tmux recorded; nothing to stop";
    default:
      if (typeof outcome === "string" && outcome.startsWith("ctrl-c-x")) {
        return "✅ Claude Code exited";
      }
      return `⚠️ /acc exit finished but exit state is unclear (${outcome})`;
  }
}

// Thin translator over tmux.ensurePaneAtShell so describeExitOutcome keeps
// its old vocabulary. ensurePaneAtShell is the shared primitive that both
// /acc exit and /acc launch (tmux reuse path) use — we spam Ctrl-C until
// `pane_current_command` is no longer "claude", with no sentinel paste to
// pollute the REPL.
async function softExitClaude(tmuxName) {
  const r = await ensurePaneAtShell(tmuxName);
  if (!r.ok) return r.reason === "no-session" ? "session-gone" : null;
  if (r.attempts === 0) return "already-shell";
  return `ctrl-c-x${r.attempts}`;
}

function describeExitOutcome(outcome, error, tmuxName) {
  if (error) return `claude-exit errored on tmux '${tmuxName}': ${error}`;
  if (outcome === "killed")           return `tmux '${tmuxName}' killed (--kill-tmux)`;
  if (outcome === "killed-escalated") return `claude REPL wouldn't release; escalated to kill tmux '${tmuxName}'`;
  if (outcome === "already-shell")    return `tmux '${tmuxName}' was already at the shell (no claude to stop)`;
  if (outcome === "no-session")       return `tmux '${tmuxName}' wasn't running`;
  if (outcome === "no-tmux")          return `no worker tmux recorded`;
  if (outcome === "session-gone")     return `tmux session vanished mid-exit`;
  if (typeof outcome === "string" && outcome.startsWith("ctrl-c-x")) {
    return `claude REPL in tmux '${tmuxName}' exited after ${outcome.slice("ctrl-c-x".length)}× Ctrl-C (tmux kept)`;
  }
  return `tmux '${tmuxName}' state unknown (${outcome})`;
}

export async function cmdStatus({ pluginConfig = {} } = {}) {
  const ctx = buildCtx(pluginConfig);
  const st = loadState(ctx.stateDir);
  if (!st.workerSessionId) {
    return { ok: true, text: "STATUS: NONE | no worker launched" };
  }
  const snapshot = await inspectWorker({
    workerSessionId: st.workerSessionId,
    workerTmuxName: st.workerTmuxName,
    workerCwd: st.workerCwd,
    workerSessionJsonl: st.workerSessionJsonl,
  });
  const branch = decideBranch({
    snapshot,
    thresholds: ctx.thresholds,
    hasWorker: true,
  });
  return {
    ok: true,
    text: formatStatusLine({ branch, state: st, snapshot }),
  };
}

export async function cmdAttach({ pluginConfig = {} } = {}) {
  const ctx = buildCtx(pluginConfig);
  const st = loadState(ctx.stateDir);
  if (!st.workerTmuxName) return { ok: false, text: "no worker to attach" };
  if (!(await tmuxHasSession(st.workerTmuxName))) {
    return { ok: false, text: `tmux session '${st.workerTmuxName}' is gone` };
  }
  return {
    ok: true,
    text: [
      `attach with:`,
      `  tmux attach -t ${st.workerTmuxName}`,
      `detach with Ctrl-b then d. (--dangerously-skip-permissions is ON)`,
    ].join("\n"),
  };
}

// `/acc resume` — list recent claude sessions for the relevant cwd (no args)
// or resume one. The picker shows the original task title (extracted from
// the first user message in the jsonl) so the user doesn't have to remember
// which UUID was which.
//
// Targets:
//   (empty)               → list mode
//   <n>                   → resume the n-th session from the listing
//   <session-id>          → resume that specific session UUID
//   last                  → resume the most recently retired session (same
//                           as `--resume-last`)
//
// Anything trailing the target is treated as a fresh prompt to inject into
// the resumed session — `/acc resume 2 keep going on the lint failures`.
export async function cmdResume({ pluginConfig = {}, args = "", notify = null } = {}) {
  const ctx = buildCtx(pluginConfig);
  const prior = loadState(ctx.stateDir);
  // Pick the cwd whose project dir we'll scan. Live worker > most-recently
  // retired > plugin default > process cwd. The fallthroughs let `resume`
  // work even when no worker is currently running.
  const cwd =
    prior.workerCwd ||
    prior.lastCwd ||
    pluginConfig.defaultCwd ||
    process.cwd();

  const trimmed = (args ?? "").trim();
  if (!trimmed || trimmed === "list" || trimmed === "ls") {
    return formatResumeListing(cwd);
  }

  const m = trimmed.match(/^(\S+)\s*(.*)$/);
  const target = m[1].toLowerCase();
  const extraPrompt = (m[2] || "").trim();

  if (target === "last" || target === "latest") {
    if (!prior.lastSessionId) {
      return {
        ok: false,
        text: "no retired session recorded yet — start one with /acc launch <task>",
      };
    }
    return cmdLaunch({
      pluginConfig,
      cwd,
      task: extraPrompt,
      taskLabel: prior.lastTask,
      resume: "last",
      notify,
    });
  }

  // Numeric index into the listing.
  if (/^\d{1,2}$/.test(target)) {
    const sessions = listRecentSessions(cwd, { limit: 10 });
    const idx = Number(target) - 1;
    const pick = sessions[idx];
    if (!pick) {
      return {
        ok: false,
        text: sessions.length
          ? `no session #${target} (only ${sessions.length} listed under ${cwd})`
          : `no claude sessions found under ${cwd}`,
      };
    }
    return cmdLaunch({
      pluginConfig,
      cwd,
      task: extraPrompt,
      taskLabel: pick.title,
      resume: pick.sessionId,
      notify,
    });
  }

  // Treat as a session id (claude uses 8-4-4-4-12 hex, 36 chars). UUIDs
  // are case-insensitive so the lowercased `target` is fine. Anything
  // shorter than 36 chars is treated as a prefix and resolved against the
  // recent listing — the picker shows 8-char prefixes, so users can copy
  // those directly.
  if (/^[0-9a-f-]{6,}$/i.test(target)) {
    let fullId = target;
    if (target.length < 36) {
      const sessions = listRecentSessions(cwd, { limit: 50 });
      const matches = sessions.filter((s) =>
        s.sessionId.toLowerCase().startsWith(target),
      );
      if (matches.length === 0) {
        return {
          ok: false,
          text: `no session id starts with "${target}" under ${cwd}`,
        };
      }
      if (matches.length > 1) {
        const lines = matches
          .slice(0, 5)
          .map((s) => `  ${s.sessionId}  ${oneLine(s.title || "(no message recorded)", 60)}`);
        return {
          ok: false,
          text: [
            `prefix "${target}" matches ${matches.length} sessions — be more specific:`,
            ...lines,
          ].join("\n"),
        };
      }
      fullId = matches[0].sessionId;
    }
    const jsonl = locateSessionJsonl(cwd, fullId);
    if (!jsonl) {
      return {
        ok: false,
        text: `no claude session ${fullId} under ${cwd}`,
      };
    }
    const title = readFirstUserMessage(jsonl);
    return cmdLaunch({
      pluginConfig,
      cwd,
      task: extraPrompt,
      taskLabel: title,
      resume: fullId,
      notify,
    });
  }

  return {
    ok: false,
    text: [
      "usage:",
      "  /acc resume                  list recent sessions",
      "  /acc resume <n>              resume the n-th from the list",
      "  /acc resume <session-id>     resume by UUID",
      "  /acc resume last             resume the most recently retired session",
      "  /acc resume <…> <prompt>     same, plus inject a fresh prompt",
    ].join("\n"),
  };
}

// `/acc continue` — first-class peer of launch and resume. Picks the cwd's
// newest jsonl (regardless of whether acc has retired it) and attaches a
// fresh worker to it. Trailing prose is injected as a new prompt, just
// like /acc resume.
export async function cmdContinue({ pluginConfig = {}, args = "", notify = null } = {}) {
  const ctx = buildCtx(pluginConfig);
  const prior = loadState(ctx.stateDir);
  const cwd =
    prior.workerCwd ||
    prior.lastCwd ||
    pluginConfig.defaultCwd ||
    process.cwd();
  const extraPrompt = (args ?? "").trim();

  const recent = listRecentSessions(cwd, { limit: 1 });
  if (!recent.length) {
    return {
      ok: false,
      text: `no claude sessions found under ${cwd} to continue`,
    };
  }
  return cmdLaunch({
    pluginConfig,
    cwd,
    task: extraPrompt,
    taskLabel: recent[0].title,
    resume: recent[0].sessionId,
    notify,
  });
}

function formatResumeListing(cwd) {
  const sessions = listRecentSessions(cwd, { limit: 10 });
  if (!sessions.length) {
    return {
      ok: false,
      text: [
        `no claude sessions found under ${cwd}`,
        "(start one with: /acc launch <task>)",
      ].join("\n"),
    };
  }
  const rows = sessions.map((s, i) => {
    const sid = s.sessionId.slice(0, 8);
    const age = formatAge(Date.now() - s.mtimeMs).padStart(5);
    const title = oneLine(s.title || "(no message recorded)", 70);
    return `  ${String(i + 1).padStart(2)}. ${sid}  ${age}  ${title}`;
  });
  return {
    ok: true,
    text: [
      `recent claude sessions in ${cwd}:`,
      ...rows,
      "",
      "resume:  /acc resume <n>   |   /acc resume <session-id>   |   /acc resume last",
      "         (append a prompt after the target to inject one on resume)",
    ].join("\n"),
  };
}

function formatAge(ms) {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86400)}d`;
}

// Send a free-form message into whichever claude REPL is currently running
// inside the worker tmux. No new session, no new cron — just a turn tacked
// onto the existing conversation. Used when the user types
// `/auto-claude-code <message>` without the `launch` keyword.
export async function cmdSend({ pluginConfig = {}, message } = {}) {
  const text = (message ?? "").trim();
  if (!text) return { ok: false, text: "usage: /auto-claude-code <message to running worker>" };

  // First: if the watcher's hook server has a pending acc_ask_user
  // question, route this reply there — claude is blocked on the MCP
  // tool call waiting for the answer. Watcher handles the dispatch.
  // Falls through to normal sticky-paste if no question is pending.
  const delivered = await tryDeliverPendingAnswer(text);
  if (delivered) {
    return { ok: true, text: `delivered answer to pending acc_ask_user question` };
  }

  const fallbackTmux = pluginConfig.tmuxName || DEFAULT_TMUX_NAME;
  const ctx = buildCtx(pluginConfig);
  const st = loadState(ctx.stateDir);
  const tmuxName = st.workerTmuxName || fallbackTmux;

  if (!(await tmuxHasSession(tmuxName))) {
    return {
      ok: false,
      text: [
        `no tmux session '${tmuxName}' is running.`,
        "start one with:  /auto-claude-code launch <task>",
      ].join("\n"),
    };
  }

  const r = await pokeTmuxWorker({ tmuxName, prompt: text });
  if (!r.ok) return { ok: false, text: `send failed: ${r.error || "unknown"}` };
  return {
    ok: true,
    text: `sent to tmux '${tmuxName}': ${summarizeTask(text)}`,
  };
}

// ---- watcher hook bridge ----

// Forward a chat reply to the watcher's /answer endpoint. If the watcher
// is up AND has a pending acc_ask_user question, it consumes the answer
// and unblocks the MCP tool call. Returns true on successful delivery
// (caller can short-circuit), false otherwise (caller falls through to
// normal pokeTmuxWorker paste path).
async function tryDeliverPendingAnswer(text) {
  const port = process.env.AUTO_CLAUDE_CODE_HOOK_PORT || "7779";
  const url = `http://127.0.0.1:${port}/answer`;
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answer: text }),
      signal: AbortSignal.timeout(2000),
    });
    if (!resp.ok) return false;
    const body = await resp.json().catch(() => ({}));
    return !!body.delivered;
  } catch {
    return false;   // watcher not up / busy → silent fall-through
  }
}
