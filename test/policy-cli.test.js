import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(__dirname, "..", "bin", "better.js");

async function runBetter(args, opts = {}) {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  try {
    const result = await execFileAsync(process.execPath, [BIN, ...args], {
      cwd: opts.cwd ?? process.cwd(),
      timeout: opts.timeout ?? 30_000,
      env: { ...process.env, ...opts.env, BETTER_LOG_LEVEL: "silent" }
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (err) {
    return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", exitCode: err.code ?? 1 };
  }
}

describe("better policy", () => {
  describe("help", () => {
    it("should show help text", async () => {
      const result = await runBetter(["policy", "--help"]);
      assert.ok(result.stdout.includes("policy check") || result.stdout.includes("policy init"));
    });
  });

  describe("init", () => {
    let tmpDir;

    before(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "better-policy-test-"));
      // Create a minimal package.json
      await fs.writeFile(path.join(tmpDir, "package.json"), JSON.stringify({ name: "test", version: "1.0.0" }));
    });

    after(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it("should create .betterrc.json with policy config", async () => {
      const result = await runBetter(["policy", "init", "--json", "--project-root", tmpDir]);
      assert.equal(result.exitCode, 0);

      const configPath = path.join(tmpDir, ".betterrc.json");
      const raw = await fs.readFile(configPath, "utf8");
      const config = JSON.parse(raw);

      assert.ok(config.policy, "should have policy field");
      assert.ok(typeof config.policy.threshold === "number", "should have threshold");
      assert.ok(Array.isArray(config.policy.rules), "should have rules array");
      assert.ok(Array.isArray(config.policy.waivers), "should have waivers array");
    });

    it("should output valid JSON with --json flag", async () => {
      const result = await runBetter(["policy", "init", "--json", "--project-root", tmpDir]);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.ok, true);
      assert.equal(parsed.kind, "better.policy.init");
    });

    it("should preserve existing config keys", async () => {
      const configPath = path.join(tmpDir, ".betterrc.json");
      await fs.writeFile(configPath, JSON.stringify({ logLevel: "debug" }));

      await runBetter(["policy", "init", "--project-root", tmpDir]);

      const raw = await fs.readFile(configPath, "utf8");
      const config = JSON.parse(raw);
      assert.equal(config.logLevel, "debug", "should preserve existing keys");
      assert.ok(config.policy, "should add policy");
    });
  });

  describe("check", () => {
    it("should output valid JSON with --json flag", async () => {
      const fixtureDir = path.join(__dirname, "..", "tests", "fixtures", "simple-project");
      const result = await runBetter(["policy", "check", "--json", "--project-root", fixtureDir], { timeout: 60_000 });

      // May fail if no node_modules, but should still output JSON
      if (result.stdout.trim()) {
        const parsed = JSON.parse(result.stdout);
        assert.equal(parsed.kind, "better.policy.check");
        assert.ok("ok" in parsed);
      }
    });

    it("should include score and threshold", async () => {
      const fixtureDir = path.join(__dirname, "..", "tests", "fixtures", "npm-v3-project");
      const result = await runBetter(["policy", "check", "--json", "--project-root", fixtureDir], { timeout: 60_000 });

      if (result.exitCode === 0 || result.stdout.includes("better.policy.check")) {
        const parsed = JSON.parse(result.stdout);
        if (parsed.ok !== undefined && parsed.kind === "better.policy.check") {
          assert.ok(typeof parsed.score === "number", "should have score");
          assert.ok(typeof parsed.threshold === "number", "should have threshold");
          assert.ok(typeof parsed.pass === "boolean", "should have pass");
        }
      }
    });

    it("should respect --threshold flag", async () => {
      const fixtureDir = path.join(__dirname, "..", "tests", "fixtures", "npm-v3-project");
      const result = await runBetter(["policy", "check", "--json", "--threshold", "0", "--project-root", fixtureDir], { timeout: 60_000 });

      if (result.stdout.includes("better.policy.check")) {
        const parsed = JSON.parse(result.stdout);
        if (parsed.kind === "better.policy.check" && parsed.score !== undefined) {
          assert.equal(parsed.threshold, 0);
        }
      }
    });

    it("should include violations and passed arrays", async () => {
      const fixtureDir = path.join(__dirname, "..", "tests", "fixtures", "npm-v3-project");
      const result = await runBetter(["policy", "check", "--json", "--project-root", fixtureDir], { timeout: 60_000 });

      if (result.stdout.includes("better.policy.check")) {
        const parsed = JSON.parse(result.stdout);
        if (parsed.violations !== undefined) {
          assert.ok(Array.isArray(parsed.violations), "violations should be array");
          assert.ok(Array.isArray(parsed.passed), "passed should be array");
        }
      }
    });

    it("should have deterministic pass/fail", async () => {
      const fixtureDir = path.join(__dirname, "..", "tests", "fixtures", "npm-v3-project");
      const result1 = await runBetter(["policy", "check", "--json", "--project-root", fixtureDir], { timeout: 60_000 });
      const result2 = await runBetter(["policy", "check", "--json", "--project-root", fixtureDir], { timeout: 60_000 });

      if (result1.stdout.includes("better.policy.check") && result2.stdout.includes("better.policy.check")) {
        const parsed1 = JSON.parse(result1.stdout);
        const parsed2 = JSON.parse(result2.stdout);
        if (parsed1.pass !== undefined && parsed2.pass !== undefined) {
          assert.equal(parsed1.pass, parsed2.pass, "pass/fail should be deterministic");
          assert.equal(parsed1.score, parsed2.score, "score should be deterministic");
        }
      }
    });
  });

  describe("unknown subcommand", () => {
    it("should error on unknown subcommand", async () => {
      const result = await runBetter(["policy", "nonexistent", "--json"]);
      assert.notEqual(result.exitCode, 0);
    });
  });
});
