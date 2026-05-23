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

// --- NAPI: audit fix planner ---
export function runPlanAuditFixesNapi(projectRoot, vulnerabilitiesJson, forceMajor) {
  const addon = tryLoadNapiAddon();
  if (!addon || typeof addon.planAuditFixes !== "function") return null;
  const json = addon.planAuditFixes(projectRoot, vulnerabilitiesJson ?? "[]", forceMajor ?? false);
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

export function runReviewDependenciesNapi(projectRoot) {
  const addon = tryLoadNapiAddon();
  if (!addon?.reviewDependencies) return null;
  const json = addon.reviewDependencies(projectRoot);
  try { return JSON.parse(json); } catch { return null; }
}

export function runSelfHealNapi(projectRoot, dryRun) {
  const addon = tryLoadNapiAddon();
  if (!addon?.selfHeal) return null;
  const json = addon.selfHeal(projectRoot, dryRun === true);
  try { return JSON.parse(json); } catch { return null; }
}

export function runHealProjectNapi(projectRoot, dryRun) {
  const addon = tryLoadNapiAddon();
  if (!addon?.healProject) return null;
  const json = addon.healProject(projectRoot, dryRun === true);
  try { return JSON.parse(json); } catch { return null; }
}

export function runAnalyzeOrgNapi(rootDir) {
  const addon = tryLoadNapiAddon();
  if (!addon?.analyzeOrg) return null;
  const json = addon.analyzeOrg(rootDir);
  try { return JSON.parse(json); } catch { return null; }
}

export function runGenerateSbomNapi(projectRoot, lockfilePath, format, includeVex) {
  const addon = tryLoadNapiAddon();
  if (!addon?.generateSbom) return null;
  const json = addon.generateSbom(projectRoot, lockfilePath, format ?? "cyclonedx", includeVex === true);
  try { return JSON.parse(json); } catch { return null; }
}

export function runPlanPipelineNapi(pipelineJson, projectRoot) {
  const addon = tryLoadNapiAddon();
  if (!addon?.planPipeline) return null;
  const json = addon.planPipeline(pipelineJson, projectRoot);
  try { return JSON.parse(json); } catch { return null; }
}

export function runSignKeygenNapi(keyName) {
  const addon = tryLoadNapiAddon();
  if (!addon?.signKeygen) return null;
  const json = addon.signKeygen(keyName);
  try { return JSON.parse(json); } catch { return null; }
}

export function runSignVerifyNapi(signaturePath, tarballHash) {
  const addon = tryLoadNapiAddon();
  if (!addon?.signVerify) return null;
  const json = addon.signVerify(signaturePath, tarballHash);
  try { return JSON.parse(json); } catch { return null; }
}

export function runGenerateBuildManifestNapi(projectRoot) {
  const addon = tryLoadNapiAddon();
  if (!addon?.generateBuildManifest) return null;
  const json = addon.generateBuildManifest(projectRoot);
  try { return JSON.parse(json); } catch { return null; }
}

export function runVerifyReproducibilityNapi(projectRoot) {
  const addon = tryLoadNapiAddon();
  if (!addon?.verifyReproducibility) return null;
  const json = addon.verifyReproducibility(projectRoot);
  try { return JSON.parse(json); } catch { return null; }
}

export function runPlanMigrationNapi(fromPkg, toPkg, projectRoot) {
  const addon = tryLoadNapiAddon();
  if (!addon?.planMigration) return null;
  const json = addon.planMigration(fromPkg, toPkg, projectRoot ?? process.cwd());
  try { return JSON.parse(json); } catch { return null; }
}

export function runCheckApprovalsNapi(projectRoot) {
  const addon = tryLoadNapiAddon();
  if (!addon?.checkApprovals) return null;
  const json = addon.checkApprovals(projectRoot);
  try { return JSON.parse(json); } catch { return null; }
}

export function runSelectMirrorNapi(timeoutMs) {
  const addon = tryLoadNapiAddon();
  if (!addon?.selectMirror) return null;
  const json = addon.selectMirror(timeoutMs ?? 5000);
  try { return JSON.parse(json); } catch { return null; }
}

export function runLoadBestMirrorNapi() {
  const addon = tryLoadNapiAddon();
  if (!addon?.loadBestMirror) return null;
  const json = addon.loadBestMirror();
  try { return JSON.parse(json); } catch { return null; }
}

export function runSandboxScanNapi(projectRoot) {
  const addon = tryLoadNapiAddon();
  if (!addon?.sandboxScan) return null;
  const json = addon.sandboxScan(projectRoot);
  try { return JSON.parse(json); } catch { return null; }
}

export function runDiffLockSnapshotsNapi(baseSnapshot, headSnapshot) {
  const addon = tryLoadNapiAddon();
  if (!addon?.diffLockSnapshots) return null;
  const json = addon.diffLockSnapshots(JSON.stringify(baseSnapshot ?? {}), JSON.stringify(headSnapshot ?? {}));
  try { return JSON.parse(json); } catch { return null; }
}

export function runCheckCompatNapi(projectRoot, targetVersion) {
  const addon = tryLoadNapiAddon();
  if (!addon?.checkCompat) return null;
  const json = addon.checkCompat(projectRoot, targetVersion ?? process.version.slice(1));
  try { return JSON.parse(json); } catch { return null; }
}

export function runCollectSignalsNapi(packageName, ecosystem, version) {
  const addon = tryLoadNapiAddon();
  if (!addon?.collectSignals) return null;
  const json = addon.collectSignals(packageName, ecosystem ?? "npm", version ?? "latest");
  try { return JSON.parse(json); } catch { return null; }
}

export function runScanScriptsNapi(projectRoot) {
  const addon = tryLoadNapiAddon();
  if (!addon?.scanScripts) return null;
  const json = addon.scanScripts(projectRoot);
  try { return JSON.parse(json); } catch { return null; }
}

export function runGenerateCostReportNapi(services, previousMonthTotal, currentDay) {
  const addon = tryLoadNapiAddon();
  if (!addon?.generateCostReport) return null;
  const json = addon.generateCostReport(JSON.stringify(services ?? []), previousMonthTotal ?? 0, currentDay ?? new Date().getDate());
  try { return JSON.parse(json); } catch { return null; }
}

export function runSuggestDepsNapi(projectRoot) {
  const addon = tryLoadNapiAddon();
  if (!addon?.suggestDeps) return null;
  const json = addon.suggestDeps(projectRoot);
  try { return JSON.parse(json); } catch { return null; }
}

export function runDetectUnusedNapi(projectRoot) {
  const addon = tryLoadNapiAddon();
  if (!addon?.detectUnused) return null;
  const json = addon.detectUnused(projectRoot);
  try { return JSON.parse(json); } catch { return null; }
}

export function runFirewallNapi(projectRoot) {
  const addon = tryLoadNapiAddon();
  if (!addon?.runFirewall) return null;
  const json = addon.runFirewall(projectRoot);
  try { return JSON.parse(json); } catch { return null; }
}

export function runDetectFrameworkNapi(projectRoot) {
  const addon = tryLoadNapiAddon();
  if (!addon?.detectFramework) return null;
  const json = addon.detectFramework(projectRoot);
  try { return JSON.parse(json); } catch { return null; }
}

export function runPinVersionsNapi(projectRoot, packages, unpin, dryRun) {
  const addon = tryLoadNapiAddon();
  if (!addon?.pinVersions) return null;
  const json = addon.pinVersions(projectRoot, JSON.stringify(packages ?? []), unpin === true, dryRun === true);
  try { return JSON.parse(json); } catch { return null; }
}

export function runVerifyProvenanceNapi(projectRoot, mode) {
  const addon = tryLoadNapiAddon();
  if (!addon?.verifyProvenance) return null;
  const json = addon.verifyProvenance(projectRoot, mode ?? "verify");
  try { return JSON.parse(json); } catch { return null; }
}

export function runScanProjectsNapi(roots) {
  const addon = tryLoadNapiAddon();
  if (!addon?.scanProjects) return null;
  const json = addon.scanProjects(JSON.stringify(roots));
  try { return JSON.parse(json); } catch { return null; }
}

export function runAuditEngineNapi(projectRoot, ecosystem) {
  const addon = tryLoadNapiAddon();
  if (!addon?.auditEngine) return null;
  const json = addon.auditEngine(projectRoot, ecosystem ?? null);
  try { return JSON.parse(json); } catch { return null; }
}

export function runOutdatedEngineNapi(projectRoot, ecosystem) {
  const addon = tryLoadNapiAddon();
  if (!addon?.outdatedEngine) return null;
  const json = addon.outdatedEngine(projectRoot, ecosystem ?? null);
  try { return JSON.parse(json); } catch { return null; }
}

export function runGetEnvInfoNapi(projectRoot) {
  const addon = tryLoadNapiAddon();
  if (!addon?.getEnvInfo) return null;
  const json = addon.getEnvInfo(projectRoot);
  try { return JSON.parse(json); } catch { return null; }
}

export function runDetectLockfilesNapi(projectRoot) {
  const addon = tryLoadNapiAddon();
  if (!addon?.detectLockfiles) return null;
  const json = addon.detectLockfiles(projectRoot);
  try { return JSON.parse(json); } catch { return null; }
}

export function runBenchmarkNapi(projectRoot, rounds, pms) {
  const addon = tryLoadNapiAddon();
  if (!addon?.runBenchmark) return null;
  const json = addon.runBenchmark(projectRoot, rounds ?? 3, JSON.stringify(pms ?? []));
  try { return JSON.parse(json); } catch { return null; }
}

export function runCalculateCasStatsNapi() {
  const addon = tryLoadNapiAddon();
  if (!addon?.calculateCasStats) return null;
  const json = addon.calculateCasStats();
  try { return JSON.parse(json); } catch { return null; }
}

export function runListReceiptsNapi(projectRoot) {
  const addon = tryLoadNapiAddon();
  if (!addon?.listReceipts) return null;
  const json = addon.listReceipts(projectRoot);
  try { return JSON.parse(json); } catch { return null; }
}

export function runVerifyReceiptNapi(projectRoot) {
  const addon = tryLoadNapiAddon();
  if (!addon?.verifyReceipt) return null;
  const json = addon.verifyReceipt(projectRoot);
  try { return JSON.parse(json); } catch { return null; }
}

export function runHooksInstallNapi(projectRoot) {
  const addon = tryLoadNapiAddon();
  if (!addon?.hooksInstall) return null;
  const json = addon.hooksInstall(projectRoot);
  try { return JSON.parse(json); } catch { return null; }
}

export function runValidateCommitMsgNapi(message) {
  const addon = tryLoadNapiAddon();
  if (!addon?.validateCommitMsg) return null;
  const json = addon.validateCommitMsg(message);
  try { return JSON.parse(json); } catch { return null; }
}

export function runGetTelemetryStatusNapi() {
  const addon = tryLoadNapiAddon();
  if (!addon?.getTelemetryStatus) return null;
  const json = addon.getTelemetryStatus();
  try { return JSON.parse(json); } catch { return null; }
}

export function runSetTelemetryEnabledNapi(enabled) {
  const addon = tryLoadNapiAddon();
  if (!addon?.setTelemetryEnabled) return null;
  const json = addon.setTelemetryEnabled(enabled === true);
  try { return JSON.parse(json); } catch { return null; }
}

export function runLoadLockSnapshotNapi(projectRoot) {
  const addon = tryLoadNapiAddon();
  if (!addon?.loadLockSnapshot) return null;
  const json = addon.loadLockSnapshot(projectRoot);
  try { return JSON.parse(json); } catch { return null; }
}

export function runCiNapi(projectRoot, options) {
  const addon = tryLoadNapiAddon();
  if (!addon?.runCi) return null;
  const json = addon.runCi(projectRoot, JSON.stringify(options ?? {}));
  try { return JSON.parse(json); } catch { return null; }
}

export function runDoctorV2Napi(projectRoot) {
  const addon = tryLoadNapiAddon();
  if (!addon?.doctorV2) return null;
  const json = addon.doctorV2(projectRoot);
  try { return JSON.parse(json); } catch { return null; }
}

export function runGraphStatsNapi(projectRoot) {
  const addon = tryLoadNapiAddon();
  if (!addon?.graphStats) return null;
  const json = addon.graphStats(projectRoot);
  try { return JSON.parse(json); } catch { return null; }
}

export function runGenerateLockMetadataNapi(projectRoot) {
  const addon = tryLoadNapiAddon();
  if (!addon?.generateLockMetadata) return null;
  const json = addon.generateLockMetadata(projectRoot);
  try { return JSON.parse(json); } catch { return null; }
}

export function runVerifyLockMetadataNapi(projectRoot) {
  const addon = tryLoadNapiAddon();
  if (!addon?.verifyLockMetadata) return null;
  const json = addon.verifyLockMetadata(projectRoot);
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
