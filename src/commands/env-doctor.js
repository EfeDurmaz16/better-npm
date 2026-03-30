/**
 * better env-doctor — diagnose Node.js/npm environment health
 *
 * Checks Node.js version, npm version, global prefix, cache dir,
 * PATH entries, and common configuration issues that affect npm usage.
 *
 * Usage:
 *   better env-doctor
 *   better env-doctor --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 8000 });
  return r.status === 0 ? r.stdout.trim() : null;
}

function checkVersion(current, minMajor, name) {
  if (!current) return { ok: false, message: `${name} not found` };
  const major = parseInt(current.replace(/^v/, "").split(".")[0], 10);
  if (isNaN(major)) return { ok: false, message: `Cannot parse ${name} version: ${current}` };
  if (major < minMajor) return { ok: false, message: `${name} ${current} is below recommended v${minMajor}` };
  return { ok: true, message: `${name} ${current}` };
}

export async function cmdEnvDoctor(argv) {
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
    printText(`Usage: better env-doctor [options]

Diagnose Node.js/npm environment health.

Options:
  --json       Machine-readable output
  -h, --help   Show this help

Checks:
  • Node.js version (recommend >= 18)
  • npm version (recommend >= 9)
  • npm global prefix and PATH alignment
  • npm cache directory permissions
  • Common .npmrc configuration issues
  • Network proxy settings
`);
    return;
  }

  if (!values.json) {
    printText(`\n\x1b[1mbetter env-doctor\x1b[0m\n`);
  }

  const checks = [];

  // Node.js version
  const nodeVer = run("node", ["--version"]);
  const nodeCheck = checkVersion(nodeVer, 18, "Node.js");
  checks.push({ name: "node-version", ...nodeCheck, value: nodeVer });

  // npm version
  const npmVer = run("npm", ["--version"]);
  const npmCheck = checkVersion(npmVer ? `v${npmVer}` : null, 9, "npm");
  checks.push({ name: "npm-version", ...npmCheck, value: npmVer });

  // Global prefix
  const globalPrefix = run("npm", ["config", "get", "prefix"]);
  checks.push({ name: "npm-global-prefix", ok: !!globalPrefix, message: globalPrefix ? `Global prefix: ${globalPrefix}` : "Cannot determine global prefix", value: globalPrefix });

  // Check if global bin is in PATH
  let pathOk = false;
  let pathMsg = "Could not check PATH";
  if (globalPrefix) {
    const globalBin = path.join(globalPrefix, "bin");
    const pathDirs = (process.env.PATH || "").split(path.delimiter);
    pathOk = pathDirs.some(d => d === globalBin || d === globalPrefix);
    pathMsg = pathOk ? `Global bin in PATH (${globalBin})` : `Global bin NOT in PATH: ${globalBin}`;
  }
  checks.push({ name: "global-bin-in-path", ok: pathOk, message: pathMsg, value: globalPrefix ? path.join(globalPrefix, "bin") : null });

  // npm cache dir
  const cacheDir = run("npm", ["config", "get", "cache"]);
  let cacheOk = false;
  let cacheMsg = "Cannot determine cache directory";
  if (cacheDir) {
    try {
      await fs.access(cacheDir, fs.constants.W_OK);
      cacheOk = true;
      cacheMsg = `Cache dir writable: ${cacheDir}`;
    } catch {
      cacheMsg = `Cache dir not writable: ${cacheDir}`;
    }
  }
  checks.push({ name: "npm-cache-writable", ok: cacheOk, message: cacheMsg, value: cacheDir });

  // Check for legacy npm config issues
  const userNpmrc = path.join(os.homedir(), ".npmrc");
  let npmrcIssues = [];
  try {
    const content = await fs.readFile(userNpmrc, "utf8");
    if (content.includes("registry=http://")) {
      npmrcIssues.push("Non-HTTPS registry URL found in .npmrc");
    }
    if (content.includes("unsafe-perm=true")) {
      npmrcIssues.push("unsafe-perm=true is set (security risk)");
    }
    if (content.match(/\/\/.*:_authToken\s*=/)) {
      // authToken present — check if it's scoped
    }
  } catch { /* no .npmrc */ }
  checks.push({
    name: "npmrc-config",
    ok: npmrcIssues.length === 0,
    message: npmrcIssues.length === 0 ? "~/.npmrc looks clean" : npmrcIssues.join("; "),
    value: npmrcIssues,
  });

  // Proxy settings
  const httpProxy = process.env.HTTP_PROXY || process.env.http_proxy || run("npm", ["config", "get", "proxy"]);
  const httpsProxy = process.env.HTTPS_PROXY || process.env.https_proxy || run("npm", ["config", "get", "https-proxy"]);
  const hasProxy = (httpProxy && httpProxy !== "null") || (httpsProxy && httpsProxy !== "null");
  checks.push({
    name: "proxy",
    ok: true,
    message: hasProxy ? `Proxy detected: ${httpProxy || httpsProxy}` : "No proxy configured",
    value: { http: httpProxy, https: httpsProxy },
  });

  // npm registry connectivity
  let registryOk = false;
  let registryMsg = "Could not check registry connectivity";
  const registryUrl = run("npm", ["config", "get", "registry"]) || "https://registry.npmjs.org/";
  try {
    const pingResult = run("npm", ["ping", "--registry", registryUrl]);
    registryOk = pingResult !== null;
    registryMsg = registryOk ? `Registry reachable: ${registryUrl}` : `Registry unreachable: ${registryUrl}`;
  } catch {
    registryMsg = `Registry check failed: ${registryUrl}`;
  }
  checks.push({ name: "registry-connectivity", ok: registryOk, message: registryMsg, value: registryUrl });

  const passed = checks.filter(c => c.ok).length;
  const failed = checks.filter(c => !c.ok).length;

  if (values.json) {
    printJson({ ok: failed === 0, kind: "better.env-doctor", passed, failed, checks });
    if (failed > 0) process.exitCode = 1;
    return;
  }

  for (const c of checks) {
    const icon = c.ok ? "\x1b[32m✔\x1b[0m" : "\x1b[31m✘\x1b[0m";
    printText(`  ${icon}  ${c.message}`);
  }

  printText("");
  if (failed === 0) {
    printText(`\x1b[32m✔ All ${passed} checks passed.\x1b[0m`);
  } else {
    printText(`\x1b[31m✘ ${failed} check(s) failed, ${passed} passed.\x1b[0m`);
    process.exitCode = 1;
  }
  printText("");
}
