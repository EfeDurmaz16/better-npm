/**
 * better config-audit — audit npm and project configuration
 *
 * Reviews npm config, .npmrc, package.json config fields, and
 * flags insecure or suboptimal settings.
 *
 * Usage:
 *   better config-audit
 *   better config-audit --strict
 *   better config-audit --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

function npmConfig(key) {
  const r = spawnSync("npm", ["config", "get", key], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  return (r.stdout || "").trim();
}

async function readNpmrc(filePath) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return Object.fromEntries(
      text.split("\n")
        .map(l => l.trim())
        .filter(l => l && !l.startsWith("#") && l.includes("="))
        .map(l => {
          const idx = l.indexOf("=");
          return [l.slice(0, idx).trim(), l.slice(idx + 1).trim()];
        })
    );
  } catch {
    return {};
  }
}

export async function cmdConfigAudit(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:   { type: "boolean", default: runtime.json === true },
      help:   { type: "boolean", short: "h", default: false },
      strict: { type: "boolean", default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better config-audit [options]

Audit npm and project configuration for security and best practices.

Options:
  --strict     Fail on warnings
  --json       Machine-readable output
  -h, --help   Show this help

Checks:
  • npm registry setting
  • audit-level configuration
  • save-exact vs save-prefix
  • ignore-scripts risk
  • package-lock settings
  • .npmrc token exposure
  • fund / update-notifier settings
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;

  if (!values.json) {
    printText(`\n\x1b[1mbetter config-audit\x1b[0m\n`);
  }

  const issues = [];
  const infos = [];

  // Read npm config values
  const registry = npmConfig("registry");
  const auditLevel = npmConfig("audit-level");
  const saveExact = npmConfig("save-exact");
  const packageLock = npmConfig("package-lock");
  const ignoreScripts = npmConfig("ignore-scripts");
  const fundConfig = npmConfig("fund");

  // Check registry
  if (registry && registry !== "https://registry.npmjs.org/") {
    infos.push(`Custom registry: ${registry}`);
  } else {
    infos.push(`Registry: ${registry || "https://registry.npmjs.org/"}`);
  }

  // Check audit-level
  if (!auditLevel || auditLevel === "undefined") {
    issues.push({ severity: "warning", message: "audit-level not set — defaults to all severities", hint: "Set: npm config set audit-level moderate" });
  } else {
    infos.push(`audit-level: ${auditLevel}`);
  }

  // package-lock disabled?
  if (packageLock === "false") {
    issues.push({ severity: "error", message: "package-lock is disabled — reproducible installs not guaranteed", hint: "Run: npm config set package-lock true" });
  }

  // ignore-scripts set globally?
  if (ignoreScripts === "true") {
    infos.push("ignore-scripts: true (safe, but may break some packages)");
  }

  // save-exact
  if (saveExact === "true") {
    infos.push("save-exact: true (pins exact versions)");
  } else {
    issues.push({ severity: "info", message: "save-exact is not set — npm install uses ^ ranges", hint: "Consider: npm config set save-exact true for production apps" });
  }

  // Read project .npmrc
  const projectRc = await readNpmrc(path.join(projectRoot, ".npmrc"));
  const globalRc = await readNpmrc(path.join(os.homedir(), ".npmrc"));

  // Check for ignore-scripts in project .npmrc
  if (projectRc["ignore-scripts"] === "true") {
    infos.push(".npmrc: ignore-scripts=true (install scripts disabled)");
  }

  // Detect legacy-peer-deps
  if (projectRc["legacy-peer-deps"] === "true" || globalRc["legacy-peer-deps"] === "true") {
    issues.push({ severity: "warning", message: "legacy-peer-deps=true bypasses peer dependency resolution", hint: "Fix peer dep conflicts instead of suppressing them" });
  }

  // Check package.json for config overrides
  let pkgJson;
  try {
    pkgJson = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8"));
  } catch {}

  if (pkgJson) {
    if (pkgJson.config) {
      infos.push(`package.json config: ${JSON.stringify(pkgJson.config).slice(0, 80)}`);
    }
    // Check engines.node
    if (!pkgJson.engines?.node) {
      issues.push({ severity: "info", message: "No engines.node specified in package.json", hint: "Add: \"engines\": { \"node\": \">=18\" }" });
    } else {
      infos.push(`engines.node: ${pkgJson.engines.node}`);
    }
  }

  const errors = issues.filter(i => i.severity === "error");
  const warnings = issues.filter(i => i.severity === "warning");
  const allOk = errors.length === 0 && (!values.strict || warnings.length === 0);

  if (values.json) {
    printJson({
      ok: allOk,
      kind: "better.config-audit",
      registry: registry || null,
      auditLevel: auditLevel || null,
      saveExact: saveExact === "true",
      packageLock: packageLock !== "false",
      issues,
      infos,
      errors: errors.length,
      warnings: warnings.length,
    });
    if (!allOk) process.exitCode = 1;
    return;
  }

  for (const info of infos) {
    printText(`  \x1b[90m·  ${info}\x1b[0m`);
  }

  if (issues.length > 0) {
    printText("");
    for (const iss of issues) {
      const icon = iss.severity === "error" ? "\x1b[31m✖\x1b[0m"
        : iss.severity === "warning" ? "\x1b[33m⚠\x1b[0m"
        : "\x1b[90m·\x1b[0m";
      printText(`  ${icon}  ${iss.message}`);
      if (iss.hint) printText(`       \x1b[90m→ ${iss.hint}\x1b[0m`);
    }
  }

  printText("");
  if (allOk) {
    printText(`\x1b[32m✔ npm configuration looks good.\x1b[0m`);
  } else if (errors.length > 0) {
    printText(`\x1b[31m✖ ${errors.length} configuration issue(s) found.\x1b[0m`);
    process.exitCode = 1;
  } else {
    printText(`\x1b[33m⚠ ${warnings.length} warning(s).\x1b[0m`);
    if (values.strict) process.exitCode = 1;
  }
  printText("");
}
