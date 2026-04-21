import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  detectStopMarker,
  isAwaitingUserReply,
  summarizeRecentOutput,
  readJsonlTail,
  _resetTailCacheForTests,
} from "../src/claude-state.js";

function scratchJsonl(lines) {
  const dir = mkdtempSync(join(tmpdir(), "acc-claude-state-"));
  const path = join(dir, "session.jsonl");
  writeFileSync(path, lines.map((o) => JSON.stringify(o)).join("\n") + "\n", "utf8");
  return path;
}

// Push the jsonl's mtime forward — some filesystems (noatime, tmpfs, WSL2)
// quantize mtime to a whole second, so two appends inside the same JS tick
// can report the same mtimeMs and defeat the cache-invalidation check.
function bumpMtime(path) {
  const future = new Date(Date.now() + 5_000);
  utimesSync(path, future, future);
}

test.beforeEach(() => {
  _resetTailCacheForTests();
});

test("detectStopMarker finds DONE in the most recent assistant turn", () => {
  const path = scratchJsonl([
    { type: "user", message: { content: "start" } },
    {
      type: "assistant",
      message: {
        content: [{ type: "text", text: "working…" }],
        stop_reason: "tool_use",
      },
    },
    {
      type: "assistant",
      message: {
        content: [{ type: "text", text: "DONE: shipped" }],
        stop_reason: "end_turn",
      },
    },
  ]);
  assert.deepEqual(detectStopMarker(path), { marker: "DONE", line: "DONE: shipped" });
});

test("detectStopMarker ignores stale markers from earlier turns", () => {
  const path = scratchJsonl([
    {
      type: "assistant",
      message: {
        content: [{ type: "text", text: "BLOCKED: earlier hiccup" }],
        stop_reason: "end_turn",
      },
    },
    {
      type: "assistant",
      message: {
        content: [{ type: "text", text: "recovered, continuing" }],
        stop_reason: "end_turn",
      },
    },
  ]);
  assert.equal(detectStopMarker(path).marker, null);
});

test("isAwaitingUserReply: true when last assistant turn ended with end_turn", () => {
  const path = scratchJsonl([
    { type: "user", message: { content: "go" } },
    {
      type: "assistant",
      message: {
        content: [{ type: "text", text: "here you go" }],
        stop_reason: "end_turn",
      },
    },
  ]);
  assert.equal(isAwaitingUserReply(path), true);
});

test("isAwaitingUserReply returns false when last event is a user turn", () => {
  const path = scratchJsonl([
    {
      type: "assistant",
      message: {
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
      },
    },
    { type: "user", message: { content: "more please" } },
  ]);
  assert.equal(isAwaitingUserReply(path), false);
});

test("summarizeRecentOutput filters by sinceTs and renders text + tool_use", () => {
  const path = scratchJsonl([
    {
      type: "assistant",
      timestamp: "2026-04-21T00:00:00.000Z",
      message: { content: [{ type: "text", text: "older line, ignore me" }] },
    },
    {
      type: "assistant",
      timestamp: "2026-04-21T00:00:05.000Z",
      message: {
        content: [
          { type: "text", text: "hello world" },
          { type: "tool_use", name: "Bash", input: { command: "ls" } },
        ],
      },
    },
  ]);
  const { lines, lastTs } = summarizeRecentOutput(path, {
    sinceTs: "2026-04-21T00:00:01.000Z",
  });
  assert.deepEqual(lines, ["[claude] hello world", "[tool] Bash(ls)"]);
  assert.equal(lastTs, "2026-04-21T00:00:05.000Z");
});

test("tail cache: two reads of an unchanged jsonl share the same events array", () => {
  const path = scratchJsonl([{ type: "user", message: { content: "one" } }]);
  const first = readJsonlTail(path, 0);
  const second = readJsonlTail(path, 0);
  assert.equal(first, second, "unchanged file must hit the cache and return the same array");
});

test("summarizeRecentOutput caps output to maxEvents, preserving chronological order", () => {
  // Five assistant events, all newer than sinceTs=null (cutoff = 0). maxEvents=3
  // should keep only the last three in original file order.
  const events = [];
  for (let i = 0; i < 5; i++) {
    events.push({
      type: "assistant",
      timestamp: `2026-04-21T00:00:0${i}.000Z`,
      message: { content: [{ type: "text", text: `event-${i}` }] },
    });
  }
  const path = scratchJsonl(events);
  const { lines } = summarizeRecentOutput(path, { maxEvents: 3 });
  assert.deepEqual(lines, [
    "[claude] event-2",
    "[claude] event-3",
    "[claude] event-4",
  ]);
});

test("tail cache: appending to the jsonl invalidates the cache", () => {
  const path = scratchJsonl([{ type: "user", message: { content: "first" } }]);
  const first = readJsonlTail(path, 0);
  assert.equal(first.length, 1);

  appendFileSync(
    path,
    JSON.stringify({ type: "user", message: { content: "second" } }) + "\n",
  );
  bumpMtime(path);

  const second = readJsonlTail(path, 0);
  assert.equal(second.length, 2, "cache must invalidate when size+mtime bump");
  assert.notEqual(first, second, "a fresh events array is returned after invalidation");
});
