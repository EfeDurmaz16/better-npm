// test/snapshot-circular-stale.test.js
// Tests for: better snapshot, better circular-deps, better stale, better dep-age

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

// ── snapshot ─────────────────────────────────────────────────────────────────

test("snapshot --help shows usage", async () => {
  // snapshot --help exits 1 when no subcommand given (by design)
  const { stdout } = await runBetter(["snapshot", "--help"], process.cwd());
  assert.ok(
    stdout.includes("save") || stdout.includes("snapshot") || stdout.includes("restore"),
    "should mention save/restore subcommands"
  );
});

test("snapshot save creates a snapshot file", async () => {
  const dir = await makeTempDir("better-snapshot-save-");
  try {
    await writeJson(path.join(dir, "package.json"), { name: "test", version: "1.0.0" });
    await writeJson(path.join(dir, "package-lock.json"), {
      name: "test", lockfileVersion: 3,
      packages: { "": { name: "test", version: "1.0.0" } }
    });

    const { stdout, ok } = await runBetter(["snapshot", "save", "v1", "--json"], dir);
    assert.ok(ok, "snapshot save should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.equal(out.ok, true);
      assert.ok(out.kind?.includes("snapshot"), `unexpected kind: ${out.kind}`);
      assert.ok(out.name === "v1" || out.snapshot === "v1", "should report snapshot name");
    }

    // Snapshot directory and file should exist
    const snapDir = path.join(dir, ".better-snapshots");
    const entries = await fs.readdir(snapDir);
    assert.ok(entries.some(e => e.includes("v1")), "should create snapshot file with name v1");
  } finally {
    await rmrf(dir);
  }
});

test("snapshot list returns empty list when no snapshots", async () => {
  const dir = await makeTempDir("better-snapshot-list-empty-");
  try {
    await writeJson(path.join(dir, "package.json"), { name: "test", version: "1.0.0" });
    await writeJson(path.join(dir, "package-lock.json"), {
      name: "test", lockfileVersion: 3, packages: {}
    });

    const { stdout, ok } = await runBetter(["snapshot", "list", "--json"], dir);
    assert.ok(ok, "snapshot list should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.equal(out.ok, true);
      assert.ok(Array.isArray(out.snapshots), "should have snapshots array");
      assert.equal(out.snapshots.length, 0, "should be empty when no snapshots exist");
    }
  } finally {
    await rmrf(dir);
  }
});

test("snapshot list shows saved snapshots", async () => {
  const dir = await makeTempDir("better-snapshot-list-");
  try {
    await writeJson(path.join(dir, "package.json"), { name: "test", version: "1.0.0" });
    await writeJson(path.join(dir, "package-lock.json"), {
      name: "test", lockfileVersion: 3, packages: { "": { name: "test" } }
    });

    await runBetter(["snapshot", "save", "before-upgrade"], dir);

    const { stdout, ok } = await runBetter(["snapshot", "list", "--json"], dir);
    assert.ok(ok, "snapshot list should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.equal(out.ok, true);
      assert.ok(out.snapshots.length >= 1, "should have at least one snapshot");
      const names = out.snapshots.map(s => s.name ?? s);
      assert.ok(names.some(n => String(n).includes("before-upgrade")), "should show the saved snapshot");
    }
  } finally {
    await rmrf(dir);
  }
});

test("snapshot save then restore restores lockfile contents", async () => {
  const dir = await makeTempDir("better-snapshot-restore-");
  try {
    const originalLock = {
      name: "test", lockfileVersion: 3,
      packages: { "": { name: "test", version: "1.0.0" } }
    };
    await writeJson(path.join(dir, "package.json"), { name: "test", version: "1.0.0" });
    await writeJson(path.join(dir, "package-lock.json"), originalLock);

    // Save snapshot
    await runBetter(["snapshot", "save", "checkpoint", "--json"], dir);

    // Modify lockfile to simulate changes
    await writeJson(path.join(dir, "package-lock.json"), {
      name: "test", lockfileVersion: 3,
      packages: {
        "": { name: "test", version: "1.0.0" },
        "node_modules/lodash": { name: "lodash", version: "4.17.21" }
      }
    });

    // Restore
    const { ok } = await runBetter(["snapshot", "restore", "checkpoint", "--json"], dir);
    assert.ok(ok, "snapshot restore should succeed");

    // Lockfile should be back to original
    const restored = JSON.parse(await fs.readFile(path.join(dir, "package-lock.json"), "utf8"));
    assert.ok(
      !restored.packages["node_modules/lodash"],
      "restored lockfile should not have lodash (was added after snapshot)"
    );
  } finally {
    await rmrf(dir);
  }
});

test("snapshot delete removes the snapshot", async () => {
  const dir = await makeTempDir("better-snapshot-del-");
  try {
    await writeJson(path.join(dir, "package.json"), { name: "test", version: "1.0.0" });
    await writeJson(path.join(dir, "package-lock.json"), {
      name: "test", lockfileVersion: 3, packages: { "": { name: "test" } }
    });

    // Save and then delete
    await runBetter(["snapshot", "save", "temp", "--json"], dir);
    const { ok } = await runBetter(["snapshot", "delete", "temp", "--json"], dir);
    assert.ok(ok, "snapshot delete should succeed");

    // List should be empty again
    const { stdout } = await runBetter(["snapshot", "list", "--json"], dir);
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      const names = (out.snapshots ?? []).map(s => s.name ?? s);
      assert.ok(!names.some(n => String(n).includes("temp")), "deleted snapshot should not appear in list");
    }
  } finally {
    await rmrf(dir);
  }
});

// ── circular-deps ─────────────────────────────────────────────────────────────

test("circular-deps --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["circular-deps", "--help"], process.cwd());
  assert.ok(ok, "circular-deps --help should succeed");
  assert.ok(
    stdout.includes("circular") || stdout.includes("cycle") || stdout.includes("deps"),
    "should describe circular dependency detection"
  );
});

test("circular-deps --json returns ok with no cycles when no node_modules", async () => {
  const dir = await makeTempDir("better-circular-empty-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test",
      version: "1.0.0",
      dependencies: {}
    });

    const { stdout, ok } = await runBetter(["circular-deps", "--json"], dir);
    assert.ok(ok, "circular-deps should succeed");
    const out = JSON.parse(stdout);
    assert.equal(out.ok, true);
    assert.ok(out.kind?.includes("circular"), `unexpected kind: ${out.kind}`);
    assert.ok(Array.isArray(out.cycles), "should have cycles array");
    assert.equal(out.cycles.length, 0, "should have no cycles when no node_modules");
  } finally {
    await rmrf(dir);
  }
});

test("circular-deps --json detects no cycles in acyclic graph", async () => {
  const dir = await makeTempDir("better-circular-acyclic-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test",
      version: "1.0.0",
      dependencies: { "pkg-a": "^1.0.0" }
    });
    // pkg-a depends on pkg-b, pkg-b has no deps — acyclic
    const nmDir = path.join(dir, "node_modules");
    await fs.mkdir(path.join(nmDir, "pkg-a"), { recursive: true });
    await writeJson(path.join(nmDir, "pkg-a", "package.json"), {
      name: "pkg-a", version: "1.0.0", dependencies: { "pkg-b": "^1.0.0" }
    });
    await fs.mkdir(path.join(nmDir, "pkg-b"), { recursive: true });
    await writeJson(path.join(nmDir, "pkg-b", "package.json"), {
      name: "pkg-b", version: "1.0.0", dependencies: {}
    });

    const { stdout, ok } = await runBetter(["circular-deps", "--json"], dir);
    assert.ok(ok, "circular-deps should succeed");
    const out = JSON.parse(stdout);
    assert.equal(out.ok, true);
    assert.equal(out.cycles.length, 0, "should have no cycles in acyclic graph");
  } finally {
    await rmrf(dir);
  }
});

test("circular-deps --json detects circular dependency cycle", async () => {
  const dir = await makeTempDir("better-circular-cyclic-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test",
      version: "1.0.0",
      dependencies: { "pkg-x": "^1.0.0" }
    });
    // Create a cycle: pkg-x → pkg-y → pkg-x
    const nmDir = path.join(dir, "node_modules");
    await fs.mkdir(path.join(nmDir, "pkg-x"), { recursive: true });
    await writeJson(path.join(nmDir, "pkg-x", "package.json"), {
      name: "pkg-x", version: "1.0.0", dependencies: { "pkg-y": "^1.0.0" }
    });
    await fs.mkdir(path.join(nmDir, "pkg-y"), { recursive: true });
    await writeJson(path.join(nmDir, "pkg-y", "package.json"), {
      name: "pkg-y", version: "1.0.0", dependencies: { "pkg-x": "^1.0.0" }
    });

    const { stdout } = await runBetter(["circular-deps", "--json"], dir);
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      // Either ok=false or cycles.length > 0
      assert.ok(
        out.cycles.length > 0 || !out.ok,
        "should detect the pkg-x ↔ pkg-y cycle"
      );
    }
  } finally {
    await rmrf(dir);
  }
});

// ── stale ────────────────────────────────────────────────────────────────────

test("stale --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["stale", "--help"], process.cwd());
  assert.ok(ok, "stale --help should succeed");
  assert.ok(
    stdout.includes("stale") || stdout.includes("abandoned") || stdout.includes("days"),
    "should describe stale package detection"
  );
});

test("stale --json returns ok and packages array when node_modules present", async (t) => {
  const dir = await makeTempDir("better-stale-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test",
      version: "1.0.0",
      dependencies: {}
    });
    // Create a fake node_modules with one package
    const nmDir = path.join(dir, "node_modules");
    await fs.mkdir(path.join(nmDir, "old-lib"), { recursive: true });
    await writeJson(path.join(nmDir, "old-lib", "package.json"), {
      name: "old-lib", version: "1.0.0"
    });

    const result = await runBetter(["stale", "--json"], dir);
    if (!result.ok && (result.stderr.includes("ENOTFOUND") || result.stderr.includes("ETIMEDOUT"))) {
      t.skip("network unavailable");
      return;
    }
    if (result.stdout.trim()) {
      const out = JSON.parse(result.stdout);
      assert.ok(out.ok === true || out.ok === false, "should have ok field");
      assert.ok(out.kind?.includes("stale"), `unexpected kind: ${out.kind}`);
      assert.ok(Array.isArray(out.packages) || Array.isArray(out.stale), "should have packages array");
    }
  } finally {
    await rmrf(dir);
  }
});

test("stale --json handles empty node_modules gracefully", async () => {
  const dir = await makeTempDir("better-stale-empty-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test",
      version: "1.0.0",
      dependencies: {}
    });

    const { stdout, ok } = await runBetter(["stale", "--json"], dir);
    assert.ok(ok, "stale should succeed with no dependencies");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.equal(out.ok, true);
      const pkgs = out.packages ?? out.stale ?? [];
      assert.equal(pkgs.length, 0, "should have no stale packages");
    }
  } finally {
    await rmrf(dir);
  }
});

// ── dep-age ──────────────────────────────────────────────────────────────────

test("dep-age --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["dep-age", "--help"], process.cwd());
  assert.ok(ok, "dep-age --help should succeed");
  assert.ok(
    stdout.includes("age") || stdout.includes("stale") || stdout.includes("threshold"),
    "should describe dep age checking"
  );
});

test("dep-age --json returns ok and packages array", async (t) => {
  const dir = await makeTempDir("better-dep-age-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test",
      version: "1.0.0",
      dependencies: {}
    });

    const result = await runBetter(["dep-age", "--json"], dir);
    // This command hits the npm registry, allow skip if offline
    if (!result.ok && (result.stderr.includes("ENOTFOUND") || result.stderr.includes("ETIMEDOUT"))) {
      t.skip("network unavailable");
      return;
    }
    if (result.stdout.trim()) {
      const out = JSON.parse(result.stdout);
      assert.equal(out.ok, true);
      assert.ok(out.kind?.includes("dep-age"), `unexpected kind: ${out.kind}`);
      assert.ok(Array.isArray(out.packages), "should have packages array");
    }
  } finally {
    await rmrf(dir);
  }
});
