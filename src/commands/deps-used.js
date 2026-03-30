/**
 * better deps-used — show which source files use each dependency
 *
 * Scans source files and builds a reverse mapping of which package
 * is imported by which files. Useful for understanding coupling
 * and preparing dependency removals.
 *
 * Usage:
 *   better deps-used
 *   better deps-used lodash express
 *   better deps-used --min-files 3
 *   better deps-used --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

const IMPORT_RE = [
  /\bimport\s+(?:[^'";\n]*?\s+from\s+)?['"]([^'"]+)['"]/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage", ".cache"]);
const JS_EXT = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"]);

async function collectFiles(dir) {
  const files = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        files.push(...(await collectFiles(full)));
      } else if (e.isFile() && JS_EXT.has(path.extname(e.name))) {
        files.push(full);
      }
    }
  } catch {}
  return files;
}

function extractPackageName(spec) {
  if (spec.startsWith(".") || spec.startsWith("/")) return null;
  if (spec.startsWith("@")) {
    const parts = spec.split("/");
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
  }
  return spec.split("/")[0];
}

function extractImportedPackages(content) {
  const pkgs = new Set();
  for (const re of IMPORT_RE) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(content)) !== null) {
      const pkg = extractPackageName(m[1]);
      if (pkg) pkgs.add(pkg);
    }
  }
  return [...pkgs];
}

export async function cmdDepsUsed(argv) {
  const runtime = getRuntimeConfig();
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json:       { type: "boolean", default: runtime.json === true },
      help:       { type: "boolean", short: "h", default: false },
      "min-files":{ type: "string", default: "1" },
      sort:       { type: "string", default: "files" },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better deps-used [packages...] [options]

Show which source files import each dependency.

Options:
  --min-files <n>  Only show deps imported in >= n files (default: 1)
  --sort <by>      Sort by: files (default), name
  --json           Machine-readable output
  -h, --help       Show this help

Examples:
  better deps-used
  better deps-used lodash react
  better deps-used --min-files 3
`);
    return;
  }

  const minFiles = parseInt(values["min-files"]) || 1;
  const sortBy = values.sort || "files";

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

  const declaredDeps = new Set(Object.keys({ ...pkgJson.dependencies, ...pkgJson.devDependencies }));

  if (!values.json) {
    process.stderr.write(`\x1b[90mScanning source files…\x1b[0m\n`);
  }

  // Collect all source files
  const srcDir = path.join(projectRoot, "src");
  let sourceFiles;
  try {
    await fs.access(srcDir);
    sourceFiles = await collectFiles(srcDir);
  } catch {
    sourceFiles = (await collectFiles(projectRoot)).filter(f => !f.includes("node_modules"));
  }

  // Build usage map: pkg → Set of relative file paths
  const usageMap = new Map();

  for (const file of sourceFiles) {
    let content;
    try { content = await fs.readFile(file, "utf8"); } catch { continue; }

    const pkgs = extractImportedPackages(content);
    const relFile = path.relative(projectRoot, file);

    for (const pkg of pkgs) {
      if (!usageMap.has(pkg)) usageMap.set(pkg, new Set());
      usageMap.get(pkg).add(relFile);
    }
  }

  // Filter to declared deps only (or requested targets)
  const targets = positionals.length > 0 ? positionals : [...declaredDeps];
  const results = [];

  for (const pkg of targets) {
    const files = [...(usageMap.get(pkg) || [])];
    if (files.length >= minFiles) {
      results.push({ name: pkg, fileCount: files.length, files: files.sort() });
    }
  }

  // Sort
  results.sort((a, b) => {
    if (sortBy === "name") return a.name.localeCompare(b.name);
    return b.fileCount - a.fileCount;
  });

  if (values.json) {
    printJson({
      ok: true,
      kind: "better.deps-used",
      filesScanned: sourceFiles.length,
      depsFound: results.length,
      packages: results,
    });
    return;
  }

  printText(`\n\x1b[1mbetter deps-used\x1b[0m — ${sourceFiles.length} files scanned, ${results.length} package(s)\n`);

  if (results.length === 0) {
    printText(`\x1b[90mNo imports found (min-files: ${minFiles}).\x1b[0m`);
    return;
  }

  for (const r of results) {
    const inDeps = declaredDeps.has(r.name);
    const tag = inDeps ? "" : " \x1b[33m[undeclared]\x1b[0m";
    printText(`  \x1b[1m${r.name}\x1b[0m${tag}  \x1b[90m${r.fileCount} file(s)\x1b[0m`);

    const shown = r.files.slice(0, 5);
    for (const f of shown) printText(`    \x1b[90m${f}\x1b[0m`);
    if (r.files.length > 5) {
      printText(`    \x1b[90m... and ${r.files.length - 5} more\x1b[0m`);
    }
  }

  printText("");
}
