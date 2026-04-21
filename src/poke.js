import { paste as tmuxPaste, sendEnter as tmuxSendEnter, hasSession as tmuxHasSession, TmuxError } from "./tmux.js";

function ageLabel(sec) {
  if (!Number.isFinite(sec)) return "unknown";
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  return `${(sec / 3600).toFixed(1)}h`;
}

export function buildResumePrompt({ ageSec, currentTask, todos, branch, recentJsonlTail }) {
  const head =
    branch === "RECOVER"
      ? "auto-claude-code watchdog: you appear stalled"
      : "auto-claude-code watchdog: you've gone quiet";
  const parts = [`${head} (heartbeat age=${ageLabel(ageSec)}).`];

  if (currentTask) {
    parts.push(`Current in-progress task: "${currentTask.content}"`);
  } else if (todos?.length) {
    const nextPending = todos.find((t) => t.status === "pending");
    if (nextPending) parts.push(`Next pending task: "${nextPending.content}"`);
  }

  const total = todos?.length ?? 0;
  if (total) {
    const done = todos.filter((t) => t.status === "completed").length;
    parts.push(`Progress: ${done}/${total} tasks completed.`);
  }

  if (recentJsonlTail) parts.push(`Recent events: ${recentJsonlTail}`);

  parts.push(
    "Resume from your current task. Do NOT restart the whole job. If you are blocked, describe what's blocking you and ask for input.",
  );
  return parts.join("\n\n");
}

export function buildContinuePrompt({ currentTask, todos, consecutiveContinues }) {
  const parts = [
    "auto-claude-code watchdog (force mode): you stopped mid-task. Keep going.",
  ];
  if (currentTask) {
    parts.push(`You were working on: "${currentTask.content}". Continue from where you left off.`);
  } else if (todos?.length) {
    const next = todos.find((t) => t.status === "pending");
    if (next) parts.push(`Next pending task: "${next.content}".`);
  }
  if (Number.isFinite(consecutiveContinues) && consecutiveContinues > 0) {
    parts.push(
      `(auto-continue #${consecutiveContinues + 1}; if you are genuinely done, reply with a single line starting with "BLOCKED:" or "DONE:" so the watchdog stops poking you.)`,
    );
  } else {
    parts.push(
      'If you are genuinely done or cannot proceed without user input, start your reply with a line "DONE:" (finished) or "BLOCKED: <what you need>" — the watchdog will then stop auto-continuing.',
    );
  }
  return parts.join("\n\n");
}

// Returns { ok, kind, error } where kind is one of:
//   no-target       caller passed an empty tmuxName
//   no-session      tmux has no session by that name (worker is gone)
//   tmux-missing    tmux binary isn't installed
//   timeout         tmux subcommand timed out (host under load)
//   permission      filesystem/pty permission error
//   buffer          load-buffer or paste-buffer failed (retryable)
//   unknown         anything else
// Callers can branch on .kind — e.g. tick.mjs should retire the worker on
// no-session instead of endlessly re-poking a dead tmux name.
export async function pokeTmuxWorker({ tmuxName, prompt }) {
  if (!tmuxName) return { ok: false, kind: "no-target", error: "no tmuxName" };
  try {
    if (!(await tmuxHasSession(tmuxName))) {
      return { ok: false, kind: "no-session", error: `tmux session '${tmuxName}' is gone` };
    }
  } catch (err) {
    return { ok: false, kind: errKind(err), error: err.message ?? String(err) };
  }
  try {
    await tmuxPaste(tmuxName, prompt);
    await tmuxSendEnter(tmuxName);
    return { ok: true, kind: "ok" };
  } catch (err) {
    return { ok: false, kind: errKind(err), error: err.message ?? String(err) };
  }
}

function errKind(err) {
  return err instanceof TmuxError ? err.kind : "unknown";
}
