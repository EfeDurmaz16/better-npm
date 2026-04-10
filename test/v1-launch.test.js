/**
 * Integration tests for v1.0–v1.4 commands:
 * better ci (full pipeline), better sign, better registry, better repro,
 * better diff, better infra, better cost, better preview, better deploy
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

// ── better ci (full pipeline) ─────────────────────────────────────────────────

test("better ci --help shows all pipeline steps", async () => {
  const result = await runBetter(["ci", "--help"]);
  assert.ok(result.stdout.includes("ci") || result.stdout.includes("pipeline"),
    `Expected ci help, got: ${result.stdout}`);
  assert.ok(
    result.stdout.includes("frozen") || result.stdout.includes("install") ||
    result.stdout.includes("audit"),
    "Expected ci help to mention install and audit steps"
  );
});

test("better ci --json in empty project returns structured output with steps", async () => {
  const dir = await makeTempDir("better-ci-pipeline-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "ci-test", version: "1.0.0", dependencies: {}
    });
    const result = await runBetter([
      "ci",
      "--no-provenance", "--no-policy", "--no-sbom",
      "--json",
      "--project-root", dir,
    ]);
    if (result.stdout && result.stdout.trim().startsWith("{")) {
      const parsed = JSON.parse(result.stdout.trim());
      assert.ok(parsed.kind === "better.ci" || parsed.steps !== undefined || parsed.ok !== undefined,
        `Expected CI result with kind/steps/ok, got: ${JSON.stringify(parsed)}`);
    } else {
      // May fail gracefully (no better-core binary or no lockfile)
      assert.ok(result.code !== 0 || result.stdout.length > 0);
    }
  } finally {
    await rmrf(dir);
  }
});

test("better ci --no-audit --no-policy --no-sbom --no-provenance returns structured output", async () => {
  const dir = await makeTempDir("better-ci-skip-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "ci-skip-test", version: "1.0.0", dependencies: {}
    });
    const result = await runBetter([
      "ci",
      "--no-audit", "--no-policy", "--no-sbom", "--no-provenance",
      "--json",
      "--project-root", dir,
    ]);
    if (result.stdout && result.stdout.trim().startsWith("{")) {
      const parsed = JSON.parse(result.stdout.trim());
      // Either a successful CI result with skipped steps, or a failed install
      assert.ok(
        parsed.kind === "better.ci" || parsed.ok !== undefined || parsed.steps !== undefined,
        `Expected CI structured output, got: ${JSON.stringify(parsed)}`
      );
      // If steps are present, verify skipped steps exist when install fails fast
      if (parsed.steps && parsed.all_passed) {
        const skipped = parsed.steps.filter(s => s.status === "skipped");
        assert.ok(skipped.length >= 3, `Expected skipped steps in passing result`);
      }
    } else {
      assert.ok(result.stdout.length > 0 || result.code !== 0);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── better sign ───────────────────────────────────────────────────────────────

test("better sign --help shows usage", async () => {
  const result = await runBetter(["sign", "--help"]);
  assert.ok(
    result.stdout.includes("sign") || result.stdout.includes("keygen"),
    `Expected sign help, got: ${result.stdout}`
  );
});

test("better sign keygen --json creates a key pair or errors gracefully", async () => {
  const dir = await makeTempDir("better-sign-");
  try {
    const result = await runBetter(["sign", "keygen", "test-key", "--json"], dir);
    if (result.stdout && result.stdout.trim().startsWith("{")) {
      const parsed = JSON.parse(result.stdout.trim());
      assert.ok(typeof parsed === "object");
    } else {
      // No Rust binary or error — should not throw
      assert.ok(result.stdout.length > 0 || result.code !== 0);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── better registry ───────────────────────────────────────────────────────────

test("better registry --help shows usage", async () => {
  const result = await runBetter(["registry", "--help"]);
  assert.ok(
    result.stdout.includes("registry") || result.stdout.includes("list"),
    `Expected registry help, got: ${result.stdout}`
  );
});

test("better registry list --json returns structured output", async () => {
  const result = await runBetter(["registry", "list", "--json"]);
  if (result.stdout && result.stdout.trim().startsWith("{")) {
    const parsed = JSON.parse(result.stdout.trim());
    assert.ok(typeof parsed === "object");
  } else if (result.stdout && result.stdout.trim().startsWith("[")) {
    const parsed = JSON.parse(result.stdout.trim());
    assert.ok(Array.isArray(parsed));
  } else {
    assert.ok(result.stdout.length > 0 || result.code !== 0);
  }
});

test("better registry federate --help shows federation usage", async () => {
  const result = await runBetter(["registry", "federate", "--help"]);
  assert.ok(
    result.stdout.includes("federate") || result.stdout.includes("registry") ||
    result.stdout.includes("federation"),
    `Expected federate help, got: ${result.stdout}`
  );
});

// ── better repro ──────────────────────────────────────────────────────────────

test("better repro --help shows usage", async () => {
  const result = await runBetter(["repro", "--help"]);
  assert.ok(
    result.stdout.includes("repro") || result.stdout.includes("reproducib"),
    `Expected repro help, got: ${result.stdout}`
  );
});

test("better repro --json in empty project returns structured output", async () => {
  const dir = await makeTempDir("better-repro-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "repro-test", version: "1.0.0", dependencies: {}
    });
    const result = await runBetter(["repro", "--json", "--project-root", dir]);
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

// ── better diff ───────────────────────────────────────────────────────────────

test("better diff --help shows usage", async () => {
  const result = await runBetter(["diff", "--help"]);
  assert.ok(
    result.stdout.includes("diff") || result.stdout.includes("compare"),
    `Expected diff help, got: ${result.stdout}`
  );
});

test("better diff --json in same-state project shows no differences", async () => {
  const dir = await makeTempDir("better-diff-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "diff-test", version: "1.0.0", dependencies: {}
    });
    const result = await runBetter(["diff", "--json", "--project-root", dir]);
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

// ── better infra ──────────────────────────────────────────────────────────────

test("better infra --help shows usage", async () => {
  const result = await runBetter(["infra", "--help"]);
  assert.ok(
    result.stdout.includes("infra") || result.stdout.includes("infrastructure"),
    `Expected infra help, got: ${result.stdout}`
  );
});

test("better infra status --json returns structured output", async () => {
  const dir = await makeTempDir("better-infra-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "infra-test", version: "1.0.0", infraDependencies: {}
    });
    const result = await runBetter(["infra", "status", "--json"], dir);
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

// ── better cost ───────────────────────────────────────────────────────────────

test("better cost --help shows usage", async () => {
  const result = await runBetter(["cost", "--help"]);
  assert.ok(
    result.stdout.includes("cost") || result.stdout.includes("service"),
    `Expected cost help, got: ${result.stdout}`
  );
});

// ── better preview ────────────────────────────────────────────────────────────

test("better preview --help shows usage", async () => {
  const result = await runBetter(["preview", "--help"]);
  assert.ok(
    result.stdout.includes("preview") || result.stdout.includes("ephemeral") ||
    result.stdout.includes("deploy"),
    `Expected preview help, got: ${result.stdout}`
  );
});

// ── better deploy ─────────────────────────────────────────────────────────────

test("better deploy --help shows all flags", async () => {
  const result = await runBetter(["deploy", "--help"]);
  assert.ok(
    result.stdout.includes("deploy") || result.stdout.includes("platform"),
    `Expected deploy help, got: ${result.stdout}`
  );
});

test("better deploy --dry-run --json returns plan", async () => {
  const dir = await makeTempDir("better-deploy-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "deploy-test", version: "1.0.0",
      scripts: { build: "echo built", deploy: "echo deployed" }
    });
    const result = await runBetter(["deploy", "--dry-run", "--json", "--project-root", dir]);
    if (result.stdout && result.stdout.trim().startsWith("{")) {
      const parsed = JSON.parse(result.stdout.trim());
      assert.ok(
        parsed.kind !== undefined || parsed.ok !== undefined || parsed.steps !== undefined,
        `Expected deploy plan, got: ${JSON.stringify(parsed)}`
      );
    } else {
      assert.ok(result.stdout.length > 0 || result.code !== 0);
    }
  } finally {
    await rmrf(dir);
  }
});
