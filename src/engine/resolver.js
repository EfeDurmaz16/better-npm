/**
 * Parallel resolution engine (#22).
 *
 * Fetches npm packument metadata concurrently with:
 *   - Up to CONCURRENCY parallel HTTPS requests
 *   - In-flight deduplication (same package requested twice → same Promise)
 *   - LRU-style in-memory cache for repeated calls within a session
 *   - Semver range resolution to pick the best matching version
 *
 * This module is designed to be used by `better install` for fast
 * dependency graph traversal without shelling out to npm/pnpm.
 *
 * Usage:
 *   import { ParallelResolver } from "./resolver.js";
 *   const resolver = new ParallelResolver({ concurrency: 32 });
 *   const version = await resolver.resolveVersion("lodash", "^4.0.0");
 *   const manifest = await resolver.fetchManifest("lodash", "4.17.21");
 */

import https from "node:https";
import { effectiveRegistry } from "../lib/mirrorSelect.js";

const DEFAULT_CONCURRENCY = 32;
const DEFAULT_REGISTRY = "https://registry.npmjs.org";

// Semver helpers — zero dependency, handles common cases

function parseSemver(v) {
  const m = String(v ?? "0.0.0")
    .replace(/^[^0-9]*/, "")
    .match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3] };
}

function semverGt(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return false;
  if (pa.major !== pb.major) return pa.major > pb.major;
  if (pa.minor !== pb.minor) return pa.minor > pb.minor;
  return pa.patch > pb.patch;
}

/**
 * Check if version `v` satisfies a semver range string.
 * Handles: exact, ^, ~, >=, <=, >, <, *, latest, x.x.x
 *
 * This is intentionally minimal — full semver ranges are left to the pm CLI.
 * We only need enough for dependency resolution preflight.
 */
function satisfies(v, range) {
  if (!range || range === "*" || range === "latest" || range === "") return true;
  const pv = parseSemver(v);
  if (!pv) return false;

  // Exact
  if (/^\d/.test(range)) {
    const pr = parseSemver(range);
    return pr && pr.major === pv.major && pr.minor === pv.minor && pr.patch === pv.patch;
  }

  // Caret: ^X.Y.Z — compatible with X (major must match, unless major=0)
  if (range.startsWith("^")) {
    const pr = parseSemver(range.slice(1));
    if (!pr) return false;
    if (pr.major > 0) return pv.major === pr.major && !semverGt(pr, v);
    if (pr.minor > 0) return pv.major === 0 && pv.minor === pr.minor && !semverGt(pr, v);
    return pv.major === 0 && pv.minor === 0 && !semverGt(pr, v);
  }

  // Tilde: ~X.Y.Z — compatible with X.Y (patch-level changes)
  if (range.startsWith("~")) {
    const pr = parseSemver(range.slice(1));
    if (!pr) return false;
    return pv.major === pr.major && pv.minor === pr.minor && !semverGt(pr, v);
  }

  // >= X.Y.Z
  if (range.startsWith(">=")) {
    const pr = parseSemver(range.slice(2));
    return pr && !semverGt(pr, v);
  }

  // > X.Y.Z
  if (range.startsWith(">")) {
    const pr = parseSemver(range.slice(1));
    return pr && semverGt(v, range.slice(1));
  }

  // <= X.Y.Z
  if (range.startsWith("<=")) {
    const pr = parseSemver(range.slice(2));
    return pr && !semverGt(v, range.slice(2));
  }

  // < X.Y.Z
  if (range.startsWith("<")) {
    const pr = parseSemver(range.slice(1));
    return pr && !semverGt(v, range.slice(1)) && v !== range.slice(1);
  }

  return false;
}

/**
 * Pick the highest version that satisfies the range.
 */
function bestVersion(versions, range) {
  // Filter to satisfying versions, then pick highest
  const matching = Object.keys(versions).filter(v => satisfies(v, range));
  if (matching.length === 0) return null;
  return matching.reduce((best, v) => (semverGt(v, best) ? v : best));
}

export class ParallelResolver {
  /**
   * @param {Object} opts
   * @param {number} [opts.concurrency=32]
   * @param {string} [opts.registry]
   * @param {number} [opts.timeoutMs=8000]
   */
  constructor(opts = {}) {
    this.concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
    this.registry = (opts.registry ?? effectiveRegistry()).replace(/\/$/, "");
    this.timeoutMs = opts.timeoutMs ?? 8000;

    // In-flight deduplication: name → Promise<packument>
    /** @type {Map<string, Promise<Object|null>>} */
    this._inflight = new Map();

    // Session cache: name → packument
    /** @type {Map<string, Object>} */
    this._cache = new Map();

    // Semaphore: count of active requests
    this._active = 0;
    this._queue = [];
  }

  /**
   * Fetch a full packument (all version metadata) for a package.
   * Deduplicates concurrent identical requests.
   *
   * @param {string} name
   * @returns {Promise<Object|null>}
   */
  fetchPackument(name) {
    if (this._cache.has(name)) {
      return Promise.resolve(this._cache.get(name));
    }
    if (this._inflight.has(name)) {
      return this._inflight.get(name);
    }

    const p = this._throttled(() => this._doFetch(`/${encodeURIComponent(name)}`))
      .then((data) => {
        this._cache.set(name, data);
        this._inflight.delete(name);
        return data;
      })
      .catch(() => {
        this._inflight.delete(name);
        return null;
      });

    this._inflight.set(name, p);
    return p;
  }

  /**
   * Fetch a specific version manifest.
   * @param {string} name
   * @param {string} version - exact version
   * @returns {Promise<Object|null>}
   */
  async fetchManifest(name, version) {
    const packument = await this.fetchPackument(name);
    return packument?.versions?.[version] ?? null;
  }

  /**
   * Resolve a semver range to the best matching version.
   * @param {string} name
   * @param {string} range - semver range string
   * @returns {Promise<string|null>} resolved version or null
   */
  async resolveVersion(name, range) {
    // Handle "latest" tag
    if (range === "latest") {
      const packument = await this.fetchPackument(name);
      return packument?.["dist-tags"]?.latest ?? null;
    }

    const packument = await this.fetchPackument(name);
    if (!packument?.versions) return null;

    return bestVersion(packument.versions, range);
  }

  /**
   * Batch-resolve multiple packages concurrently.
   * Returns a Map<name, resolvedVersion>.
   *
   * @param {Array<{name: string, range: string}>} deps
   * @returns {Promise<Map<string, string|null>>}
   */
  async resolveBatch(deps) {
    const results = await Promise.allSettled(
      deps.map(({ name, range }) =>
        this.resolveVersion(name, range).then(v => ({ name, version: v }))
      )
    );

    const map = new Map();
    for (const r of results) {
      if (r.status === "fulfilled" && r.value) {
        map.set(r.value.name, r.value.version);
      }
    }
    return map;
  }

  /**
   * Warm the cache by pre-fetching packuments for a list of package names.
   * @param {string[]} names
   */
  async prefetch(names) {
    await Promise.allSettled(names.map(n => this.fetchPackument(n)));
  }

  /** Clear the in-memory session cache. */
  clearCache() {
    this._cache.clear();
  }

  // --- Internal: rate-limited request dispatcher ---

  _throttled(fn) {
    return new Promise((resolve, reject) => {
      const run = () => {
        this._active++;
        Promise.resolve(fn())
          .then(resolve, reject)
          .finally(() => {
            this._active--;
            if (this._queue.length > 0) {
              const next = this._queue.shift();
              next();
            }
          });
      };

      if (this._active < this.concurrency) {
        run();
      } else {
        this._queue.push(run);
      }
    });
  }

  _doFetch(urlPath) {
    return new Promise((resolve, reject) => {
      const url = this.registry + urlPath;
      const req = https.get(url, {
        headers: {
          "Accept": "application/vnd.npm.install-v1+json, application/json",
          "User-Agent": "better-npm/0.1"
        },
        timeout: this.timeoutMs
      }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", c => { body += c; });
        res.on("end", () => {
          try { resolve(JSON.parse(body)); }
          catch { resolve(null); }
        });
      });
      req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
      req.on("error", reject);
    });
  }
}

/**
 * Module-level default resolver instance.
 * Shared across calls in the same process for maximum cache reuse.
 */
let _default = null;

export function getDefaultResolver(opts = {}) {
  if (!_default) _default = new ParallelResolver(opts);
  return _default;
}
