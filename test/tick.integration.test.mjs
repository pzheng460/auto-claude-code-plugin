import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { ensureStateDir, saveState, loadState } from "../src/state.js";

const tickScript = fileURLToPath(new URL("../bin/tick.mjs", import.meta.url));

async function runTick(stateDir, { instant = false, extraEnv = {} } = {}) {
  const env = {
    ...process.env,
    AUTO_CLAUDE_CODE_STATE_DIR: stateDir,
    AUTO_CLAUDE_CODE_NUDGE_AFTER_SEC: "600",
    AUTO_CLAUDE_CODE_RECOVER_AFTER_SEC: "1800",
    ...extraEnv,
  };
  if (instant) env.AUTO_CLAUDE_CODE_INSTANT = "1";
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tickScript], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const outBuf = [];
    const errBuf = [];
    child.stdout.on("data", (c) => outBuf.push(c));
    child.stderr.on("data", (c) => errBuf.push(c));
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({
        code,
        stdout: Buffer.concat(outBuf).toString("utf8"),
        stderr: Buffer.concat(errBuf).toString("utf8"),
      }),
    );
  });
}

const freshStateDir = () => mkdtempSync(join(tmpdir(), "acc-tick-it-"));

test("summary mode: no worker → branch=NONE + no-worker note", async () => {
  const dir = freshStateDir();
  ensureStateDir(dir);
  const { code, stdout } = await runTick(dir);
  assert.equal(code, 0);
  assert.match(stdout, /branch=NONE/);
  assert.match(stdout, /no worker is currently registered/);
});

test("instant mode: no worker → single no-worker line", async () => {
  const dir = freshStateDir();
  ensureStateDir(dir);
  const { code, stdout } = await runTick(dir, { instant: true });
  assert.equal(code, 0);
  assert.match(stdout, /no worker tracked/);
});

test("dead tmux retires the worker and preserves lastSessionId", async () => {
  const dir = freshStateDir();
  ensureStateDir(dir);

  const sid = randomUUID();
  const jsonlPath = join(dir, "fake-session.jsonl");
  writeFileSync(
    jsonlPath,
    JSON.stringify({
      type: "assistant",
      timestamp: new Date().toISOString(),
      message: {
        stop_reason: "end_turn",
        content: [{ type: "text", text: "hello from fake worker" }],
      },
    }) + "\n",
    "utf8",
  );

  // workerTmuxName = "" → hasSession short-circuits to false →
  // decideBranch returns DEAD → plan.autoStopReason = "tmux session gone".
  saveStateSync(dir, {
    workerSessionId: sid,
    workerTmuxName: "",
    workerCwd: "/tmp/fake-cwd",
    workerSessionJsonl: jsonlPath,
    workerTask: "integration test task",
    launchedAt: new Date().toISOString(),
  });

  const { code, stdout } = await runTick(dir);
  assert.equal(code, 0, "tick should exit cleanly");
  assert.match(stdout, /branch=DEAD/);
  assert.match(stdout, /auto-retire:\s*tmux session gone/);

  const after = loadState(dir);
  assert.equal(after.workerSessionId, null);
  assert.equal(after.lastSessionId, sid);
  assert.equal(after.lastRetireReason, "tmux session gone");
  assert.ok(after.lastRetiredAt, "lastRetiredAt should be stamped");
});

// Thin alias so the test reads naturally and we don't accidentally import
// an async save from node:fs.
function saveStateSync(dir, patch) {
  saveState(dir, patch);
}
