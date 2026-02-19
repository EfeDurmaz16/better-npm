import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { makeTempDir, rmrf, writeFile } from "./helpers.js";
import {
  hashFile,
  fileStorePath,
  packageManifestPath,
  packageManifestDir,
  ingestPackageToFileCas,
  materializeFromFileCas,
  hasFileCasManifest,
  getFileCasStats,
  gcFileCas
} from "../src/engine/better/fileCas.js";

describe("fileCas", () => {
  let tempDir;

  before(async () => {
    tempDir = await makeTempDir("filecas-test-");
  });

  after(async () => {
    await rmrf(tempDir);
  });

  it("hashFile: computes SHA-256 hash of a file", async () => {
    const testFile = path.join(tempDir, "test-hash.txt");
    const content = "hello world\n";
    await writeFile(testFile, content);

    const hash = await hashFile(testFile);

    // Verify it's a valid hex string
    assert.match(hash, /^[a-f0-9]{64}$/);

    // Verify it matches expected SHA-256
    const expected = crypto.createHash("sha256").update(content).digest("hex");
    assert.equal(hash, expected);
  });

  it("fileStorePath: returns correct path structure", () => {
    const storeRoot = "/test/store";
    const hex = "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";

    const result = fileStorePath(storeRoot, hex);

    assert.equal(result, "/test/store/files/sha256/ab/cd/abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890");
  });

  it("packageManifestDir: returns correct path structure", () => {
    const storeRoot = "/test/store";
    const algorithm = "sha512";
    const pkgHex = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

    const result = packageManifestDir(storeRoot, algorithm, pkgHex);

    assert.equal(result, "/test/store/packages/sha512/fe/dc/fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210");
  });

  it("packageManifestPath: returns manifest.json path", () => {
    const storeRoot = "/test/store";
    const algorithm = "sha512";
    const pkgHex = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

    const result = packageManifestPath(storeRoot, algorithm, pkgHex);

    assert.equal(result, "/test/store/packages/sha512/fe/dc/fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210/manifest.json");
  });

  it("ingestPackageToFileCas: ingests package files into CAS", async () => {
    const storeRoot = path.join(tempDir, "cas-store-1");
    const pkgDir = path.join(tempDir, "pkg-1");

    // Create test package with multiple files
    await writeFile(path.join(pkgDir, "index.js"), "console.log('hello');\n");
    await writeFile(path.join(pkgDir, "package.json"), '{"name":"test"}\n');
    await writeFile(path.join(pkgDir, "lib", "util.js"), "export const x = 1;\n");

    const pkgHex = "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
    const result = await ingestPackageToFileCas(storeRoot, "sha512", pkgHex, pkgDir);

    // Verify result structure
    assert.equal(result.reused, false);
    assert.equal(result.stats.totalFiles, 3);
    assert.equal(result.stats.newFiles, 3);
    assert.equal(result.stats.existingFiles, 0);
    assert.ok(result.stats.totalBytes > 0);

    // Verify manifest was created
    assert.ok(result.manifest);
    assert.equal(result.manifest.version, 1);
    assert.equal(result.manifest.pkgAlgorithm, "sha512");
    assert.equal(result.manifest.pkgHex, pkgHex);
    assert.equal(result.manifest.fileCount, 3);

    // Verify files in manifest
    assert.ok(result.manifest.files["index.js"]);
    assert.ok(result.manifest.files["package.json"]);
    assert.ok(result.manifest.files["lib/util.js"]);

    // Verify files were stored in CAS
    const indexHash = result.manifest.files["index.js"].hash;
    const storedFile = fileStorePath(storeRoot, indexHash);
    const storedContent = await fs.readFile(storedFile, "utf8");
    assert.equal(storedContent, "console.log('hello');\n");
  });

  it("ingestPackageToFileCas: second ingest reuses existing manifest", async () => {
    const storeRoot = path.join(tempDir, "cas-store-2");
    const pkgDir = path.join(tempDir, "pkg-2");

    await writeFile(path.join(pkgDir, "index.js"), "console.log('test');\n");

    const pkgHex = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

    // First ingest
    const result1 = await ingestPackageToFileCas(storeRoot, "sha512", pkgHex, pkgDir);
    assert.equal(result1.reused, false);
    assert.equal(result1.stats.newFiles, 1);

    // Second ingest - should reuse
    const result2 = await ingestPackageToFileCas(storeRoot, "sha512", pkgHex, pkgDir);
    assert.equal(result2.reused, true);
    assert.equal(result2.stats.newFiles, 0);
    assert.equal(result2.stats.existingFiles, 1);
  });

  it("ingestPackageToFileCas: handles symlinks", async () => {
    const storeRoot = path.join(tempDir, "cas-store-symlink");
    const pkgDir = path.join(tempDir, "pkg-symlink");

    await writeFile(path.join(pkgDir, "real.txt"), "real file\n");
    await fs.symlink("real.txt", path.join(pkgDir, "link.txt"));

    const pkgHex = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const result = await ingestPackageToFileCas(storeRoot, "sha512", pkgHex, pkgDir);

    assert.equal(result.manifest.files["real.txt"].type, "file");
    assert.equal(result.manifest.files["link.txt"].type, "symlink");
    assert.equal(result.manifest.files["link.txt"].target, "real.txt");
  });

  it("materializeFromFileCas: recreates package from CAS", async () => {
    const storeRoot = path.join(tempDir, "cas-store-3");
    const pkgDir = path.join(tempDir, "pkg-3");
    const destDir = path.join(tempDir, "dest-3");

    // Create and ingest package
    await writeFile(path.join(pkgDir, "index.js"), "module.exports = {};\n");
    await writeFile(path.join(pkgDir, "lib", "helper.js"), "export const help = true;\n");

    const pkgHex = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    await ingestPackageToFileCas(storeRoot, "sha512", pkgHex, pkgDir);

    // Materialize to destination
    const result = await materializeFromFileCas(storeRoot, "sha512", pkgHex, destDir);

    assert.equal(result.ok, true);
    assert.equal(result.stats.files, 2);
    assert.ok(result.stats.linked >= 0 || result.stats.copied >= 0);

    // Verify files exist with correct content
    const indexContent = await fs.readFile(path.join(destDir, "index.js"), "utf8");
    assert.equal(indexContent, "module.exports = {};\n");

    const helperContent = await fs.readFile(path.join(destDir, "lib", "helper.js"), "utf8");
    assert.equal(helperContent, "export const help = true;\n");
  });

  it("materializeFromFileCas: uses copy strategy when requested", async () => {
    const storeRoot = path.join(tempDir, "cas-store-4");
    const pkgDir = path.join(tempDir, "pkg-4");
    const destDir = path.join(tempDir, "dest-4");

    await writeFile(path.join(pkgDir, "test.js"), "test\n");

    const pkgHex = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    await ingestPackageToFileCas(storeRoot, "sha512", pkgHex, pkgDir);

    const result = await materializeFromFileCas(storeRoot, "sha512", pkgHex, destDir, { linkStrategy: "copy" });

    assert.equal(result.ok, true);
    assert.equal(result.stats.copied, 1);
    assert.equal(result.stats.linked, 0);
  });

  it("materializeFromFileCas: restores symlinks", async () => {
    const storeRoot = path.join(tempDir, "cas-store-5");
    const pkgDir = path.join(tempDir, "pkg-5");
    const destDir = path.join(tempDir, "dest-5");

    await writeFile(path.join(pkgDir, "file.txt"), "content\n");
    await fs.symlink("file.txt", path.join(pkgDir, "link.txt"));

    const pkgHex = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
    await ingestPackageToFileCas(storeRoot, "sha512", pkgHex, pkgDir);

    const result = await materializeFromFileCas(storeRoot, "sha512", pkgHex, destDir);

    assert.equal(result.ok, true);
    assert.equal(result.stats.symlinks, 1);

    // Verify symlink was created
    const linkStat = await fs.lstat(path.join(destDir, "link.txt"));
    assert.ok(linkStat.isSymbolicLink());

    const target = await fs.readlink(path.join(destDir, "link.txt"));
    assert.equal(target, "file.txt");
  });

  it("materializeFromFileCas: returns error when manifest not found", async () => {
    const storeRoot = path.join(tempDir, "cas-store-6");
    const destDir = path.join(tempDir, "dest-6");

    const pkgHex = "nonexistent1111111111111111111111111111111111111111111111111111";
    const result = await materializeFromFileCas(storeRoot, "sha512", pkgHex, destDir);

    assert.equal(result.ok, false);
    assert.equal(result.reason, "manifest_not_found");
  });

  it("hasFileCasManifest: checks manifest existence", async () => {
    const storeRoot = path.join(tempDir, "cas-store-7");
    const pkgDir = path.join(tempDir, "pkg-7");

    await writeFile(path.join(pkgDir, "test.js"), "test\n");

    const pkgHex = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

    // Before ingestion
    const existsBefore = await hasFileCasManifest(storeRoot, "sha512", pkgHex);
    assert.equal(existsBefore, false);

    // After ingestion
    await ingestPackageToFileCas(storeRoot, "sha512", pkgHex, pkgDir);
    const existsAfter = await hasFileCasManifest(storeRoot, "sha512", pkgHex);
    assert.equal(existsAfter, true);
  });

  it("getFileCasStats: returns store statistics", async () => {
    const storeRoot = path.join(tempDir, "cas-store-8");
    const pkg1Dir = path.join(tempDir, "pkg-8a");
    const pkg2Dir = path.join(tempDir, "pkg-8b");

    // Create two packages
    await writeFile(path.join(pkg1Dir, "file1.js"), "content1\n");
    await writeFile(path.join(pkg1Dir, "file2.js"), "content2\n");
    await writeFile(path.join(pkg2Dir, "file3.js"), "content3\n");

    const pkg1Hex = "1111111111111111111111111111111111111111111111111111111111111111";
    const pkg2Hex = "2222222222222222222222222222222222222222222222222222222222222222";

    await ingestPackageToFileCas(storeRoot, "sha512", pkg1Hex, pkg1Dir);
    await ingestPackageToFileCas(storeRoot, "sha512", pkg2Hex, pkg2Dir);

    const stats = await getFileCasStats(storeRoot);

    assert.equal(stats.storeRoot, storeRoot);
    assert.equal(stats.packageManifests, 2);
    assert.equal(stats.uniqueFiles, 3);
    assert.ok(stats.totalFileBytes > 0);
  });

  it("gcFileCas: removes unreferenced files", async () => {
    const storeRoot = path.join(tempDir, "cas-store-9");
    const pkg1Dir = path.join(tempDir, "pkg-9a");
    const pkg2Dir = path.join(tempDir, "pkg-9b");

    // Create two packages with shared and unique files
    await writeFile(path.join(pkg1Dir, "shared.js"), "shared content\n");
    await writeFile(path.join(pkg1Dir, "unique1.js"), "unique to pkg1\n");
    await writeFile(path.join(pkg2Dir, "shared.js"), "shared content\n");
    await writeFile(path.join(pkg2Dir, "unique2.js"), "unique to pkg2\n");

    const pkg1Hex = "aaaa111111111111111111111111111111111111111111111111111111111111";
    const pkg2Hex = "bbbb222222222222222222222222222222222222222222222222222222222222";

    const result1 = await ingestPackageToFileCas(storeRoot, "sha512", pkg1Hex, pkg1Dir);
    const result2 = await ingestPackageToFileCas(storeRoot, "sha512", pkg2Hex, pkg2Dir);

    // Verify shared file was deduplicated
    assert.equal(result1.stats.newFiles, 2);
    assert.equal(result2.stats.newFiles, 1); // Only unique2.js is new
    assert.equal(result2.stats.existingFiles, 1); // shared.js already exists

    const statsBefore = await getFileCasStats(storeRoot);
    assert.equal(statsBefore.uniqueFiles, 3); // shared.js, unique1.js, unique2.js
    assert.equal(statsBefore.packageManifests, 2);

    // Delete pkg1 manifest
    const pkg1ManifestPath = packageManifestPath(storeRoot, "sha512", pkg1Hex);
    await fs.rm(pkg1ManifestPath);

    // Run GC
    const gcResult = await gcFileCas(storeRoot);

    // Should remove unique1.js but keep shared.js (still referenced by pkg2)
    assert.equal(gcResult.removed, 1);
    assert.ok(gcResult.bytesFreed > 0);
    assert.equal(gcResult.referencedCount, 2); // shared.js + unique2.js

    const statsAfter = await getFileCasStats(storeRoot);
    assert.equal(statsAfter.uniqueFiles, 2); // shared.js, unique2.js
  });

  it("gcFileCas: dryRun mode does not delete files", async () => {
    const storeRoot = path.join(tempDir, "cas-store-10");
    const pkgDir = path.join(tempDir, "pkg-10");

    await writeFile(path.join(pkgDir, "test.js"), "test\n");

    const pkgHex = "ffff333333333333333333333333333333333333333333333333333333333333";
    await ingestPackageToFileCas(storeRoot, "sha512", pkgHex, pkgDir);

    const statsBefore = await getFileCasStats(storeRoot);
    assert.equal(statsBefore.uniqueFiles, 1);

    // Delete manifest
    const manifestPath = packageManifestPath(storeRoot, "sha512", pkgHex);
    await fs.rm(manifestPath);

    // Run GC in dry-run mode
    const gcResult = await gcFileCas(storeRoot, { dryRun: true });

    assert.equal(gcResult.dryRun, true);
    assert.equal(gcResult.removed, 1); // Would remove 1 file
    assert.equal(gcResult.referencedCount, 0);

    // Verify file still exists
    const statsAfter = await getFileCasStats(storeRoot);
    assert.equal(statsAfter.uniqueFiles, 1); // File not actually deleted
  });

  it("ingestPackageToFileCas: deduplicates files across packages", async () => {
    const storeRoot = path.join(tempDir, "cas-store-11");
    const pkg1Dir = path.join(tempDir, "pkg-11a");
    const pkg2Dir = path.join(tempDir, "pkg-11b");

    // Create identical file in both packages
    const identicalContent = "identical file content\n";
    await writeFile(path.join(pkg1Dir, "file.js"), identicalContent);
    await writeFile(path.join(pkg2Dir, "file.js"), identicalContent);

    const pkg1Hex = "aaaa444444444444444444444444444444444444444444444444444444444444";
    const pkg2Hex = "bbbb555555555555555555555555555555555555555555555555555555555555";

    const result1 = await ingestPackageToFileCas(storeRoot, "sha512", pkg1Hex, pkg1Dir);
    assert.equal(result1.stats.newFiles, 1);

    const result2 = await ingestPackageToFileCas(storeRoot, "sha512", pkg2Hex, pkg2Dir);
    assert.equal(result2.stats.newFiles, 0); // File already in CAS
    assert.equal(result2.stats.existingFiles, 1);

    // Verify both manifests reference the same hash
    const hash1 = result1.manifest.files["file.js"].hash;
    const hash2 = result2.manifest.files["file.js"].hash;
    assert.equal(hash1, hash2);

    // Verify only one copy in CAS
    const stats = await getFileCasStats(storeRoot);
    assert.equal(stats.uniqueFiles, 1);
    assert.equal(stats.packageManifests, 2);
  });
});
