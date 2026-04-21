export const BRANCH = {
  NONE: "NONE",       // no worker tracked
  DEAD: "DEAD",       // tmux session gone
  DONE: "DONE",       // all todos completed → will self-destruct
  IDLE: "IDLE",       // just launched, no jsonl yet
  AWAITING: "AWAITING", // last assistant turn ended (end_turn/stop_sequence) — watcher drives force-continue
  OK: "OK",           // heartbeat fresh
  NUDGE: "NUDGE",     // heartbeat stale
  RECOVER: "RECOVER", // heartbeat very stale
};

export function decideBranch({ snapshot, thresholds, hasWorker }) {
  if (!hasWorker) return BRANCH.NONE;
  if (!snapshot.tmuxAlive) return BRANCH.DEAD;

  // Explicit completion via TodoWrite.
  if (snapshot.totalCount > 0 && snapshot.completedCount === snapshot.totalCount) {
    return BRANCH.DONE;
  }

  // Worker just launched, no session file yet.
  if (!Number.isFinite(snapshot.ageSec)) return BRANCH.IDLE;

  // Last assistant turn ended cleanly (end_turn / stop_sequence) → worker
  // is waiting for user input. The watcher drives force-continue from this
  // state in real time; tick just reports it accurately.
  if (snapshot.awaitingUserReply) return BRANCH.AWAITING;

  if (snapshot.ageSec >= thresholds.recoverAfterSec) return BRANCH.RECOVER;
  if (snapshot.ageSec >= thresholds.nudgeAfterSec) return BRANCH.NUDGE;
  return BRANCH.OK;
}

export function formatStatusLine({ branch, state, snapshot }) {
  if (branch === BRANCH.NONE) {
    return "STATUS: NONE | no worker launched";
  }
  const tmux = state.workerTmuxName ?? "(unset)";
  const progress = snapshot.totalCount
    ? `${snapshot.completedCount}/${snapshot.totalCount}`
    : "0/0";
  const age = Number.isFinite(snapshot.ageSec) ? `${snapshot.ageSec}s` : "N/A";
  const step = snapshot.currentTask?.content
    ? truncate(snapshot.currentTask.content, 48)
    : "-";
  return `STATUS: ${branch} | tmux=${tmux} | progress=${progress} | step=${step} | age=${age} | ${remarkFor(branch, snapshot, { state })}`;
}

const STATIC_REMARKS = {
  [BRANCH.DEAD]: "tmux session gone — worker is dead; run /auto-claude-code stop then re-launch",
  [BRANCH.DONE]: "all tasks completed — watchdog will self-stop",
  [BRANCH.OK]: "healthy",
  [BRANCH.NUDGE]: "stale — nudge sent",
  [BRANCH.RECOVER]: "very stale — recovery poke sent",
};

function remarkFor(branch, snapshot, ctx) {
  if (branch === BRANCH.IDLE) {
    return snapshot.tmuxAlive ? "worker alive, no session activity yet" : "no worker";
  }
  if (branch === BRANCH.AWAITING) {
    return "last assistant turn ended — watcher handles force-continue in real time";
  }
  return STATIC_REMARKS[branch] ?? branch;
}

function truncate(s, n = 48) {
  if (!s) return "";
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
