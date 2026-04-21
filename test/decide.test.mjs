import test from "node:test";
import assert from "node:assert/strict";

import { decideBranch, BRANCH, formatStatusLine } from "../src/decide.js";

// decideBranch is a pure function of (snapshot, thresholds, hasWorker), so
// we exercise it without touching the filesystem or tmux.
const T = { nudgeAfterSec: 600, recoverAfterSec: 1800 };

function snap(overrides = {}) {
  return {
    tmuxAlive: true,
    totalCount: 0,
    completedCount: 0,
    pendingCount: 0,
    ageSec: 0,
    awaitingUserReply: false,
    currentTask: null,
    todos: [],
    jsonlPath: null,
    jsonlMtimeMs: null,
    ...overrides,
  };
}

test("NONE when no worker is tracked", () => {
  const b = decideBranch({ snapshot: snap(), thresholds: T, hasWorker: false });
  assert.equal(b, BRANCH.NONE);
});

test("DEAD when tmux session is gone", () => {
  const b = decideBranch({
    snapshot: snap({ tmuxAlive: false, ageSec: 30 }),
    thresholds: T,
    hasWorker: true,
  });
  assert.equal(b, BRANCH.DEAD);
});

test("DEAD wins over DONE when tmux died during completion", () => {
  const b = decideBranch({
    snapshot: snap({ tmuxAlive: false, totalCount: 2, completedCount: 2, ageSec: 5 }),
    thresholds: T,
    hasWorker: true,
  });
  assert.equal(b, BRANCH.DEAD);
});

test("DONE when all TodoWrite tasks are completed", () => {
  const b = decideBranch({
    snapshot: snap({ totalCount: 3, completedCount: 3 }),
    thresholds: T,
    hasWorker: true,
  });
  assert.equal(b, BRANCH.DONE);
});

test("DONE beats IDLE: completed todos win even before jsonl exists", () => {
  const b = decideBranch({
    snapshot: snap({ totalCount: 1, completedCount: 1, ageSec: Infinity }),
    thresholds: T,
    hasWorker: true,
  });
  assert.equal(b, BRANCH.DONE);
});

test("IDLE when ageSec is non-finite (no jsonl yet)", () => {
  const b = decideBranch({
    snapshot: snap({ ageSec: Infinity }),
    thresholds: T,
    hasWorker: true,
  });
  assert.equal(b, BRANCH.IDLE);
});

test("AWAITING when last assistant turn ended cleanly (awaitingUserReply)", () => {
  const b = decideBranch({
    snapshot: snap({ ageSec: 5, awaitingUserReply: true, totalCount: 2, completedCount: 1 }),
    thresholds: T,
    hasWorker: true,
  });
  assert.equal(b, BRANCH.AWAITING);
});

test("OK when heartbeat is fresh and not awaiting reply", () => {
  const b = decideBranch({
    snapshot: snap({ ageSec: 100 }),
    thresholds: T,
    hasWorker: true,
  });
  assert.equal(b, BRANCH.OK);
});

test("NUDGE at the nudge threshold, RECOVER at the recover threshold", () => {
  const at = (ageSec) =>
    decideBranch({
      snapshot: snap({ ageSec }),
      thresholds: T,
      hasWorker: true,
    });
  assert.equal(at(T.nudgeAfterSec - 1), BRANCH.OK);
  assert.equal(at(T.nudgeAfterSec), BRANCH.NUDGE);
  assert.equal(at(T.recoverAfterSec - 1), BRANCH.NUDGE);
  assert.equal(at(T.recoverAfterSec), BRANCH.RECOVER);
  assert.equal(at(T.recoverAfterSec + 60), BRANCH.RECOVER);
});

test("decide test removed: BLOCKED-like markers are not part of branch logic", () => {
  // Stop markers are handled in tick.mjs / watcher.mjs, not decideBranch.
  // Sanity check that adding unrelated snapshot fields doesn't perturb it.
  const b = decideBranch({
    snapshot: snap({ ageSec: 10, awaitingUserReply: true, stopMarker: "DONE" }),
    thresholds: T,
    hasWorker: true,
  });
  assert.equal(b, BRANCH.AWAITING);
});

test("formatStatusLine renders NONE with a guidance string", () => {
  const line = formatStatusLine({
    branch: BRANCH.NONE,
    state: {},
    snapshot: snap(),
  });
  assert.match(line, /STATUS: NONE/);
  assert.match(line, /no worker/i);
});

test("formatStatusLine surfaces tmux name, progress, and age for OK", () => {
  const line = formatStatusLine({
    branch: BRANCH.OK,
    state: { workerTmuxName: "tmuxA" },
    snapshot: snap({
      ageSec: 42,
      completedCount: 3,
      totalCount: 5,
    }),
  });
  assert.match(line, /STATUS: OK/);
  assert.match(line, /progress=3\/5/);
  assert.match(line, /age=42s/);
});

test("formatStatusLine uses '-' for step when no in_progress todo", () => {
  const line = formatStatusLine({
    branch: BRANCH.OK,
    state: { workerTmuxName: "t" },
    snapshot: snap({ ageSec: 10, totalCount: 2, completedCount: 0 }),
  });
  assert.match(line, /step=-/);
});

test("BRANCH enum exposes the stable set of labels", () => {
  assert.deepEqual(
    Object.keys(BRANCH).sort(),
    ["AWAITING", "DEAD", "DONE", "IDLE", "NONE", "NUDGE", "OK", "RECOVER"],
  );
});

test("formatStatusLine truncates long current-task with ellipsis", () => {
  const line = formatStatusLine({
    branch: BRANCH.OK,
    state: { workerTmuxName: "t" },
    snapshot: snap({
      ageSec: 10,
      totalCount: 2,
      completedCount: 0,
      currentTask: { content: "x".repeat(120) },
    }),
  });
  assert.match(line, /…/);
});
