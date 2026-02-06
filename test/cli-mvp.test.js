import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs/promises";
import { makeTempDir, rmrf, writeJson, writeFile } from "./helpers.js";

const execFileAsync = promisify(execFile);
const betterBin = path.resolve(process.cwd(), "bin", "better.js");

test("cli: --version prints version", async () => {
  const { stdout } = await execFileAsync(process.execPath, [betterBin, "--version"]);
  assert.match(stdout.trim(), /^better v\d+\.\d+\.\d+$/);
});

test("install: --dry-run emits structured JSON", async () => {
  const dir = await makeTempDir("better-dry-run-");
  try {
    await writeJson(path.join(dir, "package.json"), { name: "dry-run-test", version: "1.0.0" });
    await writeJson(path.join(dir, "package-lock.json"), {
      name: "dry-run-test",
      lockfileVersion: 3,
      packages: {
        "": { name: "dry-run-test", version: "1.0.0" },
        "node_modules/foo": { version: "1.0.0" }
      }
    });

    const { stdout } = await execFileAsync(process.execPath, [betterBin, "install", "--dry-run", "--json"], {
      cwd: dir
    });
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.kind, "better.install.dryrun");
    assert.equal(parsed.dryRun, true);
    assert.equal(parsed.pm.name, "npm");
    assert.ok(parsed.command.cmd);
    assert.ok(parsed.estimate);
  } finally {
    await rmrf(dir);
  }
});

test("doctor: exits non-zero when score below threshold", async () => {
  const dir = await makeTempDir("better-doctor-threshold-");
  try {
    await writeJson(path.join(dir, "package-lock.json"), {
      name: "doctor-threshold-test",
      lockfileVersion: 3,
      packages: { "": { name: "doctor-threshold-test", version: "1.0.0" } }
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    await writeJson(path.join(dir, "package.json"), {
      name: "doctor-threshold-test",
      version: "1.0.0"
    });
    await writeJson(path.join(dir, "node_modules", "foo", "package.json"), {
      name: "foo",
      version: "1.0.0"
    });
    await writeFile(path.join(dir, "node_modules", "foo", "index.js"), "module.exports = 1;\n");

    await assert.rejects(
      execFileAsync(process.execPath, [betterBin, "doctor", "--json", "--threshold", "99", "--no-core"], {
        cwd: dir
      }),
      (err) => {
        const parsed = JSON.parse(err.stdout);
        assert.equal(parsed.ok, true);
        assert.equal(parsed.kind, "better.doctor");
        assert.equal(parsed.healthScore.belowThreshold, true);
        return true;
      }
    );
  } finally {
    await rmrf(dir);
  }
});

test("cache stats: includes entries and hit ratio fields", async () => {
  const dir = await makeTempDir("better-cache-stats-");
  try {
    await writeJson(path.join(dir, "package.json"), { name: "cache-stats-test", version: "1.0.0" });
    const cacheRoot = path.join(dir, ".cache");
    const { stdout } = await execFileAsync(process.execPath, [betterBin, "cache", "stats", "--json", "--cache-root", cacheRoot], {
      cwd: dir
    });
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.kind, "better.cache.stats");
    assert.ok(parsed.entries);
    assert.ok(parsed.hitRatio);
    assert.ok(typeof parsed.entries.total === "number");
  } finally {
    await rmrf(dir);
  }
});

test("cache explain: uses tracked package metadata when available", async () => {
  const dir = await makeTempDir("better-cache-explain-track-");
  try {
    const cacheRoot = path.join(dir, ".cache");
    await fs.mkdir(cacheRoot, { recursive: true });
    await writeJson(path.join(cacheRoot, "state.json"), {
      schemaVersion: 1,
      projects: {},
      analysesIndex: {},
      cacheMetrics: { installRuns: 1, cacheHits: 2, cacheMisses: 1, lastUpdatedAt: "2026-01-01T00:00:00.000Z" },
      cachePackages: {
        "left-pad@1.3.0": {
          name: "left-pad",
          version: "1.3.0",
          seenCount: 3,
          lastUsedAt: "2026-01-02T00:00:00.000Z",
          projects: { demo: "2026-01-02T00:00:00.000Z" },
          cacheHitCount: 2,
          cacheMissCount: 1,
          casKeys: ["sha512:abc123"]
        }
      }
    });

    const { stdout } = await execFileAsync(process.execPath, [betterBin, "cache", "explain", "left-pad@1.3.0", "--json", "--cache-root", cacheRoot], {
      cwd: dir
    });
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.kind, "better.cache.explain");
    assert.equal(parsed.cached, true);
    assert.equal(parsed.lastSeenAt, "2026-01-02T00:00:00.000Z");
    assert.equal(parsed.tracking.cacheHitCount, 2);
  } finally {
    await rmrf(dir);
  }
});
