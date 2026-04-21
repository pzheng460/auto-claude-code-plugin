import { BRANCH } from "../decide.js";

// planTick is a pure reporter now: given the decided branch and stop marker,
// it says whether a nudge should be poked (NUDGE/RECOVER) and whether the
// worker should be retired (DONE/DEAD, or an explicit DONE/BLOCKED marker).
//
// Force-continue used to live here; it now lives entirely in bin/watcher.mjs,
// which sees end_turn the moment it lands in the jsonl and can poke without
// waiting for the next cron tick. The tick process is read-only w.r.t. force
// mode — it just renders state.
//
// Inputs:
//   branch      — BRANCH.* from decideBranch
//   stopMarker  — detectStopMarker() output — { marker, line }
//
// Output:
//   { branch, shouldNudge, autoStopReason, stopMarker }
export function planTick({ branch, stopMarker = null } = {}) {
  const shouldNudge = branch === BRANCH.NUDGE || branch === BRANCH.RECOVER;

  let autoStopReason = null;
  if (branch === BRANCH.DONE) autoStopReason = retireReasonFor({ allTodosDone: true });
  else if (branch === BRANCH.DEAD) autoStopReason = retireReasonFor({ tmuxAlive: false });
  // AWAITING: no action from tick — watcher owns force-continue. The user's
  // next message is the only way out in non-force mode, and the watcher
  // handles it in force mode.

  // A DONE/BLOCKED marker surfaced anywhere (even outside AWAITING) still
  // retires the worker — keeps the contract consistent with the watcher's
  // marker-based retire path.
  const markerReason = retireReasonFor({ stopMarker });
  if (markerReason && !autoStopReason) autoStopReason = markerReason;

  return {
    branch,
    shouldNudge,
    autoStopReason,
    stopMarker: stopMarker ?? { marker: null, line: null },
  };
}

// Pure helper used by planTick and bin/watcher.mjs so the "what counts as a
// retire condition" wording stays in one place. Returns a string reason or
// null. Callers mix and match inputs (watcher has tmuxAlive + stopMarker;
// tick has DONE/DEAD via branch plus the marker).
export function retireReasonFor({ tmuxAlive, stopMarker, allTodosDone } = {}) {
  if (tmuxAlive === false) return "tmux session gone";
  if (stopMarker?.marker === "DONE") return `claude signalled DONE: ${stopMarker.line}`;
  if (stopMarker?.marker === "BLOCKED") return `claude signalled BLOCKED: ${stopMarker.line}`;
  if (allTodosDone === true) return "all TodoWrite tasks completed";
  return null;
}
