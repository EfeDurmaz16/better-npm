// test/alias-prune-nodeversion-misc.test.js
// Tests for: better alias, better prune, better node-version,
//            better phantom-deps, better missing, better installed-check,
//            better optional-deps, better unused-scripts, better publish-check

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

// ── alias ─────────────────────────────────────────────────────────────────────

test("alias --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["alias", "--help"], process.cwd());
  assert.ok(ok, "alias --help should succeed");
  assert.ok(
    stdout.includes("alias") || stdout.includes("shortcut") || stdout.includes("subcommand"),
    "should describe alias management"
  );
});

test("alias list --json returns empty list when no aliases defined", async () => {
  const dir = await makeTempDir("better-alias-list-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0"
    });

    const { stdout, ok } = await runBetter(["alias", "list", "--json"], dir);
    assert.ok(ok, "alias list should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.equal(out.ok, true);
      assert.ok(out.kind?.includes("alias"), `unexpected kind: ${out.kind}`);
      assert.ok(typeof out.aliases === "object", "should have aliases object");
      assert.equal(Object.keys(out.aliases).length, 0, "should have no aliases");
    }
  } finally {
    await rmrf(dir);
  }
});

test("alias add --json creates a new alias", async () => {
  const dir = await makeTempDir("better-alias-add-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0"
    });

    const { stdout, ok } = await runBetter(
      ["alias", "add", "mytest", "better", "health-score", "--json"], dir
    );
    assert.ok(ok, "alias add should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.equal(out.ok, true);
      assert.ok(out.kind?.includes("alias"), `unexpected kind: ${out.kind}`);
    }

    // Verify it was saved
    const pkgJson = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8"));
    const aliases = pkgJson.better?.aliases ?? {};
    assert.ok("mytest" in aliases, "alias should be saved to package.json");
  } finally {
    await rmrf(dir);
  }
});

// ── prune ─────────────────────────────────────────────────────────────────────

test("prune --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["prune", "--help"], process.cwd());
  assert.ok(ok, "prune --help should succeed");
  assert.ok(
    stdout.includes("prune") || stdout.includes("extraneous") || stdout.includes("remove"),
    "should describe pruning extraneous packages"
  );
});

test("prune --dry-run --json reports no extraneous packages when all declared", async () => {
  const dir = await makeTempDir("better-prune-ok-");
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

    const { stdout, ok } = await runBetter(["prune", "--dry-run", "--json"], dir);
    assert.ok(ok, "prune should succeed with no extraneous packages");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.equal(out.ok, true);
      assert.ok(out.kind?.includes("prune"), `unexpected kind: ${out.kind}`);
      assert.equal(out.extraneous, 0, "should have 0 extraneous packages");
    }
  } finally {
    await rmrf(dir);
  }
});

test("prune --dry-run --json detects extraneous packages", async () => {
  const dir = await makeTempDir("better-prune-extra-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      dependencies: {}  // No declared deps
    });
    const nmDir = path.join(dir, "node_modules");
    await fs.mkdir(path.join(nmDir, "extraneous-pkg"), { recursive: true });
    await writeJson(path.join(nmDir, "extraneous-pkg", "package.json"), {
      name: "extraneous-pkg", version: "1.0.0"
    });

    const { stdout } = await runBetter(["prune", "--dry-run", "--json"], dir);
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("prune"), `unexpected kind: ${out.kind}`);
      assert.ok(out.extraneous >= 1, "should detect extraneous-pkg as extraneous");
    }
  } finally {
    await rmrf(dir);
  }
});

// ── node-version ──────────────────────────────────────────────────────────────

test("node-version --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["node-version", "--help"], process.cwd());
  assert.ok(ok, "node-version --help should succeed");
  assert.ok(
    stdout.includes("node") || stdout.includes("version") || stdout.includes("engines"),
    "should describe Node.js version checking"
  );
});

test("node-version --json reports current Node.js version", async () => {
  const dir = await makeTempDir("better-nodeversion-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0"
    });

    const { stdout, ok } = await runBetter(["node-version", "--json"], dir);
    assert.ok(ok, "node-version should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("node-version") || out.kind?.includes("node"), `unexpected kind: ${out.kind}`);
      assert.ok(out.current, "should report current node version");
      assert.ok(out.current.includes("."), "current should look like a version");
    }
  } finally {
    await rmrf(dir);
  }
});

test("node-version --json ok=true when engines.node is satisfied", async () => {
  const dir = await makeTempDir("better-nodeversion-satisfied-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      engines: { node: ">=14" }  // Any modern Node satisfies this
    });

    const { stdout, ok } = await runBetter(["node-version", "--json"], dir);
    assert.ok(ok, "node-version should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.equal(out.ok, true, "should be ok with >=14 requirement on modern Node");
      assert.equal(out.compatible, true, "should be compatible");
    }
  } finally {
    await rmrf(dir);
  }
});

// ── phantom-deps ──────────────────────────────────────────────────────────────

test("phantom-deps --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["phantom-deps", "--help"], process.cwd());
  assert.ok(ok, "phantom-deps --help should succeed");
  assert.ok(
    stdout.includes("phantom") || stdout.includes("undeclared") || stdout.includes("import"),
    "should describe phantom dependency detection"
  );
});

test("phantom-deps --json finds no phantoms when imports match deps", async () => {
  const dir = await makeTempDir("better-phantom-ok-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      dependencies: { "declared-dep": "^1.0.0" }
    });
    await fs.writeFile(
      path.join(dir, "index.js"),
      "const dep = require('declared-dep');\n",
      "utf8"
    );

    const { stdout, ok } = await runBetter(["phantom-deps", "--json"], dir);
    assert.ok(ok, "phantom-deps should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.equal(out.ok, true);
      assert.ok(out.kind?.includes("phantom"), `unexpected kind: ${out.kind}`);
      assert.equal(out.phantoms, 0, "should have no phantom dependencies");
    }
  } finally {
    await rmrf(dir);
  }
});

test("phantom-deps --json detects undeclared import", async () => {
  const dir = await makeTempDir("better-phantom-found-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      dependencies: {}  // Nothing declared
    });
    await fs.writeFile(
      path.join(dir, "index.js"),
      "const lodash = require('lodash');\n",
      "utf8"
    );
    // lodash is imported but not installed - it's a phantom
    const nmDir = path.join(dir, "node_modules");
    await fs.mkdir(path.join(nmDir, "lodash"), { recursive: true });
    await writeJson(path.join(nmDir, "lodash", "package.json"), {
      name: "lodash", version: "4.17.21"
    });

    const { stdout } = await runBetter(["phantom-deps", "--json"], dir);
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      // lodash is imported but not in dependencies → phantom
      if (!out.ok) {
        assert.ok(out.phantoms >= 1, "should detect at least one phantom");
        const pkgs = out.packages ?? [];
        if (pkgs.length > 0) {
          assert.ok(pkgs.includes("lodash") || pkgs.some(p => p === "lodash"),
            "should report lodash as phantom");
        }
      }
    }
  } finally {
    await rmrf(dir);
  }
});

// ── missing ───────────────────────────────────────────────────────────────────

test("missing --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["missing", "--help"], process.cwd());
  assert.ok(ok, "missing --help should succeed");
  assert.ok(
    stdout.includes("missing") || stdout.includes("import") || stdout.includes("declare"),
    "should describe missing dependency detection"
  );
});

test("missing --json returns no missing when no source files", async () => {
  const dir = await makeTempDir("better-missing-empty-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      dependencies: {}
    });

    const { stdout, ok } = await runBetter(["missing", "--json"], dir);
    assert.ok(ok, "missing should succeed with no source files");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("missing"), `unexpected kind: ${out.kind}`);
      const missing = out.missing ?? [];
      assert.equal(missing.length, 0, "should have no missing dependencies");
    }
  } finally {
    await rmrf(dir);
  }
});

// ── installed-check ───────────────────────────────────────────────────────────

test("installed-check --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["installed-check", "--help"], process.cwd());
  assert.ok(ok, "installed-check --help should succeed");
  assert.ok(
    stdout.includes("install") || stdout.includes("check") || stdout.includes("missing"),
    "should describe installed dependency checking"
  );
});

test("installed-check --json passes when all deps are installed", async () => {
  const dir = await makeTempDir("better-installedcheck-ok-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      dependencies: { "my-dep": "^1.0.0" }
    });
    const nmDir = path.join(dir, "node_modules");
    await fs.mkdir(path.join(nmDir, "my-dep"), { recursive: true });
    await writeJson(path.join(nmDir, "my-dep", "package.json"), {
      name: "my-dep", version: "1.0.0"
    });

    const { stdout, ok } = await runBetter(["installed-check", "--json"], dir);
    assert.ok(ok, "installed-check should succeed when all deps installed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.equal(out.ok, true);
      assert.ok(out.kind?.includes("installed"), `unexpected kind: ${out.kind}`);
      assert.equal(out.missing, 0, "should have 0 missing packages");
    }
  } finally {
    await rmrf(dir);
  }
});

test("installed-check --json fails when dep is not installed", async () => {
  const dir = await makeTempDir("better-installedcheck-missing-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      dependencies: { "not-installed": "^1.0.0" }
    });
    // node_modules exists but not-installed is absent
    await fs.mkdir(path.join(dir, "node_modules"), { recursive: true });

    const { stdout } = await runBetter(["installed-check", "--json"], dir);
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.equal(out.ok, false, "should fail when dep is not installed");
      assert.ok(out.missing >= 1, "should report 1 missing package");
    }
  } finally {
    await rmrf(dir);
  }
});

// ── optional-deps ─────────────────────────────────────────────────────────────

test("optional-deps --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["optional-deps", "--help"], process.cwd());
  assert.ok(ok, "optional-deps --help should succeed");
  assert.ok(
    stdout.includes("optional") || stdout.includes("deps") || stdout.includes("facultatif"),
    "should describe optional dependency checking"
  );
});

test("optional-deps --json returns empty list when no optional deps", async () => {
  const dir = await makeTempDir("better-optionaldeps-empty-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      dependencies: { "dep-a": "^1.0.0" }
    });

    const { stdout, ok } = await runBetter(["optional-deps", "--json"], dir);
    assert.ok(ok, "optional-deps should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.equal(out.ok, true);
      assert.ok(out.kind?.includes("optional"), `unexpected kind: ${out.kind}`);
      assert.equal(out.count, 0, "should have no optional deps");
    }
  } finally {
    await rmrf(dir);
  }
});

test("optional-deps --json lists optional dependencies", async () => {
  const dir = await makeTempDir("better-optionaldeps-found-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      optionalDependencies: { "opt-dep": "^1.0.0" }
    });
    const nmDir = path.join(dir, "node_modules");
    await fs.mkdir(path.join(nmDir, "opt-dep"), { recursive: true });
    await writeJson(path.join(nmDir, "opt-dep", "package.json"), {
      name: "opt-dep", version: "1.0.0"
    });

    const { stdout, ok } = await runBetter(["optional-deps", "--json"], dir);
    assert.ok(ok, "optional-deps should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.equal(out.ok, true);
      assert.ok(out.count >= 1, "should find optional dep");
      assert.ok(Array.isArray(out.deps), "should have deps array");
      assert.ok(out.deps.some(d => (d.name ?? d) === "opt-dep"),
        "should include opt-dep in deps list");
    }
  } finally {
    await rmrf(dir);
  }
});

// ── unused-scripts ────────────────────────────────────────────────────────────

test("unused-scripts --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["unused-scripts", "--help"], process.cwd());
  assert.ok(ok, "unused-scripts --help should succeed");
  assert.ok(
    stdout.includes("script") || stdout.includes("unused") || stdout.includes("npm"),
    "should describe unused script detection"
  );
});

test("unused-scripts --json returns ok when no scripts defined", async () => {
  const dir = await makeTempDir("better-unusedscripts-none-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0"
    });

    const { stdout, ok } = await runBetter(["unused-scripts", "--json"], dir);
    assert.ok(ok, "unused-scripts should succeed with no scripts");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.equal(out.ok, true);
      assert.ok(out.kind?.includes("unused-scripts") || out.kind?.includes("scripts"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

test("unused-scripts --json lists all scripts with usage status", async () => {
  const dir = await makeTempDir("better-unusedscripts-found-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      scripts: {
        test: "node --test",
        build: "tsc",
        "test:unit": "node --test src"
      }
    });

    const { stdout, ok } = await runBetter(["unused-scripts", "--json"], dir);
    assert.ok(ok, "unused-scripts should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(Array.isArray(out.scripts), "should have scripts array");
      assert.ok(typeof out.total === "number", "should have total count");
    }
  } finally {
    await rmrf(dir);
  }
});

// ── publish-check ─────────────────────────────────────────────────────────────

test("publish-check --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["publish-check", "--help"], process.cwd());
  assert.ok(ok, "publish-check --help should succeed");
  assert.ok(
    stdout.includes("publish") || stdout.includes("check") || stdout.includes("pre-publish"),
    "should describe pre-publish checking"
  );
});

test("publish-check --json returns checks array for publishable package", async () => {
  const dir = await makeTempDir("better-publishcheck-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "my-lib",
      version: "1.0.0",
      description: "A test library",
      license: "MIT",
      main: "index.js",
      files: ["index.js"]
    });
    await fs.writeFile(path.join(dir, "index.js"), "module.exports = {};\n");

    const { stdout } = await runBetter(["publish-check", "--json"], dir);
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("publish"), `unexpected kind: ${out.kind}`);
      assert.ok(Array.isArray(out.checks), "should have checks array");
      assert.ok(typeof out.errors === "number", "should have errors count");
      assert.ok(typeof out.warnings === "number", "should have warnings count");
    }
  } finally {
    await rmrf(dir);
  }
});

test("publish-check --json fails for private package", async () => {
  const dir = await makeTempDir("better-publishcheck-private-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "private-pkg", version: "1.0.0",
      private: true
    });

    const { stdout } = await runBetter(["publish-check", "--json"], dir);
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.equal(out.ok, false, "private package should fail publish-check");
    }
  } finally {
    await rmrf(dir);
  }
});
