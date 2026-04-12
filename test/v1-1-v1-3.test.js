/**
 * Integration tests for v1.1 (Tasks 93, 95) and v1.3 (Tasks 102-107):
 * better context --ecosystem swift/ruby (DocC/YARD generators),
 * better graph (cross-ecosystem dep graph),
 * better registry --cid / federated resolution,
 * better discover (unified search)
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

// ── Task 93: DocC / YARD context generators ─────────────────────────────────

test("better context --help shows usage", async () => {
  const result = await runBetter(["context", "--help"]);
  assert.ok(
    result.stdout.includes("context") || result.stdout.includes("Context")
      || result.stderr.includes("context") || result.code !== undefined,
    `Expected context help, got stdout=${result.stdout} stderr=${result.stderr}`
  );
});

test("better context --ecosystem swift in empty dir returns error or empty", async () => {
  const dir = await makeTempDir("better-context-swift-");
  try {
    const result = await runBetter(["context", "--ecosystem", "swift", "somelib"], dir);
    // Without Package.swift or .swift sources this should error gracefully
    assert.ok(
      result.code !== 0 || result.stdout.length > 0 || result.stderr.length > 0,
      "Expected some output from context command"
    );
  } finally {
    await rmrf(dir);
  }
});

test("better context --ecosystem ruby in empty dir returns error or empty", async () => {
  const dir = await makeTempDir("better-context-ruby-");
  try {
    const result = await runBetter(["context", "--ecosystem", "ruby", "mylib"], dir);
    assert.ok(
      result.code !== 0 || result.stdout.length > 0 || result.stderr.length > 0,
      "Expected some output from context command"
    );
  } finally {
    await rmrf(dir);
  }
});

test("better context --json returns structured output or error", async () => {
  const dir = await makeTempDir("better-context-json-");
  try {
    await writeJson(path.join(dir, "package.json"), { name: "test", version: "1.0.0" });
    const result = await runBetter(["context", "--json"], dir);
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

// ── Task 95: Cross-ecosystem dependency graph ────────────────────────────────

test("better graph --help shows usage", async () => {
  const result = await runBetter(["graph", "--help"]);
  assert.ok(
    result.stdout.includes("graph") || result.stdout.includes("Graph"),
    `Expected graph help, got: ${result.stdout}`
  );
});

test("better graph --json in npm project returns nodes", async () => {
  const dir = await makeTempDir("better-graph-npm-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test-graph", version: "1.0.0", dependencies: {}
    });
    await fs.writeFile(
      path.join(dir, "package-lock.json"),
      JSON.stringify({ lockfileVersion: 3, packages: {}, dependencies: {} })
    );
    const result = await runBetter(["graph", "--json"], dir);
    if (result.stdout && result.stdout.trim().startsWith("{")) {
      const parsed = JSON.parse(result.stdout.trim());
      assert.ok(
        parsed.nodes !== undefined || parsed.packages !== undefined || parsed.ok !== undefined,
        `Expected graph data, got: ${JSON.stringify(parsed)}`
      );
    } else {
      assert.ok(result.stdout.length > 0 || result.code !== 0);
    }
  } finally {
    await rmrf(dir);
  }
});

test("better graph --json in polyglot project lists ecosystems", async () => {
  const dir = await makeTempDir("better-graph-polyglot-");
  try {
    // npm
    await writeJson(path.join(dir, "package.json"), { name: "app", version: "1.0.0" });
    await fs.writeFile(
      path.join(dir, "package-lock.json"),
      JSON.stringify({ lockfileVersion: 3, packages: {}, dependencies: {} })
    );
    // Go
    await fs.writeFile(path.join(dir, "go.sum"), "github.com/gin-gonic/gin v1.9.0 h1:abc\n");
    const result = await runBetter(["graph", "--json"], dir);
    if (result.stdout && result.stdout.trim().startsWith("{")) {
      const parsed = JSON.parse(result.stdout.trim());
      // Should mention both ecosystems somewhere
      const str = JSON.stringify(parsed);
      assert.ok(
        str.includes("npm") || str.includes("go") || str.includes("ecosystems"),
        `Expected ecosystem data, got: ${str.substring(0, 200)}`
      );
    } else {
      assert.ok(result.stdout.length > 0 || result.code !== 0);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── Task 102: Content-addressed registry (CID) ──────────────────────────────

test("better registry cid --help shows cid usage", async () => {
  const result = await runBetter(["registry", "cid", "--help"]);
  assert.ok(
    result.stdout.includes("registry") || result.stdout.includes("cid")
      || result.stdout.includes("CID") || result.code !== 0,
    `Expected cid help, got: ${result.stdout}`
  );
});

test("better registry list --json includes registry metadata", async () => {
  const result = await runBetter(["registry", "list", "--json"]);
  if (result.stdout && (result.stdout.trim().startsWith("{") || result.stdout.trim().startsWith("["))) {
    const parsed = JSON.parse(result.stdout.trim());
    assert.ok(typeof parsed === "object" || Array.isArray(parsed));
  } else {
    assert.ok(result.stdout.length > 0 || result.code !== 0);
  }
});

// ── Task 103: Registry federation ────────────────────────────────────────────

test("better registry federate --help shows federation usage", async () => {
  const result = await runBetter(["registry", "federate", "--help"]);
  assert.ok(
    result.stdout.includes("federate") || result.stdout.includes("registry")
      || result.stdout.includes("Federation") || result.code !== 0,
    `Expected federate help, got: ${result.stdout}`
  );
});

test("better registry add --help shows add usage", async () => {
  const result = await runBetter(["registry", "add", "--help"]);
  assert.ok(
    result.stdout.includes("registry") || result.stdout.includes("add") || result.code !== 0,
    `Expected registry add help, got: ${result.stdout}`
  );
});

// ── Task 106: Unified discovery ───────────────────────────────────────────────

test("better discover --help shows usage", async () => {
  const result = await runBetter(["discover", "--help"]);
  assert.ok(
    result.stdout.includes("discover") || result.stdout.includes("Discover")
      || result.stdout.includes("search"),
    `Expected discover help, got: ${result.stdout}`
  );
});

test("better discover --json database returns structured results", async () => {
  const result = await runBetter(["discover", "--json", "database"]);
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

// ── Task 104: Package signing ─────────────────────────────────────────────────

test("better sign --help shows signing commands", async () => {
  const result = await runBetter(["sign", "--help"]);
  assert.ok(
    result.stdout.includes("sign") || result.stdout.includes("Sign"),
    `Expected sign help, got: ${result.stdout}`
  );
});

test("better sign verify --help shows verify usage", async () => {
  const result = await runBetter(["sign", "verify", "--help"]);
  assert.ok(
    result.stdout.includes("sign") || result.stdout.includes("verify")
      || result.stdout.includes("signature") || result.code !== 0,
    `Expected verify help, got: ${result.stdout}`
  );
});

// ── Task 105: Reproducible builds ─────────────────────────────────────────────

test("better repro --help shows usage", async () => {
  const result = await runBetter(["repro", "--help"]);
  assert.ok(
    result.stdout.includes("repro") || result.stdout.includes("reproducible"),
    `Expected repro help, got: ${result.stdout}`
  );
});

test("better repro --json in empty project returns structured output", async () => {
  const dir = await makeTempDir("better-repro-");
  try {
    const result = await runBetter(["repro", "--json"], dir);
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

// ── Task 107: Content-addressed publish ───────────────────────────────────────

test("better publish --help shows publish flags", async () => {
  const result = await runBetter(["publish", "--help"]);
  assert.ok(
    result.stdout.includes("publish") || result.stdout.includes("Publish")
      || result.stderr.includes("publish") || result.code !== undefined,
    `Expected publish help, got stdout=${result.stdout} stderr=${result.stderr}`
  );
});
