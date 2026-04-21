import test from "node:test";
import assert from "node:assert/strict";

import { TmuxError, classifyTmuxError as classify } from "../src/tmux.js";

test("TmuxError captures kind / command / stderr / cause", () => {
  const cause = new Error("raw");
  const err = new TmuxError({
    kind: "buffer",
    command: "load-buffer",
    stderr: "line1\nline2",
    cause,
  });
  assert.equal(err.name, "TmuxError");
  assert.equal(err.kind, "buffer");
  assert.equal(err.command, "load-buffer");
  assert.equal(err.cause, cause);
  assert.match(err.message, /load-buffer.*buffer.*line1/);
  assert.ok(!err.message.includes("line2"), "only the first line of stderr should appear in .message");
});

test("classifyTmuxError: ENOENT → tmux-missing", () => {
  const err = Object.assign(new Error(), { code: "ENOENT" });
  assert.equal(classify(["has-session", "-t", "x"], err).kind, "tmux-missing");
});

test("classifyTmuxError: killed+SIGTERM → timeout", () => {
  const err = Object.assign(new Error(), { killed: true, signal: "SIGTERM", stderr: "" });
  assert.equal(classify(["capture-pane"], err).kind, "timeout");
});

test("classifyTmuxError: no-session patterns", () => {
  const samples = [
    "can't find session: acc-1",
    "no server running on /tmp/tmux-1000/default",
    "no such session",
    "session not found: foo",
  ];
  for (const stderr of samples) {
    const err = Object.assign(new Error(), { stderr });
    assert.equal(
      classify(["has-session"], err).kind,
      "no-session",
      `expected no-session for: ${stderr}`,
    );
  }
});

test("classifyTmuxError: permission denied → permission", () => {
  const err = Object.assign(new Error(), { stderr: "permission denied" });
  assert.equal(classify(["load-buffer"], err).kind, "permission");
});

test("classifyTmuxError: buffer / disk space → buffer", () => {
  for (const stderr of ["load-buffer failed", "no space left on device", "buffer too large"]) {
    const err = Object.assign(new Error(), { stderr });
    assert.equal(
      classify(["load-buffer"], err).kind,
      "buffer",
      `expected buffer for: ${stderr}`,
    );
  }
});

test("classifyTmuxError: unrecognised stderr → unknown with preserved message", () => {
  const err = Object.assign(new Error(), { stderr: "gremlin ate the tmux" });
  const out = classify(["send-keys"], err);
  assert.equal(out.kind, "unknown");
  assert.match(out.stderr, /gremlin/);
});

test("classifyTmuxError: ENOENT beats stderr content", () => {
  const err = Object.assign(new Error(), {
    code: "ENOENT",
    stderr: "can't find session: acc",
  });
  assert.equal(classify(["has-session"], err).kind, "tmux-missing");
});
