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
  capturePane,
  sendEnter,
  sendLiteral,
  sendKey,
  DEFAULT_TMUX_NAME,
} from "./tmux.js";
import { modalSignature } from "./tui.js";
import { sleep } from "./util.js";
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

  // Auto-detect "form CSV" payload: a single digit like `1`, or a CSV of
  // digits / skip / submit / quoted text like `1,2,"stuff",submit`. Those
  // reply patterns target form/modal UI, so route them through cmdForm
  // (which drives tmux with per-answer navigation) instead of a plain
  // paste. Plain prose messages fall through to the normal send.
  // Multi-tab form answers (with commas) go through cmdForm so we do the
  // per-tab paste + Right navigation. A single-answer reply like `/acc 1`
  // stays with the normal paste + Enter path — that's what a single modal
  // expects and matches what a user would type by hand.
  if (text.includes(",") && looksLikeFormAnswer(text)) {
    return cmdForm({ pluginConfig, csv: text });
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

// Decide whether `text` is a form-answer-style payload (digit / CSV of
// digits+skip+submit+quoted-text) rather than a regular prose message.
// Conservative by design — prose like "hello, world" must NOT route to
// cmdForm (that would reject with a validation error and confuse the user).
// We require every comma-separated slot to be a form token; anything else
// falls through to normal send.
function looksLikeFormAnswer(text) {
  const t = text.trim();
  if (!t) return false;
  const tokens = splitFormCsv(t);
  if (tokens.length === 0) return false;
  return tokens.every((tok) => {
    if (tok.empty) return false;
    if (tok.quoted) return true;
    return /^(\d{1,2}|skip|submit)$/i.test(tok.text);
  });
}

// Fill a Claude Code multi-step form by pasting each answer and navigating
// with ← / → / Enter keys. Also drives single-question modals — `/acc 1`
// auto-routes here as a 1-element CSV.
//
// CSV token grammar (one per tab, in tab order):
//   \d{1,2}        — press that digit (select a numbered option)
//   skip           — leave the tab's current state untouched
//   submit         — press Enter and stop (optional — see below)
//   "quoted text"  — paste the text literally (free-text tabs)
//
// Unquoted non-digit words are rejected so typos don't silently get typed
// into a numbered-option tab. Malformed input returns a usage error so the
// user can retype rather than trash their form.
//
// After the last answer we auto-press Enter, so `submit` is optional —
// `/acc form 1,2,3,4` == `/acc form 1,2,3,4,submit`.
//
// Auto-advance: Claude Code's TUI select-and-advances on a digit press. If
// we always sent Right after every paste we'd skip the next tab. So after
// each non-last paste we compare the modal body signature before vs. after
// the keypress; only when it DIDN'T change do we send Right ourselves.
export async function cmdForm({ pluginConfig = {}, csv } = {}) {
  const raw = (csv ?? "").trim();
  if (!raw) {
    return { ok: false, text: "usage: /acc form 1,2,\"text\",skip,submit" };
  }
  const ctx = buildCtx(pluginConfig);
  const st = loadState(ctx.stateDir);
  const tmuxName = st.workerTmuxName || pluginConfig.tmuxName || DEFAULT_TMUX_NAME;
  if (!(await tmuxHasSession(tmuxName))) {
    return { ok: false, text: `no tmux session '${tmuxName}' to drive` };
  }

  const parsed = parseAndValidateFormAnswers(raw);
  if (!parsed.ok) {
    return {
      ok: false,
      text: [
        `form: ${parsed.error}`,
        `expected CSV of: digit (e.g. 1), skip, submit, or "quoted text"`,
        `example: /acc 1,2,"my-repo",submit`,
        `got: ${raw}`,
      ].join("\n"),
    };
  }
  const answers = parsed.answers;

  const log = [];
  let preSig = await paneSig(tmuxName);
  for (let i = 0; i < answers.length; i++) {
    const a = answers[i];
    const isLast = i === answers.length - 1;
    try {
      if (a.kind === "skip") {
        log.push(`skip`);
      } else if (a.kind === "submit") {
        await sendEnter(tmuxName);
        log.push(`submit`);
        break;
      } else if (a.kind === "digit") {
        await sendLiteral(tmuxName, a.value);
        log.push(`digit ${a.value}`);
      } else {
        await sendLiteral(tmuxName, a.value);
        log.push(`text "${a.value}"`);
      }
      await sleep(300);

      if (isLast) {
        await sendEnter(tmuxName);
        log.push("auto-Enter");
        break;
      }

      // Did the TUI auto-advance on the keypress? Compare modal body
      // signatures: same sig ⇒ still on the same tab ⇒ we send Right;
      // different sig ⇒ TUI already moved ⇒ skip Right to avoid
      // double-advancing past the next tab.
      const postSig = await paneSig(tmuxName);
      const advanced = postSig && preSig && postSig !== preSig;
      if (advanced) {
        log.push(`auto-advanced`);
      } else {
        await sendKey(tmuxName, "Right");
        await sleep(250);
      }
      preSig = await paneSig(tmuxName);
    } catch (err) {
      log.push(`err on item ${i + 1} (${a.kind}:${a.value}): ${err?.message || err}`);
      return { ok: false, text: `form drive failed at step ${i + 1}: ${err?.message || err}\nsteps: ${log.join(" → ")}` };
    }
  }
  return { ok: true, text: `form filled: ${log.join(" → ")}` };
}

// Snapshot the current modal body signature. Empty string when no modal
// is visible or tmux capture fails.
async function paneSig(tmuxName) {
  try {
    const pane = await capturePane(tmuxName, { lines: 40 });
    return modalSignature(pane);
  } catch {
    return "";
  }
}

// Parse a CSV of form answers and validate every token. Returns
//   { ok: true,  answers: [{ kind: "digit"|"text"|"skip"|"submit", value }] }
// or an explanatory error so the caller can tell the user what's wrong and
// prompt them to re-enter instead of pasting garbage into the TUI.
function parseAndValidateFormAnswers(input) {
  const tokens = splitFormCsv(input);
  if (tokens.length === 0) return { ok: false, error: "parsed 0 answers from CSV" };
  const answers = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.empty) {
      return { ok: false, error: `empty slot at position ${i + 1} (did you mean skip?)` };
    }
    if (tok.quoted) {
      answers.push({ kind: "text", value: tok.text });
      continue;
    }
    const t = tok.text;
    if (/^\d{1,2}$/.test(t)) {
      answers.push({ kind: "digit", value: t });
    } else if (/^skip$/i.test(t)) {
      answers.push({ kind: "skip", value: "" });
    } else if (/^submit$/i.test(t)) {
      answers.push({ kind: "submit", value: "" });
    } else {
      return {
        ok: false,
        error: `invalid token '${t}' at position ${i + 1}; wrap free text in "quotes" or use digit/skip/submit`,
      };
    }
  }
  return { ok: true, answers };
}

// CSV splitter that preserves quote context:
//   { text, quoted, empty }
// `quoted` = the token was wrapped in double quotes (so `""` is kept as an
// empty quoted string, distinct from a missing slot).
// `empty`  = the slot had no content at all — the middle of `1,,2`.
function splitFormCsv(input) {
  const out = [];
  let buf = "";
  let inQuotes = false;
  let wasQuoted = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (inQuotes) {
      if (c === '"') { inQuotes = false; continue; }
      buf += c;
      continue;
    }
    if (c === '"') { inQuotes = true; wasQuoted = true; continue; }
    if (c === ",") {
      const trimmed = buf.trim();
      out.push({ text: trimmed, quoted: wasQuoted, empty: !wasQuoted && trimmed === "" });
      buf = "";
      wasQuoted = false;
      continue;
    }
    buf += c;
  }
  const trimmed = buf.trim();
  out.push({ text: trimmed, quoted: wasQuoted, empty: !wasQuoted && trimmed === "" });
  return out;
}
