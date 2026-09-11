import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { findBetterCore } from "../src/lib/core.js";
import { cacheLayout, loadState, updateState } from "../src/lib/cache.js";
import { loadPmCacheSnapshotStore, persistPmCacheSnapshot } from "../src/lib/pmCacheSnapshots.js";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "better-bookkeeping-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return cacheLayout(root);
}

test("20 processes preserve every project and counter increment", async (t) => {
  const layout = await fixture(t);
  const moduleUrl = new URL("../src/lib/cache.js", import.meta.url).href;
  const source = `import {cacheLayout, updateState} from ${JSON.stringify(moduleUrl)};
    const [root, id] = process.argv.slice(1);
    await updateState(cacheLayout(root), async state => {
      state.projects[id] = {projectId: id};
      state.cacheMetrics.installRuns += 1;
      await new Promise(resolve => setTimeout(resolve, 3));
    }, { projectKeys: [id] });`;
  await Promise.all(Array.from({ length: 20 }, (_, id) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source, layout.root, String(id)], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", data => { stderr += data; });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve() : reject(new Error(stderr)));
  })));
  const state = await loadState(layout);
  assert.equal(Object.keys(state.projects).length, 20);
  assert.equal(state.cacheMetrics.installRuns, 20);
});

test("corruption and failed mutations preserve prior state and release ownership", async (t) => {
  const layout = await fixture(t);
  await updateState(layout, state => { state.projects.saved = { projectId: "saved" }; });
  const before = await fs.readFile(layout.stateFile, "utf8");
  await assert.rejects(updateState(layout, state => {
    state.projects = {};
    throw new Error("cancelled");
  }), /cancelled/);
  assert.equal(await fs.readFile(layout.stateFile, "utf8"), before);
  await fs.writeFile(layout.stateFile, "{broken");
  await assert.rejects(updateState(layout, () => {}), SyntaxError);
  assert.equal(await fs.readFile(layout.stateFile, "utf8"), "{broken");
  const lock = await fs.stat(`${layout.stateFile}.lock`).catch(error => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  assert.ok(!lock || lock.isFile());
});

test("existing ownership times out without stealing a lock", async (t) => {
  const layout = await fixture(t);
  await fs.mkdir(`${layout.stateFile}.lock`);
  await assert.rejects(updateState(layout, () => {}, { timeoutMs: 1 }), /lock timed out|lock exited before release/);
  assert.ok((await fs.stat(`${layout.stateFile}.lock`)).isDirectory());
});

test("PM snapshot writes are isolated by cache path and migrate legacy records read-only", async (t) => {
  const layout = await fixture(t);
  const first = path.join(layout.root, "npm");
  const second = path.join(layout.root, "bun");
  const legacyFile = path.join(layout.root, "pm-cache-snapshots.json");
  const legacy = JSON.stringify({ snapshots: { [first]: { logicalBytes: 1, physicalBytes: 2 } } });
  await fs.writeFile(legacyFile, legacy);
  assert.equal((await loadPmCacheSnapshotStore(layout, first)).snapshots[first].logicalBytes, 1);
  await Promise.all([first, second].map(async (dir, i) => {
    const store = await loadPmCacheSnapshotStore(layout, dir);
    await persistPmCacheSnapshot(layout, store, dir, { ok: true, logicalBytes: i + 10, physicalBytes: i + 20 });
  }));
  assert.equal((await loadPmCacheSnapshotStore(layout, first)).snapshots[first].logicalBytes, 10);
  assert.equal((await loadPmCacheSnapshotStore(layout, second)).snapshots[second].logicalBytes, 11);
  assert.equal(await fs.readFile(legacyFile, "utf8"), legacy);
});


test("project records migrate legacy data and only changed shards are rewritten", async (t) => {
  const layout = await fixture(t);
  await fs.writeFile(layout.stateFile, JSON.stringify({ projects: { old: { projectId: "old" } } }));
  await updateState(layout, state => { state.projects.new = { projectId: "new" }; });
  const dir = path.join(layout.root, "projects");
  const files = await fs.readdir(dir);
  assert.equal(files.length, 2);
  const oldFile = (await Promise.all(files.map(async file => ({ file, record: JSON.parse(await fs.readFile(path.join(dir, file), "utf8")) })))).find(item => item.record.key === "old").file;
  const before = await fs.stat(path.join(dir, oldFile));
  await updateState(layout, state => { state.cacheMetrics.installRuns += 1; });
  const after = await fs.stat(path.join(dir, oldFile));
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.deepEqual(Object.keys((await loadState(layout)).projects).sort(), ["new", "old"]);
  assert.deepEqual(JSON.parse(await fs.readFile(layout.stateFile, "utf8")).projects, {});
});

test("native advisory lease recovers after a writer is killed", { timeout: 10000 }, async (t) => {
  const layout = await fixture(t);
  const core = await findBetterCore();
  if (!core) return t.skip("requires the current native state-lock helper");
  const probe = spawnSync(core, ["state-lock", "--lock-path", `${layout.stateFile}.lock`], { input: "", encoding: "utf8", timeout: 1000 });
  if (probe.status !== 0 || probe.stdout !== "ready\n") return t.skip("requires rebuilt native state-lock helper");
  const moduleUrl = new URL("../src/lib/cache.js", import.meta.url).href;
  const source = `import {cacheLayout, updateState} from ${JSON.stringify(moduleUrl)};
    await updateState(cacheLayout(process.argv[1]), async state => {
      state.projects.uncommitted = {projectId: "uncommitted"};
      process.stdout.write("locked\\n");
      await new Promise(resolve => setTimeout(resolve, 60000));
    });`;
  const writer = spawn(process.execPath, ["--input-type=module", "-e", source, layout.root], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => writer.kill("SIGKILL"));
  const stopped = new Promise(resolve => writer.once("close", resolve));
  await new Promise((resolve, reject) => {
    writer.once("error", reject);
    writer.stdout.once("data", resolve);
    writer.once("exit", code => reject(new Error(`writer exited early: ${code}`)));
  });
  writer.kill("SIGKILL");
  await stopped;
  await updateState(layout, state => { state.projects.committed = {projectId: "committed"}; }, { timeoutMs: 3000 });
  assert.deepEqual(Object.keys((await loadState(layout)).projects), ["committed"]);
});


test("selected project updates preserve unmigrated legacy references", async (t) => {
  const layout = await fixture(t);
  await fs.writeFile(layout.stateFile, JSON.stringify({ projects: { a: { projectId: "a" }, b: { projectId: "b" } } }));
  await updateState(layout, state => {
    assert.deepEqual(Object.keys(state.projects), ["a"]);
    state.projects.a.used = true;
  }, { projectKeys: ["a"] });
  const aggregate = JSON.parse(await fs.readFile(layout.stateFile, "utf8"));
  assert.deepEqual(aggregate.projects, { b: { projectId: "b" } });
  assert.deepEqual(Object.keys((await loadState(layout)).projects).sort(), ["a", "b"]);
  await updateState(layout, state => { state.cacheMetrics.installRuns += 1; }, { projectKeys: [] });
  assert.deepEqual(Object.keys((await loadState(layout)).projects).sort(), ["a", "b"]);
});
