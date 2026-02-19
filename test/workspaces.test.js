import test, { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { makeTempDir, rmrf, writeJson, writeFile } from "./helpers.js";
import {
  detectWorkspaceConfig,
  resolveWorkspacePackages,
  workspaceSummary,
  isWorkspace,
  findWorkspaceRoot
} from "../src/lib/workspaces.js";

describe("detectWorkspaceConfig", () => {
  let tempDir;

  after(async () => {
    if (tempDir) await rmrf(tempDir);
  });

  it("detects npm workspaces from package.json array format", async () => {
    tempDir = await makeTempDir("better-ws-npm-array-");
    await writeJson(path.join(tempDir, "package.json"), {
      name: "npm-ws-test",
      version: "1.0.0",
      workspaces: ["packages/*", "apps/*"]
    });

    const config = await detectWorkspaceConfig(tempDir);
    assert.equal(config.type, "npm");
    assert.deepEqual(config.patterns, ["packages/*", "apps/*"]);
    assert.equal(config.root, tempDir);
  });

  it("detects yarn workspaces when yarn.lock exists", async () => {
    tempDir = await makeTempDir("better-ws-yarn-");
    await writeJson(path.join(tempDir, "package.json"), {
      name: "yarn-ws-test",
      version: "1.0.0",
      workspaces: ["packages/*"]
    });
    await writeFile(path.join(tempDir, "yarn.lock"), "# yarn lockfile v1\n");

    const config = await detectWorkspaceConfig(tempDir);
    assert.equal(config.type, "yarn");
    assert.deepEqual(config.patterns, ["packages/*"]);
    assert.equal(config.root, tempDir);
  });

  it("detects workspaces.packages object format (yarn berry style)", async () => {
    tempDir = await makeTempDir("better-ws-yarn-berry-");
    await writeJson(path.join(tempDir, "package.json"), {
      name: "yarn-berry-test",
      version: "1.0.0",
      workspaces: {
        packages: ["packages/*", "tools/*"]
      }
    });

    const config = await detectWorkspaceConfig(tempDir);
    assert.equal(config.type, "npm");
    assert.deepEqual(config.patterns, ["packages/*", "tools/*"]);
  });

  it("detects pnpm workspaces from pnpm-workspace.yaml", async () => {
    tempDir = await makeTempDir("better-ws-pnpm-");
    await writeJson(path.join(tempDir, "package.json"), {
      name: "pnpm-ws-test",
      version: "1.0.0"
    });
    await writeFile(
      path.join(tempDir, "pnpm-workspace.yaml"),
      `packages:
  - 'packages/*'
  - 'apps/*'
`
    );

    const config = await detectWorkspaceConfig(tempDir);
    assert.equal(config.type, "pnpm");
    assert.deepEqual(config.patterns, ["packages/*", "apps/*"]);
    assert.equal(config.root, tempDir);
  });

  it("returns null type for non-workspace project", async () => {
    tempDir = await makeTempDir("better-ws-none-");
    await writeJson(path.join(tempDir, "package.json"), {
      name: "regular-project",
      version: "1.0.0"
    });

    const config = await detectWorkspaceConfig(tempDir);
    assert.equal(config.type, null);
    assert.deepEqual(config.patterns, []);
    assert.equal(config.root, tempDir);
  });

  it("handles pnpm-workspace.yaml with quoted patterns", async () => {
    tempDir = await makeTempDir("better-ws-pnpm-quoted-");
    await writeJson(path.join(tempDir, "package.json"), {
      name: "pnpm-quoted-test",
      version: "1.0.0"
    });
    await writeFile(
      path.join(tempDir, "pnpm-workspace.yaml"),
      `packages:
  - "packages/*"
  - 'apps/**'
`
    );

    const config = await detectWorkspaceConfig(tempDir);
    assert.equal(config.type, "pnpm");
    assert.deepEqual(config.patterns, ["packages/*", "apps/**"]);
  });

  it("handles pnpm-workspace.yaml with comments", async () => {
    tempDir = await makeTempDir("better-ws-pnpm-comments-");
    await writeJson(path.join(tempDir, "package.json"), {
      name: "pnpm-comments-test",
      version: "1.0.0"
    });
    await writeFile(
      path.join(tempDir, "pnpm-workspace.yaml"),
      `# Workspace configuration
packages:
  # Core packages
  - 'packages/*'
  # Applications
  - 'apps/*'
`
    );

    const config = await detectWorkspaceConfig(tempDir);
    assert.equal(config.type, "pnpm");
    assert.deepEqual(config.patterns, ["packages/*", "apps/*"]);
  });
});

describe("resolveWorkspacePackages", () => {
  let tempDir;

  after(async () => {
    if (tempDir) await rmrf(tempDir);
  });

  it("resolves packages with glob expansion using *", async () => {
    tempDir = await makeTempDir("better-ws-resolve-star-");
    await writeJson(path.join(tempDir, "package.json"), {
      name: "ws-root",
      workspaces: ["packages/*"]
    });

    await writeJson(path.join(tempDir, "packages/pkg-a/package.json"), {
      name: "pkg-a",
      version: "1.0.0"
    });
    await writeJson(path.join(tempDir, "packages/pkg-b/package.json"), {
      name: "pkg-b",
      version: "2.0.0"
    });

    const result = await resolveWorkspacePackages(tempDir);
    assert.equal(result.ok, true);
    assert.equal(result.type, "npm");
    assert.equal(result.packages.length, 2);
    assert.deepEqual(
      result.packageNames.sort(),
      ["pkg-a", "pkg-b"]
    );
  });

  it("resolves packages with glob expansion using **", async () => {
    tempDir = await makeTempDir("better-ws-resolve-doublestar-");
    await writeJson(path.join(tempDir, "package.json"), {
      name: "ws-root",
      workspaces: ["packages/**"]
    });

    await writeJson(path.join(tempDir, "packages/core/package.json"), {
      name: "core",
      version: "1.0.0"
    });
    await writeJson(path.join(tempDir, "packages/utils/helpers/package.json"), {
      name: "helpers",
      version: "1.0.0"
    });

    const result = await resolveWorkspacePackages(tempDir);
    assert.equal(result.ok, true);
    assert.equal(result.packages.length, 2);
    assert.deepEqual(
      result.packageNames.sort(),
      ["core", "helpers"]
    );
  });

  it("identifies workspace dependencies correctly", async () => {
    tempDir = await makeTempDir("better-ws-resolve-deps-");
    await writeJson(path.join(tempDir, "package.json"), {
      name: "ws-root",
      workspaces: ["packages/*"]
    });

    await writeJson(path.join(tempDir, "packages/lib-a/package.json"), {
      name: "lib-a",
      version: "1.0.0"
    });
    await writeJson(path.join(tempDir, "packages/lib-b/package.json"), {
      name: "lib-b",
      version: "1.0.0",
      dependencies: {
        "lib-a": "workspace:*",
        "external-dep": "^1.0.0"
      }
    });
    await writeJson(path.join(tempDir, "packages/lib-c/package.json"), {
      name: "lib-c",
      version: "1.0.0",
      dependencies: {
        "lib-b": "workspace:*"
      },
      devDependencies: {
        "lib-a": "workspace:*"
      }
    });

    const result = await resolveWorkspacePackages(tempDir);
    assert.equal(result.ok, true);

    const libB = result.packages.find(p => p.name === "lib-b");
    assert.deepEqual(libB.workspaceDeps, ["lib-a"]);
    assert.equal(Object.keys(libB.dependencies).length, 2);

    const libC = result.packages.find(p => p.name === "lib-c");
    assert.deepEqual(libC.workspaceDeps.sort(), ["lib-a", "lib-b"]);
  });

  it("skips packages without name field", async () => {
    tempDir = await makeTempDir("better-ws-resolve-noname-");
    await writeJson(path.join(tempDir, "package.json"), {
      name: "ws-root",
      workspaces: ["packages/*"]
    });

    await writeJson(path.join(tempDir, "packages/valid/package.json"), {
      name: "valid-pkg",
      version: "1.0.0"
    });
    await writeJson(path.join(tempDir, "packages/invalid/package.json"), {
      version: "1.0.0"
      // no name field
    });

    const result = await resolveWorkspacePackages(tempDir);
    assert.equal(result.ok, true);
    assert.equal(result.packages.length, 1);
    assert.equal(result.packages[0].name, "valid-pkg");
  });

  it("returns failed result for non-workspace project", async () => {
    tempDir = await makeTempDir("better-ws-resolve-fail-");
    await writeJson(path.join(tempDir, "package.json"), {
      name: "regular-project",
      version: "1.0.0"
    });

    const result = await resolveWorkspacePackages(tempDir);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "no_workspaces");
    assert.equal(result.packages.length, 0);
  });

  it("deduplicates packages matched by multiple patterns", async () => {
    tempDir = await makeTempDir("better-ws-resolve-dedup-");
    await writeJson(path.join(tempDir, "package.json"), {
      name: "ws-root",
      workspaces: ["packages/*", "packages/core"]
    });

    await writeJson(path.join(tempDir, "packages/core/package.json"), {
      name: "core",
      version: "1.0.0"
    });

    const result = await resolveWorkspacePackages(tempDir);
    assert.equal(result.ok, true);
    assert.equal(result.packages.length, 1);
    assert.equal(result.packages[0].name, "core");
  });

  it("includes relative directory paths", async () => {
    tempDir = await makeTempDir("better-ws-resolve-reldir-");
    await writeJson(path.join(tempDir, "package.json"), {
      name: "ws-root",
      workspaces: ["packages/*"]
    });

    await writeJson(path.join(tempDir, "packages/my-pkg/package.json"), {
      name: "my-pkg",
      version: "1.0.0"
    });

    const result = await resolveWorkspacePackages(tempDir);
    assert.equal(result.ok, true);
    const pkg = result.packages[0];
    assert.equal(pkg.relativeDir, path.join("packages", "my-pkg"));
    assert.equal(pkg.dir, path.join(tempDir, "packages", "my-pkg"));
  });

  it("handles peerDependencies as workspace deps", async () => {
    tempDir = await makeTempDir("better-ws-resolve-peer-");
    await writeJson(path.join(tempDir, "package.json"), {
      name: "ws-root",
      workspaces: ["packages/*"]
    });

    await writeJson(path.join(tempDir, "packages/base/package.json"), {
      name: "base",
      version: "1.0.0"
    });
    await writeJson(path.join(tempDir, "packages/plugin/package.json"), {
      name: "plugin",
      version: "1.0.0",
      peerDependencies: {
        "base": "workspace:*"
      }
    });

    const result = await resolveWorkspacePackages(tempDir);
    assert.equal(result.ok, true);

    const plugin = result.packages.find(p => p.name === "plugin");
    assert.deepEqual(plugin.workspaceDeps, ["base"]);
  });
});

describe("workspaceSummary", () => {
  let tempDir;

  after(async () => {
    if (tempDir) await rmrf(tempDir);
  });

  it("generates summary with package counts and dependencies", async () => {
    tempDir = await makeTempDir("better-ws-summary-");
    await writeJson(path.join(tempDir, "package.json"), {
      name: "ws-root",
      workspaces: ["packages/*"]
    });

    await writeJson(path.join(tempDir, "packages/a/package.json"), {
      name: "a",
      version: "1.0.0"
    });
    await writeJson(path.join(tempDir, "packages/b/package.json"), {
      name: "b",
      version: "1.0.0",
      dependencies: {
        "a": "workspace:*",
        "external": "^1.0.0"
      }
    });

    const resolved = await resolveWorkspacePackages(tempDir);
    const summary = workspaceSummary(resolved);

    assert.equal(summary.ok, true);
    assert.equal(summary.type, "npm");
    assert.equal(summary.packageCount, 2);
    assert.equal(summary.totalDependencies, 2);
    assert.equal(summary.internalDependencies, 1);
    assert.equal(summary.packages.length, 2);

    const pkgB = summary.packages.find(p => p.name === "b");
    assert.equal(pkgB.depCount, 2);
    assert.deepEqual(pkgB.workspaceDeps, ["a"]);
  });

  it("returns failed summary for failed resolution", async () => {
    const failedResolution = {
      ok: false,
      reason: "no_workspaces",
      packages: []
    };

    const summary = workspaceSummary(failedResolution);
    assert.equal(summary.ok, false);
    assert.equal(summary.reason, "no_workspaces");
  });

  it("handles workspace with no internal dependencies", async () => {
    tempDir = await makeTempDir("better-ws-summary-nodeps-");
    await writeJson(path.join(tempDir, "package.json"), {
      name: "ws-root",
      workspaces: ["packages/*"]
    });

    await writeJson(path.join(tempDir, "packages/a/package.json"), {
      name: "a",
      version: "1.0.0",
      dependencies: { "external": "^1.0.0" }
    });
    await writeJson(path.join(tempDir, "packages/b/package.json"), {
      name: "b",
      version: "1.0.0"
    });

    const resolved = await resolveWorkspacePackages(tempDir);
    const summary = workspaceSummary(resolved);

    assert.equal(summary.ok, true);
    assert.equal(summary.packageCount, 2);
    assert.equal(summary.internalDependencies, 0);
  });
});

describe("isWorkspace", () => {
  let tempDir;

  after(async () => {
    if (tempDir) await rmrf(tempDir);
  });

  it("returns true for workspace root", async () => {
    tempDir = await makeTempDir("better-ws-isws-true-");
    await writeJson(path.join(tempDir, "package.json"), {
      name: "ws-root",
      workspaces: ["packages/*"]
    });

    const result = await isWorkspace(tempDir);
    assert.equal(result, true);
  });

  it("returns false for regular project", async () => {
    tempDir = await makeTempDir("better-ws-isws-false-");
    await writeJson(path.join(tempDir, "package.json"), {
      name: "regular-project",
      version: "1.0.0"
    });

    const result = await isWorkspace(tempDir);
    assert.equal(result, false);
  });

  it("returns true for pnpm workspace", async () => {
    tempDir = await makeTempDir("better-ws-isws-pnpm-");
    await writeJson(path.join(tempDir, "package.json"), {
      name: "pnpm-root"
    });
    await writeFile(
      path.join(tempDir, "pnpm-workspace.yaml"),
      "packages:\n  - 'packages/*'\n"
    );

    const result = await isWorkspace(tempDir);
    assert.equal(result, true);
  });
});

describe("findWorkspaceRoot", () => {
  let tempDir;

  after(async () => {
    if (tempDir) await rmrf(tempDir);
  });

  it("finds workspace root from nested directory", async () => {
    tempDir = await makeTempDir("better-ws-findroot-");
    await writeJson(path.join(tempDir, "package.json"), {
      name: "ws-root",
      workspaces: ["packages/*"]
    });

    const nestedDir = path.join(tempDir, "packages", "my-pkg", "src");
    await fs.mkdir(nestedDir, { recursive: true });

    const root = await findWorkspaceRoot(nestedDir);
    assert.equal(root, tempDir);
  });

  it("returns null when no workspace root exists", async () => {
    tempDir = await makeTempDir("better-ws-findroot-none-");
    await writeJson(path.join(tempDir, "package.json"), {
      name: "regular-project",
      version: "1.0.0"
    });

    const root = await findWorkspaceRoot(tempDir);
    assert.equal(root, null);
  });

  it("returns current dir when it is the workspace root", async () => {
    tempDir = await makeTempDir("better-ws-findroot-current-");
    await writeJson(path.join(tempDir, "package.json"), {
      name: "ws-root",
      workspaces: ["packages/*"]
    });

    const root = await findWorkspaceRoot(tempDir);
    assert.equal(root, tempDir);
  });
});
