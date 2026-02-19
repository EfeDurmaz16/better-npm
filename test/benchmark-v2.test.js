import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { makeTempDir, rmrf, writeFile, writeJson } from "./helpers.js";

const execFileAsync = promisify(execFile);
const betterBin = path.resolve(process.cwd(), "bin", "better.js");

/**
 * Helper to run benchmark and parse JSON output
 */
async function runBenchmark(dir, args = [], env = {}) {
  const { stdout } = await execFileAsync(
    process.execPath,
    [betterBin, "benchmark", ...args],
    {
      cwd: dir,
      env: {
        ...process.env,
        BETTER_LOG_LEVEL: "silent",
        ...env
      },
      timeout: 120_000
    }
  );
  return JSON.parse(stdout);
}

/**
 * Create a minimal test project with fake npm
 */
async function createTestProject(dir) {
  await writeJson(path.join(dir, "package.json"), {
    name: "benchmark-v2-test",
    version: "1.0.0"
  });
  await writeJson(path.join(dir, "package-lock.json"), {
    name: "benchmark-v2-test",
    lockfileVersion: 3,
    packages: {
      "": { name: "benchmark-v2-test", version: "1.0.0" }
    }
  });

  // Create fake npm binary for faster tests
  const fakeBin = path.join(dir, "fake-bin");
  await fs.mkdir(fakeBin, { recursive: true });
  const fakeNpmPath = path.join(fakeBin, "npm");
  await writeFile(
    fakeNpmPath,
    [
      "#!/bin/sh",
      "mkdir -p node_modules/fake",
      "cat > node_modules/fake/package.json <<'JSON'",
      '{"name":"fake","version":"1.0.0"}',
      "JSON",
      "exit 0",
      ""
    ].join("\n")
  );
  await fs.chmod(fakeNpmPath, 0o755);

  return { fakeBin };
}

test("benchmark v2 schema - schemaVersion field", async (t) => {
  if (process.platform === "win32") {
    t.skip("fake npm path shim is POSIX-only");
    return;
  }

  const dir = await makeTempDir("better-benchmark-v2-schema-");
  try {
    const { fakeBin } = await createTestProject(dir);

    const report = await runBenchmark(
      dir,
      [
        "--project-root",
        ".",
        "--pm",
        "npm",
        "--engine",
        "pm",
        "--cold-rounds",
        "1",
        "--warm-rounds",
        "1",
        "--json"
      ],
      { PATH: `${fakeBin}:${process.env.PATH ?? ""}` }
    );

    assert.equal(report.schemaVersion, 2, "schemaVersion should be 2");
    assert.equal(report.ok, true);
    assert.equal(report.kind, "better.benchmark");
  } finally {
    await rmrf(dir);
  }
});

test("benchmark v2 schema - env field with platform info", async (t) => {
  if (process.platform === "win32") {
    t.skip("fake npm path shim is POSIX-only");
    return;
  }

  const dir = await makeTempDir("better-benchmark-v2-env-");
  try {
    const { fakeBin } = await createTestProject(dir);

    const report = await runBenchmark(
      dir,
      [
        "--project-root",
        ".",
        "--pm",
        "npm",
        "--engine",
        "pm",
        "--cold-rounds",
        "0",
        "--warm-rounds",
        "1",
        "--json"
      ],
      { PATH: `${fakeBin}:${process.env.PATH ?? ""}` }
    );

    assert.ok(report.env, "env field should exist");
    assert.equal(typeof report.env.platform, "string", "env.platform should be a string");
    assert.equal(typeof report.env.arch, "string", "env.arch should be a string");
    assert.equal(typeof report.env.nodeVersion, "string", "env.nodeVersion should be a string");
    assert.equal(typeof report.env.cpus, "number", "env.cpus should be a number");
    assert.equal(typeof report.env.totalMemoryBytes, "number", "env.totalMemoryBytes should be a number");
    assert.ok(report.env.platform === process.platform, "platform should match process.platform");
    assert.ok(report.env.arch === process.arch, "arch should match process.arch");
    assert.ok(report.env.nodeVersion === process.version, "nodeVersion should match process.version");
  } finally {
    await rmrf(dir);
  }
});

test("benchmark v2 schema - parity field with lockfile hashes", async (t) => {
  if (process.platform === "win32") {
    t.skip("fake npm path shim is POSIX-only");
    return;
  }

  const dir = await makeTempDir("better-benchmark-v2-parity-");
  try {
    const { fakeBin } = await createTestProject(dir);

    const report = await runBenchmark(
      dir,
      [
        "--project-root",
        ".",
        "--pm",
        "npm",
        "--engine",
        "pm",
        "--cold-rounds",
        "0",
        "--warm-rounds",
        "1",
        "--json"
      ],
      { PATH: `${fakeBin}:${process.env.PATH ?? ""}` }
    );

    assert.ok(report.parity, "parity field should exist");
    assert.ok(report.parity.lockfiles, "parity.lockfiles should exist");
    assert.equal(typeof report.parity.lockfiles, "object", "parity.lockfiles should be an object");
    assert.ok(report.parity.lockfiles["package-lock.json"], "should have package-lock.json hash");
    assert.equal(typeof report.parity.lockfiles["package-lock.json"], "string", "lockfile hash should be a string");
    assert.equal(report.parity.lockfiles["package-lock.json"].length, 64, "sha256 hash should be 64 chars");
    assert.equal(report.parity.verified, true, "parity.verified should be true");
  } finally {
    await rmrf(dir);
  }
});

test("benchmark v2 schema - scenario field", async (t) => {
  if (process.platform === "win32") {
    t.skip("fake npm path shim is POSIX-only");
    return;
  }

  const dir = await makeTempDir("better-benchmark-v2-scenario-");
  try {
    const { fakeBin } = await createTestProject(dir);

    const report = await runBenchmark(
      dir,
      [
        "--project-root",
        ".",
        "--pm",
        "npm",
        "--engine",
        "pm",
        "--scenario",
        "warm_hit",
        "--cold-rounds",
        "0",
        "--warm-rounds",
        "1",
        "--json"
      ],
      { PATH: `${fakeBin}:${process.env.PATH ?? ""}` }
    );

    assert.equal(report.scenario, "warm_hit", "scenario should match flag value");
  } finally {
    await rmrf(dir);
  }
});

test("benchmark v2 schema - comparison.byScenario array", async (t) => {
  if (process.platform === "win32") {
    t.skip("fake npm path shim is POSIX-only");
    return;
  }

  const dir = await makeTempDir("better-benchmark-v2-byscenario-");
  try {
    const { fakeBin } = await createTestProject(dir);

    const report = await runBenchmark(
      dir,
      [
        "--project-root",
        ".",
        "--pm",
        "npm",
        "--engine",
        "pm",
        "--cold-rounds",
        "1",
        "--warm-rounds",
        "1",
        "--json"
      ],
      { PATH: `${fakeBin}:${process.env.PATH ?? ""}` }
    );

    assert.ok(report.comparison, "comparison field should exist");
    assert.ok(Array.isArray(report.comparison.byScenario), "comparison.byScenario should be an array");
    assert.ok(report.comparison.byScenario.length > 0, "byScenario should have entries");

    const scenario = report.comparison.byScenario[0];
    assert.ok(scenario.scenario, "scenario entry should have scenario field");
    assert.ok(
      ["cold_miss", "warm_hit", "reuse_noop"].includes(scenario.scenario),
      "scenario should be valid value"
    );
    assert.ok("rawMedianMs" in scenario, "scenario should have rawMedianMs");
    assert.ok("betterMedianMs" in scenario, "scenario should have betterMedianMs");
    assert.ok("deltaMs" in scenario, "scenario should have deltaMs");
    assert.ok("deltaPercent" in scenario, "scenario should have deltaPercent");
  } finally {
    await rmrf(dir);
  }
});

test("benchmark v2 schema - variance stats (stddev, p95Spread)", async (t) => {
  if (process.platform === "win32") {
    t.skip("fake npm path shim is POSIX-only");
    return;
  }

  const dir = await makeTempDir("better-benchmark-v2-variance-");
  try {
    const { fakeBin } = await createTestProject(dir);

    const report = await runBenchmark(
      dir,
      [
        "--project-root",
        ".",
        "--pm",
        "npm",
        "--engine",
        "pm",
        "--cold-rounds",
        "0",
        "--warm-rounds",
        "3",
        "--json"
      ],
      { PATH: `${fakeBin}:${process.env.PATH ?? ""}` }
    );

    assert.ok(report.variants, "variants field should exist");
    assert.ok(report.variants.raw, "raw variant should exist");
    assert.ok(report.variants.raw.stats, "raw.stats should exist");
    assert.ok(report.variants.raw.stats.warm, "raw.stats.warm should exist");

    const stats = report.variants.raw.stats.warm;
    assert.ok("stddev" in stats, "stats should have stddev field");
    assert.ok("p95Spread" in stats, "stats should have p95Spread field");

    // With 3 warm rounds, stddev should be computed
    if (stats.count >= 2) {
      assert.ok(
        stats.stddev === null || typeof stats.stddev === "number",
        "stddev should be null or number"
      );
    }
    assert.ok(
      stats.p95Spread === null || typeof stats.p95Spread === "number",
      "p95Spread should be null or number"
    );
  } finally {
    await rmrf(dir);
  }
});

test("benchmark v2 - --scenario flag validation", async (t) => {
  if (process.platform === "win32") {
    t.skip("fake npm path shim is POSIX-only");
    return;
  }

  const dir = await makeTempDir("better-benchmark-v2-scenario-invalid-");
  try {
    await createTestProject(dir);

    await assert.rejects(
      async () => {
        await runBenchmark(dir, [
          "--project-root",
          ".",
          "--pm",
          "npm",
          "--scenario",
          "invalid_scenario",
          "--cold-rounds",
          "1",
          "--warm-rounds",
          "1",
          "--json"
        ]);
      },
      {
        message: /Unknown --scenario/
      },
      "should reject invalid scenario values"
    );
  } finally {
    await rmrf(dir);
  }
});

test("benchmark v2 - cold_miss scenario skips warm rounds", async (t) => {
  if (process.platform === "win32") {
    t.skip("fake npm path shim is POSIX-only");
    return;
  }

  const dir = await makeTempDir("better-benchmark-v2-cold-only-");
  try {
    const { fakeBin } = await createTestProject(dir);

    const report = await runBenchmark(
      dir,
      [
        "--project-root",
        ".",
        "--pm",
        "npm",
        "--engine",
        "pm",
        "--scenario",
        "cold_miss",
        "--cold-rounds",
        "2",
        "--warm-rounds",
        "3",
        "--json"
      ],
      { PATH: `${fakeBin}:${process.env.PATH ?? ""}` }
    );

    assert.equal(report.scenario, "cold_miss");
    assert.ok(report.variants.raw, "raw variant should exist");
    assert.equal(report.variants.raw.cold.length, 2, "should have 2 cold samples");
    assert.equal(report.variants.raw.warm.length, 0, "should have 0 warm samples");
    assert.ok(report.comparison.byScenario.find(s => s.scenario === "cold_miss"), "should have cold_miss in byScenario");
    assert.ok(!report.comparison.byScenario.find(s => s.scenario === "warm_hit"), "should not have warm_hit in byScenario");
  } finally {
    await rmrf(dir);
  }
});

test("benchmark v2 - warm_hit scenario skips cold rounds", async (t) => {
  if (process.platform === "win32") {
    t.skip("fake npm path shim is POSIX-only");
    return;
  }

  const dir = await makeTempDir("better-benchmark-v2-warm-only-");
  try {
    const { fakeBin } = await createTestProject(dir);

    const report = await runBenchmark(
      dir,
      [
        "--project-root",
        ".",
        "--pm",
        "npm",
        "--engine",
        "pm",
        "--scenario",
        "warm_hit",
        "--cold-rounds",
        "3",
        "--warm-rounds",
        "2",
        "--json"
      ],
      { PATH: `${fakeBin}:${process.env.PATH ?? ""}` }
    );

    assert.equal(report.scenario, "warm_hit");
    assert.ok(report.variants.raw, "raw variant should exist");
    assert.equal(report.variants.raw.cold.length, 0, "should have 0 cold samples");
    assert.equal(report.variants.raw.warm.length, 2, "should have 2 warm samples");
    assert.ok(report.comparison.byScenario.find(s => s.scenario === "warm_hit"), "should have warm_hit in byScenario");
    assert.ok(!report.comparison.byScenario.find(s => s.scenario === "cold_miss"), "should not have cold_miss in byScenario");
  } finally {
    await rmrf(dir);
  }
});

test("benchmark v2 - deterministic band: byScenario matches requested scenario", async (t) => {
  if (process.platform === "win32") {
    t.skip("fake npm path shim is POSIX-only");
    return;
  }

  const dir = await makeTempDir("better-benchmark-v2-deterministic-");
  try {
    const { fakeBin } = await createTestProject(dir);

    const report = await runBenchmark(
      dir,
      [
        "--project-root",
        ".",
        "--pm",
        "npm",
        "--engine",
        "pm",
        "--scenario",
        "cold_miss",
        "--cold-rounds",
        "1",
        "--warm-rounds",
        "0",
        "--json"
      ],
      { PATH: `${fakeBin}:${process.env.PATH ?? ""}` }
    );

    assert.equal(report.comparison.byScenario.length, 1, "should have exactly 1 scenario entry");
    assert.equal(
      report.comparison.byScenario[0].scenario,
      "cold_miss",
      "byScenario entry should match requested scenario"
    );

    // Verify no warm comparison data
    const coldEntry = report.comparison.byScenario[0];
    assert.ok(coldEntry.rawMedianMs !== null, "cold should have raw median");
    assert.ok(coldEntry.betterMedianMs !== null, "cold should have better median");
  } finally {
    await rmrf(dir);
  }
});

test("benchmark v2 - all scenario runs both cold and warm", async (t) => {
  if (process.platform === "win32") {
    t.skip("fake npm path shim is POSIX-only");
    return;
  }

  const dir = await makeTempDir("better-benchmark-v2-all-");
  try {
    const { fakeBin } = await createTestProject(dir);

    const report = await runBenchmark(
      dir,
      [
        "--project-root",
        ".",
        "--pm",
        "npm",
        "--engine",
        "pm",
        "--scenario",
        "all",
        "--cold-rounds",
        "1",
        "--warm-rounds",
        "1",
        "--json"
      ],
      { PATH: `${fakeBin}:${process.env.PATH ?? ""}` }
    );

    assert.equal(report.scenario, "all");
    assert.ok(report.variants.raw.cold.length > 0, "should have cold samples");
    assert.ok(report.variants.raw.warm.length > 0, "should have warm samples");
    assert.equal(report.comparison.byScenario.length, 2, "should have 2 scenario entries");
    assert.ok(
      report.comparison.byScenario.find(s => s.scenario === "cold_miss"),
      "should have cold_miss in byScenario"
    );
    assert.ok(
      report.comparison.byScenario.find(s => s.scenario === "warm_hit"),
      "should have warm_hit in byScenario"
    );
  } finally {
    await rmrf(dir);
  }
});

test("benchmark v2 - reuse_noop scenario marks warm as reuse_noop", async (t) => {
  if (process.platform === "win32") {
    t.skip("fake npm path shim is POSIX-only");
    return;
  }

  const dir = await makeTempDir("better-benchmark-v2-reuse-noop-");
  try {
    const { fakeBin } = await createTestProject(dir);

    const report = await runBenchmark(
      dir,
      [
        "--project-root",
        ".",
        "--pm",
        "npm",
        "--engine",
        "pm",
        "--scenario",
        "reuse_noop",
        "--cold-rounds",
        "0",
        "--warm-rounds",
        "1",
        "--json"
      ],
      { PATH: `${fakeBin}:${process.env.PATH ?? ""}` }
    );

    assert.equal(report.scenario, "reuse_noop");
    assert.equal(report.comparison.byScenario.length, 1, "should have 1 scenario entry");
    assert.equal(
      report.comparison.byScenario[0].scenario,
      "reuse_noop",
      "byScenario should use reuse_noop instead of warm_hit"
    );
  } finally {
    await rmrf(dir);
  }
});

test("benchmark v2 - stats fields structure", async (t) => {
  if (process.platform === "win32") {
    t.skip("fake npm path shim is POSIX-only");
    return;
  }

  const dir = await makeTempDir("better-benchmark-v2-stats-");
  try {
    const { fakeBin } = await createTestProject(dir);

    const report = await runBenchmark(
      dir,
      [
        "--project-root",
        ".",
        "--pm",
        "npm",
        "--engine",
        "pm",
        "--cold-rounds",
        "0",
        "--warm-rounds",
        "2",
        "--json"
      ],
      { PATH: `${fakeBin}:${process.env.PATH ?? ""}` }
    );

    const stats = report.variants.raw.stats.warm;
    assert.equal(typeof stats.count, "number", "count should be a number");
    assert.ok(stats.min === null || typeof stats.min === "number", "min should be null or number");
    assert.ok(stats.max === null || typeof stats.max === "number", "max should be null or number");
    assert.ok(stats.mean === null || typeof stats.mean === "number", "mean should be null or number");
    assert.ok(stats.median === null || typeof stats.median === "number", "median should be null or number");
    assert.ok(stats.p95 === null || typeof stats.p95 === "number", "p95 should be null or number");
    assert.ok(stats.stddev === null || typeof stats.stddev === "number", "stddev should be null or number");
    assert.ok(stats.p95Spread === null || typeof stats.p95Spread === "number", "p95Spread should be null or number");
  } finally {
    await rmrf(dir);
  }
});

test("benchmark v2 - config field captures all options", async (t) => {
  if (process.platform === "win32") {
    t.skip("fake npm path shim is POSIX-only");
    return;
  }

  const dir = await makeTempDir("better-benchmark-v2-config-");
  try {
    const { fakeBin } = await createTestProject(dir);

    const report = await runBenchmark(
      dir,
      [
        "--project-root",
        ".",
        "--pm",
        "npm",
        "--engine",
        "pm",
        "--frozen",
        "--cold-rounds",
        "1",
        "--warm-rounds",
        "2",
        "--json"
      ],
      { PATH: `${fakeBin}:${process.env.PATH ?? ""}` }
    );

    assert.ok(report.config, "config field should exist");
    assert.equal(report.config.coldRounds, 1, "config.coldRounds should match");
    assert.equal(report.config.warmRounds, 2, "config.warmRounds should match");
    assert.equal(report.config.frozen, true, "config.frozen should be true");
    assert.equal(typeof report.config.timeoutMs, "number", "config.timeoutMs should be a number");
    assert.ok(report.config.cacheRootBase, "config.cacheRootBase should exist");
  } finally {
    await rmrf(dir);
  }
});
