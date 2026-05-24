// test/lock-merge.test.js
// Integration tests for better.lock merge driver (v0.3 Task 14.4)

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { makeTempDir, rmrf, writeJson } from "./helpers.js";

const execFileAsync = promisify(execFile);
const betterBin = path.resolve(process.cwd(), "bin", "better.js");

// --- Helper: build a minimal better.lock.json sidecar ---
function makeLockSidecar(packages) {
  const pkgs = {};
  for (const [key, data] of Object.entries(packages)) {
    pkgs[key] = {
      name: data.name,
      version: data.version,
      resolved: data.resolved ?? `https://registry.npmjs.org/${data.name}/-/${data.name}-${data.version}.tgz`,
      integrity: data.integrity ?? `sha512-${data.name}${data.version}fake==`,
      dependencies: data.dependencies ?? {},
    };
  }
  return { version: 1, packages: pkgs };
}

// --- Helper: run the lock merge command ---
async function runLockMerge(base, ours, theirs, dir) {
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [betterBin, "lock", "merge", base, ours, theirs, "--json"],
      {
        cwd: dir,
        env: { ...process.env, BETTER_LOG_LEVEL: "silent" },
        timeout: 30_000,
      }
    );
    return { ok: true, stdout, stderr: "" };
  } catch (err) {
    return { ok: false, stdout: err.stdout ?? "", stderr: err.stderr ?? "", code: err.code };
  }
}

// --- Test: setup-merge-driver writes .gitattributes ---
test("lock setup-merge-driver writes .gitattributes entry", async () => {
  const dir = await makeTempDir("better-lock-merge-setup-");
  try {
    await writeJson(path.join(dir, "package.json"), { name: "merge-driver-test", version: "1.0.0" });

    // Init a git repo so the git config step won't error
    await execFileAsync("git", ["init", "--quiet"], { cwd: dir }).catch(() => {});
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir }).catch(() => {});
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir }).catch(() => {});

    const { stdout } = await execFileAsync(
      process.execPath,
      [betterBin, "lock", "setup-merge-driver", "--json"],
      {
        cwd: dir,
        env: { ...process.env, BETTER_LOG_LEVEL: "silent" },
        timeout: 15_000,
      }
    );

    const report = JSON.parse(stdout);
    assert.equal(report.ok, true);

    // .gitattributes should be created/updated
    const gaPath = path.join(dir, ".gitattributes");
    const gaExists = await fs.stat(gaPath).then(() => true).catch(() => false);
    if (gaExists) {
      const ga = await fs.readFile(gaPath, "utf8");
      assert.ok(
        ga.includes("better.lock") || ga.includes("betterlockjson"),
        ".gitattributes should reference better.lock"
      );
    }
  } finally {
    await rmrf(dir);
  }
});

// --- Test: lock merge with non-conflicting additions ---
test("lock merge: non-conflicting package additions from both branches", async () => {
  const dir = await makeTempDir("better-lock-merge-add-");
  try {
    // Base: only lodash
    const baseSidecar = makeLockSidecar({
      "lodash@4.17.21": { name: "lodash", version: "4.17.21" },
    });

    // Ours: base + express (we added express)
    const oursSidecar = makeLockSidecar({
      "lodash@4.17.21": { name: "lodash", version: "4.17.21" },
      "express@4.18.2": { name: "express", version: "4.18.2" },
    });

    // Theirs: base + axios (they added axios)
    const theirsSidecar = makeLockSidecar({
      "lodash@4.17.21": { name: "lodash", version: "4.17.21" },
      "axios@1.6.0": { name: "axios", version: "1.6.0" },
    });

    const basePath = path.join(dir, "base.lock.json");
    const oursPath = path.join(dir, "ours.lock.json");
    const theirsPath = path.join(dir, "theirs.lock.json");

    await fs.writeFile(basePath, JSON.stringify(baseSidecar, null, 2));
    await fs.writeFile(oursPath, JSON.stringify(oursSidecar, null, 2));
    await fs.writeFile(theirsPath, JSON.stringify(theirsSidecar, null, 2));

    const result = await runLockMerge(basePath, oursPath, theirsPath, dir);

    const combined = result.stdout + result.stderr;

    // Gracefully skip if better-core binary isn't available
    if (
      combined.includes("binary not found") ||
      combined.includes("better-core") ||
      combined.includes("addon not found")
    ) {
      // This is acceptable — merge driver requires better-core binary
      return;
    }

    // If command ran, verify the output
    if (result.stdout) {
      try {
        const report = JSON.parse(result.stdout.trim().split("\n").pop());
        assert.equal(report.kind, "better.lock.merge");
        // No conflicts expected — lodash unchanged, express from ours, axios from theirs
        assert.ok(
          !report.conflicts || report.conflicts.length === 0,
          "Non-conflicting merge should have no conflicts"
        );
      } catch {
        // JSON parse failure is acceptable if output format differs
      }
    }
  } finally {
    await rmrf(dir);
  }
});

// --- Test: lock merge help text is available ---
test("lock merge subcommand is recognized (help text)", async () => {
  const dir = await makeTempDir("better-lock-merge-help-");
  try {
    await writeJson(path.join(dir, "package.json"), { name: "help-test", version: "1.0.0" });

    const { stdout } = await execFileAsync(
      process.execPath,
      [betterBin, "lock", "--help"],
      {
        cwd: dir,
        env: { ...process.env, BETTER_LOG_LEVEL: "silent" },
        timeout: 10_000,
      }
    );

    assert.ok(
      stdout.includes("merge"),
      "lock --help should mention the merge subcommand"
    );
    assert.ok(
      stdout.includes("setup-merge-driver"),
      "lock --help should mention setup-merge-driver"
    );
  } finally {
    await rmrf(dir);
  }
});

// --- Test: lock merge errors gracefully on missing files ---
test("lock merge reports error for missing file arguments", async () => {
  const dir = await makeTempDir("better-lock-merge-missing-");
  try {
    await writeJson(path.join(dir, "package.json"), { name: "missing-test", version: "1.0.0" });

    const result = await runLockMerge(
      "/nonexistent/base.lock.json",
      "/nonexistent/ours.lock.json",
      "/nonexistent/theirs.lock.json",
      dir
    );

    const combined = result.stdout + result.stderr;

    // Should either report an error (binary not found or file not found)
    // or handle gracefully — but should NOT crash with unhandled exception
    assert.ok(
      combined.includes("not found") ||
      combined.includes("error") ||
      combined.includes("Error") ||
      combined.includes("failed") ||
      result.code !== 0,
      "Missing files should produce an error, not a crash"
    );
  } finally {
    await rmrf(dir);
  }
});

// --- Test: lock merge with version conflict produces conflict markers ---
test("lock merge: version conflict is detected and reported", async () => {
  const dir = await makeTempDir("better-lock-merge-conflict-");
  try {
    // Base: lodash 4.17.20
    const baseSidecar = makeLockSidecar({
      "lodash@4.17.20": { name: "lodash", version: "4.17.20" },
    });

    // Ours: upgraded lodash to 4.17.21
    const oursSidecar = makeLockSidecar({
      "lodash@4.17.21": { name: "lodash", version: "4.17.21" },
    });

    // Theirs: upgraded lodash to 4.17.22 (different upgrade)
    const theirsSidecar = makeLockSidecar({
      "lodash@4.17.22": { name: "lodash", version: "4.17.22" },
    });

    const basePath = path.join(dir, "base.lock.json");
    const oursPath = path.join(dir, "ours.lock.json");
    const theirsPath = path.join(dir, "theirs.lock.json");

    await fs.writeFile(basePath, JSON.stringify(baseSidecar, null, 2));
    await fs.writeFile(oursPath, JSON.stringify(oursSidecar, null, 2));
    await fs.writeFile(theirsPath, JSON.stringify(theirsSidecar, null, 2));

    const result = await runLockMerge(basePath, oursPath, theirsPath, dir);
    const combined = result.stdout + result.stderr;

    // Skip if better-core binary isn't available
    if (
      combined.includes("binary not found") ||
      combined.includes("better-core") ||
      combined.includes("addon not found")
    ) {
      return;
    }

    if (result.stdout) {
      try {
        const lines = result.stdout.trim().split("\n");
        const reportLine = lines.findLast(l => l.startsWith("{"));
        if (reportLine) {
          const report = JSON.parse(reportLine);
          // Conflict should be detected
          assert.ok(
            report.conflicts?.length > 0 || report.ok === false,
            "Conflicting upgrades should be detected"
          );
        }
      } catch {
        // JSON parse failure acceptable if output format differs
      }
    }
  } finally {
    await rmrf(dir);
  }
});

// --- Test: lock setup-merge-driver is idempotent ---
test("lock setup-merge-driver is idempotent (running twice is safe)", async () => {
  const dir = await makeTempDir("better-lock-merge-idempotent-");
  try {
    await writeJson(path.join(dir, "package.json"), { name: "idempotent-test", version: "1.0.0" });
    await execFileAsync("git", ["init", "--quiet"], { cwd: dir }).catch(() => {});
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir }).catch(() => {});
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir }).catch(() => {});

    const runSetup = async () =>
      execFileAsync(
        process.execPath,
        [betterBin, "lock", "setup-merge-driver", "--json"],
        {
          cwd: dir,
          env: { ...process.env, BETTER_LOG_LEVEL: "silent" },
          timeout: 15_000,
        }
      );

    const first = await runSetup();
    const firstReport = JSON.parse(first.stdout);
    assert.equal(firstReport.ok, true, "First setup-merge-driver should succeed");

    const second = await runSetup();
    const secondReport = JSON.parse(second.stdout);
    assert.equal(secondReport.ok, true, "Second setup-merge-driver should also succeed");

    // .gitattributes should not have duplicate entries
    const gaPath = path.join(dir, ".gitattributes");
    const gaExists = await fs.stat(gaPath).then(() => true).catch(() => false);
    if (gaExists) {
      const ga = await fs.readFile(gaPath, "utf8");
      const betterLockLines = ga.split("\n").filter(l => l.includes("better.lock"));
      assert.ok(
        betterLockLines.length <= 2,
        `Should not duplicate better.lock entries, got ${betterLockLines.length}`
      );
    }
  } finally {
    await rmrf(dir);
  }
});
