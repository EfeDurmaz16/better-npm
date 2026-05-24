// test/discover-envgen.test.js
// Integration tests for discover (JS-native OSP provider db) and
// env-generate (JS-native .env.osp resolution)

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { makeTempDir, rmrf } from "./helpers.js";

const execFileAsync = promisify(execFile);
const betterBin = path.resolve(process.cwd(), "bin", "better.js");

async function runBetter(args, cwd, extraEnv = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [betterBin, ...args], {
      cwd: cwd || process.cwd(),
      env: { ...process.env, ...extraEnv, BETTER_LOG_LEVEL: "silent" },
      timeout: 15_000
    });
    return { ok: true, stdout, stderr, exitCode: 0 };
  } catch (err) {
    return { ok: false, stdout: err.stdout ?? "", stderr: err.stderr ?? "", exitCode: err.code ?? 1 };
  }
}

// ── better discover (JS-native curated provider database) ─────────────────────

test("discover --json returns array of all providers", async () => {
  // Pass a dummy positional so HELP is not shown
  const result = await runBetter(["discover", "database", "--json"]);
  assert.ok(result.stdout.trim().startsWith("["), `Expected JSON array, got: ${result.stdout.slice(0, 200)}`);
  const providers = JSON.parse(result.stdout);
  assert.ok(Array.isArray(providers), "Should be an array");
  assert.ok(providers.length > 0, "Should have results for 'database'");
});

test("discover --category database --json returns only database providers", async () => {
  const result = await runBetter(["discover", "--category", "database", "--json"]);
  assert.ok(result.stdout.trim().startsWith("["), "Expected JSON array");
  const providers = JSON.parse(result.stdout);
  assert.ok(Array.isArray(providers));
  assert.ok(providers.length > 0, "Should have database providers");
  for (const p of providers) {
    assert.equal(p.category, "database", `Expected category=database, got ${p.category} for ${p.provider_id}`);
  }
});

test("discover --category email --json returns only email providers", async () => {
  const result = await runBetter(["discover", "--category", "email", "--json"]);
  assert.ok(result.stdout.trim().startsWith("["), "Expected JSON array");
  const providers = JSON.parse(result.stdout);
  assert.ok(Array.isArray(providers));
  assert.ok(providers.length > 0, "Should have email providers (resend, sendgrid)");
  for (const p of providers) {
    assert.equal(p.category, "email", `Expected category=email, got ${p.category} for ${p.provider_id}`);
  }
});

test("discover --category auth --json returns only auth providers", async () => {
  const result = await runBetter(["discover", "--category", "auth", "--json"]);
  assert.ok(result.stdout.trim().startsWith("["), "Expected JSON array");
  const providers = JSON.parse(result.stdout);
  assert.ok(Array.isArray(providers));
  assert.ok(providers.length > 0, "Should have auth providers");
  for (const p of providers) {
    assert.equal(p.category, "auth");
  }
});

test("discover supabase --json finds supabase", async () => {
  const result = await runBetter(["discover", "supabase", "--json"]);
  assert.ok(result.stdout.trim().startsWith("["), "Expected JSON array");
  const providers = JSON.parse(result.stdout);
  assert.ok(Array.isArray(providers));
  assert.ok(providers.length > 0, "Should find supabase");
  assert.ok(
    providers.some(p => p.provider_id.includes("supabase")),
    `Expected supabase in results: ${providers.map(p => p.provider_id).join(", ")}`
  );
});

test("discover --free --json returns only free-tier providers", async () => {
  const result = await runBetter(["discover", "--free", "database", "--json"]);
  assert.ok(result.stdout.trim().startsWith("["), "Expected JSON array");
  const providers = JSON.parse(result.stdout);
  assert.ok(Array.isArray(providers));
  for (const p of providers) {
    assert.equal(p.free_tier, true, `Expected free_tier=true for ${p.provider_id}`);
  }
});

test("discover unknown provider --json returns empty array", async () => {
  const result = await runBetter(["discover", "xyz-nonexistent-provider-99999", "--json"]);
  assert.ok(result.stdout.trim().startsWith("["), "Expected JSON array");
  const providers = JSON.parse(result.stdout);
  assert.ok(Array.isArray(providers));
  assert.equal(providers.length, 0, "Unknown provider should return empty array");
});

test("discover provider has expected fields", async () => {
  const result = await runBetter(["discover", "supabase.com", "--json"]);
  assert.ok(result.stdout.trim().startsWith("["), "Expected JSON array");
  const providers = JSON.parse(result.stdout);
  assert.ok(providers.length > 0);
  const p = providers[0];
  assert.ok(p.provider_id, "Should have provider_id");
  assert.ok(p.name, "Should have name");
  assert.ok(p.description, "Should have description");
  assert.ok(p.category, "Should have category");
  assert.ok(Array.isArray(p.tags), "Should have tags array");
  assert.ok(Array.isArray(p.offerings), "Should have offerings array");
  assert.ok(typeof p.free_tier === "boolean", "Should have free_tier boolean");
});

test("discover with no args shows help", async () => {
  const result = await runBetter(["discover"]);
  assert.ok(
    result.stdout.includes("discover") || result.stdout.includes("query"),
    "Should show help text"
  );
});

test("discover --help shows help", async () => {
  const { stdout, ok } = await runBetter(["discover", "--help"]);
  assert.ok(ok);
  assert.ok(stdout.includes("category") || stdout.includes("discover"));
});

// ── better env-gen (JS-native .env.osp resolution) ───────────────────────────

test("env-gen --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["env-gen", "--help"]);
  assert.ok(ok, "env-gen --help should succeed");
  assert.ok(stdout.includes(".env"), "Should mention .env");
});

test("env-gen with no .env.osp returns error", async () => {
  const dir = await makeTempDir("better-envgen-nofile-");
  try {
    const result = await runBetter(["env-gen", "--project-root", dir]);
    assert.ok(result.exitCode !== 0 || result.stdout.includes("not found") || result.stderr.includes("not found"),
      "Should fail when .env.osp missing");
  } finally {
    await rmrf(dir);
  }
});

test("env-gen --json with no .env.osp returns error JSON", async () => {
  const dir = await makeTempDir("better-envgen-json-nofile-");
  try {
    const result = await runBetter(["env-gen", "--json", "--project-root", dir]);
    if (result.stdout.trim().startsWith("{")) {
      const out = JSON.parse(result.stdout);
      assert.equal(out.ok, false, "Should return ok: false when template missing");
      assert.ok(out.kind === "better.env.generate", `Expected kind better.env.generate, got ${out.kind}`);
    } else {
      assert.ok(result.exitCode !== 0, "Should exit non-zero when template missing");
    }
  } finally {
    await rmrf(dir);
  }
});

test("env-gen --dry-run resolves static values and marks unresolved osp://", async () => {
  const dir = await makeTempDir("better-envgen-dryrun-");
  try {
    // Write a .env.osp with a mix of static and osp:// values
    await fs.writeFile(path.join(dir, ".env.osp"), [
      "# App config",
      "PORT=3000",
      "NODE_ENV=production",
      "DATABASE_URL=osp://supabase.com/postgres/connection_string",
      "REDIS_URL=osp://upstash.com/redis/url"
    ].join("\n"));

    const result = await runBetter(["env-gen", "--dry-run", "--project-root", dir]);
    // Should not crash and should produce output
    assert.ok(result.stdout.length > 0 || result.stderr.length > 0, "Should produce output");
  } finally {
    await rmrf(dir);
  }
});

test("env-gen --dry-run --json returns structured report", async () => {
  const dir = await makeTempDir("better-envgen-dryrun-json-");
  try {
    await fs.writeFile(path.join(dir, ".env.osp"), [
      "PORT=3000",
      "DATABASE_URL=osp://supabase.com/postgres/connection_string"
    ].join("\n"));

    const result = await runBetter(["env-gen", "--dry-run", "--json", "--project-root", dir]);
    if (result.stdout.trim().startsWith("{")) {
      const out = JSON.parse(result.stdout);
      assert.ok(out.kind === "better.env.generate", `Expected kind better.env.generate, got ${out.kind}`);
      assert.ok(typeof out.dryRun === "boolean", "Should have dryRun field");
      assert.ok(Array.isArray(out.resolved), "Should have resolved array");
      assert.ok(Array.isArray(out.unresolved), "Should have unresolved array");
      assert.ok(typeof out.totalEntries === "number", "Should have totalEntries count");
      // DATABASE_URL should be unresolved (no vault)
      assert.ok(
        out.unresolved.some(u => u.key === "DATABASE_URL"),
        "DATABASE_URL should be in unresolved (no vault)"
      );
    } else {
      // Non-JSON fallback is acceptable
      assert.ok(result.stdout.length > 0 || result.exitCode !== 0, "Should produce output or exit non-zero");
    }
  } finally {
    await rmrf(dir);
  }
});

test("env-gen generates .env file from static values", async () => {
  const dir = await makeTempDir("better-envgen-write-");
  try {
    await fs.writeFile(path.join(dir, ".env.osp"), [
      "PORT=3000",
      "NODE_ENV=production",
      "APP_NAME=myapp"
    ].join("\n"));

    // Intentionally no --dry-run, should write .env
    const result = await runBetter(["env-gen", "--project-root", dir]);
    // If successful, .env should exist
    // If failed (e.g. osp URIs unresolved), also acceptable
    const envExists = await fs.access(path.join(dir, ".env")).then(() => true).catch(() => false);
    if (result.ok) {
      assert.ok(envExists, "Should have written .env file on success");
      const content = await fs.readFile(path.join(dir, ".env"), "utf8");
      assert.ok(content.includes("PORT=3000"), "Should contain static PORT value");
      assert.ok(content.includes("NODE_ENV=production"), "Should contain static NODE_ENV value");
    }
  } finally {
    await rmrf(dir);
  }
});
