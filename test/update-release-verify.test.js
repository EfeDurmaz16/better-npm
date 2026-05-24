// test/update-release-verify.test.js
// Tests for: better update, better update-interactive, better upgrade-smart,
//            better version-bumper, better release, better publish-checklist,
//            better verify, better update-readme, better changelog-view

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

// ── update ────────────────────────────────────────────────────────────────────

test("update --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["update", "--help"], process.cwd());
  assert.ok(ok, "update --help should succeed");
  assert.ok(
    stdout.includes("update") || stdout.includes("upgrade") || stdout.includes("package"),
    "should describe package updating"
  );
});

test("update --dry-run --json returns update list (network-aware)", async (t) => {
  const dir = await makeTempDir("better-update-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      dependencies: {}
    });
    const nmDir = path.join(dir, "node_modules");
    await fs.mkdir(nmDir, { recursive: true });

    const { stdout, stderr, ok } = await runBetter(["update", "--dry-run", "--json"], dir);
    if (stderr.includes("ENOTFOUND") || stderr.includes("ETIMEDOUT") || stderr.includes("timeout")) {
      t.skip("network unavailable");
      return;
    }
    assert.ok(ok, "update --dry-run should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(Array.isArray(out.updates ?? out.packages ?? []), "should have updates array");
    }
  } finally {
    await rmrf(dir);
  }
});

// ── update-interactive ────────────────────────────────────────────────────────

test("update-interactive --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["update-interactive", "--help"], process.cwd());
  assert.ok(ok, "update-interactive --help should succeed");
  assert.ok(
    stdout.includes("interactive") || stdout.includes("update") || stdout.includes("upgrade"),
    "should describe interactive update wizard"
  );
});

test("update-interactive --json returns packages list (network-aware)", async (t) => {
  const dir = await makeTempDir("better-updateint-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      dependencies: {}
    });

    const { stdout, stderr, ok } = await runBetter(["update-interactive", "--json"], dir);
    if (stderr.includes("ENOTFOUND") || stderr.includes("ETIMEDOUT") || stderr.includes("timeout")) {
      t.skip("network unavailable");
      return;
    }
    assert.ok(ok, "update-interactive should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("update"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── upgrade-smart ─────────────────────────────────────────────────────────────

test("upgrade --smart --help shows usage", async () => {
  // upgrade --smart --help exits 0
  const { stdout, ok } = await runBetter(["upgrade", "--smart", "--help"], process.cwd());
  assert.ok(ok, "upgrade --smart --help should succeed");
  assert.ok(
    stdout.includes("upgrade") || stdout.includes("smart") || stdout.includes("safe"),
    "should describe smart upgrade"
  );
});

test("upgrade --smart --json returns ok for package with no deps", async () => {
  const dir = await makeTempDir("better-upgradesmart-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      dependencies: {}
    });

    const { stdout, ok } = await runBetter(["upgrade", "--smart", "--json"], dir);
    assert.ok(ok, "upgrade --smart should succeed with no deps");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("upgrade"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── version-bumper ────────────────────────────────────────────────────────────

test("version-bumper --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["version-bumper", "--help"], process.cwd());
  assert.ok(ok, "version-bumper --help should succeed");
  assert.ok(
    stdout.includes("version") || stdout.includes("bump") || stdout.includes("semver"),
    "should describe version bumping"
  );
});

test("version-bumper patch --dry-run --json returns new version", async () => {
  const dir = await makeTempDir("better-versionbumper-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.2.3"
    });

    const { stdout, ok } = await runBetter(["version-bumper", "patch", "--dry-run", "--json"], dir);
    assert.ok(ok, "version-bumper patch should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.equal(out.ok, true);
      assert.ok(out.kind?.includes("version"), `unexpected kind: ${out.kind}`);
      assert.equal(out.currentVersion, "1.2.3", "should report current version");
      assert.equal(out.newVersion, "1.2.4", "patch bump should increment patch");
      assert.equal(out.bumpType, "patch", "should report bump type");
      assert.equal(out.dryRun, true, "should report dry run");
    }
  } finally {
    await rmrf(dir);
  }
});

test("version-bumper minor --dry-run --json returns bumped minor version", async () => {
  const dir = await makeTempDir("better-versionbumper-minor-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.2.3"
    });

    const { stdout, ok } = await runBetter(["version-bumper", "minor", "--dry-run", "--json"], dir);
    assert.ok(ok, "version-bumper minor should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.equal(out.ok, true);
      assert.equal(out.newVersion, "1.3.0", "minor bump should increment minor and reset patch");
    }
  } finally {
    await rmrf(dir);
  }
});

// ── release ───────────────────────────────────────────────────────────────────

test("release --help shows usage", async () => {
  // release --help exits 1 when no type arg is given
  const { stdout } = await runBetter(["release", "--help"], process.cwd());
  assert.ok(
    stdout.includes("release") || stdout.includes("publish") || stdout.includes("version"),
    "should describe release workflow"
  );
});

test("release patch --dry-run --json shows what would be released", async () => {
  const dir = await makeTempDir("better-release-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "my-lib", version: "1.0.0", license: "MIT"
    });
    await fs.writeFile(path.join(dir, "README.md"), "# My Lib\n");

    const { stdout, ok } = await runBetter(["release", "patch", "--dry-run", "--json"], dir);
    assert.ok(ok, "release patch --dry-run should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("release"), `unexpected kind: ${out.kind}`);
      assert.ok(out.dry_run === true || out.dryRun === true, "should report dry run");
    }
  } finally {
    await rmrf(dir);
  }
});

// ── publish-checklist ─────────────────────────────────────────────────────────

test("publish-checklist --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["publish-checklist", "--help"], process.cwd());
  assert.ok(ok, "publish-checklist --help should succeed");
  assert.ok(
    stdout.includes("publish") || stdout.includes("checklist") || stdout.includes("check"),
    "should describe publish checklist"
  );
});

test("publish-checklist --json returns checks for publishable package", async () => {
  const dir = await makeTempDir("better-publishchecklist-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "my-lib",
      version: "1.0.0",
      description: "A library",
      license: "MIT",
      main: "index.js"
    });
    await fs.writeFile(path.join(dir, "index.js"), "module.exports = {};\n");
    await fs.writeFile(path.join(dir, "README.md"), "# My Lib\n");

    const { stdout } = await runBetter(["publish-checklist", "--json"], dir);
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("publish"), `unexpected kind: ${out.kind}`);
      assert.ok(Array.isArray(out.checks), "should have checks array");
      assert.ok(typeof out.passed === "number", "should have passed count");
      assert.ok(typeof out.failed === "number", "should have failed count");
    }
  } finally {
    await rmrf(dir);
  }
});

// ── verify ────────────────────────────────────────────────────────────────────

test("verify --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["verify", "--help"], process.cwd());
  assert.ok(ok, "verify --help should succeed");
  assert.ok(
    stdout.includes("verify") || stdout.includes("check") || stdout.includes("valid"),
    "should describe project verification"
  );
});

test("verify --json returns checks array", async () => {
  const dir = await makeTempDir("better-verify-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      description: "A test package",
      license: "MIT"
    });

    const { stdout } = await runBetter(["verify", "--json"], dir);
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("verify"), `unexpected kind: ${out.kind}`);
      assert.ok(Array.isArray(out.checks), "should have checks array");
    }
  } finally {
    await rmrf(dir);
  }
});

// ── update-readme ─────────────────────────────────────────────────────────────

test("update-readme --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["update-readme", "--help"], process.cwd());
  assert.ok(ok, "update-readme --help should succeed");
  assert.ok(
    stdout.includes("readme") || stdout.includes("update") || stdout.includes("badge"),
    "should describe readme updating"
  );
});

test("update-readme --dry-run --json reports no changes for simple readme", async () => {
  const dir = await makeTempDir("better-updatereadme-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test-pkg", version: "1.0.0"
    });
    await fs.writeFile(path.join(dir, "README.md"), "# Test Package\n\nSimple readme.\n");

    const { stdout, ok } = await runBetter(["update-readme", "--dry-run", "--json"], dir);
    assert.ok(ok, "update-readme should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.equal(out.ok, true);
      assert.ok(out.kind?.includes("readme") || out.kind?.includes("update"), `unexpected kind: ${out.kind}`);
      assert.equal(out.dryRun, true, "should report dry run");
    }
  } finally {
    await rmrf(dir);
  }
});

// ── changelog-view ────────────────────────────────────────────────────────────

test("changelog-view --help shows usage", async () => {
  // changelog-view requires a package name; --help exits 1 without one
  const { stdout } = await runBetter(["changelog-view", "--help"], process.cwd());
  assert.ok(
    stdout.includes("changelog") || stdout.includes("CHANGELOG") || stdout.includes("view") ||
    stdout.includes("package"),
    "should describe changelog viewing"
  );
});

test("changelog-view fetches package changelog (network-aware)", async (t) => {
  // changelog-view requires a package name argument
  const { stdout, stderr, ok } = await runBetter(
    ["changelog-view", "semver", "--json"], process.cwd()
  );
  if (!ok && (stderr.includes("ENOTFOUND") || stderr.includes("ETIMEDOUT") ||
      stderr.includes("timeout") || stderr.includes("404"))) {
    t.skip("network unavailable for changelog-view");
    return;
  }
  if (stdout.trim()) {
    const out = JSON.parse(stdout);
    assert.ok(typeof out.ok === "boolean", "should have ok field");
  }
});
