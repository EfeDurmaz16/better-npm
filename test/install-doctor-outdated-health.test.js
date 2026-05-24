// test/install-doctor-outdated-health.test.js
// Tests for: better install, better doctor, better outdated, better size, better why,
//            better license, better dedupe, better dep-graph, better dep-tree-size,
//            better dep-why, better node-compat, better node-api-compat,
//            better module-type, better gen-types, better git-check,
//            better health-score, better health-dashboard

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

// ── install ───────────────────────────────────────────────────────────────────

test("install --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["install", "--help"], process.cwd());
  assert.ok(ok, "install --help should succeed");
  assert.ok(
    stdout.includes("install") || stdout.includes("pm") || stdout.includes("engine"),
    "should describe install options"
  );
});

test("install --json --dry-run reports install plan", async () => {
  const dir = await makeTempDir("better-install-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      dependencies: {}
    });

    const { stdout, ok } = await runBetter(["install", "--json", "--dry-run"], dir);
    assert.ok(ok, "install --dry-run should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("install"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── doctor ────────────────────────────────────────────────────────────────────

test("doctor --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["doctor", "--help"], process.cwd());
  assert.ok(ok, "doctor --help should succeed");
  assert.ok(
    stdout.includes("doctor") || stdout.includes("health") || stdout.includes("threshold"),
    "should describe doctor options"
  );
});

test("doctor --json runs project health check", async () => {
  const dir = await makeTempDir("better-doctor-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      description: "A test package",
      license: "MIT"
    });

    const { stdout } = await runBetter(["doctor", "--json"], dir);
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("doctor"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── outdated ──────────────────────────────────────────────────────────────────

test("outdated --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["outdated", "--help"], process.cwd());
  assert.ok(ok, "outdated --help should succeed");
  assert.ok(
    stdout.includes("outdated") || stdout.includes("level") || stdout.includes("production"),
    "should describe outdated options"
  );
});

test("outdated --json returns outdated packages (network-aware)", async (t) => {
  const dir = await makeTempDir("better-outdated-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      dependencies: { "semver": "^7.0.0" }
    });

    const { stdout, stderr, ok } = await runBetter(["outdated", "--json"], dir);
    if (!ok && (stderr.includes("ENOTFOUND") || stderr.includes("ETIMEDOUT") || stderr.includes("timeout"))) {
      t.skip("network unavailable for outdated");
      return;
    }
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("outdated"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── size ──────────────────────────────────────────────────────────────────────

test("size --help shows usage", async () => {
  const { stdout } = await runBetter(["size", "--help"], process.cwd());
  assert.ok(
    stdout.includes("size") || stdout.includes("install") || stdout.includes("impact"),
    "should describe size checking"
  );
});

test("size <pkg> --json reports install size (network-aware)", async (t) => {
  const { stdout, stderr, ok } = await runBetter(["size", "semver", "--json"], process.cwd());
  if (!ok && (stderr.includes("ENOTFOUND") || stderr.includes("ETIMEDOUT") || stderr.includes("timeout"))) {
    t.skip("network unavailable for size");
    return;
  }
  if (stdout.trim()) {
    const out = JSON.parse(stdout);
    assert.ok(typeof out.ok === "boolean", "should have ok field");
    assert.ok(Array.isArray(out.packages ?? []), "should have packages array");
  }
});

// ── why ───────────────────────────────────────────────────────────────────────

test("why --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["why", "--help"], process.cwd());
  assert.ok(ok, "why --help should succeed");
  assert.ok(
    stdout.includes("why") || stdout.includes("package") || stdout.includes("depend"),
    "should describe why options"
  );
});

test("why <pkg> --json explains why package is installed", async () => {
  const dir = await makeTempDir("better-why-");
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

    const { stdout } = await runBetter(["why", "semver", "--json"], dir);
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("why"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── license ───────────────────────────────────────────────────────────────────

test("license --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["license", "--help"], process.cwd());
  assert.ok(ok, "license --help should succeed");
  assert.ok(
    stdout.includes("license") || stdout.includes("MIT") || stdout.includes("packages"),
    "should describe license checking"
  );
});

test("license --json returns license summary", async () => {
  const dir = await makeTempDir("better-license-");
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

    const { stdout, ok } = await runBetter(["license", "--json"], dir);
    assert.ok(ok, "license should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("license"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── dedupe ────────────────────────────────────────────────────────────────────

test("dedupe --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["dedupe", "--help"], process.cwd());
  assert.ok(ok, "dedupe --help should succeed");
  assert.ok(
    stdout.includes("dedupe") || stdout.includes("duplicate") || stdout.includes("dry-run"),
    "should describe dedupe options"
  );
});

test("dedupe --json --dry-run reports duplicates", async () => {
  const dir = await makeTempDir("better-dedupe-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      dependencies: { "semver": "^7.0.0" }
    });

    const { stdout, ok } = await runBetter(["dedupe", "--json", "--dry-run"], dir);
    assert.ok(ok, "dedupe --dry-run should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("dedupe"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── dep-graph ─────────────────────────────────────────────────────────────────

test("dep-graph --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["dep-graph", "--help"], process.cwd());
  assert.ok(ok, "dep-graph --help should succeed");
  assert.ok(
    stdout.includes("dep-graph") || stdout.includes("graph") || stdout.includes("depend"),
    "should describe dep-graph options"
  );
});

test("dep-graph --json returns dependency graph", async () => {
  const dir = await makeTempDir("better-dep-graph-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      dependencies: { "semver": "^7.0.0" }
    });

    const { stdout, ok } = await runBetter(["dep-graph", "--json"], dir);
    assert.ok(ok, "dep-graph should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("dep-graph"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── dep-tree-size ─────────────────────────────────────────────────────────────

test("dep-tree-size --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["dep-tree-size", "--help"], process.cwd());
  assert.ok(ok, "dep-tree-size --help should succeed");
  assert.ok(
    stdout.includes("dep-tree-size") || stdout.includes("size") || stdout.includes("packages"),
    "should describe dep-tree-size options"
  );
});

test("dep-tree-size --json returns dependency tree sizes", async () => {
  const dir = await makeTempDir("better-dep-tree-size-");
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

    const { stdout, ok } = await runBetter(["dep-tree-size", "--json"], dir);
    assert.ok(ok, "dep-tree-size should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("dep-tree-size"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── dep-why ───────────────────────────────────────────────────────────────────

test("dep-why --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["dep-why", "--help"], process.cwd());
  assert.ok(ok, "dep-why --help should succeed");
  assert.ok(
    stdout.includes("dep-why") || stdout.includes("why") || stdout.includes("package"),
    "should describe dep-why options"
  );
});

test("dep-why <pkg> --json explains transitive dep reason", async () => {
  const dir = await makeTempDir("better-dep-why-");
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

    const { stdout } = await runBetter(["dep-why", "semver", "--json"], dir);
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
    }
  } finally {
    await rmrf(dir);
  }
});

// ── node-compat ───────────────────────────────────────────────────────────────

test("node-compat --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["node-compat", "--help"], process.cwd());
  assert.ok(ok, "node-compat --help should succeed");
  assert.ok(
    stdout.includes("node-compat") || stdout.includes("node") || stdout.includes("engines"),
    "should describe node-compat options"
  );
});

test("node-compat --json checks Node.js compatibility", async () => {
  const dir = await makeTempDir("better-node-compat-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      engines: { node: ">=18.0.0" },
      dependencies: { "semver": "^7.0.0" }
    });
    const nmDir = path.join(dir, "node_modules");
    await fs.mkdir(path.join(nmDir, "semver"), { recursive: true });
    await writeJson(path.join(nmDir, "semver", "package.json"), {
      name: "semver", version: "7.5.4",
      engines: { node: ">=10" }
    });

    const { stdout, ok } = await runBetter(["node-compat", "--json"], dir);
    assert.ok(ok, "node-compat should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("node-compat"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── node-api-compat ───────────────────────────────────────────────────────────

test("node-api-compat --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["node-api-compat", "--help"], process.cwd());
  assert.ok(ok, "node-api-compat --help should succeed");
  assert.ok(
    stdout.includes("node-api") || stdout.includes("napi") || stdout.includes("native"),
    "should describe node-api-compat options"
  );
});

test("node-api-compat --json checks Node-API compatibility", async () => {
  const dir = await makeTempDir("better-node-api-compat-");
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

    const { stdout, ok } = await runBetter(["node-api-compat", "--json"], dir);
    assert.ok(ok, "node-api-compat should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("node-api-compat"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── module-type ───────────────────────────────────────────────────────────────

test("module-type --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["module-type", "--help"], process.cwd());
  assert.ok(ok, "module-type --help should succeed");
  assert.ok(
    stdout.includes("module") || stdout.includes("type") || stdout.includes("ESM"),
    "should describe module-type options"
  );
});

test("module-type --json returns module type info", async () => {
  const dir = await makeTempDir("better-module-type-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      type: "commonjs"
    });

    const { stdout } = await runBetter(["module-type", "--json"], dir);
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("module-type"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── gen-types ─────────────────────────────────────────────────────────────────

test("gen-types --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["gen-types", "--help"], process.cwd());
  assert.ok(ok, "gen-types --help should succeed");
  assert.ok(
    stdout.includes("gen-types") || stdout.includes("types") || stdout.includes("typescript"),
    "should describe gen-types options"
  );
});

test("gen-types --json checks type definitions", async () => {
  const dir = await makeTempDir("better-gen-types-");
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

    const { stdout, ok } = await runBetter(["gen-types", "--json"], dir);
    assert.ok(ok, "gen-types should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("gen-types"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── git-check ─────────────────────────────────────────────────────────────────

test("git-check --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["git-check", "--help"], process.cwd());
  assert.ok(ok, "git-check --help should succeed");
  assert.ok(
    stdout.includes("git") || stdout.includes("branch") || stdout.includes("check"),
    "should describe git-check options"
  );
});

test("git-check --json returns git repository status", async () => {
  const { stdout } = await runBetter(["git-check", "--json"], process.cwd());
  if (stdout.trim()) {
    const out = JSON.parse(stdout);
    assert.ok(typeof out.ok === "boolean", "should have ok field");
    assert.ok(out.kind?.includes("git-check"), `unexpected kind: ${out.kind}`);
    assert.ok(Array.isArray(out.checks ?? []), "should have checks array");
  }
});

// ── health-score ──────────────────────────────────────────────────────────────

test("health-score --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["health-score", "--help"], process.cwd());
  assert.ok(ok, "health-score --help should succeed");
  assert.ok(
    stdout.includes("health") || stdout.includes("score") || stdout.includes("grade"),
    "should describe health-score options"
  );
});

test("health-score --json returns project health score", async () => {
  const dir = await makeTempDir("better-health-score-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      description: "A test project",
      license: "MIT"
    });

    const { stdout, ok } = await runBetter(["health-score", "--json"], dir);
    assert.ok(ok, "health-score should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("health-score"), `unexpected kind: ${out.kind}`);
      assert.ok(typeof out.score === "number", "should have numeric score");
    }
  } finally {
    await rmrf(dir);
  }
});

// ── health-dashboard ──────────────────────────────────────────────────────────

test("health-dashboard --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["health-dashboard", "--help"], process.cwd());
  assert.ok(ok, "health-dashboard --help should succeed");
  assert.ok(
    stdout.includes("dashboard") || stdout.includes("health") || stdout.includes("dimension"),
    "should describe health-dashboard options"
  );
});

test("health-dashboard --json returns health dashboard", async () => {
  const dir = await makeTempDir("better-health-dashboard-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      description: "A test project",
      license: "MIT"
    });

    const { stdout, ok } = await runBetter(["health-dashboard", "--json"], dir);
    assert.ok(ok, "health-dashboard should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("health-dashboard"), `unexpected kind: ${out.kind}`);
      assert.ok(typeof out.overallScore === "number", "should have overallScore");
    }
  } finally {
    await rmrf(dir);
  }
});
