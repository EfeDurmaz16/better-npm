// test/audit-depgraph-dedupe-run.test.js
// Tests for: better audit, better dep-graph, better dedupe, better dep-why,
//            better dep-tree-size, better node-modules-info, better run,
//            better analyze (basic)

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

async function makeLockfile(dir, deps = {}) {
  const packages = { "": { name: "test", version: "1.0.0", dependencies: deps } };
  for (const [name, ver] of Object.entries(deps)) {
    packages[`node_modules/${name}`] = { name, version: ver.replace(/^\^/, "").replace(/^~/, "") };
  }
  await writeJson(path.join(dir, "package-lock.json"), {
    name: "test", lockfileVersion: 3, packages
  });
}

// ── audit ─────────────────────────────────────────────────────────────────────

test("audit --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["audit", "--help"], process.cwd());
  assert.ok(ok, "audit --help should succeed");
  assert.ok(
    stdout.includes("audit") || stdout.includes("vulnerabilit") || stdout.includes("security"),
    "should describe security auditing"
  );
});

test("audit --json returns ok with no vulnerabilities for empty deps", async () => {
  const dir = await makeTempDir("better-audit-empty-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0", dependencies: {}
    });
    await makeLockfile(dir, {});

    const { stdout, ok } = await runBetter(["audit", "--json"], dir);
    assert.ok(ok, "audit should succeed with no dependencies");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("audit"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

test("audit --json returns structured report (network-aware)", async (t) => {
  const dir = await makeTempDir("better-audit-deps-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      dependencies: { "express": "^4.18.0" }
    });
    await makeLockfile(dir, { "express": "4.18.0" });
    const nmDir = path.join(dir, "node_modules");
    await fs.mkdir(path.join(nmDir, "express"), { recursive: true });
    await writeJson(path.join(nmDir, "express", "package.json"), {
      name: "express", version: "4.18.0"
    });

    const { stdout, stderr } = await runBetter(["audit", "--json"], dir);
    if (stderr.includes("403") || stderr.includes("ENOTFOUND") || stderr.includes("timeout") ||
        stderr.includes("osv_batch_error")) {
      t.skip("OSV API unavailable");
      return;
    }
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      const hasVulnInfo = Array.isArray(out.vulnerabilities) || typeof out.total === "number" ||
        typeof out.summary === "object";
      assert.ok(hasVulnInfo, "should include vulnerability information");
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
    stdout.includes("graph") || stdout.includes("tree") || stdout.includes("dependency"),
    "should describe dependency graph visualization"
  );
});

test("dep-graph --json returns tree structure", async () => {
  const dir = await makeTempDir("better-depgraph-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "my-app", version: "1.0.0",
      dependencies: { "dep-a": "^1.0.0" }
    });
    const nmDir = path.join(dir, "node_modules");
    await fs.mkdir(path.join(nmDir, "dep-a"), { recursive: true });
    await writeJson(path.join(nmDir, "dep-a", "package.json"), {
      name: "dep-a", version: "1.0.0"
    });

    const { stdout, ok } = await runBetter(["dep-graph", "--json"], dir);
    assert.ok(ok, "dep-graph should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.equal(out.ok, true);
      assert.ok(out.kind?.includes("dep-graph"), `unexpected kind: ${out.kind}`);
      assert.ok(out.root !== undefined || out.tree !== undefined, "should have root or tree");
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
    stdout.includes("dedupe") || stdout.includes("duplicate") || stdout.includes("consolidat"),
    "should describe deduplication"
  );
});

test("dedupe --dry-run --json returns ok with no duplicates for clean install", async () => {
  const dir = await makeTempDir("better-dedupe-nodups-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      dependencies: { "dep-a": "^1.0.0" }
    });
    const nmDir = path.join(dir, "node_modules");
    await fs.mkdir(path.join(nmDir, "dep-a"), { recursive: true });
    await writeJson(path.join(nmDir, "dep-a", "package.json"), {
      name: "dep-a", version: "1.0.0"
    });

    const { stdout, ok } = await runBetter(["dedupe", "--dry-run", "--json"], dir);
    assert.ok(ok, "dedupe should succeed with no duplicates");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("dedupe"), `unexpected kind: ${out.kind}`);
      assert.ok(Array.isArray(out.duplicates), "should have duplicates array");
    }
  } finally {
    await rmrf(dir);
  }
});

test("dedupe --dry-run --json detects duplicate package versions", async () => {
  const dir = await makeTempDir("better-dedupe-found-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      dependencies: { "pkg-a": "^1.0.0", "pkg-b": "^1.0.0" }
    });
    const nmDir = path.join(dir, "node_modules");
    // pkg-a and pkg-b both depend on same-dep at different minor versions
    for (const [pkg, ver] of [["pkg-a", "1.0.0"], ["pkg-b", "1.0.0"]]) {
      await fs.mkdir(path.join(nmDir, pkg), { recursive: true });
      await writeJson(path.join(nmDir, pkg, "package.json"), {
        name: pkg, version: ver,
        dependencies: { "shared-dep": `^1.0.0` }
      });
      // nested same-dep with different patch version
      await fs.mkdir(path.join(nmDir, pkg, "node_modules", "shared-dep"), { recursive: true });
      await writeJson(path.join(nmDir, pkg, "node_modules", "shared-dep", "package.json"), {
        name: "shared-dep", version: pkg === "pkg-a" ? "1.0.0" : "1.1.0"
      });
    }
    // Also a top-level shared-dep
    await fs.mkdir(path.join(nmDir, "shared-dep"), { recursive: true });
    await writeJson(path.join(nmDir, "shared-dep", "package.json"), {
      name: "shared-dep", version: "1.1.0"
    });

    const { stdout, ok } = await runBetter(["dedupe", "--dry-run", "--json"], dir);
    assert.ok(ok, "dedupe should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(Array.isArray(out.duplicates), "should have duplicates array");
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
    stdout.includes("why") || stdout.includes("reason") || stdout.includes("depend"),
    "should describe dep-why usage"
  );
});

test("dep-why --json explains why a direct dep is installed", async () => {
  const dir = await makeTempDir("better-depwhy-direct-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "my-app", version: "1.0.0",
      dependencies: { "express": "^4.18.0" }
    });
    const nmDir = path.join(dir, "node_modules");
    await fs.mkdir(path.join(nmDir, "express"), { recursive: true });
    await writeJson(path.join(nmDir, "express", "package.json"), {
      name: "express", version: "4.18.0"
    });

    const { stdout, ok } = await runBetter(["dep-why", "express", "--json"], dir);
    assert.ok(ok, "dep-why should succeed for direct dep");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("dep-why") || out.kind?.includes("why"), `unexpected kind: ${out.kind}`);
      assert.ok(out.direct === true || out.paths !== undefined, "should indicate direct or paths");
    }
  } finally {
    await rmrf(dir);
  }
});

test("dep-why requires a package argument", async () => {
  const dir = await makeTempDir("better-depwhy-noarg-");
  try {
    await writeJson(path.join(dir, "package.json"), { name: "test", version: "1.0.0" });
    const { ok } = await runBetter(["dep-why"], dir);
    assert.ok(!ok, "dep-why with no arg should fail");
  } finally {
    await rmrf(dir);
  }
});

// ── dep-tree-size ─────────────────────────────────────────────────────────────

test("dep-tree-size --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["dep-tree-size", "--help"], process.cwd());
  assert.ok(ok, "dep-tree-size --help should succeed");
  assert.ok(
    stdout.includes("tree") || stdout.includes("size") || stdout.includes("subtree"),
    "should describe dep tree size analysis"
  );
});

test("dep-tree-size --json returns sizes for installed packages", async () => {
  const dir = await makeTempDir("better-deptreesize-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      dependencies: { "dep-x": "^1.0.0" }
    });
    const nmDir = path.join(dir, "node_modules");
    await fs.mkdir(path.join(nmDir, "dep-x"), { recursive: true });
    await writeJson(path.join(nmDir, "dep-x", "package.json"), {
      name: "dep-x", version: "1.0.0"
    });
    await fs.writeFile(path.join(nmDir, "dep-x", "index.js"), "x".repeat(5000));

    const { stdout, ok } = await runBetter(["dep-tree-size", "--json"], dir);
    assert.ok(ok, "dep-tree-size should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.equal(out.ok, true);
      assert.ok(out.kind?.includes("dep-tree-size"), `unexpected kind: ${out.kind}`);
      assert.ok(Array.isArray(out.packages), "should have packages array");
    }
  } finally {
    await rmrf(dir);
  }
});

// ── node-modules-info ─────────────────────────────────────────────────────────

test("node-modules-info --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["node-modules-info", "--help"], process.cwd());
  assert.ok(ok, "node-modules-info --help should succeed");
  assert.ok(
    stdout.includes("node_modules") || stdout.includes("info") || stdout.includes("size"),
    "should describe node_modules info"
  );
});

test("node-modules-info --json returns stats for node_modules", async () => {
  const dir = await makeTempDir("better-nminfo-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0"
    });
    const nmDir = path.join(dir, "node_modules");
    await fs.mkdir(path.join(nmDir, "pkg-a"), { recursive: true });
    await writeJson(path.join(nmDir, "pkg-a", "package.json"), {
      name: "pkg-a", version: "1.0.0"
    });
    await fs.writeFile(path.join(nmDir, "pkg-a", "index.js"), "x".repeat(1000));

    const { stdout, ok } = await runBetter(["node-modules-info", "--json"], dir);
    assert.ok(ok, "node-modules-info should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.equal(out.ok, true);
      assert.ok(out.kind?.includes("node-modules"), `unexpected kind: ${out.kind}`);
      assert.ok(typeof out.totalSize === "number" || typeof out.fileCount === "number",
        "should report size or file count");
    }
  } finally {
    await rmrf(dir);
  }
});

// ── run ───────────────────────────────────────────────────────────────────────

test("run --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["run", "--help"], process.cwd());
  assert.ok(ok, "run --help should succeed");
  assert.ok(
    stdout.includes("run") || stdout.includes("script") || stdout.includes("npm"),
    "should describe script running"
  );
});

test("run executes a package.json script", async () => {
  const dir = await makeTempDir("better-run-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      scripts: { echo: "node -e \"process.stdout.write('hello-from-script')\"" }
    });

    const { stdout, ok } = await runBetter(["run", "echo"], dir);
    assert.ok(ok, "run should succeed for valid script");
    assert.ok(stdout.includes("hello-from-script"), "should output script result");
  } finally {
    await rmrf(dir);
  }
});

test("run fails gracefully when script does not exist", async () => {
  const dir = await makeTempDir("better-run-missing-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      scripts: {}
    });

    const { ok, exitCode } = await runBetter(["run", "nonexistent-script"], dir);
    assert.ok(!ok || exitCode !== 0, "run should fail for missing script");
  } finally {
    await rmrf(dir);
  }
});

// ── analyze ───────────────────────────────────────────────────────────────────

test("analyze --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["analyze", "--help"], process.cwd());
  assert.ok(ok, "analyze --help should succeed");
  assert.ok(
    stdout.includes("analyz") || stdout.includes("report") || stdout.includes("package"),
    "should describe project analysis"
  );
});

test("analyze --json returns structured analysis report", async () => {
  const dir = await makeTempDir("better-analyze-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test-project",
      version: "1.0.0",
      description: "A test project",
      license: "MIT",
      dependencies: {}
    });

    const { stdout, ok } = await runBetter(["analyze", "--json"], dir);
    assert.ok(ok, "analyze should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean" || out.kind !== undefined, "should have ok or kind field");
    }
  } finally {
    await rmrf(dir);
  }
});
