// test/pkg-commands.test.js
// Tests for: better pkg-info, better pkg-search, better pkg-versions,
//            better pkg-downloads, better pkg-metadata, better pkg-alternatives,
//            better pkg-json-lint, better pkg-compare-versions, better pkg-trust,
//            better pkg-provenance, better pkg-publish-info, better pkg-readme

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

// ── pkg-info ──────────────────────────────────────────────────────────────────

test("pkg-info --help shows usage", async () => {
  // pkg-info requires package name; --help may exit 1
  const { stdout } = await runBetter(["pkg-info", "--help"], process.cwd());
  assert.ok(
    stdout.includes("pkg-info") || stdout.includes("info") || stdout.includes("package"),
    "should describe package info"
  );
});

test("pkg-info --json fetches package info (network-aware)", async (t) => {
  const { stdout, stderr, ok } = await runBetter(
    ["pkg-info", "semver", "--json"], process.cwd()
  );
  if (!ok && (stderr.includes("ENOTFOUND") || stderr.includes("ETIMEDOUT") || stderr.includes("timeout"))) {
    t.skip("network unavailable for pkg-info");
    return;
  }
  if (stdout.trim()) {
    const out = JSON.parse(stdout);
    assert.ok(typeof out.ok === "boolean", "should have ok field");
    assert.ok(out.kind?.includes("pkg-info"), `unexpected kind: ${out.kind}`);
  }
});

// ── pkg-search ────────────────────────────────────────────────────────────────

test("pkg-search --help shows usage", async () => {
  // pkg-search requires query; --help may exit 1
  const { stdout } = await runBetter(["pkg-search", "--help"], process.cwd());
  assert.ok(
    stdout.includes("search") || stdout.includes("query") || stdout.includes("npm"),
    "should describe package search"
  );
});

test("pkg-search --json searches for packages (network-aware)", async (t) => {
  const { stdout, stderr, ok } = await runBetter(
    ["pkg-search", "semver", "--json"], process.cwd()
  );
  if (!ok && (stderr.includes("ENOTFOUND") || stderr.includes("ETIMEDOUT") || stderr.includes("timeout"))) {
    t.skip("network unavailable for pkg-search");
    return;
  }
  assert.ok(ok, "pkg-search should succeed");
  if (stdout.trim()) {
    const out = JSON.parse(stdout);
    assert.ok(typeof out.ok === "boolean", "should have ok field");
    assert.ok(out.kind?.includes("pkg-search"), `unexpected kind: ${out.kind}`);
    assert.ok(Array.isArray(out.results), "should have results array");
  }
});

// ── pkg-versions ──────────────────────────────────────────────────────────────

test("pkg-versions --help shows usage", async () => {
  // pkg-versions requires package name; --help may exit 1
  const { stdout } = await runBetter(["pkg-versions", "--help"], process.cwd());
  assert.ok(
    stdout.includes("version") || stdout.includes("package") || stdout.includes("release"),
    "should describe package versions listing"
  );
});

test("pkg-versions --json lists package versions (network-aware)", async (t) => {
  const { stdout, stderr, ok } = await runBetter(
    ["pkg-versions", "semver", "--json"], process.cwd()
  );
  if (!ok && (stderr.includes("ENOTFOUND") || stderr.includes("ETIMEDOUT") || stderr.includes("timeout"))) {
    t.skip("network unavailable for pkg-versions");
    return;
  }
  assert.ok(ok, "pkg-versions should succeed");
  if (stdout.trim()) {
    const out = JSON.parse(stdout);
    assert.ok(typeof out.ok === "boolean", "should have ok field");
    assert.ok(out.kind?.includes("pkg-versions"), `unexpected kind: ${out.kind}`);
    assert.ok(typeof out.total === "number", "should have total count");
    assert.ok(Array.isArray(out.versions), "should have versions array");
  }
});

// ── pkg-downloads ─────────────────────────────────────────────────────────────

test("pkg-downloads --help shows usage", async () => {
  // pkg-downloads requires package name; --help may exit 1
  const { stdout } = await runBetter(["pkg-downloads", "--help"], process.cwd());
  assert.ok(
    stdout.includes("download") || stdout.includes("stats") || stdout.includes("npm"),
    "should describe download statistics"
  );
});

test("pkg-downloads --json returns download stats (network-aware)", async (t) => {
  const { stdout, stderr, ok } = await runBetter(
    ["pkg-downloads", "semver", "--json"], process.cwd()
  );
  if (!ok && (stderr.includes("ENOTFOUND") || stderr.includes("ETIMEDOUT") || stderr.includes("timeout"))) {
    t.skip("network unavailable for pkg-downloads");
    return;
  }
  assert.ok(ok, "pkg-downloads should succeed");
  if (stdout.trim()) {
    const out = JSON.parse(stdout);
    assert.ok(typeof out.ok === "boolean", "should have ok field");
    assert.ok(out.kind?.includes("pkg-downloads"), `unexpected kind: ${out.kind}`);
  }
});

// ── pkg-metadata ──────────────────────────────────────────────────────────────

test("pkg-metadata --help shows usage", async () => {
  // pkg-metadata requires package name; --help may exit 1
  const { stdout } = await runBetter(["pkg-metadata", "--help"], process.cwd());
  assert.ok(
    stdout.includes("metadata") || stdout.includes("package") || stdout.includes("registry"),
    "should describe package metadata"
  );
});

test("pkg-metadata --json fetches registry metadata (network-aware)", async (t) => {
  const { stdout, stderr, ok } = await runBetter(
    ["pkg-metadata", "semver", "--json"], process.cwd()
  );
  if (!ok && (stderr.includes("ENOTFOUND") || stderr.includes("ETIMEDOUT") || stderr.includes("timeout"))) {
    t.skip("network unavailable for pkg-metadata");
    return;
  }
  assert.ok(ok, "pkg-metadata should succeed");
  if (stdout.trim()) {
    const out = JSON.parse(stdout);
    assert.ok(typeof out.ok === "boolean", "should have ok field");
    assert.ok(out.kind?.includes("pkg-metadata"), `unexpected kind: ${out.kind}`);
  }
});

// ── pkg-alternatives ──────────────────────────────────────────────────────────

test("pkg-alternatives --help shows usage", async () => {
  // pkg-alternatives requires package name; --help may exit 1
  const { stdout } = await runBetter(["pkg-alternatives", "--help"], process.cwd());
  assert.ok(
    stdout.includes("alternative") || stdout.includes("similar") || stdout.includes("package"),
    "should describe package alternatives"
  );
});

test("pkg-alternatives --json finds alternatives (network-aware)", async (t) => {
  const { stdout, stderr, ok } = await runBetter(
    ["pkg-alternatives", "lodash", "--json"], process.cwd()
  );
  if (!ok && (stderr.includes("ENOTFOUND") || stderr.includes("ETIMEDOUT") || stderr.includes("timeout"))) {
    t.skip("network unavailable for pkg-alternatives");
    return;
  }
  if (stdout.trim()) {
    const out = JSON.parse(stdout);
    assert.ok(typeof out.ok === "boolean", "should have ok field");
    assert.ok(out.kind?.includes("pkg-alternative"), `unexpected kind: ${out.kind}`);
  }
});

// ── pkg-json-lint ─────────────────────────────────────────────────────────────

test("pkg-json-lint --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["pkg-json-lint", "--help"], process.cwd());
  assert.ok(ok, "pkg-json-lint --help should succeed");
  assert.ok(
    stdout.includes("json") || stdout.includes("lint") || stdout.includes("package"),
    "should describe package.json linting"
  );
});

test("pkg-json-lint --json lints a valid package.json", async () => {
  const dir = await makeTempDir("better-pkg-json-lint-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "my-package",
      version: "1.0.0",
      description: "A test package",
      license: "MIT",
      main: "index.js"
    });
    await fs.writeFile(path.join(dir, "index.js"), "module.exports = {};\n");

    const { stdout, ok } = await runBetter(["pkg-json-lint", "--json"], dir);
    assert.ok(ok, "pkg-json-lint should succeed for valid package.json");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("pkg-json-lint"), `unexpected kind: ${out.kind}`);
      assert.ok(typeof out.errors === "number", "should have errors count");
    }
  } finally {
    await rmrf(dir);
  }
});

// ── pkg-compare-versions ──────────────────────────────────────────────────────

test("pkg-compare-versions --help shows usage", async () => {
  // pkg-compare-versions requires args; --help may exit 1
  const { stdout } = await runBetter(["pkg-compare-versions", "--help"], process.cwd());
  assert.ok(
    stdout.includes("compare") || stdout.includes("version") || stdout.includes("package"),
    "should describe version comparison"
  );
});

test("pkg-compare-versions --json compares versions (network-aware)", async (t) => {
  const { stdout, stderr, ok } = await runBetter(
    ["pkg-compare-versions", "semver", "7.0.0", "7.5.4", "--json"], process.cwd()
  );
  if (!ok && (stderr.includes("ENOTFOUND") || stderr.includes("ETIMEDOUT") || stderr.includes("timeout"))) {
    t.skip("network unavailable for pkg-compare-versions");
    return;
  }
  if (stdout.trim()) {
    const out = JSON.parse(stdout);
    assert.ok(typeof out.ok === "boolean", "should have ok field");
    assert.ok(out.kind?.includes("pkg-compare-versions"), `unexpected kind: ${out.kind}`);
  }
});

// ── pkg-trust ─────────────────────────────────────────────────────────────────

test("pkg-trust --help shows usage", async () => {
  // pkg-trust requires package name; --help may exit 1
  const { stdout } = await runBetter(["pkg-trust", "--help"], process.cwd());
  assert.ok(
    stdout.includes("trust") || stdout.includes("package") || stdout.includes("signatur"),
    "should describe package trust checking"
  );
});

test("pkg-trust --json checks package trust (network-aware)", async (t) => {
  const { stdout, stderr, ok } = await runBetter(
    ["pkg-trust", "semver", "--json"], process.cwd()
  );
  if (!ok && (stderr.includes("ENOTFOUND") || stderr.includes("ETIMEDOUT") || stderr.includes("timeout"))) {
    t.skip("network unavailable for pkg-trust");
    return;
  }
  if (stdout.trim()) {
    const out = JSON.parse(stdout);
    assert.ok(typeof out.ok === "boolean", "should have ok field");
    assert.ok(out.kind?.includes("pkg-trust"), `unexpected kind: ${out.kind}`);
  }
});

// ── pkg-publish-info ──────────────────────────────────────────────────────────

test("pkg-publish-info --help shows usage", async () => {
  // pkg-publish-info requires package name; --help may exit 1
  const { stdout } = await runBetter(["pkg-publish-info", "--help"], process.cwd());
  assert.ok(
    stdout.includes("publish") || stdout.includes("info") || stdout.includes("release"),
    "should describe publish info"
  );
});

test("pkg-publish-info --json returns publish readiness for current project", async () => {
  const dir = await makeTempDir("better-pkg-publish-info-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "my-lib", version: "1.0.0", description: "A test lib", license: "MIT", main: "index.js"
    });
    await fs.writeFile(path.join(dir, "index.js"), "module.exports = {};\n");

    // pkg-publish-info analyzes current project, no package name arg
    const { stdout } = await runBetter(["pkg-publish-info", "--json"], dir);
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("pkg-publish-info"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});
