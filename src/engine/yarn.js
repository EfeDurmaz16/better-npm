/**
 * YarnEngine — wraps the `yarn` CLI (classic v1 and Berry v2+).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { EngineBase } from "./interface.js";
import { runCommand } from "../lib/spawn.js";

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function detectBerry(projectRoot) {
  return exists(path.join(projectRoot, ".yarnrc.yml"));
}

export class YarnEngine extends EngineBase {
  get name() { return "yarn"; }

  async buildCommand(projectRoot, opts = {}) {
    const berry = await detectBerry(projectRoot);
    const args = ["install"];
    if (opts.frozen) {
      args.push(berry ? "--immutable" : "--frozen-lockfile");
    }
    if (opts.production && !berry) args.push("--production");
    if (opts.passthrough?.length) args.push(...opts.passthrough);
    return { cmd: "yarn", args };
  }

  async resolve(projectRoot, _opts = {}) {
    const lockPath = path.join(projectRoot, "yarn.lock");
    const hasLock = await exists(lockPath);

    let packageCount = 0;
    if (hasLock) {
      try {
        const raw = await fs.readFile(lockPath, "utf8");
        // Each entry starts with a quoted package name or a bare name at col 0
        packageCount = (raw.match(/^"?[\w@].*"?:$/gm) ?? []).length;
      } catch { /* ignore */ }
    }

    return {
      ok: true,
      lockfile: lockPath,
      packageCount
    };
  }

  async install(projectRoot, _plan, opts = {}) {
    const { cmd, args } = await this.buildCommand(projectRoot, opts);
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
      reason: result.exitCode !== 0 ? `yarn exited ${result.exitCode}` : undefined
    };
  }

  async verify(projectRoot, _opts = {}) {
    const errors = [];
    const warnings = [];
    const lockPath = path.join(projectRoot, "yarn.lock");
    if (!(await exists(lockPath))) {
      warnings.push("yarn.lock not found");
    }
    const nmPath = path.join(projectRoot, "node_modules");
    const berry = await detectBerry(projectRoot);
    if (!berry && !(await exists(nmPath))) {
      errors.push("node_modules not found");
    }
    return { ok: errors.length === 0, errors, warnings };
  }
}
