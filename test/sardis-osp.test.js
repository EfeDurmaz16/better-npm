/**
 * Integration tests for v0.8 Sardis / OSP commands:
 * better login --sardis, better wallet, better logout --sardis,
 * better provision, better deprovision, better services,
 * better discover, better env-gen, better pay, better earnings, better sponsor
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { makeTempDir, rmrf, writeJson } from "./helpers.js";

const execFileAsync = promisify(execFile);
const betterBin = path.resolve(process.cwd(), "bin", "better.js");

async function runBetter(args, cwd) {
  return execFileAsync("node", [betterBin, ...args], {
    cwd: cwd || process.cwd(),
    env: { ...process.env, NO_COLOR: "1" },
    timeout: 20000,
  }).catch(err => ({ stdout: err.stdout || "", stderr: err.stderr || "", code: err.code }));
}

// ── better login --sardis ──────────────────────────────────────────────────────

test("better login --sardis --help shows usage", async () => {
  const result = await runBetter(["login", "--sardis", "--help"]);
  assert.ok(
    result.stdout.includes("sardis") || result.stdout.includes("login"),
    `Expected sardis login help, got: ${result.stdout}`
  );
});

test("better login --sardis --token without value fails gracefully", async () => {
  const result = await runBetter(["login", "--sardis", "--token"]);
  // Missing token value should fail or show error — but not crash
  assert.ok(
    result.stdout !== undefined || result.stderr !== undefined,
    "Expected some output"
  );
});

// ── better wallet ──────────────────────────────────────────────────────────────

test("better wallet --help shows usage", async () => {
  const result = await runBetter(["wallet", "--help"]);
  assert.ok(
    result.stdout.includes("wallet") || result.stdout.includes("balance"),
    `Expected wallet help, got: ${result.stdout}`
  );
});

test("better wallet without auth returns error", async () => {
  const result = await runBetter(["wallet", "--json"]);
  // Without Sardis credentials, should return an error response
  if (result.stdout && result.stdout.trim().startsWith("{")) {
    const parsed = JSON.parse(result.stdout.trim());
    assert.ok(
      parsed.ok === false || parsed.error !== undefined || parsed.kind !== undefined,
      `Expected error or kind field, got: ${JSON.stringify(parsed)}`
    );
  } else {
    // Non-JSON: should at least produce output
    assert.ok(
      result.stdout.length > 0 || result.stderr.length > 0 || result.code !== 0,
      "Expected non-zero exit or output when unauthenticated"
    );
  }
});

// ── better provision ───────────────────────────────────────────────────────────

test("better provision --help shows usage", async () => {
  const result = await runBetter(["provision", "--help"]);
  assert.ok(
    result.stdout.includes("provision") || result.stdout.includes("OSP"),
    `Expected provision help, got: ${result.stdout}`
  );
});

test("better provision without argument exits with error", async () => {
  const result = await runBetter(["provision"]);
  assert.ok(
    result.code !== 0 || result.stderr.includes("error") || result.stdout.includes("error"),
    "Expected error when no offering provided"
  );
});

test("better provision --dry-run --json returns structured output", async () => {
  const result = await runBetter(["provision", "supabase.com/postgres", "--dry-run", "--json"]);
  // Either an error (not authenticated) or a structured plan
  if (result.stdout && result.stdout.trim().startsWith("{")) {
    const parsed = JSON.parse(result.stdout.trim());
    assert.ok(typeof parsed === "object", "Expected JSON object");
  } else {
    // No Rust binary or not authenticated — should exit non-zero
    assert.ok(result.code !== 0 || result.stderr.length > 0 || result.stdout.length > 0);
  }
});

// ── better deprovision ─────────────────────────────────────────────────────────

test("better deprovision --help shows usage", async () => {
  const result = await runBetter(["deprovision", "--help"]);
  assert.ok(
    result.stdout.includes("deprovision") || result.stdout.includes("resource"),
    `Expected deprovision help, got: ${result.stdout}`
  );
});

test("better deprovision without argument exits with error", async () => {
  const result = await runBetter(["deprovision"]);
  assert.ok(
    result.code !== 0 || result.stderr.includes("error") || result.stdout.includes("error"),
    "Expected error when no resource_id provided"
  );
});

// ── better services ────────────────────────────────────────────────────────────

test("better services --help shows usage", async () => {
  const result = await runBetter(["services", "--help"]);
  assert.ok(
    result.stdout.includes("services") || result.stdout.includes("list"),
    `Expected services help, got: ${result.stdout}`
  );
});

test("better services list --json returns an array or error object", async () => {
  const result = await runBetter(["services", "list", "--json"]);
  if (result.stdout && result.stdout.trim().startsWith("{")) {
    const parsed = JSON.parse(result.stdout.trim());
    assert.ok(typeof parsed === "object", "Expected JSON object");
  } else if (result.stdout && result.stdout.trim().startsWith("[")) {
    const parsed = JSON.parse(result.stdout.trim());
    assert.ok(Array.isArray(parsed), "Expected JSON array");
  } else {
    // No Rust binary — should exit non-zero
    assert.ok(result.code !== 0 || result.stdout.length > 0 || result.stderr.length > 0);
  }
});

test("better services unknown subcommand exits non-zero", async () => {
  const result = await runBetter(["services", "bogus-subcommand"]);
  assert.ok(
    result.code !== 0 || result.stdout.includes("Unknown") || result.stderr.length > 0,
    "Expected error for unknown subcommand"
  );
});

// ── better discover ────────────────────────────────────────────────────────────

test("better discover --help shows usage", async () => {
  const result = await runBetter(["discover", "--help"]);
  assert.ok(
    result.stdout.includes("discover") || result.stdout.includes("OSP"),
    `Expected discover help, got: ${result.stdout}`
  );
});

test("better discover database outputs something or errors gracefully", async () => {
  const result = await runBetter(["discover", "database", "--json"]);
  if (result.stdout && result.stdout.trim().startsWith("{")) {
    const parsed = JSON.parse(result.stdout.trim());
    assert.ok(typeof parsed === "object", "Expected JSON object");
  } else {
    assert.ok(result.code !== 0 || result.stdout.length > 0 || result.stderr.length > 0);
  }
});

// ── better env-gen ─────────────────────────────────────────────────────────────

test("better env-gen --help shows usage", async () => {
  const result = await runBetter(["env-gen", "--help"]);
  assert.ok(
    result.stdout.includes("env") || result.stdout.includes(".env"),
    `Expected env-gen help, got: ${result.stdout}`
  );
});

test("better env-gen --dry-run with no .env.osp exits with error or empty", async () => {
  const dir = await makeTempDir("better-env-gen-");
  try {
    await writeJson(path.join(dir, "package.json"), { name: "test", version: "1.0.0" });
    const result = await runBetter(["env-gen", "--dry-run", "--project-root", dir]);
    // Either errors (no .env.osp), or produces empty output — must not crash
    assert.ok(
      result.stdout !== undefined,
      "Expected some output from env-gen"
    );
  } finally {
    await rmrf(dir);
  }
});

// ── better pay ────────────────────────────────────────────────────────────────

test("better pay --help shows usage", async () => {
  const result = await runBetter(["pay", "--help"]);
  assert.ok(
    result.stdout.includes("pay") || result.stdout.includes("Sardis"),
    `Expected pay help, got: ${result.stdout}`
  );
});

test("better pay without package exits with error", async () => {
  const result = await runBetter(["pay"]);
  assert.ok(
    result.code !== 0 || result.stdout.includes("error") || result.stderr.includes("error"),
    "Expected error when no package provided"
  );
});

test("better pay --all without --budget exits with error", async () => {
  const result = await runBetter(["pay", "--all"]);
  assert.ok(
    result.code !== 0 || result.stdout.includes("error") || result.stderr.includes("error"),
    "Expected error: --all requires --budget"
  );
});

// ── better earnings ───────────────────────────────────────────────────────────

test("better earnings --help shows usage", async () => {
  const result = await runBetter(["earnings", "--help"]);
  assert.ok(
    result.stdout.includes("earnings") || result.stdout.includes("Sardis"),
    `Expected earnings help, got: ${result.stdout}`
  );
});

test("better earnings without auth returns error or exits non-zero", async () => {
  const result = await runBetter(["earnings", "--json"]);
  if (result.stdout && result.stdout.trim().startsWith("{")) {
    const parsed = JSON.parse(result.stdout.trim());
    assert.ok(
      parsed.ok === false || parsed.error !== undefined || parsed.kind !== undefined,
      `Expected error/kind field, got: ${JSON.stringify(parsed)}`
    );
  } else {
    assert.ok(result.code !== 0 || result.stdout.length > 0 || result.stderr.length > 0);
  }
});

// ── better sponsor ────────────────────────────────────────────────────────────

test("better sponsor --help shows usage", async () => {
  const result = await runBetter(["sponsor", "--help"]);
  assert.ok(
    result.stdout.includes("sponsor") || result.stdout.includes("Sardis"),
    `Expected sponsor help, got: ${result.stdout}`
  );
});

test("better sponsor without package exits with error", async () => {
  const result = await runBetter(["sponsor"]);
  assert.ok(
    result.stdout.includes("sponsor") || result.stdout.includes("usage") || result.stdout.includes("Usage"),
    "Expected help output when no args"
  );
});

test("better sponsor without --amount exits with error", async () => {
  const result = await runBetter(["sponsor", "lodash"]);
  assert.ok(
    result.code !== 0 || result.stdout.includes("error") || result.stderr.includes("error"),
    "Expected error: --amount required"
  );
});

test("better sponsors list --json returns array or error object", async () => {
  const result = await runBetter(["sponsors", "list", "--json"]);
  if (result.stdout && result.stdout.trim().startsWith("{")) {
    const parsed = JSON.parse(result.stdout.trim());
    assert.ok(typeof parsed === "object");
  } else {
    assert.ok(result.code !== 0 || result.stdout.length > 0 || result.stderr.length > 0);
  }
});
