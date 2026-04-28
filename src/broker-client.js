// HTTP client for the harness-broker API (Jarvis JCL host, default :7778).
//
// All methods throw `BrokerError` on failure. Errors carry a `.kind`
// discriminator so the lease manager can decide whether to retry, surface,
// or release: "network" (transport), "http" (non-2xx), "missing" (404),
// "config" (caller bug).
//
// Bundle fetch supports If-None-Match → 304 short-circuit so ssh-sync
// can poll cheaply on every launch.

export class BrokerError extends Error {
  constructor(kind, message, { status = null, body = null } = {}) {
    super(message);
    this.name = "BrokerError";
    this.kind = kind;
    this.status = status;
    this.body = body;
  }
}

export class BrokerClient {
  constructor({ baseUrl, token = null, timeoutMs = 15_000 } = {}) {
    if (!baseUrl) throw new BrokerError("config", "BrokerClient: baseUrl required");
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.token = token;
    this.timeoutMs = timeoutMs;
  }

  // ---- read endpoints ---------------------------------------------

  async listPools() {
    return await this._unwrap(await this._send("GET", "/v1/pools"));
  }

  async listNodes(pool = null) {
    const qs = pool ? `?pool=${encodeURIComponent(pool)}` : "";
    return await this._unwrap(await this._send("GET", `/v1/nodes${qs}`));
  }

  // ---- lease lifecycle --------------------------------------------

  async acquire({
    pool, count = 1, require = {},
    owner = "openclaw", purpose = "", ttlSec = 600,
  } = {}) {
    if (!pool) throw new BrokerError("config", "acquire: pool is required");
    const resp = await this._send("POST", "/v1/acquire", {
      pool, count, require, owner, purpose, ttl_sec: ttlSec,
    });
    return await this._unwrap(resp);
  }

  async release(leaseId) {
    if (!leaseId) throw new BrokerError("config", "release: leaseId required");
    const resp = await this._send("POST", "/v1/release", { lease_id: leaseId });
    return await this._unwrap(resp);
  }

  async heartbeat(leaseId) {
    if (!leaseId) throw new BrokerError("config", "heartbeat: leaseId required");
    const resp = await this._send("POST", "/v1/heartbeat", { lease_id: leaseId });
    return await this._unwrap(resp);
  }

  // ---- ssh bundle --------------------------------------------------

  /**
   * Fetch the SSH bundle (config + key files). Pass the prior ETag to
   * get a 304 fast-path.
   *
   * Returns either:
   *   { notModified: true, etag }                                     — 304
   *   { notModified: false, etag, version, config, keys }             — 200
   */
  async getSshBundle({ etag = null } = {}) {
    const headers = etag ? { "If-None-Match": etag } : {};
    const resp = await this._send("GET", "/v1/ssh-bundle", null, headers);
    const newEtag = resp.headers.get("etag");
    if (resp.status === 304) {
      return { notModified: true, etag: newEtag || etag };
    }
    if (!resp.ok) {
      const body = await safeText(resp);
      throw new BrokerError("http", `ssh-bundle ${resp.status}`, { status: resp.status, body });
    }
    const json = await resp.json();
    return {
      notModified: false,
      etag: newEtag,
      version: json.version,
      config: json.config,
      keys: Array.isArray(json.keys) ? json.keys : [],
    };
  }

  // ---- write side: lifecycle ---------------------------------------

  async _send(method, path, body = null, extraHeaders = {}) {
    const headers = { ...extraHeaders };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (body !== null) headers["Content-Type"] = "application/json";
    try {
      return await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body == null ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new BrokerError("network", `${method} ${path}: ${err?.message || err}`);
    }
  }

  async _send_post(path, body = null) {
    return await this._send("POST", path, body);
  }

  async _unwrap(resp) {
    if (resp.status === 404) {
      throw new BrokerError("missing", `${resp.url} 404`, { status: 404 });
    }
    if (!resp.ok) {
      const body = await safeText(resp);
      throw new BrokerError("http", `${resp.url} ${resp.status}`, { status: resp.status, body });
    }
    if (resp.status === 204) return null;
    const ct = resp.headers.get("content-type") || "";
    if (ct.includes("application/json")) return await resp.json();
    return await resp.text();
  }
}

async function safeText(resp) {
  try { return await resp.text(); } catch { return null; }
}
