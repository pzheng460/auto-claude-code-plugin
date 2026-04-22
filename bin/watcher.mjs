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
  capturePane,
  sendLiteral,
  sendEnter,
  sendKey,
} from "../src/tmux.js";
import { retireReasonFor } from "../src/tick/plan.js";
import { buildContinuePrompt, pokeTmuxWorker } from "../src/poke.js";
import { removeCronJob } from "../src/cron.js";
import { envNum, envBool } from "../src/env.js";
import { sleep, oneLine } from "../src/util.js";
import { formatAssistantText } from "../src/watcher-format.js";
import { detectMultiStepForm, extractModalBlock } from "../src/tui.js";

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

// Detect the "sensitive file" permission modal Claude Code shows when a
// tool tries to edit paths under ~/.claude — even with
// --dangerously-skip-permissions. Signature: a "Do you want to …?"
// question + "2. Yes, and …" option + "3. No" option. Narrow enough to
// not misfire on ordinary output.
function detectSensitivePrompt(paneText) {
  if (!paneText) return false;
  if (!/Do you want to/.test(paneText)) return false;
  if (!/^\s*2\.\s*Yes,\s*and\b/m.test(paneText)) return false;
  if (!/^\s*3\.\s*No\b/m.test(paneText)) return false;
  return true;
}

// Broader detector: any Claude Code modal with a question + at least two
// numbered options at the tail of the pane. Covers plan-approval prompts,
// MCP trust dialogs, custom tool confirmations, etc. The user can answer
// these by replying `/acc <digit>` — cmdSend routes it via tmux paste and
// the TUI picks that option.
function detectGenericModal(paneText) {
  if (!paneText) return false;
  // ❯ 1. <...> plus a 2. <...> line in the tail is a strong signature.
  if (!/^\s*❯?\s*1\.\s+\S/m.test(paneText)) return false;
  if (!/^\s*2\.\s+\S/m.test(paneText)) return false;
  return true;
}

// detectMultiStepForm + extractModalBlock moved to src/tui.js so cmdForm
// can share the same parsing (for auto-advance detection).

async function pressModalChoice(tmuxName, digit) {
  // Literal digit keypress, short pause, then Enter — same sequence a user
  // would produce from `tmux attach`.
  await sendLiteral(tmuxName, String(digit));
  await sleep(200);
  await sendEnter(tmuxName);
}

// Ask openclaw's default agent (`openclaw agent --agent main --json`) a one-shot
// question. Returns the raw text the agent replied with, or null on failure.
// Used by force-mode form auto-fill to pick answers for each tab.
async function askAgentOnce(prompt, { timeoutMs = 60000 } = {}) {
  try {
    const { stdout } = await execFile(
      "openclaw",
      ["agent", "--json", "--agent", "main", "--message", prompt],
      { encoding: "utf8", maxBuffer: 2 * 1024 * 1024, timeout: timeoutMs },
    );
    const parsed = JSON.parse(stdout);
    const text = parsed?.result?.payloads?.[0]?.text;
    return typeof text === "string" ? text.trim() : null;
  } catch (err) {
    log("askAgentOnce error:", err?.message || err);
    return null;
  }
}

// Interpret LLM reply as one of: { kind: "digit", value } | { kind: "text", value }
// | { kind: "skip" }. Defensive against common LLM output noise (quotes,
// code fences, "Option 1:" prefixes, trailing punctuation).
function parseAgentAnswer(raw) {
  if (!raw) return { kind: "skip" };
  let s = String(raw).trim();
  // strip code fences
  s = s.replace(/^```[a-z]*\s*/i, "").replace(/\s*```\s*$/i, "").trim();
  // strip quotes
  s = s.replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").trim();
  // If starts with a digit, treat as numeric choice (tolerate "1.", "1)", "1,").
  const m = s.match(/^(\d{1,2})(?=\D|$)/);
  if (m) return { kind: "digit", value: m[1] };
  if (/^skip$/i.test(s)) return { kind: "skip" };
  // Text input. Cap length so runaway LLM responses can't clobber the TUI.
  return { kind: "text", value: s.slice(0, 80) };
}

// Drive a multi-step form end-to-end with a single-shot LLM call:
//   Phase 1: walk Right through all tabs, capturing each tab's body
//   Phase 2: walk Left back to tab 0
//   Phase 3: ask LLM once with recent jsonl context + every tab's question
//            to return a CSV answer per tab
//   Phase 4: apply answers sequentially (paste + Right; Enter on Submit)
// Walking first means LLM sees every tab's actual options (not just labels)
// and can pick consistent answers across tabs; jsonl context lets it infer
// user preferences from the ongoing conversation.
// Walk through every tab of a multi-step form with Right arrows, capturing
// each tab's rendered body from capture-pane, then navigate back to tab 0
// with Left arrows. Returns an array of { idx, label, body }. Used by both
// force-mode auto-fill (to feed the LLM all tab content at once) and
// non-force-mode surfacing (to show the user every question up front so
// they can answer with a single /acc form CSV).
async function collectFormTabs(tmuxName, tabs) {
  log(`[form] walk ${tabs.length} tabs: ${tabs.map((t) => t.label).join(" / ")}`);
  const captured = [];
  for (let i = 0; i < tabs.length; i++) {
    await sleep(500);
    const pane = await capturePane(tmuxName, { lines: 40 }).catch(() => "");
    const body = extractModalBlock(pane) || "";
    log(`[form] tab ${i + 1}/${tabs.length} "${tabs[i].label}" captured ${body.length} chars`);
    captured.push({ idx: i, label: tabs[i].label, body });
    if (i < tabs.length - 1) {
      await sendKey(tmuxName, "Right");
    }
  }
  log(`[form] walk done, sending ${tabs.length - 1}× Left to return to tab 0`);
  for (let i = 0; i < tabs.length - 1; i++) {
    await sendKey(tmuxName, "Left");
    await sleep(150);
  }
  await sleep(400);
  // Safety: if the form disappeared during the walk (Claude Code's TUI
  // sometimes interprets stray arrow input as cancel), bail out early
  // before we send more keystrokes into an unknown state.
  const probe = await capturePane(tmuxName, { lines: 40 }).catch(() => "");
  if (!detectMultiStepForm(probe)) {
    throw new Error("form vanished during walk (TUI may have treated Right/Left as cancel)");
  }
  return captured;
}

async function autoFillForm(tmuxName, formInfo, workerTask, jsonlPath) {
  const tabs = formInfo.tabs;
  if (tabs.length === 0) return ["(empty form)"];

  // Phase 1+2 — walk all tabs + capture each body + return to tab 0.
  const captured = await collectFormTabs(tmuxName, tabs);

  // Phase 3 — build batch prompt with full jsonl context.
  const recent = jsonlPath
    ? summarizeRecentOutput(jsonlPath, { maxEvents: 18, textCharLimit: 260 })
    : { lines: [] };
  const recentLines = (recent?.lines || []).slice(-18);
  const prompt = [
    "You are auto-filling a multi-tab TUI form on behalf of a Claude Code worker.",
    "",
    `Worker's original task: "${workerTask || "(unknown)"}"`,
    "",
    "Recent session activity (most recent last) — use it to infer user's preferences:",
    "```",
    recentLines.length ? recentLines.join("\n") : "(no recent activity)",
    "```",
    "",
    `The form has ${tabs.length} tabs. Here's each tab's rendered body:`,
    "",
    ...captured.map((c) => `=== Tab ${c.idx + 1}: ${c.label} ===\n${c.body || "(no body captured — likely a Submit/confirm button)"}\n`),
    "",
    `Respond with a CSV of exactly ${tabs.length} items, one per tab IN ORDER.`,
    "Each item must be one of:",
    "  • a digit 1-9  — pick that numbered option",
    "  • short text (<=60 chars, no quotes) — type as-is into a text-input tab",
    "  • skip         — leave at default, advance",
    "  • submit       — for the final Submit tab (presses Enter)",
    "",
    "Example (5-tab repo-setup form):",
    "  2, MIT, auto-claude-code plugin, cli claude-code agent, submit",
    "",
    "Output ONLY the CSV line. No preamble, no markdown, no explanation.",
  ].join("\n");

  log(`[form] prompt built (${prompt.length} chars), calling LLM`);
  const raw = (await askAgentOnce(prompt, { timeoutMs: 90000 })) || "";
  log(`[form] LLM raw: ${raw.replace(/\n/g, "⏎").slice(0, 300)}`);
  const answers = parseBatchCsv(raw, tabs.length);
  if (!answers || answers.length === 0) {
    throw new Error(`LLM returned unparseable CSV: ${raw.slice(0, 200)}`);
  }
  log(`[form] parsed answers: ${JSON.stringify(answers)}`);

  // Phase 4 — apply. After each numeric keypress, we re-capture the pane
  // to see if Claude's TUI auto-advanced on its own (many numbered-option
  // TUIs do select+advance on a digit press). Only send Right when we're
  // still on the current tab — otherwise we'd skip the next tab entirely.
  const steps = [];
  let currentTabIdx = 0;
  for (let i = 0; i < tabs.length; i++) {
    const tab = tabs[i];
    const a = (answers[i] ?? "").trim();
    const isLast = i === tabs.length - 1;
    const wantsSubmit = /^submit$/i.test(a) || (isLast && /submit|confirm|done|finish/i.test(tab.label));
    log(`[form] applying tab ${i + 1}/${tabs.length} "${tab.label}" ← "${a}" (wantsSubmit=${wantsSubmit})`);
    if (wantsSubmit) {
      await sendEnter(tmuxName);
      steps.push(`${tab.label} → Enter`);
      break;
    }
    if (!a || /^skip$/i.test(a)) {
      steps.push(`${tab.label} → skip`);
    } else if (/^\d{1,2}$/.test(a)) {
      await sendLiteral(tmuxName, a);
      steps.push(`${tab.label} → ${a}`);
    } else {
      const text = a.replace(/^["']|["']$/g, "");
      await sendLiteral(tmuxName, text);
      steps.push(`${tab.label} → "${text}"`);
    }
    await sleep(400);
    if (isLast) {
      // End of sequence without explicit submit. Press Enter to confirm —
      // safe no-op if claude already auto-submitted on the last digit,
      // and triggers Submit otherwise.
      await sendEnter(tmuxName);
      steps.push("auto-Enter");
      break;
    }
    // Inspect pane: did the keypress auto-advance? If the current tab
    // body still looks like this tab's captured body, we're still here
    // and need to send Right. If the body already matches the NEXT
    // tab's captured body, the TUI advanced on its own — skip Right.
    const postPane = await capturePane(tmuxName, { lines: 40 }).catch(() => "");
    const postBody = extractModalBlock(postPane) || "";
    const advanced = postBody && captured[i + 1]?.body &&
      postBody.slice(0, 60) === captured[i + 1].body.slice(0, 60);
    log(`[form] post-apply pane: ${postBody.slice(0, 60).replace(/\n/g, "⏎")} (advanced=${advanced})`);
    if (!advanced) {
      await sendKey(tmuxName, "Right");
      await sleep(600);
    }
  }
  return steps;
}

// Parse an LLM CSV reply tolerantly: strips code fences, picks the first
// line with commas, honors double-quoted tokens with commas inside, pads
// with "skip" if short, truncates if long. Returns an array of length
// `expected`.
function parseBatchCsv(raw, expected) {
  if (!raw) return null;
  let s = String(raw).trim();
  s = s.replace(/^```[a-z]*\s*/i, "").replace(/\s*```\s*$/i, "").trim();
  const lines = s.split(/\n/).map((l) => l.trim()).filter(Boolean);
  const picked = lines.find((l) => l.includes(",")) || lines[0] || "";
  const out = [];
  let buf = "";
  let inQ = false;
  for (const c of picked) {
    if (inQ) {
      if (c === '"') inQ = false;
      else buf += c;
      continue;
    }
    if (c === '"') { inQ = true; continue; }
    if (c === ",") { out.push(buf.trim()); buf = ""; continue; }
    buf += c;
  }
  if (buf.trim()) out.push(buf.trim());
  while (out.length < expected) out.push("skip");
  return out.slice(0, expected);
}

// Old per-tab driver kept around (unused) in case we want to A/B it later.
async function autoFillForm_OLD_PER_TAB(tmuxName, formInfo, workerTask) {
  const steps = [];
  const tabs = formInfo.tabs;
  for (let i = 0; i < tabs.length; i++) {
    const tab = tabs[i];
    const isLast = i === tabs.length - 1;
    const looksLikeSubmit = /submit|confirm|done|finish/i.test(tab.label);
    if (isLast && looksLikeSubmit) {
      await sendEnter(tmuxName);
      steps.push(`${tab.label} → Enter (submit)`);
      break;
    }
    const pane = await capturePane(tmuxName, { lines: 40 }).catch(() => "");
    const question = extractModalBlock(pane) || "(no modal body)";
    const prompt = [
      "You are answering a multi-step form question that a Claude Code worker is currently stuck on.",
      "",
      `Worker's task: "${workerTask || "(unknown)"}"`,
      `Form tabs (in order): ${tabs_summary(tabs)}`,
      `Currently on tab: "${tab.label}"`,
      "",
      "Question and options for this tab (captured from the TUI):",
      "```",
      question,
      "```",
      "",
      "Respond with ONLY:",
      "  • a single digit 1-9 to pick that numbered option",
      "  • short text (<=60 chars, no quotes/markdown) for a text-input tab",
      "  • the word skip if the default is fine",
      "",
      "No explanation, no code fence, no preamble. Just the answer token.",
    ].join("\n");
    const reply = await askAgentOnce(prompt);
    const answer = parseAgentAnswer(reply);
    if (answer.kind === "skip") {
      steps.push(`${tab.label} → skip`);
    } else if (answer.kind === "digit") {
      await sendLiteral(tmuxName, answer.value);
      steps.push(`${tab.label} → ${answer.value}`);
    } else {
      await sendLiteral(tmuxName, answer.value);
      steps.push(`${tab.label} → "${answer.value}"`);
    }
    await sleep(300);
    await sendKey(tmuxName, "Right");
    await sleep(700); // let the tab-switch animation / re-render settle
  }
  return steps;
}

function tabs_summary(tabs) {
  return tabs.map((t, i) => `${i + 1}.${t.label}${t.done ? "✔" : ""}`).join(", ");
}

// extractModalBlock lives in src/tui.js (imported above).

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
const state = loadState(stateDir);
if (!state.workerSessionId) {
  log("no active worker; exiting");
  process.exit(0);
}
// Don't start a second watcher if one is already alive. Two watchers on the
// same tmux would both send arrow keys and type answers, which can look
// like cancel to Claude Code's TUI and completely derail a form.
if (state.watcherPid && state.watcherPid !== process.pid) {
  try {
    process.kill(state.watcherPid, 0); // probe, doesn't signal
    log(`another watcher (pid ${state.watcherPid}) already active — exiting`);
    process.exit(0);
  } catch (err) {
    // ESRCH = the recorded pid is dead; safe to claim the slot
    if (err?.code !== "ESRCH") {
      log(`watcher-pid probe error: ${err?.message || err}; continuing anyway`);
    }
  }
}
// Claim the slot early so a concurrent launch sees us.
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
// Debounce so a single modal doesn't get answered repeatedly while Claude
// is still tearing down the prompt after our first keypress.
let lastAutoAnswerAt = 0;
// Track whether we've already pushed a completion report for the current
// DONE/BLOCKED so we don't re-spam on every poll. Resets when a user event
// lands — a fresh user turn starts a new exchange that could end in its
// own completion.
let completionReported = false;
// Dedupe for modal push: remember the exact block we last surfaced so we
// don't repeatedly spam the same question while the user is thinking.
// Resets when jsonl grows (meaning claude processed a reply → new state).
let lastPushedModalBlock = null;
// Same dedupe for multi-step form push. Stores the last tab-bar + current-
// question text we surfaced, so a 2s poll loop doesn't re-announce the
// same form every tick. Cleared on jsonl movement (user gave an answer).
let lastPushedFormBlock = null;
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

    // Modal surfacing: Claude Code pops up prompts (permission, plan
    // approval, MCP trust, tool confirms, …) that never land in jsonl.
    // capture-pane is the only way to see them. Policy:
    //   • Always surface the modal text to notify so the user sees exactly
    //     what's being asked and the available options.
    //   • For the specific "sensitive-file" pattern in force mode, also
    //     auto-press 2 (yes + session-allow) so force workers don't stall
    //     on writes under ~/.claude/.
    //   • For every other modal, don't answer — tell the user to reply
    //     /acc <digit>, which routes through cmdSend → tmux paste.
    // Dedupe by exact block content; reset whenever jsonl advances (claude
    // processed a reply, so a fresh modal is worth re-surfacing).
    if (chunk.events.length > 0) { lastPushedModalBlock = null; lastPushedFormBlock = null; }
    try {
      const pane = await capturePane(state.workerTmuxName, { lines: 40 }).catch(() => "");
      const form = pane ? detectMultiStepForm(pane) : null;
      const isSensitive = !form && pane && detectSensitivePrompt(pane);
      const isGeneric = !form && pane && !isSensitive && detectGenericModal(pane);
      if (form) {
        const tabsLine = form.tabs
          .map((t, i) => `${t.done ? "✔" : "☐"} ${i + 1}. ${t.label}`)
          .join("  ·  ");
        const currentBlock = extractModalBlock(pane) || "(current tab body not extractable)";
        const formSignature = `${tabsLine}\n${currentBlock}`;
        if (formSignature !== lastPushedFormBlock) {
          lastPushedFormBlock = formSignature;
          if (FORCE_MODE) {
            // Force-mode: auto-fill each tab via LLM. Notify up front (so
            // the user sees something is happening during the minute or so
            // the form takes to drive) and at the end with final results.
            await pushToChannel(
              `🤖 force mode — auto-filling ${form.tabs.length}-tab form via LLM...\n\n**Tabs:** ${tabsLine}`,
            );
            appendNudge(stateDir, {
              ts: new Date().toISOString(),
              branch: "AWAITING",
              ok: true,
              reason: `force-mode form auto-fill started (${form.tabs.length} tabs)`,
            });
            try {
              const steps = await autoFillForm(state.workerTmuxName, form, state.workerTask || "", jsonlPath);
              await pushToChannel(
                `✅ form auto-filled:\n\`\`\`\n${steps.map((s) => "  · " + s).join("\n")}\n\`\`\``,
              );
              appendNudge(stateDir, {
                ts: new Date().toISOString(),
                branch: "AWAITING",
                ok: true,
                reason: `form auto-fill done (${steps.length} steps)`,
              });
            } catch (err) {
              await pushToChannel(
                `❌ form auto-fill errored: ${err?.message || err}\n\`tmux attach -t ${state.workerTmuxName}\` to finish manually.`,
              );
            }
            // reset so a following form is re-detected fresh
            lastPushedFormBlock = null;
          } else {
            appendNudge(stateDir, {
              ts: new Date().toISOString(),
              branch: "AWAITING",
              ok: true,
              reason: `multi-step form surfaced (${form.tabs.length} tabs)`,
            });
            // Walk all tabs to collect every question up front, then push
            // the complete picture so the user can compose a single CSV
            // reply. Same collection step as the force-mode autofill.
            let captured = [];
            try {
              captured = await collectFormTabs(state.workerTmuxName, form.tabs);
            } catch (err) {
              log("form walk failed:", err?.message || err);
            }
            // Guard: if more than half the bodies came back empty, the form
            // was probably in a transition state (UI hadn't fully rendered
            // or is already being dismissed). Push a compact placeholder
            // instead of 5 lines of "(no body captured)" noise.
            // Skip push when we captured nothing useful — either walk
            // threw (captured=[]) or most bodies came back empty (form
            // transient / glyph parse off / concurrent watcher walked
            // over us).
            const emptyBodies = captured.filter((c) => !c.body).length;
            const skipPush = captured.length === 0 || emptyBodies > captured.length / 2;
            if (skipPush) {
              log(`[form] useless capture (len=${captured.length}, empty=${emptyBodies}) — skipping push`);
              lastPushedFormBlock = null;
            }
            if (!skipPush) {
            const perTab = (captured.length
              ? captured
              : form.tabs.map((t, i) => ({ idx: i, label: t.label, body: "" }))
            )
              .map((c) => `### Tab ${c.idx + 1} · ${c.label}\n${c.body || "(no body captured)"}`)
              .join("\n\n");
            const msg = [
              `🗂 Claude is showing a ${form.tabs.length}-tab form — reply \`/acc form <csv>\` to fill it in one shot.`,
              "",
              `**Tab bar:** ${tabsLine}`,
              "",
              "**All tabs' questions/options (walked once so you can see everything):**",
              "",
              "```",
              perTab,
              "```",
              "",
              "**CSV protocol** — one item per tab, in order:",
              "  • digit `1` / `2` / … = pick that numbered option",
              "  • `\"quoted text\"` = paste text (for Type-something tabs)",
              "  • `skip` = leave tab's default, advance",
              "  • `submit` = optional — Enter is auto-pressed at the end anyway",
              "",
              "Example: `/acc 2, 1, \"cool project\", \"cli, tool\"` (Enter auto)",
            ].join("\n");
            await pushToChannel(msg);
            }  // close `if (!skipPush)`
          }
        }
      } else if (isSensitive || isGeneric) {
        const modalBlock = extractModalBlock(pane) || "(modal text unavailable)";
        if (modalBlock !== lastPushedModalBlock) {
          lastPushedModalBlock = modalBlock;
          const autoAnswer = isSensitive && FORCE_MODE && Date.now() - lastAutoAnswerAt > 3000;
          if (autoAnswer) {
            log("sensitive-file modal detected; pressing 2 (force mode)");
            await pressModalChoice(state.workerTmuxName, 2);
            lastAutoAnswerAt = Date.now();
            appendNudge(stateDir, {
              ts: new Date().toISOString(),
              branch: "AWAITING",
              ok: true,
              reason: "auto-approved sensitive-file prompt (choice 2)",
            });
          } else {
            appendNudge(stateDir, {
              ts: new Date().toISOString(),
              branch: "AWAITING",
              ok: true,
              reason: "modal surfaced to user (awaiting reply)",
            });
          }
          const header = autoAnswer
            ? "🔐 Claude asked a permission question (auto-answered with **2** since force mode is on):"
            : "🔐 Claude is asking — pick an option:";
          // Footer varies with modal type:
          //  - sensitive-file: 1/2/3 mean yes/yes+always/no (known semantics)
          //  - generic: we can't assume 1/2/3 meanings, just show how to reply
          const hint = autoAnswer
            ? "→ picked option 2 (yes + session-allow). Reply `/acc <digit>` to override if needed."
            : isSensitive
              ? "→ reply `/acc 1` (yes), `/acc 2` (yes+always), `/acc 3` (no)"
              : "→ reply `/acc <digit>` to pick that numbered option, or `/acc \"your text\"` to type into a text-input field.";
          await pushToChannel([header, "", "```", modalBlock, "```", "", hint].join("\n"));
        }
      }
    } catch (err) {
      log("modal-check error:", err?.message || err);
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
