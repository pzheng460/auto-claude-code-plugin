import test from "node:test";
import assert from "node:assert/strict";

import { planCronInstall } from "../src/commands.js";

// The watcher now owns force-continue, so the cron's only job is rendering
// the LLM heartbeat in summary mode. planCronInstall collapses to a single
// axis: instant → no cron, summary → install cron. The `force` flag used to
// matter here and no longer does — it's the watcher's responsibility.

const NOTIFY = { channel: "slack", to: "user:abc", account: "acct-1" };

test("instant mode: no cron (watcher streams chat and drives force)", () => {
  assert.equal(planCronInstall({ instant: true, notify: NOTIFY }), null);
  assert.equal(planCronInstall({ instant: true, notify: null }), null);
});

test("summary mode: install cron for LLM heartbeat", () => {
  assert.deepEqual(
    planCronInstall({ instant: false, notify: NOTIFY }),
    { notify: NOTIFY },
  );
});

test("summary mode without notify: still installs (cron has no other driver)", () => {
  const p = planCronInstall({ instant: false, notify: null });
  assert.deepEqual(p, { notify: null });
});
