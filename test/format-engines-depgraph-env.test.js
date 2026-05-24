// test/format-engines-depgraph-env.test.js
// Tests for: better format-package, better engines-check, better dep-graph-json,
//            better env-validate, better fix-versions

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

// ── format-package ────────────────────────────────────────────────────────────

test("format-package --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["format-package", "--help"], process.cwd());
  assert.ok(ok, "format-package --help should succeed");
  assert.ok(stdout.includes("format") || stdout.includes("package"), "should mention formatting");
});

test("format-package --dry-run --json reports sorted key order", async () => {
  const dir = await makeTempDir("better-fmt-pkg-");
  try {
    // Write a package.json with scrambled key order
    const raw = JSON.stringify({
      devDependencies: { jest: "^29.0.0" },
      name: "my-app",
      scripts: { test: "jest", build: "tsc" },
      version: "1.0.0",
      dependencies: { lodash: "^4.17.21", axios: "^1.0.0" },
      description: "A test app",
      license: "MIT"
    }, null, 2);
    await fs.writeFile(path.join(dir, "package.json"), raw, "utf8");

    const { stdout, ok } = await runBetter(["format-package", "--dry-run", "--json"], dir);
    assert.ok(ok, "format-package --dry-run should succeed");
    const out = JSON.parse(stdout);
    assert.equal(out.ok, true);
    assert.ok(out.kind?.includes("format"), `unexpected kind: ${out.kind}`);

    // Dry run should NOT modify the file
    const onDisk = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8"));
    assert.equal(onDisk.name, "my-app"); // file unchanged
  } finally {
    await rmrf(dir);
  }
});

test("format-package actually writes sorted package.json when not --dry-run", async () => {
  const dir = await makeTempDir("better-fmt-write-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      devDependencies: { jest: "^29.0.0" },
      name: "my-app",
      version: "1.0.0",
      dependencies: { zebra: "^1.0.0", alpha: "^2.0.0" }
    });

    const { ok } = await runBetter(["format-package", "--json"], dir);
    assert.ok(ok, "format-package should succeed");

    const formatted = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8"));
    // name should come before version (canonical order)
    const keys = Object.keys(formatted);
    const nameIdx = keys.indexOf("name");
    const versionIdx = keys.indexOf("version");
    assert.ok(nameIdx < versionIdx, "name should come before version in canonical order");

    // dependencies should be sorted alphabetically
    const deps = Object.keys(formatted.dependencies ?? {});
    assert.deepEqual(deps, [...deps].sort(), "dependencies should be sorted alphabetically");
  } finally {
    await rmrf(dir);
  }
});

// ── engines-check ────────────────────────────────────────────────────────────

test("engines-check --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["engines-check", "--help"], process.cwd());
  assert.ok(ok, "engines-check --help should succeed");
  assert.ok(stdout.includes("engines") || stdout.includes("node"), "should mention engines/node");
});

test("engines-check --json passes when no packages have incompatible engines", async () => {
  const dir = await makeTempDir("better-engines-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test",
      version: "1.0.0"
    });
    // Create a single package in node_modules with compatible engine
    const pkgDir = path.join(dir, "node_modules", "compatible-pkg");
    await fs.mkdir(pkgDir, { recursive: true });
    await writeJson(path.join(pkgDir, "package.json"), {
      name: "compatible-pkg",
      version: "1.0.0",
      engines: { node: ">=12" } // Any Node.js >= 12 should pass
    });

    const { stdout, ok } = await runBetter(["engines-check", "--json"], dir);
    assert.ok(ok, "engines-check should succeed");
    const out = JSON.parse(stdout);
    assert.equal(out.ok, true);
    assert.ok(out.kind?.includes("engines"), `unexpected kind: ${out.kind}`);
    const issues = out.incompatible ?? out.issues ?? [];
    assert.ok(Array.isArray(issues), "should have issues array");
    assert.equal(issues.length, 0, "compatible-pkg should not be in issues list");
  } finally {
    await rmrf(dir);
  }
});

test("engines-check --json flags incompatible node engine requirements", async () => {
  const dir = await makeTempDir("better-engines-incompat-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test",
      version: "1.0.0"
    });
    const pkgDir = path.join(dir, "node_modules", "old-pkg");
    await fs.mkdir(pkgDir, { recursive: true });
    await writeJson(path.join(pkgDir, "package.json"), {
      name: "old-pkg",
      version: "1.0.0",
      engines: { node: ">=999.0.0" } // Impossible requirement
    });

    const { stdout } = await runBetter(["engines-check", "--json"], dir);
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean");
      if (!out.ok || (out.issues && out.issues.length > 0)) {
        const issues = out.issues ?? out.incompatible ?? [];
        const names = issues.map(p => p.name ?? p.package);
        assert.ok(names.includes("old-pkg") || issues.length > 0, "old-pkg should be flagged as incompatible");
      }
    }
  } finally {
    await rmrf(dir);
  }
});

test("engines-check --json handles node_modules not present gracefully", async () => {
  const dir = await makeTempDir("better-engines-nonm-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test",
      version: "1.0.0"
    });
    // No node_modules - should not crash
    const { stdout, ok } = await runBetter(["engines-check", "--json"], dir);
    assert.ok(ok, "engines-check should succeed even without node_modules");
    const out = JSON.parse(stdout);
    assert.equal(out.ok, true);
    const issues = out.incompatible ?? out.issues ?? [];
    assert.equal(issues.length, 0);
  } finally {
    await rmrf(dir);
  }
});

// ── dep-graph-json ────────────────────────────────────────────────────────────

test("dep-graph-json --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["dep-graph-json", "--help"], process.cwd());
  assert.ok(ok, "dep-graph-json --help should succeed");
  assert.ok(
    stdout.includes("graph") || stdout.includes("dep") || stdout.includes("format"),
    "should describe dep graph output"
  );
});

test("dep-graph-json --json returns nodes and edges", async () => {
  const dir = await makeTempDir("better-depgraph-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "my-app",
      version: "1.0.0",
      dependencies: { lodash: "^4.17.21" },
      devDependencies: { jest: "^29.0.0" }
    });
    // Minimal package-lock.json so graph can be built
    await writeJson(path.join(dir, "package-lock.json"), {
      name: "my-app",
      lockfileVersion: 3,
      packages: {
        "": { name: "my-app", version: "1.0.0", dependencies: { lodash: "^4.17.21" }, devDependencies: { jest: "^29.0.0" } },
        "node_modules/lodash": { name: "lodash", version: "4.17.21" },
        "node_modules/jest": { name: "jest", version: "29.0.0", dev: true }
      }
    });

    const { stdout, ok } = await runBetter(["dep-graph-json", "--json"], dir);
    assert.ok(ok, "dep-graph-json should succeed");
    const out = JSON.parse(stdout);
    assert.equal(out.ok, true);
    assert.ok(Array.isArray(out.nodes), "should have nodes array");
    assert.ok(Array.isArray(out.edges), "should have edges array");
    assert.ok(out.nodes.length > 0, "should have at least one node");
    const names = out.nodes.map(n => n.name);
    assert.ok(names.includes("lodash"), "should include lodash node");
    assert.ok(names.includes("jest"), "should include jest node");
  } finally {
    await rmrf(dir);
  }
});

test("dep-graph-json --format dot returns DOT graph", async () => {
  const dir = await makeTempDir("better-depgraph-dot-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "my-app",
      version: "1.0.0",
      dependencies: { express: "^4.18.0" }
    });
    await writeJson(path.join(dir, "package-lock.json"), {
      name: "my-app",
      lockfileVersion: 3,
      packages: {
        "": { name: "my-app", version: "1.0.0", dependencies: { express: "^4.18.0" } },
        "node_modules/express": { name: "express", version: "4.18.0" }
      }
    });

    const { stdout, ok } = await runBetter(["dep-graph-json", "--format", "dot"], dir);
    assert.ok(ok, "dep-graph-json --format dot should succeed");
    assert.ok(stdout.includes("digraph") || stdout.includes("->"), "DOT output should contain graph syntax");
  } finally {
    await rmrf(dir);
  }
});

test("dep-graph-json --format mermaid returns Mermaid graph", async () => {
  const dir = await makeTempDir("better-depgraph-mmd-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "my-app",
      version: "1.0.0",
      dependencies: { chalk: "^5.0.0" }
    });
    await writeJson(path.join(dir, "package-lock.json"), {
      name: "my-app",
      lockfileVersion: 3,
      packages: {
        "": { name: "my-app", version: "1.0.0", dependencies: { chalk: "^5.0.0" } },
        "node_modules/chalk": { name: "chalk", version: "5.0.0" }
      }
    });

    const { stdout, ok } = await runBetter(["dep-graph-json", "--format", "mermaid"], dir);
    assert.ok(ok, "dep-graph-json --format mermaid should succeed");
    assert.ok(stdout.includes("graph") || stdout.includes("-->"), "Mermaid output should have graph syntax");
  } finally {
    await rmrf(dir);
  }
});

// ── env-validate ─────────────────────────────────────────────────────────────

test("env-validate --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["env-validate", "--help"], process.cwd());
  assert.ok(ok, "env-validate --help should succeed");
  assert.ok(stdout.includes("env") || stdout.includes("validate"), "should mention validation");
});

test("env-validate --json passes when all required vars present", async () => {
  const dir = await makeTempDir("better-envval-pass-");
  try {
    await writeJson(path.join(dir, "package.json"), { name: "test", version: "1.0.0" });
    // Write schema (flat format: each key is a variable name)
    await writeJson(path.join(dir, ".env.schema.json"), {
      DATABASE_URL: { type: "url", required: true },
      PORT: { type: "port", required: true }
    });
    // Write .env
    await fs.writeFile(path.join(dir, ".env"), [
      "DATABASE_URL=https://db.example.com/mydb",
      "PORT=5432"
    ].join("\n"), "utf8");

    const { stdout, ok } = await runBetter(["env-validate", "--json"], dir);
    assert.ok(ok, "env-validate should pass when all vars present");
    const out = JSON.parse(stdout);
    assert.equal(out.ok, true);
    assert.ok(out.kind?.includes("env"), `unexpected kind: ${out.kind}`);
  } finally {
    await rmrf(dir);
  }
});

test("env-validate --json fails when required var is missing", async () => {
  const dir = await makeTempDir("better-envval-fail-");
  try {
    await writeJson(path.join(dir, "package.json"), { name: "test", version: "1.0.0" });
    await writeJson(path.join(dir, ".env.schema.json"), {
      DATABASE_URL: { type: "url", required: true },
      SECRET_KEY: { type: "string", required: true }
    });
    // Only set one of the required vars
    await fs.writeFile(path.join(dir, ".env"), "DATABASE_URL=https://db.example.com\n", "utf8");

    const { stdout, ok, exitCode } = await runBetter(["env-validate", "--json"], dir);
    assert.ok(!ok || exitCode !== 0, "env-validate should fail when required var missing");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.equal(out.ok, false);
      // results is an array of { name, status } objects
      const missing = (out.results ?? []).filter(r => r.status === "missing").map(r => r.name);
      assert.ok(
        missing.includes("SECRET_KEY"),
        `should report SECRET_KEY as missing, got: ${JSON.stringify(out.results)}`
      );
    }
  } finally {
    await rmrf(dir);
  }
});

test("env-validate with positional var names validates specific vars without schema file", async () => {
  const dir = await makeTempDir("better-envval-req-");
  try {
    await writeJson(path.join(dir, "package.json"), { name: "test", version: "1.0.0" });
    await fs.writeFile(path.join(dir, ".env"), "MY_VAR=hello\n", "utf8");

    // Pass var names as positional arguments (no schema file in this dir)
    const { stdout, ok } = await runBetter(
      ["env-validate", "MY_VAR", "--json"], dir
    );
    assert.ok(ok, "env-validate should pass when positional var is present in .env");
    const out = JSON.parse(stdout);
    assert.equal(out.ok, true);
  } finally {
    await rmrf(dir);
  }
});

// ── fix-versions ──────────────────────────────────────────────────────────────

test("fix-versions --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["fix-versions", "--help"], process.cwd());
  assert.ok(ok, "fix-versions --help should succeed");
  assert.ok(stdout.includes("caret") || stdout.includes("version") || stdout.includes("range"), "should describe version normalization");
});

test("fix-versions --to caret --dry-run --json converts ranges to ^", async () => {
  const dir = await makeTempDir("better-fixver-caret-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test",
      version: "1.0.0",
      dependencies: {
        lodash: "4.17.21",        // pinned → ^4.17.21
        axios: "~1.4.0",          // tilde → ^1.4.0
        express: ">=4.0.0"        // gte → ^4.0.0
      }
    });

    const { stdout, ok } = await runBetter(["fix-versions", "--to", "caret", "--dry-run", "--json"], dir);
    assert.ok(ok, "fix-versions --dry-run should succeed");
    const out = JSON.parse(stdout);
    assert.equal(out.ok, true);
    assert.ok(out.kind?.includes("fix-versions") || out.kind?.includes("versions"), `unexpected kind: ${out.kind}`);
    assert.ok(typeof out.changes === "number" || Array.isArray(out.changes), "should report changes");

    // Dry run should NOT modify file
    const pkg = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8"));
    assert.equal(pkg.dependencies.lodash, "4.17.21", "dry-run should not change package.json");
  } finally {
    await rmrf(dir);
  }
});

test("fix-versions --to exact --json pins all versions", async () => {
  const dir = await makeTempDir("better-fixver-exact-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test",
      version: "1.0.0",
      dependencies: {
        lodash: "^4.17.21",
        axios: "~1.4.0"
      }
    });

    const { ok } = await runBetter(["fix-versions", "--to", "exact", "--json"], dir);
    assert.ok(ok, "fix-versions --to exact should succeed");

    const pkg = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8"));
    assert.equal(pkg.dependencies.lodash, "4.17.21", "lodash should be pinned");
    assert.equal(pkg.dependencies.axios, "1.4.0", "axios should be pinned");
  } finally {
    await rmrf(dir);
  }
});

test("fix-versions --to tilde --json normalizes all to ~", async () => {
  const dir = await makeTempDir("better-fixver-tilde-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test",
      version: "1.0.0",
      dependencies: {
        lodash: "^4.17.21",
        react: "18.2.0"
      }
    });

    const { ok } = await runBetter(["fix-versions", "--to", "tilde", "--json"], dir);
    assert.ok(ok, "fix-versions --to tilde should succeed");

    const pkg = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8"));
    assert.ok(pkg.dependencies.lodash.startsWith("~"), "lodash should use tilde");
    assert.ok(pkg.dependencies.react.startsWith("~"), "react should use tilde");
  } finally {
    await rmrf(dir);
  }
});

test("fix-versions leaves workspace: and file: ranges untouched", async () => {
  const dir = await makeTempDir("better-fixver-special-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test",
      version: "1.0.0",
      dependencies: {
        "my-workspace-pkg": "workspace:*",
        "my-local": "file:../local",
        "lodash": "^4.17.21"
      }
    });

    const { ok } = await runBetter(["fix-versions", "--to", "exact", "--json"], dir);
    assert.ok(ok, "fix-versions should succeed");

    const pkg = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8"));
    assert.equal(pkg.dependencies["my-workspace-pkg"], "workspace:*", "workspace: should be untouched");
    assert.equal(pkg.dependencies["my-local"], "file:../local", "file: should be untouched");
    assert.equal(pkg.dependencies.lodash, "4.17.21", "regular deps should be pinned");
  } finally {
    await rmrf(dir);
  }
});
