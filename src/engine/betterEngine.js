/**
 * BetterEngine — pure Rust materialisation via NAPI + installFromNpmLockfile.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { EngineBase } from "./interface.js";
import { installFromNpmLockfile } from "./better/installBetterNpm.js";

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
    // layout is optional here — callers that need CAS layout must pass it via opts.layout
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

    const result = await installFromNpmLockfile(projectRoot, layout, {
      verify: opts.verify ?? "integrity-required",
      linkStrategy: opts.linkStrategy ?? "auto",
      scripts: opts.scripts ?? "rebuild",
      binLinks: opts.binLinks ?? "rootOnly",
      incremental: opts.incremental ?? true,
      fsConcurrency: opts.fsConcurrency ?? 16
    });

    return {
      ok: result.ok !== false,
      wallTimeMs: Date.now() - start,
      exitCode: result.ok !== false ? 0 : 1,
      stdout: "",
      stderr: result.reason ?? "",
      reason: result.ok !== false ? undefined : result.reason
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
