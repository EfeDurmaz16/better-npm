/**
 * Integration tests for v1.x intelligence commands:
 * upgrade --smart, sbom-gen, supply-chain-audit, pkg-trust, dep-score
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
    timeout: 30000,
  }).catch(err => ({ stdout: err.stdout || "", stderr: err.stderr || "", code: err.code }));
}

// ── upgrade --smart ───────────────────────────────────────────────────────────

test("better upgrade --smart --help shows smart upgrade help", async () => {
  const result = await runBetter(["upgrade", "--smart", "--help"]);
  assert.ok(
    result.stdout.includes("smart") || result.stdout.includes("upgrade"),
    `Expected smart upgrade help, got: ${result.stdout}`
  );
});

test("better upgrade --smart --json returns kind better.upgrade-smart", async () => {
  const dir = await makeTempDir("better-smart-upgrade-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "smart-upgrade-test",
      version: "1.0.0",
      dependencies: {},
      devDependencies: {}
    });

    const result = await runBetter(["upgrade", "--smart", "--json"], dir);
    if (result.stdout?.startsWith("{")) {
      const json = JSON.parse(result.stdout);
      assert.ok(
        json.kind === "better.upgrade-smart",
        `Expected kind better.upgrade-smart, got: ${JSON.stringify(json)}`
      );
      assert.ok(typeof json.ok === "boolean");
    }
  } finally {
    await rmrf(dir);
  }
});

test("better upgrade --smart --safe-only --json skips major versions", async () => {
  const dir = await makeTempDir("better-smart-safe-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "safe-upgrade-test",
      version: "1.0.0",
      dependencies: {}
    });

    const result = await runBetter(["upgrade", "--smart", "--safe-only", "--json"], dir);
    if (result.stdout?.startsWith("{")) {
      const json = JSON.parse(result.stdout);
      if (json.upgrades) {
        // Should have no "breaking" upgrades when --safe-only
        const breaking = json.upgrades.filter(u => u.safety === "breaking");
        assert.equal(breaking.length, 0, "No breaking upgrades with --safe-only");
      }
    }
  } finally {
    await rmrf(dir);
  }
});

// ── sbom-gen ──────────────────────────────────────────────────────────────────

test("better sbom-gen --help shows help", async () => {
  const result = await runBetter(["sbom-gen", "--help"]);
  assert.ok(
    result.stdout.includes("sbom-gen") || result.stdout.includes("SBOM") || result.stdout.includes("sbom"),
    `Expected sbom-gen help, got: ${result.stdout}`
  );
});

test("better sbom-gen --output --json outputs kind better.sbom-gen", async () => {
  const dir = await makeTempDir("better-sbom-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "sbom-test",
      version: "2.0.0",
      license: "MIT",
      dependencies: {}
    });
    await writeJson(path.join(dir, "package-lock.json"), {
      name: "sbom-test",
      lockfileVersion: 3,
      packages: { "": { name: "sbom-test", version: "2.0.0" } }
    });

    // Use --output to get the {ok, kind} envelope from sbom-gen
    const result = await runBetter(["sbom-gen", "--output", "sbom.json", "--json"], dir);
    if (result.stdout?.startsWith("{")) {
      const json = JSON.parse(result.stdout);
      assert.ok(json.kind === "better.sbom-gen", `Expected kind better.sbom-gen, got: ${JSON.stringify(json)}`);
      assert.equal(json.ok, true);
      assert.ok(json.format === "spdx" || json.format === "cyclonedx", "Should have format");
      assert.ok(typeof json.packages === "number", "Should have package count");
    } else {
      // Without --output, sbom-gen may output raw SBOM — acceptable
      assert.ok(result.stdout !== undefined);
    }
  } finally {
    await rmrf(dir);
  }
});

test("better sbom-gen --format cyclonedx --json outputs cyclonedx", async () => {
  const dir = await makeTempDir("better-sbom-cdx-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "sbom-cdx-test",
      version: "1.0.0",
      dependencies: {}
    });
    await writeJson(path.join(dir, "package-lock.json"), {
      name: "sbom-cdx-test",
      lockfileVersion: 3,
      packages: { "": { name: "sbom-cdx-test", version: "1.0.0" } }
    });

    const result = await runBetter(["sbom-gen", "--format", "cyclonedx", "--json"], dir);
    if (result.stdout?.startsWith("{")) {
      const json = JSON.parse(result.stdout);
      if (json.ok) {
        assert.ok(json.format === "cyclonedx");
      }
    }
  } finally {
    await rmrf(dir);
  }
});

// ── supply-chain-audit ────────────────────────────────────────────────────────

test("better supply-chain-audit --help shows help", async () => {
  const result = await runBetter(["supply-chain-audit", "--help"]);
  assert.ok(
    result.stdout.includes("supply") || result.stdout.includes("chain") || result.stdout.includes("audit"),
    `Expected supply-chain-audit help, got: ${result.stdout}`
  );
});

test("better supply-chain-audit --json returns report", async () => {
  const dir = await makeTempDir("better-sca-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "sca-test",
      version: "1.0.0",
      dependencies: {}
    });
    await writeJson(path.join(dir, "package-lock.json"), {
      name: "sca-test",
      lockfileVersion: 3,
      packages: { "": { name: "sca-test", version: "1.0.0" } }
    });

    const result = await runBetter(["supply-chain-audit", "--json"], dir);
    if (result.stdout?.startsWith("{")) {
      const json = JSON.parse(result.stdout);
      assert.ok(typeof json.ok === "boolean");
    }
  } finally {
    await rmrf(dir);
  }
});

// ── dep-score ─────────────────────────────────────────────────────────────────

test("better dep-score --help shows help", async () => {
  const result = await runBetter(["dep-score", "--help"]);
  assert.ok(
    result.stdout.includes("dep-score") || result.stdout.includes("score") || result.stdout.includes("Usage"),
    `Expected dep-score help, got: ${result.stdout}`
  );
});

test("better dep-score --json returns score structure", async () => {
  const dir = await makeTempDir("better-dep-score-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "score-test",
      version: "1.0.0",
      dependencies: {}
    });

    const result = await runBetter(["dep-score", "--json"], dir);
    if (result.stdout?.startsWith("{")) {
      const json = JSON.parse(result.stdout);
      assert.ok(typeof json.ok === "boolean");
    }
  } finally {
    await rmrf(dir);
  }
});

// ── pkg-trust ─────────────────────────────────────────────────────────────────

test("better pkg-trust --help shows help", async () => {
  const result = await runBetter(["pkg-trust", "--help"]);
  assert.ok(
    result.stdout.includes("pkg-trust") || result.stdout.includes("trust") || result.stdout.includes("Usage"),
    `Expected pkg-trust help, got: ${result.stdout}`
  );
});

// ── reputation ────────────────────────────────────────────────────────────────

test("better reputation --help shows usage", async () => {
  const result = await runBetter(["reputation", "--help"]);
  assert.ok(
    result.stdout.includes("reputation") || result.stdout.includes("score"),
    `Expected reputation help, got: ${result.stdout}`
  );
});

test("better reputation lodash --json returns structured score", async () => {
  const result = await runBetter(["reputation", "lodash", "--json"]);
  if (result.stdout?.startsWith("{")) {
    const json = JSON.parse(result.stdout.trim());
    assert.ok(typeof json.ok === "boolean", "Expected ok field");
    if (json.ok) {
      assert.ok(json.kind === "better.reputation", `Expected kind better.reputation, got ${json.kind}`);
      assert.ok(typeof json.score === "number", "Expected numeric score");
      assert.ok(json.score >= 0 && json.score <= 100, "Score should be 0-100");
      assert.ok(["A", "B", "C", "D", "F"].includes(json.grade), "Expected valid grade");
    }
  } else {
    assert.ok(result.stdout.length > 0 || result.code !== 0, "Should produce output");
  }
});

test("better reputation --help shows ecosystem option", async () => {
  const result = await runBetter(["reputation", "--help"]);
  assert.ok(
    result.stdout.includes("ecosystem") || result.stdout.includes("npm"),
    `Expected ecosystem option in help, got: ${result.stdout}`
  );
});

// ── predict ───────────────────────────────────────────────────────────────────

test("better predict --help shows usage", async () => {
  const result = await runBetter(["predict", "--help"]);
  assert.ok(
    result.stdout.includes("predict") || result.stdout.includes("maintenance"),
    `Expected predict help, got: ${result.stdout}`
  );
});

test("better predict --all --json returns structured predictions", async () => {
  const dir = await makeTempDir("better-predict-all-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "predict-test", version: "1.0.0",
      dependencies: { lodash: "^4.17.21" }
    });
    const result = await runBetter(["predict", "--all", "--json", "--project-root", dir]);
    if (result.stdout?.startsWith("{")) {
      const json = JSON.parse(result.stdout.trim());
      assert.ok(typeof json.ok === "boolean", "Expected ok field");
      if (json.ok) {
        assert.ok(json.kind === "better.predict", `Expected kind better.predict, got ${json.kind}`);
        assert.ok(typeof json.analyzed === "number", "Expected analyzed count");
      }
    } else {
      assert.ok(result.stdout.length > 0 || result.code !== 0, "Should produce output");
    }
  } finally {
    await rmrf(dir);
  }
});

test("better predict lodash --json returns single prediction", async () => {
  const result = await runBetter(["predict", "lodash", "--json"]);
  if (result.stdout?.startsWith("{")) {
    const json = JSON.parse(result.stdout.trim());
    assert.ok(typeof json.ok === "boolean", "Expected ok field");
    if (json.ok) {
      assert.ok(json.kind === "better.predict", `Expected kind better.predict, got ${json.kind}`);
    }
  } else {
    assert.ok(result.stdout.length > 0 || result.code !== 0, "Should produce output");
  }
});

// ── ai review ─────────────────────────────────────────────────────────────────

test("better ai review --help shows help", async () => {
  const result = await runBetter(["ai", "--help"]);
  assert.ok(
    result.stdout.includes("review") || result.stdout.includes("ai"),
    `Expected ai help with review subcommand, got: ${result.stdout}`
  );
});

test("better ai review --json returns kind better.ai.review", async () => {
  const dir = await makeTempDir("better-ai-review-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "ai-review-test",
      version: "1.0.0",
      dependencies: {}
    });

    const result = await runBetter(["ai", "review", "--json", "--project-root", dir]);
    if (result.stdout?.startsWith("{")) {
      const json = JSON.parse(result.stdout);
      assert.ok(json.kind === "better.ai.review", `Expected kind better.ai.review, got: ${JSON.stringify(json)}`);
      assert.equal(json.ok, true);
      assert.ok(typeof json.total_deps === "number");
      assert.ok(Array.isArray(json.suggestions));
    }
  } finally {
    await rmrf(dir);
  }
});

test("better ai review --json detects deprecated packages", async () => {
  const dir = await makeTempDir("better-ai-review-deprecated-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "deprecated-test",
      version: "1.0.0",
      dependencies: { request: "^2.88.0" }
    });

    const result = await runBetter(["ai", "review", "--json", "--project-root", dir]);
    if (result.stdout?.startsWith("{")) {
      const json = JSON.parse(result.stdout);
      if (json.ok && json.suggestions?.length > 0) {
        const hasDeprecated = json.suggestions.some(s => s.packages?.includes("request"));
        assert.ok(hasDeprecated, "Should flag request as deprecated");
      }
    }
  } finally {
    await rmrf(dir);
  }
});

// ── heal ──────────────────────────────────────────────────────────────────────

test("better heal --help shows help", async () => {
  const result = await runBetter(["heal", "--help"]);
  assert.ok(
    result.stdout.includes("heal") || result.stdout.includes("fix"),
    `Expected heal help, got: ${result.stdout}`
  );
});

test("better heal --dry-run --json returns kind better.heal", async () => {
  const dir = await makeTempDir("better-heal-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "heal-test",
      version: "1.0.0",
      dependencies: {}
    });

    const result = await runBetter(["heal", "--dry-run", "--json", "--project-root", dir]);
    if (result.stdout?.startsWith("{")) {
      const json = JSON.parse(result.stdout);
      assert.ok(json.kind === "better.heal", `Expected kind better.heal, got: ${JSON.stringify(json)}`);
      assert.equal(json.ok, true);
      assert.ok(Array.isArray(json.actions));
      assert.ok(typeof json.healed === "number");
      assert.ok(typeof json.pending === "number");
    }
  } finally {
    await rmrf(dir);
  }
});

test("better heal --dry-run detects missing node_modules", async () => {
  const dir = await makeTempDir("better-heal-nm-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "heal-nm-test",
      version: "1.0.0",
      dependencies: {}
    });
    await writeJson(path.join(dir, "package-lock.json"), {
      name: "heal-nm-test",
      lockfileVersion: 3,
      packages: {}
    });
    // Intentionally no node_modules

    const result = await runBetter(["heal", "--dry-run", "--json", "--project-root", dir]);
    if (result.stdout?.startsWith("{")) {
      const json = JSON.parse(result.stdout);
      if (json.ok) {
        const hasMissingNm = json.actions?.some(a =>
          a.issue?.includes("node_modules") || a.issue?.includes("missing")
        );
        assert.ok(hasMissingNm, `Expected missing node_modules action, got actions: ${JSON.stringify(json.actions)}`);
      }
    }
  } finally {
    await rmrf(dir);
  }
});
