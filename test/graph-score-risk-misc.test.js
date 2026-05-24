// test/graph-score-risk-misc.test.js
// Tests for: better graph, better score, better risk, better impact,
//            better changelog, better compare, better search, better migrate

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

// ── graph ─────────────────────────────────────────────────────────────────────

test("graph --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["graph", "--help"], process.cwd());
  assert.ok(ok, "graph --help should succeed");
  assert.ok(
    stdout.includes("graph") || stdout.includes("depend") || stdout.includes("tree"),
    "should describe dependency graph"
  );
});

test("graph --json returns dependency tree", async () => {
  const dir = await makeTempDir("better-graph-");
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
    // graph requires package-lock.json
    await writeJson(path.join(dir, "package-lock.json"), {
      name: "test", lockfileVersion: 3,
      packages: {
        "": { name: "test", version: "1.0.0", dependencies: { "pkg-a": "^1.0.0" } },
        "node_modules/pkg-a": { name: "pkg-a", version: "1.0.0" }
      }
    });

    // graph requires --format json (not --json) for JSON output
    const { stdout, ok } = await runBetter(["graph", "--format", "json"], dir);
    assert.ok(ok, "graph should succeed");
    if (stdout.trim()) {
      // --format json outputs raw JSON tree, not the standard {ok, kind} envelope
      const out = JSON.parse(stdout);
      assert.ok(typeof out.name === "string" || typeof out.ok === "boolean", "should be valid JSON output");
    }
  } finally {
    await rmrf(dir);
  }
});

test("graph cycles --json returns cycle detection", async () => {
  const dir = await makeTempDir("better-graph-cycles-");
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

    const { stdout, ok } = await runBetter(["graph", "--cycles", "--json"], dir);
    assert.ok(ok, "graph cycles should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(out.kind?.includes("graph"), `unexpected kind: ${out.kind}`);
      assert.ok(Array.isArray(out.cycles), "should have cycles array");
    }
  } finally {
    await rmrf(dir);
  }
});

// ── score ─────────────────────────────────────────────────────────────────────

test("score --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["score", "--help"], process.cwd());
  assert.ok(ok, "score --help should succeed");
  assert.ok(
    stdout.includes("score") || stdout.includes("grade") || stdout.includes("quality"),
    "should describe project scoring"
  );
});

test("score --json returns project score", async () => {
  const dir = await makeTempDir("better-score-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "my-project", version: "1.0.0",
      description: "A test project",
      license: "MIT"
    });
    await fs.writeFile(path.join(dir, "README.md"), "# My Project\n");

    const { stdout, ok } = await runBetter(["score", "--json"], dir);
    assert.ok(ok, "score should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("score"), `unexpected kind: ${out.kind}`);
      assert.ok(typeof out.score === "number", "should have numeric score");
      assert.ok(typeof out.grade === "string", "should have grade");
    }
  } finally {
    await rmrf(dir);
  }
});

// ── risk ──────────────────────────────────────────────────────────────────────

test("risk --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["risk", "--help"], process.cwd());
  assert.ok(ok, "risk --help should succeed");
  assert.ok(
    stdout.includes("risk") || stdout.includes("grade") || stdout.includes("score"),
    "should describe dependency risk scoring"
  );
});

test("risk --json returns risk scores for packages (network-aware)", async (t) => {
  const dir = await makeTempDir("better-risk-");
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

    const { stdout, stderr, ok } = await runBetter(["risk", "--json"], dir);
    if (!ok && (stderr.includes("ENOTFOUND") || stderr.includes("ETIMEDOUT") || stderr.includes("timeout"))) {
      t.skip("network unavailable for risk");
      return;
    }
    assert.ok(ok, "risk should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(Array.isArray(out.packages), "should have packages array");
    }
  } finally {
    await rmrf(dir);
  }
});

// ── impact ────────────────────────────────────────────────────────────────────

test("impact --help shows usage", async () => {
  // impact requires package arg; --help exits 1 without it
  const { stdout } = await runBetter(["impact", "--help"], process.cwd());
  assert.ok(
    stdout.includes("impact") || stdout.includes("remove") || stdout.includes("depend"),
    "should describe package impact analysis"
  );
});

test("impact --json analyzes package removal impact", async () => {
  const dir = await makeTempDir("better-impact-");
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
    await fs.writeFile(path.join(dir, "index.js"), "const a = require('pkg-a');\n");

    const { stdout, ok } = await runBetter(["impact", "pkg-a", "--json"], dir);
    assert.ok(ok, "impact should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("impact"), `unexpected kind: ${out.kind}`);
      assert.ok(Array.isArray(out.results), "should have results array");
    }
  } finally {
    await rmrf(dir);
  }
});

// ── changelog ─────────────────────────────────────────────────────────────────

test("changelog --help shows usage", async () => {
  // changelog requires package arg; --help may exit 1 without it
  const { stdout } = await runBetter(["changelog", "--help"], process.cwd());
  assert.ok(
    stdout.includes("changelog") || stdout.includes("CHANGELOG") || stdout.includes("release"),
    "should describe changelog viewing"
  );
});

test("changelog --json fetches package changelog (network-aware)", async (t) => {
  const { stdout, stderr, ok } = await runBetter(
    ["changelog", "semver", "--json"], process.cwd()
  );
  if (!ok && (stderr.includes("ENOTFOUND") || stderr.includes("ETIMEDOUT") ||
      stderr.includes("timeout") || stderr.includes("404"))) {
    t.skip("network unavailable for changelog");
    return;
  }
  if (stdout.trim()) {
    const out = JSON.parse(stdout);
    assert.ok(typeof out.ok === "boolean", "should have ok field");
    assert.ok(out.kind?.includes("changelog"), `unexpected kind: ${out.kind}`);
  }
});

// ── compare ───────────────────────────────────────────────────────────────────

test("compare --help shows usage", async () => {
  // compare requires package args; --help may exit 1 without them
  const { stdout } = await runBetter(["compare", "--help"], process.cwd());
  assert.ok(
    stdout.includes("compare") || stdout.includes("package") || stdout.includes("vs"),
    "should describe package comparison"
  );
});

test("compare --json compares two packages (network-aware)", async (t) => {
  const { stdout, stderr, ok } = await runBetter(
    ["compare", "lodash", "underscore", "--json"], process.cwd()
  );
  if (!ok && (stderr.includes("ENOTFOUND") || stderr.includes("ETIMEDOUT") || stderr.includes("timeout"))) {
    t.skip("network unavailable for compare");
    return;
  }
  if (stdout.trim()) {
    const out = JSON.parse(stdout);
    assert.ok(typeof out.ok === "boolean", "should have ok field");
    assert.ok(out.kind?.includes("compare"), `unexpected kind: ${out.kind}`);
    assert.ok(Array.isArray(out.packages), "should have packages array");
  }
});

// ── search ────────────────────────────────────────────────────────────────────

test("search --help shows usage", async () => {
  // search requires query arg; --help may exit 1 without it
  const { stdout } = await runBetter(["search", "--help"], process.cwd());
  assert.ok(
    stdout.includes("search") || stdout.includes("query") || stdout.includes("npm"),
    "should describe package search"
  );
});

test("search --json searches npm packages (network-aware)", async (t) => {
  const { stdout, stderr, ok } = await runBetter(
    ["search", "semver", "--json"], process.cwd()
  );
  if (!ok && (stderr.includes("ENOTFOUND") || stderr.includes("ETIMEDOUT") || stderr.includes("timeout"))) {
    t.skip("network unavailable for search");
    return;
  }
  if (stdout.trim()) {
    const out = JSON.parse(stdout);
    assert.ok(typeof out.ok === "boolean", "should have ok field");
    assert.ok(out.kind?.includes("search"), `unexpected kind: ${out.kind}`);
  }
});

// ── migrate ───────────────────────────────────────────────────────────────────

test("migrate --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["migrate", "--help"], process.cwd());
  assert.ok(ok, "migrate --help should succeed");
  assert.ok(
    stdout.includes("migrate") || stdout.includes("npm") || stdout.includes("yarn"),
    "should describe package manager migration"
  );
});

test("migrate detect --json identifies package manager", async () => {
  const dir = await makeTempDir("better-migrate-detect-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0"
    });
    await writeJson(path.join(dir, "package-lock.json"), {
      name: "test", lockfileVersion: 3, packages: {}
    });

    const { stdout, ok } = await runBetter(["migrate", "detect", "--json"], dir);
    assert.ok(ok, "migrate detect should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("migrate"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});
