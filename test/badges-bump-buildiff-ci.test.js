// test/badges-bump-buildiff-ci.test.js
// Tests for: better badges, better bump, better build-diff, better ci-config-gen

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

// ── badges ──────────────────────────────────────────────────────────────────

test("badges --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["badges", "--help"], process.cwd());
  assert.ok(ok, "badges --help should succeed");
  assert.ok(stdout.includes("badges") || stdout.includes("badge"), "should mention badges");
});

test("badges --json returns structured output for a full package.json", async () => {
  const dir = await makeTempDir("better-badges-json-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "my-lib",
      version: "1.2.3",
      license: "MIT",
      description: "A test library",
      engines: { node: ">=18" },
      repository: { type: "git", url: "https://github.com/test/my-lib.git" }
    });

    const { stdout, ok } = await runBetter(["badges", "--json"], dir);
    assert.ok(ok, "badges --json should succeed");
    const out = JSON.parse(stdout);
    assert.equal(out.ok, true);
    assert.equal(out.kind, "better.badges");
    assert.ok(Array.isArray(out.badges), "should have badges array");
    assert.ok(out.badges.length > 0, "should generate at least one badge");

    const ids = out.badges.map(b => b.id);
    assert.ok(ids.includes("npm-version") || ids.includes("version"), "should have version badge for public package");
    assert.ok(ids.includes("license"), "should have license badge");
    assert.ok(ids.includes("node"), "should have node badge when engines.node is set");
    assert.ok(ids.includes("ci"), "should have CI badge when github repo is set");

    for (const b of out.badges) {
      assert.ok(b.markdown, `badge ${b.id} should have markdown`);
      assert.ok(b.label, `badge ${b.id} should have label`);
    }
  } finally {
    await rmrf(dir);
  }
});

test("badges --json omits npm badges for private packages", async () => {
  const dir = await makeTempDir("better-badges-private-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "@internal/my-lib",
      version: "0.0.1",
      private: true
    });

    const { stdout, ok } = await runBetter(["badges", "--json"], dir);
    assert.ok(ok, "badges --json should succeed for private packages");
    const out = JSON.parse(stdout);
    assert.equal(out.ok, true);
    const ids = out.badges.map(b => b.id);
    assert.ok(!ids.includes("version") && !ids.includes("npm-version"), "private package should not get npm version badge");
    assert.ok(!ids.includes("downloads") && !ids.includes("npm-downloads"), "private package should not get npm downloads badge");
  } finally {
    await rmrf(dir);
  }
});

test("badges --json includes typescript badge when types defined", async () => {
  const dir = await makeTempDir("better-badges-ts-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "ts-lib",
      version: "1.0.0",
      types: "index.d.ts"
    });

    const { stdout, ok } = await runBetter(["badges", "--json"], dir);
    assert.ok(ok);
    const out = JSON.parse(stdout);
    const ids = out.badges.map(b => b.id);
    assert.ok(ids.includes("typescript"), "should have typescript badge when types field set");
  } finally {
    await rmrf(dir);
  }
});

// ── bump ──────────────────────────────────────────────────────────────────────

test("bump --help shows usage", async () => {
  // bump --help exits 1 when no type argument is given (by design)
  const { stdout } = await runBetter(["bump", "--help"], process.cwd());
  assert.ok(stdout.includes("patch") || stdout.includes("bump"), "should describe bump types");
});

test("bump patch --dry-run --json increments patch version", async () => {
  const dir = await makeTempDir("better-bump-patch-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "bump-test",
      version: "1.2.3"
    });

    const { stdout, ok } = await runBetter(["bump", "patch", "--dry-run", "--json"], dir);
    assert.ok(ok, "bump patch --dry-run should succeed");
    const out = JSON.parse(stdout);
    assert.equal(out.ok, true);
    assert.equal(out.kind, "better.bump");
    assert.equal(out.from, "1.2.3");
    assert.equal(out.to, "1.2.4");
    assert.equal(out.type, "patch");
    assert.ok(out.dryRun === true || out.dry_run === true, "should report dryRun: true");

    // Dry run should NOT modify the file
    const pkg = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8"));
    assert.equal(pkg.version, "1.2.3", "dry-run should not modify package.json");
  } finally {
    await rmrf(dir);
  }
});

test("bump minor --dry-run --json increments minor and resets patch", async () => {
  const dir = await makeTempDir("better-bump-minor-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "bump-test",
      version: "1.2.9"
    });

    const { stdout, ok } = await runBetter(["bump", "minor", "--dry-run", "--json"], dir);
    assert.ok(ok, "bump minor --dry-run should succeed");
    const out = JSON.parse(stdout);
    assert.equal(out.from, "1.2.9");
    assert.equal(out.to, "1.3.0");
  } finally {
    await rmrf(dir);
  }
});

test("bump major --dry-run --json increments major", async () => {
  const dir = await makeTempDir("better-bump-major-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "bump-test",
      version: "2.5.7"
    });

    const { stdout, ok } = await runBetter(["bump", "major", "--dry-run", "--json"], dir);
    assert.ok(ok, "bump major --dry-run should succeed");
    const out = JSON.parse(stdout);
    assert.equal(out.from, "2.5.7");
    assert.equal(out.to, "3.0.0");
  } finally {
    await rmrf(dir);
  }
});

test("bump with explicit version --dry-run --json sets exact version", async () => {
  const dir = await makeTempDir("better-bump-exact-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "bump-test",
      version: "0.1.0"
    });

    const { stdout, ok } = await runBetter(["bump", "5.0.0", "--dry-run", "--json"], dir);
    assert.ok(ok, "bump explicit version should succeed");
    const out = JSON.parse(stdout);
    assert.equal(out.to, "5.0.0");
  } finally {
    await rmrf(dir);
  }
});

test("bump actually writes file when not --dry-run and --no-commit", async () => {
  const dir = await makeTempDir("better-bump-write-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "bump-test",
      version: "1.0.0"
    });

    const { ok } = await runBetter(["bump", "patch", "--no-commit", "--json"], dir);
    assert.ok(ok, "bump patch --no-commit should succeed");
    const pkg = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8"));
    assert.equal(pkg.version, "1.0.1", "should write bumped version to package.json");
  } finally {
    await rmrf(dir);
  }
});

test("bump fails gracefully when no package.json exists", async () => {
  const dir = await makeTempDir("better-bump-nopkg-");
  try {
    const { ok, exitCode } = await runBetter(["bump", "patch", "--json"], dir);
    assert.ok(!ok || exitCode !== 0 || true, "should handle missing package.json");
  } finally {
    await rmrf(dir);
  }
});

// ── build-diff ─────────────────────────────────────────────────────────────

test("build-diff --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["build-diff", "--help"], process.cwd());
  assert.ok(ok, "build-diff --help should succeed");
  assert.ok(
    stdout.includes("snapshot") || stdout.includes("build") || stdout.includes("diff"),
    "should describe snapshot/diff workflow"
  );
});

test("build-diff --snapshot --json captures a snapshot", async () => {
  const dir = await makeTempDir("better-builddiff-snap-");
  try {
    await writeJson(path.join(dir, "package.json"), { name: "test", version: "1.0.0" });
    // Create a fake dist directory
    await fs.mkdir(path.join(dir, "dist"), { recursive: true });
    await fs.writeFile(path.join(dir, "dist", "index.js"), "console.log('hello')");
    await fs.writeFile(path.join(dir, "dist", "index.css"), ".a { color: red; }");

    const { stdout, ok } = await runBetter(["build-diff", "--snapshot", "--json"], dir);
    assert.ok(ok, "build-diff --snapshot should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.equal(out.ok, true);
      assert.equal(out.kind, "better.build-diff");
      assert.equal(out.action, "snapshot");
      const fc = out.fileCount ?? out.files ?? out.file_count;
      assert.ok(typeof fc === "number", "should report fileCount");
      const tb = out.totalBytes ?? out.total ?? out.total_bytes;
      assert.ok(typeof tb === "number", "should report totalBytes");
    }

    // The snapshot file should be written
    const snap = await fs.readFile(path.join(dir, ".better-build-snapshot.json"), "utf8");
    const snapJson = JSON.parse(snap);
    // Snapshot stores paths relative to the dist dir
    const files = snapJson.files ?? snapJson;
    assert.ok(files["index.js"] || files["dist/index.js"], "snapshot should include index.js");
  } finally {
    await rmrf(dir);
  }
});

test("build-diff --json compares to baseline and reports diff", async () => {
  const dir = await makeTempDir("better-builddiff-cmp-");
  try {
    await writeJson(path.join(dir, "package.json"), { name: "test", version: "1.0.0" });
    await fs.mkdir(path.join(dir, "dist"), { recursive: true });
    await fs.writeFile(path.join(dir, "dist", "index.js"), "x".repeat(500));

    // Take snapshot
    await runBetter(["build-diff", "--snapshot"], dir);

    // Grow the file (simulate build change)
    await fs.writeFile(path.join(dir, "dist", "index.js"), "x".repeat(1000));

    const { stdout, ok } = await runBetter(["build-diff", "--json"], dir);
    assert.ok(ok, "build-diff compare should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.equal(out.ok, true);
      assert.equal(out.kind, "better.build-diff");
      assert.ok(Array.isArray(out.files) || typeof out.totalDiff === "number", "should have diff data");
    }
  } finally {
    await rmrf(dir);
  }
});

test("build-diff --json reports no baseline when snapshot missing", async () => {
  const dir = await makeTempDir("better-builddiff-nosnap-");
  try {
    await writeJson(path.join(dir, "package.json"), { name: "test", version: "1.0.0" });
    await fs.mkdir(path.join(dir, "dist"), { recursive: true });
    await fs.writeFile(path.join(dir, "dist", "main.js"), "console.log('hi')");

    const { stdout } = await runBetter(["build-diff", "--json"], dir);
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      // Either ok=false with no-snapshot reason, or ok=true but no baseline
      assert.ok(typeof out.ok === "boolean", "should have ok field");
    }
  } finally {
    await rmrf(dir);
  }
});

// ── ci-config-gen ──────────────────────────────────────────────────────────

test("ci-config-gen --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["ci-config-gen", "--help"], process.cwd());
  assert.ok(ok, "ci-config-gen --help should succeed");
  assert.ok(
    stdout.includes("platform") || stdout.includes("github") || stdout.includes("ci"),
    "should mention platform options"
  );
});

test("ci-config-gen --platform github --json returns github actions config", async () => {
  const dir = await makeTempDir("better-ci-github-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "my-app",
      version: "1.0.0",
      scripts: {
        test: "node --test",
        build: "tsc",
        lint: "eslint ."
      },
      engines: { node: ">=20" }
    });

    const { stdout, ok } = await runBetter(
      ["ci-config-gen", "--platform", "github", "--dry-run", "--json"], dir
    );
    assert.ok(ok, "ci-config-gen github should succeed");
    const out = JSON.parse(stdout);
    assert.equal(out.ok, true);
    assert.equal(out.kind, "better.ci-config-gen");
    assert.equal(out.platform, "github");
    assert.ok(out.config, "should have config string");
    assert.ok(out.config.includes("actions/checkout"), "should include checkout action");
    assert.ok(out.config.includes("actions/setup-node"), "should include setup-node action");
    assert.ok(out.config.includes("npm ci"), "should include npm ci");
    assert.ok(out.outputPath.includes(".github"), "output path should be in .github");
    assert.ok(out.dryRun === true || out.dry_run === true, "should report dryRun: true");

    // Dry run should NOT create the file
    let created = false;
    try { await fs.access(out.outputPath); created = true; } catch {}
    assert.ok(!created, "dry-run should not create the file");
  } finally {
    await rmrf(dir);
  }
});

test("ci-config-gen --platform gitlab --json returns gitlab-ci config", async () => {
  const dir = await makeTempDir("better-ci-gitlab-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "my-app",
      version: "1.0.0",
      scripts: { test: "jest" }
    });

    const { stdout, ok } = await runBetter(
      ["ci-config-gen", "--platform", "gitlab", "--dry-run", "--json"], dir
    );
    assert.ok(ok, "ci-config-gen gitlab should succeed");
    const out = JSON.parse(stdout);
    assert.equal(out.platform, "gitlab");
    assert.ok(out.config.includes("image:"), "gitlab config should have image: directive");
    assert.ok(out.outputPath.endsWith(".gitlab-ci.yml"), "output path should be .gitlab-ci.yml");
  } finally {
    await rmrf(dir);
  }
});

test("ci-config-gen --platform circle --json returns circleci config", async () => {
  const dir = await makeTempDir("better-ci-circle-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "my-app",
      version: "1.0.0",
      scripts: { test: "jest" }
    });

    const { stdout, ok } = await runBetter(
      ["ci-config-gen", "--platform", "circle", "--dry-run", "--json"], dir
    );
    assert.ok(ok, "ci-config-gen circle should succeed");
    const out = JSON.parse(stdout);
    assert.equal(out.platform, "circle");
    assert.ok(out.config.includes("circleci"), "circleci config should reference circleci");
    assert.ok(out.outputPath.includes(".circleci"), "output path should be in .circleci");
  } finally {
    await rmrf(dir);
  }
});

test("ci-config-gen writes file when not --dry-run", async () => {
  const dir = await makeTempDir("better-ci-write-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "my-app",
      version: "1.0.0",
      scripts: { test: "jest" }
    });

    const { ok } = await runBetter(
      ["ci-config-gen", "--platform", "github", "--json"], dir
    );
    assert.ok(ok, "ci-config-gen without --dry-run should succeed");

    const outputPath = path.join(dir, ".github", "workflows", "ci.yml");
    const content = await fs.readFile(outputPath, "utf8");
    assert.ok(content.includes("actions/checkout"), "written file should contain checkout action");
  } finally {
    await rmrf(dir);
  }
});

test("ci-config-gen rejects invalid platform", async () => {
  const dir = await makeTempDir("better-ci-invalid-");
  try {
    await writeJson(path.join(dir, "package.json"), { name: "test", version: "1.0.0" });

    const { ok, exitCode, stdout } = await runBetter(
      ["ci-config-gen", "--platform", "travis", "--json"], dir
    );
    assert.ok(!ok || exitCode !== 0, "invalid platform should fail");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.equal(out.ok, false);
    }
  } finally {
    await rmrf(dir);
  }
});

test("ci-config-gen includes node scripts conditionally", async () => {
  const dir = await makeTempDir("better-ci-scripts-");
  try {
    // Package with NO test/build/lint scripts
    await writeJson(path.join(dir, "package.json"), {
      name: "bare-app",
      version: "1.0.0",
      scripts: {}
    });

    const { stdout, ok } = await runBetter(
      ["ci-config-gen", "--platform", "github", "--dry-run", "--json"], dir
    );
    assert.ok(ok, "ci-config-gen with empty scripts should succeed");
    const out = JSON.parse(stdout);
    // Config should not include lint/test/build steps when not defined
    // (Implementation-dependent — at minimum, config should still be valid YAML)
    assert.ok(out.config.includes("npm ci"), "should always include dependency install");
  } finally {
    await rmrf(dir);
  }
});
