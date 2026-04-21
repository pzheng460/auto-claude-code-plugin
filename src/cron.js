import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const execFile = promisify(execFileCb);

export const CRON_JOB_NAME = "auto-claude-code-watchdog";

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TICK_SCRIPT = resolve(PLUGIN_ROOT, "bin", "tick.mjs");

async function runOpenclaw(args) {
  try {
    const { stdout } = await execFile("openclaw", args, {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    return { ok: true, stdout, stderr: "" };
  } catch (err) {
    return {
      ok: false,
      stdout: err.stdout?.toString?.() ?? "",
      stderr: err.stderr?.toString?.() ?? String(err),
    };
  }
}

function shellSingleQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}


export function buildTickMessage({ stateDir, thresholds, instant = false }) {
  // tick is a pure reporter now — it doesn't need AUTO_CLAUDE_CODE_FORCE or
  // MAX_CONTINUES. The watcher owns force-continue and reads those directly
  // from its own environment (set by spawnWatcher in commands.js).
  const envs = [`AUTO_CLAUDE_CODE_STATE_DIR=${shellSingleQuote(stateDir)}`];
  if (thresholds?.nudgeAfterSec) envs.push(`AUTO_CLAUDE_CODE_NUDGE_AFTER_SEC=${thresholds.nudgeAfterSec}`);
  if (thresholds?.recoverAfterSec) envs.push(`AUTO_CLAUDE_CODE_RECOVER_AFTER_SEC=${thresholds.recoverAfterSec}`);
  if (instant) envs.push(`AUTO_CLAUDE_CODE_INSTANT=1`);
  const command = `${envs.join(" ")} node ${shellSingleQuote(TICK_SCRIPT)}`;
  if (instant) {
    return [
      "You are a deterministic trampoline. Do exactly one thing:",
      "",
      "Run this single bash command, and reply with its stdout VERBATIM:",
      `  ${command}`,
      "",
      "Rules:",
      "- Do not summarize, reformat, re-order, or annotate.",
      "- Do not add any commentary before or after.",
      "- Preserve all whitespace and emoji from stdout.",
      "- If the command fails, reply exactly: '❌ watchdog error — ' + the stderr first line.",
    ].join("\n");
  }
  return [
    "You are the auto-claude-code watchdog reporter.",
    "",
    "Step 1 — Run this bash command and read its stdout:",
    `  ${command}`,
    "",
    "The stdout contains structured blocks delimited by tags:",
    "  <status>                key=value lines: branch, tmux_alive, progress,",
    "                           heartbeat_age, awaiting_user_reply, cwd, task, etc.",
    "  <todos>                 [done]/[wip]/[todo] lines, one per todo",
    "  <diff_since_last_tick>  completed / started / added todos (may be empty)",
    "  <recent_activity>       `[claude] <text>` and `[tool] Name(arg)` lines",
    "                           for new claude-code events since last tick",
    "  <notes>                 watchdog actions taken this tick",
    "",
    "Step 2 — Reply with an English progress report in EXACTLY this template:",
    "",
    "  <emoji> auto-claude-code heartbeat",
    "  Status: <branch> | Progress: X/Y | Heartbeat: Ns | tmux=<tmux_name>",
    "  Recently completed: <comma-joined diff.completed, or 'none'>",
    "  Currently: <content of the [wip] todo, or 'no in-progress todo'>",
    "  Recent actions: <2-6 sentences summarizing <recent_activity>. Mention concrete file edits, bash commands, and what claude said. Group similar edits. Use past tense. If recent_activity is empty, write 'No new activity since last tick.'>",
    "  Notes: <paraphrase <notes>; OMIT this line entirely if notes is '(no watchdog actions this tick)'>",
    "",
    "Emoji by branch (prefix the header line with this emoji):",
    "  OK=✅  NUDGE=⚠️  RECOVER=🔧  DONE=🎉  DEAD=💀  AWAITING=💤  IDLE=⏳  NONE=⚪",
    "",
    "Rules:",
    "- English only.",
    "- Always produce a report, even when recent_activity is empty.",
    "- Stick strictly to facts present in stdout. Do NOT invent files, commands, or todos.",
    "- If stdout starts with 'branch=NONE', reply only: '⚪ auto-claude-code: no worker tracked'.",
    "- If branch is DEAD or DONE, after the header/Status lines, write one sentence explaining why and skip Currently/Recent-actions.",
    "- Keep the entire reply under 500 words. No markdown headings, no code fences.",
    "- If the bash command itself fails, reply: '❌ watchdog error — ' followed by the stderr (one line).",
  ].join("\n");
}

// Parse a human-friendly interval string into a cron expression.
// Accepts:
//   "30s"   "45 sec"         — 6-field cron (seconds)
//   "5m"    "10 minutes"     — minute granularity
//   "2h"    "3 hour"         — hour granularity
//   "5"                      — bare number, treated as minutes
//   "*/5 * * * *"            — raw cron, passed through
// Returns { cron: string } on success or { error: string } on failure.
export function parseInterval(input) {
  if (input == null) return { cron: null };
  const s = String(input).trim();
  if (!s) return { cron: null };

  // already a multi-field cron expression (5 or 6 whitespace-separated tokens)
  const tokens = s.split(/\s+/);
  if (tokens.length === 5 || tokens.length === 6) {
    return { cron: s };
  }

  const m = s.toLowerCase().match(/^(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)?$/);
  if (!m) {
    return {
      error: `interval "${input}" not understood. Use "30s", "5m", "2h", or raw cron like "*/5 * * * *".`,
    };
  }
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 1) {
    return { error: `interval "${input}" must be a positive number` };
  }
  const unit = (m[2] || "m").charAt(0); // default minutes

  if (unit === "s") {
    if (n >= 60) return { ok: true, cron: `0 */${Math.round(n / 60)} * * * *` };
    if (60 % n !== 0) {
      return { error: `interval '${input}' does not divide 60 seconds evenly` };
    }
    return { ok: true, cron: `*/${n} * * * * *` };
  }
  if (unit === "m") {
    if (n === 1) return { ok: true, cron: "* * * * *" };
    if (n < 60) {
      // Accept any 1-59 minute interval. Non-divisors of 60 produce an
      // irregular schedule (e.g. */45 fires at :00 and :45 — only twice an
      // hour), but that's a reasonable user expectation and better than
      // rejecting common values like "7m" or "45m".
      return { ok: true, cron: `*/${n} * * * *` };
    }
    if (n % 60 === 0) return { ok: true, cron: `0 */${n / 60} * * *` };
    return { error: `${n} minutes doesn't fit standard cron cleanly; use an hour multiple or raw cron` };
  }
  if (unit === "h") {
    if (n >= 24) return { error: `${n}h too large; use raw cron for daily or longer intervals` };
    return { ok: true, cron: n === 1 ? "0 * * * *" : `0 */${n} * * *` };
  }
  return { error: `unrecognised unit in '${input}'` };
}

async function findJobIdByName(name) {
  const r = await runOpenclaw(["cron", "list", "--all", "--json"]);
  if (!r.ok) return { ok: false, stderr: r.stderr };
  try {
    const parsed = JSON.parse(r.stdout);
    const jobs = Array.isArray(parsed.jobs) ? parsed.jobs : [];
    const match = jobs.find((j) => j?.name === name);
    return { ok: true, id: match?.id ?? null };
  } catch (err) {
    return { ok: false, stderr: `failed to parse cron list: ${String(err)}` };
  }
}

export async function isCronInstalled({ name = CRON_JOB_NAME } = {}) {
  const r = await findJobIdByName(name);
  return r.ok && !!r.id;
}

// Install the watchdog cron, but ONLY if no same-named job exists.
//
// IMPORTANT: this used to "remove existing then add" so flag changes would
// take effect on every launch. That behavior is non-transactional — if the
// `cron add` step fails (e.g. because a child openclaw process can't load
// the plugin), we'd be left with NO cron at all, silently dropping the
// watchdog. See incident on 2026-04-21: a ParseError in src/tmux.js made
// every cron-spawned LLM fail to load the plugin, so installCron would
// remove the old cron and then never install the new one.
//
// Callers that want fresh flags MUST explicitly remove the cron first
// (cmdLaunch's supersede path already does this). New launches with no
// prior worker fall through to the original behavior.
export async function installCron({ cronExpr, stateDir, thresholds, notify, instant = false, timeoutSeconds = 60 }) {
  const existing = await findJobIdByName(CRON_JOB_NAME);
  if (existing.ok && existing.id) {
    return { ok: true, alreadyInstalled: true, id: existing.id };
  }
  const message = buildTickMessage({ stateDir, thresholds, instant });
  const args = [
    "cron", "add",
    "--name", CRON_JOB_NAME,
    "--cron", cronExpr,
    "--session", "isolated",
    "--tools", "exec",
    "--message", message,
    "--timeout-seconds", String(timeoutSeconds),
    "--wake", "now",
    "--best-effort-deliver",
  ];
  // Only announce when we have a concrete channel+to.
  // "last" channel fallback fails when multiple channels are configured.
  if (notify?.channel && notify?.to) {
    args.push("--announce", "--channel", notify.channel, "--to", notify.to);
    if (notify.account) args.push("--account", notify.account);
  }
  return runOpenclaw(args);
}

export async function removeCronJob({ name = CRON_JOB_NAME } = {}) {
  const found = await findJobIdByName(name);
  if (!found.ok) return { ok: false, stderr: found.stderr ?? "list failed" };
  if (!found.id) return { ok: true, alreadyRemoved: true };
  return runOpenclaw(["cron", "rm", found.id]);
}
