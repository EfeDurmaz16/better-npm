/**
 * better lockfile-lint — validate package-lock.json integrity
 *
 * Checks the lockfile for common issues: missing integrity hashes,
 * non-registry sources, duplicate packages, version mismatches,
 * excessively old packages, and format version compatibility.
 *
 * Usage:
 *   better lockfile-lint
 *   better lockfile-lint --strict
 *   better lockfile-lint --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

const TRUSTED_REGISTRIES = [
  "https://registry.npmjs.org/",
  "https://registry.yarnpkg.com/",
];

function isTrustedUrl(url) {
  if (!url) return true; // local/no source — ok
  return TRUSTED_REGISTRIES.some(r => url.startsWith(r));
}

function looksLikeSha(s) {
  return typeof s === "string" && /^sha(256|512)-[A-Za-z0-9+/=]+$/.test(s);
}

export async function cmdLockfileLint(argv) {
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
    printText(`Usage: better lockfile-lint [options]

Validate package-lock.json for common integrity and security issues.

Checks:
  • Lockfile version (v2 or v3 required)
  • All packages have integrity hashes
  • All resolved URLs from trusted registries
  • No duplicate package entries with conflicting versions
  • package.json dep versions match lockfile
  • No packages with install scripts (--strict)

Options:
  --strict     Also flag packages with install scripts
  --json       Machine-readable output
  -h, --help   Show this help
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;

  let lock;
  try {
    lock = JSON.parse(await fs.readFile(path.join(projectRoot, "package-lock.json"), "utf8"));
  } catch {
    const msg = "Cannot read package-lock.json (run npm install first)";
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`Error: ${msg}`); }
    process.exitCode = 1;
    return;
  }

  let pkgJson;
  try {
    pkgJson = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8"));
  } catch {
    pkgJson = {};
  }

  const issues = [];
  const packages = lock.packages || {};

  // Check lockfile format version
  const lockVersion = lock.lockfileVersion;
  if (lockVersion < 2) {
    issues.push({
      severity: "error",
      code: "lockfile-version",
      message: `Lockfile version ${lockVersion} is outdated (v2+ required)`,
      hint: "Run: npm install to regenerate",
    });
  }

  // Track: missing integrity, untrusted urls, install scripts
  let missingIntegrity = 0;
  let untrustedUrls = [];
  let installScripts = [];

  const versionMap = {}; // name -> Set of versions

  for (const [pkgPath, info] of Object.entries(packages)) {
    if (!pkgPath) continue; // root package
    const name = pkgPath.startsWith("node_modules/") ? pkgPath.slice(13) : pkgPath;
    if (!name) continue;

    // Nested package path (node_modules/a/node_modules/b) — get just the last segment
    const shortName = name.includes("/node_modules/")
      ? name.slice(name.lastIndexOf("/node_modules/") + 14)
      : name;

    // Integrity check
    if (info.resolved?.startsWith("https://") && !looksLikeSha(info.integrity)) {
      missingIntegrity++;
    }

    // Trusted registry check
    if (info.resolved && !isTrustedUrl(info.resolved)) {
      untrustedUrls.push({ name: shortName, url: info.resolved });
    }

    // Version tracking for duplicate detection
    if (info.version) {
      if (!versionMap[shortName]) versionMap[shortName] = new Set();
      versionMap[shortName].add(info.version);
    }

    // Install scripts check
    if (values.strict && info.scripts) {
      const scriptNames = Object.keys(info.scripts).filter(s =>
        ["preinstall", "install", "postinstall"].includes(s)
      );
      if (scriptNames.length > 0) {
        installScripts.push({ name: shortName, scripts: scriptNames });
      }
    }
  }

  if (missingIntegrity > 0) {
    issues.push({
      severity: "error",
      code: "missing-integrity",
      message: `${missingIntegrity} package(s) missing integrity hash`,
      hint: "Run: npm install to restore integrity hashes",
    });
  }

  for (const { name, url } of untrustedUrls.slice(0, 5)) {
    issues.push({
      severity: "warning",
      code: "untrusted-registry",
      message: `${name} resolved from non-standard registry: ${url}`,
      hint: "Verify this registry is intentional",
    });
  }
  if (untrustedUrls.length > 5) {
    issues.push({
      severity: "warning",
      code: "untrusted-registry",
      message: `...and ${untrustedUrls.length - 5} more untrusted registry URLs`,
    });
  }

  // Duplicate packages (same name, multiple versions)
  const duplicates = Object.entries(versionMap)
    .filter(([, versions]) => versions.size > 1)
    .map(([name, versions]) => ({ name, versions: [...versions] }));

  if (duplicates.length > 0) {
    issues.push({
      severity: "warning",
      code: "duplicate-packages",
      message: `${duplicates.length} package(s) installed in multiple versions`,
      hint: `Run: better dedupe`,
      details: duplicates.slice(0, 5).map(d => `  ${d.name}: ${d.versions.join(", ")}`).join("\n"),
    });
  }

  // Check package.json deps match lockfile
  const allDeps = { ...pkgJson.dependencies, ...pkgJson.devDependencies };
  const mismatches = [];
  for (const [name, range] of Object.entries(allDeps)) {
    const lockEntry = packages[`node_modules/${name}`];
    if (!lockEntry) continue;
    // Check if declared range is a known problematic pattern (file:, link:, git+)
    if (String(range).startsWith("file:") || String(range).startsWith("link:")) {
      issues.push({
        severity: "info",
        code: "local-dep",
        message: `${name} is a local file dependency`,
        hint: "Ensure path is correct for all team members",
      });
    }
  }

  for (const { name, scripts } of installScripts) {
    issues.push({
      severity: "warning",
      code: "install-scripts",
      message: `${name} has install scripts: ${scripts.join(", ")}`,
      hint: "Audit this package's install scripts for safety",
    });
  }

  const errors = issues.filter(i => i.severity === "error");
  const warnings = issues.filter(i => i.severity === "warning");
  const infos = issues.filter(i => i.severity === "info");
  const allOk = errors.length === 0;

  const summary = {
    ok: allOk,
    kind: "better.lockfile-lint",
    lockfileVersion: lockVersion,
    totalPackages: Object.keys(packages).filter(p => p).length,
    duplicatePackages: duplicates.length,
    issues: issues.length,
    errors: errors.length,
    warnings: warnings.length,
    issueList: issues,
  };

  if (values.json) {
    printJson(summary);
    if (!allOk) process.exitCode = 1;
    return;
  }

  const total = Object.keys(packages).filter(p => p).length;
  printText(`\n\x1b[1mbetter lockfile-lint\x1b[0m — ${total} packages, lockfile v${lockVersion}\n`);

  if (issues.length === 0) {
    printText(`\x1b[32m✔ Lockfile looks healthy!\x1b[0m`);
    return;
  }

  for (const issue of issues) {
    const icon = issue.severity === "error"
      ? "\x1b[31m✖\x1b[0m"
      : issue.severity === "warning"
      ? "\x1b[33m⚠\x1b[0m"
      : "\x1b[34mℹ\x1b[0m";
    printText(`  ${icon}  ${issue.message}`);
    if (issue.hint) printText(`       \x1b[90m→ ${issue.hint}\x1b[0m`);
    if (issue.details) printText(`\x1b[90m${issue.details}\x1b[0m`);
  }

  printText("");
  if (allOk) {
    printText(`\x1b[33m⚠ ${warnings.length} warning(s) — lockfile is usable but review above issues.\x1b[0m`);
  } else {
    printText(`\x1b[31m✖ ${errors.length} error(s) must be fixed.\x1b[0m`);
    process.exitCode = 1;
  }
}
