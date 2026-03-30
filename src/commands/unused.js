/**
 * better unused — detect unused packages
 *
 * Scans source files for import/require statements and finds packages
 * in package.json that don't appear to be used anywhere in the code.
 *
 * Usage:
 *   better unused                    # scan src/ and root js/ts files
 *   better unused --dir src          # scan specific directory
 *   better unused --prod-only        # only check production deps
 *   better unused --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

const SOURCE_EXTS = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".vue", ".svelte"]);

// Regex to extract package names from import/require statements
const IMPORT_PATTERNS = [
  /(?:import|from)\s+['"]([^'"./][^'"]*)['"]/g,          // ESM import
  /require\(['"]([^'"./][^'"]*)['"]\)/g,                   // CJS require
  /import\(['"]([^'"./][^'"]*)['"]\)/g,                    // dynamic import
  /\/\/\s*@depends:\s*([^\s]+)/g,                          // custom annotation
];

function extractPackageName(rawImport) {
  // Handle scoped packages: @scope/pkg/subpath -> @scope/pkg
  if (rawImport.startsWith("@")) {
    const parts = rawImport.split("/");
    return parts.slice(0, 2).join("/");
  }
  // Handle subpath: pkg/sub -> pkg
  return rawImport.split("/")[0];
}

async function scanFile(filePath) {
  const usedPkgs = new Set();
  try {
    const content = await fs.readFile(filePath, "utf8");
    for (const pattern of IMPORT_PATTERNS) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const pkg = extractPackageName(match[1]);
        if (pkg) usedPkgs.add(pkg);
      }
    }
  } catch {}
  return usedPkgs;
}

async function walkDir(dirPath, extensions, excludeDirs) {
  const files = [];
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        if (!excludeDirs.has(entry.name) && !entry.name.startsWith(".")) {
          files.push(...await walkDir(full, extensions, excludeDirs));
        }
      } else if (extensions.has(path.extname(entry.name))) {
        files.push(full);
      }
    }
  } catch {}
  return files;
}

export async function cmdUnused(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: runtime.json === true },
      dir: { type: "string" },
      "prod-only": { type: "boolean", default: false },
      "dev-only": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better unused [options]

Detect packages listed in package.json that aren't imported anywhere.

Options:
  --dir <path>     Directory to scan (default: src, then project root)
  --prod-only      Only check production dependencies
  --dev-only       Only check devDependencies
  --json           Machine-readable output
  -h, --help       Show this help

Note: This is a static analysis based on import/require scanning.
Dynamic requires or config-driven imports may cause false positives.

Examples:
  better unused
  better unused --dir src --prod-only
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

  // Collect packages to check
  const depsToCheck = new Map(); // name -> type
  if (!values["dev-only"]) {
    for (const name of Object.keys(pkgJson.dependencies || {})) {
      depsToCheck.set(name, "prod");
    }
  }
  if (!values["prod-only"]) {
    for (const name of Object.keys(pkgJson.devDependencies || {})) {
      depsToCheck.set(name, "dev");
    }
  }

  if (depsToCheck.size === 0) {
    const msg = "No dependencies to check.";
    if (values.json) { printJson({ ok: true, unused: [], message: msg }); } else { printText(msg); }
    return;
  }

  // Determine scan directories
  const EXCLUDE_DIRS = new Set(["node_modules", "dist", "build", "out", ".next", ".nuxt", "coverage"]);

  let scanDirs;
  if (values.dir) {
    scanDirs = [path.resolve(projectRoot, values.dir)];
  } else {
    // Prefer src/, then fall back to project root
    const srcPath = path.join(projectRoot, "src");
    try {
      await fs.access(srcPath);
      scanDirs = [srcPath, projectRoot]; // scan both src and root-level files
    } catch {
      scanDirs = [projectRoot];
    }
  }

  if (!values.json) {
    process.stderr.write(`\x1b[90mScanning source files…\x1b[0m\n`);
  }

  // Collect all source files
  const allFiles = new Set();
  for (const dir of scanDirs) {
    if (dir === projectRoot) {
      // For root, only scan direct files (not subdirs to avoid double-scanning src/)
      try {
        const entries = await fs.readdir(projectRoot, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory() && SOURCE_EXTS.has(path.extname(entry.name))) {
            allFiles.add(path.join(projectRoot, entry.name));
          }
        }
      } catch {}
    } else {
      const files = await walkDir(dir, SOURCE_EXTS, EXCLUDE_DIRS);
      for (const f of files) allFiles.add(f);
    }
  }

  // Also scan config files in root
  const configFiles = ["vite.config.js", "vite.config.ts", "webpack.config.js",
    "rollup.config.js", "jest.config.js", "jest.config.ts", ".eslintrc.js",
    "next.config.js", "nuxt.config.js", "svelte.config.js", "astro.config.mjs"];
  for (const cf of configFiles) {
    const cfPath = path.join(projectRoot, cf);
    try { await fs.access(cfPath); allFiles.add(cfPath); } catch {}
  }

  // Scan all files
  const usedPackages = new Set();
  const SCAN_BATCH = 20;
  const fileArr = [...allFiles];
  for (let i = 0; i < fileArr.length; i += SCAN_BATCH) {
    const batch = fileArr.slice(i, i + SCAN_BATCH);
    const results = await Promise.all(batch.map(f => scanFile(f)));
    for (const pkgSet of results) {
      for (const pkg of pkgSet) usedPackages.add(pkg);
    }
  }

  // Also check package.json bin fields — packages may be used as CLI tools
  const binDeps = new Set();
  for (const [name] of depsToCheck) {
    const binPath = path.join(projectRoot, "node_modules", name, "package.json");
    try {
      const instPkg = JSON.parse(await fs.readFile(binPath, "utf8"));
      if (instPkg.bin) binDeps.add(name); // has a bin — might be a CLI tool
    } catch {}
  }

  // Find truly unused
  const unused = [];
  const used = [];
  for (const [name, type] of depsToCheck) {
    if (usedPackages.has(name)) {
      used.push({ name, type });
    } else {
      unused.push({ name, type, has_bin: binDeps.has(name) });
    }
  }

  // Sort: non-bin unused first (more likely truly unused)
  unused.sort((a, b) => {
    if (a.has_bin !== b.has_bin) return a.has_bin ? 1 : -1;
    return a.name.localeCompare(b.name);
  });

  if (values.json) {
    printJson({
      ok: true,
      kind: "better.unused",
      unused,
      used: used.length,
      scanned_files: allFiles.size,
      total_deps: depsToCheck.size,
    });
    return;
  }

  printText(`\n\x1b[1mbetter unused\x1b[0m — scanned ${allFiles.size} files\n`);

  if (unused.length === 0) {
    printText("\x1b[32m✔ No unused packages detected.\x1b[0m");
    return;
  }

  const trulyUnused = unused.filter(u => !u.has_bin);
  const possiblyUnused = unused.filter(u => u.has_bin);

  if (trulyUnused.length > 0) {
    printText(`\x1b[33mPossibly unused (${trulyUnused.length}):\x1b[0m`);
    for (const u of trulyUnused) {
      const type = u.type === "prod" ? "\x1b[31mprod\x1b[0m" : "\x1b[90mdev\x1b[0m";
      printText(`  ${u.name.padEnd(32)} ${type}`);
    }
  }

  if (possiblyUnused.length > 0) {
    printText(`\n\x1b[90mCLI tools (may be used via scripts, ${possiblyUnused.length}):\x1b[0m`);
    for (const u of possiblyUnused) {
      printText(`  \x1b[90m${u.name.padEnd(32)} ${u.type} (has bin)\x1b[0m`);
    }
  }

  printText(`\n\x1b[90mNote: static analysis only. Dynamic requires may cause false positives.\x1b[0m`);
  printText(`\x1b[90mUse 'better suggest' for a more comprehensive analysis.\x1b[0m`);
}
