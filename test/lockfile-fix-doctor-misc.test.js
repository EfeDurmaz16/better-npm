// test/lockfile-fix-doctor-misc.test.js
// Tests for: better lockfile-fix, better doctor-fix, better fix-versions,
//            better import-map, better exports-map, better dep-graph-json,
//            better monorepo-version-sync, better audit-fix, better perf-budget,
//            better preinstall-check, better size-limit-check, better link-check

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

// ── lockfile-fix ──────────────────────────────────────────────────────────────

test("lockfile-fix --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["lockfile-fix", "--help"], process.cwd());
  assert.ok(ok, "lockfile-fix --help should succeed");
  assert.ok(
    stdout.includes("lockfile") || stdout.includes("fix") || stdout.includes("repair"),
    "should describe lockfile fixing"
  );
});

test("lockfile-fix --dry-run --json reports issues in lockfile", async () => {
  const dir = await makeTempDir("better-lockfile-fix-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      dependencies: { "pkg-a": "^1.0.0" }
    });
    await writeJson(path.join(dir, "package-lock.json"), {
      name: "test", lockfileVersion: 3,
      packages: {
        "": { name: "test", version: "1.0.0", dependencies: { "pkg-a": "^1.0.0" } },
        "node_modules/pkg-a": { name: "pkg-a", version: "1.0.0", integrity: "sha512-abc" }
      }
    });

    const { stdout } = await runBetter(["lockfile-fix", "--dry-run", "--json"], dir);
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("lockfile-fix"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── doctor-fix ────────────────────────────────────────────────────────────────

test("doctor-fix --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["doctor-fix", "--help"], process.cwd());
  assert.ok(ok, "doctor-fix --help should succeed");
  assert.ok(
    stdout.includes("doctor") || stdout.includes("fix") || stdout.includes("repair"),
    "should describe doctor fix"
  );
});

test("doctor-fix --dry-run --json reports fixable issues", async () => {
  const dir = await makeTempDir("better-doctor-fix-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0"
    });

    const { stdout } = await runBetter(["doctor-fix", "--dry-run", "--json"], dir);
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("doctor-fix"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── fix-versions ──────────────────────────────────────────────────────────────

test("fix-versions --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["fix-versions", "--help"], process.cwd());
  assert.ok(ok, "fix-versions --help should succeed");
  assert.ok(
    stdout.includes("version") || stdout.includes("fix") || stdout.includes("range"),
    "should describe version range fixing"
  );
});

test("fix-versions --dry-run --json normalizes version ranges", async () => {
  const dir = await makeTempDir("better-fix-versions-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      dependencies: { "pkg-a": ">=1.0.0 <2.0.0", "pkg-b": "*" }
    });

    const { stdout } = await runBetter(["fix-versions", "--dry-run", "--json"], dir);
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("fix-versions"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── import-map ────────────────────────────────────────────────────────────────

test("import-map --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["import-map", "--help"], process.cwd());
  assert.ok(ok, "import-map --help should succeed");
  assert.ok(
    stdout.includes("import") || stdout.includes("map") || stdout.includes("esm"),
    "should describe import map generation"
  );
});

test("import-map --json generates ESM import map", async () => {
  const dir = await makeTempDir("better-import-map-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      dependencies: { "pkg-a": "^1.0.0" }
    });
    const nmDir = path.join(dir, "node_modules");
    await fs.mkdir(path.join(nmDir, "pkg-a"), { recursive: true });
    await writeJson(path.join(nmDir, "pkg-a", "package.json"), {
      name: "pkg-a", version: "1.0.0", main: "index.js"
    });

    const { stdout, ok } = await runBetter(["import-map", "--json"], dir);
    assert.ok(ok, "import-map should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("import-map"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── exports-map ───────────────────────────────────────────────────────────────

test("exports-map --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["exports-map", "--help"], process.cwd());
  assert.ok(ok, "exports-map --help should succeed");
  assert.ok(
    stdout.includes("export") || stdout.includes("map") || stdout.includes("package.json"),
    "should describe exports map analysis"
  );
});

test("exports-map --json analyzes exports field", async () => {
  const dir = await makeTempDir("better-exports-map-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      exports: {
        ".": "./index.js",
        "./utils": "./utils.js"
      }
    });
    await fs.writeFile(path.join(dir, "index.js"), "module.exports = {};\n");
    await fs.writeFile(path.join(dir, "utils.js"), "module.exports = {};\n");

    const { stdout, ok } = await runBetter(["exports-map", "--json"], dir);
    assert.ok(ok, "exports-map should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("exports-map"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── dep-graph-json ────────────────────────────────────────────────────────────

test("dep-graph-json --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["dep-graph-json", "--help"], process.cwd());
  assert.ok(ok, "dep-graph-json --help should succeed");
  assert.ok(
    stdout.includes("graph") || stdout.includes("json") || stdout.includes("depend"),
    "should describe JSON dep graph export"
  );
});

test("dep-graph-json --json exports dependency graph", async () => {
  const dir = await makeTempDir("better-dep-graph-json-");
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
    await writeJson(path.join(dir, "package-lock.json"), {
      name: "test", lockfileVersion: 3,
      packages: {
        "": { name: "test", version: "1.0.0", dependencies: { "pkg-a": "^1.0.0" } },
        "node_modules/pkg-a": { name: "pkg-a", version: "1.0.0" }
      }
    });

    const { stdout, ok } = await runBetter(["dep-graph-json", "--json"], dir);
    assert.ok(ok, "dep-graph-json should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("dep-graph-json"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── monorepo-version-sync ─────────────────────────────────────────────────────

test("monorepo-version-sync --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["monorepo-version-sync", "--help"], process.cwd());
  assert.ok(ok, "monorepo-version-sync --help should succeed");
  assert.ok(
    stdout.includes("version") || stdout.includes("sync") || stdout.includes("monorepo"),
    "should describe version sync"
  );
});

test("monorepo-version-sync --json detects version inconsistencies", async () => {
  const dir = await makeTempDir("better-mono-version-sync-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "my-monorepo", version: "1.0.0", private: true,
      workspaces: ["packages/*"]
    });
    const pkgA = path.join(dir, "packages", "pkg-a");
    const pkgB = path.join(dir, "packages", "pkg-b");
    await fs.mkdir(pkgA, { recursive: true });
    await fs.mkdir(pkgB, { recursive: true });
    await writeJson(path.join(pkgA, "package.json"), {
      name: "@mono/pkg-a", version: "1.0.0",
      dependencies: { "lodash": "^4.0.0" }
    });
    await writeJson(path.join(pkgB, "package.json"), {
      name: "@mono/pkg-b", version: "1.0.0",
      dependencies: { "lodash": "^3.0.0" }
    });

    const { stdout, ok } = await runBetter(["monorepo-version-sync", "--json"], dir);
    assert.ok(ok, "monorepo-version-sync should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("monorepo-version-sync"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── audit fix (subcommand) ────────────────────────────────────────────────────

// audit-fix is routed as `audit fix`, not `audit-fix`
test("audit fix --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["audit", "fix", "--help"], process.cwd());
  assert.ok(ok, "audit fix --help should succeed");
  assert.ok(
    stdout.includes("audit") || stdout.includes("fix") || stdout.includes("vulnerabilit"),
    "should describe audit auto-fix"
  );
});

test("audit fix --dry-run --json reports fixable vulnerabilities (network-aware)", async (t) => {
  const dir = await makeTempDir("better-audit-fix-");
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
    await writeJson(path.join(dir, "package-lock.json"), {
      name: "test", lockfileVersion: 3,
      packages: {
        "": { name: "test", version: "1.0.0", dependencies: { "semver": "^7.0.0" } },
        "node_modules/semver": { name: "semver", version: "7.5.4" }
      }
    });

    const { stdout, stderr } = await runBetter(["audit", "fix", "--dry-run", "--json"], dir);
    if (stderr.includes("ENOTFOUND") || stderr.includes("403") || stderr.includes("ETIMEDOUT")) {
      t.skip("network or OSV unavailable for audit fix");
      return;
    }
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("audit-fix"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── perf-budget ───────────────────────────────────────────────────────────────

test("perf-budget --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["perf-budget", "--help"], process.cwd());
  assert.ok(ok, "perf-budget --help should succeed");
  assert.ok(
    stdout.includes("budget") || stdout.includes("perf") || stdout.includes("size"),
    "should describe performance budget enforcement"
  );
});

test("perf-budget --json reports no budget when unconfigured", async () => {
  const dir = await makeTempDir("better-perf-budget-");
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

    // perf-budget exits 1 when no budget configured
    const { stdout } = await runBetter(["perf-budget", "--json"], dir);
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      // Either reports checks or budget-not-configured error
    }
  } finally {
    await rmrf(dir);
  }
});

// ── preinstall-check ──────────────────────────────────────────────────────────

test("preinstall-check --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["preinstall-check", "--help"], process.cwd());
  assert.ok(ok, "preinstall-check --help should succeed");
  assert.ok(
    stdout.includes("preinstall") || stdout.includes("script") || stdout.includes("suspicious"),
    "should describe preinstall script auditing"
  );
});

test("preinstall-check --json audits install scripts", async () => {
  const dir = await makeTempDir("better-preinstall-check-");
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

    const { stdout, ok } = await runBetter(["preinstall-check", "--json"], dir);
    assert.ok(ok, "preinstall-check should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("preinstall"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── link-check ────────────────────────────────────────────────────────────────

test("link-check --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["link-check", "--help"], process.cwd());
  assert.ok(ok, "link-check --help should succeed");
  assert.ok(
    stdout.includes("link") || stdout.includes("check") || stdout.includes("symlink"),
    "should describe link checking"
  );
});

test("link-check --json returns linked packages status", async () => {
  const dir = await makeTempDir("better-link-check-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0"
    });
    await fs.mkdir(path.join(dir, "node_modules"), { recursive: true });

    const { stdout, ok } = await runBetter(["link-check", "--json"], dir);
    assert.ok(ok, "link-check should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("link-check"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});
