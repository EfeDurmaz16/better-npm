import { parseArgs } from "node:util";
import path from "node:path";
import fs from "node:fs/promises";
import { getCacheRoot, cacheLayout, ensureCacheDirs, loadState, saveState } from "../lib/cache.js";
import { nowIso } from "../lib/time.js";
import { shortHash } from "../lib/hash.js";
import { scanTreeWithBestEngine } from "../lib/scanFacade.js";
import { runCommand } from "../lib/spawn.js";
import { detectPackageManager } from "../pm/detect.js";
import { printJson, printText } from "../lib/output.js";
import { createParityContext, runParityCheck } from "../parity/checker.js";
import { installFromNpmLockfile } from "../engine/better/installBetterNpm.js";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";
import { getRuntimeConfig } from "../lib/config.js";
import { childLogger } from "../lib/log.js";
import { collectNodeModulesSnapshot } from "../lib/nodeModules.js";
import { estimatePackagesFromLockfile } from "../lib/lockfile.js";
import {
  deriveGlobalCacheContext,
  verifyGlobalCacheEntry,
  materializeFromGlobalCache,
  captureProjectNodeModulesToGlobalCache,
  entryBytesFromNodeModulesSnapshot
} from "../lib/globalCache.js";
import { evaluateReuseMarker, writeReuseMarker } from "../lib/reuseMarker.js";
import { findBetterCore } from "../lib/core.js";

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function copyIfExists(src, dst) {
  if (!(await exists(src))) return false;
  await fs.copyFile(src, dst);
  return true;
}

async function makeBaselineProject(layout, projectRoot) {
  const baselineRoot = path.join(layout.tmpDir, `baseline-${Date.now()}-${shortHash(projectRoot)}`);
  await fs.mkdir(baselineRoot, { recursive: true });

  const files = [
    "package.json",
    "package-lock.json",
    "npm-shrinkwrap.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    ".yarnrc.yml",
    ".npmrc",
    ".pnpmfile.cjs"
  ];

  for (const f of files) {
    await copyIfExists(path.join(projectRoot, f), path.join(baselineRoot, f));
  }

  return baselineRoot;
}

async function rmrf(p) {
  await fs.rm(p, { recursive: true, force: true });
}

async function readJsonFileOrNull(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function loadPmCacheSnapshotStore(layout) {
  const snapshotFile = path.join(layout.root, "pm-cache-snapshots.json");
  const parsed = await readJsonFileOrNull(snapshotFile);
  return {
    file: snapshotFile,
    snapshots: parsed?.snapshots && typeof parsed.snapshots === "object" ? parsed.snapshots : {}
  };
}

function pmCacheSnapshotKey(pmCacheDir) {
  return path.resolve(pmCacheDir);
}

function snapshotToCacheResult(entry) {
  if (!entry || typeof entry !== "object") return { ok: false, reason: "snapshot_missing" };
  const logicalBytes = Number(entry.logicalBytes);
  const physicalBytes = Number(entry.physicalBytes);
  if (!Number.isFinite(logicalBytes) || !Number.isFinite(physicalBytes)) {
    return { ok: false, reason: "snapshot_invalid" };
  }
  return {
    ok: true,
    logicalBytes,
    physicalBytes,
    physicalBytesApprox: true,
    source: "snapshot_index",
    snapshotUpdatedAt: entry.updatedAt ?? null
  };
}

async function persistPmCacheSnapshot(layout, snapshotStore, pmCacheDir, sample) {
  if (!sample?.ok) return;
  const key = pmCacheSnapshotKey(pmCacheDir);
  snapshotStore.snapshots[key] = {
    logicalBytes: Number(sample.logicalBytes ?? 0),
    physicalBytes: Number(sample.physicalBytes ?? 0),
    updatedAt: nowIso()
  };
  const payload = {
    schemaVersion: 1,
    snapshots: snapshotStore.snapshots
  };
  await fs.writeFile(snapshotStore.file, `${JSON.stringify(payload, null, 2)}\n`);
}

function suggestFsConcurrencyTuning({ engine, fsConcurrency, globalMaterialize }) {
  if (engine !== "better" || !globalMaterialize?.ok) return null;
  const durationMs = Number(globalMaterialize.durationMs ?? 0);
  const files = Number(globalMaterialize.stats?.files ?? 0);
  if (!Number.isFinite(durationMs) || durationMs <= 0 || files <= 0) return null;
  const lower = Math.max(4, Math.floor(fsConcurrency / 2));
  const upper = Math.min(64, fsConcurrency * 2);
  const candidates = [...new Set([lower, fsConcurrency, upper])].sort((a, b) => a - b);
  const recommended = durationMs > 8000 ? upper : durationMs < 2500 ? lower : fsConcurrency;
  return {
    kind: "fs_concurrency",
    reason: "materialize_duration_based",
    current: fsConcurrency,
    recommended,
    candidates,
    durationMs,
    files
  };
}

function pmInstallCommand(pm, passthrough, engine, opts = {}) {
  const { frozen = false, production = false, yarnBerry = false } = opts;
  if (engine === "better") {
    return { cmd: "better", args: ["install", "--engine", "better", ...passthrough] };
  }
  if (engine === "bun") {
    const args = ["install"];
    if (frozen) args.push("--frozen-lockfile");
    if (production) args.push("--production");
    return { cmd: "bun", args: [...args, ...passthrough] };
  }
  if (pm === "pnpm") {
    const args = ["install"];
    if (frozen) args.push("--frozen-lockfile");
    if (production) args.push("--prod");
    return { cmd: "pnpm", args: [...args, ...passthrough] };
  }
  if (pm === "yarn") {
    const args = ["install"];
    if (frozen) {
      args.push(yarnBerry ? "--immutable" : "--frozen-lockfile");
    }
    if (production) args.push("--production");
    return { cmd: "yarn", args: [...args, ...passthrough] };
  }
  if (frozen) {
    const args = ["ci"];
    if (production) args.push("--omit=dev");
    return { cmd: "npm", args: [...args, ...passthrough] };
  }
  const args = ["install"];
  if (production) args.push("--omit=dev");
  return { cmd: "npm", args: [...args, ...passthrough] };
}

function pmEnv(pm, layout, engine) {
  const tmp = layout.tmpDir;
  const base = { TMPDIR: tmp, TEMP: tmp, TMP: tmp };
  if (engine === "bun") {
    return {
      ...base,
      // In sandboxed environments, bun may not be able to write to the user-level BUN_INSTALL dir.
      // Point it at Better's cache root so installs remain functional and isolated.
      BUN_INSTALL: layout.pm.bunHome,
      BUN_INSTALL_CACHE_DIR: layout.pm.bun || layout.pm.npm
    };
  }
  if (pm === "pnpm") {
    return {
      ...base,
      PNPM_STORE_PATH: layout.pm.pnpmStore,
      NPM_CONFIG_USERCONFIG: process.env.NPM_CONFIG_USERCONFIG
    };
  }
  if (pm === "yarn") {
    return {
      ...base,
      YARN_CACHE_FOLDER: layout.pm.yarn
    };
  }
  return {
    ...base,
    npm_config_cache: layout.pm.npm
  };
}

function collectUnknownFlagArgs(values, knownKeys) {
  const args = [];
  for (const [key, value] of Object.entries(values)) {
    if (knownKeys.has(key)) continue;
    if (value === false || value == null) continue;
    const prefix = key.length === 1 ? "-" : "--";
    if (value === true) {
      args.push(`${prefix}${key}`);
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        args.push(`${prefix}${key}`, String(item));
      }
      continue;
    }
    args.push(`${prefix}${key}`, String(value));
  }
  return args;
}

function inferPmCacheStats({ pm, engine, installResult, betterEngine }) {
  if (engine === "better") {
    const replayReuseHits = Number(betterEngine?.incrementalOps?.kept ?? 0);
    return {
      hits: Number(betterEngine?.extracted?.reusedTarballs ?? 0) + replayReuseHits,
      misses: Number(betterEngine?.extracted?.downloadedTarballs ?? 0),
      source: "better-engine-cas"
    };
  }
  const text = `${installResult?.stdout ?? ""}\n${installResult?.stderr ?? ""}`;

  if (pm === "pnpm") {
    const reused = text.match(/reused\s+(\d+)/i);
    const downloaded = text.match(/downloaded\s+(\d+)/i);
    return {
      hits: reused ? Number(reused[1]) : 0,
      misses: downloaded ? Number(downloaded[1]) : 0,
      source: "pnpm-output"
    };
  }

  if (pm === "yarn") {
    const misses = (text.match(/can't be found in the cache/gi) ?? []).length;
    const hits = (text.match(/found in the cache/gi) ?? []).length;
    return { hits, misses, source: "yarn-output" };
  }

  if (engine === "bun") {
    const downloaded = text.match(/downloaded\s+(\d+)/i);
    return {
      hits: 0,
      misses: downloaded ? Number(downloaded[1]) : 0,
      source: "bun-output"
    };
  }

  const npmHits = (text.match(/\(cache hit\)/gi) ?? []).length;
  const npmMisses = (text.match(/\(cache miss\)/gi) ?? []).length;
  return {
    hits: npmHits,
    misses: npmMisses,
    source: "npm-output"
  };
}

function normalizeCacheScripts(value) {
  if (value === "off") return "off";
  return "rebuild";
}

async function resolveReplayRuntime(coreMode) {
  const runtime = {
    requested: coreMode,
    selected: "js",
    fallbackUsed: false,
    fallbackReason: null,
    corePath: null
  };
  if (coreMode === "js") return runtime;

  const corePath = await findBetterCore();
  if (!corePath) {
    if (coreMode === "rust") {
      return {
        ...runtime,
        fallbackUsed: true,
        fallbackReason: "rust_core_not_found"
      };
    }
    return runtime;
  }

  // Rust replay path is staged behind fallback for now.
  return {
    ...runtime,
    corePath,
    fallbackUsed: true,
    fallbackReason: "rust_replay_not_implemented"
  };
}

async function runLifecycleRebuild(pm, projectRoot, jsonOutput, env) {
  if (pm === "pnpm") {
    return await runCommand("pnpm", ["rebuild"], {
      cwd: projectRoot,
      env,
      passthroughStdio: !jsonOutput,
      captureLimitBytes: 256 * 1024
    });
  }
  return await runCommand("npm", ["rebuild", "--no-audit", "--no-fund"], {
    cwd: projectRoot,
    env,
    passthroughStdio: !jsonOutput,
    captureLimitBytes: 256 * 1024
  });
}

export async function cmdInstall(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    printText(`Usage:
  better install [--json] [--dry-run] [--pm auto|npm|pnpm|yarn] [--engine pm|bun|better]
                 [--frozen] [--production] [--cache-root PATH] [--project-root PATH]
                 [--global-cache] [--cache-mode strict|relaxed] [--cache-scripts rebuild|off]
                 [--cache-read-only] [--cache-key-salt STRING]
                 [--measure-cache auto|on|off]
                 [--core-mode auto|js|rust] [--fs-concurrency N] [--no-incremental]
                 [--parity-check auto|off|warn|strict]
                 [-- --<pm-specific flags>]
`);
    return;
  }

  const runtime = getRuntimeConfig();
  const commandLogger = childLogger({ command: "install" });
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: runtime.json === true },
      "cache-root": { type: "string", default: runtime.cacheRoot ?? undefined },
      "project-root": { type: "string" },
      pm: { type: "string", default: "auto" },
      engine: { type: "string", default: "pm" },
      "dry-run": { type: "boolean", default: false },
      frozen: { type: "boolean", default: false },
      production: { type: "boolean", default: false },
      experimental: { type: "boolean", default: false },
      mode: { type: "string", default: "wrap" },
      baseline: { type: "string", default: "estimate" },
      report: { type: "string" },
      "keep-baseline": { type: "boolean", default: false },
      "lockfile-policy": { type: "string", default: "keep" },
      "parity-check": { type: "string", default: "auto" },
      "parity-package-set": { type: "string", default: "auto" }, // auto|on|off
      measure: { type: "string", default: "on" }, // on|off
      "measure-mode": { type: "string", default: "auto" }, // auto|fast|precise
      "measure-cache": { type: "string", default: "auto" }, // auto|on|off
      "global-cache": { type: "boolean", default: false },
      "cache-mode": { type: "string", default: "strict" }, // strict|relaxed
      "cache-scripts": { type: "string", default: "rebuild" }, // rebuild|off
      "cache-read-only": { type: "boolean", default: false },
      "cache-key-salt": { type: "string" },
      "core-mode": { type: "string", default: runtime.coreMode ?? "auto" }, // auto|js|rust
      "fs-concurrency": { type: "string", default: String(runtime.fsConcurrency ?? 16) },
      incremental: { type: "boolean", default: true },
      "no-incremental": { type: "boolean", default: false },
      // Phase 3: better engine flags
      verify: { type: "string" }, // integrity-required|best-effort
      scripts: { type: "string" }, // rebuild|off
      "link-strategy": { type: "string" }, // auto|hardlink|copy
      "bin-links": { type: "string" } // rootOnly
    },
    allowPositionals: true,
    strict: false
  });

  function progress(msg) {
    commandLogger.info(msg);
  }

  const dryRun = values["dry-run"] === true;
  const frozen = values.frozen === true;
  const production = values.production === true;

  const knownOptionKeys = new Set([
    "json",
    "cache-root",
    "project-root",
    "pm",
    "engine",
    "dry-run",
    "frozen",
    "production",
    "experimental",
    "mode",
    "baseline",
    "report",
    "keep-baseline",
    "lockfile-policy",
    "parity-check",
    "parity-package-set",
    "measure",
    "measure-mode",
    "measure-cache",
    "global-cache",
    "cache-mode",
    "cache-scripts",
    "cache-read-only",
    "cache-key-salt",
    "core-mode",
    "fs-concurrency",
    "incremental",
    "no-incremental",
    "verify",
    "scripts",
    "link-strategy",
    "bin-links"
  ]);
  const passIndex = positionals.indexOf("--");
  const passthroughPositionals = passIndex >= 0 ? positionals.slice(passIndex + 1) : positionals;
  const passthroughUnknown = collectUnknownFlagArgs(values, knownOptionKeys);
  const passthrough = [...passthroughUnknown, ...passthroughPositionals];

  const invocationCwd = process.cwd();
  const resolvedRoot = values["project-root"]
    ? { root: path.resolve(values["project-root"]), reason: "flag:--project-root" }
    : await resolveInstallProjectRoot(invocationCwd);
  const projectRoot = resolvedRoot.root;

  if (projectRoot !== invocationCwd) {
    progress(`resolved project root to ${projectRoot} (${resolvedRoot.reason})`);
  }

  const cacheRoot = getCacheRoot(values["cache-root"]);
  let layout = cacheLayout(cacheRoot);
  layout = await ensureCacheDirs(layout, { projectRootForFallback: projectRoot });

  const detected = await detectPackageManager(projectRoot);
  const pm = values.pm === "auto" ? detected.pm : values.pm;
  if (pm !== "npm" && pm !== "pnpm" && pm !== "yarn") {
    throw new Error(`Unknown --pm '${pm}'. Expected npm|pnpm|yarn|auto.`);
  }
  const engine = values.engine;
  if (engine !== "pm" && engine !== "bun" && engine !== "better") {
    throw new Error(`Unknown --engine '${engine}'. Expected bun|pm|better.`);
  }
  if (engine === "better" && !values.experimental) {
    throw new Error("Engine 'better' is experimental. Re-run with --experimental.");
  }
  const yarnBerry = pm === "yarn" && (await exists(path.join(projectRoot, ".yarnrc.yml")));

  if (engine === "better") {
    const verify = values.verify ?? "integrity-required";
    if (verify !== "integrity-required" && verify !== "best-effort") {
      throw new Error(`Unknown --verify '${verify}'. Expected integrity-required|best-effort.`);
    }
    const scripts = values.scripts ?? "rebuild";
    if (scripts !== "rebuild" && scripts !== "off") {
      throw new Error(`Unknown --scripts '${scripts}'. Expected rebuild|off.`);
    }
    const linkStrategy = values["link-strategy"] ?? "auto";
    if (linkStrategy !== "auto" && linkStrategy !== "hardlink" && linkStrategy !== "copy") {
      throw new Error(`Unknown --link-strategy '${linkStrategy}'. Expected auto|hardlink|copy.`);
    }
    const binLinks = values["bin-links"] ?? "rootOnly";
    if (binLinks !== "rootOnly") {
      throw new Error(`Unknown --bin-links '${binLinks}'. Expected rootOnly.`);
    }
  }
  const mode = values.mode;
  if (mode !== "wrap" && mode !== "materialize") {
    throw new Error(`Unknown --mode '${mode}'. Expected wrap|materialize.`);
  }
  const lockfilePolicy = values["lockfile-policy"];
  if (lockfilePolicy !== "keep" && lockfilePolicy !== "allow-engine") {
    throw new Error(`Unknown --lockfile-policy '${lockfilePolicy}'. Expected keep|allow-engine.`);
  }

  // Parity check mode: off|warn|strict, default depends on engine
  let parityCheckMode = values["parity-check"];
  if (parityCheckMode === "auto") {
    parityCheckMode = engine === "bun" ? "warn" : "off";
  }
  if (parityCheckMode !== "off" && parityCheckMode !== "warn" && parityCheckMode !== "strict") {
    throw new Error(`Unknown --parity-check '${parityCheckMode}'. Expected off|warn|strict.`);
  }

  const parityPackageSet = values["parity-package-set"];
  if (parityPackageSet !== "auto" && parityPackageSet !== "on" && parityPackageSet !== "off") {
    throw new Error(`Unknown --parity-package-set '${parityPackageSet}'. Expected auto|on|off.`);
  }

  const measure = values.measure;
  if (measure !== "on" && measure !== "off") {
    throw new Error(`Unknown --measure '${measure}'. Expected on|off.`);
  }

  const userProvidedMeasureMode = argv.includes("--measure-mode");
  let measureMode = values["measure-mode"];
  if (!userProvidedMeasureMode && engine === "bun") {
    // Bun engine is the "speed track": default to fast/approx measurement to avoid minute-long scans.
    measureMode = "fast";
  }
  if (measureMode !== "auto" && measureMode !== "fast" && measureMode !== "precise") {
    throw new Error(`Unknown --measure-mode '${measureMode}'. Expected auto|fast|precise.`);
  }
  const measureCacheMode = values["measure-cache"];
  if (measureCacheMode !== "auto" && measureCacheMode !== "on" && measureCacheMode !== "off") {
    throw new Error(`Unknown --measure-cache '${measureCacheMode}'. Expected auto|on|off.`);
  }

  const globalCacheEnabled = values["global-cache"] === true;
  const cacheMode = values["cache-mode"] ?? "strict";
  if (cacheMode !== "strict" && cacheMode !== "relaxed") {
    throw new Error(`Unknown --cache-mode '${cacheMode}'. Expected strict|relaxed.`);
  }
  const cacheScripts = normalizeCacheScripts(values["cache-scripts"]);
  if (values["cache-scripts"] !== "rebuild" && values["cache-scripts"] !== "off") {
    throw new Error(`Unknown --cache-scripts '${values["cache-scripts"]}'. Expected rebuild|off.`);
  }
  const cacheReadOnly = values["cache-read-only"] === true;
  const cacheKeySalt = values["cache-key-salt"] ?? null;
  const coreMode = String(values["core-mode"] ?? "auto").toLowerCase();
  if (coreMode !== "auto" && coreMode !== "js" && coreMode !== "rust") {
    throw new Error(`Unknown --core-mode '${values["core-mode"]}'. Expected auto|js|rust.`);
  }
  const fsConcurrency = Math.max(1, Math.min(128, Number.parseInt(values["fs-concurrency"], 10) || 16));
  const incremental = values["no-incremental"] ? false : values.incremental !== false;

  const runId = `${Date.now()}-${shortHash(`${projectRoot}:${pm}:${mode}`)}`;
  const startedAt = nowIso();
  const startedAtMs = Date.now();
  const phaseDurations = {
    preMeasureMs: 0,
    installMs: 0,
    postMeasureMs: 0,
    parityPreMs: 0,
    parityCompareMs: 0,
    globalCacheStoreMs: 0,
    totalMs: 0
  };

  const nodeModulesPath = path.join(projectRoot, "node_modules");
  const pmCacheDir = engine === "bun"
    ? (layout.pm.bun || layout.pm.npm)
    : pm === "pnpm" ? layout.pm.pnpmStore : pm === "yarn" ? layout.pm.yarn : layout.pm.npm;
  const bunFastTrack = engine === "bun" && measure === "on" && measureMode === "fast";
  const shouldMeasureCache = measure === "on" && (
    measureCacheMode === "on" || (measureCacheMode === "auto" && !bunFastTrack)
  );
  const includePackageCount = !(engine === "bun" && measureMode === "fast");
  const scanCoreMode = measureMode === "fast" ? "off" : "auto";
  const duFallback = measureMode === "precise" ? "off" : "auto";
  const pmCacheSnapshotStore = await loadPmCacheSnapshotStore(layout);
  const pmCacheSnapshotBefore = snapshotToCacheResult(pmCacheSnapshotStore.snapshots[pmCacheSnapshotKey(pmCacheDir)]);
  const preMeasureStartMs = Date.now();
  const beforeCache = shouldMeasureCache
    ? await scanTreeWithBestEngine(pmCacheDir, { coreMode: scanCoreMode, duFallback })
    : (
      measure === "on" && measureCacheMode === "auto" && pmCacheSnapshotBefore.ok
        ? pmCacheSnapshotBefore
        : { ok: false, reason: measure === "off" ? "measure_off" : "measure_cache_off" }
    );
  const beforeNodeModules = measure === "on"
    ? await collectNodeModulesSnapshot(projectRoot, { coreMode: scanCoreMode, duFallback, includePackageCount })
    : { ok: false, reason: "measure_off", exists: false, packageCount: 0 };
  phaseDurations.preMeasureMs = Date.now() - preMeasureStartMs;

  const c = pmInstallCommand(pm, passthrough, engine, {
    frozen,
    production,
    yarnBerry
  });

  let globalCacheContext = null;
  let globalCacheDecision = {
    enabled: globalCacheEnabled,
    eligible: false,
    hit: false,
    reason: globalCacheEnabled ? "initializing" : "disabled",
    key: null,
    pmSupportPhase: null,
    mode: cacheMode,
    readOnly: cacheReadOnly
  };
  const engineRuntime = engine === "better"
    ? await resolveReplayRuntime(coreMode)
    : {
        requested: "n/a",
        selected: "pm",
        fallbackUsed: false,
        fallbackReason: null,
        corePath: null
      };
  let reuseContext = null;
  let reuseDecision = {
    eligible: engine === "better",
    hit: false,
    reason: engine === "better" ? "not_checked" : "not_applicable",
    key: null,
    lockHash: null
  };

  if (globalCacheEnabled || engine === "better") {
    const derivedContext = await deriveGlobalCacheContext(projectRoot, {
      pm,
      engine,
      cacheMode,
      scriptsMode: engine === "better" ? (values.scripts ?? "rebuild") : cacheScripts,
      frozen,
      production,
      cacheKeySalt
    });
    if (engine === "better") {
      reuseContext = derivedContext;
      reuseDecision = {
        eligible: derivedContext?.decision?.eligible === true,
        hit: false,
        reason: derivedContext?.decision?.eligible === true ? "marker_check_pending" : (derivedContext?.decision?.reason ?? "ineligible"),
        key: derivedContext?.key ?? null,
        lockHash: derivedContext?.lockHash ?? null
      };
    }
    if (globalCacheEnabled) {
      globalCacheContext = derivedContext;
    }
  }

  if (globalCacheEnabled && globalCacheContext) {
    globalCacheDecision = {
      ...globalCacheDecision,
      ...globalCacheContext.decision,
      enabled: true,
      readOnly: cacheReadOnly
    };
  }

  if (dryRun) {
    const lockEstimate = await estimatePackagesFromLockfile(projectRoot);
    const estimatedPackagesAfter = lockEstimate.ok ? lockEstimate.packageCount : null;
    const packagesBefore = beforeNodeModules?.packageCount ?? 0;
    const estimatedPackagesAdded = estimatedPackagesAfter == null
      ? null
      : Math.max(0, estimatedPackagesAfter - packagesBefore);
    const dryRunReport = {
      ok: true,
      kind: "better.install.dryrun",
      schemaVersion: 1,
      dryRun: true,
      runId,
      startedAt,
      endedAt: nowIso(),
      projectRoot,
      pm: { name: pm, detected: detected.pm, reason: detected.reason },
      engine,
      mode,
      cacheRoot: layout.root,
      command: c,
      estimate: {
        globalCache: globalCacheDecision,
        lockfile: lockEstimate.lockfile,
        lockfilePackageCount: lockEstimate.ok ? lockEstimate.packageCount : null,
        lockfileEstimateReason: lockEstimate.ok ? null : lockEstimate.reason,
        packagesBefore,
        estimatedPackagesAfter,
        estimatedPackagesAdded,
        nodeModulesBefore: beforeNodeModules?.ok
          ? {
              logicalBytes: beforeNodeModules.logicalBytes ?? 0,
              physicalBytes: beforeNodeModules.physicalBytes ?? 0,
              packageCount: beforeNodeModules.packageCount ?? 0
            }
          : { ok: false, reason: beforeNodeModules?.reason ?? "measurement_unavailable" }
      }
    };
    if (values.json) {
      printJson(dryRunReport);
    } else {
      printText(
        [
          "better install (dry-run)",
          `- package manager: ${pm}`,
          `- command: ${c.cmd} ${c.args.join(" ")}`,
          `- lockfile estimate: ${lockEstimate.ok ? lockEstimate.packageCount : "unavailable"}`,
          `- estimated added packages: ${estimatedPackagesAdded ?? "unknown"}`
        ].join("\n")
      );
    }
    return;
  }

  let noopReuseInstall = null;
  if (engine === "better" && reuseDecision.eligible && reuseContext?.key) {
    const reuseEval = await evaluateReuseMarker(projectRoot, {
      key: reuseContext.key,
      lockHash: reuseContext.lockHash,
      fingerprint: reuseContext.fingerprint
    });
    reuseDecision = {
      ...reuseDecision,
      hit: reuseEval.hit === true,
      reason: reuseEval.reason ?? "marker_unknown",
      markerVersion: reuseEval?.marker?.version ?? null
    };
    if (reuseEval.hit) {
      const now = Date.now();
      noopReuseInstall = {
        cmd: "better",
        args: ["install", "--engine", "better", "--reuse-hit"],
        cwd: projectRoot,
        startedAt: now,
        endedAt: now,
        wallTimeMs: 0,
        exitCode: 0,
        signal: null,
        stdout: "",
        stderr: "",
        stdoutTail: "",
        stderrTail: ""
      };
    }
  }

  // Create parity context before install
  let parityContext = null;
  if (parityCheckMode !== "off" && !noopReuseInstall) {
    const includePackageSet =
      parityPackageSet === "on" ? true : parityPackageSet === "off" ? false : parityCheckMode === "strict";
    progress(
      includePackageSet
        ? `parity pre-snapshot (${parityCheckMode}): hashing lockfiles + package set (may take time on large repos)`
        : `parity pre-snapshot (${parityCheckMode}): hashing lockfiles`
    );
    const parityPreStartMs = Date.now();
    parityContext = await createParityContext(projectRoot, includePackageSet);
    phaseDurations.parityPreMs = Date.now() - parityPreStartMs;
  }

  let cmd = null;
  let args = null;
  let install = noopReuseInstall;
  let betterEngine = null;
  let globalMaterialize = null;
  let globalCacheStored = null;
  let cacheScriptResult = null;
  let skippedPmInstall = !!noopReuseInstall;
  const installEnv = pmEnv(pm, layout, engine);
  if (noopReuseInstall) {
    progress("reuse marker hit: node_modules matches derived key, skipping install");
  }

  if (!skippedPmInstall && globalCacheEnabled && globalCacheContext?.decision?.eligible && globalCacheContext.key) {
    const verifyEntry = await verifyGlobalCacheEntry(layout, globalCacheContext.key);
    if (verifyEntry.ok) {
      progress(`global cache hit: materializing node_modules from key ${globalCacheContext.key.slice(0, 12)}…`);
      globalMaterialize = await materializeFromGlobalCache(layout, globalCacheContext.key, projectRoot, {
        linkStrategy: values["link-strategy"] ?? "auto",
        fsConcurrency,
        coreMode
      });
      if (globalMaterialize.ok) {
        globalCacheDecision = {
          ...globalCacheDecision,
          hit: true,
          reason: "global_cache_hit"
        };
        if (cacheScripts === "rebuild") {
          cacheScriptResult = await runLifecycleRebuild(pm, projectRoot, values.json, installEnv);
          if (cacheScriptResult.exitCode !== 0) {
            const err = new Error(`lifecycle rebuild failed with code ${cacheScriptResult.exitCode}`);
            err.exitCode = cacheScriptResult.exitCode;
            err.install = cacheScriptResult;
            throw err;
          }
        }
        const started = Date.now() - Number(globalMaterialize.durationMs ?? 0);
        const ended = Date.now();
        cmd = "better";
        args = ["install", "--global-cache", "--cache-hit"];
        install = {
          cmd,
          args,
          cwd: projectRoot,
          startedAt: started,
          endedAt: ended,
          wallTimeMs: Number(globalMaterialize.durationMs ?? 0),
          exitCode: 0,
          signal: null,
          stdout: "",
          stderr: "",
          stdoutTail: "",
          stderrTail: ""
        };
        skippedPmInstall = true;
      } else {
        globalCacheDecision = {
          ...globalCacheDecision,
          hit: false,
          reason: globalMaterialize.reason ?? "materialize_failed"
        };
      }
    } else {
      globalCacheDecision = {
        ...globalCacheDecision,
        hit: false,
        reason: verifyEntry.reason
      };
    }
  }

  if (!skippedPmInstall) {
    if (engine === "better") {
      progress("engine=better: materializing from package-lock.json (experimental)");
      const started = Date.now();
      betterEngine = await installFromNpmLockfile(projectRoot, layout, {
        verify: values.verify ?? "integrity-required",
        linkStrategy: values["link-strategy"] ?? "auto",
        scripts: values.scripts ?? "rebuild",
        binLinks: values["bin-links"] ?? "rootOnly",
        incremental,
        fsConcurrency
      });
      const ended = Date.now();
      cmd = "better";
      args = ["install", "--engine", "better"];
      install = {
        cmd,
        args,
        cwd: projectRoot,
        startedAt: started,
        endedAt: ended,
        wallTimeMs: ended - started,
        exitCode: 0,
        signal: null,
        stdout: "",
        stderr: "",
        stdoutTail: "",
        stderrTail: ""
      };
    } else {
      cmd = c.cmd;
      args = c.args;

      progress(`running ${cmd} ${args.join(" ")}`);
      install = await runCommand(cmd, args, { cwd: projectRoot, env: installEnv, passthroughStdio: !values.json });
      if (install.exitCode !== 0) {
        const err = new Error(`${cmd} exited with code ${install.exitCode}`);
        err.install = install;
        err.exitCode = install.exitCode;
        throw err;
      }
    }
  }
  phaseDurations.installMs = Number(install?.wallTimeMs ?? 0);

  progress(
    measure === "off"
      ? "post-install: measurement disabled"
      : shouldMeasureCache
        ? "post-install: measuring cache and node_modules sizes"
        : "post-install: measuring node_modules sizes (pm cache scan skipped)"
  );
  const postMeasureStartMs = Date.now();
  const afterCacheMeasured = shouldMeasureCache
    ? await scanTreeWithBestEngine(pmCacheDir, { coreMode: scanCoreMode, duFallback })
    : null;
  const pmCacheSnapshotAfter = snapshotToCacheResult(pmCacheSnapshotStore.snapshots[pmCacheSnapshotKey(pmCacheDir)]);
  const afterCache = afterCacheMeasured ?? (
    measure === "on" && measureCacheMode === "auto" && pmCacheSnapshotAfter.ok
      ? pmCacheSnapshotAfter
      : { ok: false, reason: measure === "off" ? "measure_off" : "measure_cache_off" }
  );
  const nodeModules = measure === "on"
    ? await collectNodeModulesSnapshot(projectRoot, { coreMode: scanCoreMode, duFallback, includePackageCount })
    : { ok: false, reason: "measure_off", exists: false, packageCount: 0 };
  phaseDurations.postMeasureMs = Date.now() - postMeasureStartMs;
  if (shouldMeasureCache && afterCacheMeasured?.ok) {
    await persistPmCacheSnapshot(layout, pmCacheSnapshotStore, pmCacheDir, afterCacheMeasured);
  }

  if (
    !noopReuseInstall &&
    globalCacheEnabled &&
    globalCacheContext?.decision?.eligible &&
    globalCacheContext.key &&
    !globalCacheDecision.hit &&
    !cacheReadOnly
  ) {
    progress(`global cache miss: capturing node_modules into key ${globalCacheContext.key.slice(0, 12)}…`);
    const globalCacheStoreStartMs = Date.now();
    globalCacheStored = await captureProjectNodeModulesToGlobalCache(layout, globalCacheContext.key, projectRoot, {
      linkStrategy: values["link-strategy"] ?? "auto",
      fsConcurrency,
      lockHash: globalCacheContext.lockHash,
      lockfile: globalCacheContext.lockfile,
      fingerprint: globalCacheContext.fingerprint,
      pm,
      engine,
      scriptsMode: cacheScripts,
      cacheMode
    });
    phaseDurations.globalCacheStoreMs = Date.now() - globalCacheStoreStartMs;
    if (globalCacheStored.ok) {
      globalCacheDecision = {
        ...globalCacheDecision,
        reason: "global_cache_stored"
      };
    } else {
      globalCacheDecision = {
        ...globalCacheDecision,
        reason: globalCacheStored.reason ?? "global_cache_store_failed"
      };
    }
  }

  // Run parity check after install
  let parityResult = null;
  if (parityContext) {
    progress(
      parityContext.packageSetBefore
        ? `parity compare (${parityCheckMode}): checking drift and package set`
        : `parity compare (${parityCheckMode}): checking drift`
    );
    const parityCompareStartMs = Date.now();
    parityResult = await runParityCheck({
      projectRoot,
      lockfileBefore: parityContext.lockfileBefore,
      packageSetBefore: parityContext.packageSetBefore,
      mode: parityCheckMode
    });
    phaseDurations.parityCompareMs = Date.now() - parityCompareStartMs;

    // In strict mode, throw if parity check failed
    if (parityCheckMode === "strict" && !parityResult.ok) {
      const err = new Error(`Parity check failed: ${parityResult.errors.join("; ")}`);
      err.parityResult = parityResult;
      throw err;
    }
  }

  const endedAt = nowIso();
  phaseDurations.totalMs = Date.now() - startedAtMs;
  const inferredCache = globalCacheDecision.hit
    ? { hits: 1, misses: 0, source: "global-node_modules-cache" }
    : inferPmCacheStats({
        pm,
        engine,
        installResult: install,
        betterEngine
      });
  const cacheHits = Number(inferredCache.hits ?? 0);
  const cacheMisses = Number(inferredCache.misses ?? 0);
  const packagesBefore = beforeNodeModules?.packageCount ?? 0;
  const packagesAfter = nodeModules?.packageCount ?? 0;
  const logicalBefore = beforeNodeModules?.logicalBytes ?? 0;
  const logicalAfter = nodeModules?.logicalBytes ?? 0;
  const physicalBefore = beforeNodeModules?.physicalBytes ?? 0;
  const physicalAfter = nodeModules?.physicalBytes ?? 0;
  const installMetrics = {
    durationMs: install.wallTimeMs,
    packagesBefore,
    packagesAfter,
    packagesInstalled: Math.max(0, packagesAfter - packagesBefore),
    logicalBytesBefore: logicalBefore,
    logicalBytesAfter: logicalAfter,
    logicalBytesDelta: logicalAfter - logicalBefore,
    physicalBytesBefore: physicalBefore,
    physicalBytesAfter: physicalAfter,
    physicalBytesDelta: physicalAfter - physicalBefore,
    cache: {
      hits: cacheHits,
      misses: cacheMisses,
      source: inferredCache.source
    }
  };

  /**
   * Install report schema v2
   * @typedef {Object} InstallReport
   * @property {boolean} ok - Overall success status
   * @property {string} kind - Report type identifier: "better.install.report"
   * @property {number} schemaVersion - Schema version (2)
   * @property {string} runId - Unique run identifier
   * @property {string} startedAt - ISO timestamp when install started
   * @property {string} endedAt - ISO timestamp when install completed
   * @property {string} projectRoot - Absolute path to project root
   * @property {Object} pm - Package manager info (name, detected, reason)
   * @property {string} engine - Engine used: "pm" or "bun"
   * @property {string} mode - Install mode: "wrap" or "materialize"
   * @property {string} lockfilePolicy - Lockfile policy: "keep" or "allow-engine"
   * @property {string} cacheRoot - Better cache root path
   * @property {Object} command - Command executed (cmd, args)
   * @property {Object} install - Install metrics (wallTimeMs)
   * @property {Object} nodeModules - node_modules scan results
   * @property {Object} cache - Cache state before/after
   * @property {Object|null} parity - Parity check results (null if not run)
   * @property {boolean} parity.ok - Parity check passed
   * @property {string} parity.mode - Parity mode: "warn" or "strict"
   * @property {Object} parity.checks - Individual check results
   * @property {Object} parity.checks.lockfileDrift - Lockfile drift check
   * @property {boolean} parity.checks.lockfileDrift.hasDrift - Whether drift was detected
   * @property {string[]} parity.checks.lockfileDrift.added - Added lockfiles
   * @property {string[]} parity.checks.lockfileDrift.removed - Removed lockfiles
   * @property {string[]} parity.checks.lockfileDrift.modified - Modified lockfiles
   * @property {Object|null} parity.checks.packageSet - Package set comparison (null if not checked)
   * @property {boolean} parity.checks.packageSet.match - Package sets match
   * @property {string} parity.checks.packageSet.hashBefore - Hash before install
   * @property {string} parity.checks.packageSet.hashAfter - Hash after install
   * @property {string[]} parity.checks.packageSet.onlyInBefore - Packages only in before
   * @property {string[]} parity.checks.packageSet.onlyInAfter - Packages only in after
   * @property {number} parity.checks.packageSet.sizeBefore - Package count before
   * @property {number} parity.checks.packageSet.sizeAfter - Package count after
   * @property {string[]} parity.warnings - Warning messages
   * @property {string[]} parity.errors - Error messages
   * @property {Object|null} lockfileMigration - Lockfile migration info (null if not migrating)
   * @property {Object} baseline - Baseline comparison results
   */
  const report = {
    ok: true,
    kind: "better.install.report",
    schemaVersion: 2,
    runId,
    startedAt,
    endedAt,
    invocationCwd,
    projectRootResolution: { root: projectRoot, reason: resolvedRoot.reason },
    projectRoot,
    pm: { name: pm, detected: detected.pm, reason: detected.reason },
    engine,
    engineRuntime,
    mode,
    lockfilePolicy,
    cacheRoot: layout.root,
    command: { cmd, args },
    install: {
      wallTimeMs: install.wallTimeMs,
      metrics: installMetrics
    },
    execution: {
      mode: noopReuseInstall
        ? "noop_reuse"
        : globalMaterialize
          ? "cache_materialize"
          : engine === "better"
            ? "replay"
            : "pm_wrap",
      incremental: engine === "better" ? incremental : null,
      fsConcurrency: engine === "better" ? fsConcurrency : null
    },
    phases: phaseDurations,
    tuning: suggestFsConcurrencyTuning({ engine, fsConcurrency, globalMaterialize }),
    reuseDecision,
    cacheDecision: globalCacheDecision,
    materialize: globalMaterialize
      ? {
          strategy: globalMaterialize.strategy,
          durationMs: globalMaterialize.durationMs,
          filesLinked: Number(globalMaterialize.stats?.filesLinked ?? 0),
          filesCopied: Number(globalMaterialize.stats?.filesCopied ?? 0),
          filesTotal: Number(globalMaterialize.stats?.files ?? 0),
          symlinks: Number(globalMaterialize.stats?.symlinks ?? 0),
          runtime: globalMaterialize.runtime ?? null
        }
      : null,
    reuse: {
      nodeModulesBytesReused: globalCacheDecision.hit ? entryBytesFromNodeModulesSnapshot(nodeModules) : 0,
      artifactBytesReused: Number(betterEngine?.extracted?.reusedTarballs ?? 0),
      downloadBytesAvoided: globalCacheDecision.hit ? entryBytesFromNodeModulesSnapshot(nodeModules) : 0
    },
    scripts: cacheScriptResult
      ? {
          mode: cacheScripts,
          command: "rebuild",
          exitCode: cacheScriptResult.exitCode,
          wallTimeMs: cacheScriptResult.wallTimeMs,
          ok: cacheScriptResult.exitCode === 0
        }
      : { mode: cacheScripts, ok: true },
    betterEngine,
    nodeModules: nodeModules.ok
      ? {
          path: nodeModulesPath,
          logicalBytes: nodeModules.logicalBytes,
          physicalBytes: nodeModules.physicalBytes,
          physicalBytesApprox: nodeModules.physicalBytesApprox,
          fileCount: nodeModules.fileCount,
          packageCount: nodeModules.packageCount
        }
      : { path: nodeModulesPath, ok: false, reason: nodeModules.reason },
    cache: {
      pmCacheDir,
      before: beforeCache.ok
        ? {
            logicalBytes: beforeCache.logicalBytes,
            physicalBytes: beforeCache.physicalBytes,
            physicalBytesApprox: beforeCache.physicalBytesApprox ?? false,
            source: beforeCache.source ?? "scan"
          }
        : { ok: false, reason: beforeCache.reason },
      after: afterCache.ok
        ? {
            logicalBytes: afterCache.logicalBytes,
            physicalBytes: afterCache.physicalBytes,
            physicalBytesApprox: afterCache.physicalBytesApprox ?? false,
            source: afterCache.source ?? "scan"
          }
        : { ok: false, reason: afterCache.reason }
    },
    metrics: installMetrics,
    baseline: values.baseline === "run" ? { mode: "run", status: "pending" } : { mode: "estimate", status: "unavailable_offline" }
  };

  // Add parity result to report
  if (parityResult) {
    report.parity = parityResult;
  }

  // Add lockfile migration info if using bun engine with allow-engine policy
  if (engine === "bun" && lockfilePolicy === "allow-engine") {
    report.lockfileMigration = {
      status: "migrating",
      engineLockfile: "bun.lockb",
      note: "Using bun engine with allow-engine policy; bun.lockb may be created/updated"
    };
  } else {
    report.lockfileMigration = null;
  }

  if (values.baseline === "run") {
    let baseline = null;
    let baselineRoot = null;
    let baselineCacheRoot = null;
    try {
      const pkgPath = path.join(projectRoot, "package.json");
      let pkg = null;
      try {
        pkg = JSON.parse(await fs.readFile(pkgPath, "utf8"));
      } catch {
        // ignore
      }
      if (pkg?.workspaces) {
        baseline = {
          ok: false,
          reason: "workspaces_not_supported_for_baseline_copy",
          note: "Baseline run copies only root manifests; workspace installs require workspace package manifests."
        };
      } else {
        baselineRoot = await makeBaselineProject(layout, projectRoot);
        baselineCacheRoot = path.join(layout.tmpDir, `baseline-cache-${Date.now()}-${shortHash(projectRoot)}`);
        let baseLayout = cacheLayout(baselineCacheRoot);
        baseLayout = await ensureCacheDirs(baseLayout);

        const basePmCacheDir = engine === "bun"
          ? (baseLayout.pm.bun || baseLayout.pm.npm)
          : pm === "pnpm" ? baseLayout.pm.pnpmStore : pm === "yarn" ? baseLayout.pm.yarn : baseLayout.pm.npm;
        const baseBeforeCache = await scanTreeWithBestEngine(basePmCacheDir, { coreMode: "auto", duFallback: "auto" });
        const baseEnv = pmEnv(pm, baseLayout, engine);
        const baseCmd = pmInstallCommand(pm, passthrough, engine === "better" ? "pm" : engine, {
          frozen,
          production,
          yarnBerry
        });
        const baseInstall = await runCommand(baseCmd.cmd, baseCmd.args, { cwd: baselineRoot, env: baseEnv, passthroughStdio: false });
        const baseAfterCache = await scanTreeWithBestEngine(basePmCacheDir, { coreMode: "auto", duFallback: "auto" });
        const baseNodeModules = await scanTreeWithBestEngine(path.join(baselineRoot, "node_modules"), { coreMode: "auto", duFallback: "auto" });

        baseline = {
          ok: baseInstall.exitCode === 0,
          projectRoot: baselineRoot,
          cacheRoot: baselineCacheRoot,
          install: { wallTimeMs: baseInstall.wallTimeMs, exitCode: baseInstall.exitCode },
          nodeModules: baseNodeModules.ok
            ? {
                logicalBytes: baseNodeModules.logicalBytes,
                physicalBytes: baseNodeModules.physicalBytes,
                physicalBytesApprox: baseNodeModules.physicalBytesApprox
              }
            : { ok: false, reason: baseNodeModules.reason },
          cache: {
            pmCacheDir: basePmCacheDir,
            before: baseBeforeCache.ok
              ? { logicalBytes: baseBeforeCache.logicalBytes, physicalBytes: baseBeforeCache.physicalBytes }
              : { ok: false, reason: baseBeforeCache.reason },
            after: baseAfterCache.ok
              ? { logicalBytes: baseAfterCache.logicalBytes, physicalBytes: baseAfterCache.physicalBytes }
              : { ok: false, reason: baseAfterCache.reason }
          }
        };
        if (baseInstall.exitCode !== 0) {
          baseline.stderrTail = baseInstall.stderrTail;
        }
      }
    } catch (err) {
      baseline = { ok: false, reason: err?.message ?? String(err) };
    } finally {
      if (!values["keep-baseline"]) {
        if (baselineRoot) await rmrf(baselineRoot);
        if (baselineCacheRoot) await rmrf(baselineCacheRoot);
      }
    }
    report.baseline = { mode: "run", status: "complete", result: baseline };
  }

  if (engine === "better" && reuseContext?.key) {
    try {
      const markerPayload = {
        version: 1,
        engine: "better",
        globalKey: reuseContext.key,
        lockHash: reuseContext.lockHash ?? null,
        runtimeFingerprint: reuseContext.fingerprint ?? null,
        scriptsMode: values.scripts ?? "rebuild",
        linkStrategy: values["link-strategy"] ?? "auto",
        incremental,
        fsConcurrency,
        updatedAt: endedAt,
        runId
      };
      const markerPath = await writeReuseMarker(projectRoot, markerPayload);
      report.reuseMarker = {
        ok: true,
        path: markerPath
      };
    } catch (err) {
      report.reuseMarker = {
        ok: false,
        reason: err?.message ?? String(err)
      };
    }
  } else {
    report.reuseMarker = {
      ok: false,
      reason: "not_written"
    };
  }

  await fs.writeFile(path.join(layout.runsDir, `${runId}.json`), `${JSON.stringify(report, null, 2)}\n`);

  const state = await loadState(layout);
  state.cacheEntries = state.cacheEntries ?? {};
  state.materializationIndex = state.materializationIndex ?? {};
  const projectId = shortHash(projectRoot);
  state.projects[projectId] = {
    projectId,
    projectRoot,
    lastUsedAt: endedAt,
    lastRunId: runId,
    pm
  };
  if (globalCacheEnabled && globalCacheContext?.key) {
    const entryKey = globalCacheContext.key;
    const previousEntry = state.cacheEntries?.[entryKey] ?? {};
    const wasCreatedNow = !!globalCacheStored?.ok;
    const sizeBytes = entryBytesFromNodeModulesSnapshot(nodeModules);
    state.cacheEntries[entryKey] = {
      ...previousEntry,
      key: entryKey,
      pm,
      engine,
      cacheMode,
      scriptsMode: cacheScripts,
      lockHash: globalCacheContext.lockHash ?? previousEntry.lockHash ?? null,
      lockfile: globalCacheContext.lockfile ?? previousEntry.lockfile ?? null,
      runtimeFingerprint: globalCacheContext.fingerprint ?? previousEntry.runtimeFingerprint ?? null,
      createdAt: previousEntry.createdAt ?? endedAt,
      lastUsedAt: endedAt,
      useCount: Number(previousEntry.useCount ?? 0) + 1,
      sizeBytes,
      sourceRunId: runId,
      hitCount: Number(previousEntry.hitCount ?? 0) + (globalCacheDecision.hit ? 1 : 0),
      missCount: Number(previousEntry.missCount ?? 0) + (globalCacheDecision.hit ? 0 : 1),
      status: wasCreatedNow ? "stored" : globalCacheDecision.hit ? "hit" : "miss"
    };
    state.materializationIndex[projectId] = {
      projectId,
      projectRoot,
      key: entryKey,
      pm,
      engine,
      lastMaterializedAt: globalCacheDecision.hit ? endedAt : (state.materializationIndex?.[projectId]?.lastMaterializedAt ?? null),
      lastStoredAt: wasCreatedNow ? endedAt : (state.materializationIndex?.[projectId]?.lastStoredAt ?? null),
      lastVerifiedAt: endedAt
    };
  }
  const previousCacheMetrics = state.cacheMetrics ?? { installRuns: 0, cacheHits: 0, cacheMisses: 0 };
  state.cacheMetrics = {
    installRuns: Number(previousCacheMetrics.installRuns ?? 0) + 1,
    cacheHits: Number(previousCacheMetrics.cacheHits ?? 0) + cacheHits,
    cacheMisses: Number(previousCacheMetrics.cacheMisses ?? 0) + cacheMisses,
    lastUpdatedAt: endedAt
  };
  if (Array.isArray(betterEngine?.packages)) {
    for (const pkg of betterEngine.packages) {
      if (!pkg?.name || !pkg?.version) continue;
      const key = `${pkg.name}@${pkg.version}`;
      const prev = state.cachePackages?.[key] ?? {
        name: pkg.name,
        version: pkg.version,
        seenCount: 0,
        projects: {},
        casKeys: []
      };
      const casKeys = Array.isArray(prev.casKeys) ? [...prev.casKeys] : [];
      const nextCasKey = pkg.cas?.keyHex ? `${pkg.cas.algorithm}:${pkg.cas.keyHex}` : null;
      if (nextCasKey && !casKeys.includes(nextCasKey)) casKeys.push(nextCasKey);
      state.cachePackages[key] = {
        ...prev,
        name: pkg.name,
        version: pkg.version,
        seenCount: Number(prev.seenCount ?? 0) + 1,
        lastUsedAt: endedAt,
        projects: {
          ...(prev.projects ?? {}),
          [projectId]: endedAt
        },
        lastSource: pkg.source ?? prev.lastSource ?? null,
        cacheHitCount: Number(prev.cacheHitCount ?? 0) + (pkg.cacheHit ? 1 : 0),
        cacheMissCount: Number(prev.cacheMissCount ?? 0) + (pkg.cacheMiss ? 1 : 0),
        casKeys
      };
    }
  }
  await saveState(layout, state);

  if (values.report) {
    const outPath = path.resolve(values.report);
    await fs.writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`);
  }

  if (values.json) {
    printJson(report);
    return;
  }

  const nm = report.nodeModules;
  const logicalMb = nm.ok === false ? null : (nm.logicalBytes / 1024 / 1024).toFixed(1);
  const physicalMb = nm.ok === false ? null : (nm.physicalBytes / 1024 / 1024).toFixed(1);

  const engineDisplay = engine === "bun" ? "bun" : pm;
  const outputLines = [
    `better install (${engineDisplay}, mode=${mode})`,
    projectRoot !== invocationCwd ? `- project root: ${projectRoot} (${resolvedRoot.reason})` : `- project root: ${projectRoot}`,
    `- wall time: ${report.install.wallTimeMs} ms`,
    `- packages: ${installMetrics.packagesBefore} -> ${installMetrics.packagesAfter} (delta ${installMetrics.packagesInstalled})`,
    nm.ok === false
      ? `- node_modules: unavailable (${nm.reason})`
      : `- node_modules: logical ${logicalMb} MiB, physical ${physicalMb} MiB${nm.physicalBytesApprox ? " (approx)" : ""}`,
    globalCacheEnabled
      ? `- global cache: ${globalCacheDecision.hit ? "hit" : "miss"} (${globalCacheDecision.reason})`
      : "- global cache: disabled",
    engine === "better"
      ? `- reuse marker: ${reuseDecision.hit ? "hit" : "miss"} (${reuseDecision.reason})`
      : "- reuse marker: n/a",
    `- cache root: ${layout.root}`,
    `- run report: ${path.join(layout.runsDir, `${runId}.json`)}`
  ];

  if (parityResult && parityResult.warnings.length > 0) {
    outputLines.push(`- parity warnings: ${parityResult.warnings.join("; ")}`);
  }

  printText(outputLines.join("\n"));
}
