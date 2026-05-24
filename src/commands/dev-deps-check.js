/**
 * better dev-deps-check — find production code using devDependencies
 *
 * Scans production source files for imports of packages listed only
 * in devDependencies. These will be missing in production installs.
 *
 * Usage:
 *   better dev-deps-check
 *   better dev-deps-check --src src
 *   better dev-deps-check --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

const IMPORT_RE = [
  /(?:^|;|\s)import\s+(?:.*?\s+from\s+)?['"]([^./\n'"][^'"\n]+)['"]/gm,
  /(?:^|;|\s)require\s*\(\s*['"]([^./\n'"][^'"\n]+)['"]\s*\)/gm,
];

const BUILTIN_MODULES = new Set([
  "assert", "buffer", "child_process", "cluster", "crypto", "events",
  "fs", "http", "http2", "https", "net", "os", "path", "readline",
  "stream", "tls", "url", "util", "v8", "vm", "worker_threads", "zlib",
]);

function extractImports(content) {
  const imports = new Set();
  for (const re of IMPORT_RE) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(content)) !== null) {
      const pkg = m[1];
      if (!pkg) continue;
      const parts = pkg.split("/");
      const name = parts[0].startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
      if (name && !BUILTIN_MODULES.has(name) && !name.startsWith("node:")) {
        imports.add(name);
      }
    }
  }
  return [...imports];
}

async function scanDir(dir, exts, visited = new Set()) {
  const imports = new Set();
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return imports; }

  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) {
      if (["node_modules", ".git", "dist", "build", "coverage", ".next", "test", "tests", "__tests__", "spec"].includes(e.name)) continue;
      if (visited.has(full)) continue;
      visited.add(full);
      const sub = await scanDir(full, exts, visited);
      for (const i of sub) imports.add(i);
    } else if (e.isFile() && exts.some(ext => e.name.endsWith(ext))) {
      try {
        const content = await fs.readFile(full, "utf8");
        for (const i of extractImports(content)) imports.add(i);
      } catch {}
    }
  }
  return imports;
}

export async function cmdDevDepsCheck(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:  { type: "boolean", default: runtime.json === true },
      help:  { type: "boolean", short: "h", default: false },
      src:   { type: "string", default: "src" },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better dev-deps-check [options]

Find production code importing devDependencies.

Options:
  --src <dir>   Source directory to scan (default: src)
  --json        Machine-readable output
  -h, --help    Show this help

Scans source files (excluding test directories) for imports
of packages only listed in devDependencies. These will be
missing when installed with \`npm install --omit=dev\`.
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;
  const srcDir = path.resolve(projectRoot, values.src);

  if (!values.json) {
    printText(`\n\x1b[1mbetter dev-deps-check\x1b[0m\n`);
    process.stderr.write(`\x1b[90mScanning ${values.src}/ for devDependency imports...\x1b[0m\n`);
  }

  let pkgJson = {};
  try { pkgJson = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8")); } catch {}

  const prodDeps = new Set(Object.keys(pkgJson.dependencies || {}));
  const devDeps = new Set(Object.keys(pkgJson.devDependencies || {}));
  const peerDeps = new Set(Object.keys(pkgJson.peerDependencies || {}));

  // Only flag packages in devDeps but NOT in prod/peer deps
  const devOnly = [...devDeps].filter(d => !prodDeps.has(d) && !peerDeps.has(d));

  const SOURCE_EXTS = [".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx"];
  let srcExists = true;
  try { await fs.access(srcDir); } catch { srcExists = false; }

  if (!srcExists) {
    const msg = `Source directory not found: ${values.src}`;
    if (values.json) { printJson({ ok: true, kind: "better.dev-deps-check", issues: [], note: msg }); return; }
    printText(`  \x1b[90m${msg}\x1b[0m\n`);
    return;
  }

  const usedImports = await scanDir(srcDir, SOURCE_EXTS);
  const violations = [...usedImports].filter(imp => devOnly.includes(imp)).sort();

  if (values.json) {
    printJson({
      ok: violations.length === 0,
      kind: "better.dev-deps-check",
      scanned: usedImports.size,
      issues: violations.length,
      violations,
    });
    if (violations.length > 0) process.exitCode = 1;
    return;
  }

  printText(`  Scanned: ${usedImports.size} imports in ${values.src}/\n`);

  if (violations.length === 0) {
    printText(`\x1b[32m✔ No production code imports devDependencies.\x1b[0m`);
  } else {
    printText(`\x1b[31m✘ ${violations.length} devDependenc${violations.length === 1 ? "y" : "ies"} used in production code:\x1b[0m\n`);
    for (const v of violations) {
      printText(`  \x1b[31m·\x1b[0m  \x1b[1m${v}\x1b[0m  \x1b[90m(in devDependencies only)\x1b[0m`);
    }
    printText(`\n  Move to dependencies: \x1b[36mnpm install ${violations.slice(0, 3).join(" ")}\x1b[0m`);
    process.exitCode = 1;
  }
  printText("");
}
