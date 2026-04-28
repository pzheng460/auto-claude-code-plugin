import { oneLine } from "../util.js";

// Pure renderers for a completed tick. The orchestrator supplies every input
// — no I/O happens in here — which keeps these trivially testable.
//
// Inputs shared by both renderers:
//   branch, snapshot, state, diff, activityLines, notes[], plan

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

export function renderSummary({ branch, snapshot, state, diff, activity, notes, force = false }) {
  const out = [];

  // Force mode: watcher already drives every turn, so progress/heartbeat/
  // todos/diff are noise. Emit only the activity narrative the LLM needs.
  if (!force) {
    const { progress, ageStr } = headerFields(snapshot);
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
  }

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

export function renderNoWorker() {
  return [
    "<status>",
    "branch=NONE",
    "</status>",
    "",
    "<notes>",
    "no worker tracked",
    "</notes>",
    "",
  ].join("\n");
}
