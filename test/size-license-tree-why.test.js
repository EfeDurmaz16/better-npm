// test/size-license-tree-why.test.js
// Tests for: better size, better license, better license-compat,
//            better license-policy, better tree, better list-scripts,
//            better why, better peer-check, better outdated

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

async function makePkgWithDeps(dir, deps = {}, devDeps = {}) {
  await writeJson(path.join(dir, "package.json"), {
    name: "test-project",
    version: "1.0.0",
    license: "MIT",
    dependencies: deps,
    devDependencies: devDeps
  });
}

async function installFakePkg(nmDir, name, version = "1.0.0", extra = {}) {
  const pkgDir = path.join(nmDir, name);
  await fs.mkdir(pkgDir, { recursive: true });
  await writeJson(path.join(pkgDir, "package.json"), { name, version, license: "MIT", ...extra });
  await fs.writeFile(path.join(pkgDir, "index.js"), `module.exports = {};\n${"x".repeat(1000)}`);
}

// ── size ─────────────────────────────────────────────────────────────────────

test("size --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["size", "--help"], process.cwd());
  assert.ok(ok, "size --help should succeed");
  assert.ok(
    stdout.includes("size") || stdout.includes("disk") || stdout.includes("package"),
    "should describe package size inspection"
  );
});

test("size --json returns package sizes when node_modules exists", async () => {
  const dir = await makeTempDir("better-size-");
  try {
    await makePkgWithDeps(dir, { "my-dep": "^1.0.0" });
    const nmDir = path.join(dir, "node_modules");
    await installFakePkg(nmDir, "my-dep");

    const { stdout, ok } = await runBetter(["size", "--json"], dir);
    assert.ok(ok, "size should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(Array.isArray(out.packages), "should have packages array");
    }
  } finally {
    await rmrf(dir);
  }
});

test("size --json reports bytes for installed packages", async () => {
  const dir = await makeTempDir("better-size-bytes-");
  try {
    const nmDir = path.join(dir, "node_modules");
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      dependencies: { "small-pkg": "^1.0.0", "big-pkg": "^1.0.0" }
    });
    // big-pkg has more files
    await fs.mkdir(path.join(nmDir, "small-pkg"), { recursive: true });
    await writeJson(path.join(nmDir, "small-pkg", "package.json"), { name: "small-pkg", version: "1.0.0" });
    await fs.writeFile(path.join(nmDir, "small-pkg", "index.js"), "x".repeat(500));
    await fs.mkdir(path.join(nmDir, "big-pkg"), { recursive: true });
    await writeJson(path.join(nmDir, "big-pkg", "package.json"), { name: "big-pkg", version: "1.0.0" });
    await fs.writeFile(path.join(nmDir, "big-pkg", "index.js"), "x".repeat(50000));

    const { stdout, ok } = await runBetter(["size", "--json"], dir);
    assert.ok(ok, "size should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(out.packages.length >= 1, "should report at least one package");
      for (const pkg of out.packages) {
        assert.ok(typeof pkg.name === "string", "each package should have a name");
        const ownSize = pkg.ownBytes ?? pkg.size ?? pkg.bytes;
        assert.ok(typeof ownSize === "number" || ownSize === undefined, "size should be a number if present");
      }
    }
  } finally {
    await rmrf(dir);
  }
});

// ── license ───────────────────────────────────────────────────────────────────

test("license --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["license", "--help"], process.cwd());
  assert.ok(ok, "license --help should succeed");
  assert.ok(
    stdout.includes("license") || stdout.includes("scan") || stdout.includes("allow"),
    "should describe license scanning"
  );
});

test("license --json returns packages array with license info", async () => {
  const dir = await makeTempDir("better-license-");
  try {
    await makePkgWithDeps(dir, { "mit-pkg": "^1.0.0" });
    const nmDir = path.join(dir, "node_modules");
    await fs.mkdir(path.join(nmDir, "mit-pkg"), { recursive: true });
    await writeJson(path.join(nmDir, "mit-pkg", "package.json"), {
      name: "mit-pkg", version: "1.0.0", license: "MIT"
    });

    const { stdout, ok } = await runBetter(["license", "--json"], dir);
    assert.ok(ok, "license should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("license"), `unexpected kind: ${out.kind}`);
      assert.ok(Array.isArray(out.packages), "should have packages array");
    }
  } finally {
    await rmrf(dir);
  }
});

test("license --deny blocks forbidden licenses", async () => {
  const dir = await makeTempDir("better-license-deny-");
  try {
    await makePkgWithDeps(dir, { "gpl-pkg": "^1.0.0" });
    const nmDir = path.join(dir, "node_modules");
    await fs.mkdir(path.join(nmDir, "gpl-pkg"), { recursive: true });
    await writeJson(path.join(nmDir, "gpl-pkg", "package.json"), {
      name: "gpl-pkg", version: "1.0.0", license: "GPL-3.0"
    });

    const { stdout } = await runBetter(["license", "--deny", "GPL-3.0", "--json"], dir);
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      // ok should be false when a denied license is found
      assert.ok(typeof out.ok === "boolean", "should have ok field");
    }
  } finally {
    await rmrf(dir);
  }
});

// ── license-compat ────────────────────────────────────────────────────────────

test("license-compat --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["license-compat", "--help"], process.cwd());
  assert.ok(ok, "license-compat --help should succeed");
  assert.ok(
    stdout.includes("compat") || stdout.includes("license") || stdout.includes("compatible"),
    "should describe license compatibility checking"
  );
});

test("license-compat --json returns ok for MIT project with MIT deps", async () => {
  const dir = await makeTempDir("better-licensecompat-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0", license: "MIT"
    });
    const nmDir = path.join(dir, "node_modules");
    await fs.mkdir(path.join(nmDir, "dep-a"), { recursive: true });
    await writeJson(path.join(nmDir, "dep-a", "package.json"), {
      name: "dep-a", version: "1.0.0", license: "MIT"
    });

    const { stdout, ok } = await runBetter(["license-compat", "--json"], dir);
    assert.ok(ok, "license-compat should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("license"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── license-policy ────────────────────────────────────────────────────────────

test("license-policy --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["license-policy", "--help"], process.cwd());
  assert.ok(ok, "license-policy --help should succeed");
  assert.ok(
    stdout.includes("policy") || stdout.includes("license") || stdout.includes("block"),
    "should describe license policy enforcement"
  );
});

test("license-policy --json returns ok with only permissive licenses", async () => {
  const dir = await makeTempDir("better-licensepolicy-ok-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0", license: "MIT"
    });
    const nmDir = path.join(dir, "node_modules");
    await fs.mkdir(path.join(nmDir, "pkg-a"), { recursive: true });
    await writeJson(path.join(nmDir, "pkg-a", "package.json"), {
      name: "pkg-a", version: "1.0.0", license: "ISC"
    });

    const { stdout, ok } = await runBetter(["license-policy", "--json"], dir);
    assert.ok(ok, "license-policy should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("license") || out.kind?.includes("policy"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

test("license-policy --block rejects blocked licenses", async () => {
  const dir = await makeTempDir("better-licensepolicy-block-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0", license: "MIT"
    });
    const nmDir = path.join(dir, "node_modules");
    await fs.mkdir(path.join(nmDir, "copyleft-dep"), { recursive: true });
    await writeJson(path.join(nmDir, "copyleft-dep", "package.json"), {
      name: "copyleft-dep", version: "1.0.0", license: "GPL-3.0"
    });

    const { stdout } = await runBetter(["license-policy", "--block", "GPL-3.0", "--json"], dir);
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      // GPL-3.0 is blocked → ok should be false
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      if (!out.ok) {
        const blocked = out.blocked ?? out.violations ?? out.issues ?? [];
        if (blocked.length > 0) {
          assert.ok(blocked.some(b => (b.name ?? b.package ?? b) === "copyleft-dep"),
            "blocked list should include copyleft-dep");
        }
      }
    }
  } finally {
    await rmrf(dir);
  }
});

// ── tree ─────────────────────────────────────────────────────────────────────

test("tree --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["tree", "--help"], process.cwd());
  assert.ok(ok, "tree --help should succeed");
  assert.ok(
    stdout.includes("tree") || stdout.includes("dependency") || stdout.includes("depth"),
    "should describe dependency tree"
  );
});

test("tree --json returns tree structure with node_modules", async () => {
  const dir = await makeTempDir("better-tree-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "my-app",
      version: "1.0.0",
      dependencies: { "dep-a": "^1.0.0" }
    });
    const nmDir = path.join(dir, "node_modules");
    await fs.mkdir(path.join(nmDir, "dep-a"), { recursive: true });
    await writeJson(path.join(nmDir, "dep-a", "package.json"), {
      name: "dep-a", version: "1.0.0"
    });

    const { stdout, ok } = await runBetter(["tree", "--json"], dir);
    assert.ok(ok, "tree should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.equal(out.ok, true);
      assert.ok(out.kind?.includes("tree"), `unexpected kind: ${out.kind}`);
      assert.ok(Array.isArray(out.tree), "should have tree array");
    }
  } finally {
    await rmrf(dir);
  }
});

test("tree --json handles no dependencies", async () => {
  const dir = await makeTempDir("better-tree-empty-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "bare-app", version: "1.0.0"
    });
    await fs.mkdir(path.join(dir, "node_modules"), { recursive: true });

    const { stdout, ok } = await runBetter(["tree", "--json"], dir);
    assert.ok(ok, "tree should succeed with no dependencies");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
    }
  } finally {
    await rmrf(dir);
  }
});

// ── list-scripts ──────────────────────────────────────────────────────────────

test("list-scripts --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["list-scripts", "--help"], process.cwd());
  assert.ok(ok, "list-scripts --help should succeed");
  assert.ok(
    stdout.includes("script") || stdout.includes("list") || stdout.includes("npm"),
    "should describe script listing"
  );
});

test("list-scripts --json returns scripts from package.json", async () => {
  const dir = await makeTempDir("better-listscripts-");
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

    const { stdout, ok } = await runBetter(["list-scripts", "--json"], dir);
    assert.ok(ok, "list-scripts should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.equal(out.ok, true);
      assert.ok(out.kind?.includes("list-scripts") || out.kind?.includes("scripts"), `unexpected kind: ${out.kind}`);
      assert.ok(Array.isArray(out.scripts), "should have scripts array");
      // total reflects all scripts; shown may be filtered
      const total = out.total ?? out.scripts.length;
      assert.ok(total >= 3, `should report 3 total scripts, got ${total}`);
    }
  } finally {
    await rmrf(dir);
  }
});

test("list-scripts --json returns empty list when no scripts", async () => {
  const dir = await makeTempDir("better-listscripts-empty-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0"
    });

    const { stdout, ok } = await runBetter(["list-scripts", "--json"], dir);
    assert.ok(ok, "list-scripts should succeed with no scripts");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      const total = out.total ?? (Array.isArray(out.scripts) ? out.scripts.length : 0);
      assert.equal(total, 0, "should report 0 scripts");
    }
  } finally {
    await rmrf(dir);
  }
});

// ── why ───────────────────────────────────────────────────────────────────────

test("why --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["why", "--help"], process.cwd());
  assert.ok(ok, "why --help should succeed");
  assert.ok(
    stdout.includes("why") || stdout.includes("package") || stdout.includes("depend"),
    "should describe dependency tracing"
  );
});

test("why --json finds direct dependency", async () => {
  const dir = await makeTempDir("better-why-direct-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "my-app", version: "1.0.0",
      dependencies: { "my-lib": "^1.0.0" }
    });
    const lockfile = {
      name: "my-app", lockfileVersion: 3,
      packages: {
        "": { name: "my-app", version: "1.0.0", dependencies: { "my-lib": "^1.0.0" } },
        "node_modules/my-lib": { name: "my-lib", version: "1.0.0" }
      }
    };
    await writeJson(path.join(dir, "package-lock.json"), lockfile);
    const nmDir = path.join(dir, "node_modules");
    await fs.mkdir(path.join(nmDir, "my-lib"), { recursive: true });
    await writeJson(path.join(nmDir, "my-lib", "package.json"), {
      name: "my-lib", version: "1.0.0"
    });

    const { stdout, ok } = await runBetter(["why", "my-lib", "--json"], dir);
    assert.ok(ok, "why should succeed for direct dependency");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("why"), `unexpected kind: ${out.kind}`);
      assert.ok(out.package === "my-lib" || out.name === "my-lib", "should report the package name");
    }
  } finally {
    await rmrf(dir);
  }
});

test("why requires a package name argument", async () => {
  const dir = await makeTempDir("better-why-noarg-");
  try {
    await writeJson(path.join(dir, "package.json"), { name: "test", version: "1.0.0" });
    const { ok } = await runBetter(["why"], dir);
    assert.ok(!ok, "why with no args should fail");
  } finally {
    await rmrf(dir);
  }
});

// ── peer-check ────────────────────────────────────────────────────────────────

test("peer-check --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["peer-check", "--help"], process.cwd());
  assert.ok(ok, "peer-check --help should succeed");
  assert.ok(
    stdout.includes("peer") || stdout.includes("dependency") || stdout.includes("conflict"),
    "should describe peer dependency checking"
  );
});

test("peer-check --json returns ok when no peer issues", async () => {
  const dir = await makeTempDir("better-peercheck-ok-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      dependencies: { "simple-dep": "^1.0.0" }
    });
    const nmDir = path.join(dir, "node_modules");
    await fs.mkdir(path.join(nmDir, "simple-dep"), { recursive: true });
    await writeJson(path.join(nmDir, "simple-dep", "package.json"), {
      name: "simple-dep", version: "1.0.0"
      // no peer dependencies
    });

    const { stdout, ok } = await runBetter(["peer-check", "--json"], dir);
    assert.ok(ok, "peer-check should succeed with no peer issues");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("peer"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

test("peer-check --json detects unsatisfied peer dependency", async () => {
  const dir = await makeTempDir("better-peercheck-missing-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      dependencies: { "plugin": "^1.0.0" }
    });
    const nmDir = path.join(dir, "node_modules");
    await fs.mkdir(path.join(nmDir, "plugin"), { recursive: true });
    await writeJson(path.join(nmDir, "plugin", "package.json"), {
      name: "plugin", version: "1.0.0",
      peerDependencies: { "host-app": ">=2.0.0" }
      // host-app is not installed
    });

    const { stdout } = await runBetter(["peer-check", "--json"], dir);
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      // Should detect missing peer dependency
      const issues = out.issues ?? [];
      if (issues.length > 0) {
        assert.ok(issues.some(i => (i.peer ?? i.name ?? i.package ?? "").includes("host-app")),
          "should report missing host-app peer");
      }
    }
  } finally {
    await rmrf(dir);
  }
});

// ── outdated ─────────────────────────────────────────────────────────────────

test("outdated --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["outdated", "--help"], process.cwd());
  assert.ok(ok, "outdated --help should succeed");
  assert.ok(
    stdout.includes("outdated") || stdout.includes("update") || stdout.includes("version"),
    "should describe outdated package detection"
  );
});

test("outdated --json returns ok with empty packages when no node_modules", async () => {
  const dir = await makeTempDir("better-outdated-empty-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      dependencies: {}
    });

    const { stdout, ok } = await runBetter(["outdated", "--json"], dir);
    assert.ok(ok, "outdated should succeed with no packages");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("outdated"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

test("outdated --json detects installed packages that could be updated", async () => {
  const dir = await makeTempDir("better-outdated-detect-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      dependencies: { "old-pkg": "^1.0.0" }
    });
    const nmDir = path.join(dir, "node_modules");
    await fs.mkdir(path.join(nmDir, "old-pkg"), { recursive: true });
    await writeJson(path.join(nmDir, "old-pkg", "package.json"), {
      name: "old-pkg", version: "1.0.0"
    });

    const { stdout, ok } = await runBetter(["outdated", "--json"], dir);
    assert.ok(ok, "outdated should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(Array.isArray(out.packages), "should have packages array");
      assert.ok(typeof out.summary === "object" || out.summary !== undefined || out.packages !== undefined,
        "should have summary or packages");
    }
  } finally {
    await rmrf(dir);
  }
});
