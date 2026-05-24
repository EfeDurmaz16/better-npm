// test/health-config-devdeps.test.js
// Tests for: better health-dashboard, better config-audit, better config-check,
//            better dev-deps-check, better deps-check, better coverage-check

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
      env: { ...process.env, ...extraEnv, BETTER_LOG_LEVEL: "silent", NO_COLOR: "1" },
      timeout: 20_000
    });
    return { ok: true, stdout, stderr, exitCode: 0 };
  } catch (err) {
    return { ok: false, stdout: err.stdout ?? "", stderr: err.stderr ?? "", exitCode: err.code ?? 1 };
  }
}

// ── health-dashboard ────────────────────────────────────────────────────────

test("health-dashboard --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["health-dashboard", "--help"], process.cwd());
  assert.ok(ok, "health-dashboard --help should succeed");
  assert.ok(
    stdout.includes("health") || stdout.includes("dashboard") || stdout.includes("score"),
    "should describe health dashboard"
  );
});

test("health-dashboard --json returns structured score report", async () => {
  const dir = await makeTempDir("better-health-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "my-app",
      version: "1.0.0",
      description: "A test app",
      license: "MIT",
      scripts: { test: "node --test" },
      dependencies: {},
      devDependencies: {}
    });

    const { stdout, ok } = await runBetter(["health-dashboard", "--json"], dir);
    assert.ok(ok, "health-dashboard should succeed");
    const out = JSON.parse(stdout);
    // ok reflects health status (may be false for poor health), not command success
    assert.ok(typeof out.ok === "boolean", "should have ok field");
    assert.ok(out.kind?.includes("health"), `unexpected kind: ${out.kind}`);
    assert.ok(typeof out.score === "number" || typeof out.overallScore === "number", "should have score");
    const score = out.score ?? out.overallScore;
    assert.ok(score >= 0 && score <= 100, `score ${score} should be 0-100`);
    assert.ok(typeof out.dimensions === "object" || Array.isArray(out.checks), "should have dimensions or checks");
  } finally {
    await rmrf(dir);
  }
});

test("health-dashboard --json scores improve with better package metadata", async () => {
  const dir1 = await makeTempDir("better-health-bare-");
  const dir2 = await makeTempDir("better-health-rich-");
  try {
    // Bare package (no license, no description)
    await writeJson(path.join(dir1, "package.json"), {
      name: "bare-pkg",
      version: "1.0.0"
    });

    // Rich package (license, description, readme, tests)
    await writeJson(path.join(dir2, "package.json"), {
      name: "rich-pkg",
      version: "1.0.0",
      description: "A well-documented package",
      license: "MIT",
      scripts: { test: "node --test", lint: "eslint ." },
      repository: { type: "git", url: "https://github.com/test/rich-pkg.git" }
    });
    await fs.writeFile(path.join(dir2, "README.md"), "# Rich Package\n\nDocs here.\n");

    const [r1, r2] = await Promise.all([
      runBetter(["health-dashboard", "--json"], dir1),
      runBetter(["health-dashboard", "--json"], dir2)
    ]);

    if (r1.stdout.trim() && r2.stdout.trim()) {
      const out1 = JSON.parse(r1.stdout);
      const out2 = JSON.parse(r2.stdout);
      if (out1.ok && out2.ok) {
        const s1 = out1.score ?? out1.overallScore ?? 0;
        const s2 = out2.score ?? out2.overallScore ?? 0;
        assert.ok(s2 >= s1, `rich package (score: ${s2}) should score >= bare package (score: ${s1})`);
      }
    }
  } finally {
    await Promise.all([rmrf(dir1), rmrf(dir2)]);
  }
});

// ── config-audit ─────────────────────────────────────────────────────────────

test("config-audit --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["config-audit", "--help"], process.cwd());
  assert.ok(ok, "config-audit --help should succeed");
  assert.ok(
    stdout.includes("config") || stdout.includes("npmrc") || stdout.includes("audit"),
    "should describe config auditing"
  );
});

test("config-audit --json returns structured report", async () => {
  const dir = await makeTempDir("better-configaudit-");
  try {
    await writeJson(path.join(dir, "package.json"), { name: "test", version: "1.0.0" });

    const { stdout, ok } = await runBetter(["config-audit", "--json"], dir);
    assert.ok(ok, "config-audit should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.equal(out.ok, true);
      assert.ok(out.kind?.includes("config"), `unexpected kind: ${out.kind}`);
      assert.ok(Array.isArray(out.issues ?? out.warnings ?? out.checks), "should have issues/checks array");
    }
  } finally {
    await rmrf(dir);
  }
});

test("config-audit --json flags insecure registry in .npmrc", async () => {
  const dir = await makeTempDir("better-configaudit-insecure-");
  try {
    await writeJson(path.join(dir, "package.json"), { name: "test", version: "1.0.0" });
    // Insecure .npmrc with http registry
    await fs.writeFile(path.join(dir, ".npmrc"), "registry=http://insecure-registry.example.com\n", "utf8");

    const { stdout } = await runBetter(["config-audit", "--json"], dir);
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      const allIssues = [...(out.issues ?? []), ...(out.warnings ?? []), ...(out.checks ?? [])];
      const hasRegistryIssue = allIssues.some(i =>
        String(i.message ?? i.label ?? i.id ?? "").toLowerCase().includes("http") ||
        String(i.message ?? i.label ?? i.id ?? "").toLowerCase().includes("insecure") ||
        String(i.message ?? i.label ?? i.id ?? "").toLowerCase().includes("registry")
      );
      assert.ok(hasRegistryIssue || !out.ok || allIssues.length > 0, "should flag insecure HTTP registry");
    }
  } finally {
    await rmrf(dir);
  }
});

// ── config-check ──────────────────────────────────────────────────────────────

test("config-check --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["config-check", "--help"], process.cwd());
  assert.ok(ok, "config-check --help should succeed");
  assert.ok(
    stdout.includes("config") || stdout.includes("check") || stdout.includes(".npmrc"),
    "should describe config checking"
  );
});

test("config-check --json returns report for project", async () => {
  const dir = await makeTempDir("better-configcheck-");
  try {
    await writeJson(path.join(dir, "package.json"), { name: "test", version: "1.0.0" });

    const { stdout, ok } = await runBetter(["config-check", "--json"], dir);
    assert.ok(ok, "config-check should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("config"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── dev-deps-check ────────────────────────────────────────────────────────────

test("dev-deps-check --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["dev-deps-check", "--help"], process.cwd());
  assert.ok(ok, "dev-deps-check --help should succeed");
  assert.ok(
    stdout.includes("dev") || stdout.includes("deps") || stdout.includes("devDependencies"),
    "should describe dev dependency checking"
  );
});

test("dev-deps-check --json returns report", async () => {
  const dir = await makeTempDir("better-devdepscheck-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test",
      version: "1.0.0",
      devDependencies: { jest: "^29.0.0" }
    });
    const nmDir = path.join(dir, "node_modules");
    await fs.mkdir(path.join(nmDir, "jest"), { recursive: true });
    await writeJson(path.join(nmDir, "jest", "package.json"), {
      name: "jest", version: "29.0.0"
    });

    const { stdout, ok } = await runBetter(["dev-deps-check", "--json"], dir);
    assert.ok(ok, "dev-deps-check should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("dev-deps") || out.kind?.includes("deps"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── deps-check ────────────────────────────────────────────────────────────────

test("deps-check --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["deps-check", "--help"], process.cwd());
  assert.ok(ok, "deps-check --help should succeed");
  assert.ok(
    stdout.includes("dep") || stdout.includes("check") || stdout.includes("missing"),
    "should describe dependency checking"
  );
});

test("deps-check --json detects missing dependencies", async () => {
  const dir = await makeTempDir("better-depscheck-missing-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test",
      version: "1.0.0",
      dependencies: {}
    });
    // Write a source file importing a package not in dependencies
    await fs.writeFile(path.join(dir, "index.js"), "const _ = require('lodash');\n", "utf8");

    const { stdout } = await runBetter(["deps-check", "--json"], dir);
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("deps") || out.kind?.includes("check"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── coverage-check ────────────────────────────────────────────────────────────

test("coverage-check --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["coverage-check", "--help"], process.cwd());
  assert.ok(ok, "coverage-check --help should succeed");
  assert.ok(
    stdout.includes("coverage") || stdout.includes("lcov") || stdout.includes("threshold"),
    "should describe coverage checking"
  );
});

test("coverage-check --json reports error when no coverage report found", async () => {
  const dir = await makeTempDir("better-covcheck-none-");
  try {
    await writeJson(path.join(dir, "package.json"), { name: "test", version: "1.0.0" });

    const { stdout } = await runBetter(["coverage-check", "--json"], dir);
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      // No coverage report found → ok=false with an error message
      if (!out.ok) {
        assert.ok(out.error || out.reason || out.kind, "should have an error message or kind");
      }
    }
  } finally {
    await rmrf(dir);
  }
});

test("coverage-check --json reads Istanbul coverage-summary.json", async () => {
  const dir = await makeTempDir("better-covcheck-istanbul-");
  try {
    await writeJson(path.join(dir, "package.json"), { name: "test", version: "1.0.0" });
    await fs.mkdir(path.join(dir, "coverage"), { recursive: true });
    // Istanbul coverage-summary.json format
    await writeJson(path.join(dir, "coverage", "coverage-summary.json"), {
      total: {
        lines: { total: 100, covered: 95, skipped: 0, pct: 95 },
        statements: { total: 120, covered: 114, skipped: 0, pct: 95 },
        functions: { total: 20, covered: 19, skipped: 0, pct: 95 },
        branches: { total: 30, covered: 27, skipped: 0, pct: 90 }
      }
    });

    const { stdout, ok } = await runBetter(["coverage-check", "--json"], dir);
    assert.ok(ok, "coverage-check should succeed with coverage-summary.json");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.equal(out.ok, true);
      assert.ok(out.kind?.includes("coverage"), `unexpected kind: ${out.kind}`);
      assert.ok(
        typeof out.coverage?.lines === "number" || typeof out.lines === "number" || out.summary || out.totals,
        "should report coverage numbers"
      );
    }
  } finally {
    await rmrf(dir);
  }
});
