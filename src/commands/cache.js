import { parseArgs } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { getCacheRoot, cacheLayout, ensureCacheDirs, loadState, saveState } from "../lib/cache.js";
import { scanTree } from "../lib/fsScan.js";
import { runCommand } from "../lib/spawn.js";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import { childLogger } from "../lib/log.js";
import { sha256Hex } from "../lib/hash.js";
import { detectPackageManager } from "../pm/detect.js";
import {
  deriveGlobalCacheContext,
  verifyGlobalCacheEntry,
  materializeFromGlobalCache,
  captureProjectNodeModulesToGlobalCache
} from "../lib/globalCache.js";

async function listFiles(dir) {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function gcDir(dir, cutoffMs, dryRun) {
  const deletions = [];
  const ents = await listFiles(dir);
  for (const ent of ents) {
    const full = path.join(dir, ent.name);
    let st;
    try {
      st = await fs.stat(full);
    } catch {
      continue;
    }
    if (st.mtimeMs >= cutoffMs) continue;
    deletions.push({ path: full, size: st.size, ageMs: Date.now() - st.mtimeMs });
    if (!dryRun) {
      await fs.rm(full, { recursive: true, force: true });
    }
  }
  return deletions;
}

function parsePackageSpec(spec) {
  if (!spec) return { name: null, version: null };
  if (spec.startsWith("@")) {
    const secondAt = spec.indexOf("@", 1);
    if (secondAt > 0) {
      return { name: spec.slice(0, secondAt), version: spec.slice(secondAt + 1) || null };
    }
    return { name: spec, version: null };
  }
  const lastAt = spec.lastIndexOf("@");
  if (lastAt > 0) {
    return { name: spec.slice(0, lastAt), version: spec.slice(lastAt + 1) || null };
  }
  return { name: spec, version: null };
}

async function scanEntriesMetadata(dir) {
  let entries = 0;
  let oldest = null;
  let newest = null;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    const dirents = await listFiles(current);
    for (const dirent of dirents) {
      const full = path.join(current, dirent.name);
      if (dirent.isDirectory()) {
        stack.push(full);
        continue;
      }
      let st;
      try {
        st = await fs.stat(full);
      } catch {
        continue;
      }
      entries += 1;
      if (!oldest || st.mtimeMs < oldest) oldest = st.mtimeMs;
      if (!newest || st.mtimeMs > newest) newest = st.mtimeMs;
    }
  }
  return { entries, oldest, newest };
}

async function collectHitMissFromRunReports(runsDir) {
  const out = { runs: 0, hits: 0, misses: 0 };
  const runFiles = await listFiles(runsDir);
  for (const file of runFiles) {
    if (!file.isFile() || !file.name.endsWith(".json")) continue;
    const full = path.join(runsDir, file.name);
    try {
      const parsed = JSON.parse(await fs.readFile(full, "utf8"));
      const metrics = parsed?.metrics?.cache ?? parsed?.install?.metrics?.cache ?? null;
      if (!metrics) continue;
      out.runs += 1;
      out.hits += Number(metrics.hits ?? 0);
      out.misses += Number(metrics.misses ?? 0);
    } catch {
      // ignore invalid report
    }
  }
  return out;
}

function normalizeScriptsMode(value) {
  return value === "off" ? "off" : "rebuild";
}

async function resolveGlobalCacheContextForCacheCommand(values) {
  const projectRoot = values["project-root"] ? path.resolve(values["project-root"]) : process.cwd();
  const detected = await detectPackageManager(projectRoot);
  const pm = values.pm === "auto" ? detected.pm : values.pm;
  const engine = values.engine ?? "pm";
  const cacheMode = values["cache-mode"] ?? "strict";
  const rawCacheScripts = values["cache-scripts"] ?? "rebuild";
  if (pm !== "npm" && pm !== "pnpm" && pm !== "yarn") {
    throw new Error(`Unknown --pm '${pm}'. Expected npm|pnpm|yarn|auto.`);
  }
  if (engine !== "pm" && engine !== "bun" && engine !== "better") {
    throw new Error(`Unknown --engine '${engine}'. Expected pm|bun|better.`);
  }
  if (cacheMode !== "strict" && cacheMode !== "relaxed") {
    throw new Error(`Unknown --cache-mode '${cacheMode}'. Expected strict|relaxed.`);
  }
  if (rawCacheScripts !== "rebuild" && rawCacheScripts !== "off") {
    throw new Error(`Unknown --cache-scripts '${rawCacheScripts}'. Expected rebuild|off.`);
  }

  return {
    projectRoot,
    pm,
    engine,
    cacheMode,
    cacheKeySalt: values["cache-key-salt"] ?? null,
    cacheScripts: normalizeScriptsMode(rawCacheScripts)
  };
}

export async function cmdCache(argv) {
  const runtime = getRuntimeConfig();
  const commandLogger = childLogger({ command: "cache" });
  const sub = argv[0];
  const rest = argv.slice(1);

  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    printText(`Usage:
  better cache stats [--json] [--cache-root PATH]
  better cache gc [--dry-run] [--keep-days N] [--json] [--cache-root PATH]
  better cache explain <name@version|runId> [--json] [--cache-root PATH]
  better cache warm [--project-root PATH] [--pm auto|npm|pnpm|yarn] [--engine pm|bun|better]
                    [--cache-mode strict|relaxed] [--cache-key-salt VALUE] [--cache-scripts rebuild|off]
                    [--json] [--cache-root PATH]
  better cache materialize [--project-root PATH] [--pm auto|npm|pnpm|yarn] [--engine pm|bun|better]
                           [--cache-mode strict|relaxed] [--cache-key-salt VALUE]
                           [--link-strategy auto|hardlink|copy] [--json] [--cache-root PATH]
  better cache verify [--project-root PATH] [--pm auto|npm|pnpm|yarn] [--engine pm|bun|better]
                      [--cache-mode strict|relaxed] [--cache-key-salt VALUE] [--json] [--cache-root PATH]
  better cache export --out <file.tgz> [--json] [--cache-root PATH]
  better cache import --in <file.tgz> [--json] [--cache-root PATH]
`);
    return;
  }

  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      json: { type: "boolean", default: runtime.json === true },
      "cache-root": { type: "string", default: runtime.cacheRoot ?? undefined },
      "dry-run": { type: "boolean", default: false },
      "keep-days": { type: "string", default: "30" },
      "project-root": { type: "string" },
      pm: { type: "string", default: "auto" },
      engine: { type: "string", default: "pm" },
      "cache-mode": { type: "string", default: "strict" },
      "cache-key-salt": { type: "string" },
      "cache-scripts": { type: "string", default: "rebuild" },
      "link-strategy": { type: "string", default: "auto" },
      out: { type: "string" },
      in: { type: "string" }
    },
    allowPositionals: true,
    strict: false
  });

  const requestedCacheRoot = getCacheRoot(values["cache-root"]);
  let layout = cacheLayout(requestedCacheRoot);
  layout = await ensureCacheDirs(layout, { projectRootForFallback: process.cwd() });
  commandLogger.info("cache.subcommand", { subcommand: sub, cacheRoot: layout.root });

  if (sub === "stats") {
    const state = await loadState(layout);
    const total = await scanTree(layout.root);
    const npm = await scanTree(layout.pm.npm);
    const bun = await scanTree(layout.pm.bun);
    const pnpm = await scanTree(layout.pm.pnpmStore);
    const yarn = await scanTree(layout.pm.yarn);
    const runs = await scanTree(layout.runsDir);
    const analyses = await scanTree(layout.analysesDir);
    const tmp = await scanTree(layout.tmpDir);
    const meta = await scanEntriesMetadata(layout.root);
    const runHitMiss = await collectHitMissFromRunReports(layout.runsDir);
    const persisted = state.cacheMetrics ?? {};
    const hits = Number(persisted.cacheHits ?? runHitMiss.hits ?? 0);
    const misses = Number(persisted.cacheMisses ?? runHitMiss.misses ?? 0);
    const ratio = hits + misses > 0 ? hits / (hits + misses) : null;

    const out = {
      ok: true,
      kind: "better.cache.stats",
      schemaVersion: 2,
      cacheRoot: layout.root,
      entries: {
        total: meta.entries,
        oldestEntry: meta.oldest ? new Date(meta.oldest).toISOString() : null,
        newestEntry: meta.newest ? new Date(meta.newest).toISOString() : null
      },
      sizes: {
        totalBytes: total.physicalBytes,
        pm: {
          bunBytes: bun.physicalBytes,
          npmBytes: npm.physicalBytes,
          pnpmStoreBytes: pnpm.physicalBytes,
          yarnBytes: yarn.physicalBytes
        },
        runsBytes: runs.physicalBytes,
        analysesBytes: analyses.physicalBytes,
        tmpBytes: tmp.physicalBytes
      },
      hitRatio: {
        hits,
        misses,
        ratio,
        sampledRuns: Number(persisted.installRuns ?? runHitMiss.runs ?? 0)
      },
      globalCache: {
        entries: Object.keys(state.cacheEntries ?? {}).length,
        materializedProjects: Object.keys(state.materializationIndex ?? {}).length,
        gcPolicy: state.gc ?? null
      },
      trackedPackages: Object.keys(state.cachePackages ?? {}).length,
      projects: Object.values(state.projects ?? {})
    };

    if (values.json) printJson(out);
    else {
      printText(
        [
          "better cache stats",
          `- root: ${layout.root}`,
          `- total: ${(out.sizes.totalBytes / 1024 / 1024).toFixed(1)} MiB`,
          `- bun cache: ${(out.sizes.pm.bunBytes / 1024 / 1024).toFixed(1)} MiB`,
          `- npm cache: ${(out.sizes.pm.npmBytes / 1024 / 1024).toFixed(1)} MiB`,
          `- pnpm store: ${(out.sizes.pm.pnpmStoreBytes / 1024 / 1024).toFixed(1)} MiB`,
          `- yarn cache: ${(out.sizes.pm.yarnBytes / 1024 / 1024).toFixed(1)} MiB`,
          `- entries: ${out.entries.total}`,
          `- oldest/newest: ${out.entries.oldestEntry ?? "n/a"} / ${out.entries.newestEntry ?? "n/a"}`,
          `- hit ratio: ${out.hitRatio.ratio == null ? "n/a" : `${(out.hitRatio.ratio * 100).toFixed(1)}%`} (${out.hitRatio.hits}/${out.hitRatio.hits + out.hitRatio.misses})`,
          `- global cache entries: ${out.globalCache.entries}`,
          `- materialized projects: ${out.globalCache.materializedProjects}`,
          `- tracked packages: ${out.trackedPackages}`,
          `- projects: ${out.projects.length}`
        ].join("\n")
      );
    }
    return;
  }

  if (sub === "gc") {
    const keepDays = Number(values["keep-days"]);
    if (!Number.isFinite(keepDays) || keepDays < 0) throw new Error("--keep-days must be a non-negative number");
    const cutoffMs = Date.now() - keepDays * 24 * 60 * 60 * 1000;
    const dryRun = values["dry-run"];

    const deletedRuns = await gcDir(layout.runsDir, cutoffMs, dryRun);
    const deletedAnalyses = await gcDir(layout.analysesDir, cutoffMs, dryRun);
    const deletedTmp = await gcDir(layout.tmpDir, cutoffMs, dryRun);
    const entriesRemoved = deletedRuns.length + deletedAnalyses.length + deletedTmp.length;
    const bytesFreed = [...deletedRuns, ...deletedAnalyses, ...deletedTmp].reduce((sum, item) => sum + Number(item.size ?? 0), 0);

    const out = {
      ok: true,
      kind: "better.cache.gc",
      schemaVersion: 2,
      cacheRoot: layout.root,
      dryRun,
      keepDays,
      entriesRemoved,
      bytesFreed,
      deleted: {
        runs: deletedRuns,
        analyses: deletedAnalyses,
        tmp: deletedTmp
      }
    };
    if (!dryRun) {
      const state = await loadState(layout);
      state.gc = {
        ...(state.gc ?? {}),
        maxAgeDays: keepDays,
        lastRunAt: new Date().toISOString(),
        lastFreedBytes: bytesFreed
      };
      await saveState(layout, state);
    }
    if (values.json) printJson(out);
    else {
      printText(
        [
          `better cache gc${dryRun ? " (dry-run)" : ""}`,
          `- keep days: ${keepDays}`,
          `- entries: ${entriesRemoved}`,
          `- bytes: ${(bytesFreed / 1024 / 1024).toFixed(1)} MiB`,
          `- deleted runs: ${deletedRuns.length}`,
          `- deleted analyses: ${deletedAnalyses.length}`,
          `- deleted tmp: ${deletedTmp.length}`
        ].join("\n")
      );
    }
    return;
  }

  if (sub === "explain") {
    const target = positionals[0];
    if (!target) throw new Error("better cache explain requires an argument (e.g. name@version or runId)");

    // Run report lookup.
    const runPath = path.join(layout.runsDir, `${target}.json`);
    try {
      const raw = await fs.readFile(runPath, "utf8");
      const parsed = JSON.parse(raw);
      const out = { ok: true, kind: "better.cache.explain", schemaVersion: 2, target, runReport: parsed };
      if (values.json) printJson(out);
      else printText(`Found run report: ${runPath}`);
      return;
    } catch {
      // ignore
    }

    const state = await loadState(layout);
    const entry = state.analysesIndex?.[target] ?? null;
    const globalEntryByKey = state.cacheEntries?.[target] ?? null;
    const spec = parsePackageSpec(target);
    const normalizedSpec = spec.version ? `${spec.name}@${spec.version}` : String(spec.name);
    const cacheKey = sha256Hex(normalizedSpec.toLowerCase());
    const tarballHint = path.join(layout.store.tarballsDir, "sha512");
    const unpackedHint = path.join(layout.store.unpackedDir, "sha512");
    const lookedUpPaths = [layout.pm.npm, layout.pm.pnpmStore, layout.pm.yarn, layout.pm.bun, tarballHint, unpackedHint];
    const observedInProjects = entry ? Object.keys(entry.projects ?? {}) : [];
    const tracked = state.cachePackages ?? {};

    let exactMatch = null;
    let familyMatches = [];
    if (spec.name && spec.version) {
      exactMatch = tracked[`${spec.name}@${spec.version}`] ?? null;
    } else if (spec.name) {
      familyMatches = Object.entries(tracked)
        .filter(([cacheSpec]) => cacheSpec.startsWith(`${spec.name}@`))
        .map(([cacheSpec, meta]) => ({ cacheSpec, meta }))
        .sort((a, b) => String(a.cacheSpec).localeCompare(String(b.cacheSpec)));
      if (familyMatches.length === 1) {
        exactMatch = familyMatches[0].meta;
      }
    }

    const trackedProjects = exactMatch?.projects ? Object.keys(exactMatch.projects) : [];
    const mergedObservedProjects = [...new Set([...observedInProjects, ...trackedProjects])];
    const isObserved = mergedObservedProjects.length > 0;
    const cached = Boolean(globalEntryByKey) || isObserved;
    const reason = globalEntryByKey
      ? `Found global materialization cache entry ${target}.`
      : exactMatch
      ? `Found Better cache tracking entry for ${exactMatch.name}@${exactMatch.version}.`
      : isObserved
        ? "Package identity was observed in prior analyses; package-manager cache artifacts are not universally mappable yet."
        : "Package identity was not observed in Better analysis index or run reports.";
    const out = {
      ok: true,
      kind: "better.cache.explain",
      schemaVersion: 2,
      target,
      package: {
        name: spec.name,
        version: spec.version,
        normalized: normalizedSpec
      },
      keyDerivation: {
        algorithm: "sha256(lowercase(name@version-or-name))",
        key: cacheKey,
        input: normalizedSpec.toLowerCase()
      },
      cached,
      reason,
      cacheRoot: layout.root,
      pmCacheRoots: layout.pm,
      lookedUpPaths,
      observedInProjects: mergedObservedProjects,
      lastSeenAt: exactMatch?.lastUsedAt ?? entry?.lastSeenAt ?? null,
      globalCacheEntry: globalEntryByKey
        ? {
            key: target,
            pm: globalEntryByKey.pm ?? null,
            engine: globalEntryByKey.engine ?? null,
            cacheMode: globalEntryByKey.cacheMode ?? null,
            lockHash: globalEntryByKey.lockHash ?? null,
            createdAt: globalEntryByKey.createdAt ?? null,
            lastUsedAt: globalEntryByKey.lastUsedAt ?? null,
            useCount: Number(globalEntryByKey.useCount ?? 0),
            hitCount: Number(globalEntryByKey.hitCount ?? 0),
            missCount: Number(globalEntryByKey.missCount ?? 0)
          }
        : null,
      tracking: exactMatch
        ? {
            seenCount: Number(exactMatch.seenCount ?? 0),
            cacheHitCount: Number(exactMatch.cacheHitCount ?? 0),
            cacheMissCount: Number(exactMatch.cacheMissCount ?? 0),
            lastSource: exactMatch.lastSource ?? null,
            casKeys: exactMatch.casKeys ?? []
          }
        : {
            familyMatches: familyMatches.map((item) => item.cacheSpec)
          }
    };
    if (values.json) printJson(out);
    else {
      printText(
        [
          `better cache explain ${target}`,
          `- key: ${out.keyDerivation.key}`,
          `- cached: ${out.cached ? "yes" : "no"}`,
          `- reason: ${out.reason}`,
          `- cache root: ${layout.root}`,
          `- last seen: ${out.lastSeenAt ?? "never"}`,
          `- observed in projects: ${out.observedInProjects.length}`
        ].join("\n")
      );
    }
    return;
  }

  if (sub === "warm") {
    const context = await resolveGlobalCacheContextForCacheCommand(values);
    const derived = await deriveGlobalCacheContext(context.projectRoot, {
      pm: context.pm,
      engine: context.engine,
      cacheMode: context.cacheMode,
      scriptsMode: context.cacheScripts,
      cacheKeySalt: context.cacheKeySalt
    });
    if (!derived.decision.eligible || !derived.key) {
      const out = {
        ok: false,
        kind: "better.cache.warm",
        schemaVersion: 1,
        projectRoot: context.projectRoot,
        pm: context.pm,
        engine: context.engine,
        reason: derived.decision.reason
      };
      if (values.json) printJson(out);
      else printText(`better cache warm: ${out.reason}`);
      process.exitCode = 1;
      return;
    }

    const verify = await verifyGlobalCacheEntry(layout, derived.key);
    if (verify.ok) {
      const out = {
        ok: true,
        kind: "better.cache.warm",
        schemaVersion: 1,
        projectRoot: context.projectRoot,
        key: derived.key,
        status: "already_warm",
        decision: derived.decision
      };
      if (values.json) printJson(out);
      else printText(`better cache warm: already warm (${derived.key.slice(0, 12)}…)`);
      return;
    }

    const captured = await captureProjectNodeModulesToGlobalCache(layout, derived.key, context.projectRoot, {
      linkStrategy: values["link-strategy"] ?? "auto",
      lockHash: derived.lockHash,
      lockfile: derived.lockfile,
      fingerprint: derived.fingerprint,
      pm: context.pm,
      engine: context.engine,
      scriptsMode: context.cacheScripts,
      cacheMode: context.cacheMode
    });
    if (!captured.ok) {
      const out = {
        ok: false,
        kind: "better.cache.warm",
        schemaVersion: 1,
        projectRoot: context.projectRoot,
        key: derived.key,
        status: "failed",
        reason: captured.reason
      };
      if (values.json) printJson(out);
      else printText(`better cache warm: ${captured.reason}`);
      process.exitCode = 1;
      return;
    }

    const state = await loadState(layout);
    state.cacheEntries = state.cacheEntries ?? {};
    state.cacheEntries[derived.key] = {
      ...(state.cacheEntries[derived.key] ?? {}),
      key: derived.key,
      pm: context.pm,
      engine: context.engine,
      cacheMode: context.cacheMode,
      scriptsMode: context.cacheScripts,
      lockHash: derived.lockHash,
      lockfile: derived.lockfile,
      runtimeFingerprint: derived.fingerprint,
      createdAt: (state.cacheEntries[derived.key]?.createdAt ?? new Date().toISOString()),
      lastUsedAt: new Date().toISOString(),
      useCount: Number(state.cacheEntries[derived.key]?.useCount ?? 0) + 1,
      status: "stored"
    };
    await saveState(layout, state);

    const out = {
      ok: true,
      kind: "better.cache.warm",
      schemaVersion: 1,
      projectRoot: context.projectRoot,
      key: derived.key,
      status: "stored",
      durationMs: captured.durationMs,
      stats: captured.stats
    };
    if (values.json) printJson(out);
    else printText(`better cache warm: stored ${derived.key.slice(0, 12)}…`);
    return;
  }

  if (sub === "materialize") {
    const context = await resolveGlobalCacheContextForCacheCommand(values);
    const derived = await deriveGlobalCacheContext(context.projectRoot, {
      pm: context.pm,
      engine: context.engine,
      cacheMode: context.cacheMode,
      scriptsMode: context.cacheScripts,
      cacheKeySalt: context.cacheKeySalt
    });
    if (!derived.decision.eligible || !derived.key) {
      const out = {
        ok: false,
        kind: "better.cache.materialize",
        schemaVersion: 1,
        projectRoot: context.projectRoot,
        reason: derived.decision.reason
      };
      if (values.json) printJson(out);
      else printText(`better cache materialize: ${out.reason}`);
      process.exitCode = 1;
      return;
    }

    const materialized = await materializeFromGlobalCache(layout, derived.key, context.projectRoot, {
      linkStrategy: values["link-strategy"] ?? "auto"
    });
    if (!materialized.ok) {
      const out = {
        ok: false,
        kind: "better.cache.materialize",
        schemaVersion: 1,
        projectRoot: context.projectRoot,
        key: derived.key,
        reason: materialized.reason
      };
      if (values.json) printJson(out);
      else printText(`better cache materialize: ${materialized.reason}`);
      process.exitCode = 1;
      return;
    }

    const state = await loadState(layout);
    state.materializationIndex = state.materializationIndex ?? {};
    const projectId = sha256Hex(context.projectRoot).slice(0, 10);
    state.materializationIndex[projectId] = {
      projectId,
      projectRoot: context.projectRoot,
      key: derived.key,
      pm: context.pm,
      engine: context.engine,
      lastMaterializedAt: new Date().toISOString(),
      lastVerifiedAt: new Date().toISOString()
    };
    await saveState(layout, state);

    const out = {
      ok: true,
      kind: "better.cache.materialize",
      schemaVersion: 1,
      projectRoot: context.projectRoot,
      key: derived.key,
      durationMs: materialized.durationMs,
      stats: materialized.stats,
      strategy: materialized.strategy
    };
    if (values.json) printJson(out);
    else printText(`better cache materialize: restored ${derived.key.slice(0, 12)}…`);
    return;
  }

  if (sub === "verify") {
    const context = await resolveGlobalCacheContextForCacheCommand(values);
    const derived = await deriveGlobalCacheContext(context.projectRoot, {
      pm: context.pm,
      engine: context.engine,
      cacheMode: context.cacheMode,
      scriptsMode: context.cacheScripts,
      cacheKeySalt: context.cacheKeySalt
    });
    if (!derived.decision.eligible || !derived.key) {
      const out = {
        ok: false,
        kind: "better.cache.verify",
        schemaVersion: 1,
        projectRoot: context.projectRoot,
        reason: derived.decision.reason
      };
      if (values.json) printJson(out);
      else printText(`better cache verify: ${out.reason}`);
      process.exitCode = 1;
      return;
    }

    const verify = await verifyGlobalCacheEntry(layout, derived.key);
    const out = {
      ok: verify.ok,
      kind: "better.cache.verify",
      schemaVersion: 1,
      projectRoot: context.projectRoot,
      key: derived.key,
      reason: verify.reason,
      entry: verify.ok ? { createdAt: verify.meta?.createdAt ?? null, pm: verify.meta?.pm ?? null } : null
    };
    if (values.json) printJson(out);
    else printText(`better cache verify: ${verify.ok ? "ok" : "fail"} (${verify.reason})`);
    if (!verify.ok) process.exitCode = 1;
    return;
  }

  if (sub === "export") {
    const outFile = values.out;
    if (!outFile) throw new Error("better cache export requires --out <file.tgz>");
    const outPath = path.resolve(outFile);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    const res = await runCommand("tar", ["-czf", outPath, "-C", layout.root, "."], {
      cwd: process.cwd(),
      passthroughStdio: false,
      captureLimitBytes: 1024 * 64
    });
    if (res.exitCode !== 0) {
      throw new Error(`tar export failed (exit ${res.exitCode}): ${res.stderrTail}`);
    }
    const out = { ok: true, kind: "better.cache.export", schemaVersion: 1, cacheRoot: layout.root, outPath };
    if (values.json) printJson(out);
    else printText(`Exported cache to ${outPath}`);
    return;
  }

  if (sub === "import") {
    const inFile = values.in;
    if (!inFile) throw new Error("better cache import requires --in <file.tgz>");
    const inPath = path.resolve(inFile);
    const res = await runCommand("tar", ["-xzf", inPath, "-C", layout.root], {
      cwd: process.cwd(),
      passthroughStdio: false,
      captureLimitBytes: 1024 * 64
    });
    if (res.exitCode !== 0) {
      throw new Error(`tar import failed (exit ${res.exitCode}): ${res.stderrTail}`);
    }
    const out = { ok: true, kind: "better.cache.import", schemaVersion: 1, cacheRoot: layout.root, inPath };
    if (values.json) printJson(out);
    else printText(`Imported cache from ${inPath}`);
    return;
  }

  throw new Error(`Unknown cache subcommand '${sub}'`);
}
