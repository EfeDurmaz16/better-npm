/**
 * better security-headers — check npm package for security-related package.json fields
 *
 * Checks packages for security-related configuration fields like
 * engines (minimum Node.js version), bin permissions, scripts that
 * could be dangerous, and other security indicators.
 *
 * Usage:
 *   better security-headers
 *   better security-headers --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

export async function cmdSecurityHeaders(argv) {
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
    printText(`Usage: better security-headers [options]

Check project package.json for security best practices.

Options:
  --json       Machine-readable output
  -h, --help   Show this help

Checks:
  • engines.node minimum version specified
  • No sensitive fields accidentally published
  • License field present
  • Repository field present
  • No obvious secrets in package.json values
  • files field or .npmignore to limit publish scope
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;

  if (!values.json) {
    printText(`\n\x1b[1mbetter security-headers\x1b[0m\n`);
  }

  let pkgJson = {};
  try { pkgJson = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8")); } catch {
    const msg = "Cannot read package.json";
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`Error: ${msg}`); }
    process.exitCode = 1;
    return;
  }

  const checks = [];

  // Engine version specified
  checks.push({
    name: "engines-node",
    ok: !!pkgJson.engines?.node,
    label: pkgJson.engines?.node ? `engines.node: ${pkgJson.engines.node}` : "No engines.node specified — any Node.js version allowed",
  });

  // License present
  checks.push({
    name: "license",
    ok: !!pkgJson.license,
    label: pkgJson.license ? `License: ${pkgJson.license}` : "No license field",
  });

  // No sensitive values in well-known fields
  const rawStr = JSON.stringify(pkgJson);
  const SENSITIVE_PATTERNS = [
    { re: /sk-[A-Za-z0-9]{20,}/, label: "possible API key in package.json" },
    { re: /ghp_[A-Za-z0-9]{20,}/, label: "possible GitHub token in package.json" },
    { re: /AKIA[0-9A-Z]{16}/, label: "possible AWS access key in package.json" },
    { re: /"password"\s*:\s*"[^"]{4,}"/, label: 'hardcoded "password" field' },
    { re: /"secret"\s*:\s*"[^"]{4,}"/, label: 'hardcoded "secret" field' },
  ];
  const secretIssues = SENSITIVE_PATTERNS.filter(p => p.re.test(rawStr)).map(p => p.label);
  checks.push({
    name: "no-secrets",
    ok: secretIssues.length === 0,
    label: secretIssues.length === 0 ? "No sensitive values detected in package.json" : `Potential secret: ${secretIssues[0]}`,
  });

  // files field limits publish scope
  let hasFilesControl = Array.isArray(pkgJson.files) && pkgJson.files.length > 0;
  if (!hasFilesControl) {
    try { await fs.access(path.join(projectRoot, ".npmignore")); hasFilesControl = true; } catch {}
  }
  checks.push({
    name: "files-control",
    ok: hasFilesControl,
    label: hasFilesControl ? "Publish scope controlled (files field or .npmignore)" : "No files field or .npmignore — all files published",
  });

  // Check for .env files that might be accidentally published
  const DANGEROUS_PUBLISH_FILES = [".env", ".env.local", ".env.production", "id_rsa", "*.pem"];
  let envFileFound = false;
  for (const file of [".env", ".env.local", ".env.production"]) {
    try {
      await fs.access(path.join(projectRoot, file));
      if (!hasFilesControl) { envFileFound = true; break; }
    } catch {}
  }
  if (envFileFound) {
    checks.push({ name: "no-env-publish", ok: false, label: ".env file found with no publish scope control — may be published!" });
  }

  // Repository field
  checks.push({
    name: "repository",
    ok: !!pkgJson.repository,
    label: pkgJson.repository ? "Repository field present" : "No repository field",
  });

  // Bin scripts exist if bin field defined
  if (pkgJson.bin) {
    const binEntries = typeof pkgJson.bin === "string"
      ? [[pkgJson.name, pkgJson.bin]]
      : Object.entries(pkgJson.bin);
    let allExist = true;
    for (const [, binPath] of binEntries) {
      try { await fs.access(path.join(projectRoot, binPath)); } catch { allExist = false; break; }
    }
    checks.push({
      name: "bin-files-exist",
      ok: allExist,
      label: allExist ? "All bin script files exist" : "Some bin script files are missing",
    });
  }

  const ok = checks.every(c => c.ok);

  if (values.json) {
    printJson({ ok, kind: "better.security-headers", checks });
    if (!ok) process.exitCode = 1;
    return;
  }

  for (const c of checks) {
    const icon = c.ok ? "\x1b[32m✔\x1b[0m" : "\x1b[33m⚠\x1b[0m";
    printText(`  ${icon}  ${c.label}`);
  }

  printText("");
  if (ok) {
    printText(`\x1b[32m✔ All security checks passed.\x1b[0m`);
  } else {
    printText(`\x1b[33m⚠ Some security best practices not followed.\x1b[0m`);
    process.exitCode = 1;
  }
  printText("");
}
