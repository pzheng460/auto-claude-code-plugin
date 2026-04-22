import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { sleep } from "./util.js";

const execFile = promisify(execFileCb);

export const DEFAULT_TMUX_NAME = "auto-claude-worker";
export const DEFAULT_TIMEOUT_MS = 5000;

// Every recoverable tmux failure becomes a TmuxError with a stable `.kind` so
// callers can branch on the failure type instead of pattern-matching stderr:
//   tmux-missing  tmux binary is not on PATH
//   no-session    the named session does not exist
//   timeout       the subprocess ran past its timeout and was killed
//   permission    EACCES on pane, tmp buffer file, or pty
//   buffer        load-buffer / paste-buffer failure (size, disk, etc.)
//   unknown       anything else (stderr is preserved on the error)
export class TmuxError extends Error {
  constructor({ kind, command, stderr = "", cause = null }) {
    const suffix = stderr ? ` — ${String(stderr).trim().split("\n")[0]}` : "";
    super(`tmux ${command}: ${kind}${suffix}`);
    this.name = "TmuxError";
    this.kind = kind;
    this.command = command;
    this.stderr = stderr;
    if (cause) this.cause = cause;
  }
}

export async function runTmux(args, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  try {
    const { stdout } = await execFile("tmux", args, {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      timeout: timeoutMs,
    });
    return stdout;
  } catch (err) {
    throw classifyTmuxError(args, err);
  }
}

export function classifyTmuxError(args, err) {
  const command = args[0] ?? "(empty)";
  const stderr = (err.stderr ?? err.message ?? "").toString();
  if (err.code === "ENOENT") {
    return new TmuxError({ kind: "tmux-missing", command, stderr, cause: err });
  }
  // execFile with a timeout: killed + SIGTERM. On some platforms code === 'ETIMEDOUT'.
  if ((err.killed && err.signal === "SIGTERM") || err.code === "ETIMEDOUT") {
    return new TmuxError({ kind: "timeout", command, stderr, cause: err });
  }
  if (/can'?t find session|no server running|no such session|session not found/i.test(stderr)) {
    return new TmuxError({ kind: "no-session", command, stderr, cause: err });
  }
  if (/permission denied|EACCES/i.test(stderr)) {
    return new TmuxError({ kind: "permission", command, stderr, cause: err });
  }
  if (/buffer|no space left|too large/i.test(stderr)) {
    return new TmuxError({ kind: "buffer", command, stderr, cause: err });
  }
  return new TmuxError({ kind: "unknown", command, stderr, cause: err });
}

// ---------- session ops ----------

export async function hasSession(name, opts) {
  if (!name) return false;
  try {
    await runTmux(["has-session", "-t", name], opts);
    return true;
  } catch (err) {
    if (err instanceof TmuxError && err.kind === "no-session") return false;
    throw err;
  }
}

export async function newSession(name, cwd, opts) {
  await runTmux(["new-session", "-d", "-s", name, "-c", cwd || process.cwd()], opts);
}

export async function killSession(name, opts) {
  if (!name) return false;
  try {
    await runTmux(["kill-session", "-t", name], opts);
    return true;
  } catch (err) {
    if (err instanceof TmuxError && err.kind === "no-session") return false;
    throw err;
  }
}

// ---------- pane I/O ----------

export async function capturePane(name, { lines = 0, ...rest } = {}) {
  const args = ["capture-pane", "-t", name, "-p"];
  if (lines > 0) args.push("-S", `-${lines}`);
  return runTmux(args, rest);
}

// Ask tmux what foreground command is running in the pane. Returns the
// short command name (e.g. "claude", "zsh", "bash"). This is the most
// reliable signal we've got for "is claude still running?" — waitForShellReady
// is fooled by Claude's REPL because claude politely echoes whatever we
// paste, so the sentinel appears in the pane even though we're still inside
// the TUI.
export async function paneCurrentCommand(name, opts) {
  try {
    const out = await runTmux(
      ["display-message", "-t", name, "-p", "#{pane_current_command}"],
      opts,
    );
    return out.trim();
  } catch (err) {
    if (err instanceof TmuxError && err.kind === "no-session") return null;
    throw err;
  }
}

export async function sendEnter(name, opts) {
  await runTmux(["send-keys", "-t", name, "Enter"], opts);
}

// Send a named key (tmux's key vocabulary: Right/Left/Up/Down/Tab/Escape/
// BSpace/etc.) to a pane. Used by form-answering logic to drive multi-step
// TUI forms without typing literal characters.
export async function sendKey(name, key, opts) {
  await runTmux(["send-keys", "-t", name, key], opts);
}

export async function sendLiteral(name, text, opts) {
  await runTmux(["send-keys", "-t", name, "-l", "--", text], opts);
}

export async function sendCtrlC(name, opts) {
  await runTmux(["send-keys", "-t", name, "C-c"], opts);
}

export async function sendCtrlCPair(name, opts) {
  // Claude's REPL requires two Ctrl-Cs (the first opens a confirm prompt).
  await sendCtrlC(name, opts);
  await sleep(250);
  await sendCtrlC(name, opts);
}

// ---------- paste ----------

export async function paste(name, text, opts = {}) {
  const buffer = `acc-${randomBytes(6).toString("hex")}`;
  const tmpFile = join(tmpdir(), `${buffer}.txt`);
  await writeFile(tmpFile, text, "utf8");
  try {
    await runTmux(["load-buffer", "-b", buffer, tmpFile], opts);
    try {
      await runTmux(["paste-buffer", "-b", buffer, "-t", name], opts);
    } finally {
      // Always try to drop the buffer, even if paste failed, so repeated
      // retries don't leak names into tmux's registry.
      try { await runTmux(["delete-buffer", "-b", buffer], opts); } catch {}
    }
  } finally {
    try { await unlink(tmpFile); } catch {}
  }
}

// ---------- ready signal ----------

// Ensure the pane's foreground process is the user's shell (not claude).
// Polls `pane_current_command`; if claude is there, sends Ctrl-C and tries
// again up to `maxCtrlCs` times. Unlike the old sentinel-based
// waitForShellReady, this doesn't paste anything into the pane, so a live
// claude REPL can't echo the sentinel back and cause a false positive.
//
//   maxCtrlCs — how many Ctrl-Cs to try before giving up (default 6,
//               matches softExitClaude's ladder).
//   pollMs    — interval between Ctrl-C and the next probe; long enough
//               for claude's "press Ctrl-C again to exit" confirm.
//
// Returns { ok: true, cmd, attempts } on success, or
//         { ok: false, reason } where reason is "no-session" | "claude-alive".
export async function ensurePaneAtShell(name, { maxCtrlCs = 6, pollMs = 400 } = {}) {
  for (let attempts = 0; attempts <= maxCtrlCs; attempts++) {
    const cmd = await paneCurrentCommand(name).catch(() => null);
    if (cmd === null) return { ok: false, reason: "no-session" };
    if (cmd !== "claude") return { ok: true, cmd, attempts };
    if (attempts < maxCtrlCs) {
      await sendCtrlC(name);
      await sleep(pollMs);
    }
  }
  return { ok: false, reason: "claude-alive" };
}
