/**
 * better global-packages — list and analyze globally installed npm packages
 *
 * Shows all globally installed packages with versions, sizes,
 * and identifies outdated or unused global tools.
 *
 * Usage:
 *   better global-packages
 *   better global-packages --outdated
 *   better global-packages --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import { spawnSync } from "node:child_process";

function fmtBytes(n) {
  if (!n) return "?";
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

export async function cmdGlobalPackages(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:     { type: "boolean", default: runtime.json === true },
      help:     { type: "boolean", short: "h", default: false },
      outdated: { type: "boolean", default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better global-packages [options]

List globally installed npm packages.

Options:
  --outdated   Check for newer versions (slower)
  --json       Machine-readable output
  -h, --help   Show this help
`);
    return;
  }

  if (!values.json) {
    printText(`\n\x1b[1mbetter global-packages\x1b[0m\n`);
    process.stderr.write(`\x1b[90mFetching global package list...\x1b[0m\n`);
  }

  // Get global list
  const listResult = spawnSync("npm", ["list", "--global", "--json", "--depth=0"], {
    encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
  });

  let globalData = null;
  try { globalData = JSON.parse(listResult.stdout); } catch {}

  if (!globalData?.dependencies) {
    const msg = "Could not read global packages";
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`\x1b[31mError: ${msg}\x1b[0m`); }
    process.exitCode = 1;
    return;
  }

  const packages = Object.entries(globalData.dependencies).map(([name, info]) => ({
    name,
    version: info.version || "?",
  }));

  // Get global prefix for size info
  const prefixResult = spawnSync("npm", ["root", "--global"], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  const globalRoot = prefixResult.stdout?.trim();

  // Get outdated info if requested
  let outdatedData = {};
  if (values.outdated) {
    if (!values.json) {
      process.stderr.write(`\x1b[90mChecking for updates...\x1b[0m\n`);
    }
    const outdatedResult = spawnSync("npm", ["outdated", "--global", "--json"], {
      encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    });
    try { outdatedData = JSON.parse(outdatedResult.stdout) || {}; } catch {}
  }

  if (values.json) {
    printJson({
      ok: true,
      kind: "better.global-packages",
      globalRoot,
      count: packages.length,
      packages: packages.map(p => ({
        ...p,
        latest: outdatedData[p.name]?.latest || null,
        needsUpdate: !!outdatedData[p.name],
      })),
    });
    return;
  }

  printText(`  Global root: ${globalRoot || "?"}`);
  printText(`  Packages:    ${packages.length}\n`);

  printText(`\x1b[90m${"─".repeat(60)}\x1b[0m`);
  printText(`  ${"Name".padEnd(35)} ${"Version".padStart(10)}  ${"Latest".padStart(10)}`);
  printText(`\x1b[90m${"─".repeat(60)}\x1b[0m`);

  for (const pkg of packages.sort((a, b) => a.name.localeCompare(b.name))) {
    const outdated = outdatedData[pkg.name];
    const latest = outdated?.latest || (values.outdated ? "\x1b[32m✔\x1b[0m" : "?");
    const versionStr = outdated ? `\x1b[33m${pkg.version}\x1b[0m` : pkg.version;
    printText(`  ${pkg.name.padEnd(35)} ${versionStr.padStart(10)}  ${latest.padStart(10)}`);
  }

  printText(`\x1b[90m${"─".repeat(60)}\x1b[0m`);

  if (values.outdated && Object.keys(outdatedData).length > 0) {
    printText(`\n\x1b[33m⚠ ${Object.keys(outdatedData).length} package(s) have updates available.\x1b[0m`);
    printText(`\x1b[90m  Run: npm update --global <package> to update\x1b[0m`);
  }
  printText("");
}
