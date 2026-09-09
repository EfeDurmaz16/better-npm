import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import { lazyPackageCasPath } from "../src/lib/lazyCasPath.js";

test("lazy CAS uses native digest shards and the package directory", () => {
  for (const algorithm of ["sha1", "sha256", "sha384", "sha512"]) {
    const digest = createHash(algorithm).update("fixture").digest();
    const hex = digest.toString("hex");
    assert.equal(lazyPackageCasPath("/cache", `${algorithm}-${digest.toString("base64")}`),
      path.join("/cache/store/unpacked", algorithm, hex.slice(0, 2), hex.slice(2, 4), hex, "package"));
  }
});

test("lazy CAS rejects malformed identities instead of inventing paths", () => {
  for (const integrity of [undefined, "sha1-AAAAAAAAAAAAAAAAAAAAAAAAAAA=\n", "", "sha512-", "sha512-AAAA", "../escape-AAAA", "sha1-AAAAAAAAAAAAAAAAAAAAAAAAAAA", "sha1-AAAAAAAAAAAAAAAAAAAAAAAAAAA=?option"]) {
    assert.throws(() => lazyPackageCasPath("/cache", integrity), /integrity/);
  }
});
