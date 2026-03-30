/**
 * better import-check — verify all imports resolve correctly
 *
 * Statically scans JS/TS source files and checks that every
 * import/require resolves to an existing file or installed package.
 * Catches broken imports before they fail at runtime.
 *
 * Usage:
 *   better import-check
 *   better import-check src/
 *   better import-check --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

const NODE_BUILTINS = new Set([
  "assert","buffer","child_process","cluster","console","constants","crypto",
  "dgram","dns","domain","events","fs","http","http2","https","inspector",
  "module","net","os","path","perf_hooks","process","punycode","querystring",
  "readline","repl","stream","string_decoder","sys","timers","tls","trace_events",
  "tty","url","util","v8","vm","wasi","worker_threads","zlib",
  "node:assert","node:buffer","node:child_process","node:cluster","node:console",
  "node:crypto","node:dgram","node:dns","node:domain","node:events","node:fs",
  "node:http","node:http2","node:https","node:inspector","node:module","node:net",
  "node:os","node:path","node:perf_hooks","node:process","node:querystring",
  "node:readline","node:repl","node:stream","node:string_decoder","node:timers",
  "node:tls","node:tty","node:url","node:util","node:v8","node:vm",
  "node:worker_threads","node:zlib",
]);

const IMPORT_RE = [
  /\bimport\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage"]);
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

function extractImports(content) {
  const imports = new Set();
  for (const re of IMPORT_RE) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(content)) !== null) {
      imports.add(m[1]);
    }
  }
  return [...imports];
}

async function resolveImport(spec, fromFile, nmPath) {
  // Node built-ins always resolve
  if (NODE_BUILTINS.has(spec)) return { ok: true };

  // Relative imports
  if (spec.startsWith(".")) {
    const dir = path.dirname(fromFile);
    const base = path.resolve(dir, spec);

    // Try exact and with extensions
    for (const ext of ["", ".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs", "/index.js", "/index.ts"]) {
      try {
        await fs.access(base + ext);
        return { ok: true };
      } catch {}
    }
    return { ok: false, reason: "file not found" };
  }

  // Package imports
  const pkgName = spec.startsWith("@")
    ? spec.split("/").slice(0, 2).join("/")
    : spec.split("/")[0];

  const pkgPath = path.join(nmPath, pkgName, "package.json");
  try {
    await fs.access(pkgPath);
    return { ok: true };
  } catch {
    return { ok: false, reason: "package not installed" };
  }
}

export async function cmdImportCheck(argv) {
  const runtime = getRuntimeConfig();
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json:  { type: "boolean", default: runtime.json === true },
      help:  { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better import-check [dir...] [options]

Check that all imports/requires in source files resolve correctly.

Options:
  --json       Machine-readable output
  -h, --help   Show this help

Examples:
  better import-check
  better import-check src/
  better import-check src/ lib/
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;
  const nmPath = path.join(projectRoot, "node_modules");

  const searchDirs = positionals.length > 0
    ? positionals.map(d => path.isAbsolute(d) ? d : path.join(cwd, d))
    : [path.join(projectRoot, "src"), projectRoot].filter(async d => {
        try { await fs.access(d); return true; } catch { return false; }
      });

  if (!values.json) {
    process.stderr.write(`\x1b[90mScanning for broken imports…\x1b[0m\n`);
  }

  let allFiles = [];
  for (const dir of searchDirs) {
    allFiles.push(...(await collectFiles(dir)));
  }
  // dedupe
  allFiles = [...new Set(allFiles)];

  const broken = [];
  let totalImports = 0;

  for (const file of allFiles) {
    let content;
    try { content = await fs.readFile(file, "utf8"); } catch { continue; }

    const imports = extractImports(content);
    totalImports += imports.length;

    for (const spec of imports) {
      // Skip dynamic computed imports
      if (spec.includes("${") || spec.includes("..") && !spec.startsWith(".")) continue;

      const result = await resolveImport(spec, file, nmPath);
      if (!result.ok) {
        broken.push({
          file: path.relative(projectRoot, file),
          import: spec,
          reason: result.reason,
        });
      }
    }
  }

  if (values.json) {
    printJson({
      ok: broken.length === 0,
      kind: "better.import-check",
      filesScanned: allFiles.length,
      importsChecked: totalImports,
      brokenCount: broken.length,
      broken,
    });
    if (broken.length > 0) process.exitCode = 1;
    return;
  }

  printText(`\n\x1b[1mbetter import-check\x1b[0m — ${allFiles.length} files, ${totalImports} imports\n`);

  if (broken.length === 0) {
    printText(`\x1b[32m✔ All imports resolve correctly.\x1b[0m`);
    return;
  }

  // Group by file
  const byFile = new Map();
  for (const b of broken) {
    if (!byFile.has(b.file)) byFile.set(b.file, []);
    byFile.get(b.file).push(b);
  }

  for (const [file, items] of byFile) {
    printText(`  \x1b[31m✖\x1b[0m  \x1b[1m${file}\x1b[0m`);
    for (const item of items) {
      printText(`       \x1b[31m→ "${item.import}"\x1b[0m  \x1b[90m${item.reason}\x1b[0m`);
    }
  }

  printText(`\n\x1b[31m${broken.length} broken import(s) found in ${byFile.size} file(s).\x1b[0m`);
  process.exitCode = 1;
}
