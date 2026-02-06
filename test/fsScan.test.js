import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { makeTempDir, rmrf, writeFile } from "./helpers.js";
import { scanTree } from "../src/lib/fsScan.js";

test("scanTree deduplicates hardlinks for physical bytes (best-effort)", async () => {
  const dir = await makeTempDir();
  try {
    const a = path.join(dir, "a.txt");
    const b = path.join(dir, "b.txt");
    await writeFile(a, "hello world");
    await fs.link(a, b); // hardlink
    const st = await fs.stat(a);
    const singlePhysical = typeof st.blocks === "number" && st.blocks > 0 ? st.blocks * 512 : st.size;
    const res = await scanTree(dir);
    assert.equal(res.ok, true);
    assert.equal(res.logicalBytes, st.size * 2);
    assert.equal(res.physicalBytes, singlePhysical);
  } finally {
    await rmrf(dir);
  }
});
