/**
 * better size — bundle / install size impact (#20)
 *
 * Shows disk footprint of installed packages:
 *   - Own size: bytes in the package directory itself
 *   - Subtree size: own + all unique transitive deps
 *   - % of total node_modules
 *
 * Also integrated into `better why --size` and `better outdated --size`
 * via the shared bundleSize lib.
 *
 * Usage:
 *   better size                   # all direct deps
 *   better size lodash express    # specific packages
 *   better size --all             # all packages in node_modules
 *   better size --json
 */
import { parseArgs } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { printJson, printText } from "../lib/output.js";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";
import { sizeReport, dirSize, formatBytes } from "../lib/bundleSize.js";

const HELP = `better size — install size impact

Usage:
  better size [packages...]     Show size of direct deps (or named packages)
  better size --all             Show all packages in node_modules

Options:
  --all              Include all installed packages
  --project-root     Override project root
  --json             Machine-readable output
  -h, --help         Show help
`;

async function readDirectDeps(projectRoot) {
  try {
    const raw = await fs.readFile(path.join(projectRoot, "package.json"), "utf8");
    const pkg = JSON.parse(raw);
    return [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {})
    ];
  } catch {
    return [];
  }
}

async function listAllPackages(nodeModulesDir) {
  const names = [];
  try {
    const entries = await fs.readdir(nodeModulesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (entry.name.startsWith(".")) continue;
      if (entry.name.startsWith("@")) {
        // scoped packages
        const scopeDir = path.join(nodeModulesDir, entry.name);
        const scoped = await fs.readdir(scopeDir, { withFileTypes: true }).catch(() => []);
        for (const s of scoped) {
          if (s.isDirectory()) names.push(`${entry.name}/${s.name}`);
        }
      } else {
        names.push(entry.name);
      }
    }
  } catch { /* ignore */ }
  return names;
}

export async function cmdSize(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      all: { type: "boolean", default: false },
      "project-root": { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" }
    },
    allowPositionals: true,
    strict: false
  });

  if (values.help) { printText(HELP); return; }

  const cwd = process.cwd();
  const resolvedRoot = values["project-root"]
    ? { root: path.resolve(values["project-root"]) }
    : await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;

  const nodeModulesDir = path.join(projectRoot, "node_modules");

  let packageNames;
  if (positionals.length > 0) {
    packageNames = positionals;
  } else if (values.all) {
    packageNames = await listAllPackages(nodeModulesDir);
  } else {
    packageNames = await readDirectDeps(projectRoot);
  }

  if (packageNames.length === 0) {
    const msg = "No packages found.";
    if (values.json) { printJson({ ok: false, reason: msg }); } else { printText(msg); }
    return;
  }

  if (!values.json) {
    process.stderr.write(`\x1b[90mScanning ${packageNames.length} package(s)…\x1b[0m\n`);
  }

  const [report, totalSize] = await Promise.all([
    sizeReport(nodeModulesDir, packageNames),
    dirSize(nodeModulesDir)
  ]);

  const totalBytes = totalSize.bytes || 1;

  if (values.json) {
    printJson({
      ok: true,
      nodeModulesBytes: totalBytes,
      packages: report.map(p => ({
        ...p,
        pctOfTotal: +((p.subtreeBytes / totalBytes) * 100).toFixed(1)
      }))
    });
    return;
  }

  const COL_NAME  = 35;
  const COL_OWN   = 12;
  const COL_TREE  = 12;
  const COL_DEPS  = 6;
  const COL_PCT   = 7;

  const header =
    "Package".padEnd(COL_NAME) +
    "Own size".padStart(COL_OWN) +
    "  Subtree".padStart(COL_TREE) +
    "  Deps".padStart(COL_DEPS) +
    "  % total".padStart(COL_PCT);

  printText(`\nbetter size — ${packageNames.length} package(s) | node_modules: ${formatBytes(totalBytes)}\n`);
  printText("\x1b[90m" + "─".repeat(header.length) + "\x1b[0m");
  printText("\x1b[1m" + header + "\x1b[0m");
  printText("\x1b[90m" + "─".repeat(header.length) + "\x1b[0m");

  for (const pkg of report) {
    const pct = (pkg.subtreeBytes / totalBytes) * 100;
    const pctStr = pct.toFixed(1) + "%";
    const pctColor = pct > 10 ? "\x1b[31m" : pct > 5 ? "\x1b[33m" : "\x1b[90m";

    const name = pkg.name.slice(0, COL_NAME - 1).padEnd(COL_NAME);
    const own  = formatBytes(pkg.ownBytes).padStart(COL_OWN);
    const tree = formatBytes(pkg.subtreeBytes).padStart(COL_TREE);
    const deps = String(pkg.depCount).padStart(COL_DEPS);
    const pctFmt = pctColor + pctStr.padStart(COL_PCT) + "\x1b[0m";

    printText(name + own + "  " + tree + "  " + deps + "  " + pctFmt);
  }

  printText("\x1b[90m" + "─".repeat(header.length) + "\x1b[0m");

  // Top heavyweights
  const heavy = report.filter(p => p.subtreeBytes > 1024 * 1024);
  if (heavy.length > 0) {
    printText(`\n\x1b[1mHeavyweights (>1 MiB subtree):\x1b[0m ${heavy.map(p => `\x1b[33m${p.name}\x1b[0m ${formatBytes(p.subtreeBytes)}`).join(", ")}`);
  }

  const totalScanned = report.reduce((s, p) => s + p.subtreeBytes, 0);
  printText(`\nScanned subtree total: ${formatBytes(totalScanned)} of ${formatBytes(totalBytes)} node_modules`);
}
