import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { makeTempDir, rmrf, writeJson } from "./helpers.js";
import { analyzeProject } from "../src/analyze/analyzeProject.js";

test("analyzeProject detects packages behind symlinks (pnpm-style)", async (t) => {
  const dir = await makeTempDir();
  try {
    const store = path.join(dir, ".store", "foo");
    await writeJson(path.join(store, "package.json"), { name: "foo", version: "1.0.0" });
    await fs.mkdir(path.join(dir, "node_modules"), { recursive: true });
    try {
      await fs.symlink(store, path.join(dir, "node_modules", "foo"), "dir");
    } catch (err) {
      // Symlink creation may be restricted on some platforms; skip.
      t.skip(`symlinks not available: ${err?.code ?? err}`);
      return;
    }

    const analysis = await analyzeProject(dir, { includeGraph: false });
    assert.equal(analysis.ok, true);
    assert.ok(analysis.packages.some((p) => p.key === "foo@1.0.0"));
  } finally {
    await rmrf(dir);
  }
});

test("analyzeProject detects duplicate versions/majors", async () => {
  const dir = await makeTempDir();
  try {
    await fs.mkdir(path.join(dir, "node_modules", "dup"), { recursive: true });
    await writeJson(path.join(dir, "node_modules", "dup", "package.json"), { name: "dup", version: "2.0.0" });

    await fs.mkdir(path.join(dir, "node_modules", "app", "node_modules", "dup"), { recursive: true });
    await writeJson(path.join(dir, "node_modules", "app", "package.json"), { name: "app", version: "1.0.0" });
    await writeJson(path.join(dir, "node_modules", "app", "node_modules", "dup", "package.json"), { name: "dup", version: "1.0.0" });

    const analysis = await analyzeProject(dir, { includeGraph: false });
    assert.equal(analysis.ok, true);
    const dup = analysis.duplicates.find((d) => d.name === "dup");
    assert.ok(dup);
    assert.deepEqual(dup.versions.sort(), ["1.0.0", "2.0.0"]);
    assert.ok(dup.majors.includes("1") && dup.majors.includes("2"));
  } finally {
    await rmrf(dir);
  }
});
