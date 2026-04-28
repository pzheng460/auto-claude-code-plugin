import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
  renameSync,
  linkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const DEFAULT_STATE_DIR = join(homedir(), ".state", "auto_claude_code");

export const INITIAL_STATE = Object.freeze({
  workerSessionId: null,
  workerTmuxName: null,
  workerCwd: null,
  workerTask: null,
  workerSessionJsonl: null,
  launchedAt: null,
  lastReportedTs: null,
  lastTodosSnapshot: [],
  nudge_history: [],
  lastSessionId: null,
  lastCwd: null,
  lastTask: null,
  lastRetiredAt: null,
  lastRetireReason: null,
  // Force-continue bookkeeping owned by bin/watcher.mjs. Tick no longer
  // touches these — the watcher increments on each poke and resets on
  // progress.
  autoContinueCount: 0,
  watcherPid: null,
  watcherStartedAt: null,
  stickyChannel: null,
  stickySender: null,
  stickyAccount: null,
  // Pool-mode state — populated by /acc launch --pool / --plugin, cleared on
  // release. Each lease record is the slice of the broker envelope we need
  // long-term (id + alias + workdir + expiry); slot.env is reconstituted on
  // demand instead of stored to keep the state file small.
  leases: [],
  leaseHeartbeatLastOkAt: null,
  leaseHeartbeatFailCount: 0,
});

const LOCK_TIMEOUT_MS = 15_000;
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 15;

export function resolveStateDir(pluginConfig = {}) {
  const fromEnv = process.env.AUTO_CLAUDE_CODE_STATE_DIR;
  const fromConfig = pluginConfig?.stateDir;
  return resolve(fromEnv || fromConfig || DEFAULT_STATE_DIR);
}

export function statePaths(stateDir) {
  return {
    stateFile: join(stateDir, "state.json"),
    lockFile: join(stateDir, "state.lock"),
    // pid-stamped so two processes that both try to write never collide on
    // the tmp path — the final `rename` is still atomic per-process.
    tmpFile: join(stateDir, `state.json.${process.pid}.tmp`),
  };
}

export function ensureStateDir(stateDir) {
  const paths = statePaths(stateDir);
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
  if (!existsSync(paths.stateFile)) {
    atomicWriteText(paths.tmpFile, paths.stateFile, JSON.stringify(INITIAL_STATE, null, 2) + "\n");
  }
  return paths;
}

export function loadState(stateDir) {
  const { stateFile } = statePaths(stateDir);
  try {
    const text = readFileSync(stateFile, "utf8");
    return { ...INITIAL_STATE, ...JSON.parse(text) };
  } catch (err) {
    if (err && err.code === "ENOENT") return { ...INITIAL_STATE };
    // A corrupt state file should surface rather than silently wipe —
    // blowing away sessionId/tmuxName would orphan the live worker.
    throw new Error(`auto-claude-code: failed to read ${stateFile}: ${err.message}`);
  }
}

export function saveState(stateDir, patch) {
  return updateState(stateDir, (prev) => ({ ...prev, ...patch }));
}

export function appendNudge(stateDir, entry) {
  return updateState(stateDir, (prev) => {
    const history = Array.isArray(prev.nudge_history) ? prev.nudge_history : [];
    return { ...prev, nudge_history: [...history, entry].slice(-10) };
  });
}

// Worker-tracking fields that should reset to their initial values when the
// worker retires or is superseded. Pulled from INITIAL_STATE so the lists
// stay in lock-step automatically — adding a new worker.* field to
// INITIAL_STATE doesn't require touching clearWorker.
const RETIRED_FIELDS = Object.freeze([
  "workerSessionId",
  "workerTmuxName",
  "workerCwd",
  "workerTask",
  "workerSessionJsonl",
  "launchedAt",
  "lastReportedTs",
  "lastTodosSnapshot",
  "autoContinueCount",
  "watcherPid",
  "watcherStartedAt",
  "stickyChannel",
  "stickySender",
  "stickyAccount",
  "leases",
  "leaseHeartbeatLastOkAt",
  "leaseHeartbeatFailCount",
]);

function withClearedWorker(prev) {
  const next = { ...prev };
  for (const f of RETIRED_FIELDS) next[f] = INITIAL_STATE[f];
  return next;
}

export function clearWorker(stateDir) {
  return updateState(stateDir, withClearedWorker);
}

// Retire the worker and stash its identity into last* fields in one write.
// Used by both `cmdLaunch` (supersede path) and the tick.mjs auto-retire so
// they avoid the saveState→clearWorker double write.
export function retireWorker(stateDir, lastFields = {}) {
  return updateState(stateDir, (prev) => ({
    ...withClearedWorker(prev),
    ...lastFields,
  }));
}

// Serialize a read-modify-write on state.json behind a PID-stamped lock file
// and commit via a tmp-file + rename so readers never observe a half-written
// file. tick.mjs, watcher.mjs, and user commands can all mutate state.json
// concurrently; without this they overwrite each other's fields.
export function updateState(stateDir, mutator) {
  const { stateFile, lockFile, tmpFile } = ensureStateDir(stateDir);
  return withFileLock(lockFile, () => {
    const prev = readJsonOrInitial(stateFile);
    const next = mutator(prev);
    atomicWriteText(tmpFile, stateFile, JSON.stringify(next, null, 2) + "\n");
    return next;
  });
}

function readJsonOrInitial(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    if (err && err.code === "ENOENT") return { ...INITIAL_STATE };
    throw err;
  }
}

function atomicWriteText(tmpFile, finalFile, data) {
  writeFileSync(tmpFile, data);
  renameSync(tmpFile, finalFile);
}

function withFileLock(lockFile, fn) {
  const token = acquireLock(lockFile);
  try {
    return fn();
  } finally {
    releaseLock(lockFile, token);
  }
}

// PID is constant for a process — pre-stamp once instead of allocating on
// every lock attempt. Map keyed by lockFile so concurrent state dirs in one
// process (tests do this) each get their own staging path.
const STAGING_BY_LOCK = new Map();
function stagingFor(lockFile) {
  let p = STAGING_BY_LOCK.get(lockFile);
  if (!p) { p = `${lockFile}.claim.${process.pid}`; STAGING_BY_LOCK.set(lockFile, p); }
  return p;
}

function acquireLock(lockFile) {
  const token = { pid: process.pid, createdAt: Date.now() };
  const payload = JSON.stringify(token);
  // Stage the payload in a per-process file, then linkSync it into place.
  // link() is atomic (EEXIST if the target already exists), so a concurrent
  // reader never sees the lockfile in an empty/partial state — the race
  // that previously let isLockStale() report "stale" on an in-flight lock.
  const staging = stagingFor(lockFile);
  writeFileSync(staging, payload);
  const waitUntil = Date.now() + LOCK_TIMEOUT_MS;
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        linkSync(staging, lockFile);
        return token;
      } catch (err) {
        if (err.code !== "EEXIST") throw err;
      }
      if (isLockStale(lockFile)) {
        try { unlinkSync(lockFile); } catch {}
        continue;
      }
      if (Date.now() > waitUntil) {
        throw new Error(
          `auto-claude-code: could not acquire state lock ${lockFile} within ${LOCK_TIMEOUT_MS}ms`,
        );
      }
      sleepSync(LOCK_RETRY_MS);
    }
  } finally {
    try { unlinkSync(staging); } catch {}
  }
}

function releaseLock(lockFile, token) {
  const owner = readLockOwner(lockFile);
  if (owner && owner.pid === token.pid && owner.createdAt === token.createdAt) {
    try { unlinkSync(lockFile); } catch {}
  }
}

function readLockOwner(lockFile) {
  try {
    const owner = JSON.parse(readFileSync(lockFile, "utf8"));
    if (typeof owner?.pid !== "number" || typeof owner?.createdAt !== "number") return null;
    return owner;
  } catch {
    return null;
  }
}

function isLockStale(lockFile) {
  const owner = readLockOwner(lockFile);
  if (!owner) return true;
  if (owner.pid === process.pid) return false;
  if (Date.now() - owner.createdAt > LOCK_STALE_MS) return true;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (err) {
    return err.code === "ESRCH";
  }
}

// Shared across all sleepSync() calls. Zero-filled and never written to —
// Atomics.wait on a value that never changes behaves as a pure delay.
const SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms) {
  Atomics.wait(SLEEP_BUF, 0, 0, ms);
}
