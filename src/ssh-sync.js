// Mirror the broker's ssh-bundle into ~/.ssh/. The plugin is the SOLE
// writer of these paths — never mix in user-edited content:
//
//   ~/.ssh/config.d/harness   — generated Host blocks
//   ~/.ssh/harness/<keyfile>  — broker-managed private keys (mode 0600)
//
// Last-installed ETag lives at <stateDir>/ssh-bundle.etag so the steady-
// state cost of a sync is one HTTP 304.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const HOME_SSH = join(homedir(), ".ssh");

export const HARNESS_KEY_DIR = join(HOME_SSH, "harness");
export const HARNESS_CONFIG_FILE = join(HOME_SSH, "config.d", "harness");
export const SSH_CONFIG_FILE = join(HOME_SSH, "config");
export const INCLUDE_LINE = "Include config.d/*";

const ETAG_FILE_NAME = "ssh-bundle.etag";

/**
 * Pull the bundle from the broker and atomically install it. ETag-cached:
 * subsequent calls hit 304 and short-circuit with no FS work.
 *
 *   syncSshBundle({ broker, stateDir })
 *     → { changed: false, etag, reason: "cached" }
 *     → { changed: true,  etag, version, keyCount, reason: "installed"|"rotated" }
 */
export async function syncSshBundle({ broker, stateDir }) {
  ensureSshConfigInclude();

  const cachedEtag = readEtag(stateDir);
  const bundle = await broker.getSshBundle({ etag: cachedEtag });
  if (bundle.notModified) {
    return { changed: false, etag: bundle.etag || cachedEtag, reason: "cached" };
  }

  installBundle(bundle);
  if (bundle.etag) writeEtag(stateDir, bundle.etag);
  return {
    changed: true,
    etag: bundle.etag,
    version: bundle.version,
    keyCount: (bundle.keys || []).length,
    reason: cachedEtag ? "rotated" : "installed",
  };
}

/**
 * Idempotent: ensure ~/.ssh/config has `Include config.d/*` at the top.
 * Creates the file (mode 0600) when absent.
 */
export function ensureSshConfigInclude() {
  mkdirSync(HOME_SSH, { recursive: true });
  try { chmodSync(HOME_SSH, 0o700); } catch {}

  let body = "";
  if (existsSync(SSH_CONFIG_FILE)) {
    body = readFileSync(SSH_CONFIG_FILE, "utf8");
    const present = body.split(/\r?\n/).some((line) => line.trim() === INCLUDE_LINE);
    if (present) return { wrote: false };
  }
  const next = body ? `${INCLUDE_LINE}\n\n${body}` : `${INCLUDE_LINE}\n`;
  atomicWrite(SSH_CONFIG_FILE, next, 0o600);
  return { wrote: true };
}

/**
 * Write the bundle to disk. Order matters: keys first, then config — so
 * SSH never sees a config block referencing a key file that hasn't
 * landed yet.
 */
export function installBundle(bundle) {
  ensureHarnessDirs();

  const keep = new Set();
  for (const k of bundle.keys || []) {
    if (!k?.filename || typeof k.content !== "string") continue;
    assertSafeBasename(k.filename);
    const target = join(HARNESS_KEY_DIR, k.filename);
    atomicWrite(target, k.content, parseMode(k.mode, 0o600));
    keep.add(k.filename);
  }

  // Drop any old key the broker no longer references. known_hosts and
  // dotfiles are preserved — they aren't broker-owned.
  for (const entry of safeReaddir(HARNESS_KEY_DIR)) {
    if (entry === "known_hosts" || entry.startsWith(".")) continue;
    if (!keep.has(entry)) {
      try { unlinkSync(join(HARNESS_KEY_DIR, entry)); } catch {}
    }
  }

  atomicWrite(HARNESS_CONFIG_FILE, bundle.config, 0o644);
}

// ---------- helpers --------------------------------------------------

function ensureHarnessDirs() {
  mkdirSync(HARNESS_KEY_DIR, { recursive: true });
  try { chmodSync(HARNESS_KEY_DIR, 0o700); } catch {}
  mkdirSync(dirname(HARNESS_CONFIG_FILE), { recursive: true });
}

function readEtag(stateDir) {
  try {
    return readFileSync(join(stateDir, ETAG_FILE_NAME), "utf8").trim() || null;
  } catch {
    return null;
  }
}

function writeEtag(stateDir, etag) {
  mkdirSync(stateDir, { recursive: true });
  atomicWrite(join(stateDir, ETAG_FILE_NAME), etag, 0o644);
}

function atomicWrite(target, content, mode) {
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, content);
  try { chmodSync(tmp, mode); } catch {}
  renameSync(tmp, target);
}

function safeReaddir(dir) {
  try { return readdirSync(dir); } catch { return []; }
}

function assertSafeBasename(name) {
  if (name.includes("/") || name.includes("\\") || name.startsWith(".")) {
    throw new Error(`ssh-sync: refusing unsafe filename: ${name}`);
  }
}

function parseMode(modeLike, fallback) {
  if (typeof modeLike === "number") return modeLike;
  if (typeof modeLike === "string" && /^[0-7]{3,4}$/.test(modeLike)) {
    return parseInt(modeLike, 8);
  }
  return fallback;
}
