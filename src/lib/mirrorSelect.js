/**
 * Registry mirror auto-select — v0.5 feature #25
 *
 * Reads the saved best mirror from ~/.better/config.json (written by
 * `better registry mirror-select --select`).  Falls back to the standard
 * npm registry when no preference has been saved.
 *
 * Used by the parallel resolver and fetch pipeline to pick the fastest
 * registry without requiring .npmrc edits.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const CONFIG_PATH = path.join(os.homedir(), ".better", "config.json");
const DEFAULT_REGISTRY = "https://registry.npmjs.org";

/** Read the saved best mirror URL. Returns null if not set. */
export function loadSavedMirror() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    const config = JSON.parse(raw);
    if (typeof config.registry === "string" && config.registry.startsWith("https://")) {
      return config.registry;
    }
  } catch {
    // Config missing or invalid — fall through
  }
  return null;
}

/**
 * Save the selected mirror URL to ~/.better/config.json.
 * Merges with existing config keys.
 */
export function saveMirror(url) {
  const configDir = path.dirname(CONFIG_PATH);
  fs.mkdirSync(configDir, { recursive: true });
  let config = {};
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch { /* fresh config */ }
  config.registry = url;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
}

/**
 * Determine the effective registry URL.
 *
 * Priority:
 *   1. `BETTER_REGISTRY` env var override
 *   2. Saved best mirror from ~/.better/config.json
 *   3. Default: https://registry.npmjs.org
 *
 * Note: .npmrc `registry=` is handled downstream by the pm CLI; this
 * function only affects the direct HTTPS fetch path used by the
 * parallel resolver.
 */
export function effectiveRegistry() {
  if (process.env.BETTER_REGISTRY) {
    return process.env.BETTER_REGISTRY;
  }
  return loadSavedMirror() ?? DEFAULT_REGISTRY;
}

/**
 * Probe mirrors using the Rust binary and optionally save the winner.
 * Falls back to a basic JS HTTP latency check if the binary is unavailable.
 */
export async function probeMirrors({ select = false, timeout = 5000 } = {}) {
  // Try Rust binary first
  try {
    const { findBetterCore } = await import("./core.js");
    const corePath = await findBetterCore();
    if (corePath) {
      const { spawnSync } = await import("node:child_process");
      const subcmd = select ? "mirror-select" : "mirror-probe";
      const args = select ? [subcmd, "--select"] : [subcmd];
      const result = spawnSync(corePath, ["registry", ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (result.stdout) {
        return JSON.parse(result.stdout.trim());
      }
    }
  } catch { /* fall through to JS */ }

  // Pure-JS fallback: basic latency check using fetch
  const KNOWN_MIRRORS = [
    { name: "npmjs", url: "https://registry.npmjs.org" },
    { name: "npmmirror (CN)", url: "https://registry.npmmirror.com" },
    { name: "yarn", url: "https://registry.yarnpkg.com" },
  ];

  const results = await Promise.all(
    KNOWN_MIRRORS.map(async ({ name, url }) => {
      const start = Date.now();
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        const resp = await fetch(`${url}/-/ping`, { signal: controller.signal });
        clearTimeout(timer);
        const latencyMs = Date.now() - start;
        return { name, url, ok: resp.ok, latencyMs, status: resp.status };
      } catch {
        return { name, url, ok: false, latencyMs: null, error: "timeout or error" };
      }
    })
  );

  results.sort((a, b) => {
    if (a.latencyMs !== null && b.latencyMs !== null) return a.latencyMs - b.latencyMs;
    if (a.latencyMs !== null) return -1;
    if (b.latencyMs !== null) return 1;
    return 0;
  });

  if (select) {
    const best = results.find((r) => r.ok);
    if (best) saveMirror(best.url);
    return {
      ok: !!best,
      kind: "better.registry.mirrorSelect",
      selected: best?.url ?? null,
      selectedName: best?.name ?? null,
      saved: !!best,
      mirrors: results,
    };
  }

  return {
    ok: true,
    kind: "better.registry.mirrorProbe",
    mirrors: results,
  };
}
