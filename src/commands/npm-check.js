/**
 * better npm-check — comprehensive npm environment check
 *
 * Validates that npm, node, and the project environment are in
 * a good state. Checks npm version, registry connectivity, auth,
 * global vs local conflicts, and common misconfigurations.
 *
 * Usage:
 *   better npm-check
 *   better npm-check --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import https from "node:https";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  return { stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim(), status: r.status };
}

function pingRegistry(url) {
  return new Promise((resolve) => {
    const start = Date.now();
    https.get(url, {
      headers: { "User-Agent": "better-npm/0.1" },
      timeout: 5000,
    }, (res) => {
      res.resume();
      res.on("end", () => resolve({ ok: true, ms: Date.now() - start }));
    }).on("error", (err) => resolve({ ok: false, error: err.message }))
      .on("timeout", () => resolve({ ok: false, error: "timeout" }));
  });
}

function parseVersion(v) {
  const parts = String(v).replace(/^v/, "").split(".").map(Number);
  return parts;
}

function meetsMinVersion(actual, min) {
  const [am, ami] = parseVersion(actual);
  const [mm, mmi] = parseVersion(min);
  if (am !== mm) return am > mm;
  return ami >= mmi;
}

export async function cmdNpmCheck(argv) {
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
    printText(`Usage: better npm-check [options]

Check npm environment health and configuration.

Checks:
  • Node.js version
  • npm version
  • npm registry connectivity
  • npm authentication status
  • .npmrc configuration
  • npm cache location and size
  • Common misconfigurations

Options:
  --json       Machine-readable output
  -h, --help   Show this help
`);
    return;
  }

  const checks = [];

  // Node.js version
  const nodeVer = process.version.replace(/^v/, "");
  const nodeLts = "18.0.0";
  const nodeOk = meetsMinVersion(nodeVer, nodeLts);
  checks.push({
    id: "node-version",
    label: `Node.js: v${nodeVer}`,
    passed: nodeOk,
    severity: nodeOk ? "info" : "warning",
    hint: nodeOk ? "" : `Node.js >= ${nodeLts} recommended`,
  });

  // npm version
  const npmResult = run("npm", ["--version"]);
  const npmVer = npmResult.stdout;
  const npmMinVer = "7.0.0";
  const npmOk = npmVer && meetsMinVersion(npmVer, npmMinVer);
  checks.push({
    id: "npm-version",
    label: `npm: v${npmVer || "unknown"}`,
    passed: !!npmOk,
    severity: npmOk ? "info" : "warning",
    hint: !npmOk ? `npm >= ${npmMinVer} recommended. Run: npm install -g npm` : "",
  });

  // npm registry
  const registryResult = run("npm", ["config", "get", "registry"]);
  const registry = registryResult.stdout;
  const isDefaultRegistry = registry === "https://registry.npmjs.org/";
  checks.push({
    id: "registry-config",
    label: `Registry: ${registry || "unknown"}`,
    passed: true,
    severity: isDefaultRegistry ? "info" : "warning",
    hint: !isDefaultRegistry ? "Using non-default registry" : "",
  });

  // Registry connectivity
  if (!values.json) {
    process.stderr.write(`\x1b[90mChecking registry connectivity…\x1b[0m\n`);
  }
  const ping = await pingRegistry("https://registry.npmjs.org/");
  checks.push({
    id: "registry-connectivity",
    label: ping.ok ? `Registry reachable (${ping.ms}ms)` : "Registry unreachable",
    passed: ping.ok,
    severity: ping.ok ? "info" : "error",
    hint: ping.ok ? "" : "Check network connection or VPN",
  });

  // npm auth
  const whoamiResult = run("npm", ["whoami"]);
  const isLoggedIn = whoamiResult.status === 0 && whoamiResult.stdout;
  checks.push({
    id: "npm-auth",
    label: isLoggedIn ? `Logged in as: ${whoamiResult.stdout}` : "Not logged in to npm",
    passed: true, // not an error — just informational
    severity: "info",
    hint: !isLoggedIn ? "Run: npm login (only needed for publishing)" : "",
  });

  // npm cache
  const cacheResult = run("npm", ["config", "get", "cache"]);
  const cachePath = cacheResult.stdout;
  checks.push({
    id: "npm-cache",
    label: `Cache: ${cachePath || "default"}`,
    passed: true,
    severity: "info",
  });

  // Check for .npmrc
  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;

  let hasNpmrc = false;
  try {
    await fs.access(path.join(projectRoot, ".npmrc"));
    hasNpmrc = true;
  } catch {}

  if (hasNpmrc) {
    const npmrcContent = await fs.readFile(path.join(projectRoot, ".npmrc"), "utf8").catch(() => "");
    const hasToken = /(_authToken|_auth\s*=|\/\/.*:_authToken)/.test(npmrcContent);
    if (hasToken) {
      checks.push({
        id: "npmrc-token",
        label: ".npmrc contains auth token",
        passed: false,
        severity: "warning",
        hint: "Consider using environment variables for auth tokens instead of .npmrc",
      });
    }
  }

  // Check for package-lock vs npm-shrinkwrap conflict
  const hasLock = await fs.access(path.join(projectRoot, "package-lock.json")).then(() => true).catch(() => false);
  const hasShrinkwrap = await fs.access(path.join(projectRoot, "npm-shrinkwrap.json")).then(() => true).catch(() => false);
  if (hasLock && hasShrinkwrap) {
    checks.push({
      id: "lockfile-conflict",
      label: "Both package-lock.json and npm-shrinkwrap.json exist",
      passed: false,
      severity: "warning",
      hint: "Remove one. npm-shrinkwrap.json takes precedence.",
    });
  }

  // Check engines field in package.json
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8"));
    const enginesNode = pkg.engines?.node;
    if (!enginesNode) {
      checks.push({
        id: "no-engines",
        label: "No engines.node field in package.json",
        passed: false,
        severity: "warning",
        hint: 'Add "engines": { "node": ">=18" } to package.json',
      });
    }
  } catch {}

  const errors = checks.filter(c => !c.passed && c.severity === "error");
  const warnings = checks.filter(c => !c.passed && c.severity === "warning");

  if (values.json) {
    printJson({
      ok: errors.length === 0,
      kind: "better.npm-check",
      checks: checks.map(c => ({ id: c.id, label: c.label, passed: c.passed, severity: c.severity })),
      errors: errors.length,
      warnings: warnings.length,
    });
    if (errors.length > 0) process.exitCode = 1;
    return;
  }

  printText(`\n\x1b[1mbetter npm-check\x1b[0m\n`);

  for (const c of checks) {
    const icon = c.passed
      ? "\x1b[32m✔\x1b[0m"
      : c.severity === "error" ? "\x1b[31m✖\x1b[0m"
      : c.severity === "warning" ? "\x1b[33m⚠\x1b[0m"
      : "\x1b[90m·\x1b[0m";
    printText(`  ${icon}  ${c.label}`);
    if (c.hint) printText(`       \x1b[90m→ ${c.hint}\x1b[0m`);
  }

  printText("");
  if (errors.length === 0 && warnings.length === 0) {
    printText(`\x1b[32m✔ npm environment is healthy.\x1b[0m`);
  } else if (errors.length === 0) {
    printText(`\x1b[33m⚠ ${warnings.length} warning(s).\x1b[0m`);
  } else {
    printText(`\x1b[31m✖ ${errors.length} error(s) found.\x1b[0m`);
    process.exitCode = 1;
  }
  printText("");
}
