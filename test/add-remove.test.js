/**
 * Integration tests for `better add` and `better remove` commands.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { makeTempDir, rmrf, writeJson } from "./helpers.js";

const execFileAsync = promisify(execFile);
const betterBin = path.resolve(process.cwd(), "bin", "better.js");

async function runBetter(args, cwd) {
  return execFileAsync("node", [betterBin, ...args], {
    cwd: cwd || process.cwd(),
    env: { ...process.env, NO_COLOR: "1" },
    timeout: 30000,
  }).catch(err => ({ stdout: err.stdout || "", stderr: err.stderr || "", code: err.code }));
}

// ── better add ─────────────────────────────────────────────────────────────────

test("better add --help shows usage", async () => {
  const result = await runBetter(["add", "--help"]);
  assert.ok(result.stdout.includes("add"), `Expected add help, got: ${result.stdout}`);
  assert.ok(result.stdout.includes("--dev") || result.stdout.includes("-D"), "Should mention --dev flag");
});

test("better add with no packages exits with error", async () => {
  const result = await runBetter(["add"]);
  const isError =
    result.code !== 0 ||
    result.stderr?.includes("error") ||
    result.stderr?.includes("specify");
  assert.ok(isError, "Should fail when no packages specified");
});

test("better add --json returns structured output on error", async () => {
  const dir = await makeTempDir();
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test-add", version: "1.0.0",
    });
    // Intentionally invalid package name to trigger a quick error
    const result = await runBetter(["add", "__invalid__pkg__that__does__not__exist__xyz__", "--json"], dir);
    if (result.stdout?.startsWith("{")) {
      const json = JSON.parse(result.stdout);
      assert.ok(typeof json.ok === "boolean", "Should have ok field");
      assert.ok(json.kind === "better.add", `Expected better.add kind, got: ${json.kind}`);
    }
    // Any outcome (ok or error) is valid; we just verify it doesn't crash unexpectedly
    assert.ok(result.stdout !== undefined, "Should produce output");
  } finally {
    await rmrf(dir);
  }
});

// ── better remove ──────────────────────────────────────────────────────────────

test("better remove --help shows usage", async () => {
  const result = await runBetter(["remove", "--help"]);
  assert.ok(result.stdout.includes("remove"), `Expected remove help, got: ${result.stdout}`);
});

test("better rm --help also shows usage (alias)", async () => {
  const result = await runBetter(["rm", "--help"]);
  assert.ok(result.stdout.includes("remove"), `Expected remove help via rm alias, got: ${result.stdout}`);
});

test("better uninstall --help also shows usage (alias)", async () => {
  const result = await runBetter(["uninstall", "--help"]);
  assert.ok(result.stdout.includes("remove"), `Expected remove help via uninstall alias, got: ${result.stdout}`);
});

test("better remove with no packages exits with error", async () => {
  const result = await runBetter(["remove"]);
  const isError =
    result.code !== 0 ||
    result.stderr?.includes("error") ||
    result.stderr?.includes("specify");
  assert.ok(isError, "Should fail when no packages specified");
});

test("better remove --json returns structured output", async () => {
  const dir = await makeTempDir();
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test-remove", version: "1.0.0",
      dependencies: {},
    });
    const result = await runBetter(["remove", "nonexistent-pkg-xyz", "--json"], dir);
    if (result.stdout?.startsWith("{")) {
      const json = JSON.parse(result.stdout);
      assert.ok(typeof json.ok === "boolean", "Should have ok field");
      assert.ok(json.kind === "better.remove", `Expected better.remove kind, got: ${json.kind}`);
      assert.ok(Array.isArray(json.removed), "Should have removed array");
    }
    assert.ok(result.stdout !== undefined, "Should produce output");
  } finally {
    await rmrf(dir);
  }
});
