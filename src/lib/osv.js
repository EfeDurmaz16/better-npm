import https from "node:https";

/**
 * OSV.dev API client for querying known vulnerabilities.
 * Zero dependencies — uses only node:https.
 *
 * API docs: https://osv.dev/docs/
 */

const OSV_API_BASE = "https://api.osv.dev/v1";
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_BATCH_SIZE = 1000;

/**
 * Make an HTTPS POST request and return parsed JSON.
 */
function httpsPost(url, body, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const payload = JSON.stringify(body);

    const req = https.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: parsed.pathname + parsed.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          "User-Agent": "better-npm/0.1.0"
        },
        timeout: timeoutMs
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          try {
            resolve({ status: res.statusCode, data: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode, data: null, raw });
          }
        });
      }
    );

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`Request to ${url} timed out after ${timeoutMs}ms`));
    });

    req.write(payload);
    req.end();
  });
}

/**
 * Make an HTTPS GET request and return parsed JSON.
 */
function httpsGet(url, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);

    const req = https.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: parsed.pathname + parsed.search,
        method: "GET",
        headers: {
          "User-Agent": "better-npm/0.1.0"
        },
        timeout: timeoutMs
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          try {
            resolve({ status: res.statusCode, data: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode, data: null, raw });
          }
        });
      }
    );

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`Request to ${url} timed out after ${timeoutMs}ms`));
    });

    req.end();
  });
}

/**
 * Query OSV for vulnerabilities affecting a specific npm package version.
 *
 * @param {string} name - Package name (e.g., "lodash")
 * @param {string} version - Exact version (e.g., "4.17.20")
 * @returns {Promise<{vulns: Object[], ok: boolean}>}
 */
export async function queryPackage(name, version) {
  try {
    const result = await httpsPost(`${OSV_API_BASE}/query`, {
      package: {
        name,
        version,
        ecosystem: "npm"
      }
    });

    if (result.status !== 200) {
      return { ok: false, vulns: [], reason: `osv_api_error_${result.status}` };
    }

    const vulns = result.data?.vulns ?? [];
    return { ok: true, vulns };
  } catch (err) {
    return { ok: false, vulns: [], reason: err?.message ?? "osv_query_failed" };
  }
}

/**
 * Batch query OSV for multiple packages at once.
 * Uses the /v1/querybatch endpoint for efficiency.
 *
 * @param {Array<{name: string, version: string}>} packages
 * @returns {Promise<{results: Array<{name: string, version: string, vulns: Object[]}>, ok: boolean}>}
 */
export async function queryBatch(packages) {
  if (packages.length === 0) {
    return { ok: true, results: [] };
  }

  const results = [];

  // Process in chunks of MAX_BATCH_SIZE
  for (let i = 0; i < packages.length; i += MAX_BATCH_SIZE) {
    const chunk = packages.slice(i, i + MAX_BATCH_SIZE);
    const queries = chunk.map((pkg) => ({
      package: {
        name: pkg.name,
        version: pkg.version,
        ecosystem: "npm"
      }
    }));

    try {
      const result = await httpsPost(`${OSV_API_BASE}/querybatch`, { queries });

      if (result.status !== 200) {
        return {
          ok: false,
          results,
          reason: `osv_batch_error_${result.status}`
        };
      }

      const batchResults = result.data?.results ?? [];
      for (let j = 0; j < chunk.length; j++) {
        results.push({
          name: chunk[j].name,
          version: chunk[j].version,
          vulns: batchResults[j]?.vulns ?? []
        });
      }
    } catch (err) {
      return { ok: false, results, reason: err?.message ?? "osv_batch_failed" };
    }
  }

  return { ok: true, results };
}

/**
 * Get detailed vulnerability information by ID.
 *
 * @param {string} vulnId - e.g., "GHSA-xxxx-yyyy-zzzz"
 * @returns {Promise<{ok: boolean, vuln: Object|null}>}
 */
export async function getVulnerability(vulnId) {
  try {
    const result = await httpsGet(`${OSV_API_BASE}/vulns/${encodeURIComponent(vulnId)}`);

    if (result.status !== 200) {
      return { ok: false, vuln: null, reason: `osv_vuln_error_${result.status}` };
    }

    return { ok: true, vuln: result.data };
  } catch (err) {
    return { ok: false, vuln: null, reason: err?.message ?? "osv_vuln_fetch_failed" };
  }
}

/**
 * Parse OSV vulnerability severity.
 * Returns a normalized severity level.
 *
 * @param {Object} vuln - OSV vulnerability object
 * @returns {"critical"|"high"|"medium"|"low"|"unknown"}
 */
export function parseSeverity(vuln) {
  // Check database_specific severity first
  const dbSeverity = vuln?.database_specific?.severity;
  if (dbSeverity) {
    const lower = String(dbSeverity).toLowerCase();
    if (lower === "critical") return "critical";
    if (lower === "high") return "high";
    if (lower === "moderate" || lower === "medium") return "medium";
    if (lower === "low") return "low";
  }

  // Check CVSS scores in severity array
  const severities = vuln?.severity ?? [];
  for (const s of severities) {
    if (s.type === "CVSS_V3" && s.score) {
      const cvss = parseCvssScore(s.score);
      if (cvss !== null) {
        if (cvss >= 9.0) return "critical";
        if (cvss >= 7.0) return "high";
        if (cvss >= 4.0) return "medium";
        return "low";
      }
    }
  }

  return "unknown";
}

/**
 * Extract numeric CVSS score from a CVSS v3 vector string.
 */
function parseCvssScore(cvssString) {
  // CVSS vector might be just a number or a full vector string
  const num = Number.parseFloat(cvssString);
  if (Number.isFinite(num)) return num;

  // Try to extract score from vector (some formats include it)
  const match = String(cvssString).match(/(\d+\.\d+)/);
  if (match) return Number.parseFloat(match[1]);

  return null;
}

/**
 * Extract affected version ranges from an OSV vulnerability for npm.
 *
 * @param {Object} vuln - OSV vulnerability object
 * @param {string} packageName - Package name to filter affected entries
 * @returns {Array<{introduced: string|null, fixed: string|null}>}
 */
export function extractAffectedRanges(vuln, packageName) {
  const ranges = [];
  const affected = vuln?.affected ?? [];

  for (const entry of affected) {
    if (entry?.package?.ecosystem !== "npm") continue;
    if (entry?.package?.name !== packageName) continue;

    for (const range of (entry.ranges ?? [])) {
      if (range.type !== "ECOSYSTEM" && range.type !== "SEMVER") continue;
      let introduced = null;
      let fixed = null;
      for (const event of (range.events ?? [])) {
        if (event.introduced) introduced = event.introduced;
        if (event.fixed) fixed = event.fixed;
      }
      ranges.push({ introduced, fixed });
    }
  }

  return ranges;
}

/**
 * Summarize a vulnerability for display.
 */
export function summarizeVuln(vuln) {
  const id = vuln.id ?? "unknown";
  const aliases = vuln.aliases ?? [];
  const summary = vuln.summary ?? vuln.details?.slice(0, 120) ?? "No description";
  const severity = parseSeverity(vuln);
  const published = vuln.published ?? null;
  const modified = vuln.modified ?? null;
  const references = (vuln.references ?? []).map((r) => r.url).filter(Boolean);

  return {
    id,
    aliases,
    summary,
    severity,
    published,
    modified,
    references: references.slice(0, 3)
  };
}
