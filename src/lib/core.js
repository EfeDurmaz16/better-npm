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

  const preferredProfile = String(process.env.BETTER_CORE_PROFILE ?? "release").toLowerCase() === "debug"
    ? "debug"
    : "release";
  const profileRank = preferredProfile === "debug"
    ? { debug: 0, release: 1 }
    : { release: 0, debug: 1 };
  const betterRoot = betterInstallRoot();
  const candidates = [
    // Cargo workspace target dirs.
    { candidate: path.join(betterRoot, "crates", "target", "release", platformExe("better-core")), profile: "release" },
    { candidate: path.join(betterRoot, "crates", "target", "debug", platformExe("better-core")), profile: "debug" },
    // Fallback if the package is built standalone.
    { candidate: path.join(betterRoot, "crates", "better-core", "target", "release", platformExe("better-core")), profile: "release" },
    { candidate: path.join(betterRoot, "crates", "better-core", "target", "debug", platformExe("better-core")), profile: "debug" }
  ];

  const existing = [];
  for (const { candidate, profile } of candidates) {
    if (!(await exists(candidate))) continue;
    try {
      const st = await fs.stat(candidate);
      existing.push({ candidate, profile, mtimeMs: Number(st.mtimeMs || 0) });
    } catch {
      existing.push({ candidate, profile, mtimeMs: 0 });
    }
  }
  if (existing.length > 0) {
    // Prefer profile (release by default), then most recent build in that profile.
    existing.sort((a, b) => {
      const byProfile = (profileRank[a.profile] ?? 99) - (profileRank[b.profile] ?? 99);
      if (byProfile !== 0) return byProfile;
      return b.mtimeMs - a.mtimeMs;
    });
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
  if (opts.jobs != null) args.push("--jobs", String(opts.jobs));
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
