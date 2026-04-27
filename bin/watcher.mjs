#!/usr/bin/env node
// Long-running tailer for --instant mode. Tails the worker's session jsonl
// and pushes each new assistant event (text, tool_use) directly to the notify
// channel via `openclaw system event`. No cron, no LLM summary.

import { statSync, openSync, readSync, closeSync, existsSync } from "node:fs";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import {
  resolveStateDir,
  loadState,
  saveState,
  appendNudge,
  retireWorker,
} from "../src/state.js";
import {
  locateSessionJsonl,
  readTasks,
  summarizeRecentOutput,
} from "../src/claude-state.js";
import {
  hasSession as tmuxHasSession,
  sendLiteral,
  sendEnter,
} from "../src/tmux.js";
import { retireReasonFor } from "../src/tick/plan.js";
import { buildContinuePrompt, pokeTmuxWorker } from "../src/poke.js";
import { removeCronJob } from "../src/cron.js";
import { envNum, envBool } from "../src/env.js";
import { sleep, oneLine } from "../src/util.js";
import { formatAssistantText } from "../src/watcher-format.js";
import {
  startHookServer,
  queueForceContinue,
  pendingCount as askPendingCount,
  deliverAnswer,
} from "../src/hook_server.js";
import { autoAnswerInForceMode } from "../src/auto_answer.js";

const execFile = promisify(execFileCb);

const POLL_MS = envNum("AUTO_CLAUDE_CODE_WATCHER_POLL_MS", 2000);
const BATCH_MS = envNum("AUTO_CLAUDE_CODE_WATCHER_BATCH_MS", 3000);
// Force-continue: the watcher owns this since it's the only loop that sees
// end_turn the moment it appears in jsonl. Tick is now a pure reporter.
const FORCE_MODE = envBool("AUTO_CLAUDE_CODE_FORCE", false);
const MAX_CONTINUES = envNum("AUTO_CLAUDE_CODE_MAX_CONTINUES", 5);
// Per-event assistant text cap before `…`. Default generous so full replies
// fit inside a single push; when a single event is larger than MSG_CHAR_LIMIT
// the flusher splits it on paragraph/sentence boundaries instead of truncating.
const TEXT_CHARS = envNum("AUTO_CLAUDE_CODE_WATCHER_TEXT_CHARS", 6000);
const LIVENESS_EVERY_POLLS = 5;

const stateDir = resolveStateDir();
const notifyChannel = process.env.AUTO_CLAUDE_CODE_NOTIFY_CHANNEL || "";
const notifyTo = process.env.AUTO_CLAUDE_CODE_NOTIFY_TO || "";
const notifyAccount = process.env.AUTO_CLAUDE_CODE_NOTIFY_ACCOUNT || "";

// ----- helpers --------------------------------------------------------------

function log(...xs) {
  process.stderr.write(`[acc-watcher ${new Date().toISOString()}] ${xs.join(" ")}\n`);
}

// Formatter (multiLine → rewriteGfmTables → normalizeForFeishuLarkMd) now
// lives in src/watcher-format.js as `formatAssistantText` — single-pass,
// unit-tested, importable.

function readDelta(path, fromOffset) {
  if (!existsSync(path)) return { events: [], newOffset: fromOffset };
  const size = statSync(path).size;
  if (size <= fromOffset) return { events: [], newOffset: fromOffset };
  const fd = openSync(path, "r");
  const buf = Buffer.alloc(size - fromOffset);
  try { readSync(fd, buf, 0, buf.length, fromOffset); }
  finally { closeSync(fd); }
  const events = buf.toString("utf8").split("\n").filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
  return { events, newOffset: size };
}

function formatEvent(ev) {
  if (ev?.type !== "assistant") return null;
  const content = ev.message?.content;
  if (!Array.isArray(content)) return null;
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && block.text?.trim()) {
      // Preserve line breaks / code blocks for readability on the chat side.
      parts.push(`💬 ${formatAssistantText(block.text, TEXT_CHARS)}`);
    } else if (block.type === "tool_use") {
      const name = block.name || "tool";
      const input = block.input || {};
      const arg =
        input.file_path ||
        input.notebook_path ||
        input.command ||
        input.pattern ||
        input.url ||
        input.query ||
        input.description ||
        "";
      const shown = arg ? `(${oneLine(arg, 120)})` : "";
      parts.push(`🔧 ${name}${shown}`);
    }
  }
  return parts.length ? parts.join("\n") : null;
}

// Walk a chunk's events and report the tail state for force-continue
// decisioning:
//   - `awaitingReason`: the stop_reason of the newest assistant event iff it
//     is end_turn/stop_sequence AND no newer user event has landed. Null
//     otherwise (either the last event is a user msg, or the last assistant
//     event is mid-tool-use).
//   - `hadToolUse`: true if any assistant event in the chunk ran a tool —
//     used to reset the auto-continue counter on progress.
function analyzeChunk(events) {
  let awaitingReason = null;
  let hadToolUse = false;
  // walk newest-first for the tail decision
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev?.type === "assistant") {
      const reason = ev?.message?.stop_reason;
      if (reason === "end_turn" || reason === "stop_sequence") {
        awaitingReason = reason;
      }
      break;
    }
    if (ev?.type === "user") break;
  }
  // second pass: any tool_use in this chunk means Claude did real work
  for (const ev of events) {
    if (ev?.type !== "assistant") continue;
    if (ev?.message?.stop_reason === "tool_use") { hadToolUse = true; break; }
    for (const block of (ev.message?.content || [])) {
      if (block?.type === "tool_use") { hadToolUse = true; break; }
    }
    if (hadToolUse) break;
  }
  return { awaitingReason: awaitingReason, hadToolUse };
}


// Pretty-print a duration in ms as Nh Mm or Mm Ss for readability.
function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "?";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m - h * 60}m`;
}

// Build a multi-line completion report to push when claude raises a
// DONE/BLOCKED marker. Includes duration, task completion count, and a
// short tail of recent assistant output so the user has real context
// instead of just the bare marker line.
async function buildCompletionReport(mark, { state, jsonlPath }) {
  const lines = [`🎯 Worker signalled ${mark.marker}: ${mark.line}`];
  if (state.launchedAt) {
    const durMs = Date.now() - Date.parse(state.launchedAt);
    if (Number.isFinite(durMs) && durMs > 0) {
      lines.push(`⏱  duration: ${formatDuration(durMs)}`);
    }
  }
  try {
    const tasks = readTasks(state.workerSessionId);
    if (tasks.length > 0) {
      const done = tasks.filter((t) => t.status === "completed").length;
      lines.push(`✅ tasks: ${done}/${tasks.length} completed`);
    }
  } catch {}
  try {
    const { lines: recent } = summarizeRecentOutput(jsonlPath, {
      maxEvents: 3,
      textCharLimit: 240,
    });
    if (recent.length) {
      lines.push("", "Recent output:");
      for (const l of recent.slice(-3)) lines.push(`  ${oneLine(l, 240)}`);
    }
  } catch {}
  lines.push("", "cron removed · watcher still monitoring · /acc stop to release tmux");
  return lines.join("\n");
}

function scanStopMarker(events) {
  // Walk newest-first and only inspect the most recent assistant turn —
  // matches detectStopMarker() in src/claude-state.js so both watcher and
  // tick infer the same retire reason from the same jsonl tail.
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev?.type !== "assistant") continue;
    for (const block of (ev.message?.content || [])) {
      if (block?.type !== "text") continue;
      for (const line of String(block.text ?? "").split(/\r?\n/)) {
        const m = line.match(/^\s*(DONE|BLOCKED)\s*:/);
        if (m) return { marker: m[1].toUpperCase(), line: line.trim() };
      }
    }
    break;
  }
  return null;
}

async function pushToChannel(text) {
  if (!text) return;
  if (!notifyChannel || !notifyTo) {
    log("no notify target; dropping:", oneLine(text, 80));
    return;
  }
  // The cron `--to` flag accepts "user:<open_id>", but `openclaw message send
  // --target` for feishu wants the bare open_id (or chat:<id> for groups).
  // Strip the leading `user:` prefix so both worlds work from the same notify
  // config.
  const target = notifyTo.replace(/^user:/, "");
  // Send as plain text. We used to append an empty ``` ``` code fence to trip
  // openclaw-feishu's card renderer, but an empty code block on mobile Feishu
  // renders a "0 行代码" footer badge — ugly on every push. Accept that
  // watcher messages are text bubbles; real code blocks in the body still
  // render as cards because the user-visible body already contains fences.
  const payload = text;
  const args = [
    "message", "send",
    "--channel", notifyChannel,
    "--target", target,
    "--message", payload,
  ];
  if (notifyAccount) args.push("--account", notifyAccount);
  try {
    await execFile("openclaw", args, { maxBuffer: 8 * 1024 * 1024 });
  } catch (err) {
    log("push failed:", err.stderr?.toString?.() || err.message);
  }
}

// -- bootstrap ---------------------------------------------------------------
// Stand up the HTTP listener FIRST — claude's MCP client connects within a
// second of REPL spawn, so binding port 7779 before claude starts is the
// only way to avoid "1 MCP server failed". cmdLaunch spawns this watcher
// before launchWorker for the same reason; here we make sure we don't
// regress that by sleeping on state.workerSessionId before binding.
//
// Defaults to :7779 on localhost; override via AUTO_CLAUDE_CODE_HOOK_PORT.
const hookServer = startHookServer({
  hooks: {
    // Stop hook: claude finished a turn. If force mode is on and we
    // haven't hit max-continues, queue a force-continue prompt for the
    // next UserPromptSubmit and tell claude to NOT exit.
    onStop: async (payload) => {
      if (!FORCE_MODE) return {};
      // Cap on auto-continues — same circuit breaker as the existing
      // tmux-based path. Read fresh from state because launchWorker may
      // have reset autoContinueCount on a new task.
      const fresh = loadState(stateDir);
      const count = fresh.autoContinueCount || 0;
      if (count >= MAX_CONTINUES) {
        log(`[stop hook] hit max-continues (${count}); allowing exit`);
        return {};
      }
      // Build the same continue prompt we'd otherwise paste via tmux.
      const prompt = buildContinuePrompt({
        purpose: fresh.workerTask || "task",
        priorTrigger: "Stop hook detected end_turn",
      });
      queueForceContinue(prompt);
      saveState(stateDir, { autoContinueCount: count + 1 });
      log(`[stop hook] queued force-continue (count ${count + 1}/${MAX_CONTINUES})`);
      return { decision: "block", reason: "auto-continue queued by force mode" };
    },
    // Push a question (from acc_ask_user MCP tool) into the user's chat.
    // In force mode, also fire a sub-agent to auto-answer in parallel —
    // whichever returns first (chat reply or sub-agent) wins via
    // deliverAnswer's first-resolver-wins semantics.
    pushQuestion: async ({ id, questions }) => {
      const lines = [
        `🗂 Claude is asking ${questions.length} question${questions.length > 1 ? "s" : ""} (#${id.slice(0, 8)}):`,
        "",
      ];
      questions.forEach((q, i) => {
        lines.push(`**${i + 1}. ${q.header || q.question}**`);
        if (q.header && q.header !== q.question) lines.push(`> ${q.question}`);
        if (q.multiSelect) lines.push("_(multi-select; comma-separate digits)_");
        (q.options || []).forEach((opt, j) => {
          const desc = opt.description ? ` — ${opt.description}` : "";
          lines.push(`  ${j + 1}. **${opt.label}**${desc}`);
        });
        lines.push("");
      });
      lines.push(
        "Reply: `/acc 1, 2, 3` (one digit per question, in order). " +
        "For multi-select, use space inside a slot e.g. `/acc 1, \"1 3\", 2`. " +
        "For free text, use quotes: `/acc 1, \"my-repo\", 3`."
      );
      if (FORCE_MODE) {
        lines.push("", "⚙️ Force mode: a sub-agent will auto-answer if you don't reply first.");
      }
      await pushToChannel(lines.join("\n"));

      if (FORCE_MODE) {
        const fresh = loadState(stateDir);
        autoAnswerInForceMode({ task: fresh.workerTask || "", questions })
          .then(async (answer) => {
            const delivered = deliverAnswer(answer);
            if (delivered) {
              log(`[auto-answer] resolved acc_ask_user #${id.slice(0, 8)}: ${oneLine(answer)}`);
              await pushToChannel(`🤖 auto-answered #${id.slice(0, 8)}: \`${oneLine(answer)}\``);
            } else {
              log(`[auto-answer] late for #${id.slice(0, 8)} — user already answered`);
            }
          })
          .catch((err) => {
            log(`[auto-answer] failed for #${id.slice(0, 8)}:`, err?.stderr?.toString?.() || err?.message || err);
          });
      }
    },
  },
});
log(`[hooks] HTTP listener up on http://127.0.0.1:${hookServer._listenedPort}`);

// Now wait for cmdLaunch to write workerSessionId. cmdLaunch spawns the
// watcher BEFORE launchWorker so claude finds MCP listening, which means
// state lags us by however long it takes claude to start (typically <1s).
const STATE_WAIT_MS = envNum("AUTO_CLAUDE_CODE_WATCHER_STATE_WAIT_MS", 15_000);
const stateDeadline = Date.now() + STATE_WAIT_MS;
let state = loadState(stateDir);
while (!state.workerSessionId && Date.now() < stateDeadline) {
  await sleep(200);
  state = loadState(stateDir);
}
if (!state.workerSessionId) {
  log(`no active worker after ${STATE_WAIT_MS}ms; exiting`);
  process.exit(0);
}
// Don't start a second watcher if one is already alive. Two watchers on the
// same tmux would both trigger Stop hooks and queue duplicate force-continues.
if (state.watcherPid && state.watcherPid !== process.pid) {
  try {
    process.kill(state.watcherPid, 0); // probe, doesn't signal
    log(`another watcher (pid ${state.watcherPid}) already active — exiting`);
    process.exit(0);
  } catch (err) {
    if (err?.code !== "ESRCH") {
      log(`watcher-pid probe error: ${err?.message || err}; continuing anyway`);
    }
  }
}
saveState(stateDir, { watcherPid: process.pid, watcherStartedAt: new Date().toISOString() });

// Wait for the jsonl to appear — claude needs a few seconds to spin up the
// REPL after `tmux send-keys claude ...`. Give it generous time before bailing.
let jsonlPath = state.workerSessionJsonl
  || locateSessionJsonl(state.workerCwd, state.workerSessionId);

// Force-continue bookkeeping (only live if FORCE_MODE). Initialized from
// state so a watcher restart resumes mid-count instead of starting fresh.
let autoContinueCount = state.autoContinueCount || 0;
let toolUseSinceLastPoke = false;
// Offset at which we last fired a force-continue. Polls while offset <= this
// don't re-evaluate — the jsonl hasn't moved past our last poke, so the same
// end_turn event is still "trailing" and would cause a redundant poke.
let lastPokedAtOffset = -1;
// Track whether we've already pushed a completion report for the current
// DONE/BLOCKED so we don't re-spam on every poll. Resets when a user event
// lands — a fresh user turn starts a new exchange that could end in its
// own completion.
let completionReported = false;
const APPEAR_TIMEOUT_MS = envNum("AUTO_CLAUDE_CODE_WATCHER_APPEAR_MS", 60_000);
const appearDeadline = Date.now() + APPEAR_TIMEOUT_MS;
while (!jsonlPath || !existsSync(jsonlPath)) {
  if (Date.now() >= appearDeadline) {
    log(`jsonl never appeared after ${APPEAR_TIMEOUT_MS}ms; exiting`);
    process.exit(0);
  }
  await sleep(1000);
  jsonlPath = state.workerSessionJsonl
    || locateSessionJsonl(state.workerCwd, state.workerSessionId);
}
log(`jsonl ready: ${jsonlPath}`);

// Start at offset 0 by default so first-run output isn't lost. Recovery /
// supersede flows that re-arm a watcher against an already-large jsonl can
// set AUTO_CLAUDE_CODE_WATCHER_START_OFFSET=eof to skip the historical
// replay (otherwise users get a flood of every prior tool call). A numeric
// value also works for resuming from a known offset.
const startEnv = process.env.AUTO_CLAUDE_CODE_WATCHER_START_OFFSET;
let offset = 0;
if (startEnv === "eof") {
  try { offset = statSync(jsonlPath).size; }
  catch (err) { log("start-offset eof stat failed; defaulting to 0:", err?.message || err); }
} else if (startEnv && /^\d+$/.test(startEnv)) {
  offset = Number(startEnv);
}

let shuttingDown = false;
const pending = [];
let flushTimer = null;
let tickCount = 0;

// Many chat channels (feishu/telegram) truncate or reject messages longer
// than a few thousand characters. Cap each outbound push and split if larger.
const MSG_CHAR_LIMIT = envNum("AUTO_CLAUDE_CODE_WATCHER_MSG_LIMIT", 3500);
const FLUSH_SIZE_LIMIT = envNum("AUTO_CLAUDE_CODE_WATCHER_FLUSH_SIZE", 2800);

function scheduleFlush() {
  if (flushTimer || shuttingDown) return;
  flushTimer = setTimeout(flushPending, BATCH_MS);
}

function currentPendingBytes() {
  let n = 0;
  for (const l of pending) n += l.length + 2; // plus "\n\n" separator
  return n;
}

async function flushPending() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (!pending.length) return;
  // Join all events then split into chat-safe chunks, preferring paragraph
  // boundaries over hard char cuts so messages don't break mid-word.
  const combined = pending.splice(0, pending.length).join("\n\n");
  const chunks = splitForChat(combined, MSG_CHAR_LIMIT);
  for (let i = 0; i < chunks.length; i++) {
    const suffix = chunks.length > 1 ? `\n— ${i + 1}/${chunks.length} —` : "";
    await pushToChannel(chunks[i] + suffix);
  }
}

// Split `text` into pieces each <= `limit` chars, walking down a fallback
// ladder: paragraph breaks → single newlines → sentence ends → hard cut.
// Each tier only fires if the previous left chunks still over-limit.
const SPLIT_TIERS = [
  { sep: /\n{2,}/, join: "\n\n" },
  { sep: /\n/, join: "\n" },
  { sep: /(?<=[.!?。！？])\s+/, join: " " },
];

function splitForChat(text, limit) {
  if (text.length <= limit) return [text];
  return splitWithTiers(text, limit, 0);
}

function splitWithTiers(text, limit, tierIdx) {
  if (text.length <= limit) return [text];
  if (tierIdx >= SPLIT_TIERS.length) return splitHard(text, limit);
  const { sep, join } = SPLIT_TIERS[tierIdx];
  const parts = text.split(sep);
  const out = [];
  let buf = "";
  const flush = () => { if (buf.length) { out.push(buf); buf = ""; } };
  for (const p of parts) {
    if (p.length > limit) {
      flush();
      for (const sub of splitWithTiers(p, limit, tierIdx + 1)) out.push(sub);
      continue;
    }
    const j = buf ? join : "";
    if (buf.length + j.length + p.length <= limit) buf += j + p;
    else { flush(); buf = p; }
  }
  flush();
  return out;
}

function splitHard(text, limit) {
  const out = [];
  for (let i = 0; i < text.length; i += limit) out.push(text.slice(i, i + limit));
  return out;
}

async function shutdown(finalMsg, retireReason) {
  if (shuttingDown) return;
  shuttingDown = true;
  try { await flushPending(); } catch {}
  if (finalMsg) { try { await pushToChannel(finalMsg); } catch {} }
  try {
    if (retireReason) {
      appendNudge(stateDir, {
        ts: new Date().toISOString(),
        branch: "WATCHER",
        ok: true,
        reason: `watcher exit: ${retireReason}`,
      });
      retireWorker(stateDir, {
        lastSessionId: state.workerSessionId,
        lastCwd: state.workerCwd,
        lastTask: state.workerTask,
        lastRetiredAt: new Date().toISOString(),
        lastRetireReason: String(retireReason),
      });
    } else {
      saveState(stateDir, { watcherPid: null, watcherStartedAt: null });
    }
  } catch (err) { log("shutdown state error:", err?.message || err); }
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("⚰️ watcher stopped (SIGTERM)", null));
process.on("SIGINT",  () => shutdown("⚰️ watcher interrupted",     null));

async function loop() {
  log(`armed tmux=${state.workerTmuxName} jsonl=${jsonlPath} offset=${offset}`);
  while (!shuttingDown) {
    let chunk = { events: [], newOffset: offset };
    try { chunk = readDelta(jsonlPath, offset); }
    catch (err) { log("readDelta error:", err?.message || err); }
    offset = chunk.newOffset;

    if (chunk.events.length) {
      for (const ev of chunk.events) {
        const line = formatEvent(ev);
        if (line) pending.push(line);
      }
      if (pending.length) {
        // If the batched body would already exceed the per-message cap, flush
        // right away instead of waiting for the BATCH_MS timer. This keeps
        // single messages under feishu/telegram's size ceiling.
        if (currentPendingBytes() >= FLUSH_SIZE_LIMIT) {
          await flushPending();
        } else {
          scheduleFlush();
        }
      }
      // Reset dedupe if the user sent a new message/tool_result in this
      // chunk — that starts a new exchange, so a subsequent DONE means a
      // new completion worth reporting.
      if (chunk.events.some((e) => e?.type === "user")) completionReported = false;

      const mark = scanStopMarker(chunk.events);
      if (mark && !completionReported) {
        // Push a proper completion report (not just the terse marker line)
        // and remove the cron so it stops spamming "no worker tracked"
        // summaries. Crucially, we do NOT retireWorker or exit here: Claude
        // REPL is still alive in tmux and the user may keep chatting, so
        // state tracking + watcher stay on. Only DEAD tmux triggers retire.
        await flushPending();
        const report = await buildCompletionReport(mark, { state, jsonlPath });
        await pushToChannel(report);
        try { await removeCronJob(); }
        catch (err) { log("cron removal after DONE failed:", err?.message || err); }
        appendNudge(stateDir, {
          ts: new Date().toISOString(),
          branch: "COMPLETED",
          ok: true,
          reason: `completion reported: ${mark.marker}`,
        });
        completionReported = true;
      }

      // Force-continue: if armed, the moment the latest event is an assistant
      // end_turn / stop_sequence (and we haven't already poked for this same
      // stop), fire the continue prompt. This is what replaces the tick's old
      // cron-driven wake-up — no more minutes-long AWAITING windows.
      // Skip entirely when claude has just raised a DONE/BLOCKED marker —
      // the user said the task is finished; don't keep prodding.
      if (FORCE_MODE && !mark && !completionReported) {
        const { awaitingReason, hadToolUse } = analyzeChunk(chunk.events);
        if (hadToolUse) toolUseSinceLastPoke = true;
        const freshEndTurn = awaitingReason && offset > lastPokedAtOffset;
        if (freshEndTurn) {
          const nextCount = toolUseSinceLastPoke ? 1 : autoContinueCount + 1;
          if (nextCount > MAX_CONTINUES) {
            const reason = `${nextCount - 1} auto-continues without progress — circuit-breaker`;
            await flushPending();
            await pushToChannel(`🛑 ${reason}; watcher retiring worker`);
            await shutdown(null, reason);
            return;
          }
          const prompt = buildContinuePrompt({
            currentTask: null,
            todos: [],
            consecutiveContinues: nextCount - 1,
          });
          const r = await pokeTmuxWorker({ tmuxName: state.workerTmuxName, prompt });
          appendNudge(stateDir, {
            ts: new Date().toISOString(),
            branch: "AWAITING",
            ok: !!r?.ok,
            reason: r?.ok
              ? `force-continue #${nextCount} (watcher)`
              : `force-continue failed [${r?.kind}]: ${r?.error ?? ""}`,
          });
          if (r?.ok) {
            lastPokedAtOffset = offset;
            autoContinueCount = nextCount;
            toolUseSinceLastPoke = false;
            saveState(stateDir, { autoContinueCount });
          } else if (r?.kind === "no-session") {
            const reason = `tmux session '${state.workerTmuxName}' gone during force-continue`;
            await flushPending();
            await pushToChannel(`⚰️ ${reason}; watcher exiting`);
            await shutdown(null, reason);
            return;
          }
        }
      }
    }

    tickCount++;
    if (tickCount % LIVENESS_EVERY_POLLS === 0) {
      const alive = await tmuxHasSession(state.workerTmuxName).catch(() => false);
      if (!alive) {
        const reason = retireReasonFor({ tmuxAlive: false });
        await flushPending();
        await pushToChannel(`⚰️ ${reason}; watcher exiting`);
        await shutdown(null, reason);
        return;
      }
    }
    await sleep(POLL_MS);
  }
}

loop().catch(async (err) => {
  log("watcher loop crashed:", err?.message || err);
  await shutdown(`❌ watcher crashed: ${err?.message || err}`, null);
});
