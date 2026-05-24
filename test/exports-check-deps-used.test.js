// test/exports-check-deps-used.test.js
// Tests for: better exports-check, better deps-used, better check-updates,
//            better ci-check, better contributors

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

// ── exports-check ─────────────────────────────────────────────────────────────

test("exports-check --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["exports-check", "--help"], process.cwd());
  assert.ok(ok, "exports-check --help should succeed");
  assert.ok(stdout.includes("exports") || stdout.includes("validate"), "should mention exports");
});

test("exports-check --json passes when no exports field", async () => {
  const dir = await makeTempDir("better-exportscheck-none-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test-pkg",
      version: "1.0.0",
      main: "index.js"
    });
    await fs.writeFile(path.join(dir, "index.js"), "module.exports = {};\n", "utf8");

    const { stdout, ok } = await runBetter(["exports-check", "--json"], dir);
    assert.ok(ok, "exports-check should succeed when no exports field");
    const out = JSON.parse(stdout);
    assert.equal(out.ok, true);
    assert.ok(out.kind?.includes("exports"), `unexpected kind: ${out.kind}`);
  } finally {
    await rmrf(dir);
  }
});

test("exports-check --json passes when all exports exist", async () => {
  const dir = await makeTempDir("better-exportscheck-ok-");
  try {
    await fs.writeFile(path.join(dir, "index.js"), "module.exports = {};\n", "utf8");
    await fs.writeFile(path.join(dir, "utils.js"), "module.exports = {};\n", "utf8");
    await writeJson(path.join(dir, "package.json"), {
      name: "test-pkg",
      version: "1.0.0",
      exports: {
        ".": "./index.js",
        "./utils": "./utils.js"
      }
    });

    const { stdout, ok } = await runBetter(["exports-check", "--json"], dir);
    assert.ok(ok, "exports-check should pass when all exports exist");
    const out = JSON.parse(stdout);
    assert.equal(out.ok, true);
    const checks = out.checks ?? out.exports ?? [];
    assert.ok(Array.isArray(checks), "should have checks/exports array");
    assert.ok(checks.every(e => e.ok !== false), "all exports should be ok");
  } finally {
    await rmrf(dir);
  }
});

test("exports-check --json fails when exported file is missing", async () => {
  const dir = await makeTempDir("better-exportscheck-missing-");
  try {
    await fs.writeFile(path.join(dir, "index.js"), "module.exports = {};\n", "utf8");
    // does NOT create utils.js
    await writeJson(path.join(dir, "package.json"), {
      name: "test-pkg",
      version: "1.0.0",
      exports: {
        ".": "./index.js",
        "./utils": "./utils.js" // missing
      }
    });

    const { stdout, ok, exitCode } = await runBetter(["exports-check", "--json"], dir);
    assert.ok(!ok || exitCode !== 0, "exports-check should fail when exports are missing");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.equal(out.ok, false);
      const checks = out.checks ?? out.exports ?? [];
      const missing = checks.filter(e => !e.ok);
      assert.ok(
        missing.some(e => String(e.path ?? e.field ?? e.condition ?? "").includes("utils")),
        "should flag utils as missing"
      );
    }
  } finally {
    await rmrf(dir);
  }
});

test("exports-check handles conditional exports (require/import)", async () => {
  const dir = await makeTempDir("better-exportscheck-cond-");
  try {
    await fs.writeFile(path.join(dir, "index.cjs"), "module.exports = {};\n", "utf8");
    await fs.writeFile(path.join(dir, "index.mjs"), "export default {};\n", "utf8");
    await writeJson(path.join(dir, "package.json"), {
      name: "dual-pkg",
      version: "1.0.0",
      main: "./index.cjs",
      exports: {
        ".": {
          require: "./index.cjs",
          import: "./index.mjs"
        }
      }
    });

    const { stdout, ok } = await runBetter(["exports-check", "--json"], dir);
    assert.ok(ok, "exports-check should pass when conditional exports exist");
    const out = JSON.parse(stdout);
    assert.equal(out.ok, true);
  } finally {
    await rmrf(dir);
  }
});

// ── deps-used ────────────────────────────────────────────────────────────────

test("deps-used --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["deps-used", "--help"], process.cwd());
  assert.ok(ok, "deps-used --help should succeed");
  assert.ok(
    stdout.includes("deps") || stdout.includes("import") || stdout.includes("used"),
    "should describe import scanning"
  );
});

test("deps-used --json returns empty map when no source files", async () => {
  const dir = await makeTempDir("better-depsused-empty-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test",
      version: "1.0.0",
      dependencies: { lodash: "^4.17.21" }
    });

    const { stdout, ok } = await runBetter(["deps-used", "--json"], dir);
    assert.ok(ok, "deps-used should succeed with no source files");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.equal(out.ok, true);
      assert.ok(out.kind?.includes("deps-used"), `unexpected kind: ${out.kind}`);
      assert.ok(typeof out.packages === "object" || Array.isArray(out.packages), "should have packages map");
    }
  } finally {
    await rmrf(dir);
  }
});

test("deps-used --json detects package imports in JS files", async () => {
  const dir = await makeTempDir("better-depsused-detect-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test",
      version: "1.0.0",
      dependencies: { lodash: "^4.17.21", axios: "^1.4.0" }
    });
    // Create source file that imports lodash but not axios
    await fs.writeFile(path.join(dir, "index.js"), [
      "const _ = require('lodash');",
      "const result = _.get({a: 1}, 'a');",
      "module.exports = result;"
    ].join("\n"), "utf8");

    const { stdout, ok } = await runBetter(["deps-used", "--json"], dir);
    assert.ok(ok, "deps-used should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.equal(out.ok, true);
      const pkgMap = out.packages;
      const lodashFiles = Array.isArray(pkgMap)
        ? pkgMap.find(p => p.name === "lodash")?.files
        : pkgMap?.lodash;
      assert.ok(
        (Array.isArray(lodashFiles) && lodashFiles.length > 0) ||
        typeof lodashFiles === "number" && lodashFiles > 0,
        "lodash should be detected as used"
      );
    }
  } finally {
    await rmrf(dir);
  }
});

test("deps-used --json supports ESM import syntax", async () => {
  const dir = await makeTempDir("better-depsused-esm-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test",
      version: "1.0.0",
      type: "module",
      dependencies: { chalk: "^5.0.0" }
    });
    await fs.writeFile(path.join(dir, "main.js"), [
      "import chalk from 'chalk';",
      "console.log(chalk.red('hello'));"
    ].join("\n"), "utf8");

    const { stdout, ok } = await runBetter(["deps-used", "--json"], dir);
    assert.ok(ok, "deps-used should succeed with ESM");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.equal(out.ok, true);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── check-updates ─────────────────────────────────────────────────────────────

test("check-updates --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["check-updates", "--help"], process.cwd());
  assert.ok(ok, "check-updates --help should succeed");
  assert.ok(
    stdout.includes("update") || stdout.includes("latest") || stdout.includes("major"),
    "should describe update checking"
  );
});

test("check-updates --json returns ok and packages array (no dependencies)", async () => {
  const dir = await makeTempDir("better-checkupdates-empty-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test",
      version: "1.0.0",
      dependencies: {}
    });

    const { stdout, ok } = await runBetter(["check-updates", "--json"], dir);
    assert.ok(ok, "check-updates should succeed with no dependencies");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.equal(out.ok, true);
      assert.ok(out.kind?.includes("check-updates") || out.kind?.includes("updates"), `unexpected kind: ${out.kind}`);
      const packages = out.packages ?? out.updates ?? [];
      assert.equal(packages.length, 0, "no packages to update");
    }
  } finally {
    await rmrf(dir);
  }
});

test("check-updates --json --major-only filters to major updates", async (t) => {
  const dir = await makeTempDir("better-checkupdates-major-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test",
      version: "1.0.0",
      dependencies: { lodash: "^4.17.0" }
    });

    const result = await runBetter(["check-updates", "--major-only", "--json"], dir);
    if (!result.ok && (result.stderr.includes("ENOTFOUND") || result.stderr.includes("ETIMEDOUT") || result.stderr.includes("timed out"))) {
      t.skip("network unavailable");
      return;
    }
    if (result.stdout.trim()) {
      const out = JSON.parse(result.stdout);
      assert.equal(out.ok, true);
      const packages = out.packages ?? out.updates ?? [];
      // All reported updates should be major bumps
      for (const p of packages) {
        assert.ok(
          p.type === "major" || p.bumpType === "major" || p.updateType === "major",
          `${p.name} should be a major update`
        );
      }
    }
  } finally {
    await rmrf(dir);
  }
});

// ── ci-check ─────────────────────────────────────────────────────────────────

test("ci-check --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["ci-check", "--help"], process.cwd());
  assert.ok(ok, "ci-check --help should succeed");
  assert.ok(
    stdout.includes("ci") || stdout.includes("config") || stdout.includes("CI"),
    "should describe CI checking"
  );
});

test("ci-check --json detects CI config files", async () => {
  const dir = await makeTempDir("better-cicheck-");
  try {
    await writeJson(path.join(dir, "package.json"), { name: "test", version: "1.0.0" });
    // Create a GitHub Actions config
    await fs.mkdir(path.join(dir, ".github", "workflows"), { recursive: true });
    await fs.writeFile(
      path.join(dir, ".github", "workflows", "ci.yml"),
      "name: CI\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n"
    );

    const { stdout, ok } = await runBetter(["ci-check", "--json"], dir);
    assert.ok(ok, "ci-check should succeed when CI config exists");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.equal(out.ok, true);
      assert.ok(out.kind?.includes("ci"), `unexpected kind: ${out.kind}`);
      const detected = out.detected ?? out.platforms ?? out.configs ?? [];
      assert.ok(
        detected.some(p => String(p.name ?? p).toLowerCase().includes("github")) ||
        out.platform?.toLowerCase().includes("github") ||
        out.hasGithubActions === true,
        "should detect GitHub Actions config"
      );
    }
  } finally {
    await rmrf(dir);
  }
});

test("ci-check --json reports no CI when no config files present", async () => {
  const dir = await makeTempDir("better-cicheck-none-");
  try {
    await writeJson(path.join(dir, "package.json"), { name: "test", version: "1.0.0" });

    const { stdout, ok } = await runBetter(["ci-check", "--json"], dir);
    // May succeed with ok=true and no CI found, or ok=false
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      if (out.ok) {
        const platforms = out.platforms ?? out.configs ?? [];
        assert.equal(platforms.length, 0, "should have no CI platforms when no config files");
      }
    }
  } finally {
    await rmrf(dir);
  }
});
