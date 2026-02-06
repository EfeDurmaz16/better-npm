import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "./spawn.js";

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function platformExe(name) {
  return process.platform === "win32" ? `${name}.exe` : name;
}

function betterInstallRoot() {
  // src/lib/core.js -> ../../ = repo/package root (works for local dev and installed package layout)
  return path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
}

export async function findBetterCore() {
  const envPath = process.env.BETTER_CORE_PATH;
  if (envPath && (await exists(envPath))) return envPath;

  const betterRoot = betterInstallRoot();
  const candidates = [
    // Cargo workspace target dirs.
    path.join(betterRoot, "crates", "target", "debug", platformExe("better-core")),
    path.join(betterRoot, "crates", "target", "release", platformExe("better-core")),
    // Fallback if the package is built standalone.
    path.join(betterRoot, "crates", "better-core", "target", "debug", platformExe("better-core")),
    path.join(betterRoot, "crates", "better-core", "target", "release", platformExe("better-core"))
  ];

  const existing = [];
  for (const candidate of candidates) {
    if (!(await exists(candidate))) continue;
    try {
      const st = await fs.stat(candidate);
      existing.push({ candidate, mtimeMs: Number(st.mtimeMs || 0) });
    } catch {
      existing.push({ candidate, mtimeMs: 0 });
    }
  }
  if (existing.length > 0) {
    // Prefer the most recently built local core binary to avoid stale release/debug mismatches.
    existing.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return existing[0].candidate;
  }

  // Try PATH.
  try {
    const probe = await runCommand(platformExe("better-core"), ["--help"], { passthroughStdio: false });
    if (probe.exitCode === 0) return platformExe("better-core");
  } catch {
    // ignore
  }
  return null;
}

export async function runBetterCoreAnalyze(corePath, projectRoot, opts = {}) {
  const args = ["analyze", "--root", projectRoot];
  if (opts.includeGraph) args.push("--graph");
  const res = await runCommand(corePath, args, { cwd: projectRoot, passthroughStdio: false, captureLimitBytes: 50 * 1024 * 1024 });
  if (res.exitCode !== 0) {
    const err = new Error(`better-core failed (exit ${res.exitCode})`);
    err.core = { ...res };
    throw err;
  }
  const json = JSON.parse(res.stdout);
  return json;
}

export async function runBetterCoreScan(corePath, rootDir) {
  const args = ["scan", "--root", rootDir];
  const res = await runCommand(corePath, args, { cwd: rootDir, passthroughStdio: false, captureLimitBytes: 50 * 1024 * 1024 });
  if (res.exitCode !== 0) {
    const err = new Error(`better-core scan failed (exit ${res.exitCode})`);
    err.core = { ...res };
    throw err;
  }
  const json = JSON.parse(res.stdout);
  return json;
}

export async function runBetterCoreMaterialize(corePath, srcDir, destDir, opts = {}) {
  const args = ["materialize", "--src", srcDir, "--dest", destDir];
  if (opts.linkStrategy) args.push("--link-strategy", String(opts.linkStrategy));
  const res = await runCommand(corePath, args, {
    cwd: path.dirname(destDir),
    passthroughStdio: false,
    captureLimitBytes: 50 * 1024 * 1024
  });
  let parsed = null;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    // ignore and surface process failure details below
  }
  if (res.exitCode !== 0) {
    const err = new Error(`better-core materialize failed (exit ${res.exitCode})`);
    err.core = { ...res, parsed };
    throw err;
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("better-core materialize returned invalid JSON");
  }
  return parsed;
}
