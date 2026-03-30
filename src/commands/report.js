/**
 * better report — generate a shareable dependency report
 *
 * Produces a comprehensive HTML or Markdown report of all dependencies,
 * their versions, licenses, and health status.
 *
 * Usage:
 *   better report                        # Markdown to stdout
 *   better report --format html          # HTML report
 *   better report --output report.md     # write to file
 *   better report --format html --output report.html
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

function fmtBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function gatherPackageData(projectRoot) {
  let pkgJson = {};
  let lockData = null;

  try {
    pkgJson = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8"));
  } catch {}

  try {
    lockData = JSON.parse(await fs.readFile(path.join(projectRoot, "package-lock.json"), "utf8"));
  } catch {}

  const directDeps = {
    ...pkgJson.dependencies,
    ...pkgJson.devDependencies,
  };

  const packages = [];
  const nmPath = path.join(projectRoot, "node_modules");

  if (lockData?.packages) {
    for (const [pkgPath, info] of Object.entries(lockData.packages)) {
      if (!pkgPath || pkgPath === "") continue;
      const name = pkgPath.startsWith("node_modules/") ? pkgPath.slice(13) : pkgPath;
      if (!name || name.includes("/node_modules/")) continue;

      let license = "Unknown";
      let description = "";
      try {
        const instPkg = JSON.parse(
          await fs.readFile(path.join(nmPath, name, "package.json"), "utf8")
        );
        license = instPkg.license || instPkg.licence || "Unknown";
        if (typeof license !== "string") license = license?.type || "Unknown";
        description = instPkg.description || "";
      } catch {}

      packages.push({
        name,
        version: info.version || "?",
        resolved: info.resolved || "",
        integrity: info.integrity || "",
        license,
        description,
        isDirect: name in directDeps,
        depType: pkgJson.dependencies?.[name] ? "prod" : pkgJson.devDependencies?.[name] ? "dev" : "transitive",
        deprecated: Boolean(info.deprecated),
      });
    }
  }

  packages.sort((a, b) => {
    if (a.isDirect !== b.isDirect) return a.isDirect ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return { pkgJson, packages, directDeps };
}

function generateMarkdown(pkgJson, packages, timestamp) {
  const direct = packages.filter(p => p.isDirect);
  const transitive = packages.filter(p => !p.isDirect);
  const licenses = {};
  for (const p of packages) {
    licenses[p.license] = (licenses[p.license] || 0) + 1;
  }
  const topLicenses = Object.entries(licenses)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  const lines = [
    `# Dependency Report — ${pkgJson.name || "Project"}@${pkgJson.version || "?"}`,
    "",
    `Generated: ${timestamp}`,
    "",
    "## Summary",
    "",
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Direct dependencies | ${direct.length} |`,
    `| Transitive dependencies | ${transitive.length} |`,
    `| Total packages | ${packages.length} |`,
    `| Deprecated packages | ${packages.filter(p => p.deprecated).length} |`,
    "",
    "### License Distribution",
    "",
    `| License | Count |`,
    `|---------|-------|`,
    ...topLicenses.map(([lic, count]) => `| ${lic} | ${count} |`),
    "",
    "## Direct Dependencies",
    "",
    `| Package | Version | Type | License | Description |`,
    `|---------|---------|------|---------|-------------|`,
    ...direct.map(p =>
      `| \`${p.name}\` | ${p.version} | ${p.depType} | ${p.license} | ${p.description.slice(0, 60)} |`
    ),
    "",
    "## All Transitive Dependencies",
    "",
    `| Package | Version | License |`,
    `|---------|---------|---------|`,
    ...transitive.slice(0, 200).map(p =>
      `| \`${p.name}\` | ${p.version} | ${p.license} |`
    ),
    ...(transitive.length > 200 ? [`\n_...and ${transitive.length - 200} more_`] : []),
    "",
  ];

  return lines.join("\n");
}

function generateHtml(pkgJson, packages, timestamp) {
  const direct = packages.filter(p => p.isDirect);
  const transitive = packages.filter(p => !p.isDirect);
  const deprecated = packages.filter(p => p.deprecated);
  const licenses = {};
  for (const p of packages) {
    licenses[p.license] = (licenses[p.license] || 0) + 1;
  }
  const topLicenses = Object.entries(licenses).sort((a, b) => b[1] - a[1]);

  const licenseRows = topLicenses.map(([lic, count]) =>
    `<tr><td>${escHtml(lic)}</td><td>${count}</td></tr>`
  ).join("\n");

  const directRows = direct.map(p =>
    `<tr>
      <td><code>${escHtml(p.name)}</code></td>
      <td>${escHtml(p.version)}</td>
      <td><span class="badge ${p.depType}">${escHtml(p.depType)}</span></td>
      <td>${escHtml(p.license)}</td>
      <td>${escHtml(p.description.slice(0, 80))}</td>
    </tr>`
  ).join("\n");

  const transitiveRows = transitive.map(p =>
    `<tr>
      <td><code>${escHtml(p.name)}</code></td>
      <td>${escHtml(p.version)}</td>
      <td>${escHtml(p.license)}</td>
      ${p.deprecated ? `<td><span class="badge deprecated">deprecated</span></td>` : "<td></td>"}
    </tr>`
  ).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Dependency Report — ${escHtml(pkgJson.name || "Project")}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, monospace; background: #0d1117; color: #c9d1d9; line-height: 1.6; }
    .container { max-width: 1200px; margin: 0 auto; padding: 2rem; }
    h1 { font-size: 1.8rem; color: #58a6ff; border-bottom: 1px solid #30363d; padding-bottom: 0.5rem; margin-bottom: 1.5rem; }
    h2 { font-size: 1.3rem; color: #79c0ff; margin: 2rem 0 1rem; }
    .meta { color: #8b949e; font-size: 0.9rem; margin-bottom: 2rem; }
    .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 1rem; margin-bottom: 2rem; }
    .stat-card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 1rem; text-align: center; }
    .stat-number { font-size: 2rem; font-weight: bold; color: #58a6ff; }
    .stat-label { font-size: 0.85rem; color: #8b949e; margin-top: 0.25rem; }
    table { width: 100%; border-collapse: collapse; font-size: 0.9rem; margin-bottom: 2rem; }
    th { background: #161b22; color: #8b949e; padding: 0.6rem 0.8rem; text-align: left; border-bottom: 1px solid #30363d; font-weight: 600; }
    td { padding: 0.5rem 0.8rem; border-bottom: 1px solid #21262d; vertical-align: top; }
    tr:hover td { background: #161b22; }
    code { background: #161b22; padding: 2px 6px; border-radius: 4px; font-size: 0.85em; color: #e3b341; }
    .badge { display: inline-block; padding: 1px 8px; border-radius: 12px; font-size: 0.75rem; font-weight: 600; }
    .badge.prod { background: #1a472a; color: #56d364; }
    .badge.dev { background: #1c2026; color: #79c0ff; border: 1px solid #30363d; }
    .badge.transitive { background: #161b22; color: #8b949e; }
    .badge.deprecated { background: #3d1a1a; color: #f85149; }
    .search { width: 100%; padding: 0.6rem 1rem; background: #161b22; border: 1px solid #30363d; border-radius: 6px; color: #c9d1d9; font-size: 0.95rem; margin-bottom: 1rem; }
    .search:focus { outline: none; border-color: #58a6ff; }
  </style>
</head>
<body>
<div class="container">
  <h1>📦 Dependency Report — ${escHtml(pkgJson.name || "Project")}@${escHtml(pkgJson.version || "?")} </h1>
  <div class="meta">Generated ${timestamp}</div>

  <div class="stats-grid">
    <div class="stat-card"><div class="stat-number">${direct.length}</div><div class="stat-label">Direct Dependencies</div></div>
    <div class="stat-card"><div class="stat-number">${transitive.length}</div><div class="stat-label">Transitive Dependencies</div></div>
    <div class="stat-card"><div class="stat-number">${packages.length}</div><div class="stat-label">Total Packages</div></div>
    <div class="stat-card"><div class="stat-number" style="color:${deprecated.length > 0 ? '#f85149' : '#56d364'}">${deprecated.length}</div><div class="stat-label">Deprecated</div></div>
  </div>

  <h2>License Distribution</h2>
  <table>
    <tr><th>License</th><th>Count</th></tr>
    ${licenseRows}
  </table>

  <h2>Direct Dependencies</h2>
  <input type="text" class="search" id="search-direct" placeholder="Search direct dependencies..." oninput="filterTable(this, 'direct-table')">
  <table id="direct-table">
    <tr><th>Package</th><th>Version</th><th>Type</th><th>License</th><th>Description</th></tr>
    ${directRows}
  </table>

  <h2>Transitive Dependencies (${transitive.length})</h2>
  <input type="text" class="search" id="search-trans" placeholder="Search transitive dependencies..." oninput="filterTable(this, 'trans-table')">
  <table id="trans-table">
    <tr><th>Package</th><th>Version</th><th>License</th><th>Status</th></tr>
    ${transitiveRows}
  </table>
</div>
<script>
function filterTable(input, tableId) {
  const q = input.value.toLowerCase();
  const rows = document.getElementById(tableId).querySelectorAll('tr:not(:first-child)');
  rows.forEach(r => { r.style.display = r.textContent.toLowerCase().includes(q) ? '' : 'none'; });
}
</script>
</body>
</html>`;
}

export async function cmdReport(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: runtime.json === true },
      format: { type: "string", default: "markdown" },
      output: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better report [options]

Generate a shareable dependency report.

Options:
  --format <fmt>   Output format: markdown (default) | html
  --output <file>  Write to file instead of stdout
  --json           Machine-readable output
  -h, --help       Show this help

Examples:
  better report                             # Markdown to stdout
  better report --format html --output report.html
  better report --output deps.md
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;

  if (!values.json && !values.output) {
    process.stderr.write("\x1b[90mGenerating report…\x1b[0m\n");
  }

  const { pkgJson, packages } = await gatherPackageData(projectRoot);
  const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";

  let output;
  if (values.format === "html") {
    output = generateHtml(pkgJson, packages, timestamp);
  } else {
    output = generateMarkdown(pkgJson, packages, timestamp);
  }

  if (values.json) {
    printJson({
      ok: true,
      kind: "better.report",
      format: values.format,
      packages: packages.length,
      direct: packages.filter(p => p.isDirect).length,
    });
    return;
  }

  if (values.output) {
    await fs.writeFile(values.output, output);
    printText(`Report written to ${values.output} (${packages.length} packages)`);
  } else {
    process.stdout.write(output + "\n");
  }
}
