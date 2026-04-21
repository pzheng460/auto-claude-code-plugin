import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  readdirSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ensureStateDir,
  loadState,
  saveState,
  appendNudge,
  clearWorker,
  updateState,
  statePaths,
} from "../src/state.js";

const freshDir = () => mkdtempSync(join(tmpdir(), "acc-state-"));
const writerScript = fileURLToPath(new URL("./fixtures/concurrent-writer.mjs", import.meta.url));

test("ensureStateDir creates state.json with INITIAL_STATE", () => {
  const d = freshDir();
  ensureStateDir(d);
  const { stateFile } = statePaths(d);
  assert.ok(existsSync(stateFile));
  const s = loadState(d);
  assert.equal(s.workerSessionId, null);
  assert.deepEqual(s.nudge_history, []);
});

test("saveState merges shallowly and persists across calls", () => {
  const d = freshDir();
  saveState(d, { workerSessionId: "s1", workerTmuxName: "tmuxA" });
  saveState(d, { workerCwd: "/tmp/proj" });
  const s = loadState(d);
  assert.equal(s.workerSessionId, "s1");
  assert.equal(s.workerTmuxName, "tmuxA");
  assert.equal(s.workerCwd, "/tmp/proj");
});

test("appendNudge trims history to last 10 entries", () => {
  const d = freshDir();
  for (let i = 0; i < 15; i++) appendNudge(d, { ts: `t${i}`, branch: "NUDGE" });
  const s = loadState(d);
  assert.equal(s.nudge_history.length, 10);
  assert.equal(s.nudge_history[0].ts, "t5");
  assert.equal(s.nudge_history.at(-1).ts, "t14");
});

test("clearWorker nulls worker fields but preserves lastSessionId + nudge history", () => {
  const d = freshDir();
  saveState(d, {
    workerSessionId: "s1",
    workerTmuxName: "t1",
    lastSessionId: "previous-sid",
  });
  appendNudge(d, { ts: "t1", branch: "OK" });
  clearWorker(d);

  const s = loadState(d);
  assert.equal(s.workerSessionId, null);
  assert.equal(s.workerTmuxName, null);
  assert.equal(
    s.lastSessionId,
    "previous-sid",
    "lastSessionId must survive clearWorker so --resume last still works",
  );
  assert.equal(s.nudge_history.length, 1);
}

);

test("loadState returns INITIAL_STATE when the file is missing", () => {
  const d = freshDir();
  const s = loadState(d);
  assert.equal(s.workerSessionId, null);
  assert.equal(s.autoContinueCount, 0);
});

test("loadState surfaces corrupt JSON instead of silently wiping", () => {
  const d = freshDir();
  ensureStateDir(d);
  const { stateFile } = statePaths(d);
  writeFileSync(stateFile, "{not json", "utf8");
  assert.throws(() => loadState(d), /failed to read/);
});

test("updateState leaves no tmp or lock files behind on success", () => {
  const d = freshDir();
  updateState(d, (prev) => ({ ...prev, workerSessionId: "x" }));
  const stray = readdirSync(d).filter((n) => n.endsWith(".tmp") || n.endsWith(".lock"));
  assert.deepEqual(stray, [], `stray artifacts: ${stray.join(", ")}`);
});

test("concurrent writers do not lose increments", async () => {
  const d = freshDir();
  ensureStateDir(d);
  const N = 20;
  const kids = Array.from({ length: N }, () => runChild(writerScript, [d]));
  const results = await Promise.all(kids);
  for (const code of results) assert.equal(code, 0, "writer child must exit 0");
  const s = loadState(d);
  assert.equal(
    s.autoContinueCount,
    N,
    "every racing writer must land its increment (no lost updates)",
  );
});

function runChild(script, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [script, ...args], { stdio: "inherit" });
    p.on("exit", (code) => resolve(code ?? 0));
    p.on("error", reject);
  });
}
