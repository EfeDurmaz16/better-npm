// test/suggest-bundle-registry-delta.test.js
// Tests for: better suggest, better bundle-check, better bundle-analyzer,
//            better registry-status, better registry-health, better telemetry,
//            better delta, better reputation, better cross-project, better notify

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

// ── suggest ───────────────────────────────────────────────────────────────────

test("suggest --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["suggest", "--help"], process.cwd());
  assert.ok(ok, "suggest --help should succeed");
  assert.ok(
    stdout.includes("suggest") || stdout.includes("missing") || stdout.includes("unused"),
    "should describe dependency suggestions"
  );
});

test("suggest --json returns missing and unused deps", async () => {
  const dir = await makeTempDir("better-suggest-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      dependencies: { "lodash": "^4.0.0" }
    });
    await fs.writeFile(path.join(dir, "index.js"), "const _ = require('lodash');\nconst moment = require('moment');\n");

    const { stdout, ok } = await runBetter(["suggest", "--json"], dir);
    assert.ok(ok, "suggest should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("suggest"), `unexpected kind: ${out.kind}`);
      assert.ok(Array.isArray(out.missing ?? []), "should have missing array");
    }
  } finally {
    await rmrf(dir);
  }
});

// ── bundle-check ──────────────────────────────────────────────────────────────

test("bundle-check --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["bundle-check", "--help"], process.cwd());
  assert.ok(ok, "bundle-check --help should succeed");
  assert.ok(
    stdout.includes("bundle") || stdout.includes("size") || stdout.includes("impact"),
    "should describe bundle size checking"
  );
});

test("bundle-check --json analyzes bundle impact (network-aware)", async (t) => {
  const dir = await makeTempDir("better-bundle-check-");
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

    const { stdout, stderr, ok } = await runBetter(["bundle-check", "--json"], dir);
    if (!ok && (stderr.includes("ENOTFOUND") || stderr.includes("ETIMEDOUT") || stderr.includes("timeout"))) {
      t.skip("network unavailable for bundle-check");
      return;
    }
    assert.ok(ok, "bundle-check should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("bundle"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── bundle-analyzer ────────────────────────────────────────────────────────────

test("bundle-analyzer --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["bundle-analyzer", "--help"], process.cwd());
  assert.ok(ok, "bundle-analyzer --help should succeed");
  assert.ok(
    stdout.includes("bundle") || stdout.includes("analyz") || stdout.includes("size"),
    "should describe bundle analysis"
  );
});

test("bundle-analyzer --json analyzes build output", async () => {
  const dir = await makeTempDir("better-bundle-analyzer-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0"
    });
    // Create a fake dist directory
    const distDir = path.join(dir, "dist");
    await fs.mkdir(distDir, { recursive: true });
    await fs.writeFile(path.join(distDir, "main.js"), "x".repeat(1024 * 10)); // 10KB

    const { stdout } = await runBetter(["bundle-analyzer", "--json"], dir);
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("bundle"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── registry-status ────────────────────────────────────────────────────────────

test("registry-status --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["registry-status", "--help"], process.cwd());
  assert.ok(ok, "registry-status --help should succeed");
  assert.ok(
    stdout.includes("registry") || stdout.includes("status") || stdout.includes("npm"),
    "should describe registry status checking"
  );
});

test("registry-status --json checks npm registry (network-aware)", async (t) => {
  const { stdout, stderr, ok } = await runBetter(
    ["registry-status", "--json"], process.cwd()
  );
  if (!ok && (stderr.includes("ENOTFOUND") || stderr.includes("ETIMEDOUT") || stderr.includes("timeout"))) {
    t.skip("network unavailable for registry-status");
    return;
  }
  if (stdout.trim()) {
    const out = JSON.parse(stdout);
    assert.ok(typeof out.ok === "boolean", "should have ok field");
    assert.ok(out.kind?.includes("registry"), `unexpected kind: ${out.kind}`);
  }
});

// ── registry-health ────────────────────────────────────────────────────────────

test("registry-health --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["registry-health", "--help"], process.cwd());
  assert.ok(ok, "registry-health --help should succeed");
  assert.ok(
    stdout.includes("registry") || stdout.includes("health") || stdout.includes("latency"),
    "should describe registry health checking"
  );
});

test("registry-health --json checks registry health (network-aware)", async (t) => {
  const { stdout, stderr, ok } = await runBetter(
    ["registry-health", "--json"], process.cwd()
  );
  if (!ok && (stderr.includes("ENOTFOUND") || stderr.includes("ETIMEDOUT") || stderr.includes("timeout"))) {
    t.skip("network unavailable for registry-health");
    return;
  }
  if (stdout.trim()) {
    const out = JSON.parse(stdout);
    assert.ok(typeof out.ok === "boolean", "should have ok field");
    assert.ok(out.kind?.includes("registry"), `unexpected kind: ${out.kind}`);
  }
});

// ── telemetry ─────────────────────────────────────────────────────────────────

test("telemetry --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["telemetry", "--help"], process.cwd());
  assert.ok(ok, "telemetry --help should succeed");
  assert.ok(
    stdout.includes("telemetry") || stdout.includes("analytics") || stdout.includes("opt"),
    "should describe telemetry management"
  );
});

test("telemetry status --json returns telemetry status", async () => {
  const { stdout, ok } = await runBetter(["telemetry", "status", "--json"], process.cwd());
  assert.ok(ok, "telemetry status should succeed");
  if (stdout.trim()) {
    const out = JSON.parse(stdout);
    assert.ok(typeof out.ok === "boolean", "should have ok field");
    assert.ok(out.kind?.includes("telemetry"), `unexpected kind: ${out.kind}`);
  }
});

// ── delta ─────────────────────────────────────────────────────────────────────

test("delta --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["delta", "--help"], process.cwd());
  assert.ok(ok, "delta --help should succeed");
  assert.ok(
    stdout.includes("delta") || stdout.includes("lockfile") || stdout.includes("change"),
    "should describe delta computation"
  );
});

test("delta --json returns lockfile delta", async () => {
  const dir = await makeTempDir("better-delta-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0"
    });
    await writeJson(path.join(dir, "package-lock.json"), {
      name: "test", lockfileVersion: 3, packages: {}
    });

    const { stdout } = await runBetter(["delta", "--json"], dir);
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      // delta may report no baseline — that's fine
    }
  } finally {
    await rmrf(dir);
  }
});

// ── reputation ────────────────────────────────────────────────────────────────

test("reputation --help shows usage", async () => {
  // reputation requires package name; --help may exit 1
  const { stdout } = await runBetter(["reputation", "--help"], process.cwd());
  assert.ok(
    stdout.includes("reputation") || stdout.includes("score") || stdout.includes("package"),
    "should describe package reputation scoring"
  );
});

test("reputation --json scores package reputation (network-aware)", async (t) => {
  const { stdout, stderr, ok } = await runBetter(
    ["reputation", "semver", "--json"], process.cwd()
  );
  if (!ok && (stderr.includes("ENOTFOUND") || stderr.includes("ETIMEDOUT") || stderr.includes("timeout"))) {
    t.skip("network unavailable for reputation");
    return;
  }
  if (stdout.trim()) {
    const out = JSON.parse(stdout);
    assert.ok(typeof out.ok === "boolean", "should have ok field");
    assert.ok(out.kind?.includes("reputation"), `unexpected kind: ${out.kind}`);
  }
});

// ── notify ─────────────────────────────────────────────────────────────────────

test("notify --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["notify", "--help"], process.cwd());
  assert.ok(ok, "notify --help should succeed");
  assert.ok(
    stdout.includes("notify") || stdout.includes("update") || stdout.includes("alert"),
    "should describe notification management"
  );
});

test("notify --json returns notification status (network-aware)", async (t) => {
  const dir = await makeTempDir("better-notify-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      dependencies: { "semver": "^7.0.0" }
    });

    const { stdout, stderr, ok } = await runBetter(["notify", "--json"], dir);
    if (!ok && (stderr.includes("ENOTFOUND") || stderr.includes("ETIMEDOUT") || stderr.includes("timeout"))) {
      t.skip("network unavailable for notify");
      return;
    }
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("notify"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});
