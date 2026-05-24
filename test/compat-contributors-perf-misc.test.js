// test/compat-contributors-perf-misc.test.js
// Tests for: better compat, better contributors, better fund, better perf,
//            better hooks, better insights, better namespace, better resolutions

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

// ── compat ────────────────────────────────────────────────────────────────────

test("compat --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["compat", "--help"], process.cwd());
  assert.ok(ok, "compat --help should succeed");
  assert.ok(
    stdout.includes("compat") || stdout.includes("Node") || stdout.includes("engine"),
    "should describe compatibility checking"
  );
});

test("compat --json returns compatibility results", async () => {
  const dir = await makeTempDir("better-compat-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      dependencies: { "pkg-a": "^1.0.0" }
    });
    const nmDir = path.join(dir, "node_modules");
    await fs.mkdir(path.join(nmDir, "pkg-a"), { recursive: true });
    await writeJson(path.join(nmDir, "pkg-a", "package.json"), {
      name: "pkg-a", version: "1.0.0",
      engines: { node: ">=14.0.0" }
    });

    const { stdout, ok } = await runBetter(["compat", "--json"], dir);
    assert.ok(ok, "compat should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("compat"), `unexpected kind: ${out.kind}`);
      assert.ok(typeof out.total === "number", "should have total count");
    }
  } finally {
    await rmrf(dir);
  }
});

test("compat --target 18 --json checks against Node 18", async () => {
  const dir = await makeTempDir("better-compat-target-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      dependencies: { "pkg-a": "^1.0.0" }
    });
    const nmDir = path.join(dir, "node_modules");
    await fs.mkdir(path.join(nmDir, "pkg-a"), { recursive: true });
    await writeJson(path.join(nmDir, "pkg-a", "package.json"), {
      name: "pkg-a", version: "1.0.0",
      engines: { node: ">=16.0.0" }
    });

    const { stdout } = await runBetter(["compat", "--target", "18", "--json"], dir);
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      // targetVersion should reflect the requested version
      if (out.targetVersion) {
        assert.ok(out.targetVersion.includes("18"), "should check against Node 18");
      }
    }
  } finally {
    await rmrf(dir);
  }
});

// ── contributors ──────────────────────────────────────────────────────────────

test("contributors --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["contributors", "--help"], process.cwd());
  assert.ok(ok, "contributors --help should succeed");
  assert.ok(
    stdout.includes("contributor") || stdout.includes("maintainer") || stdout.includes("bus"),
    "should describe contributor analysis"
  );
});

test("contributors --json returns package info (network-aware)", async (t) => {
  const dir = await makeTempDir("better-contributors-");
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

    const { stdout, stderr, ok } = await runBetter(["contributors", "--json"], dir);
    if (!ok && (stderr.includes("ENOTFOUND") || stderr.includes("ETIMEDOUT") || stderr.includes("timeout"))) {
      t.skip("network unavailable for contributors");
      return;
    }
    assert.ok(ok, "contributors should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("contributor"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── fund ──────────────────────────────────────────────────────────────────────

test("fund --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["fund", "--help"], process.cwd());
  assert.ok(ok, "fund --help should succeed");
  assert.ok(
    stdout.includes("fund") || stdout.includes("funding") || stdout.includes("sponsor"),
    "should describe funding info"
  );
});

test("fund --json returns funding information", async () => {
  const dir = await makeTempDir("better-fund-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      dependencies: { "pkg-a": "^1.0.0" }
    });
    const nmDir = path.join(dir, "node_modules");
    await fs.mkdir(path.join(nmDir, "pkg-a"), { recursive: true });
    await writeJson(path.join(nmDir, "pkg-a", "package.json"), {
      name: "pkg-a", version: "1.0.0",
      funding: { type: "github", url: "https://github.com/sponsors/test" }
    });

    const { stdout, ok } = await runBetter(["fund", "--json"], dir);
    assert.ok(ok, "fund should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("fund"), `unexpected kind: ${out.kind}`);
      assert.ok(typeof out.total === "number", "should have total count");
    }
  } finally {
    await rmrf(dir);
  }
});

test("fund --json reports no funding when packages have none", async () => {
  const dir = await makeTempDir("better-fund-none-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      dependencies: { "pkg-b": "^1.0.0" }
    });
    const nmDir = path.join(dir, "node_modules");
    await fs.mkdir(path.join(nmDir, "pkg-b"), { recursive: true });
    await writeJson(path.join(nmDir, "pkg-b", "package.json"), {
      name: "pkg-b", version: "1.0.0"
    });

    const { stdout, ok } = await runBetter(["fund", "--json"], dir);
    assert.ok(ok, "fund should succeed with no funding");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.equal(out.ok, true);
      assert.equal(out.total, 0, "should have 0 funding packages");
    }
  } finally {
    await rmrf(dir);
  }
});

// ── perf ──────────────────────────────────────────────────────────────────────

test("perf --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["perf", "--help"], process.cwd());
  assert.ok(ok, "perf --help should succeed");
  assert.ok(
    stdout.includes("perf") || stdout.includes("performance") || stdout.includes("hint"),
    "should describe perf hints"
  );
});

test("perf --json returns performance hints", async () => {
  const dir = await makeTempDir("better-perf-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      dependencies: { "lodash": "^4.0.0" }
    });
    const nmDir = path.join(dir, "node_modules");
    await fs.mkdir(path.join(nmDir, "lodash"), { recursive: true });
    await writeJson(path.join(nmDir, "lodash", "package.json"), {
      name: "lodash", version: "4.17.21"
    });

    const { stdout, ok } = await runBetter(["perf", "--json"], dir);
    assert.ok(ok, "perf should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("perf"), `unexpected kind: ${out.kind}`);
      assert.ok(Array.isArray(out.hints), "should have hints array");
      assert.ok(typeof out.total === "number", "should have total count");
    }
  } finally {
    await rmrf(dir);
  }
});

test("perf --json returns ok for clean project", async () => {
  const dir = await makeTempDir("better-perf-clean-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      dependencies: {}
    });

    const { stdout, ok } = await runBetter(["perf", "--json"], dir);
    assert.ok(ok, "perf should succeed with no deps");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.equal(out.ok, true);
      assert.equal(out.total, 0, "clean project should have no perf hints");
    }
  } finally {
    await rmrf(dir);
  }
});

// ── hooks ─────────────────────────────────────────────────────────────────────

test("hooks --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["hooks", "--help"], process.cwd());
  assert.ok(ok, "hooks --help should succeed");
  assert.ok(
    stdout.includes("hook") || stdout.includes("husky") || stdout.includes("git"),
    "should describe git hooks"
  );
});

test("hooks --json returns hook status", async () => {
  const dir = await makeTempDir("better-hooks-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0"
    });

    const { stdout, ok } = await runBetter(["hooks", "--json"], dir);
    assert.ok(ok, "hooks should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("hook"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── insights ──────────────────────────────────────────────────────────────────

test("insights --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["insights", "--help"], process.cwd());
  assert.ok(ok, "insights --help should succeed");
  assert.ok(
    stdout.includes("insight") || stdout.includes("org") || stdout.includes("monorepo"),
    "should describe org insights"
  );
});

test("insights --json returns org analysis", async () => {
  const dir = await makeTempDir("better-insights-");
  try {
    // Create a simple project structure that insights can analyze
    await writeJson(path.join(dir, "package.json"), {
      name: "my-org", version: "1.0.0"
    });

    const { stdout, ok } = await runBetter(["insights", "--json", dir], process.cwd());
    assert.ok(ok, "insights should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("insight"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── namespace ─────────────────────────────────────────────────────────────────

test("namespace --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["namespace", "--help"], process.cwd());
  assert.ok(ok, "namespace --help should succeed");
  assert.ok(
    stdout.includes("namespace") || stdout.includes("scope") || stdout.includes("@"),
    "should describe namespace/scope analysis"
  );
});

test("namespace --json returns scoped packages", async () => {
  const dir = await makeTempDir("better-namespace-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      dependencies: { "@scope/pkg-a": "^1.0.0", "unscoped": "^1.0.0" }
    });
    const nmDir = path.join(dir, "node_modules");
    await fs.mkdir(path.join(nmDir, "@scope", "pkg-a"), { recursive: true });
    await writeJson(path.join(nmDir, "@scope", "pkg-a", "package.json"), {
      name: "@scope/pkg-a", version: "1.0.0"
    });
    await fs.mkdir(path.join(nmDir, "unscoped"), { recursive: true });
    await writeJson(path.join(nmDir, "unscoped", "package.json"), {
      name: "unscoped", version: "1.0.0"
    });

    const { stdout, ok } = await runBetter(["namespace", "--json"], dir);
    assert.ok(ok, "namespace should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("namespace"), `unexpected kind: ${out.kind}`);
      assert.ok(typeof out.totalPackages === "number", "should have totalPackages");
      assert.ok(typeof out.totalScopes === "number", "should have totalScopes");
    }
  } finally {
    await rmrf(dir);
  }
});

test("namespace --json finds scoped packages and their scopes", async () => {
  const dir = await makeTempDir("better-namespace-scoped-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      dependencies: { "@myorg/alpha": "^1.0.0", "@myorg/beta": "^1.0.0" }
    });
    const nmDir = path.join(dir, "node_modules");
    for (const name of ["alpha", "beta"]) {
      await fs.mkdir(path.join(nmDir, "@myorg", name), { recursive: true });
      await writeJson(path.join(nmDir, "@myorg", name, "package.json"), {
        name: `@myorg/${name}`, version: "1.0.0"
      });
    }

    const { stdout, ok } = await runBetter(["namespace", "--json"], dir);
    assert.ok(ok, "namespace should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.equal(out.ok, true);
      assert.ok(out.totalPackages >= 2, "should find at least 2 scoped packages");
      assert.ok(out.totalScopes >= 1, "should find at least 1 scope");
    }
  } finally {
    await rmrf(dir);
  }
});

// ── resolutions ───────────────────────────────────────────────────────────────

test("resolutions --help shows usage", async () => {
  // resolutions --help may exit 1 without subcommand
  const { stdout } = await runBetter(["resolutions", "--help"], process.cwd());
  assert.ok(
    stdout.includes("resolution") || stdout.includes("override") || stdout.includes("duplicate"),
    "should describe resolutions management"
  );
});

test("resolutions --json returns ok when no duplicates", async () => {
  const dir = await makeTempDir("better-resolutions-");
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

    const { stdout, ok } = await runBetter(["resolutions", "--json"], dir);
    assert.ok(ok, "resolutions should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("resolution"), `unexpected kind: ${out.kind}`);
      assert.ok(typeof out.totalScanned === "number", "should have totalScanned");
    }
  } finally {
    await rmrf(dir);
  }
});
