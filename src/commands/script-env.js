/**
 * better script-env — show environment variables for npm scripts
 *
 * Displays the environment variables that npm injects when running
 * package.json scripts, including npm_ prefixed vars, PATH additions,
 * and lifecycle variables.
 *
 * Usage:
 *   better script-env
 *   better script-env --script build
 *   better script-env --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

// Known npm_ env vars
const NPM_ENV_DOCS = {
  "npm_execpath": "Path to npm executable",
  "npm_node_execpath": "Path to node executable",
  "npm_lifecycle_event": "Current lifecycle event/script name",
  "npm_lifecycle_script": "Current lifecycle script content",
  "npm_config_cache": "npm cache directory",
  "npm_config_global_prefix": "npm global prefix",
  "npm_config_local_prefix": "Project root directory",
  "npm_config_node_version": "Current Node.js version",
  "npm_config_npm_version": "Current npm version",
  "npm_config_user_agent": "npm user agent string",
  "npm_package_name": "Package name from package.json",
  "npm_package_version": "Package version from package.json",
  "npm_package_description": "Package description",
  "npm_package_main": "Package main entry",
  "npm_package_scripts_start": "start script content",
  "npm_package_scripts_test": "test script content",
  "npm_package_scripts_build": "build script content",
};

export async function cmdScriptEnv(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:   { type: "boolean", default: runtime.json === true },
      help:   { type: "boolean", short: "h", default: false },
      script: { type: "string", default: "" },
      all:    { type: "boolean", default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better script-env [options]

Show npm environment variables injected during script execution.

Options:
  --script <name>   Show env for specific script context
  --all             Show all npm_ prefixed variables
  --json            Machine-readable output
  -h, --help        Show this help

Shows:
  • npm_ prefixed variables and their current values
  • PATH additions from node_modules/.bin
  • Package.json fields exposed as npm_package_ variables
  • Lifecycle event variables
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
    pkgJson = {};
  }

  if (!values.json) {
    printText(`\n\x1b[1mbetter script-env\x1b[0m\n`);
  }

  // Get npm env by running `npm run env --json` or build it manually
  const npmEnvResult = spawnSync("npm", ["run", "env"], {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });

  // Parse npm env output or build from current process env
  const npmVars = {};
  const currentEnv = process.env;

  // Collect npm_ prefixed vars from current env (these are available during scripts)
  for (const [k, v] of Object.entries(currentEnv)) {
    if (k.startsWith("npm_")) npmVars[k] = v;
  }

  // Add known npm_package_ vars from package.json
  const addPkgVar = (prefix, obj, depth = 0) => {
    if (depth > 3 || typeof obj !== "object" || !obj) return;
    for (const [k, v] of Object.entries(obj)) {
      const key = `${prefix}_${k.replace(/-/g, "_")}`;
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
        npmVars[key] = String(v);
      } else if (typeof v === "object") {
        addPkgVar(key, v, depth + 1);
      }
    }
  };
  addPkgVar("npm_package", pkgJson);

  // npm config vars
  const configKeys = ["cache", "global_prefix", "user_agent"];
  for (const key of configKeys) {
    const r = spawnSync("npm", ["config", "get", key.replace(/_/g, "-")], {
      encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    });
    if (r.status === 0) npmVars[`npm_config_${key}`] = r.stdout.trim();
  }

  // PATH additions
  const binPath = path.join(projectRoot, "node_modules", ".bin");
  const pathAdditions = [binPath];

  // Lifecycle vars for specific script
  if (values.script) {
    const scripts = pkgJson.scripts || {};
    npmVars["npm_lifecycle_event"] = values.script;
    npmVars["npm_lifecycle_script"] = scripts[values.script] || "(not found)";
  }

  const scriptVars = values.script
    ? Object.fromEntries(Object.entries(npmVars).filter(([k]) => k.includes("lifecycle") || k.includes("npm_package") || k.includes("npm_config")))
    : npmVars;

  const displayVars = values.all ? npmVars : scriptVars;
  const varEntries = Object.entries(displayVars).sort(([a], [b]) => a.localeCompare(b));

  if (values.json) {
    printJson({
      ok: true,
      kind: "better.script-env",
      pathAdditions,
      npmVars: displayVars,
      script: values.script || null,
    });
    return;
  }

  // PATH info
  printText(`\x1b[1mPATH additions (prepended during scripts):\x1b[0m`);
  for (const p of pathAdditions) {
    const rel = path.relative(projectRoot, p);
    printText(`  \x1b[36m${rel}\x1b[0m`);
  }

  // npm_ variables
  printText(`\n\x1b[1mnpm_ environment variables:\x1b[0m  \x1b[90m(${varEntries.length} total)\x1b[0m\n`);

  const groups = {
    "Lifecycle": [],
    "Package": [],
    "Config": [],
    "Other": [],
  };

  for (const [k, v] of varEntries) {
    const doc = NPM_ENV_DOCS[k] || "";
    const entry = { key: k, value: v, doc };
    if (k.includes("lifecycle")) groups["Lifecycle"].push(entry);
    else if (k.startsWith("npm_package_")) groups["Package"].push(entry);
    else if (k.startsWith("npm_config_")) groups["Config"].push(entry);
    else groups["Other"].push(entry);
  }

  for (const [groupName, entries] of Object.entries(groups)) {
    if (entries.length === 0) continue;
    printText(`\x1b[90m${groupName}:\x1b[0m`);
    const shown = entries.slice(0, values.all ? entries.length : 10);
    for (const e of shown) {
      const val = e.value.length > 80 ? e.value.slice(0, 80) + "…" : e.value;
      printText(`  \x1b[36m${e.key.padEnd(45)}\x1b[0m = ${val}`);
    }
    if (entries.length > 10 && !values.all) {
      printText(`  \x1b[90m… and ${entries.length - 10} more. Use --all to see all.\x1b[0m`);
    }
    printText("");
  }
}
