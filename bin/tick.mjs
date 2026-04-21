#!/usr/bin/env node
import {
  resolveStateDir,
  loadState,
  saveState,
  appendNudge,
  retireWorker,
} from "../src/state.js";
import {
  readJsonlTail,
  inspectWorker,
  summarizeRecentOutput,
  detectStopMarker,
} from "../src/claude-state.js";
import { decideBranch, BRANCH } from "../src/decide.js";
import { buildResumePrompt, pokeTmuxWorker } from "../src/poke.js";
import { removeCronJob } from "../src/cron.js";
import { planTick } from "../src/tick/plan.js";
import { renderInstant, renderSummary, renderNoWorker } from "../src/tick/render.js";
import { diffTodos } from "../src/tick/diff.js";
import { envNum, envBool } from "../src/env.js";

// tick is now a pure reporter + nudge/retire driver. Force-continue lives
// in bin/watcher.mjs so it can react in real time instead of waiting for
// the next cron firing.
const config = {
  reportMaxEvents: envNum("AUTO_CLAUDE_CODE_REPORT_MAX_EVENTS", 30),
  reportTextChars: envNum("AUTO_CLAUDE_CODE_REPORT_TEXT_CHARS", 400),
  instant: envBool("AUTO_CLAUDE_CODE_INSTANT"),
  nudgeAfterSec: envNum("AUTO_CLAUDE_CODE_NUDGE_AFTER_SEC", 600),
  recoverAfterSec: envNum("AUTO_CLAUDE_CODE_RECOVER_AFTER_SEC", 1800),
};

const stateDir = resolveStateDir();
const state = loadState(stateDir);

if (!state.workerSessionId) {
  process.stdout.write(renderNoWorker({ mode: config.instant ? "instant" : "summary" }));
  process.exit(0);
}

// ---- inspect ---------------------------------------------------------------
const snapshot = await inspectWorker({
  workerSessionId: state.workerSessionId,
  workerTmuxName: state.workerTmuxName,
  workerCwd: state.workerCwd,
  workerSessionJsonl: state.workerSessionJsonl,
});
const stopMarker = detectStopMarker(snapshot.jsonlPath);

// ---- decide ---------------------------------------------------------------
const branch = decideBranch({
  snapshot,
  thresholds: {
    nudgeAfterSec: config.nudgeAfterSec,
    recoverAfterSec: config.recoverAfterSec,
  },
  hasWorker: true,
});
const plan = planTick({ branch, stopMarker });

// ---- act ------------------------------------------------------------------
const notes = [];
let sessionGoneReason = null;

if (plan.shouldNudge) {
  const tail = readJsonlTail(snapshot.jsonlPath, 5);
  const prompt = buildResumePrompt({
    ageSec: snapshot.ageSec,
    branch,
    currentTask: snapshot.currentTask,
    todos: snapshot.todos,
    recentJsonlTail: summarizeTailEvents(tail),
  });
  const r = await pokeTmuxWorker({ tmuxName: state.workerTmuxName, prompt });
  appendNudge(stateDir, {
    ts: new Date().toISOString(),
    branch: plan.branch,
    ok: !!r?.ok,
    reason: r?.ok ? `nudge via tmux (${plan.branch})` : `${r?.kind}: ${r?.error ?? "poke failed"}`,
  });
  if (!r?.ok && r?.kind === "no-session") {
    sessionGoneReason = `tmux session '${state.workerTmuxName}' gone during nudge`;
  }
  notes.push(r?.ok
    ? `nudge sent via tmux (branch=${plan.branch})`
    : `nudge failed [${r?.kind}]: ${r?.error ?? "unknown"}`);
}

if (stopMarker.marker) {
  notes.push(`claude raised ${stopMarker.marker} marker: ${stopMarker.line}`);
}

if (snapshot.awaitingUserReply) {
  notes.push("assistant ended its turn — watcher will force-continue if force mode is on");
}

const retireReason = sessionGoneReason || plan.autoStopReason;

// ---- auto-retire ----------------------------------------------------------
if (retireReason) {
  try {
    const r = await removeCronJob();
    appendNudge(stateDir, {
      ts: new Date().toISOString(),
      branch: plan.branch,
      ok: !!r?.ok,
      reason: `auto-retire: ${retireReason}`,
    });
  } catch (err) {
    appendNudge(stateDir, {
      ts: new Date().toISOString(),
      branch: plan.branch,
      ok: false,
      reason: `auto-retire cron removal failed: ${err.message}`,
    });
  }
  notes.push(`auto-retire: ${retireReason}`);
}

// ---- bookkeeping ----------------------------------------------------------
const diff = diffTodos(state.lastTodosSnapshot || [], snapshot.todos || []);
const { lines: activity, lastTs } = summarizeRecentOutput(snapshot.jsonlPath, {
  sinceTs: state.lastReportedTs,
  maxEvents: envNum("AUTO_CLAUDE_CODE_REPORT_MAX_EVENTS", 30),
  textCharLimit: envNum("AUTO_CLAUDE_CODE_REPORT_TEXT_CHARS", 400),
});

if (retireReason) {
  retireWorker(stateDir, {
    lastSessionId: state.workerSessionId,
    lastCwd: state.workerCwd,
    lastTask: state.workerTask,
    lastRetiredAt: new Date().toISOString(),
    lastRetireReason: String(retireReason),
  });
} else {
  saveState(stateDir, {
    lastTodosSnapshot: (snapshot.todos || []).map((t) => ({
      content: t.content,
      status: t.status,
      activeForm: t.activeForm,
    })),
    lastReportedTs: lastTs ||
      state.lastReportedTs ||
      (snapshot.jsonlMtimeMs ? new Date(snapshot.jsonlMtimeMs).toISOString() : null),
  });
}

// ---- report ---------------------------------------------------------------
const payload = { branch: plan.branch, snapshot, state, diff, activity, notes };
process.stdout.write(config.instant ? renderInstant(payload) : renderSummary(payload));

// ---- helpers --------------------------------------------------------------
function summarizeTailEvents(entries) {
  if (!entries?.length) return "";
  const slice = entries.length > 5 ? entries.slice(-5) : entries;
  const out = [];
  for (const ev of slice) {
    const t = ev?.type ?? "event";
    const reason = ev?.message?.stop_reason;
    out.push(reason ? `${t}:${reason}` : t);
  }
  return out.join(" → ");
}
