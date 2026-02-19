import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { runCommand } from "../lib/spawn.js";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import { childLogger } from "../lib/log.js";
import { detectPackageManager } from "../pm/detect.js";
import { shortHash } from "../lib/hash.js";
import { getCacheRoot, cacheLayout, ensureCacheDirs } from "../lib/cache.js";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

const BETTER_BIN_PATH = fileURLToPath(new URL("../../bin/better.js", import.meta.url));

async function rmrf(p) {
  await fs.rm(p, { recursive: true, force: true });
}

function mean(values) {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function p95(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1));
  return sorted[index];
}

function stddev(values) {
  if (values.length < 2) return null;
  const avg = mean(values);
  const squaredDiffs = values.map(v => (v - avg) ** 2);
  return Math.sqrt(squaredDiffs.reduce((sum, d) => sum + d, 0) / (values.length - 1));
}

function computeStats(samples, key = "wallTimeMs") {
  const values = samples
    .map((sample) => sample?.[key])
    .filter((value) => typeof value === "number" && Number.isFinite(value) && value >= 0);
  if (values.length === 0) {
    return {
      count: 0,
      min: null,
      max: null,
      mean: null,
      median: null,
      p95: null,
      stddev: null,
      p95Spread: null
    };
  }
  const p95Val = p95(values);
  const medianVal = median(values);
  return {
    count: values.length,
    min: Math.min(...values),
    max: Math.max(...values),
    mean: mean(values),
    median: medianVal,
    p95: p95Val,
    stddev: stddev(values),
    p95Spread: p95Val != null && medianVal != null ? p95Val - medianVal : null
  };
}

function variantPmEnv(pm, layout, engine) {
  const tmp = layout.tmpDir;
  const base = { TMPDIR: tmp, TEMP: tmp, TMP: tmp };
  if (engine === "bun") {
    return {
      ...base,
      BUN_INSTALL: layout.pm.bunHome,
      BUN_INSTALL_CACHE_DIR: layout.pm.bun || layout.pm.npm
    };
  }
  if (pm === "pnpm") {
    return {
      ...base,
      PNPM_STORE_PATH: layout.pm.pnpmStore
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

function rawInstallCommand(pm, engine, opts = {}) {
  const { frozen = false, production = false } = opts;
  if (engine === "bun") {
    const args = ["install"];
    if (frozen) args.push("--frozen-lockfile");
    if (production) args.push("--production");
    return { cmd: "bun", args };
  }

  // engine=better compares against npm raw behavior by design.
  const resolvedPm = engine === "better" ? "npm" : pm;
  if (resolvedPm === "pnpm") {
    const args = ["install"];
    if (frozen) args.push("--frozen-lockfile");
    if (production) args.push("--prod");
    return { cmd: "pnpm", args };
  }
  if (resolvedPm === "yarn") {
    const args = ["install"];
    if (frozen) args.push("--frozen-lockfile");
    if (production) args.push("--production");
    return { cmd: "yarn", args };
  }
  if (frozen) {
    const args = ["ci"];
    if (production) args.push("--omit=dev");
    return { cmd: "npm", args };
  }
  const args = ["install"];
  if (production) args.push("--omit=dev");
  return { cmd: "npm", args };
}

function parseJsonFromMixedOutput(raw) {
  if (!raw || !raw.trim()) return null;
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // continue
  }

  const starts = [];
  for (let index = 0; index < trimmed.length; index += 1) {
    if (trimmed[index] === "{") starts.push(index);
  }
  for (let index = starts.length - 1; index >= 0; index -= 1) {
    const candidate = trimmed.slice(starts[index]);
    try {
      return JSON.parse(candidate);
    } catch {
      // keep searching
    }
  }
  return null;
}

async function tryReadJsonFile(filePath) {
  if (!filePath) return null;
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function betterInstallArgs(projectRoot, pm, engine, opts = {}) {
  const args = [
    BETTER_BIN_PATH,
    "install",
    "--project-root",
    projectRoot,
    "--pm",
    pm,
    "--engine",
    engine,
    "--json"
  ];
  if (opts.frozen) args.push("--frozen");
  if (opts.production) args.push("--production");
  if (engine === "better") args.push("--experimental");
  if (opts.coreMode) args.push("--core-mode", String(opts.coreMode));
  if (opts.fsConcurrency != null) args.push("--fs-concurrency", String(opts.fsConcurrency));
  if (opts.incremental === false) args.push("--no-incremental");
  if (opts.profile === "minimal") {
    args.push("--measure", "off", "--parity-check", "off");
  }
  if (engine === "better") {
    args.push("--scripts", "off");
  }
  return args;
}

async function runVariant(variant, ctx, roundMeta, skipCleanup = false) {
  const { projectRoot, pm, engine, frozen, production, timeoutMs } = ctx;
  const env = { ...process.env, ...variant.env };
  const nodeModulesPath = path.join(projectRoot, "node_modules");
  const startedAt = Date.now();
  if (!skipCleanup) {
    await rmrf(nodeModulesPath);
  }
  const cleanupWallTimeMs = Date.now() - startedAt;

  if (variant.kind === "raw") {
    const processStartedAt = Date.now();
    const command = rawInstallCommand(pm, engine, { frozen, production });
    const res = await runCommand(command.cmd, command.args, {
      cwd: projectRoot,
      env,
      passthroughStdio: false,
      captureLimitBytes: 256 * 1024,
      timeoutMs
    });
    return {
      ...roundMeta,
      variant: variant.name,
      ok: res.exitCode === 0 && !res.timedOut,
      exitCode: res.exitCode,
      timedOut: res.timedOut,
      startedAt,
      finishedAt: Date.now(),
      cleanupWallTimeMs,
      processWallTimeMs: Date.now() - processStartedAt,
      wallTimeMs: res.wallTimeMs,
      installWallTimeMs: res.wallTimeMs,
      stderrTail: res.stderrTail
    };
  }

  const reportPath = path.join(
    roundMeta.cacheRoot ?? os.tmpdir(),
    `.better-benchmark-${variant.name}-${roundMeta.phase}-${roundMeta.round}.json`
  );
  const args = [...variant.args, "--report", reportPath];
  const processStartedAt = Date.now();
  const res = await runCommand(process.execPath, args, {
    cwd: projectRoot,
    env,
    passthroughStdio: false,
    captureLimitBytes: 4 * 1024 * 1024,
    timeoutMs
  });
  const processWallTimeMs = Date.now() - processStartedAt;
  const parseStartedAt = Date.now();
  const parsedFromReport = await tryReadJsonFile(reportPath);
  const parsed = parsedFromReport ?? parseJsonFromMixedOutput(res.stdout);
  const parseWallTimeMs = Date.now() - parseStartedAt;
  const parsedOk = parsed?.ok;
  const hasValidReport = !!parsed && parsed?.kind === "better.install.report" && parsedOk !== false;
  const installWallTimeMs = Number(parsed?.install?.wallTimeMs);
  await rmrf(reportPath);
  return {
    ...roundMeta,
    variant: variant.name,
    ok: res.exitCode === 0 && !res.timedOut && hasValidReport,
    exitCode: res.exitCode,
    timedOut: res.timedOut,
    startedAt,
    finishedAt: Date.now(),
    cleanupWallTimeMs,
    processWallTimeMs,
    parseWallTimeMs,
    wallTimeMs: res.wallTimeMs,
    installWallTimeMs: Number.isFinite(installWallTimeMs) ? installWallTimeMs : null,
    reportKind: parsed?.kind ?? null,
    reportFound: !!parsed,
    reportParseSource: parsedFromReport ? "report_file" : parsed ? "stdout_fallback" : "none",
    stderrTail: res.stderrTail
  };
}

function buildVariants(projectRoot, pm, engine, opts = {}) {
  const variants = [];
  variants.push({
    name: "raw",
    kind: "raw",
    env: {}
  });
  variants.push({
    name: "betterMinimal",
    kind: "better",
    env: { BETTER_LOG_LEVEL: "silent" },
    args: betterInstallArgs(projectRoot, pm, engine, {
      frozen: opts.frozen,
      production: opts.production,
      coreMode: opts.coreMode,
      fsConcurrency: opts.fsConcurrency,
      incremental: opts.incremental,
      profile: "minimal"
    })
  });
  if (opts.includeFull) {
    variants.push({
      name: "betterFull",
      kind: "better",
      env: { BETTER_LOG_LEVEL: "silent" },
      args: betterInstallArgs(projectRoot, pm, engine, {
        frozen: opts.frozen,
        production: opts.production,
        coreMode: opts.coreMode,
        fsConcurrency: opts.fsConcurrency,
        incremental: opts.incremental,
        profile: "full"
      })
    });
  }
  return variants;
}

function classifyError(sample) {
  if (sample.timedOut) return "timeout";
  if (sample.exitCode !== 0) return "nonzero_exit";
  if (!sample.reportFound) return "missing_report";
  if (sample.reportKind !== "better.install.report") return "invalid_report_kind";
  if (sample.ok === false) return "report_not_ok";
  return "unknown";
}

function formatSampleFailure(sample) {
  const details = [];
  details.push(`exit=${sample.exitCode}`);
  if (sample.timedOut) details.push("timedOut=true");
  if (sample.reportKind) details.push(`reportKind=${sample.reportKind}`);
  if (sample.reportFound === false) details.push("reportMissing=true");
  if (sample.reportParseSource) details.push(`reportSource=${sample.reportParseSource}`);
  if (Number.isFinite(sample.cleanupWallTimeMs)) details.push(`cleanupMs=${sample.cleanupWallTimeMs}`);
  if (Number.isFinite(sample.processWallTimeMs)) details.push(`processMs=${sample.processWallTimeMs}`);
  if (Number.isFinite(sample.parseWallTimeMs)) details.push(`parseMs=${sample.parseWallTimeMs}`);
  if (sample.stderrTail) {
    const compact = String(sample.stderrTail).replace(/\s+/g, " ").trim();
    if (compact) details.push(`stderrTail=${compact.slice(0, 300)}`);
  }
  details.push(`errorClass=${classifyError(sample)}`);
  return details.join(", ");
}

async function runWithHeartbeat(label, fn, logger, heartbeatMs = 15_000) {
  const started = Date.now();
  const timer = setInterval(() => {
    logger.info("benchmark.heartbeat", {
      phase: label,
      elapsedMs: Date.now() - started
    });
  }, heartbeatMs);
  try {
    return await fn();
  } finally {
    clearInterval(timer);
  }
}

function summarizeVariant(samples) {
  const cold = samples.filter((sample) => sample.phase === "cold");
  const warm = samples.filter((sample) => sample.phase === "warm");
  return {
    cold,
    warm,
    stats: {
      cold: computeStats(cold, "wallTimeMs"),
      warm: computeStats(warm, "wallTimeMs"),
      coldInstall: computeStats(cold, "installWallTimeMs"),
      warmInstall: computeStats(warm, "installWallTimeMs")
    }
  };
}

function collectEnvironment() {
  return {
    platform: process.platform,
    arch: process.arch,
    cpus: os.cpus().length,
    cpuModel: os.cpus()[0]?.model ?? null,
    totalMemoryBytes: os.totalmem(),
    nodeVersion: process.version,
    fsType: process.platform === "darwin" ? "apfs" : process.platform === "win32" ? "ntfs" : "ext4"
  };
}

function buildComparison(summary) {
  const rawWarmMedian = summary.raw?.stats?.warm?.median;
  const betterWarmMedian = summary.betterMinimal?.stats?.warm?.median;
  if (!Number.isFinite(rawWarmMedian) || !Number.isFinite(betterWarmMedian) || rawWarmMedian <= 0) {
    return {
      rawWarmMedianMs: rawWarmMedian ?? null,
      betterWarmMedianMs: betterWarmMedian ?? null,
      deltaMs: null,
      deltaPercent: null,
      wrapperTaxMs: null
    };
  }

  const betterWarmInstallMedian = summary.betterMinimal?.stats?.warmInstall?.median;
  return {
    rawWarmMedianMs: rawWarmMedian,
    betterWarmMedianMs: betterWarmMedian,
    deltaMs: betterWarmMedian - rawWarmMedian,
    deltaPercent: ((betterWarmMedian - rawWarmMedian) / rawWarmMedian) * 100,
    wrapperTaxMs: Number.isFinite(betterWarmInstallMedian)
      ? betterWarmMedian - betterWarmInstallMedian
      : null
  };
}

export async function cmdBenchmark(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    printText(`Usage:
  better benchmark [--json] [--project-root PATH] [--pm auto|npm|pnpm|yarn] [--engine pm|bun|better]
                   [--cold-rounds N] [--warm-rounds N] [--timeout-ms N] [--scenario cold_miss|warm_hit|reuse_noop|all]
                   [--frozen] [--production] [--include-full] [--cache-root PATH]
                   [--core-mode auto|js|rust] [--fs-concurrency N] [--no-incremental]
`);
    return;
  }

  const runtime = getRuntimeConfig();
  const commandLogger = childLogger({ command: "benchmark" });
  const { values } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: runtime.json === true },
      "project-root": { type: "string" },
      pm: { type: "string", default: "auto" },
      engine: { type: "string", default: "pm" },
      scenario: { type: "string", default: "all" },
      frozen: { type: "boolean", default: false },
      production: { type: "boolean", default: false },
      "cold-rounds": { type: "string", default: "1" },
      "warm-rounds": { type: "string", default: "3" },
      "timeout-ms": { type: "string", default: "600000" },
      "include-full": { type: "boolean", default: false },
      "cache-root": { type: "string", default: runtime.cacheRoot ?? undefined },
      "core-mode": { type: "string", default: runtime.coreMode ?? "auto" },
      "fs-concurrency": { type: "string", default: String(runtime.fsConcurrency ?? 16) },
      "no-incremental": { type: "boolean", default: false }
    },
    allowPositionals: true,
    strict: false
  });

  const invocationCwd = process.cwd();
  const resolvedRoot = values["project-root"]
    ? { root: path.resolve(values["project-root"]), reason: "flag:--project-root" }
    : await resolveInstallProjectRoot(invocationCwd);
  const projectRoot = resolvedRoot.root;
  const detected = await detectPackageManager(projectRoot);
  const pm = values.pm === "auto" ? detected.pm : values.pm;
  const engine = values.engine;
  const scenario = values.scenario ?? "all";
  if (!["npm", "pnpm", "yarn"].includes(pm)) {
    throw new Error(`Unknown --pm '${pm}'. Expected npm|pnpm|yarn|auto.`);
  }
  if (!["pm", "bun", "better"].includes(engine)) {
    throw new Error(`Unknown --engine '${engine}'. Expected pm|bun|better.`);
  }
  if (!["cold_miss", "warm_hit", "reuse_noop", "all"].includes(scenario)) {
    throw new Error(`Unknown --scenario '${scenario}'. Expected cold_miss|warm_hit|reuse_noop|all.`);
  }
  if (engine === "better" && pm !== "npm") {
    throw new Error("engine=better benchmark requires --pm npm.");
  }

  const coldRounds = Math.max(0, Number.parseInt(values["cold-rounds"], 10) || 0);
  const warmRounds = Math.max(0, Number.parseInt(values["warm-rounds"], 10) || 0);
  const timeoutMs = Math.max(10_000, Number.parseInt(values["timeout-ms"], 10) || 600_000);
  const coreMode = String(values["core-mode"] ?? "auto").toLowerCase();
  if (coreMode !== "auto" && coreMode !== "js" && coreMode !== "rust" && coreMode !== "napi") {
    throw new Error(`Unknown --core-mode '${values["core-mode"]}'. Expected auto|js|rust|napi.`);
  }
  const fsConcurrency = Math.max(1, Math.min(128, Number.parseInt(values["fs-concurrency"], 10) || 16));
  const incremental = values["no-incremental"] ? false : true;
  if (coldRounds === 0 && warmRounds === 0) {
    throw new Error("At least one of --cold-rounds or --warm-rounds must be greater than 0.");
  }

  const runCold = scenario === "cold_miss" || scenario === "all";
  const runWarm = scenario === "warm_hit" || scenario === "reuse_noop" || scenario === "all";
  const isReuseNoop = scenario === "reuse_noop";

  const cacheBase = values["cache-root"]
    ? getCacheRoot(values["cache-root"])
    : path.join(os.tmpdir(), `better-benchmark-${Date.now()}-${shortHash(projectRoot)}`);

  const variants = buildVariants(projectRoot, pm, engine, {
    frozen: values.frozen === true,
    production: values.production === true,
    includeFull: values["include-full"] === true,
    coreMode,
    fsConcurrency,
    incremental
  });

  // Lockfile parity
  let parity = null;
  try {
    const pkgLockPath = path.join(projectRoot, "package-lock.json");
    const pnpmLockPath = path.join(projectRoot, "pnpm-lock.yaml");
    const yarnLockPath = path.join(projectRoot, "yarn.lock");
    const lockPaths = [pkgLockPath, pnpmLockPath, yarnLockPath];
    const lockHashes = {};
    for (const lp of lockPaths) {
      try {
        const raw = await fs.readFile(lp);
        lockHashes[path.basename(lp)] = crypto.createHash("sha256").update(raw).digest("hex");
      } catch { /* file doesn't exist */ }
    }
    parity = { lockfiles: lockHashes, verified: Object.keys(lockHashes).length > 0 };
  } catch { parity = null; }

  const perVariantSamples = {};
  for (const variant of variants) {
    perVariantSamples[variant.name] = [];
  }

  commandLogger.info("benchmark.start", {
    projectRoot,
    pm,
    engine,
    scenario,
    coldRounds,
    warmRounds,
    timeoutMs
  });

  for (const variant of variants) {
    if (runCold && coldRounds > 0) {
      for (let round = 1; round <= coldRounds; round += 1) {
        const runCacheRoot = path.join(cacheBase, "cold", variant.name, String(round));
        let layout = cacheLayout(runCacheRoot);
        layout = await ensureCacheDirs(layout, { projectRootForFallback: projectRoot });
        variant.env = { ...variant.env, ...variantPmEnv(pm, layout, engine), BETTER_CACHE_ROOT: layout.root };
        commandLogger.info("benchmark.round.start", { variant: variant.name, phase: "cold", round, cacheRoot: layout.root });
        const sample = await runWithHeartbeat(
          `${variant.name}:cold:${round}`,
          () =>
            runVariant(
              variant,
              {
                projectRoot,
                pm,
                engine,
                frozen: values.frozen === true,
                production: values.production === true,
                timeoutMs
              },
              { phase: "cold", round, cacheRoot: layout.root }
            ),
          commandLogger
        );
        commandLogger.info("benchmark.round.end", {
          variant: variant.name,
          phase: "cold",
          round,
          ok: sample.ok,
          wallTimeMs: sample.wallTimeMs,
          cleanupWallTimeMs: sample.cleanupWallTimeMs,
          processWallTimeMs: sample.processWallTimeMs
        });
        perVariantSamples[variant.name].push(sample);
        if (!sample.ok) {
          throw new Error(`${variant.name} cold round ${round} failed (${formatSampleFailure(sample)})`);
        }
      }
    }

    if (runWarm && warmRounds > 0) {
      const runCacheRoot = path.join(cacheBase, "warm", variant.name);
      let layout = cacheLayout(runCacheRoot);
      layout = await ensureCacheDirs(layout, { projectRootForFallback: projectRoot });
      variant.env = { ...variant.env, ...variantPmEnv(pm, layout, engine), BETTER_CACHE_ROOT: layout.root };

      // Prime cache
      commandLogger.info("benchmark.round.start", { variant: variant.name, phase: "warm-prime", round: 0, cacheRoot: layout.root });
      const prime = await runWithHeartbeat(
        `${variant.name}:warm-prime`,
        () =>
          runVariant(
            variant,
            {
              projectRoot,
              pm,
              engine,
              frozen: values.frozen === true,
              production: values.production === true,
              timeoutMs
            },
            { phase: "warm-prime", round: 0, cacheRoot: layout.root }
          ),
        commandLogger
      );
      commandLogger.info("benchmark.round.end", {
        variant: variant.name,
        phase: "warm-prime",
        round: 0,
        ok: prime.ok,
        wallTimeMs: prime.wallTimeMs,
        cleanupWallTimeMs: prime.cleanupWallTimeMs,
        processWallTimeMs: prime.processWallTimeMs
      });
      if (!prime.ok) {
        throw new Error(`${variant.name} warm prime failed (${formatSampleFailure(prime)})`);
      }

      for (let round = 1; round <= warmRounds; round += 1) {
        commandLogger.info("benchmark.round.start", { variant: variant.name, phase: "warm", round, cacheRoot: layout.root });
        const sample = await runWithHeartbeat(
          `${variant.name}:warm:${round}`,
          () =>
            runVariant(
              variant,
              {
                projectRoot,
                pm,
                engine,
                frozen: values.frozen === true,
                production: values.production === true,
                timeoutMs
              },
              { phase: "warm", round, cacheRoot: layout.root },
              isReuseNoop
            ),
          commandLogger
        );
        commandLogger.info("benchmark.round.end", {
          variant: variant.name,
          phase: "warm",
          round,
          ok: sample.ok,
          wallTimeMs: sample.wallTimeMs,
          cleanupWallTimeMs: sample.cleanupWallTimeMs,
          processWallTimeMs: sample.processWallTimeMs
        });
        perVariantSamples[variant.name].push(sample);
        if (!sample.ok) {
          throw new Error(`${variant.name} warm round ${round} failed (${formatSampleFailure(sample)})`);
        }
      }
    }
  }

  const variantsSummary = {};
  for (const [name, samples] of Object.entries(perVariantSamples)) {
    variantsSummary[name] = summarizeVariant(samples);
  }
  const comparison = buildComparison(variantsSummary);

  const byScenario = [];
  if (runCold) {
    const coldRaw = variantsSummary.raw?.stats?.cold?.median;
    const coldBetter = variantsSummary.betterMinimal?.stats?.cold?.median;
    byScenario.push({
      scenario: "cold_miss",
      rawMedianMs: coldRaw ?? null,
      betterMedianMs: coldBetter ?? null,
      deltaMs: coldRaw != null && coldBetter != null ? coldBetter - coldRaw : null,
      deltaPercent: coldRaw != null && coldBetter != null && coldRaw > 0 ? ((coldBetter - coldRaw) / coldRaw) * 100 : null
    });
  }
  if (runWarm) {
    byScenario.push({
      scenario: isReuseNoop ? "reuse_noop" : "warm_hit",
      rawMedianMs: comparison.rawWarmMedianMs,
      betterMedianMs: comparison.betterWarmMedianMs,
      deltaMs: comparison.deltaMs,
      deltaPercent: comparison.deltaPercent
    });
  }

  const report = {
    ok: true,
    kind: "better.benchmark",
    schemaVersion: 2,
    projectRoot,
    projectRootResolution: resolvedRoot,
    pm: { selected: pm, detected: detected.pm, reason: detected.reason },
    engine,
    scenario,
    env: collectEnvironment(),
    parity,
    config: {
      coldRounds,
      warmRounds,
      timeoutMs,
      frozen: values.frozen === true,
      production: values.production === true,
      includeFull: values["include-full"] === true,
      coreMode,
      fsConcurrency,
      incremental,
      cacheRootBase: cacheBase
    },
    variants: variantsSummary,
    comparison: {
      ...comparison,
      byScenario
    }
  };

  if (values.json) {
    printJson(report);
  } else {
    const lines = [
      "better benchmark",
      `- project root: ${projectRoot}`,
      `- pm/engine: ${pm}/${engine}`,
      `- scenario: ${scenario}`,
      `- env: ${process.platform}/${process.arch} node ${process.version}`,
      `- cold rounds: ${coldRounds}, warm rounds: ${warmRounds}`,
      `- raw warm median: ${comparison.rawWarmMedianMs == null ? "n/a" : `${comparison.rawWarmMedianMs.toFixed(1)} ms`}`,
      `- better warm median: ${comparison.betterWarmMedianMs == null ? "n/a" : `${comparison.betterWarmMedianMs.toFixed(1)} ms`}`,
      `- delta: ${comparison.deltaMs == null ? "n/a" : `${comparison.deltaMs.toFixed(1)} ms (${comparison.deltaPercent.toFixed(2)}%)`}`,
      `- wrapper tax: ${comparison.wrapperTaxMs == null ? "n/a" : `${comparison.wrapperTaxMs.toFixed(1)} ms`}`
    ];
    printText(lines.join("\n"));
  }

  commandLogger.info("benchmark.end", {
    rawWarmMedianMs: comparison.rawWarmMedianMs,
    betterWarmMedianMs: comparison.betterWarmMedianMs,
    deltaMs: comparison.deltaMs
  });
}
