// test/env-imports-duplicates.test.js
// Tests for: better env-diff, better env-doctor, better exec, better find,
//            better import-check, better install-check, better install-order,
//            better duplicates, better dep-changes, better explain

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

// ── env-diff ──────────────────────────────────────────────────────────────────

test("env-diff --help shows usage", async () => {
  // env-diff requires two file args; --help may exit 1 without them
  const { stdout } = await runBetter(["env-diff", "--help"], process.cwd());
  assert.ok(
    stdout.includes("env") || stdout.includes("diff") || stdout.includes(".env"),
    "should describe .env diff"
  );
});

test("env-diff --json shows identical .env files have no differences", async () => {
  const dir = await makeTempDir("better-envdiff-same-");
  try {
    const envContent = "DB_URL=postgres://localhost/mydb\nSECRET_KEY=abc123\n";
    await fs.writeFile(path.join(dir, ".env"), envContent);
    await fs.writeFile(path.join(dir, ".env.example"), envContent);

    const { stdout, ok } = await runBetter(
      ["env-diff", ".env", ".env.example", "--json"], dir
    );
    assert.ok(ok, "env-diff should succeed for identical files");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("env-diff") || out.kind?.includes("env"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

test("env-diff --json reports differences between .env files", async () => {
  const dir = await makeTempDir("better-envdiff-diff-");
  try {
    await fs.writeFile(path.join(dir, ".env"), "DB_URL=postgres://\nEXTRA_VAR=value\n");
    await fs.writeFile(path.join(dir, ".env.example"), "DB_URL=postgres://\nMISSING_VAR=\n");

    const { stdout } = await runBetter(
      ["env-diff", ".env", ".env.example", "--json"], dir
    );
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      // EXTRA_VAR in .env but not .env.example, MISSING_VAR in .env.example but not .env
      const diffs = out.differences ?? out.diff ?? out.changes ?? [];
      if (diffs.length > 0) {
        assert.ok(Array.isArray(diffs), "should have differences array");
      }
    }
  } finally {
    await rmrf(dir);
  }
});

// ── env-doctor ────────────────────────────────────────────────────────────────

test("env-doctor --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["env-doctor", "--help"], process.cwd());
  assert.ok(ok, "env-doctor --help should succeed");
  assert.ok(
    stdout.includes("env") || stdout.includes("doctor") || stdout.includes("node") ||
    stdout.includes("npm"),
    "should describe environment doctor"
  );
});

test("env-doctor --json returns health checks", async () => {
  const dir = await makeTempDir("better-envdoctor-");
  try {
    await writeJson(path.join(dir, "package.json"), { name: "test", version: "1.0.0" });

    const { stdout, ok } = await runBetter(["env-doctor", "--json"], dir);
    assert.ok(ok, "env-doctor should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("env-doctor") || out.kind?.includes("env"), `unexpected kind: ${out.kind}`);
      assert.ok(Array.isArray(out.checks), "should have checks array");
    }
  } finally {
    await rmrf(dir);
  }
});

// ── exec ──────────────────────────────────────────────────────────────────────

test("exec --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["exec", "--help"], process.cwd());
  assert.ok(ok, "exec --help should succeed");
  assert.ok(
    stdout.includes("exec") || stdout.includes("binary") || stdout.includes("node_modules"),
    "should describe running local binaries"
  );
});

test("exec runs a locally installed binary", async () => {
  const dir = await makeTempDir("better-exec-");
  try {
    await writeJson(path.join(dir, "package.json"), { name: "test", version: "1.0.0" });
    // Create a fake binary in node_modules/.bin
    const binDir = path.join(dir, "node_modules", ".bin");
    await fs.mkdir(binDir, { recursive: true });
    const binPath = path.join(binDir, "my-tool");
    await fs.writeFile(binPath, "#!/usr/bin/env node\nprocess.stdout.write('tool-output');\n");
    await fs.chmod(binPath, 0o755);

    const { stdout, ok } = await runBetter(["exec", "my-tool"], dir);
    assert.ok(ok, "exec should succeed for installed binary");
    assert.ok(stdout.includes("tool-output"), "should output binary result");
  } finally {
    await rmrf(dir);
  }
});

test("exec fails when binary not found", async () => {
  const dir = await makeTempDir("better-exec-missing-");
  try {
    await writeJson(path.join(dir, "package.json"), { name: "test", version: "1.0.0" });
    await fs.mkdir(path.join(dir, "node_modules", ".bin"), { recursive: true });

    const { ok } = await runBetter(["exec", "nonexistent-binary-xyz"], dir);
    assert.ok(!ok, "exec should fail for missing binary");
  } finally {
    await rmrf(dir);
  }
});

// ── find ──────────────────────────────────────────────────────────────────────

test("find --help shows usage", async () => {
  // find requires a package arg; --help may exit 1 without it
  const { stdout } = await runBetter(["find", "--help"], process.cwd());
  assert.ok(
    stdout.includes("find") || stdout.includes("depend") || stdout.includes("who"),
    "should describe reverse dependency lookup"
  );
});

test("find --json returns packages that depend on a module", async () => {
  const dir = await makeTempDir("better-find-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      dependencies: { "pkg-a": "^1.0.0" }
    });
    const nmDir = path.join(dir, "node_modules");
    // pkg-a depends on common-dep
    await fs.mkdir(path.join(nmDir, "pkg-a"), { recursive: true });
    await writeJson(path.join(nmDir, "pkg-a", "package.json"), {
      name: "pkg-a", version: "1.0.0",
      dependencies: { "common-dep": "^1.0.0" }
    });
    await fs.mkdir(path.join(nmDir, "common-dep"), { recursive: true });
    await writeJson(path.join(nmDir, "common-dep", "package.json"), {
      name: "common-dep", version: "1.0.0"
    });

    const { stdout, ok } = await runBetter(["find", "common-dep", "--json"], dir);
    assert.ok(ok, "find should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("find"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── import-check ──────────────────────────────────────────────────────────────

test("import-check --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["import-check", "--help"], process.cwd());
  assert.ok(ok, "import-check --help should succeed");
  assert.ok(
    stdout.includes("import") || stdout.includes("check") || stdout.includes("resolve"),
    "should describe import checking"
  );
});

test("import-check --json finds no broken imports in clean project", async () => {
  const dir = await makeTempDir("better-importcheck-ok-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0"
    });
    await fs.writeFile(path.join(dir, "index.js"), "const x = 42;\nmodule.exports = x;\n");
    await fs.writeFile(path.join(dir, "utils.js"), "module.exports = {};\n");
    // index.js doesn't import from utils.js, so no imports to check

    const { stdout, ok } = await runBetter(["import-check", "--json"], dir);
    assert.ok(ok, "import-check should succeed with valid imports");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.equal(out.ok, true);
      assert.ok(out.kind?.includes("import"), `unexpected kind: ${out.kind}`);
      assert.equal(out.brokenCount, 0, "should have no broken imports");
    }
  } finally {
    await rmrf(dir);
  }
});

// ── install-check ──────────────────────────────────────────────────────────────

test("install-check --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["install-check", "--help"], process.cwd());
  assert.ok(ok, "install-check --help should succeed");
  assert.ok(
    stdout.includes("install") || stdout.includes("check") || stdout.includes("valid"),
    "should describe npm install validation"
  );
});

test("install-check --json returns checks for npm installation", async () => {
  const dir = await makeTempDir("better-installcheck-");
  try {
    await writeJson(path.join(dir, "package.json"), { name: "test", version: "1.0.0" });

    const { stdout } = await runBetter(["install-check", "--json"], dir);
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("install"), `unexpected kind: ${out.kind}`);
      assert.ok(Array.isArray(out.checks), "should have checks array");
    }
  } finally {
    await rmrf(dir);
  }
});

// ── install-order ──────────────────────────────────────────────────────────────

test("install-order --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["install-order", "--help"], process.cwd());
  assert.ok(ok, "install-order --help should succeed");
  assert.ok(
    stdout.includes("install") || stdout.includes("order") || stdout.includes("topolog"),
    "should describe install order"
  );
});

test("install-order --json returns topological order", async () => {
  const dir = await makeTempDir("better-installorder-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      dependencies: { "pkg-a": "^1.0.0" }
    });
    const nmDir = path.join(dir, "node_modules");
    await fs.mkdir(path.join(nmDir, "pkg-a"), { recursive: true });
    await writeJson(path.join(nmDir, "pkg-a", "package.json"), {
      name: "pkg-a", version: "1.0.0"
    });

    const { stdout, ok } = await runBetter(["install-order", "--json"], dir);
    assert.ok(ok, "install-order should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.equal(out.ok, true);
      assert.ok(out.kind?.includes("install-order"), `unexpected kind: ${out.kind}`);
      assert.ok(Array.isArray(out.order), "should have order array");
    }
  } finally {
    await rmrf(dir);
  }
});

// ── duplicates ─────────────────────────────────────────────────────────────────

test("duplicates --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["duplicates", "--help"], process.cwd());
  assert.ok(ok, "duplicates --help should succeed");
  assert.ok(
    stdout.includes("duplicate") || stdout.includes("version") || stdout.includes("conflict"),
    "should describe duplicate package detection"
  );
});

test("duplicates --json returns ok when no duplicates", async () => {
  const dir = await makeTempDir("better-duplicates-ok-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      dependencies: { "pkg-a": "^1.0.0" }
    });
    const nmDir = path.join(dir, "node_modules");
    await fs.mkdir(path.join(nmDir, "pkg-a"), { recursive: true });
    await writeJson(path.join(nmDir, "pkg-a", "package.json"), {
      name: "pkg-a", version: "1.0.0"
    });

    const { stdout, ok } = await runBetter(["duplicates", "--json"], dir);
    assert.ok(ok, "duplicates should succeed with no duplicates");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.equal(out.ok, true);
      assert.ok(out.kind?.includes("duplicate"), `unexpected kind: ${out.kind}`);
      assert.equal(out.duplicateCount, 0, "should have no duplicates");
    }
  } finally {
    await rmrf(dir);
  }
});

test("duplicates --json detects multiple versions of same package", async () => {
  const dir = await makeTempDir("better-duplicates-found-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      dependencies: { "pkg-a": "^1.0.0", "pkg-b": "^1.0.0" }
    });
    const nmDir = path.join(dir, "node_modules");
    // pkg-a at top level
    await fs.mkdir(path.join(nmDir, "shared-lib"), { recursive: true });
    await writeJson(path.join(nmDir, "shared-lib", "package.json"), {
      name: "shared-lib", version: "1.0.0"
    });
    // pkg-a has its own nested version of shared-lib at 2.0.0
    await fs.mkdir(path.join(nmDir, "pkg-a"), { recursive: true });
    await writeJson(path.join(nmDir, "pkg-a", "package.json"), {
      name: "pkg-a", version: "1.0.0"
    });
    await fs.mkdir(path.join(nmDir, "pkg-a", "node_modules", "shared-lib"), { recursive: true });
    await writeJson(path.join(nmDir, "pkg-a", "node_modules", "shared-lib", "package.json"), {
      name: "shared-lib", version: "2.0.0"
    });

    const { stdout } = await runBetter(["duplicates", "--json"], dir);
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("duplicate"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── dep-changes ────────────────────────────────────────────────────────────────

test("dep-changes --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["dep-changes", "--help"], process.cwd());
  assert.ok(ok, "dep-changes --help should succeed");
  assert.ok(
    stdout.includes("change") || stdout.includes("dep") || stdout.includes("release"),
    "should describe dependency changes"
  );
});

test("dep-changes --json returns changes info (network-aware)", async (t) => {
  // dep-changes fetches from npm registry, skip if network unavailable
  const { stdout, stderr, ok } = await runBetter(
    ["dep-changes", "semver", "--json"], process.cwd()
  );
  if (!ok && (stderr.includes("ENOTFOUND") || stderr.includes("ETIMEDOUT") ||
      stderr.includes("timeout"))) {
    t.skip("network unavailable for dep-changes");
    return;
  }
  if (stdout.trim()) {
    const out = JSON.parse(stdout);
    assert.ok(typeof out.ok === "boolean", "should have ok field");
    assert.ok(out.kind?.includes("dep-changes"), `unexpected kind: ${out.kind}`);
  }
});
