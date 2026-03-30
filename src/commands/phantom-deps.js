/**
 * better phantom-deps — detect phantom/undeclared dependencies
 *
 * Finds packages imported in your source code but not listed in
 * package.json as dependencies. These "phantom" deps work accidentally
 * because they're installed by other packages, but will break if the
 * providing package is removed or updated.
 *
 * Usage:
 *   better phantom-deps
 *   better phantom-deps --src src
 *   better phantom-deps --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

const IMPORT_PATTERNS = [
  /(?:^|;|\s)import\s+(?:.*?\s+from\s+)?['"]([^./\n'"][^'"\n]+)['"]/gm,
  /(?:^|;|\s)require\s*\(\s*['"]([^./\n'"][^'"\n]+)['"]\s*\)/gm,
  /(?:^|;|\s)import\s*\(\s*['"]([^./\n'"][^'"\n]+)['"]\s*\)/gm,
];

const BUILTIN_MODULES = new Set([
  "assert", "async_hooks", "buffer", "child_process", "cluster", "console",
  "constants", "crypto", "dgram", "diagnostics_channel", "dns", "domain",
  "events", "fs", "http", "http2", "https", "inspector", "module", "net",
  "os", "path", "perf_hooks", "process", "punycode", "querystring",
  "readline", "repl", "stream", "string_decoder", "sys", "timers",
  "tls", "trace_events", "tty", "url", "util", "v8", "vm", "wasi",
  "worker_threads", "zlib",
]);

function extractImports(content) {
  const imports = new Set();
  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const pkg = match[1];
      if (!pkg) continue;
      // Extract package name (handle subpaths like lodash/merge or @scope/pkg/subpath)
      const parts = pkg.split("/");
      const name = parts[0].startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
      if (name && !BUILTIN_MODULES.has(name) && !name.startsWith("node:")) {
        imports.add(name);
      }
    }
  }
  return [...imports];
}

async function scanSourceFiles(dir, exts, visited = new Set()) {
  const imports = new Set();
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return imports; }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymlink()) continue;
    if (entry.isDirectory()) {
      if (["node_modules", ".git", "dist", "build", "coverage", ".next", ".nuxt"].includes(entry.name)) continue;
      if (visited.has(full)) continue;
      visited.add(full);
      const sub = await scanSourceFiles(full, exts, visited);
      for (const i of sub) imports.add(i);
    } else if (entry.isFile() && exts.some(ext => entry.name.endsWith(ext))) {
      try {
        const content = await fs.readFile(full, "utf8");
        for (const i of extractImports(content)) imports.add(i);
      } catch {}
    }
  }
  return imports;
}

export async function cmdPhantomDeps(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:  { type: "boolean", default: runtime.json === true },
      help:  { type: "boolean", short: "h", default: false },
      src:   { type: "string", default: "." },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better phantom-deps [options]

Detect undeclared (phantom) dependencies in source code.

Options:
  --src <dir>   Source directory to scan (default: .)
  --json        Machine-readable output
  -h, --help    Show this help

Finds packages imported in source code but missing from
package.json dependencies, which may cause build failures.
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;
  const srcDir = path.resolve(projectRoot, values.src);

  if (!values.json) {
    printText(`\n\x1b[1mbetter phantom-deps\x1b[0m\n`);
    process.stderr.write(`\x1b[90mScanning source files...\x1b[0m\n`);
  }

  let pkgJson = {};
  try { pkgJson = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8")); } catch {}

  const declared = new Set([
    ...Object.keys(pkgJson.dependencies || {}),
    ...Object.keys(pkgJson.devDependencies || {}),
    ...Object.keys(pkgJson.peerDependencies || {}),
    ...Object.keys(pkgJson.optionalDependencies || {}),
    ...(pkgJson.name ? [pkgJson.name] : []),
  ]);

  const SOURCE_EXTS = [".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".vue", ".svelte"];
  const usedImports = await scanSourceFiles(srcDir, SOURCE_EXTS);

  const phantoms = [...usedImports].filter(imp => !declared.has(imp)).sort();

  if (values.json) {
    printJson({
      ok: phantoms.length === 0,
      kind: "better.phantom-deps",
      scanned: [...usedImports].length,
      phantoms: phantoms.length,
      packages: phantoms,
    });
    if (phantoms.length > 0) process.exitCode = 1;
    return;
  }

  printText(`  Imports found: ${usedImports.size}  |  Declared: ${declared.size}\n`);

  if (phantoms.length === 0) {
    printText(`\x1b[32m✔ No phantom dependencies detected.\x1b[0m`);
  } else {
    printText(`\x1b[33m⚠ ${phantoms.length} phantom dependenc${phantoms.length === 1 ? "y" : "ies"} detected:\x1b[0m\n`);
    for (const p of phantoms) {
      printText(`  \x1b[33m·\x1b[0m  \x1b[1m${p}\x1b[0m  \x1b[90m(imported but not in package.json)\x1b[0m`);
    }
    printText(`\n  Add them to dependencies: \x1b[36mnpm install ${phantoms.slice(0, 3).join(" ")}\x1b[0m`);
    process.exitCode = 1;
  }
  printText("");
}
