/**
 * better fund-info — show funding information for dependencies
 *
 * Displays funding links for installed packages that request
 * financial support, summarized by type (GitHub Sponsors, OpenCollective, etc.)
 *
 * Usage:
 *   better fund-info
 *   better fund-info --type opencollective
 *   better fund-info --json
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
  if (Array.isArray(funding)) return funding.flatMap(f => extractFunding(f));
  if (typeof funding === "object") {
    return [{ type: funding.type || "url", url: funding.url || "" }];
  }
  return [];
}

function getFundingType(url) {
  if (!url) return "other";
  if (url.includes("github.com/sponsors")) return "github";
  if (url.includes("opencollective.com")) return "opencollective";
  if (url.includes("patreon.com")) return "patreon";
  if (url.includes("ko-fi.com")) return "ko-fi";
  if (url.includes("liberapay.com")) return "liberapay";
  if (url.includes("tidelift.com")) return "tidelift";
  return "other";
}

export async function cmdFundInfo(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:  { type: "boolean", default: runtime.json === true },
      help:  { type: "boolean", short: "h", default: false },
      type:  { type: "string" },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better fund-info [options]

Show funding information for installed dependencies.

Options:
  --type <t>   Filter by type: github|opencollective|patreon|ko-fi|tidelift
  --json       Machine-readable output
  -h, --help   Show this help

Shows packages requesting financial support with their funding URLs.
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;
  const nmPath = path.join(projectRoot, "node_modules");

  if (!values.json) {
    printText(`\n\x1b[1mbetter fund-info\x1b[0m\n`);
  }

  let pkgJson = {};
  try { pkgJson = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8")); } catch {}

  const allDeps = Object.keys({ ...pkgJson.dependencies, ...pkgJson.devDependencies });

  const results = [];
  const BATCH = 20;
  for (let i = 0; i < allDeps.length; i += BATCH) {
    const batch = allDeps.slice(i, i + BATCH);
    await Promise.all(batch.map(async (dep) => {
      try {
        const pkg = JSON.parse(await fs.readFile(path.join(nmPath, dep, "package.json"), "utf8"));
        const fundingLinks = extractFunding(pkg.funding);
        if (fundingLinks.length > 0) {
          for (const link of fundingLinks) {
            const type = getFundingType(link.url);
            if (!values.type || type === values.type) {
              results.push({ name: dep, version: pkg.version, type, url: link.url });
            }
          }
        }
      } catch {}
    }));
  }

  results.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));

  // Count by type
  const byType = {};
  for (const r of results) {
    byType[r.type] = (byType[r.type] || 0) + 1;
  }

  if (values.json) {
    printJson({ ok: true, kind: "better.fund-info", total: results.length, byType, packages: results });
    return;
  }

  if (results.length === 0) {
    printText(`  \x1b[90mNo funding information found${values.type ? ` for type: ${values.type}` : ""}.\x1b[0m\n`);
    return;
  }

  printText(`  ${results.length} package(s) requesting support\n`);

  // Group by type
  const groups = {};
  for (const r of results) {
    if (!groups[r.type]) groups[r.type] = [];
    groups[r.type].push(r);
  }

  const TYPE_COLORS = {
    github: "\x1b[35m",
    opencollective: "\x1b[36m",
    patreon: "\x1b[31m",
    "ko-fi": "\x1b[33m",
    tidelift: "\x1b[34m",
    other: "\x1b[90m",
  };

  for (const [type, pkgs] of Object.entries(groups)) {
    const color = TYPE_COLORS[type] || "\x1b[90m";
    printText(`${color}\x1b[1m${type}\x1b[0m \x1b[90m(${pkgs.length})\x1b[0m`);
    for (const p of pkgs.slice(0, 5)) {
      printText(`  \x1b[90m·\x1b[0m  \x1b[1m${p.name}\x1b[0m  \x1b[90m${p.url}\x1b[0m`);
    }
    if (pkgs.length > 5) printText(`  \x1b[90m... and ${pkgs.length - 5} more\x1b[0m`);
    printText("");
  }
}
