import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildLeaseEnv,
  explicitPoolRequests,
  releaseAll,
  retryOrphans,
  loadOrphans,
  appendOrphans,
  dropOrphans,
} from "../src/lease-manager.js";

const freshDir = () => mkdtempSync(join(tmpdir(), "lease-test-"));

// — explicitPoolRequests --------------------------------------------------

test("explicitPoolRequests splits comma list and derives sanitized aliases", () => {
  const r = explicitPoolRequests("npu-pool, gpu-pool , npu-pool");
  assert.deepEqual(r, [
    { alias: "npu_pool", pool: "npu-pool", require: {} },
    { alias: "gpu_pool", pool: "gpu-pool", require: {} },
  ]);
});

// — buildLeaseEnv ---------------------------------------------------------

test("buildLeaseEnv produces alias-suffixed env vars", () => {
  const leases = [
    { alias: "npu", pool: "npu-pool", leaseId: "L1",
      hostAlias: "harness-ascend", host: "1.2.3.4", user: "root", workdir: "/w", port: null },
    { alias: "gpu", pool: "gpu-pool", leaseId: "L2",
      hostAlias: "harness-h100", host: "10.0.0.1", user: "u", workdir: "/g", port: 22 },
  ];
  const env = buildLeaseEnv(leases);
  assert.equal(env.LEASE_IDS, "L1,L2");
  assert.equal(env.REMOTE_SSH_ALIAS_NPU, "harness-ascend");
  assert.equal(env.REMOTE_SSH_ALIAS_GPU, "harness-h100");
  assert.equal(env.REMOTE_HOST_NPU, "1.2.3.4");
  assert.equal(env.REMOTE_PORT_GPU, "22");
  // null port shouldn't leak as the literal string "null"
  assert.equal(env.REMOTE_PORT_NPU, undefined);
});

// ---- orphan cleanup paths ----------------------------------------------

test("releaseAll drops successfully-released ids from orphan_leases.json", async () => {
  const stateDir = freshDir();
  appendOrphans(stateDir, [
    { leaseId: "L1", pool: "p", recordedAt: "x", lastErr: "boom" },
  ]);
  assert.equal(loadOrphans(stateDir).length, 1);

  const broker = { async release() { /* succeed */ } };
  const r = await releaseAll({ broker, leases: [{ leaseId: "L1", pool: "p" }], stateDir });

  assert.deepEqual(r.released, ["L1"]);
  assert.deepEqual(r.orphaned, []);
  assert.equal(loadOrphans(stateDir).length, 0,
    "successful release should delete matching orphan record");
});

test("releaseAll persists an orphan when broker release rejects", async () => {
  const stateDir = freshDir();
  const broker = { async release() { throw new Error("network down"); } };
  const r = await releaseAll({ broker, leases: [{ leaseId: "L1", pool: "p" }], stateDir });
  assert.deepEqual(r.released, []);
  assert.deepEqual(r.orphaned, ["L1"]);
  const orphans = loadOrphans(stateDir);
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0].leaseId, "L1");
  assert.match(orphans[0].lastErr, /network down/);
});

test("dropOrphans removes only listed ids", () => {
  const stateDir = freshDir();
  appendOrphans(stateDir, [
    { leaseId: "A", pool: "p", recordedAt: "x", lastErr: "x" },
    { leaseId: "B", pool: "p", recordedAt: "x", lastErr: "x" },
    { leaseId: "C", pool: "p", recordedAt: "x", lastErr: "x" },
  ]);
  dropOrphans(stateDir, ["A", "C"]);
  assert.deepEqual(loadOrphans(stateDir).map((o) => o.leaseId), ["B"]);
});

test("retryOrphans releases all and clears file on full success", async () => {
  const stateDir = freshDir();
  appendOrphans(stateDir, [
    { leaseId: "X", pool: "p", recordedAt: "x", lastErr: "x" },
    { leaseId: "Y", pool: "p", recordedAt: "x", lastErr: "x" },
  ]);
  const broker = { async release() { /* ok */ } };
  const r = await retryOrphans({ broker, stateDir });
  assert.deepEqual(r, { retried: 2, released: 2, stillFailed: 0 });
  assert.equal(loadOrphans(stateDir).length, 0);
});

test("retryOrphans keeps still-failing entries with refreshed lastErr", async () => {
  const stateDir = freshDir();
  appendOrphans(stateDir, [
    { leaseId: "OK", pool: "p", recordedAt: "x", lastErr: "old" },
    { leaseId: "BAD", pool: "p", recordedAt: "x", lastErr: "old" },
  ]);
  const broker = {
    async release(id) { if (id === "BAD") throw new Error("still down"); },
  };
  const r = await retryOrphans({ broker, stateDir });
  assert.equal(r.released, 1);
  assert.equal(r.stillFailed, 1);
  const left = loadOrphans(stateDir);
  assert.deepEqual(left.map((o) => o.leaseId), ["BAD"]);
  assert.match(left[0].lastErr, /still down/);
});
