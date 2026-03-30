/**
 * better lock-health — comprehensive lockfile health analysis
 *
 * Analyzes package-lock.json or yarn.lock for health indicators:
 * size, duplicate packages, integrity fields, lockfile version,
 * and consistency with package.json.
 *
 * Usage:
 *   better lock-health
 *   better lock-health --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

function fmtBytes(n) {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${n}B`;
}

export async function cmdLockHealth(argv) {
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
    printText(`Usage: better lock-health [options]

Comprehensive lockfile health analysis.

Options:
  --json       Machine-readable output
  -h, --help   Show this help

Checks:
  • Lockfile existence and format (npm/yarn/pnpm)
  • Package count and file size
  • Missing integrity fields
  • Duplicate package versions
  • Consistency with package.json
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;

  if (!values.json) {
    printText(`\n\x1b[1mbetter lock-health\x1b[0m\n`);
  }

  // Detect lockfile type
  let lockfilePath = null;
  let lockfileType = null;
  for (const [file, type] of [
    ["package-lock.json", "npm"],
    ["yarn.lock", "yarn"],
    ["pnpm-lock.yaml", "pnpm"],
    ["bun.lockb", "bun"],
  ]) {
    try {
      await fs.access(path.join(projectRoot, file));
      lockfilePath = path.join(projectRoot, file);
      lockfileType = type;
      break;
    } catch {}
  }

  if (!lockfilePath) {
    const msg = "No lockfile found";
    if (values.json) { printJson({ ok: false, kind: "better.lock-health", error: msg }); } else { printText(`\x1b[33m⚠ ${msg}\x1b[0m\n`); }
    process.exitCode = 1;
    return;
  }

  const stat = await fs.stat(lockfilePath);
  const lockfileSize = stat.size;

  const checks = [];
  let packageCount = 0;
  let missingIntegrity = 0;
  let duplicateCount = 0;

  if (lockfileType === "npm") {
    let lockData;
    try {
      lockData = JSON.parse(await fs.readFile(lockfilePath, "utf8"));
    } catch {
      checks.push({ ok: false, label: "Lockfile is not valid JSON" });
      lockData = null;
    }

    if (lockData) {
      const lockVersion = lockData.lockfileVersion || 1;
      checks.push({
        ok: lockVersion >= 2,
        label: lockVersion >= 3 ? `lockfileVersion: ${lockVersion} (npm 7+ format)` :
               lockVersion >= 2 ? `lockfileVersion: ${lockVersion} (npm 7 format)` :
               `lockfileVersion: ${lockVersion} (legacy — run npm install to upgrade)`,
      });

      // Count packages and check integrity
      const packages = lockData.packages || lockData.dependencies || {};
      const versionMap = new Map();

      for (const [pkgPath, info] of Object.entries(packages)) {
        if (pkgPath === "") continue; // root
        packageCount++;
        if (!info.integrity && !info.bundled) missingIntegrity++;

        // Track duplicates (same name, different version)
        const name = pkgPath.replace(/^node_modules\//, "").replace(/\/node_modules\/[^/]+$/, "").split("node_modules/").pop();
        const version = info.version;
        if (name && version) {
          if (!versionMap.has(name)) versionMap.set(name, new Set());
          versionMap.get(name).add(version);
        }
      }

      for (const versions of versionMap.values()) {
        if (versions.size > 1) duplicateCount++;
      }

      checks.push({ ok: missingIntegrity === 0, label: missingIntegrity === 0 ? "All packages have integrity hashes" : `${missingIntegrity} packages missing integrity hash` });
      checks.push({ ok: duplicateCount === 0, label: duplicateCount === 0 ? "No duplicate package versions" : `${duplicateCount} packages have multiple versions installed` });

      // Check consistency with package.json
      let pkgJson = {};
      try { pkgJson = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8")); } catch {}
      const lockName = lockData.name;
      const pkgName = pkgJson.name;
      checks.push({ ok: !lockName || !pkgName || lockName === pkgName, label: lockName === pkgName ? "Package name consistent" : `Name mismatch: lock=${lockName}, pkg=${pkgName}` });
    }
  } else if (lockfileType === "yarn") {
    const content = await fs.readFile(lockfilePath, "utf8");
    packageCount = (content.match(/^"?[^"#\s]/mg) || []).length;
    checks.push({ ok: true, label: `Yarn lockfile detected` });
    checks.push({ ok: true, label: `${packageCount} entries in lockfile` });
  } else {
    checks.push({ ok: true, label: `${lockfileType} lockfile detected` });
  }

  const ok = checks.every(c => c.ok);

  if (values.json) {
    printJson({
      ok,
      kind: "better.lock-health",
      lockfileType,
      lockfileSize,
      packageCount,
      missingIntegrity,
      duplicateCount,
      checks,
    });
    if (!ok) process.exitCode = 1;
    return;
  }

  printText(`  Lockfile: \x1b[1m${path.basename(lockfilePath)}\x1b[0m  |  Size: ${fmtBytes(lockfileSize)}  |  Packages: ${packageCount}\n`);

  for (const c of checks) {
    const icon = c.ok ? "\x1b[32m✔\x1b[0m" : "\x1b[33m⚠\x1b[0m";
    printText(`  ${icon}  ${c.label}`);
  }

  printText("");
  if (ok) {
    printText(`\x1b[32m✔ Lockfile is healthy.\x1b[0m`);
  } else {
    printText(`\x1b[33m⚠ Some issues found. Run \`npm install\` to regenerate.\x1b[0m`);
    process.exitCode = 1;
  }
  printText("");
}
