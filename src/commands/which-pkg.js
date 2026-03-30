/**
 * better which-pkg — find which installed package provides a file or binary
 *
 * Given a file path, binary name, or module specifier, finds which
 * npm package installed it and shows package metadata.
 *
 * Usage:
 *   better which-pkg lodash.debounce
 *   better which-pkg bin/jest
 *   better which-pkg --bin jest
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

async function findPackageForModule(nmPath, specifier) {
  // Try direct package
  const pkgName = specifier.startsWith("@")
    ? specifier.split("/").slice(0, 2).join("/")
    : specifier.split("/")[0];

  try {
    const pkg = JSON.parse(await fs.readFile(path.join(nmPath, pkgName, "package.json"), "utf8"));
    return { package: pkgName, version: pkg.version, description: pkg.description, path: path.join(nmPath, pkgName) };
  } catch {}
  return null;
}

async function findPackageForBin(nmPath, binName) {
  // Check .bin directory
  const binPath = path.join(nmPath, ".bin", binName);
  try {
    // Resolve symlink
    const realPath = await fs.realpath(binPath);
    // Walk up to find package root
    let dir = path.dirname(realPath);
    while (dir !== path.dirname(dir)) {
      try {
        const pkg = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8"));
        if (pkg.name) {
          return {
            package: pkg.name,
            version: pkg.version,
            description: pkg.description,
            binPath: realPath,
            resolvedFrom: binPath,
            path: dir,
          };
        }
      } catch {}
      dir = path.dirname(dir);
    }
  } catch {}

  // Fallback: search all packages for the binary
  try {
    const entries = await fs.readdir(nmPath, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      const pkgDir = path.join(nmPath, e.name);
      try {
        const pkg = JSON.parse(await fs.readFile(path.join(pkgDir, "package.json"), "utf8"));
        const bins = typeof pkg.bin === "string"
          ? { [pkg.name]: pkg.bin }
          : (pkg.bin || {});
        if (bins[binName]) {
          return {
            package: pkg.name,
            version: pkg.version,
            description: pkg.description,
            binEntry: bins[binName],
            path: pkgDir,
          };
        }
      } catch {}
    }
  } catch {}
  return null;
}

async function findPackageForFile(nmPath, filePath) {
  // Convert relative path to absolute if needed
  const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);

  // If the file is inside node_modules, find its package
  const nmPrefix = nmPath + path.sep;
  if (absPath.startsWith(nmPrefix)) {
    const rel = absPath.slice(nmPrefix.length);
    const parts = rel.split(path.sep);
    const pkgName = parts[0].startsWith("@") && parts.length > 1
      ? `${parts[0]}/${parts[1]}`
      : parts[0];

    try {
      const pkg = JSON.parse(await fs.readFile(path.join(nmPath, pkgName, "package.json"), "utf8"));
      return { package: pkgName, version: pkg.version, description: pkg.description, path: path.join(nmPath, pkgName) };
    } catch {}
  }
  return null;
}

export async function cmdWhichPkg(argv) {
  const runtime = getRuntimeConfig();
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json:  { type: "boolean", default: runtime.json === true },
      help:  { type: "boolean", short: "h", default: false },
      bin:   { type: "string" },
      file:  { type: "string" },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better which-pkg <module|binary|file> [options]

Find which npm package provides a module, binary, or file.

Options:
  --bin <name>    Find package providing a binary/command
  --file <path>   Find package containing a file path
  --json          Machine-readable output
  -h, --help      Show this help

Examples:
  better which-pkg lodash
  better which-pkg --bin jest
  better which-pkg --bin tsc
  better which-pkg /path/to/node_modules/lodash/debounce.js
`);
    return;
  }

  if (positionals.length === 0 && !values.bin && !values.file) {
    printText(`Usage: better which-pkg <module|binary> [--bin <name>] [--file <path>]`);
    process.exitCode = 1;
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;
  const nmPath = path.join(projectRoot, "node_modules");

  const queries = [];
  if (values.bin) queries.push({ type: "bin", value: values.bin });
  if (values.file) queries.push({ type: "file", value: values.file });
  for (const p of positionals) {
    // Heuristic: if it looks like a path, treat as file; otherwise module
    queries.push({ type: p.includes("/") && !p.startsWith("@") ? "file" : "module", value: p });
  }

  const results = [];
  for (const q of queries) {
    let found = null;
    if (q.type === "bin") {
      found = await findPackageForBin(nmPath, q.value);
    } else if (q.type === "file") {
      found = await findPackageForFile(nmPath, q.value);
    } else {
      found = await findPackageForModule(nmPath, q.value);
    }
    results.push({ query: q.value, type: q.type, found });
  }

  if (values.json) {
    printJson({
      ok: results.every(r => r.found),
      kind: "better.which-pkg",
      results,
    });
    return;
  }

  printText(`\n\x1b[1mbetter which-pkg\x1b[0m\n`);

  for (const r of results) {
    if (!r.found) {
      printText(`  \x1b[31m✖\x1b[0m  "${r.query}" — not found`);
      continue;
    }
    const f = r.found;
    printText(`  \x1b[32m✔\x1b[0m  \x1b[1m${r.query}\x1b[0m → \x1b[1m${f.package}\x1b[0m@${f.version}`);
    if (f.description) printText(`       \x1b[90m${f.description}\x1b[0m`);
    if (f.binPath) printText(`       \x1b[90mBin: ${f.binPath}\x1b[0m`);
    printText(`       \x1b[90mPath: ${f.path}\x1b[0m`);
  }

  printText("");
}
