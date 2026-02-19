import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const napiNodePath = path.join(repoRoot, "crates", "better-napi", "better-core.darwin-arm64.node");

let addon = null;

try {
  await fs.access(napiNodePath);
  const require = createRequire(import.meta.url);
  addon = require(napiNodePath);
} catch {
  // addon stays null; tests will skip
}

const shouldSkip = addon == null;

describe("napi addon", { skip: shouldSkip }, () => {
  describe("scan()", () => {
    it("returns correct shape for existing directory", () => {
      if (!addon) return;
      const result = addon.scan(repoRoot);
      assert.equal(typeof result, "object");
      assert.equal(result.ok, true);
      assert.ok(result.reason == null, "reason should be null/undefined on success");
      assert.equal(typeof result.logicalBytes, "number");
      assert.equal(typeof result.physicalBytes, "number");
      assert.equal(typeof result.sharedBytes, "number");
      assert.equal(typeof result.physicalBytesApprox, "boolean");
      assert.equal(typeof result.fileCount, "number");
      assert.equal(typeof result.packageCount, "number");
      assert.ok(result.fileCount > 0, "fileCount should be > 0");
      assert.ok(result.logicalBytes > 0, "logicalBytes should be > 0");
    });

    it("returns a result for non-existent directory", () => {
      if (!addon) return;
      const result = addon.scan("/tmp/__napi_test_does_not_exist__");
      assert.equal(typeof result, "object");
      // scan_tree skips NotFound dirs and returns ok=true with zeroed stats
      assert.equal(typeof result.ok, "boolean");
      assert.equal(typeof result.fileCount, "number");
    });
  });

  describe("analyze()", () => {
    it("returns packages array for a project with node_modules", async () => {
      if (!addon) return;
      // Use the repo root if it has node_modules, otherwise skip
      const nmPath = path.join(repoRoot, "node_modules");
      try {
        await fs.access(nmPath);
      } catch {
        return; // skip - no node_modules
      }
      const result = addon.analyze(repoRoot, false);
      assert.equal(typeof result, "object");
      assert.equal(result.ok, true);
      assert.ok(Array.isArray(result.packages), "packages should be an array");
      assert.ok(Array.isArray(result.duplicates), "duplicates should be an array");
      assert.equal(typeof result.depth, "object");
      assert.equal(typeof result.depth.maxDepth, "number");
      assert.equal(typeof result.depth.p95Depth, "number");
      assert.equal(typeof result.nodeModules, "object");
      assert.equal(typeof result.nodeModules.logicalBytes, "number");
      assert.equal(typeof result.nodeModules.physicalBytes, "number");
      assert.equal(typeof result.nodeModules.fileCount, "number");
    });

    it("returns ok=false when node_modules missing", () => {
      if (!addon) return;
      const result = addon.analyze("/tmp/__napi_test_no_nm__", false);
      assert.equal(result.ok, false);
      assert.equal(typeof result.reason, "string");
    });
  });

  describe("materialize()", () => {
    it("copies files from src to dest", async () => {
      if (!addon) return;
      const tmpBase = path.join(repoRoot, ".better-napi-test-tmp-" + Date.now());
      const srcDir = path.join(tmpBase, "src");
      const destDir = path.join(tmpBase, "dest");
      try {
        await fs.mkdir(srcDir, { recursive: true });
        await fs.writeFile(path.join(srcDir, "hello.txt"), "hello world");
        await fs.mkdir(path.join(srcDir, "sub"));
        await fs.writeFile(path.join(srcDir, "sub", "nested.txt"), "nested content");

        const result = addon.materialize(srcDir, destDir, {
          linkStrategy: "copy",
        });
        assert.equal(typeof result, "object");
        assert.equal(result.ok, true);
        assert.ok(result.reason == null, "reason should be null/undefined on success");
        assert.equal(typeof result.stats, "object");
        assert.equal(result.stats.files, 2);
        assert.equal(result.stats.filesCopied, 2);
        assert.equal(typeof result.stats.directories, "number");
        assert.equal(typeof result.phaseDurations, "object");
        assert.equal(typeof result.phaseDurations.scanMs, "number");
        assert.equal(typeof result.phaseDurations.totalMs, "number");

        // Verify files exist
        const content1 = await fs.readFile(path.join(destDir, "hello.txt"), "utf8");
        assert.equal(content1, "hello world");
        const content2 = await fs.readFile(path.join(destDir, "sub", "nested.txt"), "utf8");
        assert.equal(content2, "nested content");
      } finally {
        await fs.rm(tmpBase, { recursive: true, force: true });
      }
    });

    it("supports hardlink strategy", async () => {
      if (!addon) return;
      const tmpBase = path.join(repoRoot, ".better-napi-test-hl-" + Date.now());
      const srcDir = path.join(tmpBase, "src");
      const destDir = path.join(tmpBase, "dest");
      try {
        await fs.mkdir(srcDir, { recursive: true });
        await fs.writeFile(path.join(srcDir, "file.txt"), "data");

        const result = addon.materialize(srcDir, destDir, {
          linkStrategy: "hardlink",
        });
        assert.equal(result.ok, true);
        assert.equal(result.stats.files, 1);
        // Should be linked (not copied) on same filesystem
        assert.equal(result.stats.filesLinked, 1);
        assert.equal(result.stats.filesCopied, 0);
      } finally {
        await fs.rm(tmpBase, { recursive: true, force: true });
      }
    });
  });
});
