import {
  resolveStateDir,
  ensureStateDir,
  loadState,
  saveState,
  updateState,
  clearWorker,
  retireWorker,
} from "./state.js";
import { inspectWorker, locateSessionJsonl } from "./claude-state.js";
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

const DEFAULT_CRON_EXPR = "*/5 * * * *";
const DEFAULT_NUDGE_AFTER_SEC = 600;
const DEFAULT_RECOVER_AFTER_SEC = 1800;
const TASK_SUMMARY_CHARS = 80;

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

// Decide whether the watchdog cron should be installed for a launch, and
// Watcher owns force-continue (it sees end_turn in real time). Cron is now
// purely for LLM heartbeat rendering in summary mode. In instant mode the
// watcher streams to chat directly, so the cron stays out of the picture
// regardless of whether force is on.
//
//   instant  force | watcher                   cron
//   ---------------+-----------------------------------------------
//   true     no    | spawn (streams chat)      (none)
//   true     yes   | spawn (streams + force)   (none)
//   false    no    | (none)                    install (announce)
//   false    yes   | spawn (force only, no notify) install (announce)
export function planCronInstall({ instant, notify }) {
  if (instant) return null;
  return { notify: notify ?? null, instant: false };
}

const WATCHER_SCRIPT = pathResolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "bin",
  "watcher.mjs",
);

function spawnWatcher({ stateDir, notify, force = false, maxContinues } = {}) {
  const env = {
    ...process.env,
    AUTO_CLAUDE_CODE_STATE_DIR: stateDir,
  };
  if (notify?.channel) env.AUTO_CLAUDE_CODE_NOTIFY_CHANNEL = notify.channel;
  if (notify?.to) env.AUTO_CLAUDE_CODE_NOTIFY_TO = notify.to;
  if (notify?.account) env.AUTO_CLAUDE_CODE_NOTIFY_ACCOUNT = notify.account;
  // Force-continue lives inside the watcher now — tick no longer reads
  // these, so only the watcher needs to be told.
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
} = {}) {
  if (!task || !task.trim()) {
    return { ok: false, text: "usage: /auto-claude-code launch <task description>" };
  }
  if (!cwd) {
    return { ok: false, text: "launch: cwd is required" };
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
  const launched = await launchWorker({
    cwd,
    task,
    model,
    tmuxName,
    resumeSessionId,
    continueLatest: !!continueLatest,
    forkOnResume: !!fork,
  });
  if (!launched.ok) return { ok: false, text: `launch failed: ${launched.error}` };

  const resolvedForce = force ?? !!pluginConfig.force;
  const resolvedMaxContinues =
    maxContinues ?? pluginConfig.maxAutoContinues ?? undefined;
  const configInstant = pluginConfig.instant !== false;
  const resolvedInstant = instant !== undefined ? instant : configInstant;

  // Always spawn the watcher — it's the only process that can (a) react to
  // end_turn the moment it lands (force-continue), (b) push streaming chat
  // in instant mode, and (c) auto-approve Claude Code's sensitive-file
  // modal that --dangerously-skip-permissions doesn't cover. Features (a)
  // and (b) are gated internally on the launch flags, but (c) runs as long
  // as the watcher is alive, so we need the watcher regardless of mode.
  const watcherPid = spawnWatcher({
    stateDir: ctx.stateDir,
    notify: resolvedInstant ? ctx.notify : null,
    force: resolvedForce,
    maxContinues: resolvedMaxContinues,
  });

  updateState(ctx.stateDir, (prev) => ({
    ...prev,
    workerSessionId: launched.sessionId,
    workerTmuxName: launched.tmuxName,
    workerCwd: launched.cwd,
    workerTask: launched.task,
    workerSessionJsonl: locateSessionJsonl(cwd, launched.sessionId),
    launchedAt: launched.launchedAt,
    // Sticky routing: chats that launched this worker should have their
    // follow-up messages auto-pasted to the worker without needing /acc.
    stickyChannel: pluginConfig.sticky === false ? null : (ctx.notify?.channel ?? null),
    stickySender: pluginConfig.sticky === false ? null : (ctx.notify?.to ?? null),
    stickyAccount: pluginConfig.sticky === false ? null : (ctx.notify?.account ?? null),
    watcherPid,
    watcherStartedAt: watcherPid ? new Date().toISOString() : null,
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
      instant: cronPlan.instant,
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

  const lines = [
    `${headerEmoji} ${headerVerb} — ${summarizeTask(launched.task)}`,
    `↳ session: ${shortSid}  ·  tmux: ${launched.tmuxName}`,
  ];
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

  let cronRemoved = false;
  if (await isCronInstalled()) {
    const r = await removeCronJob();
    if (!r.ok) return { ok: false, text: `failed to remove cron: ${r.stderr || "unknown"}` };
    cronRemoved = true;
  }

  // Figure out the tmux name to operate on. Usually it's the worker we
  // recorded in state, but if the worker was already retired (or we cleared
  // it) while the user's Claude is still alive in the default tmux, fall
  // back to the configured/default session name so `/acc stop` can still
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
  return { ok: true, text: lines.join("\n") };
}

// One-line summary that makes it obvious whether Claude Code actually
// exited. Appears at the top of `/acc stop` output.
function stopHeadline(outcome, error) {
  if (error) return `❌ /acc stop: error (${error})`;
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
      return `⚠️ /acc stop finished but exit state is unclear (${outcome})`;
  }
}

// Thin translator over tmux.ensurePaneAtShell so describeExitOutcome keeps
// its old vocabulary. ensurePaneAtShell is the shared primitive that both
// /acc stop and /acc launch (tmux reuse path) use — we spam Ctrl-C until
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

// Send a free-form message into whichever claude REPL is currently running
// inside the worker tmux. No new session, no new cron — just a turn tacked
// onto the existing conversation. Used when the user types
// `/auto-claude-code <message>` without the `launch` keyword.
export async function cmdSend({ pluginConfig = {}, message } = {}) {
  const text = (message ?? "").trim();
  if (!text) return { ok: false, text: "usage: /auto-claude-code <message to running worker>" };

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
