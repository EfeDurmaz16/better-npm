/**
 * better audit-html — generate an HTML security audit report
 *
 * Runs npm audit and generates a standalone HTML report
 * with color-coded severity tables and package details.
 *
 * Usage:
 *   better audit-html
 *   better audit-html --output report.html
 *   better audit-html --open
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

const SEVERITY_COLOR = {
  critical: "#d73a49",
  high:     "#e36209",
  moderate: "#b08800",
  low:      "#6a737d",
  info:     "#0366d6",
};

const SEVERITY_BG = {
  critical: "#ffeef0",
  high:     "#fff8f0",
  moderate: "#fffbdd",
  low:      "#f6f8fa",
  info:     "#f1f8ff",
};

function escHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildHtml(auditData, generatedAt) {
  const vulns = auditData?.vulnerabilities || {};
  const meta = auditData?.metadata || {};
  const vulnCounts = meta.vulnerabilities || {};

  const total = Object.values(vulnCounts).reduce((s, n) => s + (n || 0), 0);

  const entries = Object.values(vulns);
  entries.sort((a, b) => {
    const order = ["critical", "high", "moderate", "low", "info"];
    return order.indexOf(a.severity) - order.indexOf(b.severity);
  });

  const rows = entries.map(v => {
    const color = SEVERITY_COLOR[v.severity] || "#6a737d";
    const bg = SEVERITY_BG[v.severity] || "#f6f8fa";
    const via = (v.via || []).map(x => typeof x === "string" ? x : x.title || x.name || "?").join(", ");
    const fixAvail = v.fixAvailable
      ? (typeof v.fixAvailable === "object"
          ? `Fix: npm install ${escHtml(v.fixAvailable.name)}@${escHtml(v.fixAvailable.version)}`
          : "Fix available")
      : "No fix";

    return `
      <tr style="background:${bg}">
        <td><span style="background:${color};color:#fff;padding:2px 8px;border-radius:12px;font-size:12px;font-weight:600">${escHtml(v.severity)}</span></td>
        <td><strong>${escHtml(v.name)}</strong></td>
        <td>${escHtml(v.range || "")}</td>
        <td style="max-width:300px">${escHtml(via)}</td>
        <td style="color:${v.fixAvailable ? "#28a745" : "#d73a49"}">${fixAvail}</td>
      </tr>`;
  }).join("\n");

  const summaryBadges = ["critical", "high", "moderate", "low"]
    .filter(s => vulnCounts[s] > 0)
    .map(s => `<span style="background:${SEVERITY_COLOR[s]};color:#fff;padding:4px 12px;border-radius:20px;font-weight:600;margin-right:8px">${vulnCounts[s]} ${s}</span>`)
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>npm Audit Report — ${escHtml(generatedAt)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f6f8fa; color: #24292e; line-height: 1.5; }
  .container { max-width: 1100px; margin: 0 auto; padding: 32px 24px; }
  h1 { font-size: 24px; font-weight: 700; margin-bottom: 4px; }
  .subtitle { color: #6a737d; margin-bottom: 24px; }
  .summary { background: #fff; border: 1px solid #e1e4e8; border-radius: 8px; padding: 20px 24px; margin-bottom: 24px; }
  .summary h2 { font-size: 16px; margin-bottom: 12px; color: #6a737d; text-transform: uppercase; letter-spacing: .5px; }
  .clean { color: #28a745; font-size: 18px; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #e1e4e8; border-radius: 8px; overflow: hidden; }
  th { background: #f6f8fa; text-align: left; padding: 10px 14px; font-size: 12px; text-transform: uppercase; letter-spacing: .5px; color: #6a737d; border-bottom: 1px solid #e1e4e8; }
  td { padding: 10px 14px; border-bottom: 1px solid #e1e4e8; font-size: 14px; vertical-align: top; }
  tr:last-child td { border-bottom: none; }
  .footer { margin-top: 24px; color: #6a737d; font-size: 12px; }
</style>
</head>
<body>
<div class="container">
  <h1>npm Audit Report</h1>
  <div class="subtitle">Generated: ${escHtml(generatedAt)}</div>

  <div class="summary">
    <h2>Summary</h2>
    ${total === 0
      ? `<div class="clean">✔ No vulnerabilities found</div>`
      : `<div>${summaryBadges}</div><div style="margin-top:10px;color:#6a737d">${total} total vulnerabilit${total === 1 ? "y" : "ies"} found</div>`
    }
  </div>

  ${entries.length > 0 ? `
  <table>
    <thead>
      <tr>
        <th>Severity</th>
        <th>Package</th>
        <th>Vulnerable Range</th>
        <th>Via</th>
        <th>Fix</th>
      </tr>
    </thead>
    <tbody>
      ${rows}
    </tbody>
  </table>` : ""}

  <div class="footer">
    Produced by <strong>better-npm</strong> audit-html command.
    Dependencies scanned: ${meta.dependencies?.total ?? "—"}.
  </div>
</div>
</body>
</html>`;
}

export async function cmdAuditHtml(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:   { type: "boolean", default: runtime.json === true },
      help:   { type: "boolean", short: "h", default: false },
      output: { type: "string", default: "audit-report.html" },
      open:   { type: "boolean", default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better audit-html [options]

Generate an HTML security audit report.

Options:
  --output <file>   Output file path (default: audit-report.html)
  --open            Open the report in a browser after generating
  --json            Machine-readable output (report path + vuln counts)
  -h, --help        Show this help
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;

  if (!values.json) {
    process.stderr.write(`\x1b[90mRunning npm audit…\x1b[0m\n`);
  }

  const result = spawnSync("npm", ["audit", "--json"], {
    cwd: projectRoot,
    stdio: ["pipe", "pipe", "pipe"],
    encoding: "utf8",
  });

  let auditData = null;
  try { auditData = JSON.parse(result.stdout); } catch {}

  if (!auditData) {
    const msg = "Failed to run npm audit";
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`\x1b[31mError: ${msg}\x1b[0m`); }
    process.exitCode = 1;
    return;
  }

  const generatedAt = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";
  const html = buildHtml(auditData, generatedAt);

  const outPath = path.isAbsolute(values.output)
    ? values.output
    : path.join(projectRoot, values.output);

  await fs.writeFile(outPath, html, "utf8");

  const vulnCounts = auditData?.metadata?.vulnerabilities || {};
  const total = Object.values(vulnCounts).reduce((s, n) => s + (n || 0), 0);

  if (values.json) {
    printJson({
      ok: true,
      kind: "better.audit-html",
      output: outPath,
      vulnerabilities: total,
      counts: vulnCounts,
    });
    return;
  }

  printText(`\n\x1b[1mbetter audit-html\x1b[0m\n`);
  printText(`  \x1b[32m✔\x1b[0m  Report written to: \x1b[1m${outPath}\x1b[0m`);
  printText(`  \x1b[90mVulnerabilities: ${total === 0 ? "\x1b[32mnone\x1b[0m" : `\x1b[31m${total}\x1b[0m`}`);

  if (values.open) {
    const opener = process.platform === "darwin" ? "open"
      : process.platform === "win32" ? "start"
      : "xdg-open";
    spawnSync(opener, [outPath], { stdio: "ignore" });
  }

  printText("");
}
