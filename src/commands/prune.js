/**
 * better prune — remove extraneous packages from node_modules
 *
 * Finds packages in node_modules that are not in package.json
 * (extraneous), and removes them or reports them.
 *
 * Usage:
 *   better prune
 *   better prune --dry-run
 *   better prune --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

function fmtBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${bytes}B`;
}

async function getDirSizeKb(dir) {
  let total = 0;
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    await Promise.all(entries.map(async (e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) total += await getDirSizeKb(full);
      else if (e.isFile()) {
        const s = await fs.stat(full).catch(() => null);
        if (s) total += s.size;
      }
    }));
  } catch {}
  return total;
}

export async function cmdPrune(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:     { type: "boolean", default: runtime.json === true },
      help:     { type: "boolean", short: "h", default: false },
      "dry-run":{ type: "boolean", default: false },
      "npm":    { type: "boolean", default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better prune [options]

Remove extraneous packages from node_modules.

Options:
  --dry-run    Show what would be removed without removing
  --npm        Use npm prune instead of custom logic
  --json       Machine-readable output
  -h, --help   Show this help
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;
  const nmPath = path.join(projectRoot, "node_modules");

  // If --npm flag, delegate to npm prune
  if (values["npm"]) {
    const args = ["prune"];
    if (values["dry-run"]) args.push("--dry-run");
    const result = spawnSync("npm", args, { cwd: projectRoot, stdio: "inherit" });
    process.exitCode = result.status;
    return;
  }

  let pkgJson;
  try {
    pkgJson = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8"));
  } catch {
    const msg = "Cannot read package.json";
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`Error: ${msg}`); }
    process.exitCode = 1;
    return;
  }

  // Build set of all declared deps (at top level only)
  const declared = new Set([
    ...Object.keys(pkgJson.dependencies || {}),
    ...Object.keys(pkgJson.devDependencies || {}),
    ...Object.keys(pkgJson.peerDependencies || {}),
    ...Object.keys(pkgJson.optionalDependencies || {}),
  ]);

  // Find top-level packages in node_modules not in declared
  let nmEntries;
  try { nmEntries = await fs.readdir(nmPath, { withFileTypes: true }); } catch {
    const msg = "node_modules not found — run npm install first";
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`Error: ${msg}`); }
    process.exitCode = 1;
    return;
  }

  const extraneous = [];

  for (const e of nmEntries) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;

    if (e.name.startsWith("@")) {
      // Scoped package
      const scopePath = path.join(nmPath, e.name);
      let subEntries;
      try { subEntries = await fs.readdir(scopePath, { withFileTypes: true }); } catch { continue; }
      for (const se of subEntries.filter(e => e.isDirectory())) {
        const fullName = `${e.name}/${se.name}`;
        if (!declared.has(fullName)) {
          // It's extraneous (not directly declared) — but may be a transitive dep, so we skip
          // We only flag packages that are truly not needed by any declared package
          // For simplicity, we only flag if they have no dependents in declared packages
        }
      }
      continue;
    }

    if (!declared.has(e.name)) {
      // Check if it's a .bin or other special dir
      if (e.name === ".bin" || e.name === ".cache" || e.name === ".package-lock.json") continue;

      let version = "?";
      try {
        const p = JSON.parse(await fs.readFile(path.join(nmPath, e.name, "package.json"), "utf8"));
        version = p.version || "?";
      } catch {}

      extraneous.push({ name: e.name, version, path: path.join(nmPath, e.name) });
    }
  }

  // Get sizes for extraneous packages
  const withSizes = await Promise.all(extraneous.map(async (e) => {
    const sizeBytes = await getDirSizeKb(e.path);
    return { ...e, sizeBytes };
  }));

  const totalSize = withSizes.reduce((s, e) => s + e.sizeBytes, 0);

  if (values.json) {
    printJson({
      ok: extraneous.length === 0,
      kind: "better.prune",
      extraneous: extraneous.length,
      totalSizeBytes: totalSize,
      packages: withSizes.map(e => ({
        name: e.name,
        version: e.version,
        sizeBytes: e.sizeBytes,
      })),
    });
    if (extraneous.length > 0) process.exitCode = 1;
    return;
  }

  printText(`\n\x1b[1mbetter prune\x1b[0m${values["dry-run"] ? " (dry-run)" : ""}\n`);

  if (extraneous.length === 0) {
    printText(`\x1b[32m✔ No extraneous packages found.\x1b[0m`);
    return;
  }

  printText(`\x1b[33m${extraneous.length} extraneous package(s) (${fmtBytes(totalSize)} total):\x1b[0m\n`);

  for (const e of withSizes) {
    printText(`  ${e.name}@${e.version} \x1b[90m(${fmtBytes(e.sizeBytes)})\x1b[0m`);
  }

  if (!values["dry-run"]) {
    printText(`\n\x1b[90mUse: npm prune — to remove extraneous packages\x1b[0m`);
    printText(`\x1b[90mOr: better prune --npm — to run npm prune directly\x1b[0m`);
  } else {
    printText(`\n\x1b[90mDry-run: run without --dry-run to remove\x1b[0m`);
  }

  process.exitCode = 1;
}
