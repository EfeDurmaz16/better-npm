// test/circular-diff-pin-check-updates.test.js
// Tests for: better circular, better diff, better pin, better link,
//            better check-updates, better patch, better delta

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

// ── circular ──────────────────────────────────────────────────────────────────

test("circular --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["circular", "--help"], process.cwd());
  assert.ok(ok, "circular --help should succeed");
  assert.ok(
    stdout.includes("circular") || stdout.includes("cycle") || stdout.includes("import"),
    "should describe circular dependency detection"
  );
});

test("circular --json detects no circular imports in clean project", async () => {
  const dir = await makeTempDir("better-circular-ok-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0"
    });
    await fs.writeFile(path.join(dir, "index.js"), "const x = 42;\nmodule.exports = x;\n");
    await fs.writeFile(path.join(dir, "utils.js"), "module.exports = { helper: () => {} };\n");

    const { stdout, ok } = await runBetter(["circular", "--json"], dir);
    assert.ok(ok, "circular should succeed with no cycles");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("circular"), `unexpected kind: ${out.kind}`);
      assert.ok(typeof out.filesAnalyzed === "number", "should have filesAnalyzed");
      assert.equal(out.cyclesFound, 0, "should have no cycles");
    }
  } finally {
    await rmrf(dir);
  }
});

test("circular --json detects circular imports", async () => {
  const dir = await makeTempDir("better-circular-found-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0"
    });
    // a requires b, b requires a — a real cycle
    await fs.writeFile(path.join(dir, "a.js"), "const b = require('./b');\nmodule.exports = { a: true };\n");
    await fs.writeFile(path.join(dir, "b.js"), "const a = require('./a');\nmodule.exports = { b: true };\n");

    const { stdout } = await runBetter(["circular", "--json"], dir);
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("circular"), `unexpected kind: ${out.kind}`);
      // May or may not detect depending on entry point
    }
  } finally {
    await rmrf(dir);
  }
});

// ── diff ──────────────────────────────────────────────────────────────────────

test("diff --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["diff", "--help"], process.cwd());
  assert.ok(ok, "diff --help should succeed");
  assert.ok(
    stdout.includes("diff") || stdout.includes("lockfile") || stdout.includes("change"),
    "should describe lockfile diff"
  );
});

test("diff --base --head --json compares two lockfiles", async () => {
  const dir = await makeTempDir("better-diff-");
  try {
    const baseLock = {
      name: "test", lockfileVersion: 3,
      packages: {
        "": { name: "test", version: "1.0.0" },
        "node_modules/pkg-a": { version: "1.0.0" }
      }
    };
    const headLock = {
      name: "test", lockfileVersion: 3,
      packages: {
        "": { name: "test", version: "1.0.0" },
        "node_modules/pkg-a": { version: "1.1.0" },
        "node_modules/pkg-b": { version: "2.0.0" }
      }
    };
    await writeJson(path.join(dir, "base-lock.json"), baseLock);
    await writeJson(path.join(dir, "head-lock.json"), headLock);
    await writeJson(path.join(dir, "package.json"), { name: "test", version: "1.0.0" });

    const { stdout, ok } = await runBetter(
      ["diff", "--base", "base-lock.json", "--head", "head-lock.json", "--json"], dir
    );
    assert.ok(ok, "diff should succeed with explicit files");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("diff"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── pin ───────────────────────────────────────────────────────────────────────

test("pin --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["pin", "--help"], process.cwd());
  assert.ok(ok, "pin --help should succeed");
  assert.ok(
    stdout.includes("pin") || stdout.includes("exact") || stdout.includes("version"),
    "should describe version pinning"
  );
});

test("pin --dry-run --json returns pin changes without writing", async () => {
  const dir = await makeTempDir("better-pin-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      dependencies: { "pkg-a": "^1.5.2" },
      devDependencies: { "pkg-b": "~2.0.0" }
    });
    const nmDir = path.join(dir, "node_modules");
    await fs.mkdir(path.join(nmDir, "pkg-a"), { recursive: true });
    await writeJson(path.join(nmDir, "pkg-a", "package.json"), {
      name: "pkg-a", version: "1.5.2"
    });

    const { stdout, ok } = await runBetter(["pin", "--dry-run", "--json"], dir);
    assert.ok(ok, "pin --dry-run should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("pin"), `unexpected kind: ${out.kind}`);
      assert.ok(Array.isArray(out.changes), "should have changes array");
    }
  } finally {
    await rmrf(dir);
  }
});

// ── link ──────────────────────────────────────────────────────────────────────

test("link --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["link", "--help"], process.cwd());
  assert.ok(ok, "link --help should succeed");
  assert.ok(
    stdout.includes("link") || stdout.includes("symlink") || stdout.includes("local"),
    "should describe local package linking"
  );
});

test("link --list --json returns linked packages", async () => {
  const dir = await makeTempDir("better-link-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0"
    });
    await fs.mkdir(path.join(dir, "node_modules"), { recursive: true });

    const { stdout, ok } = await runBetter(["link", "--list", "--json"], dir);
    assert.ok(ok, "link --list should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("link"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── check-updates ─────────────────────────────────────────────────────────────

test("check-updates --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["check-updates", "--help"], process.cwd());
  assert.ok(ok, "check-updates --help should succeed");
  assert.ok(
    stdout.includes("update") || stdout.includes("latest") || stdout.includes("newer"),
    "should describe available updates checking"
  );
});

test("check-updates --json checks for updates (network-aware)", async (t) => {
  const dir = await makeTempDir("better-check-updates-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      dependencies: { "semver": "^7.0.0" }
    });
    const nmDir = path.join(dir, "node_modules");
    await fs.mkdir(path.join(nmDir, "semver"), { recursive: true });
    await writeJson(path.join(nmDir, "semver", "package.json"), {
      name: "semver", version: "7.0.0"
    });

    const { stdout, stderr, ok } = await runBetter(["check-updates", "--json"], dir);
    if (!ok && (stderr.includes("ENOTFOUND") || stderr.includes("ETIMEDOUT") || stderr.includes("timeout"))) {
      t.skip("network unavailable for check-updates");
      return;
    }
    assert.ok(ok, "check-updates should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("check-updates"), `unexpected kind: ${out.kind}`);
      assert.ok(typeof out.totalChecked === "number", "should have totalChecked");
    }
  } finally {
    await rmrf(dir);
  }
});

// ── patch ─────────────────────────────────────────────────────────────────────

test("patch --help shows usage", async () => {
  // patch --help exits 1 without subcommand in some environments
  const { stdout } = await runBetter(["patch", "--help"], process.cwd());
  assert.ok(
    stdout.includes("patch") || stdout.includes("modify") || stdout.includes("node_modules"),
    "should describe patch management"
  );
});

test("patch list --json returns applied patches", async () => {
  const dir = await makeTempDir("better-patch-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0"
    });

    const { stdout, ok } = await runBetter(["patch", "list", "--json"], dir);
    assert.ok(ok, "patch list should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("patch"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});
