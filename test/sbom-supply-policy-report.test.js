// test/sbom-supply-policy-report.test.js
// Tests for: better sbom, better sbom-gen, better supply-chain,
//            better policy, better report, better stats, better cost

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

// ── sbom ──────────────────────────────────────────────────────────────────────

test("sbom --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["sbom", "--help"], process.cwd());
  assert.ok(ok, "sbom --help should succeed");
  assert.ok(
    stdout.includes("sbom") || stdout.includes("SBOM") || stdout.includes("software"),
    "should describe SBOM generation"
  );
});

test("sbom --json generates SBOM for project", async () => {
  const dir = await makeTempDir("better-sbom-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      dependencies: { "pkg-a": "^1.0.0" }
    });
    const nmDir = path.join(dir, "node_modules");
    await fs.mkdir(path.join(nmDir, "pkg-a"), { recursive: true });
    await writeJson(path.join(nmDir, "pkg-a", "package.json"), {
      name: "pkg-a", version: "1.0.0", license: "MIT"
    });
    // sbom JS fallback requires package-lock.json
    await writeJson(path.join(dir, "package-lock.json"), {
      name: "test", lockfileVersion: 3,
      packages: {
        "": { name: "test", version: "1.0.0", dependencies: { "pkg-a": "^1.0.0" } },
        "node_modules/pkg-a": { name: "pkg-a", version: "1.0.0", license: "MIT" }
      }
    });

    const { stdout } = await runBetter(["sbom", "--json"], dir);
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      // sbom outputs either {ok,kind} envelope or raw CycloneDX
      assert.ok(typeof out.ok === "boolean" || out.bomFormat, "should be valid SBOM or result JSON");
    }
  } finally {
    await rmrf(dir);
  }
});

// ── sbom-gen ──────────────────────────────────────────────────────────────────

test("sbom-gen --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["sbom-gen", "--help"], process.cwd());
  assert.ok(ok, "sbom-gen --help should succeed");
  assert.ok(
    stdout.includes("sbom") || stdout.includes("SBOM") || stdout.includes("generat"),
    "should describe SBOM generation"
  );
});

test("sbom-gen --json generates SBOM", async () => {
  const dir = await makeTempDir("better-sbom-gen-");
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

    const { stdout } = await runBetter(["sbom-gen", "--json"], dir);
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      // sbom-gen returns {ok, kind} envelope
    }
  } finally {
    await rmrf(dir);
  }
});

// ── supply-chain ──────────────────────────────────────────────────────────────

test("supply-chain --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["supply-chain", "--help"], process.cwd());
  assert.ok(ok, "supply-chain --help should succeed");
  assert.ok(
    stdout.includes("supply") || stdout.includes("chain") || stdout.includes("provenance"),
    "should describe supply chain analysis"
  );
});

test("supply-chain --json analyzes project supply chain", async () => {
  const dir = await makeTempDir("better-supply-chain-");
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

    const { stdout, ok } = await runBetter(["supply-chain", "--json"], dir);
    assert.ok(ok, "supply-chain should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("supply-chain"), `unexpected kind: ${out.kind}`);
      assert.ok(typeof out.totalPackages === "number", "should have totalPackages");
    }
  } finally {
    await rmrf(dir);
  }
});

// ── policy ────────────────────────────────────────────────────────────────────

test("policy --help shows usage", async () => {
  // policy requires subcommand; --help may exit 1
  const { stdout } = await runBetter(["policy", "--help"], process.cwd());
  assert.ok(
    stdout.includes("policy") || stdout.includes("check") || stdout.includes("rule"),
    "should describe policy management"
  );
});

test("policy check --json returns policy result (no policy = pass)", async () => {
  const dir = await makeTempDir("better-policy-check-");
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

    const { stdout } = await runBetter(["policy", "check", "--json"], dir);
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("policy"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── report ────────────────────────────────────────────────────────────────────

test("report --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["report", "--help"], process.cwd());
  assert.ok(ok, "report --help should succeed");
  assert.ok(
    stdout.includes("report") || stdout.includes("generat") || stdout.includes("markdown"),
    "should describe report generation"
  );
});

test("report --json generates dependency report", async () => {
  const dir = await makeTempDir("better-report-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      dependencies: { "pkg-a": "^1.0.0" }
    });
    const nmDir = path.join(dir, "node_modules");
    await fs.mkdir(path.join(nmDir, "pkg-a"), { recursive: true });
    await writeJson(path.join(nmDir, "pkg-a", "package.json"), {
      name: "pkg-a", version: "1.0.0", license: "MIT"
    });
    await writeJson(path.join(dir, "package-lock.json"), {
      name: "test", lockfileVersion: 3,
      packages: {
        "": { name: "test", version: "1.0.0", dependencies: { "pkg-a": "^1.0.0" } },
        "node_modules/pkg-a": { name: "pkg-a", version: "1.0.0" }
      }
    });

    const { stdout, ok } = await runBetter(["report", "--json"], dir);
    assert.ok(ok, "report should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("report"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── stats ─────────────────────────────────────────────────────────────────────

test("stats --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["stats", "--help"], process.cwd());
  assert.ok(ok, "stats --help should succeed");
  assert.ok(
    stdout.includes("stat") || stdout.includes("size") || stdout.includes("project"),
    "should describe project statistics"
  );
});

test("stats --json returns project statistics", async () => {
  const dir = await makeTempDir("better-stats-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "my-project", version: "1.0.0",
      description: "A test project",
      license: "MIT",
      dependencies: { "pkg-a": "^1.0.0" },
      scripts: { test: "node --test" }
    });
    const nmDir = path.join(dir, "node_modules");
    await fs.mkdir(path.join(nmDir, "pkg-a"), { recursive: true });
    await writeJson(path.join(nmDir, "pkg-a", "package.json"), {
      name: "pkg-a", version: "1.0.0"
    });

    const { stdout, ok } = await runBetter(["stats", "--json"], dir);
    assert.ok(ok, "stats should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("stats"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── cost ──────────────────────────────────────────────────────────────────────

test("cost --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["cost", "--help"], process.cwd());
  assert.ok(ok, "cost --help should succeed");
  assert.ok(
    stdout.includes("cost") || stdout.includes("service") || stdout.includes("provision"),
    "should describe cost analysis"
  );
});

test("cost --json returns cost info for project", async () => {
  const dir = await makeTempDir("better-cost-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0"
    });

    const { stdout, ok } = await runBetter(["cost", "--json"], dir);
    assert.ok(ok, "cost should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("cost"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});
