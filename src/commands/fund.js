/**
 * better fund — show funding information for installed packages
 *
 * Shows packages that have funding links, groups them by
 * funding type, and summarizes total packages needing support.
 *
 * Usage:
 *   better fund
 *   better fund --depth 1
 *   better fund --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

function extractFunding(funding) {
  if (!funding) return [];
  if (typeof funding === "string") return [{ type: "url", url: funding }];
  if (Array.isArray(funding)) return funding.map(f => extractFunding(f)).flat();
  return [{
    type: funding.type || "url",
    url: funding.url || String(funding),
  }];
}

export async function cmdFund(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:  { type: "boolean", default: runtime.json === true },
      help:  { type: "boolean", short: "h", default: false },
      depth: { type: "string" },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better fund [options]

Show funding information for installed packages.

Options:
  --depth <N>  Max depth to scan (default: 1 = direct deps only)
  --json       Machine-readable output
  -h, --help   Show this help
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;

  let pkgJson;
  try {
    pkgJson = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8"));
  } catch {
    const msg = "Cannot read package.json";
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`Error: ${msg}`); }
    process.exitCode = 1;
    return;
  }

  const nmPath = path.join(projectRoot, "node_modules");
  const maxDepth = parseInt(values.depth) || 1;

  const depNames = [
    ...Object.keys(pkgJson.dependencies || {}),
    ...Object.keys(pkgJson.devDependencies || {}),
  ];

  const fundingPkgs = [];
  const scanned = new Set();

  async function scanDep(name, depth) {
    if (depth > maxDepth || scanned.has(name)) return;
    scanned.add(name);

    let dep;
    try {
      dep = JSON.parse(await fs.readFile(path.join(nmPath, name, "package.json"), "utf8"));
    } catch { return; }

    if (dep.funding) {
      const links = extractFunding(dep.funding);
      if (links.length > 0) {
        fundingPkgs.push({
          name,
          version: dep.version,
          funding: links,
        });
      }
    }

    if (depth < maxDepth) {
      for (const sub of Object.keys(dep.dependencies || {})) {
        await scanDep(sub, depth + 1);
      }
    }
  }

  for (const name of depNames) {
    await scanDep(name, 0);
  }

  // Group by funding type
  const byType = {};
  for (const pkg of fundingPkgs) {
    for (const link of pkg.funding) {
      const type = link.type || "other";
      if (!byType[type]) byType[type] = [];
      byType[type].push({ ...pkg, url: link.url });
    }
  }

  if (values.json) {
    printJson({
      ok: true,
      kind: "better.fund",
      total: fundingPkgs.length,
      scanned: scanned.size,
      byType,
      packages: fundingPkgs,
    });
    return;
  }

  printText(`\n\x1b[1mbetter fund\x1b[0m — ${scanned.size} package(s) scanned\n`);

  if (fundingPkgs.length === 0) {
    printText(`\x1b[90mNo funding information found in installed packages.\x1b[0m`);
    return;
  }

  printText(`\x1b[1m${fundingPkgs.length}\x1b[0m package(s) are seeking funding:\n`);

  // Show by type
  for (const [type, pkgs] of Object.entries(byType)) {
    printText(`\x1b[1m${type.toUpperCase()}\x1b[0m (${pkgs.length})`);
    for (const pkg of pkgs.slice(0, 8)) {
      printText(`  ${pkg.name}@${pkg.version}`);
      printText(`    \x1b[90m${pkg.url}\x1b[0m`);
    }
    if (pkgs.length > 8) printText(`  \x1b[90m...and ${pkgs.length - 8} more\x1b[0m`);
    printText("");
  }

  printText(`\x1b[90mConsider supporting the packages you depend on!\x1b[0m`);
}
