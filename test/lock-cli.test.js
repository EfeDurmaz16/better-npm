import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { makeTempDir, rmrf, writeJson } from "./helpers.js";

const execFileAsync = promisify(execFile);
const betterBin = path.resolve(process.cwd(), "bin", "better.js");

test("lock generate writes better.lock.json and returns structured JSON", async () => {
  const dir = await makeTempDir("better-lock-generate-");
  try {
    await writeJson(path.join(dir, "package.json"), { name: "lock-test", version: "1.0.0" });
    await writeJson(path.join(dir, "package-lock.json"), {
      name: "lock-test",
      lockfileVersion: 3,
      packages: { "": { name: "lock-test", version: "1.0.0" } }
    });

    const { stdout } = await execFileAsync(process.execPath, [betterBin, "lock", "--json"], {
      cwd: dir,
      env: { ...process.env, BETTER_LOG_LEVEL: "silent" }
    });
    const report = JSON.parse(stdout);
    assert.equal(report.ok, true);
    assert.equal(report.kind, "better.lock.generate");
    assert.ok(typeof report.key === "string" && report.key.length > 10);

    const lockFile = path.join(dir, "better.lock.json");
    const doc = JSON.parse(await fs.readFile(lockFile, "utf8"));
    assert.equal(doc.kind, "better.lock");
    assert.equal(doc.schemaVersion, 1);
    assert.equal(doc.lockfile.file, "package-lock.json");
  } finally {
    await rmrf(dir);
  }
});

test("lock verify succeeds after generate", async () => {
  const dir = await makeTempDir("better-lock-verify-ok-");
  try {
    await writeJson(path.join(dir, "package.json"), { name: "lock-verify-test", version: "1.0.0" });
    await writeJson(path.join(dir, "package-lock.json"), {
      name: "lock-verify-test",
      lockfileVersion: 3,
      packages: { "": { name: "lock-verify-test", version: "1.0.0" } }
    });

    await execFileAsync(process.execPath, [betterBin, "lock", "--json"], {
      cwd: dir,
      env: { ...process.env, BETTER_LOG_LEVEL: "silent" }
    });

    const { stdout } = await execFileAsync(process.execPath, [betterBin, "lock", "verify", "--json"], {
      cwd: dir,
      env: { ...process.env, BETTER_LOG_LEVEL: "silent" }
    });
    const report = JSON.parse(stdout);
    assert.equal(report.ok, true);
    assert.equal(report.kind, "better.lock.verify");
    assert.equal(report.checks.keyMatches, true);
    assert.equal(report.checks.lockfileMatches, true);
  } finally {
    await rmrf(dir);
  }
});

test("lock verify fails when lockfile drifts", async () => {
  const dir = await makeTempDir("better-lock-verify-drift-");
  try {
    await writeJson(path.join(dir, "package.json"), { name: "lock-drift-test", version: "1.0.0" });
    await writeJson(path.join(dir, "package-lock.json"), {
      name: "lock-drift-test",
      lockfileVersion: 3,
      packages: { "": { name: "lock-drift-test", version: "1.0.0" } }
    });

    await execFileAsync(process.execPath, [betterBin, "lock", "--json"], {
      cwd: dir,
      env: { ...process.env, BETTER_LOG_LEVEL: "silent" }
    });

    await writeJson(path.join(dir, "package-lock.json"), {
      name: "lock-drift-test",
      lockfileVersion: 3,
      packages: {
        "": { name: "lock-drift-test", version: "1.0.0" },
        "node_modules/foo": { version: "1.0.0" }
      }
    });

    await assert.rejects(
      execFileAsync(process.execPath, [betterBin, "lock", "verify", "--json"], {
        cwd: dir,
        env: { ...process.env, BETTER_LOG_LEVEL: "silent" }
      }),
      (err) => {
        const report = JSON.parse(err.stdout);
        assert.equal(report.ok, false);
        assert.equal(report.kind, "better.lock.verify");
        assert.equal(report.checks.keyMatches, false);
        return true;
      }
    );
  } finally {
    await rmrf(dir);
  }
});

test("lock generate supports bun lockfile when --pm bun is set", async () => {
  const dir = await makeTempDir("better-lock-bun-explicit-");
  try {
    await writeJson(path.join(dir, "package.json"), { name: "lock-bun-test", version: "1.0.0" });
    await fs.writeFile(path.join(dir, "bun.lock"), "lockfileVersion = 0\n");

    const { stdout } = await execFileAsync(process.execPath, [betterBin, "lock", "--pm", "bun", "--json"], {
      cwd: dir,
      env: { ...process.env, BETTER_LOG_LEVEL: "silent" }
    });
    const report = JSON.parse(stdout);
    assert.equal(report.ok, true);
    assert.equal(report.kind, "better.lock.generate");
    assert.equal(report.lockfile.file, "bun.lock");

    const lockFile = path.join(dir, "better.lock.json");
    const doc = JSON.parse(await fs.readFile(lockFile, "utf8"));
    assert.equal(doc.pm.selected, "bun");
    assert.equal(doc.lockfile.file, "bun.lock");
  } finally {
    await rmrf(dir);
  }
});

test("lock auto-detects bun when only bun lockfile exists", async () => {
  const dir = await makeTempDir("better-lock-bun-auto-");
  try {
    await writeJson(path.join(dir, "package.json"), { name: "lock-bun-auto-test", version: "1.0.0" });
    await fs.writeFile(path.join(dir, "bun.lockb"), "binary-lock-placeholder");

    const { stdout } = await execFileAsync(process.execPath, [betterBin, "lock", "--json"], {
      cwd: dir,
      env: { ...process.env, BETTER_LOG_LEVEL: "silent" }
    });
    const report = JSON.parse(stdout);
    assert.equal(report.ok, true);
    assert.equal(report.lockfile.file, "bun.lockb");
    assert.equal(report.pm.selected, "bun");
    assert.equal(report.pm.reason, "bun.lockb");
  } finally {
    await rmrf(dir);
  }
});
