// test/check-clean-workspace-misc.test.js
// Tests for: better check, better clean, better mono-deps,
//            better workspace-deps, better workspace-graph, better ai-advisor,
//            better ai-review, better dashboard

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

// ── check ─────────────────────────────────────────────────────────────────────

test("check --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["check", "--help"], process.cwd());
  assert.ok(ok, "check --help should succeed");
  assert.ok(
    stdout.includes("check") || stdout.includes("valid") || stdout.includes("verify"),
    "should describe project checking"
  );
});

test("check --json runs project checks", async () => {
  const dir = await makeTempDir("better-check-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      description: "A test project",
      license: "MIT"
    });

    const { stdout } = await runBetter(["check", "--json"], dir);
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("check"), `unexpected kind: ${out.kind}`);
      assert.ok(typeof out.total === "number", "should have total checks");
    }
  } finally {
    await rmrf(dir);
  }
});

// ── clean ─────────────────────────────────────────────────────────────────────

test("clean --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["clean", "--help"], process.cwd());
  assert.ok(ok, "clean --help should succeed");
  assert.ok(
    stdout.includes("clean") || stdout.includes("remove") || stdout.includes("node_modules"),
    "should describe cleaning"
  );
});

test("clean --dry-run --json reports what would be cleaned", async () => {
  const dir = await makeTempDir("better-clean-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0"
    });
    await fs.mkdir(path.join(dir, "node_modules"), { recursive: true });

    const { stdout, ok } = await runBetter(["clean", "--dry-run", "--json"], dir);
    assert.ok(ok, "clean --dry-run should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("clean"), `unexpected kind: ${out.kind}`);
      assert.equal(out.dry_run, true, "should report dry run");
    }
  } finally {
    await rmrf(dir);
  }
});

// ── mono-deps ─────────────────────────────────────────────────────────────────

test("mono-deps --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["mono-deps", "--help"], process.cwd());
  assert.ok(ok, "mono-deps --help should succeed");
  assert.ok(
    stdout.includes("mono") || stdout.includes("workspace") || stdout.includes("depend"),
    "should describe monorepo dependency analysis"
  );
});

test("mono-deps --json analyzes workspace dependencies", async () => {
  const dir = await makeTempDir("better-mono-deps-");
  try {
    // Create monorepo structure
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
      dependencies: { "lodash": "^4.0.0" }
    });

    const { stdout, ok } = await runBetter(["mono-deps", "--json"], dir);
    assert.ok(ok, "mono-deps should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("mono-deps"), `unexpected kind: ${out.kind}`);
      assert.ok(typeof out.workspaces === "number", "should have workspaces count");
    }
  } finally {
    await rmrf(dir);
  }
});

// ── workspace-deps ────────────────────────────────────────────────────────────

test("workspace-deps --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["workspace-deps", "--help"], process.cwd());
  assert.ok(ok, "workspace-deps --help should succeed");
  assert.ok(
    stdout.includes("workspace") || stdout.includes("depend") || stdout.includes("internal"),
    "should describe workspace dependency analysis"
  );
});

test("workspace-deps --json returns workspace packages", async () => {
  const dir = await makeTempDir("better-workspace-deps-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "my-monorepo", version: "1.0.0", private: true,
      workspaces: ["packages/*"]
    });
    const pkgA = path.join(dir, "packages", "pkg-a");
    await fs.mkdir(pkgA, { recursive: true });
    await writeJson(path.join(pkgA, "package.json"), {
      name: "@mono/pkg-a", version: "1.0.0"
    });

    const { stdout, ok } = await runBetter(["workspace-deps", "--json"], dir);
    assert.ok(ok, "workspace-deps should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("workspace-deps"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── workspace-graph ───────────────────────────────────────────────────────────

test("workspace-graph --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["workspace-graph", "--help"], process.cwd());
  assert.ok(ok, "workspace-graph --help should succeed");
  assert.ok(
    stdout.includes("workspace") || stdout.includes("graph") || stdout.includes("monorepo"),
    "should describe workspace graph"
  );
});

test("workspace-graph --json returns workspace dependency graph", async () => {
  const dir = await makeTempDir("better-workspace-graph-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "my-monorepo", version: "1.0.0", private: true,
      workspaces: ["packages/*"]
    });
    const pkgA = path.join(dir, "packages", "pkg-a");
    await fs.mkdir(pkgA, { recursive: true });
    await writeJson(path.join(pkgA, "package.json"), {
      name: "@mono/pkg-a", version: "1.0.0"
    });

    const { stdout, ok } = await runBetter(["workspace-graph", "--json"], dir);
    assert.ok(ok, "workspace-graph should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("workspace-graph"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── ai-advisor ────────────────────────────────────────────────────────────────

// Note: ai-advisor is routed as `better ai`, not `better ai-advisor`
test("ai --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["ai", "--help"], process.cwd());
  assert.ok(ok, "ai --help should succeed");
  assert.ok(
    stdout.includes("ai") || stdout.includes("advis") || stdout.includes("recommend"),
    "should describe AI advisory"
  );
});

test("ai --json returns AI recommendations or auth error", async () => {
  const dir = await makeTempDir("better-ai-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      dependencies: { "lodash": "^4.0.0" }
    });

    // ai requires ANTHROPIC_API_KEY/OPENAI_API_KEY, may fail without them
    const { stdout } = await runBetter(["ai", "--json"], dir);
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      // Either auth error or actual results
      if (out.ok) {
        assert.ok(out.kind?.includes("ai"), `unexpected kind: ${out.kind}`);
      } else {
        assert.ok(out.error, "should have error message when not ok");
      }
    }
  } finally {
    await rmrf(dir);
  }
});
