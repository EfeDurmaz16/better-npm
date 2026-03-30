/**
 * better find-unused-exports — find exported symbols not imported anywhere
 *
 * Scans JavaScript/TypeScript source files for exported functions,
 * classes, and variables that are never imported in any other file
 * in the project.
 *
 * Usage:
 *   better find-unused-exports
 *   better find-unused-exports --dir src
 *   better find-unused-exports --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

const EXTS = [".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx"];

const EXPORT_PATTERNS = [
  /^export\s+(?:async\s+)?function\s+(\w+)/,
  /^export\s+(?:const|let|var)\s+(\w+)/,
  /^export\s+class\s+(\w+)/,
  /^export\s+(?:type|interface)\s+(\w+)/,
  /^export\s+(?:default\s+)?(?:async\s+)?function\s+(\w+)/,
  /^export\s+\{\s*([^}]+)\}/,   // export { a, b as c }
];

const IMPORT_PATTERNS = [
  /import\s*\{([^}]+)\}\s*from\s*['"][^'"]+['"]/g,
  /import\s+(\w+)\s*from\s*['"][^'"]+['"]/g,
  /(?:require|import)\s*\(\s*['"][^'"]+['"]\s*\)\s*\.(\w+)/g,
];

async function collectFiles(dir, exts) {
  const files = [];
  async function walk(d, depth) {
    if (depth > 6) return;
    let entries;
    try { entries = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".") || ["node_modules", "dist", "build", "coverage", ".next"].includes(e.name)) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full, depth + 1);
      else if (e.isFile() && exts.includes(path.extname(e.name).toLowerCase())) files.push(full);
    }
  }
  await walk(dir, 0);
  return files;
}

function extractExports(content, filePath) {
  const exports = [];
  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    for (const pat of EXPORT_PATTERNS) {
      const m = trimmed.match(pat);
      if (m) {
        if (m[1] && m[1].includes(",")) {
          // export { a, b, c }
          const names = m[1].split(",").map(s => s.trim().replace(/\s+as\s+\w+/, "").trim()).filter(Boolean);
          exports.push(...names.map(n => ({ name: n, file: filePath })));
        } else if (m[1]) {
          exports.push({ name: m[1].trim(), file: filePath });
        }
      }
    }
    // export default
    if (/^export\s+default\s/.test(trimmed)) {
      exports.push({ name: "default", file: filePath });
    }
  }
  return exports;
}

function extractImports(content) {
  const imported = new Set();
  // Named imports: import { a, b } from '...'
  const namedRe = /import\s*\{([^}]+)\}\s*from\s*['"][^'"]+['"]/g;
  let m;
  while ((m = namedRe.exec(content)) !== null) {
    m[1].split(",").forEach(s => {
      const name = s.trim().replace(/\w+\s+as\s+(\w+)/, "$1").replace(/^(\w+)\s+as\s+\w+/, "$1").trim();
      if (name) imported.add(name);
    });
  }
  // Default imports: import Foo from '...'
  const defaultRe = /import\s+(\w+)\s*(?:,\s*\{[^}]*\})?\s*from\s*['"][^'"]+['"]/g;
  while ((m = defaultRe.exec(content)) !== null) {
    if (m[1] !== "type") imported.add(m[1]);
  }
  // re-exports: export { x } from '...' — these are used
  const reExportRe = /export\s*\{([^}]+)\}\s*from\s*['"][^'"]+['"]/g;
  while ((m = reExportRe.exec(content)) !== null) {
    m[1].split(",").forEach(s => {
      const name = s.trim().split(/\s+as\s+/)[0].trim();
      if (name) imported.add(name);
    });
  }
  return imported;
}

export async function cmdFindUnusedExports(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:    { type: "boolean", default: runtime.json === true },
      help:    { type: "boolean", short: "h", default: false },
      dir:     { type: "string", default: "" },
      "skip-default": { type: "boolean", default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better find-unused-exports [options]

Find exported symbols not imported anywhere in the project.

Options:
  --dir <path>       Source directory to scan (default: src/ or project root)
  --skip-default     Don't report unused default exports
  --json             Machine-readable output
  -h, --help         Show this help

Note: Only analyzes static imports/exports. Dynamic requires may
      cause false positives.
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;

  let scanDir;
  if (values.dir) {
    scanDir = path.resolve(cwd, values.dir);
  } else {
    // Try src/ first, fallback to root
    const srcPath = path.join(projectRoot, "src");
    try { await fs.access(srcPath); scanDir = srcPath; } catch { scanDir = projectRoot; }
  }

  if (!values.json) {
    printText(`\n\x1b[1mbetter find-unused-exports\x1b[0m\n`);
    process.stderr.write(`\x1b[90mScanning ${path.relative(projectRoot, scanDir) || scanDir}…\x1b[0m\n`);
  }

  const files = await collectFiles(scanDir, EXTS);

  if (files.length === 0) {
    const msg = `No source files found in ${scanDir}`;
    if (values.json) { printJson({ ok: true, kind: "better.find-unused-exports", unused: [], files: 0 }); }
    else { printText(`\x1b[90m${msg}\x1b[0m`); }
    return;
  }

  // Read all files
  const fileContents = new Map();
  const BATCH = 10;
  for (let i = 0; i < files.length; i += BATCH) {
    const batch = files.slice(i, i + BATCH);
    await Promise.all(batch.map(async f => {
      try { fileContents.set(f, await fs.readFile(f, "utf8")); } catch {}
    }));
  }

  // Collect all exports
  const allExports = [];
  for (const [filePath, content] of fileContents) {
    const exports = extractExports(content, filePath);
    allExports.push(...exports);
  }

  // Collect all imports
  const allImported = new Set();
  for (const [, content] of fileContents) {
    const imported = extractImports(content);
    for (const name of imported) allImported.add(name);
  }

  // Find unused
  let unused = allExports.filter(exp => {
    if (values["skip-default"] && exp.name === "default") return false;
    return !allImported.has(exp.name);
  });

  // Deduplicate by name+file
  const seen = new Set();
  unused = unused.filter(u => {
    const key = `${u.file}::${u.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (values.json) {
    printJson({
      ok: true,
      kind: "better.find-unused-exports",
      files: files.length,
      totalExports: allExports.length,
      unused: unused.map(u => ({ name: u.name, file: path.relative(projectRoot, u.file) })),
    });
    return;
  }

  printText(`  Files scanned:  ${files.length}`);
  printText(`  Total exports:  ${allExports.length}`);
  printText(`  Unused exports: ${unused.length}\n`);

  if (unused.length === 0) {
    printText(`\x1b[32m✔ No unused exports found.\x1b[0m`);
  } else {
    // Group by file
    const byFile = new Map();
    for (const u of unused) {
      const rel = path.relative(projectRoot, u.file);
      if (!byFile.has(rel)) byFile.set(rel, []);
      byFile.get(rel).push(u.name);
    }

    for (const [file, names] of byFile) {
      printText(`  \x1b[90m${file}\x1b[0m`);
      for (const name of names) {
        printText(`    \x1b[33m⚠\x1b[0m  ${name}`);
      }
    }
    printText(`\n\x1b[33m⚠ ${unused.length} potentially unused export(s) found.\x1b[0m`);
    printText(`\x1b[90m  Note: dynamic imports and external consumers may cause false positives.\x1b[0m`);
  }
  printText("");
}
