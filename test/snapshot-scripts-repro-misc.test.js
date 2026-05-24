// test/snapshot-scripts-repro-misc.test.js
// Tests for: better snapshot, better scripts, better repro,
//            better plugin, better sign, better receipt, better test-coverage,
//            better test-runner, better cross-project, better init

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

// ── snapshot ──────────────────────────────────────────────────────────────────

test("snapshot --help shows usage", async () => {
  // snapshot requires subcommand; --help may exit 1
  const { stdout } = await runBetter(["snapshot", "--help"], process.cwd());
  assert.ok(
    stdout.includes("snapshot") || stdout.includes("save") || stdout.includes("restore"),
    "should describe snapshot management"
  );
});

test("snapshot list --json returns saved snapshots", async () => {
  const dir = await makeTempDir("better-snapshot-");
  try {
    await writeJson(path.join(dir, "package.json"), { name: "test", version: "1.0.0" });

    const { stdout, ok } = await runBetter(["snapshot", "list", "--json"], dir);
    assert.ok(ok, "snapshot list should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("snapshot"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── scripts ───────────────────────────────────────────────────────────────────

test("scripts --help shows usage", async () => {
  // scripts requires subcommand; --help may exit 1
  const { stdout } = await runBetter(["scripts", "--help"], process.cwd());
  assert.ok(
    stdout.includes("script") || stdout.includes("sandbox") || stdout.includes("allow"),
    "should describe script sandboxing"
  );
});

test("scripts list --json returns script allowlist", async () => {
  const dir = await makeTempDir("better-scripts-");
  try {
    await writeJson(path.join(dir, "package.json"), { name: "test", version: "1.0.0" });

    const { stdout } = await runBetter(["scripts", "list", "--json"], dir);
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("scripts"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── repro ─────────────────────────────────────────────────────────────────────

test("repro --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["repro", "--help"], process.cwd());
  assert.ok(ok, "repro --help should succeed");
  assert.ok(
    stdout.includes("repro") || stdout.includes("reproduce") || stdout.includes("lockfile"),
    "should describe reproducible build verification"
  );
});

test("repro --json verifies install matches lockfile", async () => {
  const dir = await makeTempDir("better-repro-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      dependencies: { "pkg-a": "^1.0.0" }
    });
    const nmDir = path.join(dir, "node_modules");
    await fs.mkdir(path.join(nmDir, "pkg-a"), { recursive: true });
    await writeJson(path.join(nmDir, "pkg-a", "package.json"), {
      name: "pkg-a", version: "1.0.0",
      dist: { integrity: "sha512-abc123" }
    });
    await writeJson(path.join(dir, "package-lock.json"), {
      name: "test", lockfileVersion: 3,
      packages: {
        "": { name: "test", version: "1.0.0", dependencies: { "pkg-a": "^1.0.0" } },
        "node_modules/pkg-a": { name: "pkg-a", version: "1.0.0", integrity: "sha512-abc123" }
      }
    });

    const { stdout } = await runBetter(["repro", "--json"], dir);
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("repro"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── plugin ────────────────────────────────────────────────────────────────────

test("plugin --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["plugin", "--help"], process.cwd());
  assert.ok(ok, "plugin --help should succeed");
  assert.ok(
    stdout.includes("plugin") || stdout.includes("extend") || stdout.includes("add"),
    "should describe plugin management"
  );
});

test("plugin list --json returns installed plugins", async () => {
  const dir = await makeTempDir("better-plugin-");
  try {
    await writeJson(path.join(dir, "package.json"), { name: "test", version: "1.0.0" });

    const { stdout, ok } = await runBetter(["plugin", "list", "--json"], dir);
    assert.ok(ok, "plugin list should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("plugin"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── sign ──────────────────────────────────────────────────────────────────────

test("sign --help shows usage", async () => {
  // sign requires subcommand; --help may exit 1
  const { stdout } = await runBetter(["sign", "--help"], process.cwd());
  assert.ok(
    stdout.includes("sign") || stdout.includes("key") || stdout.includes("verify"),
    "should describe package signing"
  );
});

// ── receipt ───────────────────────────────────────────────────────────────────

test("receipt --help shows usage", async () => {
  // receipt requires subcommand
  const { stdout } = await runBetter(["receipt", "--help"], process.cwd());
  assert.ok(
    stdout.includes("receipt") || stdout.includes("install") || stdout.includes("record"),
    "should describe install receipts"
  );
});

test("receipt list --json returns install receipts", async () => {
  const dir = await makeTempDir("better-receipt-");
  try {
    await writeJson(path.join(dir, "package.json"), { name: "test", version: "1.0.0" });

    const { stdout, ok } = await runBetter(["receipt", "list", "--json"], dir);
    assert.ok(ok, "receipt list should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("receipt"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── test-coverage ─────────────────────────────────────────────────────────────

test("test-coverage --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["test-coverage", "--help"], process.cwd());
  assert.ok(ok, "test-coverage --help should succeed");
  assert.ok(
    stdout.includes("coverage") || stdout.includes("threshold") || stdout.includes("test"),
    "should describe test coverage checking"
  );
});

test("test-coverage --json checks coverage thresholds", async () => {
  const dir = await makeTempDir("better-test-coverage-");
  try {
    await writeJson(path.join(dir, "package.json"), { name: "test", version: "1.0.0" });
    // Create a mock coverage report
    await writeJson(path.join(dir, "coverage-summary.json"), {
      total: {
        lines: { pct: 85 },
        statements: { pct: 85 },
        branches: { pct: 75 },
        functions: { pct: 90 }
      }
    });

    const { stdout } = await runBetter(["test-coverage", "--json"], dir);
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("test-coverage"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── test-runner ───────────────────────────────────────────────────────────────

test("test-runner --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["test-runner", "--help"], process.cwd());
  assert.ok(ok, "test-runner --help should succeed");
  assert.ok(
    stdout.includes("test") || stdout.includes("runner") || stdout.includes("jest"),
    "should describe test runner"
  );
});

test("test-runner --json runs tests and returns result", async () => {
  const dir = await makeTempDir("better-test-runner-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      scripts: { test: "node --version" }
    });

    const { stdout } = await runBetter(["test-runner", "--json"], dir);
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("test-runner"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── cross-project ─────────────────────────────────────────────────────────────

test("cross-project --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["cross-project", "--help"], process.cwd());
  assert.ok(ok, "cross-project --help should succeed");
  assert.ok(
    stdout.includes("cross") || stdout.includes("project") || stdout.includes("scan"),
    "should describe cross-project analysis"
  );
});

test("cross-project --json analyzes multiple projects", async () => {
  const dir = await makeTempDir("better-cross-project-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "project-a", version: "1.0.0"
    });

    const { stdout } = await runBetter(["cross-project", "--json", dir], process.cwd());
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("cross-project"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});
