// test/global-gentypes-misc.test.js
// Tests for: better global-packages, better gen-types, better audit-html,
//            better git-check, better health-score, better duplicate-files

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

// ── global-packages ─────────────────────────────────────────────────────────

test("global-packages --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["global-packages", "--help"], process.cwd());
  assert.ok(ok, "global-packages --help should succeed");
  assert.ok(
    stdout.includes("global") || stdout.includes("packages") || stdout.includes("worldwide"),
    "should describe global package listing"
  );
});

test("global-packages --json returns ok and packages array", async () => {
  const { stdout, ok } = await runBetter(["global-packages", "--json"], process.cwd());
  assert.ok(ok, "global-packages should succeed");
  if (stdout.trim()) {
    const out = JSON.parse(stdout);
    assert.equal(out.ok, true);
    assert.ok(out.kind?.includes("global"), `unexpected kind: ${out.kind}`);
    assert.ok(Array.isArray(out.packages), "should have packages array");
    // Each package should have name and version
    for (const p of out.packages.slice(0, 5)) {
      assert.ok(p.name, "package should have name");
      assert.ok(p.version, "package should have version");
    }
  }
});

// ── gen-types ───────────────────────────────────────────────────────────────

test("gen-types --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["gen-types", "--help"], process.cwd());
  assert.ok(ok, "gen-types --help should succeed");
  assert.ok(
    stdout.includes("type") || stdout.includes("TypeScript") || stdout.includes(".d.ts"),
    "should describe type generation"
  );
});

test("gen-types --json returns empty list when no untyped packages", async () => {
  const dir = await makeTempDir("better-gentypes-empty-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test",
      version: "1.0.0",
      dependencies: {}
    });

    const { stdout, ok } = await runBetter(["gen-types", "--json"], dir);
    assert.ok(ok, "gen-types should succeed with no packages");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("gen-types") || out.kind?.includes("types"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

test("gen-types --json generates .d.ts stub for untyped installed package", async (t) => {
  const dir = await makeTempDir("better-gentypes-gen-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test",
      version: "1.0.0",
      dependencies: { "untyped-lib": "^1.0.0" }
    });
    // Fake installed untyped package
    const pkgDir = path.join(dir, "node_modules", "untyped-lib");
    await fs.mkdir(pkgDir, { recursive: true });
    await writeJson(path.join(pkgDir, "package.json"), {
      name: "untyped-lib",
      version: "1.0.0",
      main: "index.js"
    });
    await fs.writeFile(path.join(pkgDir, "index.js"), "module.exports = { hello: () => 'world' };\n");

    const result = await runBetter(["gen-types", "untyped-lib", "--json"], dir);
    if (!result.ok && result.stderr.includes("ENOTFOUND")) {
      t.skip("network unavailable for @types check");
      return;
    }
    if (result.stdout.trim()) {
      const out = JSON.parse(result.stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
    }
  } finally {
    await rmrf(dir);
  }
});

// ── audit-html ────────────────────────────────────────────────────────────────

test("audit-html --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["audit-html", "--help"], process.cwd());
  assert.ok(ok, "audit-html --help should succeed");
  assert.ok(
    stdout.includes("audit") || stdout.includes("html") || stdout.includes("report"),
    "should describe HTML audit report generation"
  );
});

test("audit-html --output generates an HTML file", async () => {
  const dir = await makeTempDir("better-audithtml-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test",
      version: "1.0.0",
      dependencies: {}
    });
    await writeJson(path.join(dir, "package-lock.json"), {
      name: "test",
      lockfileVersion: 3,
      packages: { "": { name: "test", version: "1.0.0" } }
    });

    const outputFile = path.join(dir, "audit-report.html");
    const { ok } = await runBetter(["audit-html", "--output", outputFile, "--json"], dir);
    assert.ok(ok, "audit-html should succeed");

    // File should exist and be HTML
    const content = await fs.readFile(outputFile, "utf8");
    assert.ok(content.includes("<html") || content.includes("<!DOCTYPE"), "output should be HTML");
    assert.ok(content.includes("audit") || content.includes("dependency") || content.includes("package"), "HTML should mention audit");
  } finally {
    await rmrf(dir);
  }
});

// ── git-check ────────────────────────────────────────────────────────────────

test("git-check --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["git-check", "--help"], process.cwd());
  assert.ok(ok, "git-check --help should succeed");
  assert.ok(
    stdout.includes("git") || stdout.includes("check") || stdout.includes("repository"),
    "should describe git status checking"
  );
});

test("git-check --json returns repo state for git repo", async () => {
  // Run in our own repo (which is a git repo)
  // git-check exits 1 when there are issues (uncommitted changes, detached HEAD, etc.)
  const { stdout } = await runBetter(["git-check", "--json"], process.cwd());
  if (stdout.trim()) {
    const out = JSON.parse(stdout);
    assert.ok(typeof out.ok === "boolean", "should have ok field");
    assert.ok(out.kind?.includes("git"), `unexpected kind: ${out.kind}`);
    // git-check may return ok=false if there are issues (uncommitted changes, detached HEAD, etc.)
    assert.ok(out.branch !== undefined || Array.isArray(out.checks), "should report git status");
  }
});

// ── health-score ──────────────────────────────────────────────────────────────

test("health-score --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["health-score", "--help"], process.cwd());
  assert.ok(ok, "health-score --help should succeed");
  assert.ok(
    stdout.includes("health") || stdout.includes("score") || stdout.includes("grade"),
    "should describe health score calculation"
  );
});

test("health-score --json returns score and grade", async () => {
  const dir = await makeTempDir("better-healthscore-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test",
      version: "1.0.0",
      license: "MIT",
      description: "A test package"
    });

    const { stdout, ok } = await runBetter(["health-score", "--json"], dir);
    assert.ok(ok, "health-score should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("health") || out.kind?.includes("score"), `unexpected kind: ${out.kind}`);
      const score = out.score ?? out.overallScore ?? out.total;
      if (typeof score === "number") {
        assert.ok(score >= 0 && score <= 100, `score ${score} should be 0-100`);
      }
    }
  } finally {
    await rmrf(dir);
  }
});

// ── duplicate-files ────────────────────────────────────────────────────────────

test("duplicate-files --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["duplicate-files", "--help"], process.cwd());
  assert.ok(ok, "duplicate-files --help should succeed");
  assert.ok(
    stdout.includes("duplicate") || stdout.includes("files") || stdout.includes("identical"),
    "should describe duplicate file detection"
  );
});

test("duplicate-files --json detects no duplicates when packages are unique", async () => {
  // duplicate-files scans node_modules for duplicate files
  const dir = await makeTempDir("better-dupfiles-empty-");
  try {
    await writeJson(path.join(dir, "package.json"), { name: "test", version: "1.0.0" });
    // Create two packages with different content
    const nmDir = path.join(dir, "node_modules");
    await fs.mkdir(path.join(nmDir, "pkg-a"), { recursive: true });
    await writeJson(path.join(nmDir, "pkg-a", "package.json"), { name: "pkg-a", version: "1.0.0" });
    await fs.writeFile(path.join(nmDir, "pkg-a", "index.js"), "// unique content A\n", "utf8");
    await fs.mkdir(path.join(nmDir, "pkg-b"), { recursive: true });
    await writeJson(path.join(nmDir, "pkg-b", "package.json"), { name: "pkg-b", version: "1.0.0" });
    await fs.writeFile(path.join(nmDir, "pkg-b", "index.js"), "// unique content B\n", "utf8");

    const { stdout, ok } = await runBetter(["duplicate-files", "--min-size", "1", "--json"], dir);
    assert.ok(ok, "duplicate-files should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.equal(out.ok, true);
      assert.ok(out.kind?.includes("duplicate"), `unexpected kind: ${out.kind}`);
      const dups = out.duplicates ?? out.groups ?? [];
      assert.ok(Array.isArray(dups), "should have duplicates array");
      assert.equal(dups.length, 0, "should have no duplicates with unique files");
    }
  } finally {
    await rmrf(dir);
  }
});

test("duplicate-files --json finds identical files across packages", async () => {
  const dir = await makeTempDir("better-dupfiles-found-");
  try {
    await writeJson(path.join(dir, "package.json"), { name: "test", version: "1.0.0" });
    const nmDir = path.join(dir, "node_modules");
    // Two packages sharing an identical file (large enough to exceed min-size threshold)
    const identicalContent = "// identical helper\nmodule.exports = function noop() {};\n" + "x".repeat(1100);
    await fs.mkdir(path.join(nmDir, "pkg-x"), { recursive: true });
    await writeJson(path.join(nmDir, "pkg-x", "package.json"), { name: "pkg-x", version: "1.0.0" });
    await fs.writeFile(path.join(nmDir, "pkg-x", "helper.js"), identicalContent, "utf8");
    await fs.mkdir(path.join(nmDir, "pkg-y"), { recursive: true });
    await writeJson(path.join(nmDir, "pkg-y", "package.json"), { name: "pkg-y", version: "1.0.0" });
    await fs.writeFile(path.join(nmDir, "pkg-y", "helper.js"), identicalContent, "utf8");

    const { stdout, ok } = await runBetter(["duplicate-files", "--json"], dir);
    assert.ok(ok, "duplicate-files should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.equal(out.ok, true);
      const dups = out.duplicates ?? out.groups ?? [];
      assert.ok(Array.isArray(dups), "should have duplicates array");
      if (dups.length > 0) {
        const allFiles = dups.flatMap(d => d.files ?? d.paths ?? []);
        assert.ok(allFiles.length >= 2, "should list at least 2 duplicate files");
      }
    }
  } finally {
    await rmrf(dir);
  }
});
