import test from "node:test";
import assert from "node:assert/strict";

import { BRANCH } from "../src/decide.js";
import { planTick, retireReasonFor } from "../src/tick/plan.js";

// planTick is intentionally thin now: it turns a branch + stop marker into
// { shouldNudge, autoStopReason }. Force-continue lives in bin/watcher.mjs.
test("OK: no action", () => {
  const plan = planTick({ branch: BRANCH.OK });
  assert.equal(plan.shouldNudge, false);
  assert.equal(plan.autoStopReason, null);
});

test("NUDGE + RECOVER request a nudge but do not retire", () => {
  for (const branch of [BRANCH.NUDGE, BRANCH.RECOVER]) {
    const plan = planTick({ branch });
    assert.equal(plan.shouldNudge, true, `branch=${branch}`);
    assert.equal(plan.autoStopReason, null, `branch=${branch}`);
  }
});

test("DONE retires with the all-tasks-done reason", () => {
  const plan = planTick({ branch: BRANCH.DONE });
  assert.equal(plan.autoStopReason, "all TodoWrite tasks completed");
  assert.equal(plan.shouldNudge, false);
});

test("DEAD retires with the tmux-gone reason", () => {
  const plan = planTick({ branch: BRANCH.DEAD });
  assert.equal(plan.autoStopReason, "tmux session gone");
});

test("AWAITING: tick does nothing — watcher owns force-continue", () => {
  const plan = planTick({ branch: BRANCH.AWAITING });
  assert.equal(plan.shouldNudge, false);
  assert.equal(plan.autoStopReason, null);
});

test("DONE marker retires even on AWAITING branch", () => {
  const plan = planTick({
    branch: BRANCH.AWAITING,
    stopMarker: { marker: "DONE", line: "DONE: ship it" },
  });
  assert.match(plan.autoStopReason, /DONE/);
});

test("BLOCKED marker retires with BLOCKED reason", () => {
  const plan = planTick({
    branch: BRANCH.AWAITING,
    stopMarker: { marker: "BLOCKED", line: "BLOCKED: no key" },
  });
  assert.match(plan.autoStopReason, /BLOCKED/);
});

test("NONE branch does nothing", () => {
  const plan = planTick({ branch: BRANCH.NONE });
  assert.equal(plan.shouldNudge, false);
  assert.equal(plan.autoStopReason, null);
});

test("NUDGE wins over marker-less AWAITING — shouldNudge flips true", () => {
  const plan = planTick({ branch: BRANCH.NUDGE });
  assert.equal(plan.shouldNudge, true);
});

// retireReasonFor is shared between planTick and bin/watcher.mjs so both
// emit identical reason strings — changing the wording is a single point
// of maintenance.
test("retireReasonFor: tmuxAlive=false wins over stopMarker", () => {
  const r = retireReasonFor({
    tmuxAlive: false,
    stopMarker: { marker: "DONE", line: "DONE: x" },
  });
  assert.equal(r, "tmux session gone");
});

test("retireReasonFor: DONE marker", () => {
  const r = retireReasonFor({ stopMarker: { marker: "DONE", line: "DONE: ship it" } });
  assert.equal(r, "claude signalled DONE: DONE: ship it");
});

test("retireReasonFor: BLOCKED marker", () => {
  const r = retireReasonFor({ stopMarker: { marker: "BLOCKED", line: "BLOCKED: missing key" } });
  assert.equal(r, "claude signalled BLOCKED: BLOCKED: missing key");
});

test("retireReasonFor: allTodosDone", () => {
  assert.equal(retireReasonFor({ allTodosDone: true }), "all TodoWrite tasks completed");
});

test("retireReasonFor: nothing matches → null", () => {
  assert.equal(retireReasonFor({}), null);
});
