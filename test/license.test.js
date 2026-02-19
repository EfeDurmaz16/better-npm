import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { makeTempDir, rmrf, writeJson, writeFile } from "./helpers.js";

const execFileAsync = promisify(execFile);

async function runLicense(cwd, args = []) {
  const binPath = path.resolve(import.meta.dirname, "../bin/better.js");
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [binPath, "license", "--json", "--project-root", cwd, ...args],
      { cwd }
    );
    return { stdout, stderr, exitCode: 0 };
  } catch (err) {
    return { stdout: err.stdout || "", stderr: err.stderr || "", exitCode: err.code || 1 };
  }
}

describe("better license", () => {
  it("detects MIT license from package.json license field", async () => {
    const tmpDir = await makeTempDir();
    try {
      const nodeModulesDir = path.join(tmpDir, "node_modules");
      const lodashDir = path.join(nodeModulesDir, "lodash");

      await writeJson(path.join(lodashDir, "package.json"), {
        name: "lodash",
        version: "4.17.21",
        license: "MIT"
      });

      const { stdout, exitCode } = await runLicense(tmpDir);
      assert.equal(exitCode, 0);

      const result = JSON.parse(stdout);
      assert.equal(result.ok, true);
      assert.equal(result.kind, "better.license");
      assert.equal(result.schemaVersion, 1);
      assert.equal(result.packages.length, 1);
      assert.equal(result.packages[0].name, "lodash");
      assert.equal(result.packages[0].version, "4.17.21");
      assert.equal(result.packages[0].license, "MIT");
      assert.equal(result.summary.totalPackages, 1);
      assert.equal(result.summary.byLicense.MIT, 1);
      assert.equal(result.summary.violations.length, 0);
    } finally {
      await rmrf(tmpDir);
    }
  });

  it("detects license from LICENSE file when field missing", async () => {
    const tmpDir = await makeTempDir();
    try {
      const nodeModulesDir = path.join(tmpDir, "node_modules");
      const pkgDir = path.join(nodeModulesDir, "test-pkg");

      await writeJson(path.join(pkgDir, "package.json"), {
        name: "test-pkg",
        version: "1.0.0"
      });

      await writeFile(
        path.join(pkgDir, "LICENSE"),
        "ISC License\n\nCopyright (c) 2024 Test\n\nPermission to use..."
      );

      const { stdout, exitCode } = await runLicense(tmpDir);
      assert.equal(exitCode, 0);

      const result = JSON.parse(stdout);
      assert.equal(result.packages.length, 1);
      assert.equal(result.packages[0].name, "test-pkg");
      assert.equal(result.packages[0].license, "ISC");
      assert.equal(result.summary.byLicense.ISC, 1);
    } finally {
      await rmrf(tmpDir);
    }
  });

  it("reports UNKNOWN for packages without license info", async () => {
    const tmpDir = await makeTempDir();
    try {
      const nodeModulesDir = path.join(tmpDir, "node_modules");
      const pkgDir = path.join(nodeModulesDir, "no-license-pkg");

      await writeJson(path.join(pkgDir, "package.json"), {
        name: "no-license-pkg",
        version: "1.0.0"
      });

      const { stdout, exitCode } = await runLicense(tmpDir);
      assert.equal(exitCode, 0);

      const result = JSON.parse(stdout);
      assert.equal(result.packages.length, 1);
      assert.equal(result.packages[0].license, "UNKNOWN");
      assert.equal(result.summary.byLicense.UNKNOWN, 1);
    } finally {
      await rmrf(tmpDir);
    }
  });

  it("--allow flag filters correctly", async () => {
    const tmpDir = await makeTempDir();
    try {
      const nodeModulesDir = path.join(tmpDir, "node_modules");

      await writeJson(path.join(nodeModulesDir, "pkg1", "package.json"), {
        name: "pkg1",
        version: "1.0.0",
        license: "MIT"
      });

      await writeJson(path.join(nodeModulesDir, "pkg2", "package.json"), {
        name: "pkg2",
        version: "1.0.0",
        license: "ISC"
      });

      await writeJson(path.join(nodeModulesDir, "pkg3", "package.json"), {
        name: "pkg3",
        version: "1.0.0",
        license: "GPL-3.0"
      });

      const { stdout, exitCode } = await runLicense(tmpDir, ["--allow", "MIT,ISC"]);
      assert.equal(exitCode, 1);

      const result = JSON.parse(stdout);
      assert.equal(result.ok, false);
      assert.equal(result.packages.length, 3);
      assert.equal(result.summary.violations.length, 1);
      assert.equal(result.summary.violations[0].type, "not-allowed");
      assert.equal(result.summary.violations[0].package, "pkg3");
      assert.equal(result.summary.violations[0].license, "GPL-3.0");
    } finally {
      await rmrf(tmpDir);
    }
  });

  it("--deny flag catches violations and exits non-zero", async () => {
    const tmpDir = await makeTempDir();
    try {
      const nodeModulesDir = path.join(tmpDir, "node_modules");

      await writeJson(path.join(nodeModulesDir, "safe-pkg", "package.json"), {
        name: "safe-pkg",
        version: "1.0.0",
        license: "MIT"
      });

      await writeJson(path.join(nodeModulesDir, "bad-pkg", "package.json"), {
        name: "bad-pkg",
        version: "2.0.0",
        license: "GPL-3.0"
      });

      const { stdout, exitCode } = await runLicense(tmpDir, ["--deny", "GPL-3.0,AGPL-3.0"]);
      assert.equal(exitCode, 1);

      const result = JSON.parse(stdout);
      assert.equal(result.ok, false);
      assert.equal(result.packages.length, 2);
      assert.equal(result.summary.violations.length, 1);
      assert.equal(result.summary.violations[0].type, "denied");
      assert.equal(result.summary.violations[0].package, "bad-pkg");
      assert.equal(result.summary.violations[0].license, "GPL-3.0");
    } finally {
      await rmrf(tmpDir);
    }
  });

  it("groups by license in summary", async () => {
    const tmpDir = await makeTempDir();
    try {
      const nodeModulesDir = path.join(tmpDir, "node_modules");

      await writeJson(path.join(nodeModulesDir, "pkg1", "package.json"), {
        name: "pkg1",
        version: "1.0.0",
        license: "MIT"
      });

      await writeJson(path.join(nodeModulesDir, "pkg2", "package.json"), {
        name: "pkg2",
        version: "1.0.0",
        license: "MIT"
      });

      await writeJson(path.join(nodeModulesDir, "pkg3", "package.json"), {
        name: "pkg3",
        version: "1.0.0",
        license: "ISC"
      });

      await writeJson(path.join(nodeModulesDir, "pkg4", "package.json"), {
        name: "pkg4",
        version: "1.0.0",
        license: "Apache-2.0"
      });

      const { stdout, exitCode } = await runLicense(tmpDir);
      assert.equal(exitCode, 0);

      const result = JSON.parse(stdout);
      assert.equal(result.packages.length, 4);
      assert.equal(result.summary.totalPackages, 4);
      assert.equal(result.summary.byLicense.MIT, 2);
      assert.equal(result.summary.byLicense.ISC, 1);
      assert.equal(result.summary.byLicense["Apache-2.0"], 1);
    } finally {
      await rmrf(tmpDir);
    }
  });

  it("scans scoped packages", async () => {
    const tmpDir = await makeTempDir();
    try {
      const nodeModulesDir = path.join(tmpDir, "node_modules");
      const scopeDir = path.join(nodeModulesDir, "@babel");
      const coreDir = path.join(scopeDir, "core");

      await writeJson(path.join(coreDir, "package.json"), {
        name: "@babel/core",
        version: "7.23.0",
        license: "MIT"
      });

      const { stdout, exitCode } = await runLicense(tmpDir);
      assert.equal(exitCode, 0);

      const result = JSON.parse(stdout);
      assert.equal(result.packages.length, 1);
      assert.equal(result.packages[0].name, "@babel/core");
      assert.equal(result.packages[0].license, "MIT");
    } finally {
      await rmrf(tmpDir);
    }
  });

  it("scans nested node_modules", async () => {
    const tmpDir = await makeTempDir();
    try {
      const nodeModulesDir = path.join(tmpDir, "node_modules");
      const pkgDir = path.join(nodeModulesDir, "parent-pkg");
      const nestedModulesDir = path.join(pkgDir, "node_modules");
      const nestedPkgDir = path.join(nestedModulesDir, "nested-pkg");

      await writeJson(path.join(pkgDir, "package.json"), {
        name: "parent-pkg",
        version: "1.0.0",
        license: "MIT"
      });

      await writeJson(path.join(nestedPkgDir, "package.json"), {
        name: "nested-pkg",
        version: "2.0.0",
        license: "ISC"
      });

      const { stdout, exitCode } = await runLicense(tmpDir);
      assert.equal(exitCode, 0);

      const result = JSON.parse(stdout);
      assert.equal(result.packages.length, 2);

      const parentPkg = result.packages.find((p) => p.name === "parent-pkg");
      const nestedPkg = result.packages.find((p) => p.name === "nested-pkg");

      assert.ok(parentPkg);
      assert.ok(nestedPkg);
      assert.equal(parentPkg.license, "MIT");
      assert.equal(nestedPkg.license, "ISC");
    } finally {
      await rmrf(tmpDir);
    }
  });

  it("handles empty node_modules gracefully", async () => {
    const tmpDir = await makeTempDir();
    try {
      const { stdout, exitCode } = await runLicense(tmpDir);
      assert.equal(exitCode, 0);

      const result = JSON.parse(stdout);
      assert.equal(result.ok, true);
      assert.equal(result.packages.length, 0);
      assert.equal(result.summary.totalPackages, 0);
    } finally {
      await rmrf(tmpDir);
    }
  });
});
