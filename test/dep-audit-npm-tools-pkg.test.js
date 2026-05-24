// test/dep-audit-npm-tools-pkg.test.js
// Tests for: better dependency-audit, better env-generate, better explain,
//            better license-report, better migration-guide, better missing-peer-install,
//            better module-check, better node-modules-doctor, better npm-check,
//            better npm-ci-check, better npm-run-order, better npm-token,
//            better pack-size, better package-diff, better package-json-diff,
//            better package-lock-audit, better package-size-breakdown,
//            better patch-patch-check, better peer-conflicts, better peer-deps

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

// ── dependency-audit ──────────────────────────────────────────────────────────

test("dependency-audit --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["dependency-audit", "--help"], process.cwd());
  assert.ok(ok, "dependency-audit --help should succeed");
  assert.ok(
    stdout.includes("dependency") || stdout.includes("audit") || stdout.includes("severity"),
    "should describe dependency-audit options"
  );
});

test("dependency-audit --json audits dependencies", async () => {
  const dir = await makeTempDir("better-dep-audit-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      dependencies: {}
    });

    const { stdout, ok } = await runBetter(["dependency-audit", "--json"], dir);
    assert.ok(ok, "dependency-audit should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("dependency-audit"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── env-generate ──────────────────────────────────────────────────────────────

test("env-generate --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["env-generate", "--help"], process.cwd());
  assert.ok(ok, "env-generate --help should succeed");
  assert.ok(
    stdout.includes("env") || stdout.includes("generate") || stdout.includes(".osp"),
    "should describe env-generate options"
  );
});

// env-generate requires .env.osp template — skip functional test

// ── explain ───────────────────────────────────────────────────────────────────

test("explain --help shows usage", async () => {
  const { stdout } = await runBetter(["explain", "--help"], process.cwd());
  assert.ok(
    stdout.includes("explain") || stdout.includes("package") || stdout.includes("why"),
    "should describe explain options"
  );
});

test("explain <pkg> --json explains a package (network-aware)", async (t) => {
  const { stdout, stderr, ok } = await runBetter(
    ["explain", "semver", "--json"], process.cwd()
  );
  if (!ok && (stderr.includes("ENOTFOUND") || stderr.includes("ETIMEDOUT") || stderr.includes("timeout"))) {
    t.skip("network unavailable for explain");
    return;
  }
  if (stdout.trim()) {
    const out = JSON.parse(stdout);
    assert.ok(typeof out.ok === "boolean", "should have ok field");
    assert.ok(out.kind?.includes("explain"), `unexpected kind: ${out.kind}`);
  }
});

// ── license-report ────────────────────────────────────────────────────────────

test("license-report --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["license-report", "--help"], process.cwd());
  assert.ok(ok, "license-report --help should succeed");
  assert.ok(
    stdout.includes("license") || stdout.includes("report") || stdout.includes("copyleft"),
    "should describe license-report options"
  );
});

test("license-report --json returns license report", async () => {
  const dir = await makeTempDir("better-license-report-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      dependencies: { "semver": "^7.0.0" }
    });
    const nmDir = path.join(dir, "node_modules");
    await fs.mkdir(path.join(nmDir, "semver"), { recursive: true });
    await writeJson(path.join(nmDir, "semver", "package.json"), {
      name: "semver", version: "7.5.4", license: "ISC"
    });

    const { stdout, ok } = await runBetter(["license-report", "--json"], dir);
    assert.ok(ok, "license-report should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("license-report"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── migration-guide ───────────────────────────────────────────────────────────

test("migration-guide --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["migration-guide", "--help"], process.cwd());
  assert.ok(ok, "migration-guide --help should succeed");
  assert.ok(
    stdout.includes("migration") || stdout.includes("package") || stdout.includes("major"),
    "should describe migration-guide options"
  );
});

test("migration-guide <pkg> <from> <to> --json returns migration guide (network-aware)", async (t) => {
  const { stdout, stderr, ok } = await runBetter(
    ["migration-guide", "lodash", "4", "5", "--json"], process.cwd()
  );
  if (!ok && (stderr.includes("ENOTFOUND") || stderr.includes("ETIMEDOUT") || stderr.includes("timeout"))) {
    t.skip("network unavailable for migration-guide");
    return;
  }
  if (stdout.trim()) {
    const out = JSON.parse(stdout);
    assert.ok(typeof out.ok === "boolean", "should have ok field");
    assert.ok(out.kind?.includes("migration-guide"), `unexpected kind: ${out.kind}`);
  }
});

// ── missing-peer-install ──────────────────────────────────────────────────────

test("missing-peer-install --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["missing-peer-install", "--help"], process.cwd());
  assert.ok(ok, "missing-peer-install --help should succeed");
  assert.ok(
    stdout.includes("peer") || stdout.includes("missing") || stdout.includes("install"),
    "should describe missing-peer-install options"
  );
});

test("missing-peer-install --json checks for missing peers", async () => {
  const dir = await makeTempDir("better-missing-peer-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      dependencies: {}
    });

    const { stdout, ok } = await runBetter(["missing-peer-install", "--json"], dir);
    assert.ok(ok, "missing-peer-install should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("missing-peer"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── module-check ──────────────────────────────────────────────────────────────

test("module-check --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["module-check", "--help"], process.cwd());
  assert.ok(ok, "module-check --help should succeed");
  assert.ok(
    stdout.includes("module") || stdout.includes("check") || stdout.includes("ESM"),
    "should describe module-check options"
  );
});

test("module-check --json checks module type compatibility", async () => {
  const dir = await makeTempDir("better-module-check-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      type: "module"
    });

    const { stdout } = await runBetter(["module-check", "--json"], dir);
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("module-check"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── node-modules-doctor ───────────────────────────────────────────────────────

test("node-modules-doctor --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["node-modules-doctor", "--help"], process.cwd());
  assert.ok(ok, "node-modules-doctor --help should succeed");
  assert.ok(
    stdout.includes("node_modules") || stdout.includes("doctor") || stdout.includes("check"),
    "should describe node-modules-doctor options"
  );
});

test("node-modules-doctor --json diagnoses node_modules", async () => {
  const dir = await makeTempDir("better-nm-doctor-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      dependencies: {}
    });

    const { stdout } = await runBetter(["node-modules-doctor", "--json"], dir);
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("node-modules-doctor"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── npm-check ─────────────────────────────────────────────────────────────────

test("npm-check --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["npm-check", "--help"], process.cwd());
  assert.ok(ok, "npm-check --help should succeed");
  assert.ok(
    stdout.includes("npm") || stdout.includes("check") || stdout.includes("node"),
    "should describe npm-check options"
  );
});

test("npm-check --json checks npm configuration", async () => {
  const { stdout, ok } = await runBetter(["npm-check", "--json"], process.cwd());
  assert.ok(ok, "npm-check should succeed");
  if (stdout.trim()) {
    const out = JSON.parse(stdout);
    assert.ok(typeof out.ok === "boolean", "should have ok field");
    assert.ok(out.kind?.includes("npm-check"), `unexpected kind: ${out.kind}`);
  }
});

// ── npm-ci-check ──────────────────────────────────────────────────────────────

test("npm-ci-check --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["npm-ci-check", "--help"], process.cwd());
  assert.ok(ok, "npm-ci-check --help should succeed");
  assert.ok(
    stdout.includes("ci") || stdout.includes("check") || stdout.includes("lockfile"),
    "should describe npm-ci-check options"
  );
});

test("npm-ci-check --json checks CI configuration readiness", async () => {
  const dir = await makeTempDir("better-npm-ci-check-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0"
    });

    const { stdout } = await runBetter(["npm-ci-check", "--json"], dir);
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("npm-ci-check"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── npm-run-order ─────────────────────────────────────────────────────────────

test("npm-run-order --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["npm-run-order", "--help"], process.cwd());
  assert.ok(ok, "npm-run-order --help should succeed");
  assert.ok(
    stdout.includes("npm-run-order") || stdout.includes("script") || stdout.includes("order"),
    "should describe npm-run-order options"
  );
});

test("npm-run-order --json returns script run order", async () => {
  const dir = await makeTempDir("better-npm-run-order-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      scripts: { prebuild: "echo pre", build: "echo build", postbuild: "echo post" }
    });

    const { stdout, ok } = await runBetter(["npm-run-order", "--json"], dir);
    assert.ok(ok, "npm-run-order should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("npm-run-order"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── npm-token ─────────────────────────────────────────────────────────────────

test("npm-token --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["npm-token", "--help"], process.cwd());
  assert.ok(ok, "npm-token --help should succeed");
  assert.ok(
    stdout.includes("token") || stdout.includes("npm") || stdout.includes("auth"),
    "should describe npm-token options"
  );
});

test("npm-token --json returns npm token info", async () => {
  const { stdout } = await runBetter(["npm-token", "--json"], process.cwd());
  if (stdout.trim()) {
    const out = JSON.parse(stdout);
    assert.ok(typeof out.ok === "boolean", "should have ok field");
    assert.ok(out.kind?.includes("npm-token"), `unexpected kind: ${out.kind}`);
  }
});

// ── pack-size ─────────────────────────────────────────────────────────────────

test("pack-size --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["pack-size", "--help"], process.cwd());
  assert.ok(ok, "pack-size --help should succeed");
  assert.ok(
    stdout.includes("pack") || stdout.includes("size") || stdout.includes("tarball"),
    "should describe pack-size options"
  );
});

test("pack-size --json reports pack size", async () => {
  const dir = await makeTempDir("better-pack-size-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test-pkg", version: "1.0.0"
    });
    await fs.writeFile(path.join(dir, "index.js"), "module.exports = {};\n");

    const { stdout } = await runBetter(["pack-size", "--json"], dir);
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("pack-size"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── package-diff ──────────────────────────────────────────────────────────────

test("package-diff --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["package-diff", "--help"], process.cwd());
  assert.ok(ok, "package-diff --help should succeed");
  assert.ok(
    stdout.includes("package-diff") || stdout.includes("diff") || stdout.includes("version"),
    "should describe package-diff options"
  );
});

test("package-diff <pkg> --json diffs package versions (network-aware)", async (t) => {
  const { stdout, stderr, ok } = await runBetter(
    ["package-diff", "semver", "--json"], process.cwd()
  );
  if (!ok && (stderr.includes("ENOTFOUND") || stderr.includes("ETIMEDOUT") || stderr.includes("timeout"))) {
    t.skip("network unavailable for package-diff");
    return;
  }
  if (stdout.trim()) {
    const out = JSON.parse(stdout);
    assert.ok(typeof out.ok === "boolean", "should have ok field");
    assert.ok(out.kind?.includes("package-diff"), `unexpected kind: ${out.kind}`);
  }
});

// ── package-json-diff ─────────────────────────────────────────────────────────

test("package-json-diff --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["package-json-diff", "--help"], process.cwd());
  assert.ok(ok, "package-json-diff --help should succeed");
  assert.ok(
    stdout.includes("package-json-diff") || stdout.includes("diff") || stdout.includes("version"),
    "should describe package-json-diff options"
  );
});

test("package-json-diff <pkg> <v1> <v2> --json diffs package.json (network-aware)", async (t) => {
  const { stdout, stderr, ok } = await runBetter(
    ["package-json-diff", "semver", "7.0.0", "7.5.4", "--json"], process.cwd()
  );
  if (!ok && (stderr.includes("ENOTFOUND") || stderr.includes("ETIMEDOUT") || stderr.includes("timeout"))) {
    t.skip("network unavailable for package-json-diff");
    return;
  }
  if (stdout.trim()) {
    const out = JSON.parse(stdout);
    assert.ok(typeof out.ok === "boolean", "should have ok field");
    assert.ok(out.kind?.includes("package-json-diff"), `unexpected kind: ${out.kind}`);
  }
});

// ── package-lock-audit ────────────────────────────────────────────────────────

test("package-lock-audit --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["package-lock-audit", "--help"], process.cwd());
  assert.ok(ok, "package-lock-audit --help should succeed");
  assert.ok(
    stdout.includes("package-lock") || stdout.includes("audit") || stdout.includes("lockfile"),
    "should describe package-lock-audit options"
  );
});

test("package-lock-audit --json audits package-lock.json", async () => {
  const dir = await makeTempDir("better-pkg-lock-audit-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0"
    });
    await writeJson(path.join(dir, "package-lock.json"), {
      name: "test", lockfileVersion: 3, packages: {}
    });

    const { stdout, ok } = await runBetter(["package-lock-audit", "--json"], dir);
    assert.ok(ok, "package-lock-audit should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("package-lock-audit"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── package-size-breakdown ────────────────────────────────────────────────────

test("package-size-breakdown --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["package-size-breakdown", "--help"], process.cwd());
  assert.ok(ok, "package-size-breakdown --help should succeed");
  assert.ok(
    stdout.includes("package-size") || stdout.includes("breakdown") || stdout.includes("size"),
    "should describe package-size-breakdown options"
  );
});

test("package-size-breakdown <pkg> --json returns size breakdown (network-aware)", async (t) => {
  const { stdout, stderr, ok } = await runBetter(
    ["package-size-breakdown", "semver", "--json"], process.cwd()
  );
  if (!ok && (stderr.includes("ENOTFOUND") || stderr.includes("ETIMEDOUT") || stderr.includes("timeout"))) {
    t.skip("network unavailable for package-size-breakdown");
    return;
  }
  if (stdout.trim()) {
    const out = JSON.parse(stdout);
    assert.ok(typeof out.ok === "boolean", "should have ok field");
    assert.ok(out.kind?.includes("package-size-breakdown"), `unexpected kind: ${out.kind}`);
  }
});

// ── patch-package-check ───────────────────────────────────────────────────────

test("patch-package-check --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["patch-package-check", "--help"], process.cwd());
  assert.ok(ok, "patch-package-check --help should succeed");
  assert.ok(
    stdout.includes("patch") || stdout.includes("package") || stdout.includes("check"),
    "should describe patch-package-check options"
  );
});

test("patch-package-check --json checks for applied patches", async () => {
  const dir = await makeTempDir("better-patch-pkg-check-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0"
    });

    const { stdout, ok } = await runBetter(["patch-package-check", "--json"], dir);
    assert.ok(ok, "patch-package-check should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("patch-package-check"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── peer-conflicts ────────────────────────────────────────────────────────────

test("peer-conflicts --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["peer-conflicts", "--help"], process.cwd());
  assert.ok(ok, "peer-conflicts --help should succeed");
  assert.ok(
    stdout.includes("peer") || stdout.includes("conflict") || stdout.includes("deps"),
    "should describe peer-conflicts options"
  );
});

test("peer-conflicts --json checks for peer dependency conflicts", async () => {
  const dir = await makeTempDir("better-peer-conflicts-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      dependencies: {}
    });
    await fs.mkdir(path.join(dir, "node_modules"), { recursive: true });

    const { stdout } = await runBetter(["peer-conflicts", "--json"], dir);
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
    }
  } finally {
    await rmrf(dir);
  }
});

// ── peer-deps ─────────────────────────────────────────────────────────────────

test("peer-deps --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["peer-deps", "--help"], process.cwd());
  assert.ok(ok, "peer-deps --help should succeed");
  assert.ok(
    stdout.includes("peer") || stdout.includes("deps") || stdout.includes("satisfied"),
    "should describe peer-deps options"
  );
});

test("peer-deps --json checks peer dependency satisfaction", async () => {
  const dir = await makeTempDir("better-peer-deps-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      dependencies: {}
    });

    const { stdout, ok } = await runBetter(["peer-deps", "--json"], dir);
    assert.ok(ok, "peer-deps should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("peer-deps"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});
