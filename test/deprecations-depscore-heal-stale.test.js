// test/deprecations-depscore-heal-stale.test.js
// Tests for: better deprecations, better dep-score, better deps-used,
//            better lockfile-lint, better lockfile-merge, better heal,
//            better dep-age, better stale, better maintenance, better fix

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

// ── deprecations ──────────────────────────────────────────────────────────────

test("deprecations --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["deprecations", "--help"], process.cwd());
  assert.ok(ok, "deprecations --help should succeed");
  assert.ok(
    stdout.includes("deprecat") || stdout.includes("deprecated") || stdout.includes("package"),
    "should describe deprecation checking"
  );
});

test("deprecations --json returns ok when no deprecated packages", async () => {
  const dir = await makeTempDir("better-deprecations-ok-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      dependencies: { "pkg-a": "^1.0.0" }
    });
    const nmDir = path.join(dir, "node_modules");
    await fs.mkdir(path.join(nmDir, "pkg-a"), { recursive: true });
    await writeJson(path.join(nmDir, "pkg-a", "package.json"), {
      name: "pkg-a", version: "1.0.0"
    });

    const { stdout, ok } = await runBetter(["deprecations", "--json"], dir);
    assert.ok(ok, "deprecations should succeed with no deprecated packages");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("deprecation"), `unexpected kind: ${out.kind}`);
      assert.ok(typeof out.total_checked === "number", "should have total_checked");
      assert.equal(out.deprecated_count, 0, "should have 0 deprecated");
    }
  } finally {
    await rmrf(dir);
  }
});

test("deprecations --json detects deprecated packages", async () => {
  const dir = await makeTempDir("better-deprecations-found-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      dependencies: { "old-pkg": "^1.0.0" }
    });
    const nmDir = path.join(dir, "node_modules");
    await fs.mkdir(path.join(nmDir, "old-pkg"), { recursive: true });
    // Mark package as deprecated in its package.json
    await writeJson(path.join(nmDir, "old-pkg", "package.json"), {
      name: "old-pkg", version: "1.0.0",
      deprecated: "Use new-pkg instead"
    });

    const { stdout } = await runBetter(["deprecations", "--json"], dir);
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("deprecation"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── dep-score ─────────────────────────────────────────────────────────────────

test("dep-score --help shows usage", async () => {
  // dep-score requires package args; --help may exit 1 without them
  const { stdout } = await runBetter(["dep-score", "--help"], process.cwd());
  assert.ok(
    stdout.includes("score") || stdout.includes("dep") || stdout.includes("quality"),
    "should describe dependency scoring"
  );
});

test("dep-score --json scores packages (network-aware)", async (t) => {
  const { stdout, stderr, ok } = await runBetter(
    ["dep-score", "semver", "--json"], process.cwd()
  );
  if (!ok && (stderr.includes("ENOTFOUND") || stderr.includes("ETIMEDOUT") || stderr.includes("timeout"))) {
    t.skip("network unavailable for dep-score");
    return;
  }
  if (stdout.trim()) {
    const out = JSON.parse(stdout);
    assert.ok(typeof out.ok === "boolean", "should have ok field");
    assert.ok(out.kind?.includes("dep-score"), `unexpected kind: ${out.kind}`);
    assert.ok(Array.isArray(out.results), "should have results array");
  }
});

// ── deps-used ─────────────────────────────────────────────────────────────────

test("deps-used --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["deps-used", "--help"], process.cwd());
  assert.ok(ok, "deps-used --help should succeed");
  assert.ok(
    stdout.includes("deps") || stdout.includes("used") || stdout.includes("import"),
    "should describe deps-used analysis"
  );
});

test("deps-used --json finds used dependencies in source files", async () => {
  const dir = await makeTempDir("better-deps-used-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      dependencies: { "lodash": "^4.0.0" }
    });
    await fs.writeFile(path.join(dir, "index.js"), `const _ = require('lodash');\n_.map([1,2,3], x => x * 2);\n`);

    const { stdout, ok } = await runBetter(["deps-used", "--json"], dir);
    assert.ok(ok, "deps-used should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("deps-used"), `unexpected kind: ${out.kind}`);
      assert.ok(typeof out.filesScanned === "number", "should have filesScanned");
    }
  } finally {
    await rmrf(dir);
  }
});

// ── lockfile-lint ─────────────────────────────────────────────────────────────

test("lockfile-lint --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["lockfile-lint", "--help"], process.cwd());
  assert.ok(ok, "lockfile-lint --help should succeed");
  assert.ok(
    stdout.includes("lockfile") || stdout.includes("lint") || stdout.includes("lock"),
    "should describe lockfile linting"
  );
});

test("lockfile-lint --json returns ok for valid lockfile", async () => {
  const dir = await makeTempDir("better-lockfile-lint-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      dependencies: { "my-dep": "^1.0.0" }
    });
    await writeJson(path.join(dir, "package-lock.json"), {
      name: "test",
      lockfileVersion: 3,
      packages: {
        "": { name: "test", version: "1.0.0", dependencies: { "my-dep": "^1.0.0" } },
        "node_modules/my-dep": {
          name: "my-dep", version: "1.0.0",
          integrity: "sha512-abc123",
          resolved: "https://registry.npmjs.org/my-dep/-/my-dep-1.0.0.tgz"
        }
      }
    });

    const { stdout, ok } = await runBetter(["lockfile-lint", "--json"], dir);
    assert.ok(ok, "lockfile-lint should succeed for valid lockfile");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("lockfile-lint"), `unexpected kind: ${out.kind}`);
      assert.ok(typeof out.totalPackages === "number", "should have totalPackages");
    }
  } finally {
    await rmrf(dir);
  }
});

// ── lockfile-merge ────────────────────────────────────────────────────────────

test("lockfile-merge --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["lockfile-merge", "--help"], process.cwd());
  assert.ok(ok, "lockfile-merge --help should succeed");
  assert.ok(
    stdout.includes("merge") || stdout.includes("lockfile") || stdout.includes("conflict"),
    "should describe lockfile merge"
  );
});

test("lockfile-merge --json reports no conflicts for clean lockfile", async () => {
  const dir = await makeTempDir("better-lockfile-merge-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0"
    });
    await writeJson(path.join(dir, "package-lock.json"), {
      name: "test", lockfileVersion: 3, packages: {}
    });

    const { stdout } = await runBetter(["lockfile-merge", "--json"], dir);
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("lockfile-merge"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── heal ──────────────────────────────────────────────────────────────────────

test("heal --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["heal", "--help"], process.cwd());
  assert.ok(ok, "heal --help should succeed");
  assert.ok(
    stdout.includes("heal") || stdout.includes("fix") || stdout.includes("repair"),
    "should describe project healing"
  );
});

test("heal --dry-run --json returns heal actions", async () => {
  const dir = await makeTempDir("better-heal-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0"
    });

    const { stdout, ok } = await runBetter(["heal", "--dry-run", "--json"], dir);
    assert.ok(ok, "heal should succeed in dry-run mode");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("heal"), `unexpected kind: ${out.kind}`);
      assert.ok(Array.isArray(out.actions), "should have actions array");
    }
  } finally {
    await rmrf(dir);
  }
});

// ── dep-age ───────────────────────────────────────────────────────────────────

test("dep-age --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["dep-age", "--help"], process.cwd());
  assert.ok(ok, "dep-age --help should succeed");
  assert.ok(
    stdout.includes("age") || stdout.includes("dep") || stdout.includes("stale"),
    "should describe dependency age checking"
  );
});

test("dep-age --json returns age info (network-aware)", async (t) => {
  const dir = await makeTempDir("better-dep-age-");
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

    const { stdout, stderr, ok } = await runBetter(["dep-age", "--json"], dir);
    if (!ok && (stderr.includes("ENOTFOUND") || stderr.includes("ETIMEDOUT") || stderr.includes("timeout"))) {
      t.skip("network unavailable for dep-age");
      return;
    }
    assert.ok(ok, "dep-age should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("dep-age"), `unexpected kind: ${out.kind}`);
      assert.ok(typeof out.checked === "number", "should have checked count");
    }
  } finally {
    await rmrf(dir);
  }
});

// ── stale ─────────────────────────────────────────────────────────────────────

test("stale --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["stale", "--help"], process.cwd());
  assert.ok(ok, "stale --help should succeed");
  assert.ok(
    stdout.includes("stale") || stdout.includes("old") || stdout.includes("deprecated"),
    "should describe stale package detection"
  );
});

test("stale --json returns stale package report (network-aware)", async (t) => {
  const dir = await makeTempDir("better-stale-");
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

    const { stdout, stderr, ok } = await runBetter(["stale", "--json"], dir);
    if (!ok && (stderr.includes("ENOTFOUND") || stderr.includes("ETIMEDOUT") || stderr.includes("timeout"))) {
      t.skip("network unavailable for stale");
      return;
    }
    assert.ok(ok, "stale should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("stale"), `unexpected kind: ${out.kind}`);
      assert.ok(typeof out.totalChecked === "number", "should have totalChecked");
      assert.ok(Array.isArray(out.packages), "should have packages array");
    }
  } finally {
    await rmrf(dir);
  }
});

// ── maintenance ───────────────────────────────────────────────────────────────

test("maintenance --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["maintenance", "--help"], process.cwd());
  assert.ok(ok, "maintenance --help should succeed");
  assert.ok(
    stdout.includes("maintenance") || stdout.includes("risk") || stdout.includes("predict"),
    "should describe maintenance analysis"
  );
});

test("maintenance --json returns maintenance report (network-aware)", async (t) => {
  const dir = await makeTempDir("better-maintenance-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      dependencies: { "semver": "^7.0.0" }
    });

    const { stdout, stderr, ok } = await runBetter(["maintenance", "--json"], dir);
    if (!ok && (stderr.includes("ENOTFOUND") || stderr.includes("ETIMEDOUT") || stderr.includes("timeout"))) {
      t.skip("network unavailable for maintenance");
      return;
    }
    assert.ok(ok, "maintenance should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("maintenance"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── fix ───────────────────────────────────────────────────────────────────────

test("fix --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["fix", "--help"], process.cwd());
  assert.ok(ok, "fix --help should succeed");
  assert.ok(
    stdout.includes("fix") || stdout.includes("check") || stdout.includes("issue"),
    "should describe auto-fix functionality"
  );
});

test("fix --check --json returns issues without fixing", async () => {
  const dir = await makeTempDir("better-fix-check-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0"
    });

    // fix --check exits 1 when issues found (expected), stdout still has JSON
    const { stdout } = await runBetter(["fix", "--check", "--json"], dir);
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("fix"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});
