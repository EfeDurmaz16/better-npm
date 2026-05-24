// test/bin-check-cleanup-diff.test.js
// Tests for: better bin-check, better cleanup, better diff-deps

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile, spawnSync } from "node:child_process";
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

function gitInit(dir) {
  spawnSync("git", ["init"], { cwd: dir, stdio: "pipe" });
  spawnSync("git", ["config", "user.email", "test@test.com"], { cwd: dir, stdio: "pipe" });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "pipe" });
}

function gitCommit(dir, msg) {
  spawnSync("git", ["add", "-A"], { cwd: dir, stdio: "pipe" });
  spawnSync("git", ["commit", "-m", msg, "--allow-empty", "--no-gpg-sign"], { cwd: dir, stdio: "pipe" });
}

// ── bin-check ────────────────────────────────────────────────────────────────

test("bin-check --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["bin-check", "--help"], process.cwd());
  assert.ok(ok, "bin-check --help should succeed");
  assert.ok(stdout.includes("bin") || stdout.includes("validate"), "should describe bin validation");
});

test("bin-check --json returns ok when no bin field", async () => {
  const dir = await makeTempDir("better-bincheck-nobin-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test-pkg",
      version: "1.0.0"
    });

    const { stdout, ok } = await runBetter(["bin-check", "--json"], dir);
    assert.ok(ok, "bin-check should succeed when no bin field");
    const out = JSON.parse(stdout);
    assert.equal(out.ok, true);
    assert.ok(out.kind?.includes("bin"), `unexpected kind: ${out.kind}`);
    assert.ok(Array.isArray(out.bins), "should have bins array");
    assert.equal(out.bins.length, 0, "should have zero bins when no bin field");
  } finally {
    await rmrf(dir);
  }
});

test("bin-check --json validates bin files that exist", async () => {
  const dir = await makeTempDir("better-bincheck-exists-");
  try {
    // Create the bin file
    const binDir = path.join(dir, "bin");
    await fs.mkdir(binDir, { recursive: true });
    await fs.writeFile(path.join(binDir, "my-cli.js"), "#!/usr/bin/env node\nconsole.log('hello');\n", "utf8");
    // Make it executable
    await fs.chmod(path.join(binDir, "my-cli.js"), 0o755);

    await writeJson(path.join(dir, "package.json"), {
      name: "my-pkg",
      version: "1.0.0",
      bin: { "my-cli": "./bin/my-cli.js" }
    });

    const { stdout, ok } = await runBetter(["bin-check", "--json"], dir);
    assert.ok(ok, "bin-check should succeed when bin file exists");
    const out = JSON.parse(stdout);
    assert.equal(out.ok, true);
    assert.equal(out.bins.length, 1, "should report 1 bin");
    assert.equal(out.bins[0].name, "my-cli");
    assert.equal(out.bins[0].ok, true);
  } finally {
    await rmrf(dir);
  }
});

test("bin-check --json fails when bin file is missing", async () => {
  const dir = await makeTempDir("better-bincheck-missing-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "my-pkg",
      version: "1.0.0",
      bin: { "my-cli": "./bin/my-cli.js" } // Does not exist
    });

    const { stdout, ok, exitCode } = await runBetter(["bin-check", "--json"], dir);
    assert.ok(!ok || exitCode !== 0, "bin-check should fail when bin file missing");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.equal(out.ok, false);
      const badBins = out.bins.filter(b => !b.ok);
      assert.ok(badBins.length > 0, "should report missing bin");
      assert.ok(
        badBins.some(b => b.name === "my-cli"),
        "should flag my-cli as missing"
      );
    }
  } finally {
    await rmrf(dir);
  }
});

test("bin-check --json handles string bin shorthand", async () => {
  const dir = await makeTempDir("better-bincheck-str-");
  try {
    const binDir = path.join(dir, "bin");
    await fs.mkdir(binDir, { recursive: true });
    await fs.writeFile(path.join(binDir, "cli.js"), "#!/usr/bin/env node\n", "utf8");
    await fs.chmod(path.join(binDir, "cli.js"), 0o755);

    await writeJson(path.join(dir, "package.json"), {
      name: "my-pkg",
      version: "1.0.0",
      bin: "./bin/cli.js" // String shorthand
    });

    const { stdout, ok } = await runBetter(["bin-check", "--json"], dir);
    assert.ok(ok, "bin-check should handle string bin shorthand");
    const out = JSON.parse(stdout);
    assert.ok(Array.isArray(out.bins), "should have bins array");
    assert.equal(out.bins.length, 1, "should have 1 bin for string shorthand");
  } finally {
    await rmrf(dir);
  }
});

// ── cleanup ──────────────────────────────────────────────────────────────────

test("cleanup --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["cleanup", "--help"], process.cwd());
  assert.ok(ok, "cleanup --help should succeed");
  assert.ok(
    stdout.includes("clean") || stdout.includes("dry-run") || stdout.includes("node_modules"),
    "should describe cleanup targets"
  );
});

test("cleanup --dry-run --json reports removable targets", async () => {
  const dir = await makeTempDir("better-cleanup-dry-");
  try {
    await writeJson(path.join(dir, "package.json"), { name: "test", version: "1.0.0" });
    // Create some targets cleanup would remove
    await fs.mkdir(path.join(dir, "dist"), { recursive: true });
    await fs.writeFile(path.join(dir, "dist", "bundle.js"), "/* bundle */");
    await fs.mkdir(path.join(dir, "coverage"), { recursive: true });
    await fs.writeFile(path.join(dir, "coverage", "lcov.info"), "SF:test.js\n");

    const { stdout, ok } = await runBetter(["cleanup", "--dry-run", "--json"], dir);
    assert.ok(ok, "cleanup --dry-run should succeed");
    const out = JSON.parse(stdout);
    assert.equal(out.ok, true);
    assert.ok(out.kind?.includes("cleanup"), `unexpected kind: ${out.kind}`);
    assert.equal(out.dryRun ?? out.dry_run, true, "should report dryRun: true");

    // Dry run should NOT delete files
    await fs.access(path.join(dir, "dist"), fs.constants.F_OK);
    await fs.access(path.join(dir, "coverage"), fs.constants.F_OK);
  } finally {
    await rmrf(dir);
  }
});

test("cleanup --build-only --dry-run --json only targets build artifacts", async () => {
  const dir = await makeTempDir("better-cleanup-build-");
  try {
    await writeJson(path.join(dir, "package.json"), { name: "test", version: "1.0.0" });
    await fs.mkdir(path.join(dir, "dist"), { recursive: true });
    await fs.mkdir(path.join(dir, "coverage"), { recursive: true });

    const { stdout, ok } = await runBetter(["cleanup", "--build-only", "--dry-run", "--json"], dir);
    assert.ok(ok, "cleanup --build-only should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.equal(out.ok, true);
      const targets = out.targets ?? out.removed ?? [];
      // Should NOT include test coverage (category: test)
      const hasCoverage = targets.some(t => String(t.path ?? t.label ?? t).includes("coverage"));
      assert.ok(!hasCoverage, "--build-only should not include coverage dir");
    }
  } finally {
    await rmrf(dir);
  }
});

test("cleanup --json actually removes build artifacts when not dry-run", async () => {
  const dir = await makeTempDir("better-cleanup-real-");
  try {
    await writeJson(path.join(dir, "package.json"), { name: "test", version: "1.0.0" });
    await fs.mkdir(path.join(dir, "dist"), { recursive: true });
    await fs.writeFile(path.join(dir, "dist", "app.js"), "compiled");

    const { ok } = await runBetter(["cleanup", "--keep-modules", "--json"], dir);
    assert.ok(ok, "cleanup should succeed");

    // dist should now be gone
    let exists = false;
    try { await fs.access(path.join(dir, "dist")); exists = true; } catch {}
    assert.ok(!exists, "dist should be removed after cleanup");
  } finally {
    await rmrf(dir);
  }
});

// ── diff-deps ────────────────────────────────────────────────────────────────

test("diff-deps --help shows usage", async () => {
  // diff-deps --help with no positionals exits 1 (by design)
  const { stdout } = await runBetter(["diff-deps", "--help"], process.cwd());
  assert.ok(
    stdout.includes("diff") || stdout.includes("ref") || stdout.includes("deps"),
    "should describe dep diff usage"
  );
});

test("diff-deps --json shows added/removed deps between git refs", async () => {
  const dir = await makeTempDir("better-diffdeps-");
  try {
    gitInit(dir);

    // v1: only lodash
    await writeJson(path.join(dir, "package.json"), {
      name: "test",
      version: "1.0.0",
      dependencies: { lodash: "^4.17.0" }
    });
    gitCommit(dir, "v1");

    // v2: add axios, remove nothing, bump lodash
    await writeJson(path.join(dir, "package.json"), {
      name: "test",
      version: "1.1.0",
      dependencies: {
        lodash: "^4.17.21",
        axios: "^1.4.0"
      }
    });
    gitCommit(dir, "v2");

    const { stdout, ok } = await runBetter(["diff-deps", "HEAD~1", "HEAD", "--json"], dir);
    assert.ok(ok, "diff-deps should succeed with two git refs");
    const out = JSON.parse(stdout);
    assert.equal(out.ok, true);
    assert.ok(out.kind?.includes("diff-deps"), `unexpected kind: ${out.kind}`);

    // Added: axios
    const added = out.added ?? [];
    assert.ok(
      added.some(a => a.name === "axios" || a === "axios"),
      "should report axios as added"
    );

    // Changed: lodash version bump
    const changed = out.changed ?? out.updated ?? [];
    assert.ok(
      changed.some(c => c.name === "lodash" || c === "lodash"),
      "should report lodash as changed"
    );
  } finally {
    await rmrf(dir);
  }
});

test("diff-deps --json shows removed packages", async () => {
  const dir = await makeTempDir("better-diffdeps-remove-");
  try {
    gitInit(dir);

    await writeJson(path.join(dir, "package.json"), {
      name: "test",
      version: "1.0.0",
      dependencies: { lodash: "^4.17.0", moment: "^2.29.0" }
    });
    gitCommit(dir, "with moment");

    await writeJson(path.join(dir, "package.json"), {
      name: "test",
      version: "1.0.0",
      dependencies: { lodash: "^4.17.0" } // moment removed
    });
    gitCommit(dir, "remove moment");

    const { stdout, ok } = await runBetter(["diff-deps", "HEAD~1", "--json"], dir);
    assert.ok(ok, "diff-deps should succeed");
    const out = JSON.parse(stdout);
    assert.equal(out.ok, true);

    const removed = out.removed ?? [];
    assert.ok(
      removed.some(r => r.name === "moment" || r === "moment"),
      "should report moment as removed"
    );
  } finally {
    await rmrf(dir);
  }
});

test("diff-deps fails gracefully when ref does not exist", async () => {
  const dir = await makeTempDir("better-diffdeps-badref-");
  try {
    gitInit(dir);
    await writeJson(path.join(dir, "package.json"), { name: "test", version: "1.0.0" });
    gitCommit(dir, "initial");

    const { stdout, ok, exitCode } = await runBetter(["diff-deps", "nonexistent-ref", "--json"], dir);
    assert.ok(!ok || exitCode !== 0, "diff-deps with bad ref should fail");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.equal(out.ok, false);
    }
  } finally {
    await rmrf(dir);
  }
});
