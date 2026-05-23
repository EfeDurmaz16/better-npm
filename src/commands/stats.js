/**
 * better stats — project dependency statistics
 *
 * Shows a comprehensive summary of dependency counts, sizes,
 * license distribution, and health indicators.
 *
 * Usage:
 *   better stats
 *   better stats --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";
import { runCalculateCasStatsNapi } from "../lib/core.js";

function fmtBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

async function walkSize(dirPath, depth = 0) {
  let size = 0;
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        if (depth < 3) size += await walkSize(full, depth + 1);
      } else {
        try { size += (await fs.stat(full)).size; } catch {}
      }
    }
  } catch {}
  return size;
}

async function countFilesInDir(dirPath) {
  let count = 0;
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        count += await countFilesInDir(path.join(dirPath, entry.name));
      } else {
        count++;
      }
    }
  } catch {}
  return count;
}

export async function cmdStats(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: runtime.json === true },
      cas: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better stats [options]

Show project dependency statistics.

Options:
  --json       Machine-readable output
  -h, --help   Show this help
`);
    return;
  }

  const cwd = process.cwd();

  // CAS stats via NAPI
  if (values.cas) {
    const casResult = runCalculateCasStatsNapi();
    if (casResult?.ok) {
      if (values.json) { printJson({ ok: true, kind: "better.stats.cas", ...casResult.data }); return; }
      const d = casResult.data;
      printText([
        "better stats (CAS)",
        `- total packages: ${d?.total_packages ?? 0}`,
        `- total files: ${d?.total_files ?? 0}`,
        `- logical size: ${d?.total_logical_bytes ?? 0} bytes`,
        `- physical size: ${d?.total_physical_bytes ?? 0} bytes`,
        `- dedup savings: ${d?.dedup_savings_percent?.toFixed(1) ?? 0}%`,
      ].join("\n"));
      return;
    }
  }

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

  // Count deps
  const prodDeps = Object.keys(pkgJson.dependencies || {});
  const devDeps = Object.keys(pkgJson.devDependencies || {});
  const peerDeps = Object.keys(pkgJson.peerDependencies || {});
  const optDeps = Object.keys(pkgJson.optionalDependencies || {});

  // Read lock file for transitive count
  let lockData;
  let transitiveCount = 0;
  let lockFormat = "none";
  try {
    lockData = JSON.parse(await fs.readFile(path.join(projectRoot, "package-lock.json"), "utf8"));
    lockFormat = `npm v${lockData.lockfileVersion || "?"}`;
    transitiveCount = Object.keys(lockData.packages || {}).filter(k => k && k !== "").length;
  } catch {}

  // Scan node_modules
  const nmPath = path.join(projectRoot, "node_modules");
  let nmSize = 0;
  let nmPackageCount = 0;
  let nmFileCount = 0;
  let nmExists = false;

  try {
    await fs.access(nmPath);
    nmExists = true;
    if (!values.json) process.stderr.write("\x1b[90mCalculating node_modules size…\x1b[0m\n");
    nmSize = await walkSize(nmPath, 0);

    // Count packages (top-level + scoped)
    const nmEntries = await fs.readdir(nmPath, { withFileTypes: true });
    for (const entry of nmEntries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".")) continue;
      if (entry.name.startsWith("@")) {
        // Scoped packages
        const scopeEntries = await fs.readdir(path.join(nmPath, entry.name), { withFileTypes: true });
        nmPackageCount += scopeEntries.filter(e => e.isDirectory()).length;
      } else {
        nmPackageCount++;
      }
    }
  } catch {}

  // License distribution
  const licenses = {};
  if (nmExists) {
    try {
      const entries = await fs.readdir(nmPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        const pkgPath2 = path.join(nmPath, entry.name, "package.json");
        try {
          const pkg = JSON.parse(await fs.readFile(pkgPath2, "utf8"));
          const lic = pkg.license || pkg.licence || "Unknown";
          const licStr = typeof lic === "string" ? lic : (lic?.type || "Unknown");
          licenses[licStr] = (licenses[licStr] || 0) + 1;
        } catch {}
      }
    } catch {}
  }

  // Sort licenses by count
  const licenseList = Object.entries(licenses)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, count }));

  // Check for lock file health
  const hasLockFile = lockFormat !== "none";
  const isDepsInstalled = nmExists;

  // Count scripts in package.json
  const scripts = Object.keys(pkgJson.scripts || {});

  const stats = {
    project: {
      name: pkgJson.name || path.basename(projectRoot),
      version: pkgJson.version || "0.0.0",
      description: pkgJson.description || null,
    },
    dependencies: {
      production: prodDeps.length,
      development: devDeps.length,
      peer: peerDeps.length,
      optional: optDeps.length,
      total_direct: prodDeps.length + devDeps.length + peerDeps.length + optDeps.length,
      total_installed: transitiveCount,
    },
    node_modules: {
      exists: nmExists,
      packages: nmPackageCount,
      size_bytes: nmSize,
      size: fmtBytes(nmSize),
    },
    lockfile: {
      format: lockFormat,
      present: hasLockFile,
    },
    licenses: licenseList.slice(0, 10),
    scripts: scripts.length,
    script_names: scripts,
  };

  if (values.json) {
    printJson({ ok: true, kind: "better.stats", ...stats });
    return;
  }

  const name = stats.project.name;
  const ver = stats.project.version;

  printText(`\n\x1b[1mbetter stats — ${name}@${ver}\x1b[0m`);
  if (stats.project.description) printText(`\x1b[90m${stats.project.description}\x1b[0m`);
  printText("");

  printText("\x1b[1mDependencies\x1b[0m");
  printText(`  Production:    ${String(stats.dependencies.production).padStart(5)}`);
  printText(`  Development:   ${String(stats.dependencies.development).padStart(5)}`);
  if (peerDeps.length) printText(`  Peer:          ${String(stats.dependencies.peer).padStart(5)}`);
  if (optDeps.length) printText(`  Optional:      ${String(stats.dependencies.optional).padStart(5)}`);
  printText(`  ─────────────────────`);
  printText(`  Total direct:  ${String(stats.dependencies.total_direct).padStart(5)}`);
  if (transitiveCount > 0) {
    printText(`  Installed:     ${String(stats.dependencies.total_installed).padStart(5)}  \x1b[90m(incl. transitive)\x1b[0m`);
  }

  printText("");
  printText("\x1b[1mnode_modules\x1b[0m");
  if (!nmExists) {
    printText("  \x1b[33mNot installed\x1b[0m — run `better install`");
  } else {
    printText(`  Packages:  ${nmPackageCount}`);
    printText(`  Size:      ${fmtBytes(nmSize)}`);
  }

  printText("");
  printText("\x1b[1mLockfile\x1b[0m");
  printText(`  ${hasLockFile ? "\x1b[32m✔\x1b[0m" : "\x1b[31m✖\x1b[0m"} ${lockFormat}`);

  if (licenseList.length > 0) {
    printText("");
    printText("\x1b[1mTop Licenses\x1b[0m");
    for (const { name: lic, count } of licenseList.slice(0, 5)) {
      const bar = "█".repeat(Math.min(20, Math.round((count / licenseList[0].count) * 20)));
      printText(`  ${lic.padEnd(24)} \x1b[90m${bar}\x1b[0m ${count}`);
    }
  }

  if (scripts.length > 0) {
    printText("");
    printText(`\x1b[1mScripts\x1b[0m  (${scripts.length})`);
    printText(`  \x1b[90m${scripts.slice(0, 8).join(", ")}${scripts.length > 8 ? `, ...` : ""}\x1b[0m`);
  }

  printText("");
}
