import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { ensureEmptyDir, materializeTree, atomicReplaceDir } from "../engine/better/materialize.js";

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function stableValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => stableValue(item));
  }
  if (!value || typeof value !== "object") return value;
  const keys = Object.keys(value).sort();
  const out = {};
  for (const key of keys) {
    out[key] = stableValue(value[key]);
  }
  return out;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function hashString(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function runtimeLibc() {
  try {
    const report = process.report?.getReport?.();
    const glibc = report?.header?.glibcVersionRuntime;
    if (glibc) return `glibc-${glibc}`;
    if (process.platform === "linux") return "linux-unknown-libc";
  } catch {
    // ignore
  }
  return "n/a";
}

export function globalCacheSupportPhase({ engine, pm }) {
  if (engine === "better") return "phase1-better-engine";
  if (engine === "bun") return "phase2-bun-wrap";
  if (pm === "pnpm" || pm === "yarn" || pm === "npm") return "phase3-pm-wrap";
  return "phase-unknown";
}

export async function resolvePrimaryLockfile(projectRoot, opts = {}) {
  const { pm = "npm", engine = "pm" } = opts;
  const candidates = [];
  if (engine === "bun") {
    candidates.push("bun.lock", "bun.lockb");
  } else if (pm === "pnpm") {
    candidates.push("pnpm-lock.yaml");
  } else if (pm === "yarn") {
    candidates.push("yarn.lock");
  } else {
    candidates.push("package-lock.json", "npm-shrinkwrap.json");
  }

  for (const file of candidates) {
    const full = path.join(projectRoot, file);
    if (await exists(full)) return { file, path: full };
  }
  return null;
}

export async function hashLockfile(projectRoot, opts = {}) {
  const lock = await resolvePrimaryLockfile(projectRoot, opts);
  if (!lock) return { ok: false, reason: "lockfile_not_found", lockfile: null, lockHash: null };
  try {
    const raw = await fs.readFile(lock.path);
    const lockHash = crypto.createHash("sha256").update(raw).digest("hex");
    return { ok: true, lockfile: lock, lockHash };
  } catch (err) {
    return {
      ok: false,
      reason: err?.message ?? String(err),
      lockfile: lock,
      lockHash: null
    };
  }
}

export function buildRuntimeFingerprint(opts = {}) {
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0], 10);
  const strictPayload = {
    platform: process.platform,
    arch: process.arch,
    nodeMajor: Number.isFinite(nodeMajor) ? nodeMajor : null,
    libc: runtimeLibc(),
    pm: opts.pm ?? "npm",
    engine: opts.engine ?? "pm",
    scriptsMode: opts.scriptsMode ?? "rebuild",
    frozen: opts.frozen === true,
    production: opts.production === true,
    cacheKeySalt: opts.cacheKeySalt ?? null
  };
  const relaxedPayload = {
    platform: process.platform,
    arch: process.arch,
    pm: opts.pm ?? "npm",
    engine: opts.engine ?? "pm",
    scriptsMode: opts.scriptsMode ?? "rebuild",
    cacheKeySalt: opts.cacheKeySalt ?? null
  };
  return {
    strict: strictPayload,
    relaxed: relaxedPayload
  };
}

export async function deriveGlobalCacheContext(projectRoot, opts = {}) {
  const {
    pm = "npm",
    engine = "pm",
    cacheMode = "strict",
    scriptsMode = "rebuild",
    frozen = false,
    production = false,
    cacheKeySalt = null
  } = opts;

  const lock = await hashLockfile(projectRoot, { pm, engine });
  if (!lock.ok) {
    return {
      decision: {
        eligible: false,
        hit: false,
        reason: lock.reason,
        key: null,
        pmSupportPhase: globalCacheSupportPhase({ engine, pm }),
        mode: cacheMode
      },
      key: null,
      lockHash: null,
      lockfile: lock.lockfile,
      fingerprint: null
    };
  }

  const fingerprint = buildRuntimeFingerprint({
    pm,
    engine,
    scriptsMode,
    frozen,
    production,
    cacheKeySalt
  });
  const fingerprintPayload = cacheMode === "relaxed" ? fingerprint.relaxed : fingerprint.strict;
  const payload = {
    version: 1,
    cacheMode,
    lockHash: lock.lockHash,
    fingerprint: fingerprintPayload
  };
  const key = hashString(stableJson(payload));
  return {
    decision: {
      eligible: true,
      hit: false,
      reason: "key_derived",
      key,
      pmSupportPhase: globalCacheSupportPhase({ engine, pm }),
      mode: cacheMode
    },
    key,
    lockHash: lock.lockHash,
    lockfile: lock.lockfile,
    fingerprint: fingerprintPayload
  };
}

export function globalCacheEntryPaths(layout, key) {
  const a = String(key).slice(0, 2);
  const b = String(key).slice(2, 4);
  const root = path.join(layout.store.materializationsDir, a, b, key);
  return {
    root,
    metaPath: path.join(root, "entry.json"),
    nodeModulesPath: path.join(root, "node_modules")
  };
}

export async function readGlobalCacheEntryMeta(layout, key) {
  const paths = globalCacheEntryPaths(layout, key);
  if (!(await exists(paths.metaPath))) return null;
  try {
    return JSON.parse(await fs.readFile(paths.metaPath, "utf8"));
  } catch {
    return null;
  }
}

export async function verifyGlobalCacheEntry(layout, key) {
  const paths = globalCacheEntryPaths(layout, key);
  const hasNodeModules = await exists(paths.nodeModulesPath);
  if (!hasNodeModules) {
    return {
      ok: false,
      reason: "entry_node_modules_missing",
      paths,
      meta: null
    };
  }
  const meta = await readGlobalCacheEntryMeta(layout, key);
  if (!meta) {
    return {
      ok: false,
      reason: "entry_meta_missing",
      paths,
      meta: null
    };
  }
  return { ok: true, reason: "entry_ready", paths, meta };
}

export async function materializeFromGlobalCache(layout, key, projectRoot, opts = {}) {
  const verify = await verifyGlobalCacheEntry(layout, key);
  if (!verify.ok) return { ok: false, reason: verify.reason, verify };

  const linkStrategy = opts.linkStrategy ?? "auto";
  const fsConcurrency = Math.max(1, Number(opts.fsConcurrency) || 16);
  const staging = path.join(projectRoot, `.better-global-staging-node_modules-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const startedAt = Date.now();
  const stats = {
    files: 0,
    filesLinked: 0,
    filesCopied: 0,
    linkFallbackCopies: 0,
    directories: 0,
    symlinks: 0
  };
  await ensureEmptyDir(staging);
  await materializeTree(verify.paths.nodeModulesPath, staging, { linkStrategy, stats, fsConcurrency });
  await atomicReplaceDir(staging, path.join(projectRoot, "node_modules"));
  const endedAt = Date.now();

  return {
    ok: true,
    reason: "materialized",
    key,
    paths: verify.paths,
    meta: verify.meta,
    stats,
    durationMs: endedAt - startedAt,
    strategy: linkStrategy,
    fsConcurrency
  };
}

export async function captureProjectNodeModulesToGlobalCache(layout, key, projectRoot, opts = {}) {
  const source = path.join(projectRoot, "node_modules");
  if (!(await exists(source))) {
    return { ok: false, reason: "node_modules_missing", key };
  }

  const linkStrategy = opts.linkStrategy ?? "auto";
  const fsConcurrency = Math.max(1, Number(opts.fsConcurrency) || 16);
  const entryPaths = globalCacheEntryPaths(layout, key);
  const stagingRoot = `${entryPaths.root}.staging-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const stagingNodeModules = path.join(stagingRoot, "node_modules");
  const startedAt = Date.now();
  const stats = {
    files: 0,
    filesLinked: 0,
    filesCopied: 0,
    linkFallbackCopies: 0,
    directories: 0,
    symlinks: 0
  };

  await ensureEmptyDir(stagingRoot);
  await materializeTree(source, stagingNodeModules, { linkStrategy, stats, fsConcurrency });
  await fs.mkdir(stagingRoot, { recursive: true });
  await fs.writeFile(
    path.join(stagingRoot, "entry.json"),
    `${JSON.stringify(
      {
        key,
        createdAt: new Date().toISOString(),
        createdBy: "better",
        sourceProjectRoot: projectRoot,
        lockHash: opts.lockHash ?? null,
        lockfile: opts.lockfile ?? null,
        fingerprint: opts.fingerprint ?? null,
        pm: opts.pm ?? null,
        engine: opts.engine ?? null,
        scriptsMode: opts.scriptsMode ?? "rebuild",
        cacheMode: opts.cacheMode ?? "strict",
        fsConcurrency,
        stats
      },
      null,
      2
    )}\n`
  );

  await fs.mkdir(path.dirname(entryPaths.root), { recursive: true });
  await fs.rm(entryPaths.root, { recursive: true, force: true });
  await fs.rename(stagingRoot, entryPaths.root);
  const endedAt = Date.now();

  return {
    ok: true,
    reason: "captured",
    key,
    paths: entryPaths,
    stats,
    durationMs: endedAt - startedAt,
    fsConcurrency
  };
}

export function entryBytesFromNodeModulesSnapshot(snapshot) {
  if (!snapshot || snapshot.ok === false) return 0;
  return Number(snapshot.physicalBytes ?? snapshot.logicalBytes ?? 0);
}

export function defaultGlobalCacheGcPolicy() {
  return {
    maxSizeBytes: 20 * 1024 * 1024 * 1024,
    maxAgeDays: 30,
    lruWindowDays: 14
  };
}

export function currentUserScopeKey() {
  return `${os.userInfo().username}@${process.platform}`;
}
