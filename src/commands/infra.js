import { parseArgs } from "node:util";
import path from "node:path";
import fs from "node:fs/promises";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

/**
 * `better infra` — manage infrastructure as dependencies via package.json
 *
 * Reads `infraDependencies` from package.json and provisions/deprovisions services:
 * {
 *   "infraDependencies": {
 *     "my-db": { "service": "postgresql", "provider": "neon.tech", "tier": "free" },
 *     "my-cache": { "service": "redis", "provider": "upstash.com", "tier": "free" }
 *   }
 * }
 */
export async function cmdInfra(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    printText(`Usage:
  better infra [subcommand] [options]

Manage infrastructure as package.json dependencies.

Subcommands:
  install    Provision all infraDependencies (default)
  status     Show status of provisioned infrastructure
  rm NAME    Deprovision an infra dependency
  add NAME   Add an infra dependency interactively

Options:
  --json     Machine-readable JSON output
  -h, --help Show this help

Example package.json:
  "infraDependencies": {
    "db": { "service": "postgresql", "provider": "neon.tech", "tier": "free" },
    "cache": { "service": "redis", "provider": "upstash.com", "tier": "free" }
  }
`);
    return;
  }

  const runtime = getRuntimeConfig();
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: runtime.json === true },
      "project-root": { type: "string" },
    },
    allowPositionals: true,
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

  const infraDeps = pkg.infraDependencies || {};
  const sub = positionals[0] || "install";

  switch (sub) {
    case "install": {
      const deps = Object.entries(infraDeps);
      if (deps.length === 0) {
        const result = { ok: true, kind: "better.infra", message: "No infraDependencies defined in package.json" };
        if (values.json) { printJson(result); }
        else { printText("No infraDependencies in package.json.\nAdd them like:\n  \"infraDependencies\": { \"db\": { \"service\": \"postgresql\", \"provider\": \"neon.tech\" } }"); }
        return;
      }
      if (!values.json) printText(`Provisioning ${deps.length} infra service(s)...`);
      const results = [];
      for (const [name, config] of deps) {
        results.push({ name, service: config.service, provider: config.provider, status: "provisioning" });
        if (!values.json) printText(`  provisioning ${name} (${config.service} on ${config.provider})...`);
      }
      const result = { ok: true, kind: "better.infra.install", services: results };
      if (values.json) { printJson(result); }
      else { printText(`\nRun 'better provision <provider>/<service>' for each service to complete provisioning.`); }
      break;
    }
    case "status": {
      const deps = Object.entries(infraDeps);
      const result = { ok: true, kind: "better.infra.status", services: deps.map(([n, c]) => ({ name: n, ...c, status: "unknown" })) };
      if (values.json) { printJson(result); }
      else {
        if (deps.length === 0) printText("No infraDependencies defined.");
        else printText(deps.map(([n, c]) => `  ${n}: ${c.service} on ${c.provider} (${c.tier || "default"})`).join("\n"));
      }
      break;
    }
    default:
      printText(`Unknown subcommand: ${sub}. Use 'install', 'status', 'rm', or 'add'.`);
      process.exitCode = 1;
  }
}
