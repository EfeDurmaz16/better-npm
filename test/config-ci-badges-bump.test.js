// test/config-ci-badges-bump.test.js
// Tests for: better config, better changelog-gen, better ci,
//            better ci-config-gen, better badges, better bump, better completions

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

// ── config ────────────────────────────────────────────────────────────────────

test("config --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["config", "--help"], process.cwd());
  assert.ok(ok, "config --help should succeed");
  assert.ok(
    stdout.includes("config") || stdout.includes("get") || stdout.includes("set"),
    "should describe config management"
  );
});

test("config list --json returns current config", async () => {
  const dir = await makeTempDir("better-config-");
  try {
    await writeJson(path.join(dir, "package.json"), { name: "test", version: "1.0.0" });

    const { stdout, ok } = await runBetter(["config", "list", "--json"], dir);
    assert.ok(ok, "config list should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("config"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

test("config get --json returns config value", async () => {
  const dir = await makeTempDir("better-config-get-");
  try {
    await writeJson(path.join(dir, "package.json"), { name: "test", version: "1.0.0" });

    const { stdout } = await runBetter(["config", "get", "json", "--json"], dir);
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("config"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── changelog-gen ─────────────────────────────────────────────────────────────

test("changelog-gen --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["changelog-gen", "--help"], process.cwd());
  assert.ok(ok, "changelog-gen --help should succeed");
  assert.ok(
    stdout.includes("changelog") || stdout.includes("generat") || stdout.includes("commit"),
    "should describe changelog generation"
  );
});

test("changelog-gen --dry-run --json generates changelog", async () => {
  const dir = await makeTempDir("better-changelog-gen-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0"
    });
    // Initialize a git repo so git log works
    const { execSync } = await import("node:child_process");
    execSync("git init", { cwd: dir, stdio: "ignore" });
    execSync("git config user.email test@test.com", { cwd: dir, stdio: "ignore" });
    execSync("git config user.name Test", { cwd: dir, stdio: "ignore" });
    execSync("git add .", { cwd: dir, stdio: "ignore" });
    execSync("git commit --no-gpg-sign -m 'feat: initial commit'", { cwd: dir, stdio: "ignore" });

    const { stdout, ok } = await runBetter(["changelog-gen", "--dry-run", "--json"], dir);
    assert.ok(ok, "changelog-gen should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("changelog"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── ci ────────────────────────────────────────────────────────────────────────

test("ci --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["ci", "--help"], process.cwd());
  assert.ok(ok, "ci --help should succeed");
  assert.ok(
    stdout.includes("ci") || stdout.includes("pipeline") || stdout.includes("run"),
    "should describe CI pipeline running"
  );
});

test("ci --json runs CI pipeline", async () => {
  const dir = await makeTempDir("better-ci-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      scripts: { test: "node --version" }
    });

    const { stdout } = await runBetter(["ci", "--json"], dir);
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("ci"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── ci-config-gen ──────────────────────────────────────────────────────────────

test("ci-config-gen --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["ci-config-gen", "--help"], process.cwd());
  assert.ok(ok, "ci-config-gen --help should succeed");
  assert.ok(
    stdout.includes("ci") || stdout.includes("config") || stdout.includes("generat"),
    "should describe CI config generation"
  );
});

test("ci-config-gen --dry-run --json generates GitHub Actions config", async () => {
  const dir = await makeTempDir("better-ci-config-gen-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      scripts: { test: "node --version", build: "echo build" }
    });

    const { stdout, ok } = await runBetter(
      ["ci-config-gen", "--platform", "github", "--dry-run", "--json"], dir
    );
    assert.ok(ok, "ci-config-gen should succeed in dry-run");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("ci-config-gen"), `unexpected kind: ${out.kind}`);
      assert.ok(out.dryRun === true, "should report dry run");
    }
  } finally {
    await rmrf(dir);
  }
});

// ── badges ────────────────────────────────────────────────────────────────────

test("badges --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["badges", "--help"], process.cwd());
  assert.ok(ok, "badges --help should succeed");
  assert.ok(
    stdout.includes("badge") || stdout.includes("shield") || stdout.includes("markdown"),
    "should describe badge generation"
  );
});

test("badges --json generates badges for package", async () => {
  const dir = await makeTempDir("better-badges-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "my-package",
      version: "1.0.0",
      license: "MIT",
      description: "A test package"
    });

    const { stdout, ok } = await runBetter(["badges", "--json"], dir);
    assert.ok(ok, "badges should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("badges"), `unexpected kind: ${out.kind}`);
      assert.ok(Array.isArray(out.badges), "should have badges array");
    }
  } finally {
    await rmrf(dir);
  }
});

// ── bump ──────────────────────────────────────────────────────────────────────

test("bump --help shows usage", async () => {
  // bump --help exits 1 without type arg
  const { stdout } = await runBetter(["bump", "--help"], process.cwd());
  assert.ok(
    stdout.includes("bump") || stdout.includes("version") || stdout.includes("semver"),
    "should describe version bumping"
  );
});

test("bump patch --dry-run --json returns version info", async () => {
  const dir = await makeTempDir("better-bump-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0"
    });

    const { stdout, ok } = await runBetter(["bump", "patch", "--dry-run", "--json"], dir);
    assert.ok(ok, "bump should succeed in dry-run");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("bump"), `unexpected kind: ${out.kind}`);
      assert.equal(out.from, "1.0.0", "should report current version");
      assert.equal(out.to, "1.0.1", "should report new patch version");
      assert.equal(out.dry_run, true, "should report dry run");
    }
  } finally {
    await rmrf(dir);
  }
});

// ── completions ───────────────────────────────────────────────────────────────

test("completions --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["completions", "--help"], process.cwd());
  assert.ok(ok, "completions --help should succeed");
  assert.ok(
    stdout.includes("completion") || stdout.includes("shell") || stdout.includes("bash"),
    "should describe shell completions"
  );
});

test("completions bash outputs shell completion script", async () => {
  const { stdout, ok } = await runBetter(["completions", "bash"], process.cwd());
  assert.ok(ok, "completions bash should succeed");
  assert.ok(
    stdout.includes("complete") || stdout.includes("better") || stdout.length > 0,
    "should output completion script"
  );
});
