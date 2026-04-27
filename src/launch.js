import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_TMUX_NAME,
  hasSession,
  newSession,
  sendEnter,
  sendLiteral,
  ensurePaneAtShell,
} from "./tmux.js";
import { locateSessionJsonl } from "./claude-state.js";
import { sleep } from "./util.js";

export { DEFAULT_TMUX_NAME } from "./tmux.js";

function shellSafe(s) {
  const str = String(s);
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(str)) return str;
  return `'${str.replace(/'/g, `'\\''`)}'`;
}

// Pre-accept Claude Code's per-project trust prompt by flipping the flag in
// ~/.claude.json; without it the first `claude` invocation in a new cwd parks
// at "Do you trust the files in this folder?" and the worker never starts.
function ensureProjectTrusted(cwd) {
  if (!cwd) return { ok: false, reason: "no cwd" };
  const path = join(homedir(), ".claude.json");
  if (!existsSync(path)) return { ok: false, reason: "~/.claude.json missing" };
  let obj;
  try {
    obj = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    return { ok: false, reason: `parse ~/.claude.json: ${err.message}` };
  }
  obj.projects ??= {};
  const entry = obj.projects[cwd] ?? {};
  if (entry.hasTrustDialogAccepted === true || entry.hasTrustDialogAccepted === "accepted") {
    return { ok: true, alreadyTrusted: true };
  }
  obj.projects[cwd] = { ...entry, hasTrustDialogAccepted: true };
  try {
    writeFileSync(path, JSON.stringify(obj, null, 2));
    return { ok: true, alreadyTrusted: false };
  } catch (err) {
    return { ok: false, reason: `write ~/.claude.json: ${err.message}` };
  }
}

// Poll until Claude has actually started — proved by a non-empty jsonl under
// ~/.claude/projects/<slug>/<sessionId>.jsonl. Much more reliable than
// capturing the pane and guessing whether the REPL is up.
export async function waitForClaudeReady({ cwd, sessionId, timeoutMs = 15_000, pollMs = 200 }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const path = locateSessionJsonl(cwd, sessionId);
    if (path) {
      try {
        if (statSync(path).size > 0) return { ok: true, jsonlPath: path };
      } catch {}
    }
    await sleep(pollMs);
  }
  return { ok: false, reason: `timed out after ${timeoutMs}ms waiting for ${sessionId} jsonl` };
}

export async function launchWorker({
  cwd,
  task,
  model,
  tmuxName = DEFAULT_TMUX_NAME,
  resumeSessionId = null,
  continueLatest = false,
  forkOnResume = false,
  awaitReady = true,
  readyTimeoutMs = 15_000,
} = {}) {
  const trust = ensureProjectTrusted(cwd);
  const sessionId = forkOnResume ? randomUUID() : (resumeSessionId || randomUUID());

  const reused = await hasSession(tmuxName);
  if (!reused) {
    await newSession(tmuxName, cwd);
    // Fresh tmux launches the user's shell directly; a short sleep lets
    // zsh/bash finish init (rcfiles, prompts) before we paste a command.
    await sleep(500);
  } else {
    // Pane may be at a shell prompt OR inside an old claude REPL. The old
    // path pasted a `printf <sentinel>` and watched capture-pane for it,
    // which fooled us when claude was alive (claude echoes the sentinel
    // back as user input). Use `pane_current_command` instead: spam Ctrl-C
    // until the pane's foreground process is no longer claude.
    const r = await ensurePaneAtShell(tmuxName);
    if (!r.ok) {
      return { ok: false, error: `tmux pane '${tmuxName}' stuck (${r.reason})` };
    }
    await sendLiteral(tmuxName, `cd ${shellSafe(cwd)} && clear`);
    await sendEnter(tmuxName);
    // cd+clear is instant; a short settle avoids racing the next paste
    // against the shell's redraw.
    await sleep(300);
  }

  // Plugin path: this file lives at <plugin-root>/src/launch.js, so the
  // plugin root is one dir up. Tell claude to load it via --plugin-dir
  // so the lifecycle hooks + acc_ask_user MCP tool are available.
  const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const claudeArgs = [
    "--dangerously-skip-permissions",
    "--plugin-dir", PLUGIN_ROOT,
  ];
  if (resumeSessionId) {
    claudeArgs.push("--resume", resumeSessionId);
  } else if (continueLatest) {
    claudeArgs.push("--continue");
  } else {
    claudeArgs.push("--session-id", sessionId);
  }
  if (forkOnResume && (resumeSessionId || continueLatest)) {
    claudeArgs.push("--fork-session");
  }
  if (model) claudeArgs.push("--model", model);

  // Pre-pend NO_PROXY for the claude command so the bundled MCP server
  // at http://127.0.0.1:7779/mcp isn't intercepted by the user's HTTP
  // proxy. We OR with whatever no_proxy already is so we don't clobber
  // existing settings.
  const parts = [
    "NO_PROXY=\"${NO_PROXY:+$NO_PROXY,}localhost,127.0.0.1\"",
    "no_proxy=\"${no_proxy:+$no_proxy,}localhost,127.0.0.1\"",
    "claude", ...claudeArgs.map(shellSafe),
  ];
  if (task) parts.push(shellSafe(task));
  await sendLiteral(tmuxName, parts.join(" "));
  await sendEnter(tmuxName);

  const ready = awaitReady
    ? await waitForClaudeReady({ cwd, sessionId, timeoutMs: readyTimeoutMs })
    : { ok: true, jsonlPath: null, skipped: true };

  return {
    ok: true,
    sessionId,
    tmuxName,
    reused: !!reused,
    cwd,
    task,
    launchedAt: new Date().toISOString(),
    trust,
    resumed: !!(resumeSessionId || continueLatest),
    forked: !!(forkOnResume && (resumeSessionId || continueLatest)),
    ready,
  };
}
