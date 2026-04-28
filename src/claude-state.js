import {
  readFileSync,
  existsSync,
  readdirSync,
  openSync,
  closeSync,
  readSync,
  fstatSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { hasSession as tmuxHasSession } from "./tmux.js";

// Cap how many tail bytes we ever read from a jsonl. ~1 MiB easily covers
// the last few dozen Claude events even with sizeable tool outputs, and
// keeps tick cost flat as sessions grow into multi-MB jsonls.
const JSONL_TAIL_BYTES = 1024 * 1024;

const HOME = homedir();
const TODOS_DIR = `${HOME}/.claude/todos`;
// Claude Code 2.1 moved TodoWrite to a new TaskCreate tool that writes one
// file per task under ~/.claude/tasks/<sessionId>/<id>.json. The old todos
// directory still exists for sub-agents and backwards compat, so we read
// tasks first and only fall back to todos.
const TASKS_DIR = `${HOME}/.claude/tasks`;
const PROJECTS_DIR = `${HOME}/.claude/projects`;

function slugifyCwd(cwd) {
  // Observed Claude Code convention: "/home/alice/foo.bar" → "-home-alice-foo-bar".
  // One regex pass: leading slash run collapses to "-", then each /, ., _ also.
  return cwd.replace(/^\/+|[/._]/g, "-");
}

// First 256 KiB of any session jsonl is more than enough to find the first
// user message. Bigger sessions don't make us read more — title extraction
// stops at the first hit anyway.
const TITLE_SCAN_BYTES = 256 * 1024;

// Two kinds of "user" messages we want to skip when picking a title:
//  1. Claude Code's slash-command and system envelopes (`<command-name>` etc.)
//  2. auto-claude-code's own watchdog nudges (poke.js / cron.js outputs)
// Both look like user input in the jsonl but aren't the task the human typed.
const WRAPPER_PREFIXES = [
  "<command-name>",
  "<command-message>",
  "<local-command-stdout>",
  "<local-command-stderr>",
  "<local-command-caveat>",
  "<system-reminder>",
  "Caveat:",
  "auto-claude-code watchdog:",
  "auto-claude-code heartbeat",
];

// Substring patterns that mark watchdog heartbeats — these can appear after
// an emoji prefix, so prefix-matching alone misses them.
const WRAPPER_SUBSTRINGS = [
  "auto-claude-code heartbeat",
  "auto-claude-code watchdog:",
];

// Recent claude session jsonls under `cwd`, newest first, each enriched
// with a `title` extracted from the first prose user message. Used by
// `/acc resume` to render a numbered picker.
export function listRecentSessions(cwd, { limit = 10 } = {}) {
  if (!cwd) return [];
  const dir = join(PROJECTS_DIR, slugifyCwd(cwd));
  let names;
  try { names = readdirSync(dir); } catch { return []; }
  const items = [];
  for (const n of names) {
    if (!n.endsWith(".jsonl")) continue;
    const path = join(dir, n);
    let st;
    try { st = statSync(path); } catch { continue; }
    if (!st.isFile()) continue;
    items.push({
      sessionId: n.replace(/\.jsonl$/, ""),
      jsonlPath: path,
      mtimeMs: st.mtimeMs,
      sizeBytes: st.size,
    });
  }
  items.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const top = items.slice(0, limit);
  for (const s of top) s.title = readFirstUserMessage(s.jsonlPath);
  return top;
}

// Pull the first prose user message from a session jsonl — the original
// task text that started the session. Returns "" if nothing usable is
// found within the first `maxBytes`.
export function readFirstUserMessage(jsonlPath, maxBytes = TITLE_SCAN_BYTES) {
  if (!jsonlPath) return "";
  let fd;
  try { fd = openSync(jsonlPath, "r"); } catch { return ""; }
  try {
    const { size } = fstatSync(fd);
    const len = Math.min(size, maxBytes);
    if (len <= 0) return "";
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, 0);
    const lines = buf.toString("utf8").split("\n");
    // Drop a possibly truncated last line unless we read the whole file.
    if (len < size && lines.length) lines.pop();
    for (const line of lines) {
      if (!line) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev?.type !== "user" || ev.isSidechain) continue;
      const c = ev.message?.content;
      let body = "";
      if (typeof c === "string") body = c;
      else if (Array.isArray(c)) {
        for (const block of c) {
          if (block?.type === "text" && typeof block.text === "string") {
            body = block.text;
            break;
          }
        }
      }
      body = body.trim();
      if (!body) continue;
      if (WRAPPER_PREFIXES.some((p) => body.startsWith(p))) continue;
      // First non-whitespace ~80 chars: watchdog headers usually fit there.
      const head = body.slice(0, 100);
      if (WRAPPER_SUBSTRINGS.some((s) => head.includes(s))) continue;
      return body;
    }
    return "";
  } finally {
    try { closeSync(fd); } catch {}
  }
}

export function locateSessionJsonl(cwd, sessionId) {
  if (!cwd || !sessionId) return null;
  const direct = join(PROJECTS_DIR, slugifyCwd(cwd), `${sessionId}.jsonl`);
  if (existsSync(direct)) return direct;
  try {
    for (const proj of readdirSync(PROJECTS_DIR)) {
      const candidate = join(PROJECTS_DIR, proj, `${sessionId}.jsonl`);
      if (existsSync(candidate)) return candidate;
    }
  } catch {}
  return null;
}

export function findTodosFile(sessionId) {
  if (!sessionId) return null;
  const prefix = `${sessionId}-agent-`;
  try {
    // Early-exit scan — previous impl built a filtered array of ALL matches
    // before picking entries[0]. Users with hundreds of retired sessions in
    // ~/.claude/todos paid that scan on every tick.
    for (const e of readdirSync(TODOS_DIR)) {
      if (e.startsWith(prefix) && e.endsWith(".json")) return join(TODOS_DIR, e);
    }
    return null;
  } catch {
    return null;
  }
}

export function readTodos(sessionId) {
  const path = findTodosFile(sessionId);
  if (!path) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Claude Code 2.1's TaskCreate stores one file per task under
// ~/.claude/tasks/<sessionId>/<id>.json with shape:
//   { id, subject, description, activeForm, status, blocks, blockedBy }
// We normalise to { content, status, activeForm } so downstream consumers
// (inspectWorker, diff.js, render.js) that keyed on TodoWrite's old shape
// keep working unchanged. Sorted by numeric id so diff's index-based keying
// lands on the same task across ticks.
export function readTasks(sessionId) {
  if (!sessionId) return [];
  const dir = join(TASKS_DIR, sessionId);
  let entries;
  try { entries = readdirSync(dir); }
  catch { return []; }
  const tasks = [];
  for (const name of entries) {
    if (!name.endsWith(".json") || name.startsWith(".")) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(dir, name), "utf8"));
      if (!parsed || typeof parsed !== "object") continue;
      tasks.push({
        content: parsed.subject ?? parsed.description ?? "",
        status: parsed.status ?? "pending",
        activeForm: parsed.activeForm ?? "",
        id: parsed.id ?? name.replace(/\.json$/, ""),
      });
    } catch {}
  }
  tasks.sort((a, b) => {
    const na = Number(a.id);
    const nb = Number(b.id);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
    return String(a.id).localeCompare(String(b.id));
  });
  return tasks;
}

export async function inspectWorker({ workerSessionId, workerTmuxName, workerCwd, workerSessionJsonl }) {
  const tmuxAlive = await tmuxHasSession(workerTmuxName);
  // Claude Code 2.1 writes to ~/.claude/tasks/ via TaskCreate; older sessions
  // and sub-agents still use ~/.claude/todos/. Prefer tasks; fall back to
  // todos only when tasks/ is empty.
  const tasks = readTasks(workerSessionId);
  const todos = tasks.length ? tasks : readTodos(workerSessionId);
  const jsonlPath = workerSessionJsonl || locateSessionJsonl(workerCwd, workerSessionId);
  // One fstat covers both the jsonl-age calculation and cache validation for
  // the tail reader — previously we did a separate statSync(path) for mtime
  // and a fstatSync(fd) inside readJsonlTailEvents.
  const { events, mtimeMs } = readJsonlTailWithMeta(jsonlPath);
  const ageSec = mtimeMs ? Math.max(0, Math.floor((Date.now() - mtimeMs) / 1000)) : Infinity;
  let current = null;
  let completedCount = 0;
  let pendingCount = 0;
  for (const t of todos) {
    if (t?.status === "in_progress") { if (!current) current = t; }
    else if (t?.status === "completed") completedCount++;
    else if (t?.status === "pending") pendingCount++;
  }
  return {
    tmuxAlive,
    todos,
    currentTask: current,
    completedCount,
    pendingCount,
    totalCount: todos.length,
    jsonlPath,
    jsonlMtimeMs: mtimeMs,
    ageSec,
    awaitingUserReply: awaitingFromEvents(events),
  };
}

// Scan an already-parsed event list newest-first for a DONE/BLOCKED marker
// in the most recent assistant turn. Shared between the watcher (which has
// per-chunk events in hand) and detectStopMarker (which reads jsonl).
export function findStopMarkerInEvents(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev?.type !== "assistant") continue;
    const content = ev.message?.content;
    if (!Array.isArray(content)) return { marker: null, line: null };
    for (const block of content) {
      if (block?.type !== "text") continue;
      const text = String(block.text ?? "");
      for (const line of text.split(/\r?\n/)) {
        const m = line.match(/^\s*(DONE|BLOCKED)\s*:/i);
        if (m) return { marker: m[1].toUpperCase(), line: line.trim() };
      }
    }
    break; // only inspect the most recent assistant turn
  }
  return { marker: null, line: null };
}

// Scan the tail of a session jsonl for DONE/BLOCKED in the most recent
// assistant turn. Used by tick/plan to decide whether to retire the worker.
export function detectStopMarker(jsonlPath) {
  if (!jsonlPath) return { marker: null, line: null };
  return findStopMarkerInEvents(readJsonlTail(jsonlPath, 0));
}

export function isAwaitingUserReply(jsonlPath) {
  if (!jsonlPath) return false;
  return awaitingFromEvents(readJsonlTailEvents(jsonlPath));
}

// Walk the tail newest-first and report whether the session is waiting on
// the user: true iff the most recent assistant turn ended with end_turn /
// stop_sequence before any user turn appears. Factored out so inspectWorker
// can reuse an already-parsed events array instead of re-reading the tail.
function awaitingFromEvents(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev?.type === "assistant") {
      const reason = ev?.message?.stop_reason;
      return reason === "end_turn" || reason === "stop_sequence";
    }
    if (ev?.type === "user") return false;
  }
  return false;
}

export function readJsonlTail(jsonlPath, maxLines = 30) {
  const events = readJsonlTailEvents(jsonlPath);
  return maxLines && events.length > maxLines ? events.slice(-maxLines) : events;
}

// Process-level cache so the 3-4 tail readers per tick (inspectWorker,
// detectStopMarker, the nudge-tail, summarizeRecentOutput) share a single
// read+parse instead of each re-slurping the same 1 MiB. Keyed by path +
// maxBytes and invalidated by (size, mtimeMs) — jsonl is append-only, so
// either bumps whenever a new event lands. Bounded so a long-running
// watcher (or a pathological caller passing many paths) can't grow the map
// unbounded.
const TAIL_CACHE = new Map();
const TAIL_CACHE_MAX = 8;

function cacheTailEntry(key, entry) {
  TAIL_CACHE.delete(key); // re-insert to refresh insertion-order position
  TAIL_CACHE.set(key, entry);
  while (TAIL_CACHE.size > TAIL_CACHE_MAX) {
    TAIL_CACHE.delete(TAIL_CACHE.keys().next().value);
  }
}

// Read up to JSONL_TAIL_BYTES from the end of `path`, return the parsed
// events plus the file's mtime+size. Callers that only need events use the
// thin `readJsonlTailEvents` wrapper below. Hits TAIL_CACHE when the file
// hasn't changed since the last read — append-only jsonl means any new
// event bumps size AND mtime, so the (size, mtimeMs) tuple is a safe key.
function readJsonlTailWithMeta(path, maxBytes = JSONL_TAIL_BYTES) {
  if (!path) return { events: [], mtimeMs: null, size: 0 };
  let fd;
  try { fd = openSync(path, "r"); } catch { return { events: [], mtimeMs: null, size: 0 }; }
  try {
    const { size, mtimeMs } = fstatSync(fd);
    const key = `${path}|${maxBytes}`;
    const cached = TAIL_CACHE.get(key);
    if (cached && cached.size === size && cached.mtimeMs === mtimeMs) {
      return { events: cached.events, mtimeMs, size };
    }
    if (size === 0) {
      const empty = [];
      cacheTailEntry(key, { size, mtimeMs, events: empty });
      return { events: empty, mtimeMs, size };
    }
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, start);
    let lines = buf.toString("utf8").split("\n");
    if (start > 0 && lines.length > 0) lines.shift();
    const events = [];
    for (const l of lines) {
      if (!l) continue;
      try { events.push(JSON.parse(l)); } catch {}
    }
    cacheTailEntry(key, { size, mtimeMs, events });
    return { events, mtimeMs, size };
  } catch {
    return { events: [], mtimeMs: null, size: 0 };
  } finally {
    try { closeSync(fd); } catch {}
  }
}

function readJsonlTailEvents(path, maxBytes = JSONL_TAIL_BYTES) {
  return readJsonlTailWithMeta(path, maxBytes).events;
}

// Test-only escape hatch to clear the tail cache between unit tests. Not
// exported for production use — long-lived processes rely on mtime/size
// invalidation, which is sufficient for the append-only jsonl contract.
export function _resetTailCacheForTests() {
  TAIL_CACHE.clear();
}

function truncateText(s, n) {
  if (!s) return "";
  const t = String(s).replace(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

function formatToolUse(block) {
  const name = block?.name ?? "tool";
  const input = block?.input ?? {};
  let arg = "";
  if (input.file_path) arg = input.file_path;
  else if (input.path) arg = input.path;
  else if (input.pattern) arg = input.pattern;
  else if (input.command) arg = input.command;
  else if (input.description) arg = input.description;
  else if (input.url) arg = input.url;
  else if (input.query) arg = input.query;
  else if (typeof input === "string") arg = input;
  arg = truncateText(arg, 120);
  return arg ? `[tool] ${name}(${arg})` : `[tool] ${name}`;
}

function extractAssistantBlocks(ev) {
  const content = ev?.message?.content;
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const block of content) {
    if (block?.type === "text" && block.text) {
      out.push({ kind: "text", text: block.text });
    } else if (block?.type === "tool_use") {
      out.push({ kind: "tool_use", name: block.name, input: block.input });
    }
  }
  return out;
}

/**
 * Summarize recent Claude Code worker output since a given ISO timestamp.
 *
 * Reads assistant events from the session jsonl (skipping user, system, meta),
 * keeps only those strictly newer than `sinceTs`, caps at `maxEvents`, and
 * flattens into readable lines of `[claude] text...` and `[tool] Name(arg)`.
 * Returns `{ lines, lastTs }` where `lastTs` is the ISO timestamp of the most
 * recent event included, for stateful tailing on subsequent ticks.
 */
export function summarizeRecentOutput(jsonlPath, { sinceTs = null, maxEvents = 30, textCharLimit = 400 } = {}) {
  if (!jsonlPath) return { lines: [], lastTs: null };
  const events = readJsonlTailEvents(jsonlPath);
  if (!events.length) return { lines: [], lastTs: null };

  const sinceMs = sinceTs ? Date.parse(sinceTs) : 0;
  // Walk backward, keeping only the last `maxEvents` matching events. Previous
  // `events.filter(...).slice(-maxEvents)` allocated a filtered array of every
  // matching event even when maxEvents was tiny. For long sessions that's a
  // throwaway array of hundreds of events per tick.
  const relevant = [];
  for (let i = events.length - 1; i >= 0 && relevant.length < maxEvents; i--) {
    const ev = events[i];
    if (ev?.type !== "assistant") continue;
    const ts = ev?.timestamp ? Date.parse(ev.timestamp) : 0;
    if (!Number.isFinite(ts) || ts <= sinceMs) continue;
    relevant.push(ev);
  }
  relevant.reverse(); // restore chronological order for rendering

  const lines = [];
  for (const ev of relevant) {
    for (const block of extractAssistantBlocks(ev)) {
      if (block.kind === "text") {
        lines.push(`[claude] ${truncateText(block.text, textCharLimit)}`);
      } else if (block.kind === "tool_use") {
        lines.push(formatToolUse(block));
      }
    }
  }
  const lastTs = relevant.length ? (relevant[relevant.length - 1].timestamp ?? null) : null;
  return { lines, lastTs };
}
