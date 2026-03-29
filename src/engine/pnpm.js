/**
 * PnpmEngine — wraps the `pnpm` CLI.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { EngineBase } from "./interface.js";
import { runCommand } from "../lib/spawn.js";

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

export class PnpmEngine extends EngineBase {
  get name() { return "pnpm"; }

  buildCommand(_projectRoot, opts = {}) {
    const args = ["install"];
    if (opts.frozen) args.push("--frozen-lockfile");
    if (opts.production) args.push("--prod");
    if (opts.passthrough?.length) args.push(...opts.passthrough);
    return { cmd: "pnpm", args };
  }

  async resolve(projectRoot, _opts = {}) {
    const lockPath = path.join(projectRoot, "pnpm-lock.yaml");
    const hasLock = await exists(lockPath);

    let packageCount = 0;
    if (hasLock) {
      try {
        // Count "packages:" section entries via line scan (no yaml dep needed)
        const raw = await fs.readFile(lockPath, "utf8");
        packageCount = (raw.match(/^  \/.+:/gm) ?? []).length;
      } catch { /* ignore */ }
    }

    return {
      ok: true,
      lockfile: lockPath,
      packageCount
    };
  }

  async install(projectRoot, _plan, opts = {}) {
    const { cmd, args } = this.buildCommand(projectRoot, opts);
    const start = Date.now();
    const result = await runCommand(cmd, args, {
      cwd: projectRoot,
      env: opts.env,
      passthroughStdio: !opts.json
    });
    return {
      ok: result.exitCode === 0,
      wallTimeMs: Date.now() - start,
      exitCode: result.exitCode ?? 0,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      reason: result.exitCode !== 0 ? `pnpm exited ${result.exitCode}` : undefined
    };
  }

  async verify(projectRoot, _opts = {}) {
    const errors = [];
    const warnings = [];
    const lockPath = path.join(projectRoot, "pnpm-lock.yaml");
    if (!(await exists(lockPath))) {
      warnings.push("pnpm-lock.yaml not found");
    }
    const nmPath = path.join(projectRoot, "node_modules");
    if (!(await exists(nmPath))) {
      errors.push("node_modules not found");
    }
    return { ok: errors.length === 0, errors, warnings };
  }
}
