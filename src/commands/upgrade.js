import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import { VERSION } from "../version.js";
import { execFileSync } from "node:child_process";

export async function cmdUpgrade(argv) {
  // Delegate --smart to the intelligence-based upgrade command
  if (argv.includes("--smart")) {
    const { cmdUpgradeSmart } = await import("./upgrade-smart.js");
    return cmdUpgradeSmart(argv.filter(a => a !== "--smart"));
  }

  if (argv.includes("--help") || argv.includes("-h")) {
    printText(`Usage:
  better upgrade [options]

Upgrade better itself to the latest version, or upgrade dependencies with --smart.

Options:
  --smart          Use AI-assisted changelog analysis to upgrade dependencies
  --check-only     Only check if an update is available
  --force          Force upgrade even if already on latest
  --json           Machine-readable JSON output
  -h, --help       Show this help
`);
    return;
  }

  const { values } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: false },
      "check-only": { type: "boolean", default: false },
      force: { type: "boolean", default: false },
    },
    strict: false
  });

  const runtime = getRuntimeConfig();
  const useJson = values.json || runtime.json === true;

  // Fetch latest version from npm registry (since this is an npm package)
  let latest;
  try {
    const resp = await fetch("https://registry.npmjs.org/better-npm/latest");
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    latest = data.version;
  } catch (err) {
    const result = { ok: false, error: `Failed to check for updates: ${err.message}`, current: VERSION };
    if (useJson) { printJson(result); } else { printText(`Error: ${result.error}`); }
    process.exitCode = 1;
    return;
  }

  const current = VERSION;
  const isNewer = isVersionNewer(latest, current);

  if (values["check-only"]) {
    const result = { ok: true, current, latest, updateAvailable: isNewer };
    if (useJson) {
      printJson(result);
    } else {
      if (isNewer) {
        printText(`Update available: ${current} → ${latest}\nRun 'better upgrade' to install.`);
      } else {
        printText(`Already on latest version ${current}`);
      }
    }
    return;
  }

  if (!isNewer && !values.force) {
    const result = { ok: true, current, latest, updated: false, message: "Already on latest version" };
    if (useJson) { printJson(result); } else { printText(`Already on latest version ${current}`); }
    return;
  }

  // Run npm install -g better-npm@latest
  try {
    printText(`Upgrading better from ${current} to ${latest}...`);
    execFileSync("npm", ["install", "-g", `better-npm@${latest}`], { stdio: "inherit" });
    const result = { ok: true, current, latest, updated: true };
    if (useJson) { printJson(result); } else { printText(`Successfully upgraded to ${latest}`); }
  } catch (err) {
    const result = { ok: false, error: `Upgrade failed: ${err.message}`, current, latest };
    if (useJson) { printJson(result); } else { printText(`Error: ${result.error}`); }
    process.exitCode = 1;
  }
}

function isVersionNewer(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}
