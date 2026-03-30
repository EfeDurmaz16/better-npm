import { parseArgs } from "node:util";
import path from "node:path";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

/**
 * `better ci` — CI-optimized install (strict frozen lockfile, no lockfile update)
 *
 * Equivalent to `better install --frozen --strict` but with CI-specific defaults:
 * - Fail if lockfile is missing
 * - Fail if package.json is out of sync with lockfile
 * - Parallel fetch with all cores
 * - Clean node_modules before installing
 */
export async function cmdCi(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    printText(`Usage:
  better ci [options]

CI-optimized install — strict frozen lockfile install.

Equivalent to: better install --frozen --strict
Differences from 'better install':
  - Fails if package-lock.json/better.lock is missing
  - Fails if package.json is out of sync with lockfile
  - Deletes node_modules before installing (clean install)
  - Never modifies the lockfile

Options:
  --json               Machine-readable JSON output
  --project-root PATH  Override project root
  --no-audit           Skip security audit after install
  -h, --help           Show this help
`);
    return;
  }

  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: runtime.json === true },
      "project-root": { type: "string" },
      "no-audit": { type: "boolean", default: false },
    },
    strict: false
  });

  const resolvedRoot = values["project-root"]
    ? { root: path.resolve(values["project-root"]) }
    : await resolveInstallProjectRoot(process.cwd());
  const projectRoot = resolvedRoot.root;

  // Delegate to install with CI flags
  const installArgs = [
    "--frozen",
    "--strict",
    "--project-root", projectRoot,
  ];
  if (values.json) installArgs.push("--json");

  const { cmdInstall } = await import("./install.js");
  return cmdInstall(installArgs);
}
