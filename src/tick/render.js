import { BRANCH } from "../decide.js";
import { oneLine } from "../util.js";

// Pure renderers for a completed tick. The orchestrator supplies every input
// — no I/O happens in here — which keeps these trivially testable.
//
// Inputs shared by both renderers:
//   branch, snapshot, state, diff, activityLines, notes[], plan

const EMOJI_BY_BRANCH = {
  [BRANCH.OK]: "✅",
  [BRANCH.NUDGE]: "⚠️",
  [BRANCH.RECOVER]: "🔧",
  [BRANCH.DONE]: "🎉",
  [BRANCH.DEAD]: "💀",
  [BRANCH.AWAITING]: "💤",
  [BRANCH.IDLE]: "⏳",
};

// Progress + age strings are identical across both renderers. Extracting
// keeps formatting edits (e.g. showing pending counts in `progress`) from
// drifting between instant and summary output.
function headerFields(snapshot) {
  return {
    progress: snapshot.totalCount
      ? `${snapshot.completedCount}/${snapshot.totalCount}`
      : "0/0",
    ageStr: Number.isFinite(snapshot.ageSec) ? `${snapshot.ageSec}s` : "N/A",
  };
}

export function renderInstant({ branch, snapshot, state, diff, activity, notes }) {
  const { progress, ageStr } = headerFields(snapshot);
  const emoji = EMOJI_BY_BRANCH[branch] ?? "•";

  const out = [
    `${emoji} auto-claude-code | ${branch} | ${progress} | age=${ageStr} | tmux=${state.workerTmuxName ?? "(?)"}`,
  ];

  if (state.workerTask) out.push(`Task: ${oneLine(state.workerTask, 160)}`);

  const todos = snapshot.todos || [];
  if (todos.length) {
    out.push("Todos:");
    for (const t of todos) {
      const mark = t.status === "completed" ? "✓"
        : t.status === "in_progress" ? "▶"
        : "·";
      out.push(`  ${mark} ${oneLine(t.content || "", 140)}`);
    }
  }

  const changes = [];
  for (const c of diff.completed || []) changes.push(`completed: ${oneLine(c, 140)}`);
  for (const c of diff.started || []) changes.push(`started:   ${oneLine(c, 140)}`);
  for (const c of diff.added || []) changes.push(`added:     ${oneLine(c, 140)}`);
  if (changes.length) {
    out.push("Changes this tick:");
    for (const c of changes) out.push(`  ${c}`);
  }

  if (activity?.length) {
    out.push("Recent activity:");
    for (const a of activity) out.push(`  ${a}`);
  }

  if (notes?.length) {
    out.push("Notes:");
    for (const n of notes) out.push(`  ${n}`);
  }

  return out.join("\n") + "\n";
}

export function renderSummary({ branch, snapshot, state, diff, activity, notes }) {
  const { progress, ageStr } = headerFields(snapshot);
  const out = [];

  out.push("<status>");
  out.push(`branch=${branch}`);
  out.push(`tmux_alive=${snapshot.tmuxAlive}`);
  out.push(`tmux_name=${state.workerTmuxName ?? ""}`);
  out.push(`progress=${progress}`);
  out.push(`heartbeat_age=${ageStr}`);
  out.push(`awaiting_user_reply=${snapshot.awaitingUserReply ? "true" : "false"}`);
  out.push(`cwd=${state.workerCwd ?? ""}`);
  out.push(`task=${oneLine(state.workerTask ?? "", 200)}`);
  out.push("</status>");
  out.push("");

  out.push("<todos>");
  const todos = snapshot.todos || [];
  if (!todos.length) {
    out.push("(no TodoWrite entries)");
  } else {
    for (const t of todos) {
      const tag = t.status === "completed" ? "[done]"
        : t.status === "in_progress" ? "[wip]"
        : "[todo]";
      out.push(`${tag} ${oneLine(t.content || "", 160)}`);
    }
  }
  out.push("</todos>");
  out.push("");

  out.push("<diff_since_last_tick>");
  const diffLines = [];
  for (const c of diff.completed || []) diffLines.push(`completed: ${c}`);
  for (const c of diff.started || []) diffLines.push(`started: ${c}`);
  for (const c of diff.added || []) diffLines.push(`added: ${c}`);
  if (!diffLines.length) diffLines.push("(no todo transitions since last tick)");
  for (const l of diffLines) out.push(l);
  out.push("</diff_since_last_tick>");
  out.push("");

  out.push("<recent_activity>");
  if (!activity?.length) out.push("(no assistant events since last tick)");
  else for (const l of activity) out.push(l);
  out.push("</recent_activity>");
  out.push("");

  out.push("<notes>");
  const emit = notes?.length ? notes : ["(no watchdog actions this tick)"];
  for (const n of emit) out.push(n);
  out.push("</notes>");
  out.push("");

  return out.join("\n");
}

export function renderNoWorker({ mode }) {
  if (mode === "instant") return "⚪ auto-claude-code | no worker tracked\n";
  return [
    "<status>",
    "branch=NONE",
    "</status>",
    "",
    "<notes>",
    "no worker is currently registered",
    "</notes>",
    "",
  ].join("\n");
}
