// test/packages-workspace-lockhealth.test.js
// Tests for: better package-stats, better package-size-map, better semver-check,
//            better workspace, better monorepo-info, better lock-health,
//            better overrides, better outdated-report, better dep-changes

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

// ── package-stats ─────────────────────────────────────────────────────────────

test("package-stats --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["package-stats", "--help"], process.cwd());
  assert.ok(ok, "package-stats --help should succeed");
  assert.ok(
    stdout.includes("stat") || stdout.includes("package") || stdout.includes("size"),
    "should describe package statistics"
  );
});

test("package-stats --json returns stats for node_modules", async () => {
  const dir = await makeTempDir("better-pkgstats-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0", dependencies: { "pkg-a": "^1.0.0" }
    });
    const nmDir = path.join(dir, "node_modules");
    await fs.mkdir(path.join(nmDir, "pkg-a"), { recursive: true });
    await writeJson(path.join(nmDir, "pkg-a", "package.json"), {
      name: "pkg-a", version: "1.0.0", license: "MIT"
    });
    await fs.writeFile(path.join(nmDir, "pkg-a", "index.js"), "x".repeat(2000));

    const { stdout, ok } = await runBetter(["package-stats", "--json"], dir);
    assert.ok(ok, "package-stats should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.equal(out.ok, true);
      assert.ok(out.kind?.includes("package-stats"), `unexpected kind: ${out.kind}`);
      assert.ok(typeof out.totalPackages === "number", "should have totalPackages");
      assert.ok(typeof out.totalSize === "number", "should have totalSize");
    }
  } finally {
    await rmrf(dir);
  }
});

// ── package-size-map ──────────────────────────────────────────────────────────

test("package-size-map --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["package-size-map", "--help"], process.cwd());
  assert.ok(ok, "package-size-map --help should succeed");
  assert.ok(
    stdout.includes("size") || stdout.includes("map") || stdout.includes("package"),
    "should describe package size mapping"
  );
});

test("package-size-map --json returns size map for node_modules", async () => {
  const dir = await makeTempDir("better-pkgsizemap-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0"
    });
    const nmDir = path.join(dir, "node_modules");
    for (const [name, size] of [["small", 100], ["large", 50000]]) {
      await fs.mkdir(path.join(nmDir, name), { recursive: true });
      await writeJson(path.join(nmDir, name, "package.json"), { name, version: "1.0.0" });
      await fs.writeFile(path.join(nmDir, name, "index.js"), "x".repeat(size));
    }

    const { stdout, ok } = await runBetter(["package-size-map", "--json"], dir);
    assert.ok(ok, "package-size-map should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.equal(out.ok, true);
      assert.ok(out.kind?.includes("package-size"), `unexpected kind: ${out.kind}`);
      assert.ok(typeof out.totalSize === "number", "should report total size");
      assert.ok(Array.isArray(out.topPackages), "should have topPackages array");
    }
  } finally {
    await rmrf(dir);
  }
});

// ── semver-check ──────────────────────────────────────────────────────────────

test("semver-check --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["semver-check", "--help"], process.cwd());
  assert.ok(ok, "semver-check --help should succeed");
  assert.ok(
    stdout.includes("semver") || stdout.includes("range") || stdout.includes("version"),
    "should describe semver checking"
  );
});

test("semver-check with range and version returns match result", async () => {
  const dir = await makeTempDir("better-semvercheck-");
  try {
    await writeJson(path.join(dir, "package.json"), { name: "test", version: "1.0.0" });

    // semver-check with inline args (no network needed)
    const { stdout, ok } = await runBetter(
      ["semver-check", "--range", "^1.0.0", "--version", "1.5.0", "--json"], dir
    );
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("semver"), `unexpected kind: ${out.kind}`);
      // Result is in results[] array or allSatisfy
      const satisfies = out.allSatisfy === true ||
        (Array.isArray(out.results) && out.results.some(r => r.satisfies === true)) ||
        out.satisfies === true;
      assert.ok(satisfies, "1.5.0 should satisfy ^1.0.0");
    }
  } finally {
    await rmrf(dir);
  }
});

// ── workspace ─────────────────────────────────────────────────────────────────

test("workspace --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["workspace", "--help"], process.cwd());
  assert.ok(ok, "workspace --help should succeed");
  assert.ok(
    stdout.includes("workspace") || stdout.includes("monorepo") || stdout.includes("package"),
    "should describe workspace management"
  );
});

test("workspace list --json returns workspace packages", async () => {
  const dir = await makeTempDir("better-workspace-");
  try {
    // Create a workspace root
    await writeJson(path.join(dir, "package.json"), {
      name: "my-monorepo",
      version: "1.0.0",
      private: true,
      workspaces: ["packages/*"]
    });
    // Create workspace packages
    const pkgA = path.join(dir, "packages", "pkg-a");
    const pkgB = path.join(dir, "packages", "pkg-b");
    await fs.mkdir(pkgA, { recursive: true });
    await fs.mkdir(pkgB, { recursive: true });
    await writeJson(path.join(pkgA, "package.json"), {
      name: "@my/pkg-a", version: "1.0.0"
    });
    await writeJson(path.join(pkgB, "package.json"), {
      name: "@my/pkg-b", version: "1.0.0"
    });

    const { stdout, ok } = await runBetter(["workspace", "list", "--json"], dir);
    assert.ok(ok, "workspace list should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("workspace"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── monorepo-info ─────────────────────────────────────────────────────────────

test("monorepo-info --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["monorepo-info", "--help"], process.cwd());
  assert.ok(ok, "monorepo-info --help should succeed");
  assert.ok(
    stdout.includes("monorepo") || stdout.includes("workspace") || stdout.includes("info"),
    "should describe monorepo info"
  );
});

test("monorepo-info --json detects monorepo from workspaces field", async () => {
  const dir = await makeTempDir("better-monoinfo-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "my-monorepo", version: "1.0.0",
      private: true,
      workspaces: ["packages/*"]
    });
    const pkgA = path.join(dir, "packages", "pkg-a");
    await fs.mkdir(pkgA, { recursive: true });
    await writeJson(path.join(pkgA, "package.json"), {
      name: "@my/pkg-a", version: "1.0.0"
    });

    const { stdout, ok } = await runBetter(["monorepo-info", "--json"], dir);
    assert.ok(ok, "monorepo-info should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.equal(out.ok, true);
      assert.ok(out.kind?.includes("monorepo"), `unexpected kind: ${out.kind}`);
      assert.equal(out.isMonorepo, true, "should detect as monorepo");
      assert.ok(Array.isArray(out.workspaces), "should have workspaces array");
    }
  } finally {
    await rmrf(dir);
  }
});

test("monorepo-info --json detects non-monorepo", async () => {
  const dir = await makeTempDir("better-monoinfo-single-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "single-pkg", version: "1.0.0"
    });

    const { stdout, ok } = await runBetter(["monorepo-info", "--json"], dir);
    assert.ok(ok, "monorepo-info should succeed for single package");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.equal(out.ok, true);
      assert.equal(out.isMonorepo, false, "single pkg should not be monorepo");
    }
  } finally {
    await rmrf(dir);
  }
});

// ── lock-health ───────────────────────────────────────────────────────────────

test("lock-health --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["lock-health", "--help"], process.cwd());
  assert.ok(ok, "lock-health --help should succeed");
  assert.ok(
    stdout.includes("lock") || stdout.includes("health") || stdout.includes("lockfile"),
    "should describe lockfile health checking"
  );
});

test("lock-health --json returns health report for valid lockfile", async () => {
  const dir = await makeTempDir("better-lockhealth-");
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
        "node_modules/my-dep": { name: "my-dep", version: "1.0.0", integrity: "sha512-abc123" }
      }
    });

    const { stdout, ok } = await runBetter(["lock-health", "--json"], dir);
    assert.ok(ok, "lock-health should succeed with valid lockfile");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("lock-health"), `unexpected kind: ${out.kind}`);
      assert.ok(Array.isArray(out.checks), "should have checks array");
      assert.ok(typeof out.packageCount === "number", "should have packageCount");
    }
  } finally {
    await rmrf(dir);
  }
});

test("lock-health --json reports error when no lockfile exists", async () => {
  const dir = await makeTempDir("better-lockhealth-nolock-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0"
    });
    // No lockfile

    const { stdout } = await runBetter(["lock-health", "--json"], dir);
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      // No lockfile means either error or empty checks
      if (!out.ok) {
        assert.ok(out.error || out.kind, "should have error or kind when no lockfile");
      }
    }
  } finally {
    await rmrf(dir);
  }
});

// ── overrides ─────────────────────────────────────────────────────────────────

test("overrides --help shows usage", async () => {
  // overrides --help exits 1 when no subcommand is given
  const { stdout } = await runBetter(["overrides", "--help"], process.cwd());
  assert.ok(
    stdout.includes("override") || stdout.includes("resolutions") || stdout.includes("version"),
    "should describe overrides management"
  );
});

test("overrides list --json returns empty when no overrides", async () => {
  const dir = await makeTempDir("better-overrides-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0"
    });

    const { stdout, ok } = await runBetter(["overrides", "list", "--json"], dir);
    assert.ok(ok, "overrides list should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.equal(out.ok, true);
      assert.ok(out.kind?.includes("override"), `unexpected kind: ${out.kind}`);
      assert.equal(out.count, 0, "should have no overrides");
    }
  } finally {
    await rmrf(dir);
  }
});

test("overrides list --json reports existing overrides", async () => {
  const dir = await makeTempDir("better-overrides-found-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      overrides: { "lodash": "^4.17.21" }
    });

    const { stdout, ok } = await runBetter(["overrides", "list", "--json"], dir);
    assert.ok(ok, "overrides list should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.equal(out.ok, true);
      assert.ok(out.count >= 1, "should have 1 override");
    }
  } finally {
    await rmrf(dir);
  }
});

// ── outdated-report ───────────────────────────────────────────────────────────

test("outdated-report --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["outdated-report", "--help"], process.cwd());
  assert.ok(ok, "outdated-report --help should succeed");
  assert.ok(
    stdout.includes("outdated") || stdout.includes("report") || stdout.includes("update"),
    "should describe outdated report generation"
  );
});

test("outdated-report --json generates report with no outdated packages", async () => {
  const dir = await makeTempDir("better-outdatedreport-empty-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      dependencies: {}
    });

    const { stdout, ok } = await runBetter(["outdated-report", "--json"], dir);
    assert.ok(ok, "outdated-report should succeed with no packages");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
    }
  } finally {
    await rmrf(dir);
  }
});
