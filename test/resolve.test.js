import { describe, it } from "node:test";
import assert from "node:assert";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveFromLockfile } from "../src/engine/better/resolve.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("resolve", () => {
  it("should parse package-lock.json v3", async () => {
    const lockfilePath = path.join(__dirname, "fixtures", "npm-v3-project", "package-lock.json");
    const result = await resolveFromLockfile(lockfilePath);

    assert.strictEqual(result.ok, true);
    assert.ok(Array.isArray(result.packages));
    assert.ok(result.runtime === "js" || result.runtime === "napi");
    assert.ok(result.lockfileVersion >= 2);

    console.log(`Resolved ${result.packages.length} packages using ${result.runtime} runtime`);

    if (result.packages.length > 0) {
      const pkg = result.packages[0];
      assert.ok(pkg.name);
      assert.ok(pkg.version);
      assert.ok(pkg.relPath);
      assert.ok(pkg.resolvedUrl);
      assert.ok(pkg.integrity);
    }
  });

  it("should handle missing lockfile gracefully", async () => {
    const lockfilePath = path.join(__dirname, "nonexistent-package-lock.json");

    try {
      await resolveFromLockfile(lockfilePath);
      assert.fail("Should have thrown");
    } catch (err) {
      assert.ok(err.message.includes("ENOENT") || err.message.includes("no such file"));
    }
  });
});
