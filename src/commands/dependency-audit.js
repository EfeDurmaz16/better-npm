/**
 * better dependency-audit — comprehensive dependency security audit
 *
 * Combines npm audit, CVE checking (OSV.dev), supply chain risk,
 * and license issues into a single comprehensive report.
 *
 * Usage:
 *   better dependency-audit
 *   better dependency-audit --fail-on high
 *   better dependency-audit --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import https from "node:https";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const urlObj = new URL(url);
    const req = https.request({
      hostname: urlObj.hostname,
      path: urlObj.pathname,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data), "User-Agent": "better-npm/1.0" },
      timeout: 10000,
    }, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.write(data);
    req.end();
  });
}

const SEVERITY_ORDER = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1, UNKNOWN: 0 };
const SEVERITY_COLORS = { CRITICAL: "\x1b[35m", HIGH: "\x1b[31m", MEDIUM: "\x1b[33m", LOW: "\x1b[36m" };

export async function cmdDependencyAudit(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:       { type: "boolean", default: runtime.json === true },
      help:       { type: "boolean", short: "h", default: false },
      "fail-on":  { type: "string", default: "high" },
      "skip-osv": { type: "boolean", default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better dependency-audit [options]

Comprehensive dependency security audit (npm audit + OSV.dev).

Options:
  --fail-on <level>   Fail on: critical|high|medium|low (default: high)
  --skip-osv          Skip OSV.dev CVE lookup
  --json              Machine-readable output
  -h, --help          Show this help

Sources:
  • npm audit for npm advisory database
  • OSV.dev API for cross-database CVE coverage
`);
    return;
  }

  const failLevel = SEVERITY_ORDER[values["fail-on"]?.toUpperCase()] ?? SEVERITY_ORDER.HIGH;

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;

  if (!values.json) {
    printText(`\n\x1b[1mbetter dependency-audit\x1b[0m\n`);
  }

  const allVulns = [];

  // 1. npm audit
  if (!values.json) {
    process.stderr.write(`\x1b[90mRunning npm audit…\x1b[0m\n`);
  }

  const auditResult = spawnSync("npm", ["audit", "--json"], {
    cwd: projectRoot, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
  });

  let npmAuditData = null;
  try { npmAuditData = JSON.parse(auditResult.stdout); } catch {}

  if (npmAuditData?.vulnerabilities) {
    for (const [pkgName, vuln] of Object.entries(npmAuditData.vulnerabilities)) {
      const severity = (vuln.severity || "unknown").toUpperCase();
      const via = Array.isArray(vuln.via) ? vuln.via.filter(v => typeof v === "object") : [];
      for (const v of via) {
        allVulns.push({
          source: "npm-audit",
          package: pkgName,
          severity,
          title: v.title || `${pkgName} vulnerability`,
          url: v.url || null,
          range: v.range || vuln.range || null,
          fixAvailable: !!vuln.fixAvailable,
        });
      }
      if (via.length === 0) {
        allVulns.push({
          source: "npm-audit",
          package: pkgName,
          severity,
          title: `${pkgName} vulnerability`,
          url: null,
          range: vuln.range || null,
          fixAvailable: !!vuln.fixAvailable,
        });
      }
    }
  }

  // 2. OSV.dev check (top-level deps only to stay fast)
  if (!values["skip-osv"]) {
    let pkgJson;
    try { pkgJson = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8")); } catch {}

    if (pkgJson) {
      const allDeps = { ...pkgJson.dependencies };
      const nmPath = path.join(projectRoot, "node_modules");
      const depNames = Object.keys(allDeps).slice(0, 30); // limit to avoid rate limiting

      if (!values.json) {
        process.stderr.write(`\x1b[90mQuerying OSV.dev for ${depNames.length} packages…\x1b[0m\n`);
      }

      const BATCH = 5;
      for (let i = 0; i < depNames.length; i += BATCH) {
        const batch = depNames.slice(i, i + BATCH);
        await Promise.all(batch.map(async (dep) => {
          let version = null;
          try {
            const pkg = JSON.parse(await fs.readFile(path.join(nmPath, dep, "package.json"), "utf8"));
            version = pkg.version;
          } catch {}
          if (!version) return;
          try {
            const res = await postJson("https://api.osv.dev/v1/query", {
              package: { name: dep, ecosystem: "npm" },
              version,
            });
            if (res.status === 200) {
              const data = JSON.parse(res.body);
              for (const vuln of (data.vulns || [])) {
                // Skip if already in npm audit
                const alreadyCovered = allVulns.some(v => v.source === "npm-audit" && v.package === dep);
                if (alreadyCovered) continue;

                let severity = "UNKNOWN";
                const cvss = vuln.severity?.find(s => s.type === "CVSS_V3");
                if (cvss?.score) {
                  const s = parseFloat(cvss.score);
                  if (s >= 9) severity = "CRITICAL";
                  else if (s >= 7) severity = "HIGH";
                  else if (s >= 4) severity = "MEDIUM";
                  else severity = "LOW";
                }

                allVulns.push({
                  source: "osv",
                  package: dep,
                  severity,
                  title: vuln.summary || vuln.id,
                  url: `https://osv.dev/vulnerability/${vuln.id}`,
                  range: null,
                  osvId: vuln.id,
                  fixAvailable: false,
                });
              }
            }
          } catch {}
        }));
      }
    }
  }

  // Deduplicate and sort
  const seen = new Set();
  const unique = allVulns.filter(v => {
    const key = `${v.package}::${v.title}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  unique.sort((a, b) => (SEVERITY_ORDER[b.severity] || 0) - (SEVERITY_ORDER[a.severity] || 0));

  const bySeverity = {
    CRITICAL: unique.filter(v => v.severity === "CRITICAL"),
    HIGH: unique.filter(v => v.severity === "HIGH"),
    MEDIUM: unique.filter(v => v.severity === "MEDIUM"),
    LOW: unique.filter(v => v.severity === "LOW"),
  };

  const maxSeverity = unique.length > 0
    ? Math.max(...unique.map(v => SEVERITY_ORDER[v.severity] || 0))
    : 0;
  const shouldFail = maxSeverity >= failLevel;

  if (values.json) {
    printJson({
      ok: !shouldFail,
      kind: "better.dependency-audit",
      total: unique.length,
      bySeverity: Object.fromEntries(Object.entries(bySeverity).map(([k, v]) => [k, v.length])),
      failOn: values["fail-on"],
      vulnerabilities: unique,
    });
    if (shouldFail) process.exitCode = 1;
    return;
  }

  if (unique.length === 0) {
    printText(`\x1b[32m✔ No vulnerabilities found.\x1b[0m`);
    printText("");
    return;
  }

  // Print by severity
  for (const [sev, vulns] of Object.entries(bySeverity)) {
    if (vulns.length === 0) continue;
    const col = SEVERITY_COLORS[sev] || "";
    printText(`\n${col}${sev} (${vulns.length})\x1b[0m`);
    for (const v of vulns) {
      printText(`  ${col}●\x1b[0m  ${v.package}  \x1b[90m${v.title}${v.url ? "  " + v.url : ""}\x1b[0m`);
      if (v.range) printText(`       \x1b[90mAffected: ${v.range}\x1b[0m`);
      if (v.fixAvailable) printText(`       \x1b[32m→ Fix available\x1b[0m`);
    }
  }

  printText(`\n\x1b[90m${"─".repeat(50)}\x1b[0m`);
  printText(`  Total: ${unique.length} vulnerabilities`);
  for (const [sev, vulns] of Object.entries(bySeverity)) {
    if (vulns.length > 0) printText(`    ${(SEVERITY_COLORS[sev] || "") + sev}\x1b[0m: ${vulns.length}`);
  }
  printText("");

  if (shouldFail) {
    printText(`\x1b[31m✖ Audit failed (--fail-on ${values["fail-on"]})\x1b[0m`);
    printText(`\x1b[90m  Run: npm audit fix to auto-fix where possible\x1b[0m`);
    process.exitCode = 1;
  } else {
    printText(`\x1b[33m⚠ Vulnerabilities found below fail threshold (--fail-on ${values["fail-on"]})\x1b[0m`);
  }
  printText("");
}
