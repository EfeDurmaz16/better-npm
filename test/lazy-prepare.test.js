import test from "node:test";
import assert from "node:assert/strict";
import { prepareLazyInstall } from "../src/lib/lazyPrepare.js";

for (const result of [undefined, {}, { ok: false, reason: "malformed lockfile", packages: [] }, { ok: true }]) {
  test(`lazy resolve fails closed for ${JSON.stringify(result)}`, async () => {
    let fetched = false;
    await assert.rejects(prepareLazyInstall({
      resolve: () => result,
      fetchAndExtract: () => { fetched = true; }
    }, "lock", "cache"), /Lazy resolution failed/);
    assert.equal(fetched, false);
  });
}

for (const result of [undefined, {}, { ok: false, reason: "integrity mismatch" }]) {
  test(`lazy fetch fails closed for ${JSON.stringify(result)}`, async () => {
    await assert.rejects(prepareLazyInstall({
      resolve: () => ({ ok: true, packages: [] }),
      fetchAndExtract: () => result
    }, "lock", "cache"), /Lazy fetch failed/);
  });
}

for (const phase of ["resolve", "fetchAndExtract"]) {
  test(`lazy propagates thrown ${phase} failure`, async () => {
    const error = new Error("native failure");
    const addon = {
      resolve: () => ({ ok: true, packages: [] }),
      fetchAndExtract: () => ({ ok: true, packagesFetched: 0 })
    };
    addon[phase] = () => { throw error; };
    await assert.rejects(prepareLazyInstall(addon, "lock", "cache"), e => e === error);
  });
}

test("lazy reports success only after both native phases complete", async () => {
  const calls = [];
  const packages = [{ name: "fixture", version: "1.0.0" }];
  const result = await prepareLazyInstall({
    resolve: lock => { calls.push(["resolve", lock]); return { ok: true, packages }; },
    fetchAndExtract: (lock, cache) => {
      calls.push(["fetch", lock, cache]);
      return { ok: true, packagesFetched: 1 };
    }
  }, "lock", "cache");
  assert.deepEqual(calls, [["resolve", "lock"], ["fetch", "lock", "cache"]]);
  assert.deepEqual(result, { packages, fetchedCount: 1 });
});
