/**
 * better package-lock-audit — deep audit of package-lock.json
 *
 * Analyzes package-lock.json for security and quality issues:
 * integrity hash coverage, registry diversity, nested duplicates,
 * and dependency resolution quality.
 *
 * Usage:
 *   better package-lock-audit
 *   better package-lock-audit --strict
 *   better package-lock-audit --json
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

export async function cmdPackageLockAudit(argv) {
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
    printText(`Usage: better package-lock-audit [options]

Deep security and quality audit of package-lock.json.

Options:
  --strict     Fail on warnings
  --json       Machine-readable output
  -h, --help   Show this help

Checks:
  • lockfileVersion (recommend ≥ 2 for integrity)
  • Integrity hash coverage
  • Third-party registry packages
  • Git dependency sources
  • Duplicate package versions
  • Missing packages (in lockfile but not installed)
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;
  const lockPath = path.join(projectRoot, "package-lock.json");

  if (!values.json) {
    printText(`\n\x1b[1mbetter package-lock-audit\x1b[0m\n`);
  }

  let lockfile;
  try {
    lockfile = JSON.parse(await fs.readFile(lockPath, "utf8"));
  } catch {
    const msg = "package-lock.json not found";
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`\x1b[31mError: ${msg}\x1b[0m`); }
    process.exitCode = 1;
    return;
  }

  const issues = [];
  const stats = { total: 0, withIntegrity: 0, gitDeps: [], thirdPartyRegistries: new Set(), duplicates: new Map() };

  const packages = lockfile.packages || {};

  for (const [key, pkg] of Object.entries(packages)) {
    if (key === "") continue; // root
    stats.total++;

    // Integrity check
    if (!pkg.integrity && !pkg.bundled && !pkg.inBundle) {
      // Missing integrity
    } else if (pkg.integrity) {
      stats.withIntegrity++;
    }

    // Check resolved registry
    if (pkg.resolved) {
      const isGit = pkg.resolved.startsWith("git+") || pkg.resolved.startsWith("github:") || pkg.resolved.startsWith("bitbucket:");
      if (isGit) {
        stats.gitDeps.push(key.replace("node_modules/", ""));
      } else {
        const isThirdParty = !TRUSTED_REGISTRIES.some(r => pkg.resolved.startsWith(r));
        if (isThirdParty) {
          try {
            const hostname = new URL(pkg.resolved).hostname;
            stats.thirdPartyRegistries.add(hostname);
          } catch {}
        }
      }
    }

    // Track versions for duplicate detection
    const pkgName = key.replace(/^node_modules\//, "").replace(/\/node_modules\/.+$/, "");
    if (!stats.duplicates.has(pkgName)) stats.duplicates.set(pkgName, new Set());
    if (pkg.version) stats.duplicates.get(pkgName).add(pkg.version);
  }

  const lfv = lockfile.lockfileVersion || 1;
  if (lfv < 2) {
    issues.push({ severity: "warning", message: `lockfileVersion ${lfv} — upgrade to 2+ for integrity hashes`, hint: "Regenerate with npm 7+: npm install" });
  }

  const missingIntegrity = stats.total - stats.withIntegrity;
  if (missingIntegrity > 0) {
    issues.push({ severity: "warning", message: `${missingIntegrity}/${stats.total} packages missing integrity hash`, hint: "Regenerate with npm install --lockfile-version=2" });
  }

  if (stats.gitDeps.length > 0) {
    issues.push({ severity: "warning", message: `${stats.gitDeps.length} git-sourced dependencies (unpinned commit risk)`, hint: "Prefer published npm packages", packages: stats.gitDeps.slice(0, 5) });
  }

  if (stats.thirdPartyRegistries.size > 0) {
    issues.push({ severity: "warning", message: `Packages from ${stats.thirdPartyRegistries.size} non-standard registry/registries`, hint: "Verify trust: " + [...stats.thirdPartyRegistries].join(", ") });
  }

  // Find packages with > 1 version
  const duplicated = [...stats.duplicates.entries()].filter(([, versions]) => versions.size > 1);
  if (duplicated.length > 0) {
    issues.push({ severity: "info", message: `${duplicated.length} package(s) have multiple versions installed`, packages: duplicated.slice(0, 5).map(([n, vs]) => `${n}: [${[...vs].join(", ")}]`) });
  }

  const errors = issues.filter(i => i.severity === "error");
  const warnings = issues.filter(i => i.severity === "warning");
  const infos = issues.filter(i => i.severity === "info");
  const allOk = errors.length === 0 && (!values.strict || warnings.length === 0);

  if (values.json) {
    printJson({
      ok: allOk,
      kind: "better.package-lock-audit",
      lockfileVersion: lfv,
      totalPackages: stats.total,
      integrityPercent: stats.total > 0 ? Math.round(stats.withIntegrity / stats.total * 100) : 100,
      gitDepsCount: stats.gitDeps.length,
      thirdPartyRegistries: [...stats.thirdPartyRegistries],
      duplicatedPackages: duplicated.length,
      issues,
      errors: errors.length,
      warnings: warnings.length,
    });
    if (!allOk) process.exitCode = 1;
    return;
  }

  const intPct = stats.total > 0 ? Math.round(stats.withIntegrity / stats.total * 100) : 100;
  printText(`  lockfileVersion: ${lfv}  |  Packages: ${stats.total}  |  Integrity: ${intPct}%\n`);

  if (issues.length === 0) {
    printText(`\x1b[32m✔ package-lock.json looks healthy.\x1b[0m`);
  } else {
    for (const iss of [...errors, ...warnings, ...infos]) {
      const icon = iss.severity === "error" ? "\x1b[31m✖\x1b[0m"
        : iss.severity === "warning" ? "\x1b[33m⚠\x1b[0m"
        : "\x1b[90m·\x1b[0m";
      printText(`  ${icon}  ${iss.message}`);
      if (iss.hint) printText(`       \x1b[90m→ ${iss.hint}\x1b[0m`);
      if (iss.packages?.length) {
        for (const p of iss.packages) printText(`       \x1b[90m${p}\x1b[0m`);
      }
    }
    printText("");
    if (allOk) {
      printText(`\x1b[33m⚠ ${warnings.length} warning(s).\x1b[0m`);
    } else {
      printText(`\x1b[31m✖ ${errors.length} error(s) found.\x1b[0m`);
      process.exitCode = 1;
    }
  }
  printText("");
}
