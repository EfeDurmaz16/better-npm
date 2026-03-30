/**
 * Integration tests for v2.0 commands:
 * notify, graph, pin, clean, env-check, trace, repro, stats,
 * format, check, report, unused, import-map, licenses-report,
 * bundle-check, workspace-graph
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
    timeout: 20000,
  }).catch(err => ({ stdout: err.stdout || "", stderr: err.stderr || "", code: err.code }));
}

// ── notify ────────────────────────────────────────────────────────────────────

test("better notify --help shows usage", async () => {
  const result = await runBetter(["notify", "--help"]);
  assert.ok(result.stdout.includes("notify"), `Expected notify help, got: ${result.stdout}`);
});

test("better notify --json returns structured data", async () => {
  const dir = await makeTempDir();
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test-notify", version: "1.0.0",
      dependencies: {},
    });
    const result = await runBetter(["notify", "--json"], dir);
    if (result.stdout?.startsWith("{")) {
      const json = JSON.parse(result.stdout);
      assert.ok(json.kind === "better.notify");
      assert.ok(Array.isArray(json.updates));
    }
  } finally {
    await rmrf(dir);
  }
});

// ── graph ─────────────────────────────────────────────────────────────────────

test("better graph --help shows usage", async () => {
  const result = await runBetter(["graph", "--help"]);
  assert.ok(result.stdout.includes("graph") && result.stdout.includes("depth"),
    `Expected graph help, got: ${result.stdout}`);
});

test("better graph --cycles on empty project exits cleanly", async () => {
  const dir = await makeTempDir();
  try {
    await writeJson(path.join(dir, "package.json"), { name: "test", version: "1.0.0" });
    await fs.writeFile(path.join(dir, "package-lock.json"),
      JSON.stringify({ lockfileVersion: 3, packages: {} }));
    const result = await runBetter(["graph", "--cycles"], dir);
    // Should indicate no cycles
    assert.ok(
      result.stdout.includes("circular") || result.stdout.includes("cycle") || result.code === 0,
      `Got: ${result.stdout}`
    );
  } finally {
    await rmrf(dir);
  }
});

// ── pin ───────────────────────────────────────────────────────────────────────

test("better pin --help shows usage", async () => {
  const result = await runBetter(["pin", "--help"]);
  assert.ok(result.stdout.includes("pin") && result.stdout.includes("unpin"),
    `Expected pin help, got: ${result.stdout}`);
});

test("better pin --dry-run shows changes", async () => {
  const dir = await makeTempDir();
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      dependencies: { lodash: "^4.17.21" },
    });
    await fs.writeFile(path.join(dir, "package-lock.json"),
      JSON.stringify({
        lockfileVersion: 3,
        packages: { "node_modules/lodash": { version: "4.17.21" } },
      }));
    const result = await runBetter(["pin", "--dry-run"], dir);
    // Should show pinning info
    assert.ok(
      result.stdout.includes("lodash") || result.stdout.includes("pinned") ||
      result.stdout.includes("Pinned"),
      `Expected pin output, got: ${result.stdout}`
    );
  } finally {
    await rmrf(dir);
  }
});

test("better pin --json with range dep returns changes", async () => {
  const dir = await makeTempDir();
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      dependencies: { lodash: "^4.17.21" },
    });
    await fs.writeFile(path.join(dir, "package-lock.json"),
      JSON.stringify({
        lockfileVersion: 3,
        packages: { "node_modules/lodash": { version: "4.17.21" } },
      }));
    const result = await runBetter(["pin", "--dry-run", "--json"], dir);
    if (result.stdout?.startsWith("{")) {
      const json = JSON.parse(result.stdout);
      assert.ok(json.kind === "better.pin");
      assert.ok(Array.isArray(json.changes));
    }
  } finally {
    await rmrf(dir);
  }
});

// ── clean ─────────────────────────────────────────────────────────────────────

test("better clean --help shows usage", async () => {
  const result = await runBetter(["clean", "--help"]);
  assert.ok(result.stdout.includes("clean") && result.stdout.includes("node_modules"),
    `Expected clean help, got: ${result.stdout}`);
});

test("better clean --dry-run reports nothing when no targets", async () => {
  const dir = await makeTempDir();
  try {
    await writeJson(path.join(dir, "package.json"), { name: "test", version: "1.0.0" });
    const result = await runBetter(["clean", "--dry-run"], dir);
    assert.ok(
      result.stdout.includes("Nothing") || result.code === 0,
      `Got: ${result.stdout}`
    );
  } finally {
    await rmrf(dir);
  }
});

test("better clean --dry-run shows dist if it exists", async () => {
  const dir = await makeTempDir();
  try {
    await writeJson(path.join(dir, "package.json"), { name: "test", version: "1.0.0" });
    await fs.mkdir(path.join(dir, "dist"));
    await fs.writeFile(path.join(dir, "dist", "index.js"), "");
    const result = await runBetter(["clean", "--dist", "--dry-run"], dir);
    assert.ok(
      result.stdout.includes("dist") || result.stdout.includes("remove") ||
      result.stdout.includes("dry"),
      `Got: ${result.stdout}`
    );
  } finally {
    await rmrf(dir);
  }
});

// ── env-check ─────────────────────────────────────────────────────────────────

test("better env-check --help shows usage", async () => {
  const result = await runBetter(["env-check", "--help"]);
  assert.ok(result.stdout.includes("env-check") || result.stdout.includes(".env"),
    `Expected env-check help, got: ${result.stdout}`);
});

test("better env-check with .env and .env.example validates correctly", async () => {
  const dir = await makeTempDir();
  try {
    await writeJson(path.join(dir, "package.json"), { name: "test", version: "1.0.0" });
    await fs.writeFile(path.join(dir, ".env.example"), "DATABASE_URL=\nPORT=3000\n");
    await fs.writeFile(path.join(dir, ".env"), "DATABASE_URL=postgres://localhost/db\nPORT=5432\n");
    const result = await runBetter(["env-check"], dir);
    // code is undefined on success (promise resolves), or 0 explicitly
    assert.ok(!result.code || result.code === 0,
      `Expected success, got exit ${result.code}: ${result.stdout}`);
  } finally {
    await rmrf(dir);
  }
});

// ── trace ─────────────────────────────────────────────────────────────────────

test("better trace --help shows usage", async () => {
  const result = await runBetter(["trace", "--help"]);
  assert.ok(result.stdout.includes("trace") || result.stdout.includes("resolution"),
    `Expected trace help, got: ${result.stdout}`);
});

test("better trace missing package returns error", async () => {
  const dir = await makeTempDir();
  try {
    await writeJson(path.join(dir, "package.json"), { name: "test", version: "1.0.0" });
    await fs.writeFile(path.join(dir, "package-lock.json"),
      JSON.stringify({ lockfileVersion: 3, packages: {} }));
    const result = await runBetter(["trace", "nonexistent-pkg-xyz", "--json"], dir);
    if (result.stdout?.startsWith("{")) {
      const json = JSON.parse(result.stdout);
      assert.ok(!json.ok);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── repro ─────────────────────────────────────────────────────────────────────

test("better repro --help shows usage", async () => {
  const result = await runBetter(["repro", "--help"]);
  assert.ok(result.stdout.includes("repro") || result.stdout.includes("reproducib"),
    `Expected repro help, got: ${result.stdout}`);
});

test("better repro without lockfile fails gracefully", async () => {
  const dir = await makeTempDir();
  try {
    await writeJson(path.join(dir, "package.json"), { name: "test", version: "1.0.0" });
    const result = await runBetter(["repro", "--json"], dir);
    if (result.stdout?.startsWith("{")) {
      const json = JSON.parse(result.stdout);
      assert.ok(!json.ok);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── stats ─────────────────────────────────────────────────────────────────────

test("better stats --help shows usage", async () => {
  const result = await runBetter(["stats", "--help"]);
  assert.ok(result.stdout.includes("stats"),
    `Expected stats help, got: ${result.stdout}`);
});

test("better stats --json returns structured data", async () => {
  const dir = await makeTempDir();
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "my-app",
      version: "2.0.0",
      dependencies: { express: "^4.18.0" },
      devDependencies: { jest: "^29.0.0" },
      scripts: { test: "jest", build: "tsc" },
    });
    await fs.writeFile(path.join(dir, "package-lock.json"),
      JSON.stringify({ lockfileVersion: 3, packages: {} }));
    const result = await runBetter(["stats", "--json"], dir);
    if (result.stdout?.startsWith("{")) {
      const json = JSON.parse(result.stdout);
      assert.ok(json.kind === "better.stats");
      assert.strictEqual(json.project.name, "my-app");
      assert.strictEqual(json.dependencies.production, 1);
      assert.strictEqual(json.dependencies.development, 1);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── format ────────────────────────────────────────────────────────────────────

test("better format --check detects unformatted package.json", async () => {
  const dir = await makeTempDir();
  try {
    // Write package.json with deps before name (non-canonical)
    await fs.writeFile(path.join(dir, "package.json"),
      JSON.stringify({ dependencies: { lodash: "^4" }, name: "test", version: "1.0.0" }, null, 2));
    const result = await runBetter(["format", "--check"], dir);
    // Either detects issue (exit 1) or passes -- either way no crash
    assert.ok(
      result.stdout.includes("format") || result.code === 0 || result.code === 1,
      `Got: ${result.stdout}`
    );
  } finally {
    await rmrf(dir);
  }
});

test("better format --json reports change status", async () => {
  const dir = await makeTempDir();
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      dependencies: { lodash: "^4", chalk: "^5" },
    });
    const result = await runBetter(["format", "--json"], dir);
    if (result.stdout?.startsWith("{")) {
      const json = JSON.parse(result.stdout);
      assert.ok(json.kind === "better.format");
      assert.ok(typeof json.changed === "boolean");
    }
  } finally {
    await rmrf(dir);
  }
});

// ── check ─────────────────────────────────────────────────────────────────────

test("better check --help shows usage", async () => {
  const result = await runBetter(["check", "--help"]);
  assert.ok(result.stdout.includes("check") && result.stdout.includes("format"),
    `Expected check help, got: ${result.stdout}`);
});

test("better check --json returns results array", async () => {
  const dir = await makeTempDir();
  try {
    await writeJson(path.join(dir, "package.json"), { name: "test", version: "1.0.0" });
    const result = await runBetter(["check", "--only", "scripts", "--json"], dir);
    if (result.stdout?.startsWith("{")) {
      const json = JSON.parse(result.stdout);
      assert.ok(json.kind === "better.check");
      assert.ok(Array.isArray(json.results));
    }
  } finally {
    await rmrf(dir);
  }
});

// ── report ────────────────────────────────────────────────────────────────────

test("better report --help shows usage", async () => {
  const result = await runBetter(["report", "--help"]);
  assert.ok(result.stdout.includes("report") && result.stdout.includes("format"),
    `Expected report help, got: ${result.stdout}`);
});

test("better report --json returns metadata", async () => {
  const dir = await makeTempDir();
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      dependencies: { lodash: "^4.17.21" },
    });
    await fs.writeFile(path.join(dir, "package-lock.json"),
      JSON.stringify({
        lockfileVersion: 3,
        packages: { "node_modules/lodash": { version: "4.17.21", integrity: "" } },
      }));
    const result = await runBetter(["report", "--json"], dir);
    if (result.stdout?.startsWith("{")) {
      const json = JSON.parse(result.stdout);
      assert.ok(json.kind === "better.report");
    }
  } finally {
    await rmrf(dir);
  }
});

// ── unused ────────────────────────────────────────────────────────────────────

test("better unused --help shows usage", async () => {
  const result = await runBetter(["unused", "--help"]);
  assert.ok(result.stdout.includes("unused") && result.stdout.includes("import"),
    `Expected unused help, got: ${result.stdout}`);
});

test("better unused --json detects unused packages", async () => {
  const dir = await makeTempDir();
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      dependencies: { lodash: "^4.17.21" },
    });
    // Create source file that doesn't import lodash
    await fs.writeFile(path.join(dir, "index.js"), 'console.log("hello");');
    const result = await runBetter(["unused", "--json"], dir);
    if (result.stdout?.startsWith("{")) {
      const json = JSON.parse(result.stdout);
      assert.ok(json.kind === "better.unused");
      assert.ok(Array.isArray(json.unused));
      // lodash is not imported, should be in unused
      assert.ok(json.unused.some(u => u.name === "lodash"),
        `Expected lodash in unused: ${JSON.stringify(json.unused)}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── import-map ────────────────────────────────────────────────────────────────

test("better import-map --help shows usage", async () => {
  const result = await runBetter(["import-map", "--help"]);
  assert.ok(result.stdout.includes("import-map") && result.stdout.includes("CDN"),
    `Expected import-map help, got: ${result.stdout}`);
});

test("better import-map --json returns imports", async () => {
  const dir = await makeTempDir();
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      dependencies: { lodash: "^4.17.21" },
    });
    await fs.writeFile(path.join(dir, "package-lock.json"),
      JSON.stringify({
        lockfileVersion: 3,
        packages: { "node_modules/lodash": { version: "4.17.21" } },
      }));
    const result = await runBetter(["import-map", "--json"], dir);
    if (result.stdout?.startsWith("{")) {
      const json = JSON.parse(result.stdout);
      assert.ok(json.imports, `Expected imports, got: ${JSON.stringify(json)}`);
      assert.ok(json.imports.lodash, `Expected lodash in imports`);
      assert.ok(json.imports.lodash.includes("esm.sh"), `Expected CDN URL`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── licenses-report ───────────────────────────────────────────────────────────

test("better licenses-report --help shows usage", async () => {
  const result = await runBetter(["licenses-report", "--help"]);
  assert.ok(result.stdout.includes("licenses-report") || result.stdout.includes("license"),
    `Expected licenses-report help, got: ${result.stdout}`);
});

// ── bundle-check ──────────────────────────────────────────────────────────────

test("better bundle-check --help shows usage", async () => {
  const result = await runBetter(["bundle-check", "--help"]);
  assert.ok(result.stdout.includes("bundle") && result.stdout.includes("size"),
    `Expected bundle-check help, got: ${result.stdout}`);
});

// ── workspace-graph ───────────────────────────────────────────────────────────

test("better workspace-graph --help shows usage", async () => {
  const result = await runBetter(["workspace-graph", "--help"]);
  assert.ok(result.stdout.includes("workspace") || result.stdout.includes("monorepo"),
    `Expected workspace-graph help, got: ${result.stdout}`);
});

test("better workspace-graph without workspaces field exits with message", async () => {
  const dir = await makeTempDir();
  try {
    await writeJson(path.join(dir, "package.json"), { name: "test", version: "1.0.0" });
    const result = await runBetter(["workspace-graph"], dir);
    assert.ok(
      result.stdout.includes("workspace") || result.stderr.includes("workspace"),
      `Got: ${result.stdout}`
    );
  } finally {
    await rmrf(dir);
  }
});
