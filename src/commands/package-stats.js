/**
 * better package-stats — show aggregate statistics about dependencies
 *
 * Computes statistics about the installed packages: total count,
 * sizes, ages, license breakdown, and dependency depth distribution.
 *
 * Usage:
 *   better package-stats
 *   better package-stats --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

function fmtBytes(n) {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

async function getDirSize(dir) {
  let total = 0;
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) total += await getDirSize(p);
      else if (e.isFile()) { try { total += (await fs.stat(p)).size; } catch {} }
    }
  } catch {}
  return total;
}

async function scanAllPackages(nmPath) {
  const packages = [];
  try {
    const entries = await fs.readdir(nmPath, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;

      if (e.name.startsWith("@")) {
        const scoped = await fs.readdir(path.join(nmPath, e.name), { withFileTypes: true }).catch(() => []);
        for (const s of scoped) {
          if (!s.isDirectory()) continue;
          const dir = path.join(nmPath, e.name, s.name);
          const pkg = await readPkg(dir);
          if (pkg) packages.push({ ...pkg, dir });
        }
      } else {
        const dir = path.join(nmPath, e.name);
        const pkg = await readPkg(dir);
        if (pkg) packages.push({ ...pkg, dir });
      }
    }
  } catch {}
  return packages;
}

async function readPkg(dir) {
  try {
    const p = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8"));
    return {
      name: p.name,
      version: p.version,
      license: typeof p.license === "object" ? p.license?.type : p.license,
      hasTypes: !!(p.types || p.typings),
      hasScripts: !!(p.scripts?.install || p.scripts?.postinstall || p.scripts?.preinstall),
      depCount: Object.keys(p.dependencies || {}).length,
    };
  } catch { return null; }
}

export async function cmdPackageStats(argv) {
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
    printText(`Usage: better package-stats [options]

Show aggregate statistics about installed packages.

Options:
  --json       Machine-readable output
  -h, --help   Show this help
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;
  const nmPath = path.join(projectRoot, "node_modules");

  if (!values.json) {
    process.stderr.write(`\x1b[90mAnalyzing node_modules…\x1b[0m\n`);
  }

  const [packages, nmSize] = await Promise.all([
    scanAllPackages(nmPath),
    getDirSize(nmPath),
  ]);

  // License breakdown
  const licenseMap = new Map();
  for (const p of packages) {
    const lic = p.license || "UNKNOWN";
    licenseMap.set(lic, (licenseMap.get(lic) || 0) + 1);
  }
  const topLicenses = [...licenseMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);

  // Stats
  const withTypes = packages.filter(p => p.hasTypes).length;
  const withInstallScripts = packages.filter(p => p.hasScripts).length;
  const avgDeps = packages.length
    ? Math.round(packages.reduce((s, p) => s + p.depCount, 0) / packages.length * 10) / 10
    : 0;
  const maxDeps = Math.max(...packages.map(p => p.depCount), 0);
  const topByDeps = packages
    .sort((a, b) => b.depCount - a.depCount)
    .slice(0, 5)
    .map(p => ({ name: p.name, version: p.version, deps: p.depCount }));

  const stats = {
    totalPackages: packages.length,
    totalSize: nmSize,
    avgSizePerPackage: packages.length ? Math.round(nmSize / packages.length) : 0,
    withTypes,
    withInstallScripts,
    avgDependenciesPerPackage: avgDeps,
    maxDependenciesInPackage: maxDeps,
    licenseBreakdown: Object.fromEntries(topLicenses),
    mostDependencies: topByDeps,
  };

  if (values.json) {
    printJson({
      ok: true,
      kind: "better.package-stats",
      ...stats,
    });
    return;
  }

  printText(`\n\x1b[1mbetter package-stats\x1b[0m\n`);
  printText(`  Packages installed:     \x1b[1m${stats.totalPackages}\x1b[0m`);
  printText(`  Total size:             \x1b[1m${fmtBytes(stats.totalSize)}\x1b[0m`);
  printText(`  Avg size per package:   ${fmtBytes(stats.avgSizePerPackage)}`);
  printText(`  With TypeScript types:  ${stats.withTypes} (${Math.round(stats.withTypes / stats.totalPackages * 100)}%)`);
  printText(`  With install scripts:   \x1b[${withInstallScripts > 10 ? "33" : "90"}m${stats.withInstallScripts}\x1b[0m`);
  printText(`  Avg deps per package:   ${stats.avgDependenciesPerPackage}`);
  printText("");

  printText(`\x1b[90mTop licenses:\x1b[0m`);
  for (const [lic, count] of topLicenses) {
    const bar = "█".repeat(Math.round(count / packages.length * 20));
    printText(`  ${lic.padEnd(20)} ${String(count).padEnd(5)} \x1b[36m${bar}\x1b[0m`);
  }
  printText("");

  if (topByDeps.length > 0) {
    printText(`\x1b[90mMost dependencies:\x1b[0m`);
    for (const p of topByDeps) {
      printText(`  \x1b[1m${p.name}\x1b[0m@${p.version}  \x1b[90m${p.deps} deps\x1b[0m`);
    }
  }

  printText("");
}
