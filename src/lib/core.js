import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
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

// --- napi addon loading ---

let _napiAddon = undefined;

export function tryLoadNapiAddon() {
  if (_napiAddon !== undefined) return _napiAddon;
  const require = createRequire(import.meta.url);
  const root = betterInstallRoot();
  const platform = process.platform;
  const arch = process.arch;
  const napiTriple =
    platform === "darwin" && arch === "arm64" ? "darwin-arm64" :
    platform === "darwin" && arch === "x64" ? "darwin-x64" :
    platform === "linux" && arch === "x64" ? "linux-x64-gnu" :
    platform === "linux" && arch === "arm64" ? "linux-arm64-gnu" :
    null;
  const candidates = [];
  if (napiTriple) {
    // Platform-specific pre-built addon (CI artifact)
    candidates.push(path.join(root, "crates", "better-napi", `better-core.${napiTriple}.node`));
  }
  // Generic local dev build
  candidates.push(path.join(root, "crates", "better-napi", "better-core.node"));
  // Fallback: old hardcoded name
  if (napiTriple === "darwin-arm64") {
    candidates.push(path.join(root, "crates", "better-napi", "better-core.darwin-arm64.node"));
  }
  for (const p of candidates) {
    try {
      _napiAddon = require(p);
      return _napiAddon;
    } catch {
      continue;
    }
  }
  _napiAddon = null;
  return null;
}

export function runBetterCoreAnalyzeNapi(projectRoot, opts = {}) {
  const addon = tryLoadNapiAddon();
  if (!addon) throw new Error("napi addon not available");
  const result = addon.analyze(projectRoot, !!opts.includeGraph);
  if (!result || typeof result !== "object") throw new Error("napi analyze returned invalid result");
  return result;
}

export function runBetterCoreScanNapi(rootDir) {
  const addon = tryLoadNapiAddon();
  if (!addon) throw new Error("napi addon not available");
  const result = addon.scan(rootDir);
  if (!result || typeof result !== "object") throw new Error("napi scan returned invalid result");
  return result;
}

export function runBetterCoreMaterializeNapi(srcDir, destDir, opts = {}) {
  const addon = tryLoadNapiAddon();
  if (!addon) throw new Error("napi addon not available");
  const napiOpts = {};
  if (opts.linkStrategy) napiOpts.linkStrategy = String(opts.linkStrategy);
  if (opts.jobs != null) napiOpts.jobs = Number(opts.jobs);
  if (opts.profile) napiOpts.profile = String(opts.profile);
  const result = addon.materialize(srcDir, destDir, napiOpts);
  if (!result || typeof result !== "object") throw new Error("napi materialize returned invalid result");
  return result;
}

export function runBetterCoreMaterializeBatchNapi(entries, opts = {}) {
  const addon = tryLoadNapiAddon();
  if (!addon || typeof addon.materializeBatch !== "function") return null;
  const napiOpts = {};
  if (opts.linkStrategy) napiOpts.linkStrategy = String(opts.linkStrategy);
  if (opts.profile) napiOpts.profile = String(opts.profile);
  const result = addon.materializeBatch(entries, napiOpts);
  if (!result || typeof result !== "object") throw new Error("napi materializeBatch returned invalid result");
  return result;
}

export function runBetterCoreFetchAndExtractNapi(lockfilePath, cacheDir, opts = {}) {
  const addon = tryLoadNapiAddon();
  if (!addon || typeof addon.fetchAndExtract !== "function") return null;
  const napiOpts = {};
  if (opts.linkStrategy) napiOpts.linkStrategy = String(opts.linkStrategy);
  if (opts.jobs != null) napiOpts.jobs = Number(opts.jobs);
  const result = addon.fetchAndExtract(lockfilePath, cacheDir, napiOpts);
  if (!result || typeof result !== "object") throw new Error("napi fetchAndExtract returned invalid result");
  return result;
}

// --- NAPI: audit ---
export function runAuditNapi(projectRoot, opts = {}) {
  const addon = tryLoadNapiAddon();
  if (!addon || typeof addon.audit !== "function") return null;
  const result = addon.audit(projectRoot, opts.minSeverity || undefined);
  if (!result || typeof result !== "object") throw new Error("napi audit returned invalid result");
  return result;
}

// --- NAPI: smart audit ---
export function runSmartAuditNapi(projectRoot, opts = {}) {
  const addon = tryLoadNapiAddon();
  if (!addon || typeof addon.smartAudit !== "function") return null;
  const result = addon.smartAudit({
    projectRoot,
    rootDeps: opts.rootDeps || {},
    rootDevDeps: opts.rootDevDeps || {},
    rootOptionalDeps: opts.rootOptionalDeps || {},
    depGraph: opts.depGraph || {},
    resolvedVersions: opts.resolvedVersions || {},
    prodOnly: !!opts.prodOnly,
    minScore: opts.minScore != null ? opts.minScore : null,
    ignoreDev: !!opts.ignoreDev,
    fixableOnly: !!opts.fixableOnly,
    minSeverity: opts.minSeverity || null,
  });
  if (!result || typeof result !== "object") throw new Error("napi smartAudit returned invalid result");
  return result;
}

// --- NAPI: license ---
export function runLicenseNapi(projectRoot, opts = {}) {
  const addon = tryLoadNapiAddon();
  if (!addon || typeof addon.license !== "function") return null;
  const result = addon.license(projectRoot, opts.allow || undefined, opts.deny || undefined);
  if (!result || typeof result !== "object") throw new Error("napi license returned invalid result");
  return result;
}

// --- NAPI: outdated ---
export function runOutdatedNapi(projectRoot) {
  const addon = tryLoadNapiAddon();
  if (!addon || typeof addon.outdated !== "function") return null;
  const result = addon.outdated(projectRoot);
  if (!result || typeof result !== "object") throw new Error("napi outdated returned invalid result");
  return result;
}

// --- NAPI: doctor ---
export function runDoctorNapi(projectRoot, opts = {}) {
  const addon = tryLoadNapiAddon();
  if (!addon || typeof addon.doctor !== "function") return null;
  const result = addon.doctor(projectRoot, opts.threshold || undefined);
  if (!result || typeof result !== "object") throw new Error("napi doctor returned invalid result");
  return result;
}

// --- NAPI: why ---
export function runWhyNapi(projectRoot, target) {
  const addon = tryLoadNapiAddon();
  if (!addon || typeof addon.why !== "function") return null;
  const result = addon.why(projectRoot, target);
  if (!result || typeof result !== "object") throw new Error("napi why returned invalid result");
  return result;
}

// --- NAPI: dedupe ---
export function runDedupeNapi(projectRoot) {
  const addon = tryLoadNapiAddon();
  if (!addon || typeof addon.dedupe !== "function") return null;
  const result = addon.dedupe(projectRoot);
  if (!result || typeof result !== "object") throw new Error("napi dedupe returned invalid result");
  return result;
}

// --- NAPI: workspace list ---
export function runWorkspaceListNapi(projectRoot) {
  const addon = tryLoadNapiAddon();
  if (!addon || typeof addon.workspaceList !== "function") return null;
  const result = addon.workspaceList(projectRoot);
  if (!result || typeof result !== "object") throw new Error("napi workspaceList returned invalid result");
  return result;
}

// --- NAPI: workspace graph ---
export function runWorkspaceGraphNapi(projectRoot) {
  const addon = tryLoadNapiAddon();
  if (!addon || typeof addon.workspaceGraph !== "function") return null;
  const result = addon.workspaceGraph(projectRoot);
  if (!result || typeof result !== "object") throw new Error("napi workspaceGraph returned invalid result");
  return result;
}

// --- NAPI: policy check ---
export function runPolicyCheckNapi(projectRoot) {
  const addon = tryLoadNapiAddon();
  if (!addon || typeof addon.policyCheck !== "function") return null;
  const result = addon.policyCheck(projectRoot);
  if (!result || typeof result !== "object") throw new Error("napi policyCheck returned invalid result");
  return result;
}

// --- NAPI: supply chain analysis ---
export function runAnalyzeSupplyChainNapi(projectRoot) {
  const addon = tryLoadNapiAddon();
  if (!addon || typeof addon.analyzeSupplyChain !== "function") return null;
  const result = addon.analyzeSupplyChain(projectRoot);
  if (!result || typeof result !== "object") throw new Error("napi analyzeSupplyChain returned invalid result");
  return result;
}

// --- NAPI: typosquat check ---
export function runCheckTyposquatNapi(name, knownPackages) {
  const addon = tryLoadNapiAddon();
  if (!addon || typeof addon.checkTyposquat !== "function") return null;
  return addon.checkTyposquat(name, knownPackages ?? []);
}

// --- NAPI: ecosystem detection ---
export function runDetectEcosystemsNapi(projectRoot) {
  const addon = tryLoadNapiAddon();
  if (!addon || typeof addon.detectEcosystems !== "function") return null;
  return addon.detectEcosystems(projectRoot);
}

// --- NAPI: OSP discovery ---
export function runOspDiscoverNapi(query, category) {
  const addon = tryLoadNapiAddon();
  if (!addon || typeof addon.ospDiscover !== "function") return null;
  const json = addon.ospDiscover(query, category ?? null);
  try { return JSON.parse(json); } catch { return []; }
}

// --- NAPI: OSP services list ---
export function runOspServicesListNapi() {
  const addon = tryLoadNapiAddon();
  if (!addon || typeof addon.ospServicesList !== "function") return null;
  const json = addon.ospServicesList();
  try { return JSON.parse(json); } catch { return []; }
}

// --- NAPI: OSP deprovision ---
export function runOspDeprovisionNapi(providerId, offering) {
  const addon = tryLoadNapiAddon();
  if (!addon || typeof addon.ospDeprovisionService !== "function") return null;
  const json = addon.ospDeprovisionService(providerId, offering);
  try { return JSON.parse(json); } catch { return null; }
}

// --- NAPI: OSP env generate ---
export function runOspEnvGenerateNapi(projectRoot) {
  const addon = tryLoadNapiAddon();
  if (!addon || typeof addon.ospEnvGenerate !== "function") return null;
  const json = addon.ospEnvGenerate(projectRoot);
  try { return JSON.parse(json); } catch { return null; }
}

// --- NAPI: monetize earnings ---
export function runFetchEarningsNapi(periodDays, withBreakdown) {
  const addon = tryLoadNapiAddon();
  if (!addon || typeof addon.fetchEarnings !== "function") return null;
  const json = addon.fetchEarnings(periodDays ?? 30, withBreakdown ?? false);
  try { return JSON.parse(json); } catch { return null; }
}

// --- NAPI: pay package ---
export function runPayPackageNapi(packageName, amount, currency) {
  const addon = tryLoadNapiAddon();
  if (!addon || typeof addon.payPackage !== "function") return null;
  const json = addon.payPackage(packageName, amount, currency ?? "USD");
  try { return JSON.parse(json); } catch { return null; }
}

// --- NAPI: smart upgrade planner ---
export function runPlanSmartUpgradeNapi(projectRoot, packageName, fromVersion, toVersion, changelogText, dryRun, minReputationScore) {
  const addon = tryLoadNapiAddon();
  if (!addon || typeof addon.planSmartUpgrade !== "function") return null;
  const json = addon.planSmartUpgrade(
    projectRoot, packageName, fromVersion ?? "", toVersion ?? "",
    changelogText ?? null, dryRun ?? false, minReputationScore ?? 40
  );
  try { return JSON.parse(json); } catch { return null; }
}

// --- NAPI: changelog analysis ---
export function runAnalyzeChangelogNapi(packageName, fromVersion, toVersion, changelogText) {
  const addon = tryLoadNapiAddon();
  if (!addon || typeof addon.analyzeChangelog !== "function") return null;
  const json = addon.analyzeChangelog(packageName, fromVersion ?? "", toVersion ?? "", changelogText ?? "");
  try { return JSON.parse(json); } catch { return null; }
}

// --- NAPI: predictive maintenance ---
export function runPredictMaintenanceNapi(packageName, ecosystem, version) {
  const addon = tryLoadNapiAddon();
  if (!addon || typeof addon.predictMaintenance !== "function") return null;
  const json = addon.predictMaintenance(packageName, ecosystem ?? "npm", version ?? "latest");
  try { return JSON.parse(json); } catch { return null; }
}

// --- NAPI: impact analysis ---
export function runAnalyzeImpactNapi(projectRoot, packageName, version, dependents, transitiveRemoveCount, pkgSizeBytes) {
  const addon = tryLoadNapiAddon();
  if (!addon || typeof addon.analyzeImpact !== "function") return null;
  const json = addon.analyzeImpact(
    projectRoot, packageName, version ?? "",
    dependents ?? [], transitiveRemoveCount ?? 0, pkgSizeBytes ?? 0
  );
  try { return JSON.parse(json); } catch { return null; }
}

// --- NAPI: reputation score ---
export function runReputationScoreNapi(packageName, ecosystem, version) {
  const addon = tryLoadNapiAddon();
  if (!addon || typeof addon.reputationScore !== "function") return null;
  const json = addon.reputationScore(packageName, ecosystem ?? "npm", version ?? "latest");
  try { return JSON.parse(json); } catch { return null; }
}

// --- NAPI: create sponsorship ---
export function runCreateSponsorshipNapi(packageName, monthlyAmount, currency) {
  const addon = tryLoadNapiAddon();
  if (!addon || typeof addon.createSponsorship !== "function") return null;
  const json = addon.createSponsorship(packageName, monthlyAmount, currency ?? "USD");
  try { return JSON.parse(json); } catch { return null; }
}

export async function runBetterCoreInstall(corePath, projectRoot, opts = {}) {
  const args = ["install", "--project-root", projectRoot];
  if (opts.lockfile) args.push("--lockfile", String(opts.lockfile));
  if (opts.cacheRoot) args.push("--cache-root", String(opts.cacheRoot));
  if (opts.storeRoot) args.push("--store-root", String(opts.storeRoot));
  if (opts.linkStrategy) args.push("--link-strategy", String(opts.linkStrategy));
  if (opts.jobs != null) args.push("--jobs", String(opts.jobs));
  if (opts.scripts === false) args.push("--no-scripts");
  if (opts.dedup) args.push("--dedup");
  if (opts.offline) args.push("--offline");
  if (opts.nodeLayout === "strict") args.push("--strict");
  else if (opts.nodeLayout === "hoist") args.push("--hoist");
  const res = await runCommand(corePath, args, {
    cwd: projectRoot,
    passthroughStdio: false,
    captureLimitBytes: 50 * 1024 * 1024
  });
  let parsed = null;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    // ignore parse failure, surface process error below
  }
  if (res.exitCode !== 0) {
    const err = new Error(`better-core install failed (exit ${res.exitCode})`);
    err.core = { ...res, parsed };
    throw err;
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("better-core install returned invalid JSON");
  }
  return parsed;
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
