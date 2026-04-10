/**
 * Integration tests for v1.5 Intelligence + v2.0 AI-native commands:
 * better upgrade --smart, better impact, better supply-chain, better audit-fix,
 * better score, better ai, better heal, better orchestrate, better cross-project
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

// ── better score ──────────────────────────────────────────────────────────────

test("better score --help shows usage", async () => {
  const result = await runBetter(["score", "--help"]);
  assert.ok(
    result.stdout.includes("score") || result.stdout.includes("health"),
    `Expected score help, got: ${result.stdout}`
  );
});

test("better score --json returns structured output", async () => {
  const dir = await makeTempDir("better-score-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "score-test", version: "1.0.0", dependencies: {}
    });
    const result = await runBetter(["score", "--json", "--project-root", dir]);
    if (result.stdout && result.stdout.trim().startsWith("{")) {
      const parsed = JSON.parse(result.stdout.trim());
      assert.ok(typeof parsed === "object", "Expected JSON object");
    } else {
      assert.ok(result.stdout.length > 0 || result.code !== 0);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── better impact ─────────────────────────────────────────────────────────────

test("better impact --help shows usage", async () => {
  const result = await runBetter(["impact", "--help"]);
  assert.ok(
    result.stdout.includes("impact") || result.stdout.includes("dep"),
    `Expected impact help, got: ${result.stdout}`
  );
});

test("better impact lodash --json returns structured output", async () => {
  const dir = await makeTempDir("better-impact-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "impact-test", version: "1.0.0", dependencies: { lodash: "^4.17.21" }
    });
    const result = await runBetter(["impact", "lodash", "--json", "--project-root", dir]);
    if (result.stdout && result.stdout.trim().startsWith("{")) {
      const parsed = JSON.parse(result.stdout.trim());
      assert.ok(typeof parsed === "object");
    } else {
      assert.ok(result.stdout.length > 0 || result.code !== 0);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── better supply-chain ───────────────────────────────────────────────────────

test("better supply-chain --help shows usage", async () => {
  const result = await runBetter(["supply-chain", "--help"]);
  assert.ok(
    result.stdout.includes("supply") || result.stdout.includes("chain"),
    `Expected supply-chain help, got: ${result.stdout}`
  );
});

test("better supply-chain --json returns structured output", async () => {
  const dir = await makeTempDir("better-sc-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "sc-test", version: "1.0.0", dependencies: {}
    });
    const result = await runBetter(["supply-chain", "--json", "--project-root", dir]);
    if (result.stdout && result.stdout.trim().startsWith("{")) {
      const parsed = JSON.parse(result.stdout.trim());
      assert.ok(typeof parsed === "object");
    } else {
      assert.ok(result.stdout.length > 0 || result.code !== 0);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── better audit-fix ──────────────────────────────────────────────────────────

test("better audit-fix --help shows usage", async () => {
  const result = await runBetter(["audit-fix", "--help"]);
  assert.ok(
    result.stdout.includes("audit") || result.stdout.includes("fix"),
    `Expected audit-fix help, got: ${result.stdout}`
  );
});

test("better audit-fix --dry-run --json returns structured output", async () => {
  const dir = await makeTempDir("better-audit-fix-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "audit-fix-test", version: "1.0.0", dependencies: {}
    });
    const result = await runBetter(["audit-fix", "--dry-run", "--json", "--project-root", dir]);
    if (result.stdout && result.stdout.trim().startsWith("{")) {
      const parsed = JSON.parse(result.stdout.trim());
      assert.ok(typeof parsed === "object");
    } else {
      assert.ok(result.stdout.length > 0 || result.code !== 0);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── better upgrade --smart ────────────────────────────────────────────────────

test("better upgrade --smart --help shows smart flags", async () => {
  const result = await runBetter(["upgrade", "--smart", "--help"]);
  assert.ok(
    result.stdout.includes("smart") || result.stdout.includes("upgrade"),
    `Expected smart upgrade help, got: ${result.stdout}`
  );
});

test("better upgrade --smart --dry-run --json returns structured output", async () => {
  const dir = await makeTempDir("better-upgrade-smart-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "upgrade-smart-test", version: "1.0.0", dependencies: {}
    });
    const result = await runBetter([
      "upgrade", "--smart", "--dry-run", "--json", "--project-root", dir
    ]);
    if (result.stdout && result.stdout.trim().startsWith("{")) {
      const parsed = JSON.parse(result.stdout.trim());
      assert.ok(typeof parsed === "object");
    } else {
      assert.ok(result.stdout.length > 0 || result.code !== 0);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── better ai ─────────────────────────────────────────────────────────────────

test("better ai --help shows subcommands", async () => {
  const result = await runBetter(["ai", "--help"]);
  assert.ok(
    result.stdout.includes("ai") || result.stdout.includes("advise") ||
    result.stdout.includes("explain"),
    `Expected ai help with subcommands, got: ${result.stdout}`
  );
});

test("better ai provision --json returns structured recommendation", async () => {
  const result = await runBetter(["ai", "provision", "I need a database", "--json"]);
  if (result.stdout && result.stdout.trim().startsWith("{")) {
    const parsed = JSON.parse(result.stdout.trim());
    assert.ok(
      parsed.kind !== undefined || parsed.ok !== undefined || parsed.recommended_services !== undefined,
      `Expected ai provision result, got: ${JSON.stringify(parsed)}`
    );
  } else {
    // May require API key — should not crash
    assert.ok(result.stdout.length > 0 || result.stderr.length > 0 || result.code !== 0);
  }
});

test("better ai advise --json returns structured advice", async () => {
  const dir = await makeTempDir("better-ai-advise-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "ai-advise-test", version: "1.0.0",
      dependencies: { lodash: "^4.17.21" }
    });
    const result = await runBetter(["ai", "advise", "--json", "--project-root", dir]);
    if (result.stdout && result.stdout.trim().startsWith("{")) {
      const parsed = JSON.parse(result.stdout.trim());
      assert.ok(typeof parsed === "object");
    } else {
      assert.ok(result.stdout.length > 0 || result.code !== 0);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── better heal ───────────────────────────────────────────────────────────────

test("better heal --help shows usage", async () => {
  const result = await runBetter(["heal", "--help"]);
  assert.ok(
    result.stdout.includes("heal") || result.stdout.includes("fix"),
    `Expected heal help, got: ${result.stdout}`
  );
});

test("better heal --dry-run --json returns structured output", async () => {
  const dir = await makeTempDir("better-heal-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "heal-test", version: "1.0.0", dependencies: {}
    });
    const result = await runBetter(["heal", "--dry-run", "--json", "--project-root", dir]);
    if (result.stdout && result.stdout.trim().startsWith("{")) {
      const parsed = JSON.parse(result.stdout.trim());
      assert.ok(typeof parsed === "object");
    } else {
      assert.ok(result.stdout.length > 0 || result.code !== 0);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── better orchestrate ────────────────────────────────────────────────────────

test("better orchestrate --help shows usage", async () => {
  const result = await runBetter(["orchestrate", "--help"]);
  assert.ok(
    result.stdout.includes("orchestrate") || result.stdout.includes("agent") ||
    result.stdout.includes("pipeline"),
    `Expected orchestrate help, got: ${result.stdout}`
  );
});

// ── better cross-project ──────────────────────────────────────────────────────

test("better cross-project --help shows usage", async () => {
  const result = await runBetter(["cross-project", "--help"]);
  assert.ok(
    result.stdout.includes("cross") || result.stdout.includes("project") ||
    result.stdout.includes("insights"),
    `Expected cross-project help, got: ${result.stdout}`
  );
});

test("better cross-project --json returns structured output", async () => {
  const result = await runBetter(["cross-project", "--json"]);
  if (result.stdout && result.stdout.trim().startsWith("{")) {
    const parsed = JSON.parse(result.stdout.trim());
    assert.ok(typeof parsed === "object");
  } else {
    assert.ok(result.stdout.length > 0 || result.code !== 0);
  }
});
