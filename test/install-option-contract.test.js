import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nativeInstallRuntime } from "../src/commands/install.js";
import { runBetterCoreInstall, runBetterCoreFetchAndExtractNapi } from "../src/lib/core.js";
import { makeTempDir, rmrf, writeJson } from "./helpers.js";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const cli = path.join(root, "bin/better.js");
const native = path.join(root, "crates/target/debug", process.platform === "win32" ? "better-core.exe" : "better-core");
const unsupported = [
  ["sandbox", "--sandbox", /script isolation/],
  ["verifyProvenance", "--verify-provenance", /cryptographic provenance/],
  ["requireProvenance", "--require-provenance", /cryptographic provenance/]
];

for (const [key, flag, reason] of unsupported) {
  test(`bridge rejects ${flag} before spawning core`, async () => {
    await assert.rejects(runBetterCoreInstall("/missing-core", "/missing-project", { [key]: true }), reason);
  });
  const engines = key === "production" ? ["better"] : ["better", "pm", "bun"];
  for (const engine of engines) {
    test(`CLI rejects ${flag} with ${engine} before touching the project or cache`, async () => {
      const dir = await makeTempDir("better-option-reject-");
      try {
        // No project exists: the option error must win over any install/preflight error.
        await assert.rejects(exec(process.execPath, [cli, "install", "--engine", engine,
          "--experimental", flag, "--json", "--project-root", path.join(dir, "project"),
          "--cache-root", path.join(dir, "cache")], { cwd: dir }), error => {
          assert.match(error.stdout + error.stderr, reason);
          assert.notEqual(error.code, 0);
          return true;
        });
        assert.deepEqual(await fs.readdir(dir), []);
      } finally {
        await rmrf(dir);
      }
    });
  }
}

test("bridge forwards supported native install options", async () => {
  const dir = await makeTempDir("better-option-argv-");
  try {
    const stub = path.join(dir, "core");
    await fs.writeFile(stub, `#!${process.execPath}\nconsole.log(JSON.stringify({ args: process.argv.slice(2) }));\n`, { mode: 0o755 });
    const report = await runBetterCoreInstall(stub, dir, {
      lockfile: "custom-lock.json", cacheRoot: "cache", storeRoot: "store",
      linkStrategy: "copy", jobs: 2, scripts: false, dedup: true,
      production: true, offline: true, nodeLayout: "strict"
    });
    assert.deepEqual(report.args, ["install", "--project-root", dir, "--os", process.platform, "--cpu", process.arch,
      "--lockfile", "custom-lock.json", "--cache-root", "cache", "--store-root", "store",
      "--link-strategy", "copy", "--jobs", "2", "--no-scripts", "--dedup", "--production", "--offline", "--strict"]);
  } finally {
    await rmrf(dir);
  }
});

test("CLI frozen still rejects a stale package-manager lockfile", async () => {
  const dir = await makeTempDir("better-option-frozen-");
  try {
    await writeJson(path.join(dir, "package.json"), { name: "fixture", dependencies: { missing: "1.0.0" } });
    await writeJson(path.join(dir, "package-lock.json"), { lockfileVersion: 3, packages: {} });
    await assert.rejects(exec(process.execPath, [cli, "install", "--engine", "better", "--experimental",
      "--frozen", "--json", "--project-root", dir, "--cache-root", path.join(dir, "cache")], { cwd: dir }), error => {
      assert.match(error.stdout + error.stderr, /Frozen lockfile check failed/);
      return true;
    });
    await assert.rejects(fs.access(path.join(dir, "node_modules")));
  } finally {
    await rmrf(dir);
  }
});

test("native install enforces the option contract before resolving packages", async t => {
  try { await fs.access(native); } catch { t.skip("Build better-core debug binary to run native contract coverage"); return; }
  const dir = await makeTempDir("better-option-native-");
  try {
    for (const [, flag, reason] of unsupported) {
      await assert.rejects(exec(native, ["install", flag, "--project-root", dir], { cwd: dir }), error => {
        assert.match(error.stdout + error.stderr, reason);
        return true;
      });
    }
    assert.deepEqual(await fs.readdir(dir), []);
    await writeJson(path.join(dir, "package.json"), { name: "empty-fixture", version: "1.0.0" });
    await writeJson(path.join(dir, "package-lock.json"), { lockfileVersion: 3, packages: {} });
    const report = await runBetterCoreInstall(native, dir, {
      cacheRoot: path.join(dir, "cache"), scripts: false, offline: true, nodeLayout: "hoist"
    });
    assert.equal(report.ok, true);
    assert.equal(report.kind, "better.install.report");
    await fs.access(path.join(dir, "better.lock"));

    const args = [cli, "install", "--engine", "better", "--experimental", "--json",
      "--scripts", "off", "--measure", "off", "--offline", "--frozen",
      "--project-root", dir, "--cache-root", path.join(dir, "cache")];
    const env = { ...process.env, BETTER_CORE_PATH: native };
    const first = JSON.parse((await exec(process.execPath, args, { cwd: dir, env })).stdout);
    assert.equal(first.betterEngine.ok, true);
    assert.equal(first.engineRuntime.selected, "rust");
    assert.equal(first.engineRuntime.backend, "native-binary");
    assert.equal(first.install.backend, "native-binary");
    const reused = JSON.parse((await exec(process.execPath, args, { cwd: dir, env })).stdout);
    assert.equal(reused.reuseDecision.hit, true);
    assert.equal(reused.install.backend, "none");
    for (const [, flag, reason] of unsupported) {
      await assert.rejects(exec(process.execPath, [...args, flag], { cwd: dir, env }), error => {
        assert.match(error.stdout + error.stderr, reason);
        return true;
      });
    }
  } finally {
    await rmrf(dir);
  }
});

for (const key of ["jobs", "extractJobs", "maxTarballBytes", "maxExpandedBytes", "maxArchiveEntries", "maxArchiveMetadataBytes"]) {
  test(`fetch bridges reject invalid ${key} before native work`, async () => {
    for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      await assert.rejects(runBetterCoreInstall("/missing-core", "/missing-project", { [key]: value }), /positive safe integer/);
      assert.throws(() => runBetterCoreFetchAndExtractNapi("/missing-lock", "/missing-cache", { [key]: value }), /positive safe integer/);
    }
  });
}

test("bridge forwards independent network, extraction and artifact budgets", async () => {
  const dir = await makeTempDir("better-fetch-options-");
  try {
    const stub = path.join(dir, "core");
    await fs.writeFile(stub, `#!${process.execPath}\nconsole.log(JSON.stringify({ args: process.argv.slice(2) }));\n`, { mode: 0o755 });
    const report = await runBetterCoreInstall(stub, dir, { jobs: 4, extractJobs: 2,
      maxTarballBytes: 100, maxExpandedBytes: 200, maxArchiveEntries: 3, maxArchiveMetadataBytes: 50 });
    assert.deepEqual(report.args.slice(7), ["--jobs", "4", "--extract-jobs", "2",
      "--max-tarball-bytes", "100", "--max-expanded-bytes", "200",
      "--max-archive-entries", "3", "--max-archive-metadata-bytes", "50"]);
  } finally { await rmrf(dir); }
});

for (const flag of ["--jobs", "--extract-jobs", "--max-tarball-bytes", "--max-expanded-bytes", "--max-archive-entries", "--max-archive-metadata-bytes"]) {
  test(`CLI rejects invalid ${flag} before creating cache directories`, async () => {
    const dir = await makeTempDir("better-fetch-invalid-");
    try {
      await assert.rejects(exec(process.execPath, [cli, "install", "--engine", "better", "--experimental", flag, "0",
        "--json", "--project-root", path.join(dir, "missing"), "--cache-root", path.join(dir, "cache")]), /positive safe integer/);
      assert.deepEqual(await fs.readdir(dir), []);
    } finally { await rmrf(dir); }
  });
}

test("native install runtime reports the binary actually used while preserving requested mode", () => {
  for (const requested of ["auto", "rust", "napi", "js"]) {
    const runtime = nativeInstallRuntime(requested, "/actual/better-core");
    assert.equal(runtime.requested, requested);
    assert.equal(runtime.selected, "rust");
    assert.equal(runtime.backend, "native-binary");
    assert.equal(runtime.corePath, "/actual/better-core");
    assert.equal(runtime.fallbackUsed, requested === "napi" || requested === "js");
    assert.equal(runtime.fallbackReason, runtime.fallbackUsed ? "native_install_requires_binary" : null);
  }
});
