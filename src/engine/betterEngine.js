/**
 * BetterEngine — pure Rust materialisation via NAPI.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { EngineBase } from "./interface.js";
import { tryLoadNapiAddon, runBetterCoreFetchAndExtractNapi, runBetterCoreMaterializeBatchNapi } from "../lib/core.js";

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

export class BetterEngine extends EngineBase {
  get name() { return "better"; }

  buildCommand(_projectRoot, _opts = {}) {
    return { cmd: "better", args: ["install", "--engine", "better"] };
  }

  async resolve(projectRoot, _opts = {}) {
    const lockPath = path.join(projectRoot, "package-lock.json");
    const hasLock = await exists(lockPath);

    let packageCount = 0;
    if (hasLock) {
      try {
        const raw = JSON.parse(await fs.readFile(lockPath, "utf8"));
        packageCount = Object.keys(raw?.packages ?? raw?.dependencies ?? {}).length;
      } catch { /* ignore */ }
    }

    return {
      ok: hasLock,
      lockfile: lockPath,
      packageCount,
      reason: hasLock ? undefined : "package-lock.json not found (required for better engine)"
    };
  }

  async install(projectRoot, _plan, opts = {}) {
    const start = Date.now();
    const layout = opts.layout ?? null;
    if (!layout) {
      return {
        ok: false,
        wallTimeMs: 0,
        exitCode: 1,
        stdout: "",
        stderr: "",
        reason: "better engine requires opts.layout (CAS cache layout)"
      };
    }

    const lockfilePath = path.join(projectRoot, "package-lock.json");
    const cacheDir = layout.pm?.npm ?? layout.root;

    // Try NAPI first (Rust engine)
    const addon = tryLoadNapiAddon();
    if (addon) {
      try {
        const fetchResult = runBetterCoreFetchAndExtractNapi(lockfilePath, cacheDir, {
          linkStrategy: opts.linkStrategy ?? "auto",
        });
        if (fetchResult?.ok === false) {
          return {
            ok: false,
            wallTimeMs: Date.now() - start,
            exitCode: 1,
            stdout: "",
            stderr: fetchResult.reason ?? "fetch failed",
            reason: fetchResult.reason ?? "fetch failed",
          };
        }
        return {
          ok: true,
          wallTimeMs: Date.now() - start,
          exitCode: 0,
          stdout: "",
          stderr: "",
        };
      } catch (err) {
        return {
          ok: false,
          wallTimeMs: Date.now() - start,
          exitCode: 1,
          stdout: "",
          stderr: String(err?.message ?? err),
          reason: String(err?.message ?? err),
        };
      }
    }

    return {
      ok: false,
      wallTimeMs: Date.now() - start,
      exitCode: 1,
      stdout: "",
      stderr: "No Rust engine available. Run `npm run napi:build` or `npm run core:build`.",
      reason: "No Rust engine available. Run `npm run napi:build` or `npm run core:build`.",
    };
  }

  async verify(projectRoot, _opts = {}) {
    const errors = [];
    const warnings = [];
    const lockPath = path.join(projectRoot, "package-lock.json");
    if (!(await exists(lockPath))) {
      errors.push("package-lock.json not found (required for better engine)");
    }
    const nmPath = path.join(projectRoot, "node_modules");
    if (!(await exists(nmPath))) {
      errors.push("node_modules not found");
    }
    return { ok: errors.length === 0, errors, warnings };
  }
}
