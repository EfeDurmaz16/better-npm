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

function computeStats(samples, key = "wallTimeMs") {
  const values = samples
    .map((sample) => Number(sample?.[key]))
    .filter((value) => Number.isFinite(value) && value >= 0);
  if (values.length === 0) {
    return {
      count: 0,
      min: null,
      max: null,
      mean: null,
      median: null,
      p95: null
    };
  }
  return {
    count: values.length,
    min: Math.min(...values),
    max: Math.max(...values),
    mean: mean(values),
    median: median(values),
    p95: p95(values)
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
  if (opts.profile === "minimal") {
    args.push("--measure", "off", "--parity-check", "off");
  }
  if (engine === "better") {
    args.push("--scripts", "off");
  }
  return args;
}

async function runVariant(variant, ctx, roundMeta) {
  const { projectRoot, pm, engine, frozen, production, timeoutMs } = ctx;
  const env = { ...process.env, ...variant.env };
  const nodeModulesPath = path.join(projectRoot, "node_modules");
  await rmrf(nodeModulesPath);

  if (variant.kind === "raw") {
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
      wallTimeMs: res.wallTimeMs,
      installWallTimeMs: res.wallTimeMs,
      stderrTail: res.stderrTail
    };
  }

  const res = await runCommand(process.execPath, variant.args, {
    cwd: projectRoot,
    env,
    passthroughStdio: false,
    captureLimitBytes: 1024 * 1024,
    timeoutMs
  });
  const parsed = parseJsonFromMixedOutput(res.stdout);
  const installWallTimeMs = Number(parsed?.install?.wallTimeMs);
  return {
    ...roundMeta,
    variant: variant.name,
    ok: res.exitCode === 0 && !res.timedOut && parsed?.ok === true,
    exitCode: res.exitCode,
    timedOut: res.timedOut,
    wallTimeMs: res.wallTimeMs,
    installWallTimeMs: Number.isFinite(installWallTimeMs) ? installWallTimeMs : null,
    reportKind: parsed?.kind ?? null,
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
        profile: "full"
      })
    });
  }
  return variants;
}

function formatSampleFailure(sample) {
  const details = [];
  details.push(`exit=${sample.exitCode}`);
  if (sample.timedOut) details.push("timedOut=true");
  if (sample.reportKind) details.push(`reportKind=${sample.reportKind}`);
  if (sample.stderrTail) {
    const compact = String(sample.stderrTail).replace(/\s+/g, " ").trim();
    if (compact) details.push(`stderrTail=${compact.slice(0, 300)}`);
  }
  return details.join(", ");
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
                   [--cold-rounds N] [--warm-rounds N] [--timeout-ms N]
                   [--frozen] [--production] [--include-full] [--cache-root PATH]
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
      frozen: { type: "boolean", default: false },
      production: { type: "boolean", default: false },
      "cold-rounds": { type: "string", default: "1" },
      "warm-rounds": { type: "string", default: "3" },
      "timeout-ms": { type: "string", default: "600000" },
      "include-full": { type: "boolean", default: false },
      "cache-root": { type: "string", default: runtime.cacheRoot ?? undefined }
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
  if (!["npm", "pnpm", "yarn"].includes(pm)) {
    throw new Error(`Unknown --pm '${pm}'. Expected npm|pnpm|yarn|auto.`);
  }
  if (!["pm", "bun", "better"].includes(engine)) {
    throw new Error(`Unknown --engine '${engine}'. Expected pm|bun|better.`);
  }
  if (engine === "better" && pm !== "npm") {
    throw new Error("engine=better benchmark requires --pm npm.");
  }

  const coldRounds = Math.max(0, Number.parseInt(values["cold-rounds"], 10) || 0);
  const warmRounds = Math.max(0, Number.parseInt(values["warm-rounds"], 10) || 0);
  const timeoutMs = Math.max(10_000, Number.parseInt(values["timeout-ms"], 10) || 600_000);
  if (coldRounds === 0 && warmRounds === 0) {
    throw new Error("At least one of --cold-rounds or --warm-rounds must be greater than 0.");
  }

  const cacheBase = values["cache-root"]
    ? getCacheRoot(values["cache-root"])
    : path.join(os.tmpdir(), `better-benchmark-${Date.now()}-${shortHash(projectRoot)}`);

  const variants = buildVariants(projectRoot, pm, engine, {
    frozen: values.frozen === true,
    production: values.production === true,
    includeFull: values["include-full"] === true
  });

  const perVariantSamples = {};
  for (const variant of variants) {
    perVariantSamples[variant.name] = [];
  }

  commandLogger.info("benchmark.start", {
    projectRoot,
    pm,
    engine,
    coldRounds,
    warmRounds,
    timeoutMs
  });

  for (const variant of variants) {
    if (coldRounds > 0) {
      for (let round = 1; round <= coldRounds; round += 1) {
        const runCacheRoot = path.join(cacheBase, "cold", variant.name, String(round));
        let layout = cacheLayout(runCacheRoot);
        layout = await ensureCacheDirs(layout, { projectRootForFallback: projectRoot });
        variant.env = { ...variant.env, ...variantPmEnv(pm, layout, engine), BETTER_CACHE_ROOT: layout.root };
        const sample = await runVariant(
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
        );
        perVariantSamples[variant.name].push(sample);
        if (!sample.ok) {
          throw new Error(`${variant.name} cold round ${round} failed (${formatSampleFailure(sample)})`);
        }
      }
    }

    if (warmRounds > 0) {
      const runCacheRoot = path.join(cacheBase, "warm", variant.name);
      let layout = cacheLayout(runCacheRoot);
      layout = await ensureCacheDirs(layout, { projectRootForFallback: projectRoot });
      variant.env = { ...variant.env, ...variantPmEnv(pm, layout, engine), BETTER_CACHE_ROOT: layout.root };

      // Prime cache
      const prime = await runVariant(
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
      );
      if (!prime.ok) {
        throw new Error(`${variant.name} warm prime failed (${formatSampleFailure(prime)})`);
      }

      for (let round = 1; round <= warmRounds; round += 1) {
        const sample = await runVariant(
          variant,
          {
            projectRoot,
            pm,
            engine,
            frozen: values.frozen === true,
            production: values.production === true,
            timeoutMs
          },
          { phase: "warm", round, cacheRoot: layout.root }
        );
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
  const report = {
    ok: true,
    kind: "better.benchmark",
    schemaVersion: 1,
    projectRoot,
    projectRootResolution: resolvedRoot,
    pm: { selected: pm, detected: detected.pm, reason: detected.reason },
    engine,
    config: {
      coldRounds,
      warmRounds,
      timeoutMs,
      frozen: values.frozen === true,
      production: values.production === true,
      includeFull: values["include-full"] === true,
      cacheRootBase: cacheBase
    },
    variants: variantsSummary,
    comparison
  };

  if (values.json) {
    printJson(report);
  } else {
    const lines = [
      "better benchmark",
      `- project root: ${projectRoot}`,
      `- pm/engine: ${pm}/${engine}`,
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
