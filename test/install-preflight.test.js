import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import { makeTempDir, rmrf, writeJson } from "./helpers.js";
import { buildRuntimeFingerprint } from "../src/lib/globalCache.js";
import { detectPackageManager } from "../src/pm/detect.js";
import { verifyFrozenLockfile } from "../src/lib/frozenLockfile.js";

// Keep simulated process properties isolated from other test files (Node runs
// each file in its own process), and restore them before the next test.
test("non-Linux fingerprints do not generate a diagnostic report", t => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  t.after(() => Object.defineProperty(process, "platform", descriptor));
  const report = t.mock.method(process.report, "getReport", () => {
    throw new Error("diagnostic report must not be generated");
  });
  for (const platform of ["darwin", "win32"]) {
    Object.defineProperty(process, "platform", { value: platform });
    assert.equal(buildRuntimeFingerprint().strict.libc, "n/a");
  }
  assert.equal(report.mock.callCount(), 0);
});

test("Linux fingerprints retain the glibc ABI and unknown-libc fallback", t => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  t.after(() => Object.defineProperty(process, "platform", descriptor));
  Object.defineProperty(process, "platform", { value: "linux" });
  const report = t.mock.method(process.report, "getReport", () => ({
    header: { glibcVersionRuntime: "2.39" }
  }));
  assert.equal(buildRuntimeFingerprint().strict.libc, "glibc-2.39");
  report.mock.mockImplementation(() => ({ header: {} }));
  assert.equal(buildRuntimeFingerprint().strict.libc, "linux-unknown-libc");
  report.mock.mockImplementation(() => { throw new Error("report unavailable"); });
  assert.equal(buildRuntimeFingerprint().strict.libc, "n/a");
});

test("PM detection preserves precedence and observes changed files on each call", async () => {
  const dir = await makeTempDir("preflight-pm-");
  try {
    await writeJson(path.join(dir, "package.json"), {});
    for (const file of ["pnpm-lock.yaml", "yarn.lock", ".yarnrc.yml", "package-lock.json"]) {
      await fs.writeFile(path.join(dir, file), "");
    }
    assert.deepEqual(await detectPackageManager(dir), { pm: "pnpm", reason: "pnpm-lock.yaml" });
    await fs.rm(path.join(dir, "pnpm-lock.yaml"));
    assert.deepEqual(await detectPackageManager(dir), { pm: "yarn", reason: "yarn.lock + .yarnrc.yml" });
    await fs.rm(path.join(dir, ".yarnrc.yml"));
    assert.deepEqual(await detectPackageManager(dir), { pm: "yarn", reason: "yarn.lock" });
    await writeJson(path.join(dir, "package.json"), { packageManager: "npm@10.0.0" });
    assert.deepEqual(await detectPackageManager(dir), { pm: "npm", reason: "package.json#packageManager" });
  } finally {
    await rmrf(dir);
  }
});

test("frozen fallback preserves nested/scoped matching and rereads changed inputs", async () => {
  const dir = await makeTempDir("preflight-frozen-");
  try {
    const dependencies = { plain: "1.0.0", "@scope/pkg": "2.0.0", absent: "3.0.0" };
    await writeJson(path.join(dir, "package.json"), { dependencies });
    const packages = {
      "": { dependencies },
      "node_modules/outer/node_modules/plain": { version: "1.0.0" },
      "node_modules/outer/node_modules/deeper/node_modules/@scope/pkg": { version: "2.0.0" },
      "node_modules/outer/node_modules/not-absent": { version: "3.0.0" }
    };
    await writeJson(path.join(dir, "package-lock.json"), { lockfileVersion: 3, packages });
    const before = await verifyFrozenLockfile(dir);
    assert.equal(before.ok, false);
    assert.equal(before.errors.length, 1);
    assert.match(before.errors[0], /absent@3.0.0/);
    packages["node_modules/absent"] = { version: "3.0.0" };
    await writeJson(path.join(dir, "package-lock.json"), { lockfileVersion: 3, packages });
    const after = await verifyFrozenLockfile(dir);
    assert.equal(after.ok, true);
    assert.notEqual(after.hash, before.hash);
    await writeJson(path.join(dir, "package.json"), { dependencies: { ...dependencies, plain: "4.0.0" } });
    const changedManifest = await verifyFrozenLockfile(dir);
    assert.equal(changedManifest.ok, false);
    assert.match(changedManifest.errors[0], /plain.*spec differs/);
  } finally {
    await rmrf(dir);
  }
});

test("native strict and relaxed keys invalidate legacy materialization policy", () => {
  for (const engine of ["better", "pm", "bun"]) {
    const fingerprint = buildRuntimeFingerprint({ engine });
    for (const mode of ["strict", "relaxed"]) {
      if (engine === "better") {
        assert.equal(fingerprint[mode].materializationPolicy, "isolated-auto-v2");
      } else {
        assert.equal(Object.hasOwn(fingerprint[mode], "materializationPolicy"), false);
      }
    }
  }
});
