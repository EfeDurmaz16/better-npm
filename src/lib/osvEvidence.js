import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const TTL_SECONDS = 86_400;
const MAX_ENTRY_BYTES = 32 * 1024 * 1024;
export const OSV_QUERY_BATCH_URL = "https://api.osv.dev/v1/querybatch";
const digest = (text) => createHash("sha256").update(text).digest("hex");

export class OsvEvidenceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "OsvEvidenceError";
    this.code = code;
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateOsvRows(data, count) {
  if (!isObject(data) || !Array.isArray(data.results) || data.results.length !== count) {
    throw new OsvEvidenceError("osv_invalid_response", "OSV response count does not match exact queries");
  }
  for (const row of data.results) {
    if (!isObject(row) || (row.vulns != null && (!Array.isArray(row.vulns) || row.vulns.some((v) =>
      !isObject(v) || (v.id != null && typeof v.id !== "string") ||
      (v.summary != null && typeof v.summary !== "string") ||
      (v.details != null && typeof v.details !== "string") ||
      (v.severity != null && (!Array.isArray(v.severity) || v.severity.some((severity) =>
        !isObject(severity) || (severity.type != null && typeof severity.type !== "string") ||
        (severity.score != null && typeof severity.score !== "string")))) ||
      (v.affected != null && !Array.isArray(v.affected))
    )))) {
      throw new OsvEvidenceError("osv_invalid_response", "Malformed OSV vulnerability evidence");
    }
    if (row.next_page_token != null && row.next_page_token !== "") {
      throw new OsvEvidenceError("osv_incomplete_response", "OSV returned paginated evidence; complete results are required");
    }
  }
  return data.results;
}

function compareUtf8(a, b) {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

export function canonicalOsvBatch(packages) {
  for (const pkg of packages) {
    if (!isObject(pkg) || typeof pkg.name !== "string" || !pkg.name || typeof pkg.version !== "string" || !pkg.version) {
      throw new OsvEvidenceError("osv_invalid_query", "OSV requires exact package name and version strings");
    }
  }
  const identities = new Map(packages.map(({ name, version }) => [JSON.stringify([name, version]), { name, version }]));
  const canonical = [...identities.values()].sort((a, b) => compareUtf8(a.name, b.name) || compareUtf8(a.version, b.version));
  // Matches Rust serde_json's lexicographic object-key serialization exactly.
  const body = JSON.stringify({ queries: canonical.map(({ name, version }) => ({ package: { ecosystem: "npm", name }, version })) });
  return { canonical, body, key: `osv-querybatch-v2\n${OSV_QUERY_BATCH_URL}\n${body}` };
}

async function readEnvelope(directory, key) {
  let file;
  try {
    file = await fs.open(path.join(directory, `${digest(key)}.json`), "r");
    const chunks = [];
    let total = 0;
    while (true) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_ENTRY_BYTES + 1 - total));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > MAX_ENTRY_BYTES) return null;
      chunks.push(buffer.subarray(0, bytesRead));
    }
    const entry = JSON.parse(Buffer.concat(chunks, total).toString("utf8"));
    const now = Math.floor(Date.now() / 1000);
    if (entry.schema !== 2 || entry.request_digest !== digest(key) ||
      !Number.isSafeInteger(entry.fetched_at) || !Number.isSafeInteger(entry.expires_at) ||
      entry.fetched_at < 0 || entry.fetched_at > now || entry.expires_at <= now ||
      entry.expires_at < entry.fetched_at || entry.expires_at - entry.fetched_at > TTL_SECONDS ||
      typeof entry.response !== "string" || entry.response_digest !== digest(entry.response)) return null;
    return JSON.parse(entry.response);
  } catch {
    return null;
  } finally {
    await file?.close().catch(() => {});
  }
}

async function writeEnvelope(directory, key, data) {
  const response = JSON.stringify(data);
  const now = Math.floor(Date.now() / 1000);
  const bytes = JSON.stringify({ schema: 2, request_digest: digest(key), fetched_at: now,
    expires_at: now + TTL_SECONDS, response_digest: digest(response), response });
  if (Buffer.byteLength(bytes) > MAX_ENTRY_BYTES) return;
  const temporary = path.join(directory, `.${digest(key)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    await fs.rename(temporary, path.join(directory, `${digest(key)}.json`));
  } catch {
    // Cache persistence never turns unavailable evidence into a successful scan.
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
}

/** Raw OSV evidence shared with native readers. No scoring or waiver decisions. */
export function createOsvEvidenceService({ post, cacheDirectory = () => path.join(process.env.HOME || os.homedir(), ".better", "osv-cache") }) {
  const inFlight = new Map();
  async function batch(packages) {
    const requested = packages.map((pkg) => ({ name: pkg.name, version: pkg.version }));
    const { canonical, body, key } = canonicalOsvBatch(requested);
    const directory = typeof cacheDirectory === "function" ? cacheDirectory() : cacheDirectory;
    const flightKey = JSON.stringify([directory, key]);
    let pending = inFlight.get(flightKey);
    if (!pending) {
      pending = (async () => {
        const cached = await readEnvelope(directory, key);
        if (cached !== null) {
          try { return validateOsvRows(cached, canonical.length); } catch { /* refresh invalid evidence */ }
        }
        const result = await post(OSV_QUERY_BATCH_URL, JSON.parse(body));
        if (result.status !== 200) {
          throw new OsvEvidenceError("osv_http_error", `osv_batch_error_${result.status}`);
        }
        const rows = validateOsvRows(result.data, canonical.length);
        await writeEnvelope(directory, key, result.data);
        return rows;
      })();
      inFlight.set(flightKey, pending);
    }
    try {
      const rows = await pending;
      const byIdentity = new Map(canonical.map(({ name, version }, index) => [JSON.stringify([name, version]), rows[index]]));
      return requested.map(({ name, version }) => ({ name, version,
        vulns: structuredClone(byIdentity.get(JSON.stringify([name, version])).vulns ?? []) }));
    } finally {
      if (inFlight.get(flightKey) === pending) inFlight.delete(flightKey);
    }
  }
  async function single(name, version) {
    canonicalOsvBatch([{ name, version }]);
    const body = { package: { ecosystem: "npm", name }, version };
    const url = "https://api.osv.dev/v1/query";
    const key = `osv-query-v2\n${url}\n${JSON.stringify(body)}`;
    const directory = typeof cacheDirectory === "function" ? cacheDirectory() : cacheDirectory;
    const flightKey = JSON.stringify([directory, key]);
    let pending = inFlight.get(flightKey);
    if (!pending) {
      pending = (async () => {
        const cached = await readEnvelope(directory, key);
        if (cached !== null) {
          try { return validateOsvRows({ results: [cached] }, 1)[0]; } catch { /* refresh invalid evidence */ }
        }
        const result = await post(url, body);
        if (result.status !== 200) throw new OsvEvidenceError("osv_http_error", `osv_api_error_${result.status}`);
        const row = validateOsvRows({ results: [result.data] }, 1)[0];
        await writeEnvelope(directory, key, result.data);
        return row;
      })();
      inFlight.set(flightKey, pending);
    }
    try {
      return structuredClone((await pending).vulns ?? []);
    } finally {
      if (inFlight.get(flightKey) === pending) inFlight.delete(flightKey);
    }
  }
  return { batch, single };
}
