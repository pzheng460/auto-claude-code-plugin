// Multi-lease lifecycle: acquire a group of broker leases (one per pool
// declared in a manifest), heartbeat them while the worker runs, release
// on stop / death / orphan-cleanup. Failures of any single op are isolated
// — orphans are persisted so cmdGc can sweep them on daemon restart.

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const ORPHAN_FILE = "orphan_leases.json";

// ---------- discovery ----------------------------------------------------

/**
 * Read a Claude Code plugin's harness manifest at
 * <pluginRoot>/.claude-plugin/harness.json. Returns null if absent.
 *
 * Manifest shape:
 *   {
 *     "pools": [
 *       { "alias": "npu", "pool": "npu-910b" },
 *       { "alias": "gpu", "pool": "gpu-h100", "require": { "cuda": ">=12" } }
 *     ]
 *   }
 *
 * Each entry in the returned `requests` array is what the broker
 * acquire() call needs.
 */
export function pluginManifestRequests(pluginRoot) {
  const path = join(pluginRoot, ".claude-plugin", "harness.json");
  if (!existsSync(path)) return null;
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`harness.json parse error at ${path}: ${e.message}`);
  }
  const pools = Array.isArray(raw.pools) ? raw.pools : [];
  return pools_to_requests(pools, path);
}

function pools_to_requests(entries, sourcePath) {
  const requests = [];
  const aliases = new Set();
  for (const entry of entries) {
    if (!entry?.pool || typeof entry.pool !== "string") {
      throw new Error(`harness.json (${sourcePath}): entry missing 'pool' string`);
    }
    const alias = entry.alias || entry.pool;
    if (aliases.has(alias)) {
      throw new Error(`harness.json (${sourcePath}): duplicate alias ${alias}`);
    }
    aliases.add(alias);
    requests.push({
      alias,
      pool: entry.pool,
      require: entry.require || {},
    });
  }
  return requests;
}

/**
 * Build pool acquire requests from a CLI-supplied comma-separated pool
 * list (--pool npu-910b,gpu-h100). Used when no plugin manifest is in
 * play. Aliases are derived from the pool id (uppercased, hyphens →
 * underscores).
 */
export function explicitPoolRequests(poolList) {
  const out = [];
  const seen = new Set();
  for (const raw of String(poolList || "").split(",")) {
    const pool = raw.trim();
    if (!pool || seen.has(pool)) continue;
    seen.add(pool);
    out.push({
      alias: aliasFromPool(pool),
      pool,
      require: {},
    });
  }
  return out;
}

function aliasFromPool(pool) {
  return pool.replace(/[^A-Za-z0-9_]/g, "_");
}

// ---------- acquire / release / heartbeat -------------------------------

/**
 * Acquire every pool in `requests` from the broker. If any acquire
 * fails, roll back already-acquired leases.
 *
 *   acquireGroup({ broker, requests, owner, purpose, ttlSec })
 *     → { ok: true, leases: [{alias, leaseId, hostAlias, host, ...}] }
 *     | { ok: false, error, kind, rolledBack: N }
 */
export async function acquireGroup({ broker, requests, owner, purpose, ttlSec = 600 }) {
  const acquired = [];
  for (const req of requests) {
    try {
      const lease = await broker.acquire({
        pool: req.pool,
        require: req.require,
        owner,
        purpose,
        ttlSec,
      });
      const slot = (lease.slots && lease.slots[0]) || {};
      acquired.push({
        alias: req.alias,
        pool: lease.pool,
        leaseId: lease.lease_id,
        hostAlias: slot.host_alias || `harness-${slot.node_id}`,
        host: slot.host,
        port: Number(slot.env?.REMOTE_PORT) || null,
        user: slot.user,
        workdir: slot.workdir,
        env: slot.env || {},
        expiresAt: lease.expires_at,
        startedAt: lease.started_at,
      });
    } catch (err) {
      // rollback: release whatever we already acquired
      for (const got of acquired) {
        try { await broker.release(got.leaseId); } catch {}
      }
      return {
        ok: false,
        error: err?.message || String(err),
        kind: err?.kind || "unknown",
        rolledBack: acquired.length,
        failedPool: req.pool,
      };
    }
  }
  return { ok: true, leases: acquired };
}

/**
 * Best-effort release of every lease in the array. Failures land in
 * orphan_leases.json for retryOrphans / next-launch sweep. Never throws.
 *
 * Successfully-released ids are also dropped from orphan_leases.json so
 * an entry that got persisted on a prior unreachable-broker release
 * doesn't survive a later successful release of the same lease.
 */
export async function releaseAll({ broker, leases, stateDir }) {
  const released = [];
  const orphaned = [];
  for (const l of leases || []) {
    try {
      await broker.release(l.leaseId);
      released.push(l.leaseId);
    } catch (err) {
      orphaned.push({
        leaseId: l.leaseId,
        pool: l.pool,
        recordedAt: new Date().toISOString(),
        lastErr: err?.message || String(err),
      });
    }
  }
  if (stateDir) {
    if (released.length) dropOrphans(stateDir, released);
    if (orphaned.length) appendOrphans(stateDir, orphaned);
  }
  return { released, orphaned: orphaned.map((o) => o.leaseId) };
}

/**
 * One round of heartbeats across all leases. Returns ok/failed lists.
 * Caller decides whether to escalate (release everything if all fail).
 */
export async function heartbeatAll({ broker, leases }) {
  const ok = [];
  const failed = [];
  for (const l of leases || []) {
    try {
      await broker.heartbeat(l.leaseId);
      ok.push(l.leaseId);
    } catch (e) {
      failed.push({ leaseId: l.leaseId, error: e?.message || String(e) });
    }
  }
  return { ok, failed };
}

// ---------- env injection -----------------------------------------------

/**
 * Build the env vars handed to the cc subprocess so each declared alias
 * resolves to its lease's host alias + workdir without any local lookup.
 *
 * Aliases are uppercased and non-alphanumeric chars become underscores
 * so REMOTE_SSH_ALIAS_<ALIAS> is always a valid shell identifier.
 */
export function buildLeaseEnv(leases) {
  const env = {};
  if (!leases || leases.length === 0) return env;
  env.LEASE_IDS = leases.map((l) => l.leaseId).join(",");
  for (const l of leases) {
    const sfx = (l.alias || l.pool || "").toUpperCase().replace(/[^A-Z0-9_]/g, "_");
    if (!sfx) continue;
    env[`REMOTE_SSH_ALIAS_${sfx}`] = l.hostAlias;
    if (l.workdir) env[`REMOTE_WORKDIR_${sfx}`] = l.workdir;
    if (l.host) env[`REMOTE_HOST_${sfx}`] = l.host;
    if (l.port) env[`REMOTE_PORT_${sfx}`] = String(l.port);
    if (l.user) env[`REMOTE_USER_${sfx}`] = l.user;
  }
  return env;
}

// ---------- orphan persistence -----------------------------------------

export function loadOrphans(stateDir) {
  const path = join(stateDir, "orphan_leases.json");
  if (!existsSync(path)) return [];
  try {
    const raw = readFileSync(path, "utf8");
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch { return []; }
}

export function appendOrphans(stateDir, entries) {
  const cur = loadOrphans(stateDir);
  const next = [...cur, ...entries];
  writeOrphansFile(stateDir, next);
}

export function dropOrphan(stateDir, leaseId) {
  dropOrphans(stateDir, [leaseId]);
}

export function dropOrphans(stateDir, leaseIds) {
  if (!leaseIds?.length) return;
  const drop = new Set(leaseIds);
  const cur = loadOrphans(stateDir);
  const next = cur.filter((o) => !drop.has(o.leaseId));
  if (next.length === cur.length) return;
  writeOrphansFile(stateDir, next);
}

function writeOrphansFile(stateDir, list) {
  mkdirSync(stateDir, { recursive: true });
  const path = join(stateDir, "orphan_leases.json");
  if (!list.length) {
    try { unlinkSync(path); } catch {}
    return;
  }
  writeFileSync(path, JSON.stringify(list, null, 2) + "\n");
}

/**
 * Retry every persisted orphan release. Whatever succeeds gets dropped
 * from the file; whatever still fails stays for the next sweep.
 */
export async function retryOrphans({ broker, stateDir }) {
  const orphans = loadOrphans(stateDir);
  if (!orphans.length) return { retried: 0, released: 0, stillFailed: 0 };
  let released = 0;
  const remaining = [];
  for (const o of orphans) {
    try { await broker.release(o.leaseId); released++; }
    catch (e) { remaining.push({ ...o, lastErr: e?.message || String(e) }); }
  }
  writeOrphansFile(stateDir, remaining);
  return { retried: orphans.length, released, stillFailed: remaining.length };
}

// expose for tests
export const __test__ = { aliasFromPool, pools_to_requests };
