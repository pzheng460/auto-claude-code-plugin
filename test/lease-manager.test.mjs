import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendOrphans,
  buildLeaseEnv,
  dropOrphans,
  explicitPoolRequests,
  loadOrphans,
  pluginManifestRender,
  pluginManifestRequests,
  releaseAll,
  renderTemplates,
  retryOrphans,
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
      hostAlias: "harness-ascend", host: "1.2.3.4", user: "root", workdir: "/w", port: null,
      keyPath: "~/.ssh/harness/npu.pem" },
    { alias: "gpu", pool: "gpu-pool", leaseId: "L2",
      hostAlias: "harness-h100", host: "10.0.0.1", user: "u", workdir: "/g", port: 22,
      keyPath: null },
  ];
  const env = buildLeaseEnv(leases);
  assert.equal(env.LEASE_IDS, "L1,L2");
  assert.equal(env.REMOTE_SSH_ALIAS_NPU, "harness-ascend");
  assert.equal(env.REMOTE_SSH_ALIAS_GPU, "harness-h100");
  assert.equal(env.REMOTE_HOST_NPU, "1.2.3.4");
  assert.equal(env.REMOTE_KEY_PATH_NPU, "~/.ssh/harness/npu.pem");
  assert.equal(env.REMOTE_PORT_GPU, "22");
  assert.equal(env.REMOTE_PORT_NPU, undefined);
  assert.equal(env.REMOTE_KEY_PATH_GPU, undefined,
    "null keyPath should NOT emit an env var");
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

// ---- harness.json render directives + renderTemplates ------------------

function pluginRootWith(harnessJson, templates = {}) {
  const root = freshDir();
  mkdirSync(`${root}/.claude-plugin`, { recursive: true });
  writeFileSync(`${root}/.claude-plugin/harness.json`, JSON.stringify(harnessJson, null, 2));
  for (const [path, body] of Object.entries(templates)) {
    const full = join(root, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, body);
  }
  return root;
}

test("pluginManifestRender returns null when harness.json has no render array", () => {
  const root = pluginRootWith({ pools: [{ alias: "npu", pool: "npu-pool" }] });
  assert.equal(pluginManifestRender(root), null);
});

test("pluginManifestRender normalizes directives", () => {
  const root = pluginRootWith({
    pools: [],
    render: [
      { template: "tmpl/a.tmpl", target: "~/.foo/a.yaml" },                 // backup defaults to true
      { template: "tmpl/b.tmpl", target: "/tmp/b.yaml", backup: false },
      { template: 123, target: "x" },                                       // bad → filtered
    ],
  });
  const out = pluginManifestRender(pluginRootWith({ pools: [], render: [] }));  // empty manifest
  assert.equal(out, null);

  const ds = pluginManifestRender(root);
  assert.equal(ds.length, 2);
  assert.equal(ds[0].backup, true);
  assert.equal(ds[1].backup, false);
});

test("renderTemplates substitutes ${VAR} and ${VAR:-default}", () => {
  const root = pluginRootWith(
    {},
    { "config.yaml.tmpl": "host: ${REMOTE_HOST_NPU}\nport: ${REMOTE_PORT_NPU:-22}\nrole: ${MISSING:-fallback}\n" },
  );
  const target = join(freshDir(), "deep", "subdir", "out.yaml");
  const out = renderTemplates({
    pluginRoot: root,
    directives: [{ template: "config.yaml.tmpl", target, backup: false }],
    env: { REMOTE_HOST_NPU: "1.2.3.4" },
  });
  assert.deepEqual(out.errors, []);
  assert.equal(out.rendered.length, 1);
  assert.equal(readFileSync(target, "utf8"), "host: 1.2.3.4\nport: 22\nrole: fallback\n".replace("port: 22", "port: 22"));
});

test("renderTemplates backs up an existing target when backup=true", () => {
  const stateDir = freshDir();
  const target = join(stateDir, "config.yaml");
  writeFileSync(target, "OLD CONTENT\n");

  const root = pluginRootWith({}, { "t.tmpl": "NEW ${X}\n" });
  const out = renderTemplates({
    pluginRoot: root,
    directives: [{ template: "t.tmpl", target, backup: true }],
    env: { X: "DATA" },
  });
  assert.equal(out.errors.length, 0);
  assert.equal(readFileSync(target, "utf8"), "NEW DATA\n");

  const siblings = readdirSync(stateDir);
  const backup = siblings.find((f) => f.startsWith("config.yaml.before-pool-"));
  assert.ok(backup, `expected a backup file, got ${siblings.join(",")}`);
  assert.equal(readFileSync(join(stateDir, backup), "utf8"), "OLD CONTENT\n");
});

test("renderTemplates reports missing template without throwing", () => {
  const root = freshDir();
  const out = renderTemplates({
    pluginRoot: root,
    directives: [{ template: "nope.tmpl", target: join(freshDir(), "x.yaml") }],
    env: {},
  });
  assert.equal(out.rendered.length, 0);
  assert.equal(out.errors.length, 1);
  assert.match(out.errors[0].error, /template not found/);
});

test("renderTemplates skips directives missing template/target", () => {
  const out = renderTemplates({
    pluginRoot: freshDir(),
    directives: [{ template: "x" }, {}],
    env: {},
  });
  assert.equal(out.rendered.length, 0);
  assert.equal(out.errors.length, 2);
});
