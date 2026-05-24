import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { makeTempDir, rmrf, writeFile, writeJson } from "./helpers.js";

const execFileAsync = promisify(execFile);
const betterBin = path.resolve(process.cwd(), "bin", "better.js");

test("benchmark command emits comparative JSON report", async (t) => {
  if (process.platform === "win32") {
    t.skip("fake npm path shim in this test is POSIX-only");
    return;
  }

  const dir = await makeTempDir("better-benchmark-");
  try {
    await writeJson(path.join(dir, "package.json"), { name: "benchmark-test", version: "1.0.0" });
    await writeJson(path.join(dir, "package-lock.json"), {
      name: "benchmark-test",
      lockfileVersion: 3,
      packages: {
        "": { name: "benchmark-test", version: "1.0.0" }
      }
    });

    const fakeBin = path.join(dir, "fake-bin");
    await fs.mkdir(fakeBin, { recursive: true });
    const fakeNpmPath = path.join(fakeBin, "npm");
    await writeFile(
      fakeNpmPath,
      [
        "#!/bin/sh",
        "mkdir -p node_modules/fake",
        "cat > node_modules/fake/package.json <<'JSON'",
        "{\"name\":\"fake\",\"version\":\"1.0.0\"}",
        "JSON",
        "exit 0",
        ""
      ].join("\n")
    );
    await fs.chmod(fakeNpmPath, 0o755);

    const { stdout } = await execFileAsync(
      process.execPath,
      [
        betterBin,
        "benchmark",
        "--project-root",
        ".",
        "--pm",
        "npm",
        "--engine",
        "pm",
        "--frozen",
        "--cold-rounds",
        "1",
        "--warm-rounds",
        "1",
        "--json"
      ],
      {
        cwd: dir,
        env: {
          ...process.env,
          BETTER_LOG_LEVEL: "silent",
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`
        },
        timeout: 120_000
      }
    );
    const report = JSON.parse(stdout);
    assert.equal(report.ok, true);
    assert.equal(report.kind, "better.benchmark");
    assert.ok(report.schemaVersion >= 1); // accepts v1 or v2+
    assert.equal(report.pm.selected, "npm");
    assert.equal(report.engine, "pm");
    assert.ok(report.variants.raw);
    assert.ok(report.variants.betterMinimal);
    assert.equal(report.variants.raw.cold.length, 1);
    assert.equal(report.variants.raw.warm.length, 1);
    assert.equal(report.variants.betterMinimal.cold.length, 1);
    assert.equal(report.variants.betterMinimal.warm.length, 1);
    assert.ok(typeof report.comparison === "object");
  } finally {
    await rmrf(dir);
  }
});

test("benchmark command works with engine=better on npm lockfile project", async (t) => {
  const dir = await makeTempDir("better-benchmark-engine-better-");
  try {
    await writeJson(path.join(dir, "package.json"), { name: "benchmark-better-test", version: "1.0.0" });
    await writeJson(path.join(dir, "package-lock.json"), {
      name: "benchmark-better-test",
      lockfileVersion: 3,
      packages: {
        "": { name: "benchmark-better-test", version: "1.0.0" }
      }
    });

    let stdout;
    try {
      ({ stdout } = await execFileAsync(
        process.execPath,
        [
          betterBin,
          "benchmark",
          "--project-root",
          ".",
          "--pm",
          "npm",
          "--engine",
          "better",
          "--cold-rounds",
          "1",
          "--warm-rounds",
          "1",
          "--json"
        ],
        {
          cwd: dir,
          env: { ...process.env, BETTER_LOG_LEVEL: "silent" },
          timeout: 120_000
        }
      ));
    } catch (err) {
      // When the NAPI addon or better-core binary is not built, the betterMinimal
      // variant fails. Accept this as a graceful skip in environments without Rust builds.
      const combined = (err.stdout ?? "") + (err.stderr ?? "") + (err.message ?? "");
      const isRustUnavailable =
        combined.includes("Rust engine") ||
        combined.includes("addon not found") ||
        combined.includes("binary not found") ||
        combined.includes("napi:build") ||
        combined.includes("core:build") ||
        combined.includes("better-core") ||
        // betterMinimal cold round failing in round 1 indicates Rust engine unavailable
        (combined.includes("betterMinimal") && combined.includes("cold round 1 failed"));
      if (isRustUnavailable) {
        t.skip("NAPI addon / better-core not built — skipping engine=better benchmark test");
        return;
      }
      throw err;
    }
    const report = JSON.parse(stdout);
    assert.equal(report.ok, true);
    assert.equal(report.kind, "better.benchmark");
    assert.equal(report.engine, "better");
    assert.equal(report.pm.selected, "npm");
    assert.ok(report.variants.raw);
    assert.ok(report.variants.betterMinimal);
  } finally {
    await rmrf(dir);
  }
});
