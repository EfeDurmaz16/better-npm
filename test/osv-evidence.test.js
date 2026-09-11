import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { canonicalOsvBatch, createOsvEvidenceService } from "../src/lib/osvEvidence.js";

const digest = (value) => createHash("sha256").update(value).digest("hex");
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "better-osv-evidence-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}
const responseFor = (body) => ({ status: 200, data: { results: body.queries.map((query) => ({
  vulns: [{ id: `${query.package.name}@${query.version}`, aliases: ["CVE-fixture"] }]
})) } });

test("canonical OSV identity matches native key and puts version at top level", () => {
  const { body, key } = canonicalOsvBatch([{ name: "z", version: "2" }, { name: "@scope/a", version: "1" }]);
  assert.equal(body, '{"queries":[{"package":{"ecosystem":"npm","name":"@scope/a"},"version":"1"},{"package":{"ecosystem":"npm","name":"z"},"version":"2"}]}');
  assert.equal(key, `osv-querybatch-v2\nhttps://api.osv.dev/v1/querybatch\n${body}`);
  const long = "a".repeat(250);
  assert.notEqual(canonicalOsvBatch([{ name: long, version: "1" }]).key, canonicalOsvBatch([{ name: long, version: "2" }]).key);
});

test("same canonical queries singleflight and rows map by exact identity", async (t) => {
  const cacheDirectory = await fixture(t);
  let requests = 0;
  const service = createOsvEvidenceService({ cacheDirectory, post: async (_url, body) => {
    requests++;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return responseFor(body);
  } });
  const packages = [{ name: "b", version: "2" }, { name: "a", version: "1" }];
  const [first, second] = await Promise.all([service.batch(packages), service.batch([...packages].reverse())]);
  assert.equal(requests, 1);
  assert.equal(first[0].vulns[0].id, "b@2");
  assert.equal(second[0].vulns[0].id, "a@1");
  assert.deepEqual(first[0].vulns[0].aliases, ["CVE-fixture"]);
  first[0].vulns[0].aliases.push("mutated");
  const duplicate = await service.batch([packages[1], packages[0], packages[1]]);
  assert.equal(requests, 1);
  assert.deepEqual(duplicate.map((row) => row.vulns[0].id), ["a@1", "b@2", "a@1"]);
  assert.deepEqual(duplicate[1].vulns[0].aliases, ["CVE-fixture"]);
});

test("native version2 raw envelope is reusable by JS without network", async (t) => {
  const cacheDirectory = await fixture(t);
  const packages = [{ name: "a", version: "1" }];
  const { key } = canonicalOsvBatch(packages);
  const response = '{"results":[{"vulns":[{"id":"native-fixture","aliases":["CVE-fixture"]}]}]}';
  const now = Math.floor(Date.now() / 1000);
  await fs.writeFile(path.join(cacheDirectory, `${digest(key)}.json`), JSON.stringify({
    schema: 2, request_digest: digest(key), fetched_at: now, expires_at: now + 86400,
    response_digest: digest(response), response
  }));
  const service = createOsvEvidenceService({ cacheDirectory, post: async () => { throw new Error("unexpected network"); } });
  assert.equal((await service.batch(packages))[0].vulns[0].id, "native-fixture");
});

test("expired, future, corrupt and wrong-key envelopes refresh", async (t) => {
  const cacheDirectory = await fixture(t);
  const packages = [{ name: "a", version: "1" }];
  let requests = 0;
  const service = createOsvEvidenceService({ cacheDirectory, post: async (_url, body) => { requests++; return responseFor(body); } });
  await service.batch(packages);
  const { key } = canonicalOsvBatch(packages);
  const entryPath = path.join(cacheDirectory, `${digest(key)}.json`);
  for (const change of [
    (entry) => { entry.expires_at = 0; },
    (entry) => { entry.fetched_at += 99999; },
    (entry) => { entry.response = '{"results":[{}]}'; },
    (entry) => { entry.request_digest = digest("other"); },
    (entry) => { entry.schema = 1; }
  ]) {
    const entry = JSON.parse(await fs.readFile(entryPath, "utf8"));
    change(entry);
    await fs.writeFile(entryPath, JSON.stringify(entry));
    assert.equal((await service.batch(packages))[0].vulns[0].id, "a@1");
  }
  assert.equal(requests, 6);
});

test("HTTP failures, malformed rows and pagination are never cached as clean", async (t) => {
  const cacheDirectory = await fixture(t);
  for (const response of [
    { status: 429, data: {} }, { status: 500, data: {} },
    { status: 200, data: {} }, { status: 200, data: { results: [] } },
    { status: 200, data: { results: [{ vulns: "bad" }] } },
    { status: 200, data: { results: [{ vulns: [{ severity: "HIGH" }] }] } },
    { status: 200, data: { results: [{ next_page_token: "more" }] } }
  ]) {
    let requests = 0;
    const service = createOsvEvidenceService({ cacheDirectory, post: async () => { requests++; return response; } });
    await assert.rejects(service.batch([{ name: "a", version: "1" }]));
    await assert.rejects(service.batch([{ name: "a", version: "1" }]));
    assert.equal(requests, 2);
  }
  assert.deepEqual(await fs.readdir(cacheDirectory), []);
});

test("independent publishers only leave complete compatible envelopes", async (t) => {
  const cacheDirectory = await fixture(t);
  const packages = [{ name: "a", version: "1" }];
  const services = Array.from({ length: 8 }, () => createOsvEvidenceService({ cacheDirectory, post: async (_url, body) => responseFor(body) }));
  await Promise.all(services.map((service) => service.batch(packages)));
  const files = await fs.readdir(cacheDirectory);
  assert.equal(files.length, 1);
  const entry = JSON.parse(await fs.readFile(path.join(cacheDirectory, files[0]), "utf8"));
  assert.equal(entry.response_digest, digest(entry.response));
  assert.equal(entry.schema, 2);
});

test("single-package cache preserves complete details and exact version", async (t) => {
  const cacheDirectory = await fixture(t);
  let requests = 0;
  const service = createOsvEvidenceService({ cacheDirectory, post: async (url, body) => {
    requests++;
    assert.equal(url, "https://api.osv.dev/v1/query");
    assert.equal(body.version, "1.2.3");
    assert.equal(body.package.version, undefined);
    return { status: 200, data: { vulns: [{ id: "fixture", summary: "Full details", aliases: ["CVE-fixture"] }] } };
  } });
  assert.equal((await service.single("@scope/a", "1.2.3"))[0].summary, "Full details");
  assert.deepEqual((await service.single("@scope/a", "1.2.3"))[0].aliases, ["CVE-fixture"]);
  assert.equal(requests, 1);
});
