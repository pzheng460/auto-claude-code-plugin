import test from "node:test";
import assert from "node:assert/strict";

import { diffTodos } from "../src/tick/diff.js";

test("empty prev + empty curr → all-empty diff", () => {
  const d = diffTodos([], []);
  assert.deepEqual(d, { completed: [], started: [], added: [] });
});

test("new todo added at the end", () => {
  const d = diffTodos(
    [{ content: "A", status: "pending" }],
    [
      { content: "A", status: "pending" },
      { content: "B", status: "pending" },
    ],
  );
  assert.deepEqual(d.added, ["B"]);
  assert.deepEqual(d.completed, []);
  assert.deepEqual(d.started, []);
});

test("pending → in_progress is reported as started", () => {
  const d = diffTodos(
    [{ content: "A", status: "pending" }],
    [{ content: "A", status: "in_progress" }],
  );
  assert.deepEqual(d.started, ["A"]);
});

test("in_progress → completed is a completion", () => {
  const d = diffTodos(
    [{ content: "A", status: "in_progress" }],
    [{ content: "A", status: "completed" }],
  );
  assert.deepEqual(d.completed, ["A"]);
  assert.deepEqual(d.started, []);
});

test("duplicate content at different indices is tracked per-position", () => {
  // Claude often plans with repeated task names. Before the fix, when one of
  // two "Run tests" completed, the content-only diff would miss (or worse:
  // double-report) the transition.
  const prev = [
    { content: "Run tests", status: "pending" },
    { content: "Run tests", status: "pending" },
  ];
  const curr = [
    { content: "Run tests", status: "completed" },
    { content: "Run tests", status: "pending" },
  ];
  const d = diffTodos(prev, curr);
  assert.deepEqual(d.completed, ["Run tests"]);
  assert.equal(d.started.length, 0);
  assert.equal(d.added.length, 0);
});

test("inserting a todo at the end is detected", () => {
  const d = diffTodos(
    [{ content: "A", status: "completed" }],
    [
      { content: "A", status: "completed" },
      { content: "B", status: "pending" },
    ],
  );
  assert.deepEqual(d.added, ["B"]);
  assert.deepEqual(d.completed, []);
});

test("unrelated status (e.g. pending → pending) is a no-op", () => {
  const r = diffTodos(
    [{ content: "A", status: "pending" }],
    [{ content: "A", status: "pending" }],
  );
  assert.deepEqual(r, { completed: [], started: [], added: [] });
});

