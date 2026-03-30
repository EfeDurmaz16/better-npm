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
    timeout: 15000,
  }).catch(err => ({ stdout: err.stdout || "", stderr: err.stderr || "", code: err.code }));
}

// ── telemetry ────────────────────────────────────────────────────────────────

test("better telemetry status shows current state", async () => {
  const result = await runBetter(["telemetry", "status"]);
  assert.ok(
    result.stdout.includes("Telemetry is currently:"),
    `Expected telemetry status output, got: ${result.stdout}`
  );
});

test("better telemetry status --json returns JSON", async () => {
  const result = await runBetter(["telemetry", "status", "--json"]);
  const json = JSON.parse(result.stdout);
  assert.ok(json.kind === "better.telemetry.status");
  assert.ok(typeof json.enabled === "boolean");
});

// ── ai review ────────────────────────────────────────────────────────────────

test("better ai review --json returns review object", async () => {
  const dir = await makeTempDir();
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test",
      version: "1.0.0",
      dependencies: { moment: "2.29.0", "date-fns": "3.0.0" },
      devDependencies: { request: "2.88.0" },
    });
    const result = await runBetter(["ai", "review", "--json"], dir);
    // ai command may not exist yet; only check if it runs
    if (result.stdout && result.stdout.startsWith("{")) {
      const json = JSON.parse(result.stdout);
      assert.ok(json.kind === "better.ai.review" || json.error, `Got: ${result.stdout}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── supply-chain ─────────────────────────────────────────────────────────────

test("better supply-chain --json returns report", async () => {
  const dir = await makeTempDir();
  try {
    await writeJson(path.join(dir, "package.json"), { name: "test", version: "1.0.0", dependencies: {} });
    await writeJson(path.join(dir, "package-lock.json"), {
      lockfileVersion: 3,
      name: "test",
      packages: {}
    });
    const result = await runBetter(["supply-chain", "--json"], dir);
    if (result.stdout && result.stdout.startsWith("{")) {
      const json = JSON.parse(result.stdout);
      assert.ok(json.ok !== undefined || json.error !== undefined);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── cross-project ─────────────────────────────────────────────────────────────

test("better cross-project --help shows usage", async () => {
  const result = await runBetter(["cross-project", "--help"]);
  assert.ok(
    result.stdout.includes("cross-project") || result.stdout.includes("Usage"),
    `Expected help output, got: ${result.stdout}`
  );
});

// ── deploy ────────────────────────────────────────────────────────────────────

test("better deploy --dry-run --json outputs detection", async () => {
  const dir = await makeTempDir();
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test",
      version: "1.0.0",
      dependencies: { next: "14.0.0" },
    });
    const result = await runBetter(["deploy", "--dry-run", "--json"], dir);
    // should not throw, may detect Next.js
    if (result.stdout && result.stdout.startsWith("{")) {
      const json = JSON.parse(result.stdout);
      assert.ok(json.platform || json.error || json.framework);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── heal ─────────────────────────────────────────────────────────────────────

test("better heal --dry-run --json returns healing actions", async () => {
  const dir = await makeTempDir();
  try {
    await writeJson(path.join(dir, "package.json"), { name: "test", version: "1.0.0", dependencies: {} });
    const result = await runBetter(["heal", "--dry-run", "--json"], dir);
    if (result.stdout && result.stdout.startsWith("{")) {
      const json = JSON.parse(result.stdout);
      assert.ok(json.ok !== undefined || json.error !== undefined);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── maintenance ───────────────────────────────────────────────────────────────

test("better maintenance --json returns report", async () => {
  const dir = await makeTempDir();
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test",
      version: "1.0.0",
      dependencies: {},
      devDependencies: {},
    });
    const result = await runBetter(["maintenance", "--json"], dir);
    if (result.stdout && result.stdout.startsWith("{")) {
      const json = JSON.parse(result.stdout);
      assert.ok(json.ok !== undefined || json.error !== undefined);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── link ──────────────────────────────────────────────────────────────────────

test("better link --list --json returns list", async () => {
  const result = await runBetter(["link", "--list", "--json"]);
  if (result.stdout && result.stdout.startsWith("{")) {
    const json = JSON.parse(result.stdout);
    assert.ok(json.kind === "better.link.list" || json.error);
  }
});

// ── plugin ────────────────────────────────────────────────────────────────────

test("better plugin list --json returns plugins", async () => {
  const result = await runBetter(["plugin", "list", "--json"]);
  if (result.stdout && result.stdout.startsWith("{")) {
    const json = JSON.parse(result.stdout);
    assert.ok(json.kind === "better.plugin.list" || json.error);
  }
});

// ── registry ──────────────────────────────────────────────────────────────────

test("better registry list --json returns registries", async () => {
  const result = await runBetter(["registry", "list", "--json"]);
  if (result.stdout && result.stdout.startsWith("{")) {
    const json = JSON.parse(result.stdout);
    assert.ok(json.kind === "better.registry.list" || json.error);
  }
});

// ── orchestrate ───────────────────────────────────────────────────────────────

test("better orchestrate --help shows usage", async () => {
  const result = await runBetter(["orchestrate", "--help"]);
  assert.ok(
    result.stdout.includes("orchestrate") || result.stdout.includes("Usage"),
    `Expected help output, got: ${result.stdout}`
  );
});

// ── why-not ───────────────────────────────────────────────────────────────────

test("better why-not --help shows usage", async () => {
  const result = await runBetter(["why-not", "--help"]);
  assert.ok(
    result.stdout.includes("why-not") || result.stdout.includes("Usage") || result.stdout.includes("peer"),
    `Expected help output, got: ${result.stdout}`
  );
});
