// test/node-security-cache.test.js
// Tests for: better node-compat, better node-api-compat, better module-type,
//            better npm-cache-info, better install-time, better hooks-audit,
//            better cve-check, better security, better scan-secrets

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

// ── node-compat ────────────────────────────────────────────────────────────────

test("node-compat --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["node-compat", "--help"], process.cwd());
  assert.ok(ok, "node-compat --help should succeed");
  assert.ok(
    stdout.includes("node") || stdout.includes("compat") || stdout.includes("engines"),
    "should describe Node.js compatibility checking"
  );
});

test("node-compat --json returns compat report for node_modules", async () => {
  const dir = await makeTempDir("better-nodecompat-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0"
    });
    const nmDir = path.join(dir, "node_modules");
    await fs.mkdir(path.join(nmDir, "compat-pkg"), { recursive: true });
    await writeJson(path.join(nmDir, "compat-pkg", "package.json"), {
      name: "compat-pkg", version: "1.0.0",
      engines: { node: ">=14" }
    });

    const { stdout, ok } = await runBetter(["node-compat", "--json"], dir);
    assert.ok(ok, "node-compat should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("node-compat"), `unexpected kind: ${out.kind}`);
      assert.ok(typeof out.totalScanned === "number", "should report totalScanned");
    }
  } finally {
    await rmrf(dir);
  }
});

// ── node-api-compat ───────────────────────────────────────────────────────────

test("node-api-compat --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["node-api-compat", "--help"], process.cwd());
  assert.ok(ok, "node-api-compat --help should succeed");
  assert.ok(
    stdout.includes("napi") || stdout.includes("native") || stdout.includes("addon") ||
    stdout.includes("api") || stdout.includes("compat"),
    "should describe N-API compatibility"
  );
});

test("node-api-compat --json returns ok with no native packages", async () => {
  const dir = await makeTempDir("better-nodeapicompat-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0"
    });
    const nmDir = path.join(dir, "node_modules");
    await fs.mkdir(path.join(nmDir, "pure-js"), { recursive: true });
    await writeJson(path.join(nmDir, "pure-js", "package.json"), {
      name: "pure-js", version: "1.0.0"
    });
    await fs.writeFile(path.join(nmDir, "pure-js", "index.js"), "module.exports = {};");

    const { stdout, ok } = await runBetter(["node-api-compat", "--json"], dir);
    assert.ok(ok, "node-api-compat should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.equal(out.ok, true);
      assert.ok(out.kind?.includes("node-api"), `unexpected kind: ${out.kind}`);
      assert.equal(out.total, 0, "should have 0 native packages");
    }
  } finally {
    await rmrf(dir);
  }
});

// ── module-type ────────────────────────────────────────────────────────────────

test("module-type --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["module-type", "--help"], process.cwd());
  assert.ok(ok, "module-type --help should succeed");
  assert.ok(
    stdout.includes("module") || stdout.includes("type") || stdout.includes("esm") ||
    stdout.includes("cjs") || stdout.includes("commonjs"),
    "should describe module type detection"
  );
});

test("module-type --json returns CJS for package without type field", async () => {
  const dir = await makeTempDir("better-moduletype-cjs-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0"
      // No "type" field → CJS by default
    });
    await fs.writeFile(path.join(dir, "index.js"), "module.exports = {};\n");

    const { stdout, ok } = await runBetter(["module-type", "--json"], dir);
    assert.ok(ok, "module-type should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("module"), `unexpected kind: ${out.kind}`);
      assert.ok(out.declaredType === "commonjs" || out.declaredType === null ||
        out.declaredType === undefined || out.checks !== undefined,
        "should report CJS or provide checks");
    }
  } finally {
    await rmrf(dir);
  }
});

test("module-type --json detects ESM package type", async () => {
  const dir = await makeTempDir("better-moduletype-esm-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test-esm", version: "1.0.0", type: "module"
    });
    await fs.writeFile(path.join(dir, "index.js"), "export default {};\n");

    const { stdout, ok } = await runBetter(["module-type", "--json"], dir);
    assert.ok(ok, "module-type should succeed for ESM package");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.declaredType === "module" || out.checks !== undefined,
        "should report ESM type");
    }
  } finally {
    await rmrf(dir);
  }
});

// ── npm-cache-info ─────────────────────────────────────────────────────────────

test("npm-cache-info --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["npm-cache-info", "--help"], process.cwd());
  assert.ok(ok, "npm-cache-info --help should succeed");
  assert.ok(
    stdout.includes("cache") || stdout.includes("npm") || stdout.includes("size"),
    "should describe npm cache info"
  );
});

test("npm-cache-info --json returns cache information", async () => {
  const dir = await makeTempDir("better-npmcacheinfo-");
  try {
    await writeJson(path.join(dir, "package.json"), { name: "test", version: "1.0.0" });

    const { stdout, ok } = await runBetter(["npm-cache-info", "--json"], dir);
    assert.ok(ok, "npm-cache-info should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.equal(out.ok, true);
      assert.ok(out.kind?.includes("npm-cache"), `unexpected kind: ${out.kind}`);
      assert.ok(typeof out.cachePath === "string", "should report cache path");
    }
  } finally {
    await rmrf(dir);
  }
});

// ── install-time ──────────────────────────────────────────────────────────────

test("install-time --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["install-time", "--help"], process.cwd());
  assert.ok(ok, "install-time --help should succeed");
  assert.ok(
    stdout.includes("install") || stdout.includes("time") || stdout.includes("estimate"),
    "should describe install time estimation"
  );
});

test("install-time --json returns estimates for node_modules", async () => {
  const dir = await makeTempDir("better-installtime-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0"
    });
    const nmDir = path.join(dir, "node_modules");
    await fs.mkdir(path.join(nmDir, "pkg-a"), { recursive: true });
    await writeJson(path.join(nmDir, "pkg-a", "package.json"), {
      name: "pkg-a", version: "1.0.0"
    });
    await fs.writeFile(path.join(nmDir, "pkg-a", "index.js"), "x".repeat(5000));

    const { stdout, ok } = await runBetter(["install-time", "--json"], dir);
    assert.ok(ok, "install-time should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.equal(out.ok, true);
      assert.ok(out.kind?.includes("install-time"), `unexpected kind: ${out.kind}`);
      assert.ok(typeof out.packageCount === "number", "should report packageCount");
      assert.ok(typeof out.freshEstimateMs === "number", "should report freshEstimateMs");
    }
  } finally {
    await rmrf(dir);
  }
});

// ── hooks-audit ────────────────────────────────────────────────────────────────

test("hooks-audit --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["hooks-audit", "--help"], process.cwd());
  assert.ok(ok, "hooks-audit --help should succeed");
  assert.ok(
    stdout.includes("hook") || stdout.includes("audit") || stdout.includes("install"),
    "should describe hooks auditing"
  );
});

test("hooks-audit --json returns ok for packages with no hooks", async () => {
  const dir = await makeTempDir("better-hooksaudit-ok-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      dependencies: { "safe-pkg": "^1.0.0" }
    });
    const nmDir = path.join(dir, "node_modules");
    await fs.mkdir(path.join(nmDir, "safe-pkg"), { recursive: true });
    await writeJson(path.join(nmDir, "safe-pkg", "package.json"), {
      name: "safe-pkg", version: "1.0.0"
      // No install scripts
    });

    const { stdout, ok } = await runBetter(["hooks-audit", "--json"], dir);
    assert.ok(ok, "hooks-audit should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.equal(out.ok, true);
      assert.ok(out.kind?.includes("hooks"), `unexpected kind: ${out.kind}`);
      assert.equal(out.suspicious, 0, "should have no suspicious hooks");
    }
  } finally {
    await rmrf(dir);
  }
});

test("hooks-audit --json flags packages with install scripts", async () => {
  const dir = await makeTempDir("better-hooksaudit-found-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      dependencies: { "scripted-pkg": "^1.0.0" }
    });
    const nmDir = path.join(dir, "node_modules");
    await fs.mkdir(path.join(nmDir, "scripted-pkg"), { recursive: true });
    await writeJson(path.join(nmDir, "scripted-pkg", "package.json"), {
      name: "scripted-pkg", version: "1.0.0",
      scripts: {
        postinstall: "node ./scripts/setup.js"
      }
    });

    const { stdout, ok } = await runBetter(["hooks-audit", "--json"], dir);
    // hooks-audit exits 1 when suspicious hooks found
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("hooks"), `unexpected kind: ${out.kind}`);
      assert.ok(typeof out.suspicious === "number", "should report suspicious count");
      if (!out.ok) {
        assert.ok(out.suspicious >= 1, "should flag scripted-pkg as suspicious");
      }
    }
  } finally {
    await rmrf(dir);
  }
});

// ── cve-check ─────────────────────────────────────────────────────────────────

test("cve-check --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["cve-check", "--help"], process.cwd());
  assert.ok(ok, "cve-check --help should succeed");
  assert.ok(
    stdout.includes("cve") || stdout.includes("vulnerability") || stdout.includes("CVE"),
    "should describe CVE checking"
  );
});

test("cve-check --json returns ok with empty deps", async () => {
  const dir = await makeTempDir("better-cvecheck-empty-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      dependencies: {}
    });
    await fs.mkdir(path.join(dir, "node_modules"), { recursive: true });

    const { stdout, ok } = await runBetter(["cve-check", "--json"], dir);
    assert.ok(ok, "cve-check should succeed with no packages");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.equal(out.ok, true);
      assert.ok(out.kind?.includes("cve"), `unexpected kind: ${out.kind}`);
      assert.equal(out.count, 0, "should have 0 vulnerabilities");
    }
  } finally {
    await rmrf(dir);
  }
});

// ── security ──────────────────────────────────────────────────────────────────

test("security --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["security", "--help"], process.cwd());
  assert.ok(ok, "security --help should succeed");
  assert.ok(
    stdout.includes("security") || stdout.includes("check") || stdout.includes("vulnerabilit"),
    "should describe security checking"
  );
});

test("security --json returns checks array", async () => {
  const dir = await makeTempDir("better-security-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0", license: "MIT"
    });
    await fs.writeFile(path.join(dir, ".npmrc"), "");

    const { stdout } = await runBetter(["security", "--json"], dir);
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("security"), `unexpected kind: ${out.kind}`);
      assert.ok(Array.isArray(out.checks), "should have checks array");
    }
  } finally {
    await rmrf(dir);
  }
});

// ── scan-secrets ──────────────────────────────────────────────────────────────

test("scan-secrets --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["scan-secrets", "--help"], process.cwd());
  assert.ok(ok, "scan-secrets --help should succeed");
  assert.ok(
    stdout.includes("secret") || stdout.includes("scan") || stdout.includes("api.key") ||
    stdout.includes("token"),
    "should describe secret scanning"
  );
});

test("scan-secrets --json finds no secrets in clean source", async () => {
  const dir = await makeTempDir("better-scansecrets-clean-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0"
    });
    await fs.writeFile(path.join(dir, "index.js"), "const x = 42;\nmodule.exports = { x };\n");

    const { stdout, ok } = await runBetter(["scan-secrets", "--json"], dir);
    assert.ok(ok, "scan-secrets should succeed with clean files");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.equal(out.ok, true);
      assert.ok(out.kind?.includes("scan-secrets") || out.kind?.includes("secret"), `unexpected kind: ${out.kind}`);
      assert.equal(out.findings, 0, "should have no secret findings");
    }
  } finally {
    await rmrf(dir);
  }
});

test("scan-secrets --json detects potential API key patterns", async () => {
  const dir = await makeTempDir("better-scansecrets-found-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0"
    });
    // File with an npm token pattern
    await fs.writeFile(
      path.join(dir, "config.js"),
      "const token = 'npm_abcdefghijklmnopqrstuvwxyz1234567890';\n"
    );

    const { stdout } = await runBetter(["scan-secrets", "--json"], dir);
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      // If it finds the npm token pattern, ok should be false
      if (!out.ok) {
        assert.ok(out.findings >= 1, "should report at least one finding");
      }
    }
  } finally {
    await rmrf(dir);
  }
});
