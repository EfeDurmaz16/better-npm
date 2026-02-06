import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULTS = {
  json: false,
  telemetry: false,
  logLevel: "info",
  cacheRoot: null,
  coreMode: "auto",
  fsConcurrency: 16,
  doctor: {
    threshold: 70,
    maxDepth: 15,
    p95Depth: 10,
    largeNodeModulesBytes: 500 * 1024 * 1024
  }
};

const VALID_LOG_LEVELS = new Set(["debug", "info", "warn", "error", "silent"]);

let runtimeConfig = DEFAULTS;

function isObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function mergeConfig(...parts) {
  const merged = {};
  for (const part of parts) {
    if (!isObject(part)) continue;
    for (const [key, value] of Object.entries(part)) {
      if (isObject(value) && isObject(merged[key])) {
        merged[key] = mergeConfig(merged[key], value);
      } else {
        merged[key] = value;
      }
    }
  }
  return merged;
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function normalizeLogLevel(level) {
  if (typeof level !== "string") return DEFAULTS.logLevel;
  const lowered = level.toLowerCase();
  return VALID_LOG_LEVELS.has(lowered) ? lowered : DEFAULTS.logLevel;
}

async function loadConfigFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") {
    const imported = await import(pathToFileURL(path.resolve(filePath)).href);
    return imported?.default ?? imported ?? {};
  }
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

async function loadFileConfig(cwd, configPath) {
  if (configPath) {
    return await loadConfigFile(configPath);
  }

  const candidates = [
    "better.config.js",
    "better.config.mjs",
    "better.config.cjs",
    ".betterrc",
    ".betterrc.json"
  ];
  for (const candidate of candidates) {
    const full = path.join(cwd, candidate);
    if (await exists(full)) {
      return await loadConfigFile(full);
    }
  }

  const pkgPath = path.join(cwd, "package.json");
  if (await exists(pkgPath)) {
    try {
      const pkgRaw = await fs.readFile(pkgPath, "utf8");
      const pkg = JSON.parse(pkgRaw);
      if (isObject(pkg?.better)) return pkg.better;
    } catch {
      // ignore package.json parse errors
    }
  }
  return {};
}

function parseEnv() {
  const env = {};
  if (process.env.BETTER_JSON != null) {
    const value = String(process.env.BETTER_JSON).toLowerCase();
    env.json = value === "1" || value === "true";
  }
  if (process.env.BETTER_TELEMETRY != null) {
    const value = String(process.env.BETTER_TELEMETRY).toLowerCase();
    env.telemetry = value === "1" || value === "true";
  }
  if (process.env.BETTER_LOG_LEVEL) {
    env.logLevel = process.env.BETTER_LOG_LEVEL;
  }
  if (process.env.BETTER_CACHE_ROOT) {
    env.cacheRoot = process.env.BETTER_CACHE_ROOT;
  }
  if (process.env.BETTER_CORE_MODE) {
    env.coreMode = process.env.BETTER_CORE_MODE;
  }
  if (process.env.BETTER_FS_CONCURRENCY) {
    const n = Number(process.env.BETTER_FS_CONCURRENCY);
    if (Number.isFinite(n)) env.fsConcurrency = n;
  }
  if (process.env.BETTER_DOCTOR_THRESHOLD) {
    const n = Number(process.env.BETTER_DOCTOR_THRESHOLD);
    if (Number.isFinite(n)) {
      env.doctor = { threshold: n };
    }
  }
  return env;
}

function validateAndNormalize(config) {
  const normalized = mergeConfig(DEFAULTS, config);
  normalized.json = !!normalized.json;
  normalized.telemetry = !!normalized.telemetry;
  normalized.logLevel = normalizeLogLevel(normalized.logLevel);
  if (normalized.cacheRoot != null && typeof normalized.cacheRoot !== "string") {
    normalized.cacheRoot = null;
  }
  if (typeof normalized.coreMode !== "string") {
    normalized.coreMode = DEFAULTS.coreMode;
  }
  const coreMode = normalized.coreMode.toLowerCase();
  normalized.coreMode = coreMode === "js" || coreMode === "rust" || coreMode === "auto"
    ? coreMode
    : DEFAULTS.coreMode;
  const fsConcurrency = Number(normalized.fsConcurrency);
  normalized.fsConcurrency = Number.isFinite(fsConcurrency)
    ? Math.max(1, Math.min(128, Math.floor(fsConcurrency)))
    : DEFAULTS.fsConcurrency;

  if (!isObject(normalized.doctor)) normalized.doctor = { ...DEFAULTS.doctor };
  const threshold = Number(normalized.doctor.threshold);
  normalized.doctor.threshold = Number.isFinite(threshold) ? Math.max(0, Math.min(100, threshold)) : DEFAULTS.doctor.threshold;

  const maxDepth = Number(normalized.doctor.maxDepth);
  normalized.doctor.maxDepth = Number.isFinite(maxDepth) ? Math.max(1, maxDepth) : DEFAULTS.doctor.maxDepth;

  const p95Depth = Number(normalized.doctor.p95Depth);
  normalized.doctor.p95Depth = Number.isFinite(p95Depth) ? Math.max(1, p95Depth) : DEFAULTS.doctor.p95Depth;

  const largeBytes = Number(normalized.doctor.largeNodeModulesBytes);
  normalized.doctor.largeNodeModulesBytes = Number.isFinite(largeBytes)
    ? Math.max(10 * 1024 * 1024, largeBytes)
    : DEFAULTS.doctor.largeNodeModulesBytes;

  return normalized;
}

export async function resolveRuntimeConfig(opts = {}) {
  const cwd = opts.cwd ? path.resolve(opts.cwd) : process.cwd();
  const fileConfig = await loadFileConfig(cwd, opts.configPath);
  const envConfig = parseEnv();
  const cliConfig = opts.cli ?? {};
  return validateAndNormalize(mergeConfig(DEFAULTS, fileConfig, envConfig, cliConfig));
}

export function setRuntimeConfig(config) {
  runtimeConfig = validateAndNormalize(config);
}

export function getRuntimeConfig() {
  return runtimeConfig;
}
