import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

export function defaultCacheRoot() {
  const platform = os.platform();
  if (platform === "darwin") {
    return path.join(os.homedir(), "Library", "Caches", "better");
  }
  if (platform === "win32") {
    const localAppData =
      process.env.LOCALAPPDATA ??
      path.join(os.homedir(), "AppData", "Local");
    return path.join(localAppData, "better", "cache");
  }
  const xdg = process.env.XDG_CACHE_HOME;
  if (xdg) return path.join(xdg, "better");
  return path.join(os.homedir(), ".cache", "better");
}

export function getCacheRoot(overridePath) {
  return overridePath ? path.resolve(overridePath) : defaultCacheRoot();
}

export function cacheLayout(cacheRoot) {
  return {
    root: cacheRoot,
    stateFile: path.join(cacheRoot, "state.json"),
    runsDir: path.join(cacheRoot, "runs"),
    analysesDir: path.join(cacheRoot, "analyses"),
    tmpDir: path.join(cacheRoot, "tmp"),
    store: {
      root: path.join(cacheRoot, "store"),
      tarballsDir: path.join(cacheRoot, "store", "tarballs"),
      unpackedDir: path.join(cacheRoot, "store", "unpacked"),
      materializationsDir: path.join(cacheRoot, "store", "materializations"),
      tmpDir: path.join(cacheRoot, "store", "tmp")
    },
    pm: {
      npm: path.join(cacheRoot, "pm", "npm-cache"),
      pnpmStore: path.join(cacheRoot, "pm", "pnpm-store"),
      yarn: path.join(cacheRoot, "pm", "yarn-cache"),
      bun: path.join(cacheRoot, "pm", "bun-cache"),
      bunHome: path.join(cacheRoot, "pm", "bun-home")
    }
  };
}

async function assertDirWritable(dir) {
  const probe = path.join(dir, `.better-write-probe-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  try {
    await fs.writeFile(probe, "ok\n", { flag: "wx" });
  } finally {
    await fs.rm(probe, { force: true });
  }
}

export async function ensureCacheDirs(layout, opts = {}) {
  const { projectRootForFallback } = opts;
  try {
    await fs.mkdir(layout.root, { recursive: true });
    await fs.mkdir(layout.runsDir, { recursive: true });
    await fs.mkdir(layout.analysesDir, { recursive: true });
    await fs.mkdir(layout.tmpDir, { recursive: true });
    await fs.mkdir(layout.store.root, { recursive: true });
    await fs.mkdir(layout.store.tarballsDir, { recursive: true });
    await fs.mkdir(layout.store.unpackedDir, { recursive: true });
    await fs.mkdir(layout.store.materializationsDir, { recursive: true });
    await fs.mkdir(layout.store.tmpDir, { recursive: true });
    // Probe CAS algorithm directories early so we can fall back if the default cache root isn't writable
    // (e.g. sandboxed environments).
    await fs.mkdir(path.join(layout.store.tarballsDir, "sha512"), { recursive: true });
    await fs.mkdir(path.join(layout.store.unpackedDir, "sha512"), { recursive: true });
    await fs.mkdir(path.dirname(layout.pm.npm), { recursive: true });
    await fs.mkdir(layout.pm.npm, { recursive: true });
    await fs.mkdir(layout.pm.pnpmStore, { recursive: true });
    await fs.mkdir(layout.pm.yarn, { recursive: true });
    await fs.mkdir(layout.pm.bun, { recursive: true });
    await fs.mkdir(layout.pm.bunHome, { recursive: true });
    // Some sandboxes allow read but disallow writes outside a whitelist. mkdir() may "succeed"
    // if the directory already exists, but writes can still fail later. Probe writability now.
    await assertDirWritable(layout.runsDir);
    await assertDirWritable(layout.analysesDir);
    await assertDirWritable(layout.tmpDir);
    return layout;
  } catch (err) {
    const code = err?.code;
    if ((code === "EACCES" || code === "EPERM") && projectRootForFallback) {
      const fallbackRoot = path.join(path.resolve(projectRootForFallback), ".better", "cache");
      const fallback = cacheLayout(fallbackRoot);
      await fs.mkdir(fallback.root, { recursive: true });
      await fs.mkdir(fallback.runsDir, { recursive: true });
      await fs.mkdir(fallback.analysesDir, { recursive: true });
      await fs.mkdir(fallback.tmpDir, { recursive: true });
      await fs.mkdir(fallback.store.root, { recursive: true });
      await fs.mkdir(fallback.store.tarballsDir, { recursive: true });
      await fs.mkdir(fallback.store.unpackedDir, { recursive: true });
      await fs.mkdir(fallback.store.materializationsDir, { recursive: true });
      await fs.mkdir(fallback.store.tmpDir, { recursive: true });
      await fs.mkdir(path.join(fallback.store.tarballsDir, "sha512"), { recursive: true });
      await fs.mkdir(path.join(fallback.store.unpackedDir, "sha512"), { recursive: true });
      await fs.mkdir(path.dirname(fallback.pm.npm), { recursive: true });
      await fs.mkdir(fallback.pm.npm, { recursive: true });
      await fs.mkdir(fallback.pm.pnpmStore, { recursive: true });
      await fs.mkdir(fallback.pm.yarn, { recursive: true });
      await fs.mkdir(fallback.pm.bun, { recursive: true });
      await fs.mkdir(fallback.pm.bunHome, { recursive: true });
      await assertDirWritable(fallback.runsDir);
      await assertDirWritable(fallback.analysesDir);
      await assertDirWritable(fallback.tmpDir);
      return fallback;
    }
    throw err;
  }
}

function defaultState() {
  return {
    schemaVersion: 2,
    projects: {},
    analysesIndex: {},
    cacheMetrics: { installRuns: 0, cacheHits: 0, cacheMisses: 0, lastUpdatedAt: null },
    cachePackages: {},
    cacheEntries: {},
    materializationIndex: {},
    gc: {
      maxSizeBytes: 20 * 1024 * 1024 * 1024,
      maxAgeDays: 30,
      lruWindowDays: 14,
      lastRunAt: null,
      lastFreedBytes: 0
    }
  };
}

// A published record is always complete. Sync its contents before the atomic
// rename; this is not a promise of power-loss durability for the parent directory.
export async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value)}\n`);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, file);
  } finally {
    await handle?.close();
    await fs.rm(temporary, { force: true });
  }
}

const stateSources = new WeakMap();

function projectRecordFile(layout, key) {
  return path.join(layout.root, "projects", `${createHash("sha256").update(key).digest("hex")}.json`);
}

export async function loadState(layout, opts = {}) {
  let state;
  try {
    const parsed = JSON.parse(await fs.readFile(layout.stateFile, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Invalid cache state");
    }
    state = { ...defaultState(), ...parsed };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    state = defaultState();
  }
  if (!state.projects || typeof state.projects !== "object" || Array.isArray(state.projects)) {
    throw new Error("Invalid project index");
  }
  const legacyProjects = state.projects;
  const selectedKeys = opts.projectKeys ? new Set(opts.projectKeys) : null;
  state.projects = Object.fromEntries(Object.entries(legacyProjects).filter(([key]) => !selectedKeys || selectedKeys.has(key)));
  const legacyKeys = new Set(Object.keys(state.projects));
  let entries;
  if (selectedKeys) {
    entries = [...selectedKeys].map(key => ({ name: path.basename(projectRecordFile(layout, key)), isFile: () => true }));
  } else {
    try {
      entries = await fs.readdir(path.join(layout.root, "projects"), { withFileTypes: true });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      entries = [];
    }
  }
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(8, entries.length) }, async () => {
    while (next < entries.length) {
      const entry = entries[next++];
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const file = path.join(layout.root, "projects", entry.name);
      let record;
      try {
        record = JSON.parse(await fs.readFile(file, "utf8"));
      } catch (error) {
        if (selectedKeys && error.code === "ENOENT") continue;
        throw error;
      }
      if (record?.schemaVersion !== 1 || typeof record.key !== "string" ||
          projectRecordFile(layout, record.key) !== file ||
          (record.value !== null && (!record.value || typeof record.value !== "object" || Array.isArray(record.value)))) {
        throw new Error(`Invalid project record: ${file}`);
      }
      if (record.value === null) delete state.projects[record.key];
      else Object.defineProperty(state.projects, record.key, { value: record.value, writable: true, enumerable: true, configurable: true });
    }
  }));
  stateSources.set(state, { legacyKeys, legacyProjects });
  return state;
}

async function publishProjects(layout, before, state) {
  const legacyKeys = stateSources.get(state)?.legacyKeys ?? new Set();
  const keys = new Set([...Object.keys(before), ...Object.keys(state.projects)]);
  for (const key of keys) {
    if (!legacyKeys.has(key) && JSON.stringify(before[key]) === JSON.stringify(state.projects[key])) continue;
    await writeJsonAtomic(projectRecordFile(layout, key), {
      schemaVersion: 1, key, value: Object.hasOwn(state.projects, key) ? state.projects[key] : null
    });
  }
}

// Compatibility for installations without the new helper. This deliberately
// uses the same pathname as the native stable lock file: the two protocols
// cannot acquire independent locks and overwrite each other's state.
async function acquireFallbackLease(layout, timeoutMs) {
  const lock = `${layout.stateFile}.lock`;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      await fs.mkdir(lock, { mode: 0o700 });
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const info = await fs.stat(lock).catch(error => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (info && !info.isDirectory()) {
        throw new Error("This cache uses native state locking; a current better-core binary is required");
      }
      if (Date.now() >= deadline) {
        throw new Error(`Cache state lock timed out: ${lock}. For fallback recovery, stop all writers before removing this directory.`);
      }
      await delay(10 + Math.floor(Math.random() * 20));
    }
  }
  try {
    await fs.writeFile(path.join(lock, "owner.json"), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { flag: "wx", mode: 0o600 });
  } catch (error) {
    await fs.rm(lock, { recursive: true, force: true });
    throw error;
  }
  return {
    assertHeld() {},
    async release() { await fs.rm(lock, { recursive: true, force: true }); }
  };
}

// Keep an OS advisory lock in a helper whose stdin belongs to this process.
// A killed parent closes the pipe, releasing the lock without stale-file races.
// The stable lock file must never be unlinked while writers can be active.
async function acquireStateLease(layout, timeoutMs) {
  const { findBetterCore } = await import("./core.js");
  const core = await findBetterCore();
  if (!core) return acquireFallbackLease(layout, timeoutMs);
  const child = spawn(core, ["state-lock", "--lock-path", `${layout.stateFile}.lock`], {
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true
  });
  let exited = false;
  let stderr = "";
  let stdout = "";
  let exitCode = null;
  child.stdout.on("data", data => { stdout = (stdout + data).slice(-8192); });
  child.stderr.on("data", data => { stderr = (stderr + data).slice(-4096); });
  const completion = new Promise(resolve => {
    child.once("error", error => { exited = true; resolve({ error }); });
    child.once("close", code => { exited = true; exitCode = code; resolve({ code }); });
  });
  child.stdin.on("error", () => {});
  try {
    await new Promise((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error("Cache state lock timed out")), timeoutMs);
      const finish = (error) => {
        clearTimeout(timer);
        child.stdout.removeListener("data", onData);
        if (error) reject(error); else resolve();
      };
      const onData = data => {
        output = (output + data).slice(0, 128);
        if (output === "ready\n") finish();
      };
      child.stdout.on("data", onData);
      completion.then(result => finish(result.error ?? new Error(`Cache state lock exited before release: ${result.code}; ${stderr}`)));
    });
  } catch (error) {
    child.kill();
    await completion;
    if (exitCode === 2 && /unknown flag: --lock-path|unknown command.*state-lock|unrecognized subcommand.*state-lock/.test(stderr + stdout)) {
      return acquireFallbackLease(layout, timeoutMs);
    }
    throw error;
  }
  return {
    assertHeld() {
      if (exited) throw new Error("Cache state lock was lost before publication");
    },
    async release() {
      child.stdin.end();
      const result = await completion;
      if (result.error) throw result.error;
      if (result.code !== 0) throw new Error(`Cache state lock helper failed: ${result.code}; ${stderr}`);
    }
  };
}

export async function updateState(layout, mutate, opts = {}) {
  await fs.mkdir(layout.root, { recursive: true });
  const lease = await acquireStateLease(layout, opts.timeoutMs ?? 30000);
  try {
    const state = await loadState(layout, { projectKeys: opts.projectKeys });
    const previousProjects = structuredClone(state.projects);
    const result = await mutate(state);
    lease.assertHeld();
    await publishProjects(layout, previousProjects, state);
    lease.assertHeld();
    // Project records are independently recoverable, rebuildable metadata. Their
    // publication is not a multi-file transaction with aggregate counters.
    // Legacy references are removed only after every migrated shard is complete.
    const legacyProjects = { ...(stateSources.get(state)?.legacyProjects ?? {}) };
    for (const key of new Set([...Object.keys(previousProjects), ...Object.keys(state.projects)])) delete legacyProjects[key];
    await writeJsonAtomic(layout.stateFile, { ...state, schemaVersion: 3, projects: legacyProjects });
    return result;
  } finally {
    await lease.release();
  }
}
