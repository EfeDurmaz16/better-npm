import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { makeTempDir, rmrf, writeJson, writeFile } from "./helpers.js";
import { detectPrimaryLockfile, estimatePackagesFromLockfile } from "../src/lib/lockfile.js";
import { buildPackageSet, comparePackageSets, hashPackageSet } from "../src/parity/packageSetHash.js";
import { createParityContext, runParityCheck } from "../src/parity/checker.js";

test("lockfile helpers detect and estimate lockfile package counts", async () => {
  const dir = await makeTempDir("better-lockfile-");
  try {
    await writeFile(
      path.join(dir, "pnpm-lock.yaml"),
      [
        "lockfileVersion: '9.0'",
        "packages:",
        "  /chalk@5.0.0:",
        "    resolution: {integrity: sha512-1}",
        "  '@types/node@20.1.0':",
        "    resolution: {integrity: sha512-2}",
        ""
      ].join("\n")
    );
    await writeFile(
      path.join(dir, "yarn.lock"),
      [
        "__metadata:",
        "  version: 6",
        "",
        "left-pad@^1.3.0:",
        "  version \"1.3.0\"",
        ""
      ].join("\n")
    );

    const primary = await detectPrimaryLockfile(dir);
    assert.equal(primary?.pm, "pnpm");
    assert.equal(primary?.file, "pnpm-lock.yaml");

    const estimated = await estimatePackagesFromLockfile(dir);
    assert.equal(estimated.ok, true);
    assert.equal(estimated.packageCount, 2);
  } finally {
    await rmrf(dir);
  }
});

test("lockfile estimator handles npm lockfile and invalid json", async () => {
  const dir = await makeTempDir("better-lockfile-npm-");
  try {
    await writeJson(path.join(dir, "package-lock.json"), {
      name: "sample",
      lockfileVersion: 3,
      packages: {
        "": { name: "sample", version: "1.0.0" },
        "node_modules/a": { version: "1.0.0" },
        "node_modules/b": { version: "2.0.0" }
      }
    });
    const good = await estimatePackagesFromLockfile(dir);
    assert.equal(good.ok, true);
    assert.equal(good.packageCount, 2);

    await writeFile(path.join(dir, "package-lock.json"), "{ broken");
    const broken = await estimatePackagesFromLockfile(dir);
    assert.equal(broken.ok, false);
    assert.equal(broken.lockfile.file, "package-lock.json");
  } finally {
    await rmrf(dir);
  }
});

test("parity package set and strict parity check report drift", async () => {
  const dir = await makeTempDir("better-parity-");
  try {
    await writeJson(path.join(dir, "package-lock.json"), {
      name: "parity-test",
      lockfileVersion: 3,
      packages: { "": { name: "parity-test", version: "1.0.0" } }
    });
    await writeJson(path.join(dir, "node_modules", "alpha", "package.json"), {
      name: "alpha",
      version: "1.0.0"
    });
    await writeJson(path.join(dir, "node_modules", "@scope", "beta", "package.json"), {
      name: "@scope/beta",
      version: "2.0.0"
    });
    await writeJson(path.join(dir, "node_modules", "wrapper", "package.json"), {
      name: "wrapper",
      version: "1.0.0"
    });
    await writeJson(path.join(dir, "node_modules", "wrapper", "node_modules", "alpha", "package.json"), {
      name: "alpha",
      version: "2.0.0"
    });

    const beforeSet = await buildPackageSet(path.join(dir, "node_modules"));
    assert.deepEqual(
      [...beforeSet].sort(),
      ["@scope/beta@2.0.0", "alpha@1.0.0", "alpha@2.0.0", "wrapper@1.0.0"]
    );
    const beforeHash = hashPackageSet(beforeSet);
    assert.equal(beforeHash.length, 64);
    assert.equal(beforeHash, hashPackageSet(new Set([...beforeSet].reverse())));

    const context = await createParityContext(dir, true);

    await writeJson(path.join(dir, "package-lock.json"), {
      name: "parity-test",
      lockfileVersion: 3,
      packages: { "": { name: "parity-test", version: "1.0.1" } }
    });
    await writeJson(path.join(dir, "node_modules", "gamma", "package.json"), {
      name: "gamma",
      version: "1.0.0"
    });

    const strict = await runParityCheck({
      projectRoot: dir,
      lockfileBefore: context.lockfileBefore,
      packageSetBefore: context.packageSetBefore,
      mode: "strict"
    });
    assert.equal(strict.ok, false);
    assert.equal(strict.checks.lockfileDrift.hasDrift, true);
    assert.equal(strict.checks.packageSet.match, false);
    assert.ok(strict.errors.length >= 1);

    const afterSet = await buildPackageSet(path.join(dir, "node_modules"));
    const comparison = comparePackageSets(beforeSet, afterSet);
    assert.equal(comparison.match, false);
    assert.ok(comparison.onlyInB.includes("gamma@1.0.0"));
  } finally {
    await rmrf(dir);
  }
});
