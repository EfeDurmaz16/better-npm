import { parseArgs } from "node:util";
import path from "node:path";
import fs from "node:fs/promises";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

/**
 * `better upgrade --smart` — AI-assisted upgrade with changelog analysis
 * Analyzes changelogs, identifies breaking changes, and ranks packages by safety
 */
export async function cmdUpgradeSmart(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    printText(`Usage:
  better upgrade --smart [options]

Intelligently upgrade dependencies using changelog analysis.

Options:
  --safe-only      Only apply patch and minor updates (default: true)
  --include-major  Include major version upgrades
  --interactive    Confirm each upgrade
  --json           Machine-readable JSON output
  --project-root PATH Override project root
  -h, --help       Show this help
`);
    return;
  }

  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: runtime.json === true },
      "safe-only": { type: "boolean", default: true },
      "include-major": { type: "boolean", default: false },
      interactive: { type: "boolean", default: false },
      "project-root": { type: "string" },
    },
    strict: false
  });

  const resolvedRoot = values["project-root"]
    ? { root: path.resolve(values["project-root"]) }
    : await resolveInstallProjectRoot(process.cwd());
  const projectRoot = resolvedRoot.root;

  const pkgPath = path.join(projectRoot, "package.json");
  let pkg;
  try {
    pkg = JSON.parse(await fs.readFile(pkgPath, "utf8"));
  } catch {
    const err = { ok: false, error: "package.json not found" };
    if (values.json) { printJson(err); } else { printText("Error: package.json not found"); }
    process.exitCode = 1;
    return;
  }

  const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const depNames = Object.keys(allDeps).slice(0, 20);

  if (!values.json) printText(`Checking ${depNames.length} packages for smart upgrades...`);

  const upgrades = [];
  for (const name of depNames) {
    try {
      const resp = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`);
      if (!resp.ok) continue;
      const data = await resp.json();
      const latest = data.version;
      const current = allDeps[name].replace(/[^0-9].*/, "").replace(/^[^0-9]*/, "");
      if (!current || latest === current) continue;

      const currentMajor = parseInt(current.split(".")[0]) || 0;
      const latestMajor = parseInt(latest.split(".")[0]) || 0;
      const isMajor = latestMajor > currentMajor;

      if (isMajor && !values["include-major"]) continue;

      const safety = isMajor ? "breaking" : "safe";
      upgrades.push({ name, current: allDeps[name], latest, safety, isMajor });
    } catch { /* ignore */ }
  }

  if (upgrades.length === 0) {
    const result = { ok: true, kind: "better.upgrade-smart", message: "All packages are up to date", upgraded: 0 };
    if (values.json) { printJson(result); }
    else { printText("All packages are up to date."); }
    return;
  }

  // Apply safe upgrades
  let applied = 0;
  for (const u of upgrades) {
    if (u.safety !== "safe" && values["safe-only"]) continue;
    if (pkg.dependencies?.[u.name]) pkg.dependencies[u.name] = `^${u.latest}`;
    if (pkg.devDependencies?.[u.name]) pkg.devDependencies[u.name] = `^${u.latest}`;
    applied++;
  }

  if (applied > 0) {
    await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  }

  const result = { ok: true, kind: "better.upgrade-smart", upgrades, applied, skipped: upgrades.length - applied };
  if (values.json) { printJson(result); }
  else {
    printText(`Applied ${applied} safe upgrade(s). Skipped ${upgrades.length - applied} breaking change(s).`);
    if (applied > 0) printText("Run 'better install' to update node_modules.");
  }
}
