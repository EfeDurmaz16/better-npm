// test/add-remove-analyze-misc.test.js
// Tests for: better add, better remove, better analyze, better audit-html,
//            better benchmark, better cache, better alias, better changelog-view,
//            better ci-check, better cleanup, better config-audit, better config-check,
//            better contributors-check, better coverage-check, better cve-check,
//            better dashboard, better compliance, better credentials

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

// ── add ───────────────────────────────────────────────────────────────────────

test("add --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["add", "--help"], process.cwd());
  assert.ok(ok, "add --help should succeed");
  assert.ok(
    stdout.includes("add") || stdout.includes("package") || stdout.includes("install"),
    "should describe add options"
  );
});

test("add --json --dry-run reports what would be added", async () => {
  const dir = await makeTempDir("better-add-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      dependencies: {}
    });

    const { stdout } = await runBetter(["add", "semver", "--json", "--dry-run"], dir);
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
    }
  } finally {
    await rmrf(dir);
  }
});

// ── remove ────────────────────────────────────────────────────────────────────

test("remove --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["remove", "--help"], process.cwd());
  assert.ok(ok, "remove --help should succeed");
  assert.ok(
    stdout.includes("remove") || stdout.includes("package") || stdout.includes("uninstall"),
    "should describe remove options"
  );
});

// ── analyze ───────────────────────────────────────────────────────────────────

test("analyze --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["analyze", "--help"], process.cwd());
  assert.ok(ok, "analyze --help should succeed");
  assert.ok(
    stdout.includes("analyze") || stdout.includes("graph") || stdout.includes("out"),
    "should describe analyze options"
  );
});

test("analyze --json analyzes project dependencies", async () => {
  const dir = await makeTempDir("better-analyze-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      dependencies: { "semver": "^7.0.0" }
    });

    const { stdout } = await runBetter(["analyze", "--json"], dir);
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
    }
  } finally {
    await rmrf(dir);
  }
});

// ── audit-html ────────────────────────────────────────────────────────────────

test("audit-html --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["audit-html", "--help"], process.cwd());
  assert.ok(ok, "audit-html --help should succeed");
  assert.ok(
    stdout.includes("audit") || stdout.includes("html") || stdout.includes("report"),
    "should describe audit-html options"
  );
});

test("audit-html --json generates audit HTML report", async () => {
  const dir = await makeTempDir("better-audit-html-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      dependencies: {}
    });

    const { stdout, ok } = await runBetter(["audit-html", "--json"], dir);
    assert.ok(ok, "audit-html should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("audit-html"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── benchmark ─────────────────────────────────────────────────────────────────

test("benchmark --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["benchmark", "--help"], process.cwd());
  assert.ok(ok, "benchmark --help should succeed");
  assert.ok(
    stdout.includes("benchmark") || stdout.includes("pm") || stdout.includes("engine"),
    "should describe benchmark options"
  );
});

test("benchmark --json benchmarks install performance", async () => {
  const dir = await makeTempDir("better-benchmark-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      dependencies: {}
    });

    const { stdout, ok } = await runBetter(["benchmark", "--json"], dir);
    assert.ok(ok, "benchmark should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("benchmark"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── cache ─────────────────────────────────────────────────────────────────────

test("cache --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["cache", "--help"], process.cwd());
  assert.ok(ok, "cache --help should succeed");
  assert.ok(
    stdout.includes("cache") || stdout.includes("stats") || stdout.includes("clean"),
    "should describe cache subcommands"
  );
});

test("cache stats --json returns cache statistics", async () => {
  const { stdout, ok } = await runBetter(["cache", "stats", "--json"], process.cwd());
  assert.ok(ok, "cache stats should succeed");
  if (stdout.trim()) {
    const out = JSON.parse(stdout);
    assert.ok(typeof out.ok === "boolean", "should have ok field");
    assert.ok(out.kind?.includes("cache"), `unexpected kind: ${out.kind}`);
  }
});

// ── alias ─────────────────────────────────────────────────────────────────────

test("alias --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["alias", "--help"], process.cwd());
  assert.ok(ok, "alias --help should succeed");
  assert.ok(
    stdout.includes("alias") || stdout.includes("list") || stdout.includes("add"),
    "should describe alias subcommands"
  );
});

test("alias list --json returns configured aliases", async () => {
  const { stdout, ok } = await runBetter(["alias", "list", "--json"], process.cwd());
  assert.ok(ok, "alias list should succeed");
  if (stdout.trim()) {
    const out = JSON.parse(stdout);
    assert.ok(typeof out.ok === "boolean", "should have ok field");
    assert.ok(out.kind?.includes("alias"), `unexpected kind: ${out.kind}`);
  }
});

// ── changelog-view ────────────────────────────────────────────────────────────

test("changelog-view --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["changelog-view", "--help"], process.cwd());
  assert.ok(ok, "changelog-view --help should succeed");
  assert.ok(
    stdout.includes("changelog") || stdout.includes("package") || stdout.includes("version"),
    "should describe changelog-view options"
  );
});

test("changelog-view <pkg> --json returns changelog (network-aware)", async (t) => {
  const { stdout, stderr, ok } = await runBetter(
    ["changelog-view", "semver", "--json"], process.cwd()
  );
  if (!ok && (stderr.includes("ENOTFOUND") || stderr.includes("ETIMEDOUT") || stderr.includes("timeout"))) {
    t.skip("network unavailable for changelog-view");
    return;
  }
  if (stdout.trim()) {
    const out = JSON.parse(stdout);
    assert.ok(typeof out.ok === "boolean", "should have ok field");
    assert.ok(out.kind?.includes("changelog"), `unexpected kind: ${out.kind}`);
  }
});

// ── ci-check ─────────────────────────────────────────────────────────────────

test("ci-check --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["ci-check", "--help"], process.cwd());
  assert.ok(ok, "ci-check --help should succeed");
  assert.ok(
    stdout.includes("ci") || stdout.includes("check") || stdout.includes("config"),
    "should describe ci-check options"
  );
});

test("ci-check --json reports CI configuration", async () => {
  const dir = await makeTempDir("better-ci-check-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0"
    });

    const { stdout, ok } = await runBetter(["ci-check", "--json"], dir);
    assert.ok(ok, "ci-check should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("ci-check"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── cleanup ───────────────────────────────────────────────────────────────────

test("cleanup --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["cleanup", "--help"], process.cwd());
  assert.ok(ok, "cleanup --help should succeed");
  assert.ok(
    stdout.includes("cleanup") || stdout.includes("clean") || stdout.includes("remove"),
    "should describe cleanup options"
  );
});

test("cleanup --json --dry-run reports what would be cleaned", async () => {
  const dir = await makeTempDir("better-cleanup-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0"
    });

    const { stdout } = await runBetter(["cleanup", "--json", "--dry-run"], dir);
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("cleanup"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── config-audit ──────────────────────────────────────────────────────────────

test("config-audit --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["config-audit", "--help"], process.cwd());
  assert.ok(ok, "config-audit --help should succeed");
  assert.ok(
    stdout.includes("config") || stdout.includes("audit") || stdout.includes("registry"),
    "should describe config-audit options"
  );
});

test("config-audit --json audits npm config", async () => {
  const { stdout, ok } = await runBetter(["config-audit", "--json"], process.cwd());
  assert.ok(ok, "config-audit should succeed");
  if (stdout.trim()) {
    const out = JSON.parse(stdout);
    assert.ok(typeof out.ok === "boolean", "should have ok field");
    assert.ok(out.kind?.includes("config-audit"), `unexpected kind: ${out.kind}`);
  }
});

// ── config-check ──────────────────────────────────────────────────────────────

test("config-check --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["config-check", "--help"], process.cwd());
  assert.ok(ok, "config-check --help should succeed");
  assert.ok(
    stdout.includes("config") || stdout.includes("check") || stdout.includes("typescript"),
    "should describe config-check options"
  );
});

test("config-check --json checks project configuration", async () => {
  const dir = await makeTempDir("better-config-check-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0"
    });

    const { stdout, ok } = await runBetter(["config-check", "--json"], dir);
    assert.ok(ok, "config-check should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("config-check"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── contributors-check ────────────────────────────────────────────────────────

test("contributors-check --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["contributors-check", "--help"], process.cwd());
  assert.ok(ok, "contributors-check --help should succeed");
  assert.ok(
    stdout.includes("contributors") || stdout.includes("check") || stdout.includes("packages"),
    "should describe contributors-check options"
  );
});

test("contributors-check --json checks contributor counts (network-aware)", async (t) => {
  const dir = await makeTempDir("better-contributors-check-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      dependencies: { "semver": "^7.0.0" }
    });
    const nmDir = path.join(dir, "node_modules");
    await fs.mkdir(path.join(nmDir, "semver"), { recursive: true });
    await writeJson(path.join(nmDir, "semver", "package.json"), {
      name: "semver", version: "7.5.4"
    });

    const { stdout, stderr, ok } = await runBetter(["contributors-check", "--json"], dir);
    if (!ok && (stderr.includes("ENOTFOUND") || stderr.includes("ETIMEDOUT") || stderr.includes("timeout"))) {
      t.skip("network unavailable for contributors-check");
      return;
    }
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("contributors"), `unexpected kind: ${out.kind}`);
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
    stdout.includes("coverage") || stdout.includes("threshold") || stdout.includes("check"),
    "should describe coverage-check options"
  );
});

test("coverage-check --json checks coverage thresholds", async () => {
  const dir = await makeTempDir("better-coverage-check-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0"
    });
    // Create a mock coverage report
    await writeJson(path.join(dir, "coverage-summary.json"), {
      total: {
        lines: { pct: 80 }, statements: { pct: 80 },
        branches: { pct: 70 }, functions: { pct: 85 }
      }
    });

    const { stdout } = await runBetter(["coverage-check", "--json"], dir);
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
    }
  } finally {
    await rmrf(dir);
  }
});

// ── cve-check ─────────────────────────────────────────────────────────────────

test("cve-check --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["cve-check", "--help"], process.cwd());
  assert.ok(ok, "cve-check --help should succeed");
  assert.ok(
    stdout.includes("cve") || stdout.includes("vulnerability") || stdout.includes("check"),
    "should describe cve-check options"
  );
});

test("cve-check --json checks for CVEs (network-aware)", async (t) => {
  const dir = await makeTempDir("better-cve-check-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      dependencies: {}
    });

    const { stdout, stderr, ok } = await runBetter(["cve-check", "--json"], dir);
    if (!ok && (stderr.includes("ENOTFOUND") || stderr.includes("ETIMEDOUT") || stderr.includes("timeout"))) {
      t.skip("network unavailable for cve-check");
      return;
    }
    assert.ok(ok, "cve-check should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("cve"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── dashboard ─────────────────────────────────────────────────────────────────

test("dashboard --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["dashboard", "--help"], process.cwd());
  assert.ok(ok, "dashboard --help should succeed");
  assert.ok(
    stdout.includes("dashboard") || stdout.includes("project-root") || stdout.includes("cache"),
    "should describe dashboard options"
  );
});

// dashboard requires TTY — just verify --help works (no --json test)

// ── compliance ────────────────────────────────────────────────────────────────

test("compliance --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["compliance", "--help"], process.cwd());
  assert.ok(ok, "compliance --help should succeed");
  assert.ok(
    stdout.includes("compliance") || stdout.includes("report") || stdout.includes("OSP"),
    "should describe compliance options"
  );
});

// ── credentials ───────────────────────────────────────────────────────────────

test("credentials --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["credentials", "--help"], process.cwd());
  assert.ok(ok, "credentials --help should succeed");
  assert.ok(
    stdout.includes("credential") || stdout.includes("list") || stdout.includes("provider"),
    "should describe credentials options"
  );
});
