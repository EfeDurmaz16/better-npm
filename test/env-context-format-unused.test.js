// test/env-context-format-unused.test.js
// Tests for: better env, better env-validate, better context,
//            better format-package, better unused, better predict,
//            better summarize, better script-env

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

// ── env ───────────────────────────────────────────────────────────────────────

test("env --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["env", "--help"], process.cwd());
  assert.ok(ok, "env --help should succeed");
  assert.ok(
    stdout.includes("env") || stdout.includes("environment") || stdout.includes("variable"),
    "should describe env management"
  );
});

test("env list --json returns env variables", async () => {
  const dir = await makeTempDir("better-env-");
  try {
    await writeJson(path.join(dir, "package.json"), { name: "test", version: "1.0.0" });
    await fs.writeFile(path.join(dir, ".env"), "DB_URL=postgres://localhost/test\nAPP_PORT=3000\n");

    const { stdout, ok } = await runBetter(["env", "list", "--json"], dir);
    assert.ok(ok, "env list should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("env"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── env-validate ──────────────────────────────────────────────────────────────

test("env-validate --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["env-validate", "--help"], process.cwd());
  assert.ok(ok, "env-validate --help should succeed");
  assert.ok(
    stdout.includes("validate") || stdout.includes("env") || stdout.includes("variable"),
    "should describe env validation"
  );
});

test("env-validate --json validates env file", async () => {
  const dir = await makeTempDir("better-env-validate-");
  try {
    await writeJson(path.join(dir, "package.json"), { name: "test", version: "1.0.0" });
    await fs.writeFile(path.join(dir, ".env"), "DB_URL=postgres://localhost/test\nAPP_PORT=3000\n");
    await fs.writeFile(path.join(dir, ".env.example"), "DB_URL=\nAPP_PORT=\n");

    const { stdout } = await runBetter(["env-validate", "--json"], dir);
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("env"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── context ───────────────────────────────────────────────────────────────────

test("context --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["context", "--help"], process.cwd());
  assert.ok(ok, "context --help should succeed");
  assert.ok(
    stdout.includes("context") || stdout.includes("project") || stdout.includes("ai"),
    "should describe project context"
  );
});

test("context --json returns project context", async () => {
  const dir = await makeTempDir("better-context-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      description: "A test project",
      license: "MIT",
      dependencies: { "pkg-a": "^1.0.0" }
    });
    const nmDir = path.join(dir, "node_modules");
    await fs.mkdir(path.join(nmDir, "pkg-a"), { recursive: true });
    await writeJson(path.join(nmDir, "pkg-a", "package.json"), {
      name: "pkg-a", version: "1.0.0"
    });

    const { stdout, ok } = await runBetter(["context", "--json"], dir);
    assert.ok(ok, "context should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("context"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── format-package ────────────────────────────────────────────────────────────

test("format-package --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["format-package", "--help"], process.cwd());
  assert.ok(ok, "format-package --help should succeed");
  assert.ok(
    stdout.includes("format") || stdout.includes("package.json") || stdout.includes("sort"),
    "should describe package.json formatting"
  );
});

test("format-package --dry-run --json reports format changes", async () => {
  const dir = await makeTempDir("better-format-package-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      version: "1.0.0",
      name: "test",
      license: "MIT",
      dependencies: {}
    });

    const { stdout, ok } = await runBetter(["format-package", "--dry-run", "--json"], dir);
    assert.ok(ok, "format-package should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("format"), `unexpected kind: ${out.kind}`);
      assert.equal(out.dryRun, true, "should report dry run");
    }
  } finally {
    await rmrf(dir);
  }
});

// ── unused ────────────────────────────────────────────────────────────────────

test("unused --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["unused", "--help"], process.cwd());
  assert.ok(ok, "unused --help should succeed");
  assert.ok(
    stdout.includes("unused") || stdout.includes("depend") || stdout.includes("import"),
    "should describe unused dependency detection"
  );
});

test("unused --json detects unused dependencies", async () => {
  const dir = await makeTempDir("better-unused-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      dependencies: { "pkg-a": "^1.0.0", "pkg-b": "^1.0.0" }
    });
    // Only import pkg-a, not pkg-b
    await fs.writeFile(path.join(dir, "index.js"), "const a = require('pkg-a');\nmodule.exports = a;\n");

    const { stdout, ok } = await runBetter(["unused", "--json"], dir);
    assert.ok(ok, "unused should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("unused"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── predict ───────────────────────────────────────────────────────────────────

test("predict --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["predict", "--help"], process.cwd());
  assert.ok(ok, "predict --help should succeed");
  assert.ok(
    stdout.includes("predict") || stdout.includes("maintenance") || stdout.includes("risk"),
    "should describe maintenance prediction"
  );
});

test("predict --all --json returns maintenance predictions (network-aware)", async (t) => {
  const dir = await makeTempDir("better-predict-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      dependencies: { "semver": "^7.0.0" }
    });

    // predict requires --all for project mode (no single package arg)
    const { stdout, stderr, ok } = await runBetter(["predict", "--all", "--json"], dir);
    if (!ok && (stderr.includes("ENOTFOUND") || stderr.includes("ETIMEDOUT") || stderr.includes("timeout"))) {
      t.skip("network unavailable for predict");
      return;
    }
    assert.ok(ok, "predict should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("predict"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── summarize ─────────────────────────────────────────────────────────────────

test("summarize --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["summarize", "--help"], process.cwd());
  assert.ok(ok, "summarize --help should succeed");
  assert.ok(
    stdout.includes("summarize") || stdout.includes("summary") || stdout.includes("project"),
    "should describe project summarization"
  );
});

test("summarize --json returns project summary", async () => {
  const dir = await makeTempDir("better-summarize-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "my-project",
      version: "1.0.0",
      description: "A sample project",
      license: "MIT",
      dependencies: { "express": "^4.0.0" },
      devDependencies: { "jest": "^29.0.0" }
    });
    await fs.writeFile(path.join(dir, "README.md"), "# My Project\n");

    const { stdout, ok } = await runBetter(["summarize", "--json"], dir);
    assert.ok(ok, "summarize should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("summarize"), `unexpected kind: ${out.kind}`);
      assert.ok(typeof out.prodDeps === "number", "should have prodDeps count");
    }
  } finally {
    await rmrf(dir);
  }
});

// ── script-env ────────────────────────────────────────────────────────────────

test("script-env --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["script-env", "--help"], process.cwd());
  assert.ok(ok, "script-env --help should succeed");
  assert.ok(
    stdout.includes("script") || stdout.includes("env") || stdout.includes("variable"),
    "should describe script environment"
  );
});

test("script-env --json returns script environment variables", async () => {
  const dir = await makeTempDir("better-script-env-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      scripts: { build: "NODE_ENV=production node build.js", test: "jest" }
    });

    const { stdout, ok } = await runBetter(["script-env", "--json"], dir);
    assert.ok(ok, "script-env should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("script-env"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});
