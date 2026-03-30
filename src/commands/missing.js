/**
 * better missing — find missing dependencies
 *
 * Scans source code for import/require statements and finds
 * packages that are imported but NOT listed in package.json.
 * Complements "unused" by checking the other direction.
 *
 * Usage:
 *   better missing
 *   better missing --json
 *   better missing --fix    (adds to package.json)
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import https from "node:https";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

// Same import patterns as unused.js
const IMPORT_PATTERNS = [
  /(?:^|\n)\s*import\s+(?:[\w\s{},*]+\s+from\s+)?['"]([^'"./][^'"]*)['"]/g,
  /(?:^|\n)\s*(?:const|let|var)\s+\S+\s*=\s*require\(['"]([^'"./][^'"]*)['"]\)/g,
  /(?:^|\n)\s*import\s*\(\s*['"]([^'"./][^'"]*)['"]\s*\)/g,
];

function extractPackageName(importPath) {
  if (importPath.startsWith(".") || importPath.startsWith("/")) return null;
  const parts = importPath.split("/");
  return importPath.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

// Built-in Node.js modules (shouldn't be in package.json)
const NODE_BUILTINS = new Set([
  "fs", "path", "http", "https", "os", "url", "util", "crypto", "events",
  "stream", "buffer", "child_process", "cluster", "net", "tls", "dns",
  "readline", "repl", "vm", "zlib", "assert", "querystring", "string_decoder",
  "timers", "punycode", "domain", "tty", "v8", "worker_threads", "perf_hooks",
  "async_hooks", "inspector", "module", "process", "console", "global",
  "node:fs", "node:path", "node:http", "node:https", "node:os", "node:url",
  "node:util", "node:crypto", "node:events", "node:stream", "node:buffer",
  "node:child_process", "node:readline", "node:zlib", "node:assert",
  "node:worker_threads", "node:perf_hooks", "node:async_hooks",
]);

function isBuiltin(name) {
  return NODE_BUILTINS.has(name) || name.startsWith("node:");
}

async function collectJsFiles(dir, maxDepth = 5) {
  const files = [];
  async function walk(current, depth) {
    if (depth > maxDepth) return;
    let entries;
    try { entries = await fs.readdir(current, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules" || e.name === "dist" || e.name === "build") continue;
      const full = path.join(current, e.name);
      if (e.isDirectory()) await walk(full, depth + 1);
      else if (/\.[jt]sx?$/.test(e.name) || e.name.endsWith(".mjs")) files.push(full);
    }
  }
  await walk(dir, 0);
  return files;
}

function fetchRegistryExists(name) {
  return new Promise((resolve) => {
    const encoded = encodeURIComponent(name).replace(/%40/g, "@");
    https.get(`https://registry.npmjs.org/${encoded}/latest`, {
      headers: { "Accept": "application/json", "User-Agent": "better-npm/0.1" },
      timeout: 4000,
    }, (res) => {
      resolve(res.statusCode === 200);
    }).on("error", () => resolve(false)).on("timeout", () => resolve(false));
  });
}

export async function cmdMissing(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:   { type: "boolean", default: runtime.json === true },
      help:   { type: "boolean", short: "h", default: false },
      fix:    { type: "boolean", default: false },
      check:  { type: "boolean", default: false }, // alias for CI
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better missing [options]

Find imported packages that are not in package.json dependencies.

Options:
  --fix        Add missing packages to package.json (requires npm install after)
  --json       Machine-readable output
  -h, --help   Show this help
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

  const allDeclared = new Set([
    ...Object.keys(pkgJson.dependencies || {}),
    ...Object.keys(pkgJson.devDependencies || {}),
    ...Object.keys(pkgJson.peerDependencies || {}),
    ...Object.keys(pkgJson.optionalDependencies || {}),
  ]);

  const files = await collectJsFiles(projectRoot);
  const importedPackages = new Set();

  for (const file of files) {
    let content;
    try { content = await fs.readFile(file, "utf8"); } catch { continue; }

    for (const pattern of IMPORT_PATTERNS) {
      let m;
      const re = new RegExp(pattern.source, "g");
      while ((m = re.exec(content)) !== null) {
        const pkg = extractPackageName(m[1]);
        if (pkg && !isBuiltin(pkg)) importedPackages.add(pkg);
      }
    }
  }

  // Find packages that are imported but not declared
  const missing = [];
  for (const pkg of importedPackages) {
    if (!allDeclared.has(pkg)) {
      // Check if it's installed (may be a transitive dep being used directly)
      let installed = false;
      try {
        await fs.access(path.join(projectRoot, "node_modules", pkg, "package.json"));
        installed = true;
      } catch {}

      missing.push({ name: pkg, installed });
    }
  }

  if (missing.length > 0 && !values.json) {
    process.stderr.write(`\x1b[90mChecking registry for ${missing.filter(m => !m.installed).length} unfound packages…\x1b[0m\n`);
  }

  // Check registry for missing packages not installed
  for (const m of missing) {
    if (!m.installed) {
      m.existsOnRegistry = await fetchRegistryExists(m.name);
    }
  }

  const reallyMissing = missing.filter(m => !m.installed || m.existsOnRegistry !== false);
  const onRegistry = missing.filter(m => m.existsOnRegistry);
  const allOk = missing.length === 0;

  if (values.json) {
    printJson({
      ok: allOk,
      kind: "better.missing",
      filesScanned: files.length,
      missing: missing.map(m => ({ name: m.name, installed: m.installed, existsOnRegistry: m.existsOnRegistry })),
    });
    if (!allOk) process.exitCode = 1;
    return;
  }

  printText(`\n\x1b[1mbetter missing\x1b[0m — ${files.length} files scanned\n`);

  if (missing.length === 0) {
    printText(`\x1b[32m✔ All imports are declared in package.json.\x1b[0m`);
    return;
  }

  printText(`\x1b[31m${missing.length} imported package(s) not in package.json:\x1b[0m\n`);

  for (const m of missing) {
    const statusStr = m.installed
      ? "\x1b[33m (transitive — not declared directly)\x1b[0m"
      : m.existsOnRegistry === false
      ? "\x1b[90m (not on registry — may be a local/built-in)\x1b[0m"
      : "\x1b[31m (missing — run npm install)\x1b[0m";
    printText(`  \x1b[31m✖\x1b[0m  ${m.name}${statusStr}`);
  }

  const toAdd = missing.filter(m => !m.installed && m.existsOnRegistry !== false);
  if (toAdd.length > 0) {
    printText(`\n\x1b[90mSuggested: npm install ${toAdd.map(m => m.name).join(" ")}\x1b[0m`);
  }

  if (values.fix && toAdd.length > 0) {
    printText(`\n\x1b[1mAdding to dependencies in package.json:\x1b[0m`);
    const updated = { ...pkgJson };
    if (!updated.dependencies) updated.dependencies = {};
    for (const m of toAdd) {
      updated.dependencies[m.name] = "*";
      printText(`  + ${m.name}: "*"`);
    }
    await fs.writeFile(
      path.join(projectRoot, "package.json"),
      JSON.stringify(updated, null, 2) + "\n"
    );
    printText(`\n\x1b[32m✔ Added ${toAdd.length} package(s). Run: npm install\x1b[0m`);
  }

  process.exitCode = 1;
}
