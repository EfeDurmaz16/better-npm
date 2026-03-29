/**
 * NpmEngine — wraps the `npm` CLI.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { EngineBase } from "./interface.js";
import { runCommand } from "../lib/spawn.js";

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

export class NpmEngine extends EngineBase {
  get name() { return "npm"; }

  buildCommand(projectRoot, opts = {}) {
    const args = ["install"];
    if (opts.frozen) args.push("--frozen-lockfile");
    if (opts.production) args.push("--omit=dev");
    if (opts.passthrough?.length) args.push(...opts.passthrough);
    return { cmd: "npm", args };
  }

  async resolve(projectRoot, _opts = {}) {
    const lockPath = path.join(projectRoot, "package-lock.json");
    const shrinkPath = path.join(projectRoot, "npm-shrinkwrap.json");
    let lockfile = null;
    if (await exists(lockPath)) lockfile = lockPath;
    else if (await exists(shrinkPath)) lockfile = shrinkPath;

    let packageCount = 0;
    if (lockfile) {
      try {
        const raw = JSON.parse(await fs.readFile(lockfile, "utf8"));
        packageCount = Object.keys(raw?.packages ?? raw?.dependencies ?? {}).length;
      } catch { /* ignore */ }
    }

    return {
      ok: true,
      lockfile: lockfile ?? path.join(projectRoot, "package-lock.json"),
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
      reason: result.exitCode !== 0 ? `npm exited ${result.exitCode}` : undefined
    };
  }

  async verify(projectRoot, _opts = {}) {
    const errors = [];
    const warnings = [];
    const lockPath = path.join(projectRoot, "package-lock.json");
    if (!(await exists(lockPath))) {
      warnings.push("package-lock.json not found");
    }
    const nmPath = path.join(projectRoot, "node_modules");
    if (!(await exists(nmPath))) {
      errors.push("node_modules not found");
    }
    return { ok: errors.length === 0, errors, warnings };
  }
}
