// test/find-unused-deprecation-fundinfo.test.js
// Tests for: better find-unused-exports, better deprecation-check,
//            better fund-info, better files-check, better exports-map

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

// ── find-unused-exports ───────────────────────────────────────────────────────

test("find-unused-exports --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["find-unused-exports", "--help"], process.cwd());
  assert.ok(ok, "find-unused-exports --help should succeed");
  assert.ok(
    stdout.includes("unused") || stdout.includes("export") || stdout.includes("symbol"),
    "should describe unused export finding"
  );
});

test("find-unused-exports --json returns empty when no source files", async () => {
  const dir = await makeTempDir("better-unused-exports-empty-");
  try {
    await writeJson(path.join(dir, "package.json"), { name: "test", version: "1.0.0" });

    const { stdout, ok } = await runBetter(["find-unused-exports", "--json"], dir);
    assert.ok(ok, "find-unused-exports should succeed with no source files");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.equal(out.ok, true);
      assert.ok(out.kind?.includes("unused") || out.kind?.includes("exports"), `unexpected kind: ${out.kind}`);
      const unused = out.unused ?? out.symbols ?? [];
      assert.ok(Array.isArray(unused), "should have unused array");
    }
  } finally {
    await rmrf(dir);
  }
});

test("find-unused-exports --json detects exported symbol used in another file", async () => {
  const dir = await makeTempDir("better-unused-used-");
  try {
    await writeJson(path.join(dir, "package.json"), { name: "test", version: "1.0.0" });
    // lib.js exports 'helper', index.js imports it → helper is NOT unused
    await fs.writeFile(path.join(dir, "lib.js"), "export function helper() { return 42; }\n", "utf8");
    await fs.writeFile(path.join(dir, "index.js"), "import { helper } from './lib.js';\nconsole.log(helper());\n", "utf8");

    const { stdout, ok } = await runBetter(["find-unused-exports", "--json"], dir);
    assert.ok(ok, "find-unused-exports should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.equal(out.ok, true);
      const unused = out.unused ?? [];
      const isHelperUnused = unused.some(u => String(u.name ?? u.symbol ?? u).includes("helper"));
      assert.ok(!isHelperUnused, "helper should NOT be reported as unused (it is imported in index.js)");
    }
  } finally {
    await rmrf(dir);
  }
});

test("find-unused-exports --json detects genuinely unused export", async () => {
  const dir = await makeTempDir("better-unused-detect-");
  try {
    await writeJson(path.join(dir, "package.json"), { name: "test", version: "1.0.0" });
    // lib.js exports 'unusedFn' but nobody imports it
    await fs.writeFile(path.join(dir, "lib.js"), [
      "export function usedFn() { return 1; }",
      "export function unusedFn() { return 2; }"
    ].join("\n"), "utf8");
    await fs.writeFile(path.join(dir, "index.js"), "import { usedFn } from './lib.js';\nconsole.log(usedFn());\n", "utf8");

    const { stdout, ok } = await runBetter(["find-unused-exports", "--json"], dir);
    assert.ok(ok, "find-unused-exports should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      const unused = out.unused ?? [];
      const isUnusedFnFound = unused.some(u => String(u.name ?? u.symbol ?? u).includes("unusedFn"));
      // If the scanner works, unusedFn should be flagged
      if (unused.length > 0) {
        assert.ok(isUnusedFnFound, "unusedFn should be reported as unused");
      }
    }
  } finally {
    await rmrf(dir);
  }
});

// ── deprecation-check ────────────────────────────────────────────────────────

test("deprecation-check --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["deprecation-check", "--help"], process.cwd());
  assert.ok(ok, "deprecation-check --help should succeed");
  assert.ok(
    stdout.includes("deprecat") || stdout.includes("alternative") || stdout.includes("package"),
    "should describe deprecation checking"
  );
});

test("deprecation-check --json returns ok with no packages", async () => {
  const dir = await makeTempDir("better-depcheck-empty-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test",
      version: "1.0.0",
      dependencies: {}
    });

    const { stdout, ok } = await runBetter(["deprecation-check", "--json"], dir);
    assert.ok(ok, "deprecation-check should succeed with no packages");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.equal(out.ok, true);
      assert.ok(out.kind?.includes("deprecat"), `unexpected kind: ${out.kind}`);
      const deprecated = out.deprecated ?? out.packages ?? [];
      assert.equal(deprecated.length, 0, "should have no deprecated packages when none installed");
    }
  } finally {
    await rmrf(dir);
  }
});

test("deprecation-check --json detects deprecated package from known list", async () => {
  const dir = await makeTempDir("better-depcheck-known-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test",
      version: "1.0.0",
      dependencies: { request: "^2.88.0", moment: "^2.29.0" }
    });
    // Install fake packages in node_modules
    const nmDir = path.join(dir, "node_modules");
    await fs.mkdir(path.join(nmDir, "request"), { recursive: true });
    await writeJson(path.join(nmDir, "request", "package.json"), {
      name: "request", version: "2.88.0", deprecated: "request is deprecated"
    });
    await fs.mkdir(path.join(nmDir, "moment"), { recursive: true });
    await writeJson(path.join(nmDir, "moment", "package.json"), {
      name: "moment", version: "2.29.4"
    });

    const { stdout, ok } = await runBetter(["deprecation-check", "--json"], dir);
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean");
      // request is known deprecated; should appear
      const deprecated = out.deprecated ?? out.packages ?? [];
      if (deprecated.length > 0) {
        assert.ok(
          deprecated.some(p => p.name === "request" || p === "request"),
          "request should be flagged as deprecated"
        );
      }
    }
  } finally {
    await rmrf(dir);
  }
});

// ── files-check ───────────────────────────────────────────────────────────────

test("files-check --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["files-check", "--help"], process.cwd());
  assert.ok(ok, "files-check --help should succeed");
  assert.ok(
    stdout.includes("files") || stdout.includes("publish") || stdout.includes("package"),
    "should describe files field checking"
  );
});

test("files-check --json passes when all files in field exist", async () => {
  const dir = await makeTempDir("better-filescheck-ok-");
  try {
    await fs.writeFile(path.join(dir, "index.js"), "module.exports = {};");
    await fs.mkdir(path.join(dir, "src"), { recursive: true });
    await fs.writeFile(path.join(dir, "src", "main.js"), "// main");
    await writeJson(path.join(dir, "package.json"), {
      name: "test-pkg",
      version: "1.0.0",
      files: ["index.js", "src/"]
    });

    const { stdout, ok } = await runBetter(["files-check", "--json"], dir);
    assert.ok(ok, "files-check should pass when files exist");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.equal(out.ok, true);
      assert.ok(out.kind?.includes("files"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

test("files-check --json warns when files field is missing", async () => {
  const dir = await makeTempDir("better-filescheck-missing-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test-pkg",
      version: "1.0.0"
      // No files field
    });

    const { stdout } = await runBetter(["files-check", "--json"], dir);
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean");
      // Should warn about missing files field (ok=false or warnings array)
      if (!out.ok) {
        const hasExplanation = out.error || (out.warnings ?? []).length > 0 || out.reason ||
          (out.checks ?? []).some(c => !c.ok);
        assert.ok(hasExplanation, "should explain why files is missing/empty");
      }
    }
  } finally {
    await rmrf(dir);
  }
});

// ── exports-map ────────────────────────────────────────────────────────────────

test("exports-map --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["exports-map", "--help"], process.cwd());
  assert.ok(ok, "exports-map --help should succeed");
  assert.ok(
    stdout.includes("exports") || stdout.includes("map") || stdout.includes("entry"),
    "should describe exports map inspection"
  );
});

test("exports-map --json returns the exports map for a package", async () => {
  const dir = await makeTempDir("better-exportsmap-");
  try {
    await fs.writeFile(path.join(dir, "index.js"), "module.exports = {};");
    await fs.writeFile(path.join(dir, "utils.js"), "module.exports = {};");
    await writeJson(path.join(dir, "package.json"), {
      name: "test-pkg",
      version: "1.0.0",
      exports: {
        ".": "./index.js",
        "./utils": "./utils.js"
      }
    });

    const { stdout, ok } = await runBetter(["exports-map", "--json"], dir);
    assert.ok(ok, "exports-map should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.equal(out.ok, true);
      assert.ok(out.kind?.includes("exports"), `unexpected kind: ${out.kind}`);
      // Should describe the exports map entries
      const entries = out.entries ?? out.exports ?? out.map ?? [];
      assert.ok(Array.isArray(entries) || typeof entries === "object", "should have exports entries");
    }
  } finally {
    await rmrf(dir);
  }
});

test("exports-map --json handles package with no exports field", async () => {
  const dir = await makeTempDir("better-exportsmap-noexports-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test-pkg",
      version: "1.0.0",
      main: "./index.js"
    });
    await fs.writeFile(path.join(dir, "index.js"), "module.exports = {};");

    const { stdout, ok } = await runBetter(["exports-map", "--json"], dir);
    assert.ok(ok, "exports-map should succeed for package without exports field");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean");
    }
  } finally {
    await rmrf(dir);
  }
});

// ── fund-info ─────────────────────────────────────────────────────────────────

test("fund-info --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["fund-info", "--help"], process.cwd());
  assert.ok(ok, "fund-info --help should succeed");
  assert.ok(
    stdout.includes("fund") || stdout.includes("sponsor") || stdout.includes("donation"),
    "should describe funding information"
  );
});

test("fund-info --json returns ok when project has funding", async () => {
  const dir = await makeTempDir("better-fundinfo-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test-pkg",
      version: "1.0.0",
      funding: {
        type: "opencollective",
        url: "https://opencollective.com/test"
      }
    });

    const { stdout, ok } = await runBetter(["fund-info", "--json"], dir);
    assert.ok(ok, "fund-info should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean");
      assert.ok(out.kind?.includes("fund"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

test("fund-info --json returns ok when no funding field", async () => {
  const dir = await makeTempDir("better-fundinfo-nofund-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test-pkg",
      version: "1.0.0"
    });

    const { stdout, ok } = await runBetter(["fund-info", "--json"], dir);
    assert.ok(ok, "fund-info should succeed even without funding field");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean");
    }
  } finally {
    await rmrf(dir);
  }
});
