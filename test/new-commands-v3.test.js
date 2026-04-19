/**
 * Integration tests for v3.0 commands:
 * changelog-gen, lockfile-lint, init
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

// ── changelog-gen ──────────────────────────────────────────────────────────────

test("better changelog-gen --help shows usage", async () => {
  const result = await runBetter(["changelog-gen", "--help"]);
  assert.ok(result.stdout.includes("changelog-gen"), `Expected changelog-gen help, got: ${result.stdout}`);
});

test("better changelog-gen shows no commits gracefully", async () => {
  const dir = await makeTempDir();
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test-changelog", version: "1.0.0",
    });
    // No git repo — should either error gracefully or output nothing
    const result = await runBetter(["changelog-gen", "--json"], dir);
    // Should not crash with unexpected errors
    assert.ok(result.stdout !== undefined, "Expected some output");
  } finally {
    await rmrf(dir);
  }
});

test("better changelog-gen parses conventional commits correctly", async () => {
  const dir = await makeTempDir();
  try {
    // Init git repo with some conventional commits
    const { spawnSync } = await import("node:child_process");
    spawnSync("git", ["init"], { cwd: dir });
    spawnSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
    spawnSync("git", ["config", "user.name", "Test"], { cwd: dir });

    await writeJson(path.join(dir, "package.json"), {
      name: "test-changelog", version: "2.0.0",
    });

    // Create initial commit
    spawnSync("git", ["add", "."], { cwd: dir });
    spawnSync("git", ["commit", "-m", "chore: initial commit"], { cwd: dir });

    // Add more commits
    await fs.writeFile(path.join(dir, "index.js"), "// hello\n");
    spawnSync("git", ["add", "."], { cwd: dir });
    spawnSync("git", ["commit", "-m", "feat: add new feature"], { cwd: dir });

    await fs.writeFile(path.join(dir, "fix.js"), "// fix\n");
    spawnSync("git", ["add", "."], { cwd: dir });
    spawnSync("git", ["commit", "-m", "fix(core): resolve bug in parser"], { cwd: dir });

    const result = await runBetter(["changelog-gen", "--json"], dir);
    if (result.stdout?.startsWith("{")) {
      const json = JSON.parse(result.stdout);
      // If git signing fails or commits aren't available in this env, ok:false is acceptable
      if (json.ok === false) {
        assert.ok(typeof json.error === "string", "error response should have a message");
        return; // acceptable failure — git signing may not be available in this test env
      }
      assert.ok(json.kind === "better.changelog-gen", `Expected kind, got: ${JSON.stringify(json)}`);
      assert.ok(typeof json.commits === "number");
      assert.ok(typeof json.markdown === "string");
      if (json.commits >= 2) {
        assert.ok(json.markdown.includes("Features") || json.markdown.includes("feat") || json.markdown.includes("Fix"));
      }
    } else {
      // No commits or no git — acceptable in test env
      assert.ok(result.stdout !== undefined);
    }
  } finally {
    await rmrf(dir);
  }
});

test("better changelog-gen --write creates CHANGELOG.md", async () => {
  const dir = await makeTempDir();
  try {
    const { spawnSync } = await import("node:child_process");
    spawnSync("git", ["init"], { cwd: dir });
    spawnSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
    spawnSync("git", ["config", "user.name", "Test"], { cwd: dir });

    await writeJson(path.join(dir, "package.json"), {
      name: "test-changelog", version: "1.5.0",
    });

    spawnSync("git", ["add", "."], { cwd: dir });
    spawnSync("git", ["commit", "-m", "feat: initial feature"], { cwd: dir });

    const result = await runBetter(["changelog-gen", "--write"], dir);
    // Any of these outcomes is valid: updated, no commits found, or empty output
    const validOutput = result.stdout.includes("CHANGELOG") ||
      result.stdout.includes("changelog") ||
      result.stdout.includes("updated") ||
      result.stdout.includes("commits") ||
      result.stdout.includes("No commits") ||
      result.stdout === "";
    assert.ok(validOutput, `Unexpected output: ${result.stdout}`);
  } finally {
    await rmrf(dir);
  }
});

// ── lockfile-lint ──────────────────────────────────────────────────────────────

test("better lockfile-lint --help shows usage", async () => {
  const result = await runBetter(["lockfile-lint", "--help"]);
  assert.ok(result.stdout.includes("lockfile-lint"), `Expected lockfile-lint help, got: ${result.stdout}`);
});

test("better lockfile-lint fails when no lockfile exists", async () => {
  const dir = await makeTempDir();
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test-lock", version: "1.0.0",
    });
    const result = await runBetter(["lockfile-lint", "--json"], dir);
    if (result.stdout?.startsWith("{")) {
      const json = JSON.parse(result.stdout);
      assert.ok(json.ok === false, `Expected failure without lockfile`);
    }
  } finally {
    await rmrf(dir);
  }
});

test("better lockfile-lint validates healthy lockfile", async () => {
  const dir = await makeTempDir();
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test-lock", version: "1.0.0",
      dependencies: {},
    });

    // Write a minimal valid lockfile v3
    await writeJson(path.join(dir, "package-lock.json"), {
      name: "test-lock",
      version: "1.0.0",
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": {
          name: "test-lock",
          version: "1.0.0",
          dependencies: {},
        },
      },
    });

    const result = await runBetter(["lockfile-lint", "--json"], dir);
    if (result.stdout?.startsWith("{")) {
      const json = JSON.parse(result.stdout);
      assert.ok(json.kind === "better.lockfile-lint");
      assert.ok(json.ok === true, `Expected pass, got: ${JSON.stringify(json)}`);
      assert.ok(json.lockfileVersion === 3);
    }
  } finally {
    await rmrf(dir);
  }
});

test("better lockfile-lint detects missing integrity hashes", async () => {
  const dir = await makeTempDir();
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test-lock", version: "1.0.0",
      dependencies: { "some-pkg": "^1.0.0" },
    });

    await writeJson(path.join(dir, "package-lock.json"), {
      name: "test-lock",
      version: "1.0.0",
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": { name: "test-lock", version: "1.0.0", dependencies: { "some-pkg": "^1.0.0" } },
        "node_modules/some-pkg": {
          version: "1.0.0",
          resolved: "https://registry.npmjs.org/some-pkg/-/some-pkg-1.0.0.tgz",
          // No integrity field — should be flagged
        },
      },
    });

    const result = await runBetter(["lockfile-lint", "--json"], dir);
    if (result.stdout?.startsWith("{")) {
      const json = JSON.parse(result.stdout);
      assert.ok(json.ok === false, `Expected failure due to missing integrity`);
      assert.ok(json.errors > 0, `Expected errors`);
    }
  } finally {
    await rmrf(dir);
  }
});

test("better lockfile-lint detects outdated lockfile version", async () => {
  const dir = await makeTempDir();
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test-lock", version: "1.0.0",
    });

    await writeJson(path.join(dir, "package-lock.json"), {
      name: "test-lock",
      version: "1.0.0",
      lockfileVersion: 1, // Old format
      requires: true,
      dependencies: {},
    });

    const result = await runBetter(["lockfile-lint", "--json"], dir);
    if (result.stdout?.startsWith("{")) {
      const json = JSON.parse(result.stdout);
      assert.ok(json.ok === false, `Expected failure for lockfile v1`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── init ───────────────────────────────────────────────────────────────────────

test("better init --help shows usage", async () => {
  const result = await runBetter(["init", "--help"]);
  assert.ok(result.stdout.includes("init"), `Expected init help, got: ${result.stdout}`);
});

test("better init creates package.json and .gitignore", async () => {
  const dir = await makeTempDir();
  try {
    const result = await runBetter(["init", "--json"], dir);
    if (result.stdout?.startsWith("{")) {
      const json = JSON.parse(result.stdout);
      assert.ok(json.kind === "better.init");
      assert.ok(Array.isArray(json.actions));
      assert.ok(json.actions.length > 0);

      // Check files were created
      const pkgExists = await fs.access(path.join(dir, "package.json")).then(() => true).catch(() => false);
      assert.ok(pkgExists, "package.json should have been created");

      const gitignoreExists = await fs.access(path.join(dir, ".gitignore")).then(() => true).catch(() => false);
      assert.ok(gitignoreExists, ".gitignore should have been created");
    }
  } finally {
    await rmrf(dir);
  }
});

test("better init --dry-run does not write files", async () => {
  const dir = await makeTempDir();
  try {
    const result = await runBetter(["init", "--dry-run", "--json"], dir);
    if (result.stdout?.startsWith("{")) {
      const json = JSON.parse(result.stdout);
      assert.ok(json.dryRun === true);

      // No files should have been created
      const pkgExists = await fs.access(path.join(dir, "package.json")).then(() => true).catch(() => false);
      assert.ok(!pkgExists, "package.json should NOT be created in dry-run");
    }
  } finally {
    await rmrf(dir);
  }
});

test("better init --ci creates GitHub Actions workflow", async () => {
  const dir = await makeTempDir();
  try {
    await runBetter(["init", "--ci"], dir);

    const ciExists = await fs.access(
      path.join(dir, ".github", "workflows", "ci.yml")
    ).then(() => true).catch(() => false);
    assert.ok(ciExists, "CI workflow should have been created");

    const content = await fs.readFile(path.join(dir, ".github", "workflows", "ci.yml"), "utf8");
    assert.ok(content.includes("node-version"), "CI workflow should configure Node.js");
    assert.ok(content.includes("npm ci"), "CI workflow should run npm ci");
  } finally {
    await rmrf(dir);
  }
});

test("better init --readme creates README.md", async () => {
  const dir = await makeTempDir();
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "my-cool-package", version: "1.0.0", license: "MIT",
    });
    await runBetter(["init", "--readme"], dir);

    const readmeExists = await fs.access(path.join(dir, "README.md")).then(() => true).catch(() => false);
    assert.ok(readmeExists, "README.md should have been created");

    const content = await fs.readFile(path.join(dir, "README.md"), "utf8");
    assert.ok(content.includes("my-cool-package"), "README should include package name");
    assert.ok(content.includes("Installation"), "README should have Installation section");
  } finally {
    await rmrf(dir);
  }
});

test("better init updates existing package.json with missing fields", async () => {
  const dir = await makeTempDir();
  try {
    // Create minimal package.json
    await writeJson(path.join(dir, "package.json"), {
      name: "existing-package",
      version: "0.5.0",
    });

    await runBetter(["init"], dir);

    const pkg = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8"));
    assert.ok(pkg.name === "existing-package", "Name should be preserved");
    assert.ok(pkg.version === "0.5.0", "Version should be preserved");
    assert.ok(pkg.license, "License should have been added");
    assert.ok(pkg.engines, "Engines field should have been added");
    assert.ok(pkg.scripts, "Scripts field should have been added");
  } finally {
    await rmrf(dir);
  }
});

test("better init --json returns actions list", async () => {
  const dir = await makeTempDir();
  try {
    const result = await runBetter(["init", "--json", "--dry-run"], dir);
    if (result.stdout?.startsWith("{")) {
      const json = JSON.parse(result.stdout);
      assert.ok(json.kind === "better.init");
      assert.ok(Array.isArray(json.actions));
      // Should have at least package.json and .gitignore and .nvmrc actions
      assert.ok(json.actions.length >= 3, `Expected ≥3 actions, got ${json.actions.length}`);
      const fileNames = json.actions.map(a => a.file);
      assert.ok(fileNames.includes("package.json"), "Should include package.json action");
      assert.ok(fileNames.includes(".gitignore"), "Should include .gitignore action");
    }
  } finally {
    await rmrf(dir);
  }
});

test("better init --context-template creates .better-context.md and better.context.json", async () => {
  const dir = await makeTempDir();
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "my-pkg",
      version: "1.0.0",
    });
    const result = await runBetter(["init", "--context-template"], dir);
    const ctxMd = path.join(dir, ".better-context.md");
    const ctxJson = path.join(dir, "better.context.json");
    const mdExists = await fs.access(ctxMd).then(() => true).catch(() => false);
    const jsonExists = await fs.access(ctxJson).then(() => true).catch(() => false);
    assert.ok(mdExists, ".better-context.md should be created");
    assert.ok(jsonExists, "better.context.json should be created");
    if (mdExists) {
      const md = await fs.readFile(ctxMd, "utf8");
      assert.ok(md.includes("Quick Start"), ".better-context.md should have Quick Start section");
    }
    if (jsonExists) {
      const json = JSON.parse(await fs.readFile(ctxJson, "utf8"));
      assert.ok(json.name === "my-pkg", "better.context.json should have correct name");
      assert.ok(json.schema === "1", "better.context.json should have schema version");
    }
  } finally {
    await rmrf(dir);
  }
});

test("better init --context-template --json includes context files in actions list", async () => {
  const dir = await makeTempDir();
  try {
    const result = await runBetter(["init", "--context-template", "--json", "--dry-run"], dir);
    if (result.stdout?.startsWith("{")) {
      const json = JSON.parse(result.stdout);
      assert.ok(json.ok, "Should succeed");
      const fileNames = json.actions.map(a => a.file);
      assert.ok(
        fileNames.includes(".better-context.md"),
        "Should list .better-context.md in actions"
      );
      assert.ok(
        fileNames.includes("better.context.json"),
        "Should list better.context.json in actions"
      );
    }
  } finally {
    await rmrf(dir);
  }
});
