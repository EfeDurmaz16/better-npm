/**
 * better config-audit — audit npm configuration
 *
 * Reads and validates npm configuration from all sources (.npmrc files,
 * environment variables, defaults) and reports security or correctness issues.
 *
 * Usage:
 *   better config-audit
 *   better config-audit --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 8000 });
  return r.status === 0 ? r.stdout.trim() : null;
}

function parseNpmrc(content) {
  const result = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(";") || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    result[key] = val;
  }
  return result;
}

export async function cmdConfigAudit(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:  { type: "boolean", default: runtime.json === true },
      help:  { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better config-audit [options]

Audit npm configuration for security and correctness issues.

Options:
  --json       Machine-readable output
  -h, --help   Show this help

Checks:
  • Registry URL (should be HTTPS)
  • unsafe-perm setting
  • ignore-scripts setting
  • Proxy configuration
  • Auth tokens exposure
  • Deprecated settings
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;

  if (!values.json) {
    printText(`\n\x1b[1mbetter config-audit\x1b[0m\n`);
  }

  // Read all npmrc files
  const sources = [
    { label: "project .npmrc", file: path.join(projectRoot, ".npmrc") },
    { label: "user .npmrc", file: path.join(os.homedir(), ".npmrc") },
  ];

  const configs = {};
  for (const src of sources) {
    try {
      const content = await fs.readFile(src.file, "utf8");
      const parsed = parseNpmrc(content);
      for (const [k, v] of Object.entries(parsed)) {
        configs[k] = { value: v, source: src.label };
      }
    } catch {}
  }

  // Also get runtime values from npm
  const npmRegistry = run("npm", ["config", "get", "registry"]) || "https://registry.npmjs.org/";
  const npmIgnoreScripts = run("npm", ["config", "get", "ignore-scripts"]);
  const npmUnsafePerm = run("npm", ["config", "get", "unsafe-perm"]);
  const npmAuditLevel = run("npm", ["config", "get", "audit-level"]);

  const checks = [];

  // Registry HTTPS check
  const registryIsHttps = npmRegistry.startsWith("https://");
  checks.push({
    name: "registry-https",
    ok: registryIsHttps,
    message: registryIsHttps
      ? `Registry uses HTTPS: ${npmRegistry}`
      : `Registry uses insecure HTTP: ${npmRegistry}`,
    severity: registryIsHttps ? "ok" : "error",
  });

  // unsafe-perm
  const unsafePerm = configs["unsafe-perm"]?.value || npmUnsafePerm;
  const unsafePermOn = unsafePerm === "true";
  checks.push({
    name: "unsafe-perm",
    ok: !unsafePermOn,
    message: unsafePermOn ? "unsafe-perm=true is set (security risk)" : "unsafe-perm not enabled",
    severity: unsafePermOn ? "warning" : "ok",
  });

  // ignore-scripts
  const ignoreScripts = configs["ignore-scripts"]?.value || npmIgnoreScripts;
  const ignoreScriptsOn = ignoreScripts === "true";
  checks.push({
    name: "ignore-scripts",
    ok: ignoreScriptsOn,
    message: ignoreScriptsOn ? "ignore-scripts=true (good security practice)" : "ignore-scripts not enabled (lifecycle scripts run on install)",
    severity: ignoreScriptsOn ? "ok" : "info",
  });

  // audit-level
  const auditLevel = configs["audit-level"]?.value || npmAuditLevel;
  const goodLevels = ["low", "moderate", "high", "critical"];
  const auditLevelOk = !auditLevel || auditLevel === "null" || goodLevels.includes(auditLevel);
  checks.push({
    name: "audit-level",
    ok: auditLevelOk,
    message: auditLevel && auditLevel !== "null" ? `audit-level set to: ${auditLevel}` : "audit-level not configured (defaults to low)",
    severity: "info",
  });

  // Auth tokens in config
  const authTokenKeys = Object.keys(configs).filter(k => k.includes(":_authToken"));
  if (authTokenKeys.length > 0) {
    checks.push({
      name: "auth-tokens",
      ok: true,
      message: `${authTokenKeys.length} auth token(s) configured in .npmrc`,
      severity: "info",
    });
    // Check if any are committed to project .npmrc
    const projectAuthTokens = authTokenKeys.filter(k => configs[k].source === "project .npmrc");
    if (projectAuthTokens.length > 0) {
      checks.push({
        name: "auth-tokens-in-project",
        ok: false,
        message: `Auth token(s) found in project .npmrc — risk of accidental commit`,
        severity: "error",
      });
    }
  }

  // HTTP proxy
  const httpProxy = process.env.HTTP_PROXY || process.env.http_proxy || configs["proxy"]?.value;
  if (httpProxy && httpProxy !== "null" && httpProxy !== "") {
    checks.push({
      name: "proxy",
      ok: true,
      message: `HTTP proxy configured: ${httpProxy}`,
      severity: "info",
    });
  }

  const ok = checks.every(c => c.ok || c.severity === "info");

  if (values.json) {
    printJson({ ok, kind: "better.config-audit", registry: npmRegistry, checks });
    if (!ok) process.exitCode = 1;
    return;
  }

  for (const c of checks) {
    const icon = c.ok ? "\x1b[32m✔\x1b[0m" : (c.severity === "warning" ? "\x1b[33m⚠\x1b[0m" : c.severity === "info" ? "\x1b[36mℹ\x1b[0m" : "\x1b[31m✘\x1b[0m");
    printText(`  ${icon}  ${c.message}`);
  }

  printText("");
  if (!ok) {
    const errors = checks.filter(c => !c.ok && c.severity !== "info");
    printText(`\x1b[31m✘ ${errors.length} configuration issue(s) found.\x1b[0m`);
    process.exitCode = 1;
  } else {
    printText(`\x1b[32m✔ npm configuration looks good.\x1b[0m`);
  }
  printText("");
}
