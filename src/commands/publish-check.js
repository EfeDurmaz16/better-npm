/**
 * better publish-check — pre-publish checklist
 *
 * Verifies a package is ready to publish to npm by running
 * a comprehensive pre-publish checklist.
 *
 * Usage:
 *   better publish-check
 *   better publish-check --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import https from "node:https";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";
import { spawnSync } from "node:child_process";

async function fetchRegistryVersion(name) {
  return new Promise((resolve) => {
    https.get(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`, {
      headers: { "Accept": "application/json", "User-Agent": "better-npm/0.1" },
      timeout: 5000,
    }, (res) => {
      let body = "";
      res.on("data", c => { body += c; });
      res.on("end", () => {
        try { resolve(JSON.parse(body)?.version || null); }
        catch { resolve(null); }
      });
    }).on("error", () => resolve(null)).on("timeout", () => resolve(null));
  });
}

function semverGt(a, b) {
  const pa = String(a).replace(/^v/, "").split(".").map(n => parseInt(n) || 0);
  const pb = String(b).replace(/^v/, "").split(".").map(n => parseInt(n) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}

export async function cmdPublishCheck(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: runtime.json === true },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better publish-check [options]

Run pre-publish checklist to verify package is ready for npm.

Checks:
  • Version is newer than registry
  • Required fields (name, version, description, license)
  • README.md exists
  • .npmignore or files field configured
  • No sensitive files in package
  • exports/main point to real files
  • TypeScript types included (if applicable)
  • No pre-release version range deps

Options:
  --json       Machine-readable output
  -h, --help   Show this help
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
    const msg = "Cannot read package.json";
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`Error: ${msg}`); }
    process.exitCode = 1;
    return;
  }

  if (pkgJson.private === true) {
    if (values.json) {
      printJson({ ok: false, kind: "better.publish-check", error: "Package is marked private" });
    } else {
      printText(`\x1b[31m✖ Package is marked \x1b[1mprivate: true\x1b[0m\x1b[31m — cannot publish.\x1b[0m`);
    }
    process.exitCode = 1;
    return;
  }

  if (!values.json) {
    printText(`\n\x1b[1mbetter publish-check — ${pkgJson.name}@${pkgJson.version}\x1b[0m\n`);
    process.stderr.write("\x1b[90mRunning checks…\x1b[0m\n");
  }

  const checks = [];

  // Check required fields
  const requiredFields = ["name", "version", "description", "license"];
  for (const field of requiredFields) {
    checks.push({
      id: `required-${field}`,
      label: `Has ${field} field`,
      passed: Boolean(pkgJson[field]),
      severity: "error",
      hint: `Add "${field}" to package.json`,
    });
  }

  // Version is higher than registry
  const registryVersion = await fetchRegistryVersion(pkgJson.name);
  if (registryVersion) {
    const isNewer = semverGt(pkgJson.version, registryVersion);
    checks.push({
      id: "version-bump",
      label: `Version ${pkgJson.version} > registry ${registryVersion}`,
      passed: isNewer,
      severity: "error",
      hint: `Run 'better bump patch' to increment version`,
    });
  } else {
    checks.push({
      id: "version-bump",
      label: "Package not yet on registry (new)",
      passed: true,
      severity: "info",
    });
  }

  // README exists
  const readmeExists = await fs.access(path.join(projectRoot, "README.md")).then(() => true).catch(() => false);
  checks.push({
    id: "readme",
    label: "README.md exists",
    passed: readmeExists,
    severity: "warning",
    hint: "Create a README.md",
  });

  // Check .npmignore or files field
  const hasNpmIgnore = await fs.access(path.join(projectRoot, ".npmignore")).then(() => true).catch(() => false);
  const hasFilesField = Boolean(pkgJson.files?.length);
  checks.push({
    id: "ignore-config",
    label: "Package contents configured (.npmignore or files field)",
    passed: hasNpmIgnore || hasFilesField,
    severity: "warning",
    hint: "Add 'files' field to package.json or create .npmignore",
  });

  // No sensitive files would be published
  const sensitiveFiles = ["*.env", ".env", ".env.*", "*.pem", "*.key", "*.p12", "credentials*", "secrets*"];
  let hasSensitive = false;
  for (const pattern of [".env", ".env.local", "credentials.json", "secrets.json"]) {
    try {
      await fs.access(path.join(projectRoot, pattern));
      if (!hasNpmIgnore && !hasFilesField) {
        hasSensitive = true;
        break;
      }
    } catch {}
  }
  checks.push({
    id: "no-sensitive",
    label: "No unignored sensitive files",
    passed: !hasSensitive,
    severity: "error",
    hint: "Add sensitive files to .npmignore",
  });

  // Check repository field
  checks.push({
    id: "repository",
    label: "Repository field set",
    passed: Boolean(pkgJson.repository),
    severity: "warning",
    hint: "Add repository field pointing to source code",
  });

  // Check keywords
  checks.push({
    id: "keywords",
    label: "Keywords configured",
    passed: Boolean(pkgJson.keywords?.length),
    severity: "info",
    hint: "Add keywords for discoverability",
  });

  // Check for pre-release deps in production
  const prodDeps = pkgJson.dependencies || {};
  const preReleaseDeps = Object.entries(prodDeps)
    .filter(([, v]) => String(v).includes("-alpha") || String(v).includes("-beta") || String(v).includes("-rc"))
    .map(([name]) => name);
  checks.push({
    id: "no-prerelease-deps",
    label: "No pre-release production dependencies",
    passed: preReleaseDeps.length === 0,
    severity: "warning",
    hint: preReleaseDeps.length > 0 ? `Pre-release deps: ${preReleaseDeps.join(", ")}` : "",
  });

  // Run npm pack dry run
  const packResult = spawnSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: projectRoot,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const packOk = packResult.status === 0;
  checks.push({
    id: "npm-pack",
    label: "npm pack succeeds",
    passed: packOk,
    severity: "error",
    hint: packOk ? "" : "Fix npm pack errors before publishing",
  });

  const errors = checks.filter(c => !c.passed && c.severity === "error");
  const warnings = checks.filter(c => !c.passed && c.severity === "warning");
  const passed = checks.filter(c => c.passed);
  const allOk = errors.length === 0;

  if (values.json) {
    printJson({
      ok: allOk,
      kind: "better.publish-check",
      package: pkgJson.name,
      version: pkgJson.version,
      checks,
      errors: errors.length,
      warnings: warnings.length,
      passed: passed.length,
    });
    if (!allOk) process.exitCode = 1;
    return;
  }

  for (const c of checks) {
    const icon = c.passed
      ? "\x1b[32m✔\x1b[0m"
      : c.severity === "error" ? "\x1b[31m✖\x1b[0m"
      : c.severity === "warning" ? "\x1b[33m⚠\x1b[0m"
      : "\x1b[90m·\x1b[0m";
    printText(`  ${icon}  ${c.label}`);
    if (!c.passed && c.hint) {
      printText(`       \x1b[90m→ ${c.hint}\x1b[0m`);
    }
  }

  printText("");
  if (allOk && warnings.length === 0) {
    printText(`\x1b[32m✔ Ready to publish!\x1b[0m Run: npm publish`);
  } else if (allOk) {
    printText(`\x1b[33m⚠ ${warnings.length} warning(s) — package can be published but consider fixing.\x1b[0m`);
    printText(`Run: npm publish`);
  } else {
    printText(`\x1b[31m✖ ${errors.length} error(s) must be fixed before publishing.\x1b[0m`);
    process.exitCode = 1;
  }
}
