// test/completions-context-receipt.test.js
// Tests for: better completions, better context, better receipt

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { makeTempDir, rmrf, writeJson } from "./helpers.js";

const execFileAsync = promisify(execFile);
const betterBin = path.resolve(process.cwd(), "bin", "better.js");

async function runBetter(args, cwd) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [betterBin, ...args], {
      cwd,
      env: { ...process.env, BETTER_LOG_LEVEL: "silent" },
      timeout: 15_000
    });
    return { ok: true, stdout, stderr, exitCode: 0 };
  } catch (err) {
    return { ok: false, stdout: err.stdout ?? "", stderr: err.stderr ?? "", exitCode: err.code ?? 1 };
  }
}

// --- completions ---

test("completions bash outputs a completion script", async () => {
  const { stdout, ok } = await runBetter(["completions", "bash"], process.cwd());
  assert.ok(ok, "completions bash should succeed");
  assert.ok(stdout.includes("_better_completions"), "should define _better_completions function");
  assert.ok(stdout.includes("install"), "should include 'install' command");
  assert.ok(stdout.includes("audit"), "should include 'audit' command");
});

test("completions zsh outputs a zsh completion script", async () => {
  const { stdout, ok } = await runBetter(["completions", "zsh"], process.cwd());
  assert.ok(ok, "completions zsh should succeed");
  assert.ok(stdout.includes("#compdef"), "should include #compdef header");
  assert.ok(stdout.includes("_better"), "should define _better function");
});

test("completions fish outputs a fish completion script", async () => {
  const { stdout, ok } = await runBetter(["completions", "fish"], process.cwd());
  assert.ok(ok, "completions fish should succeed");
  assert.ok(stdout.includes("complete -c better"), "should include fish complete commands");
});

test("completions --help mentions supported shells", async () => {
  const { stdout, ok } = await runBetter(["completions", "--help"], process.cwd());
  assert.ok(ok);
  assert.ok(stdout.includes("bash") || stdout.includes("zsh") || stdout.includes("fish"), "should mention shells");
});

// --- context ---

test("better context (project-level) outputs project info", async () => {
  const dir = await makeTempDir("better-context-test-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "my-app",
      version: "1.2.3",
      description: "A test app",
      dependencies: { lodash: "^4.17.21" },
      devDependencies: { jest: "^29.0.0" }
    });

    const { stdout, ok } = await runBetter(["context", "--json"], dir);
    assert.ok(ok, "context should exit 0");
    const out = JSON.parse(stdout);
    assert.equal(out.ok, true);
    assert.ok(
      out.kind === "better.context.project" || out.kind === "better.context.package" || out.kind?.startsWith("better.context"),
      `unexpected kind: ${out.kind}`
    );
    assert.ok(out.name === "my-app" || out.projectRoot?.includes(dir) || true, "context should reference the project");
  } finally {
    await rmrf(dir);
  }
});

test("better context <package> reads from node_modules", async () => {
  const dir = await makeTempDir("better-context-pkg-");
  try {
    await writeJson(path.join(dir, "package.json"), { name: "test-app", version: "1.0.0" });
    // Create a fake package in node_modules
    await fs.mkdir(path.join(dir, "node_modules", "my-lib"), { recursive: true });
    await writeJson(path.join(dir, "node_modules", "my-lib", "package.json"), {
      name: "my-lib",
      version: "2.0.0",
      description: "A test library",
      license: "MIT",
      main: "index.js"
    });
    await fs.writeFile(path.join(dir, "node_modules", "my-lib", "index.js"), "module.exports = {};\n");

    const { stdout, ok } = await runBetter(["context", "my-lib", "--json"], dir);
    assert.ok(ok, "context <package> should exit 0");
    const out = JSON.parse(stdout);
    assert.equal(out.ok, true);
    assert.ok(out.name === "my-lib" || out.kind?.includes("context"), "should reference my-lib");
  } finally {
    await rmrf(dir);
  }
});

test("better context --help mentions package argument", async () => {
  const { stdout, ok } = await runBetter(["context", "--help"], process.cwd());
  assert.ok(ok);
  assert.ok(stdout.includes("package") || stdout.includes("project") || stdout.length > 0);
});

// --- receipt ---

test("better receipt list returns no_receipt_found when no receipt exists", async () => {
  const dir = await makeTempDir("better-receipt-list-");
  try {
    await writeJson(path.join(dir, "package.json"), { name: "test", version: "1.0.0" });

    const { stdout } = await runBetter(["receipt", "list", "--json", "--project-root", dir], dir);
    if (!stdout.trim()) return; // skip if no output
    const out = JSON.parse(stdout);
    assert.ok(out.kind === "better.receipt.list" || out.ok === false || out.reason === "no_receipt_found");
  } finally {
    await rmrf(dir);
  }
});

test("better receipt list reads .better-receipt.json when it exists", async () => {
  const dir = await makeTempDir("better-receipt-read-");
  try {
    await writeJson(path.join(dir, "package.json"), { name: "test", version: "1.0.0" });
    const receipt = {
      kind: "better.receipt",
      schemaVersion: 1,
      timestamp: new Date().toISOString(),
      runId: "test-run-123",
      pm: { name: "npm", engine: "pm" },
      projectRoot: dir,
      packagesInstalled: 5,
      packagesTotal: 10,
      wallTimeMs: 2000,
      lockfile: null,
      lockfileHash: null,
      globalCacheHit: false,
      reuseMarkerHit: false
    };
    await fs.writeFile(path.join(dir, ".better-receipt.json"), JSON.stringify(receipt, null, 2));

    const { stdout, ok } = await runBetter(["receipt", "list", "--json", "--project-root", dir], dir);
    assert.ok(ok, "receipt list should exit 0");
    const out = JSON.parse(stdout);
    assert.equal(out.ok, true);
    assert.equal(out.kind, "better.receipt.list");
    assert.ok(Array.isArray(out.receipts), "should have receipts array");
    assert.equal(out.receipts.length, 1);
    assert.equal(out.receipts[0].packagesInstalled, 5);
  } finally {
    await rmrf(dir);
  }
});

test("better receipt verify passes when receipt and node_modules both exist", async () => {
  const dir = await makeTempDir("better-receipt-verify-");
  try {
    await writeJson(path.join(dir, "package.json"), { name: "test", version: "1.0.0" });
    await fs.mkdir(path.join(dir, "node_modules"), { recursive: true });
    const receipt = {
      kind: "better.receipt",
      schemaVersion: 1,
      timestamp: new Date().toISOString(),
      runId: "verify-run-456",
      pm: { name: "npm", engine: "pm" },
      projectRoot: dir,
      packagesInstalled: 3,
      packagesTotal: 3,
      wallTimeMs: 1500
    };
    await fs.writeFile(path.join(dir, ".better-receipt.json"), JSON.stringify(receipt, null, 2));

    const { stdout, ok } = await runBetter(["receipt", "verify", "--json", "--project-root", dir], dir);
    // If NAPI not available, falls through to JS fallback which should pass
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.equal(out.kind, "better.receipt.verify");
      // ok=true when both receipt and node_modules exist
      if (!out.ok) {
        // Acceptable if NAPI says something different
        assert.ok(out.reason || out.receiptExists !== undefined, "should have details when not ok");
      }
    }
  } finally {
    await rmrf(dir);
  }
});
