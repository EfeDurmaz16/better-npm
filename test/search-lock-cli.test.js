// test/search-lock-cli.test.js
// Tests for: better search (help/validation), better lock generate/verify

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { makeTempDir, rmrf, writeJson } from "./helpers.js";

const execFileAsync = promisify(execFile);
const betterBin = path.resolve(process.cwd(), "bin", "better.js");

async function runBetter(args, cwd, extraEnv = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [betterBin, ...args], {
      cwd,
      env: { ...process.env, ...extraEnv, BETTER_LOG_LEVEL: "silent" },
      timeout: 20_000
    });
    return { ok: true, stdout, stderr, exitCode: 0 };
  } catch (err) {
    return { ok: false, stdout: err.stdout ?? "", stderr: err.stderr ?? "", exitCode: err.code ?? 1 };
  }
}

// --- search ---

test("search --help describes usage", async () => {
  const { stdout, ok } = await runBetter(["search", "--help"], process.cwd());
  assert.ok(ok, "search --help should succeed");
  assert.ok(stdout.includes("query") || stdout.includes("search"), "help should describe search");
});

test("search requires a query argument", async () => {
  const dir = await makeTempDir("better-search-noquery-");
  try {
    const { exitCode } = await runBetter(["search"], dir);
    assert.notEqual(exitCode, 0, "search with no args should fail");
  } finally {
    await rmrf(dir);
  }
});

test("search with --limit validates the number", async (t) => {
  // This test hits npm registry, skip in offline environments
  const dir = await makeTempDir("better-search-limit-");
  try {
    const result = await runBetter(["search", "express", "--limit", "3", "--json"], dir);
    if (!result.ok && (result.stderr.includes("ENOTFOUND") || result.stderr.includes("ETIMEDOUT") || result.stderr.includes("timed out"))) {
      t.skip("network unavailable");
      return;
    }
    if (result.ok && result.stdout.trim()) {
      const out = JSON.parse(result.stdout);
      assert.equal(out.kind, "better.search");
      assert.ok(out.results.length <= 3, "should not return more than --limit results");
    }
  } finally {
    await rmrf(dir);
  }
});

// --- lock generate ---

test("lock generate creates better.lock.json with correct structure", async () => {
  const dir = await makeTempDir("better-lock-generate-");
  try {
    await writeJson(path.join(dir, "package.json"), { name: "lock-test", version: "1.0.0" });
    // Create a minimal package-lock.json so lock can hash it
    await writeJson(path.join(dir, "package-lock.json"), {
      name: "lock-test",
      lockfileVersion: 3,
      packages: { "": { name: "lock-test", version: "1.0.0" } }
    });

    const { stdout, ok } = await runBetter(["lock", "generate", "--json"], dir);
    assert.ok(ok, "lock generate should succeed");
    const out = JSON.parse(stdout);
    assert.equal(out.ok, true);
    assert.equal(out.kind, "better.lock.generate");
    assert.ok(out.key, "should have a cache key");
    assert.ok(out.lockfile?.file, "should reference the lockfile");

    // Verify the file was created
    const lockFile = await fs.readFile(path.join(dir, "better.lock.json"), "utf8");
    const lock = JSON.parse(lockFile);
    assert.equal(lock.kind, "better.lock");
    assert.equal(lock.schemaVersion, 1);
    assert.ok(lock.key, "should have key in file");
    assert.ok(lock.lockfile?.hash, "should have lockfile hash");
  } finally {
    await rmrf(dir);
  }
});

test("lock verify passes when better.lock.json matches current lockfile", async () => {
  const dir = await makeTempDir("better-lock-verify-pass-");
  try {
    await writeJson(path.join(dir, "package.json"), { name: "lock-verify-test", version: "1.0.0" });
    await writeJson(path.join(dir, "package-lock.json"), {
      name: "lock-verify-test",
      lockfileVersion: 3,
      packages: { "": { name: "lock-verify-test", version: "1.0.0" } }
    });

    // Generate first
    await runBetter(["lock", "generate"], dir);

    // Then verify — should pass
    const { stdout, ok } = await runBetter(["lock", "verify", "--json"], dir);
    assert.ok(ok, "lock verify should succeed after generate");
    const out = JSON.parse(stdout);
    assert.equal(out.ok, true);
    assert.equal(out.kind, "better.lock.verify");
    assert.ok(out.checks.keyMatches, "key should match");
    assert.ok(out.checks.lockfileMatches, "lockfile hash should match");
  } finally {
    await rmrf(dir);
  }
});

test("lock verify fails when lockfile changes after generate", async () => {
  const dir = await makeTempDir("better-lock-verify-fail-");
  try {
    await writeJson(path.join(dir, "package.json"), { name: "lock-drift-test", version: "1.0.0" });
    await writeJson(path.join(dir, "package-lock.json"), {
      name: "lock-drift-test",
      lockfileVersion: 3,
      packages: { "": { name: "lock-drift-test", version: "1.0.0" } }
    });

    // Generate
    await runBetter(["lock", "generate"], dir);

    // Modify the lockfile (simulate drift)
    await writeJson(path.join(dir, "package-lock.json"), {
      name: "lock-drift-test",
      lockfileVersion: 3,
      packages: {
        "": { name: "lock-drift-test", version: "1.0.0" },
        "node_modules/lodash": { name: "lodash", version: "4.17.21" }
      }
    });

    // Verify should fail
    const { stdout, ok } = await runBetter(["lock", "verify", "--json"], dir);
    assert.ok(!ok, "lock verify should fail after lockfile changes");
    const out = JSON.parse(stdout);
    assert.equal(out.ok, false);
    assert.ok(!out.checks.lockfileMatches, "lockfile hash should not match after change");
  } finally {
    await rmrf(dir);
  }
});

test("lock --help mentions all subcommands", async () => {
  const { stdout, ok } = await runBetter(["lock", "--help"], process.cwd());
  assert.ok(ok);
  assert.ok(stdout.includes("generate"), "should mention generate");
  assert.ok(stdout.includes("verify"), "should mention verify");
  assert.ok(stdout.includes("setup-merge-driver"), "should mention setup-merge-driver");
  assert.ok(stdout.includes("merge"), "should mention merge");
});
