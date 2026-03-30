/**
 * better clean — remove build artifacts and ephemeral directories
 *
 * Usage:
 *   better clean                      # remove node_modules, dist, build
 *   better clean --modules            # only node_modules
 *   better clean --dist               # only dist/build/out
 *   better clean --cache              # clear better cache
 *   better clean --all                # everything above
 *   better clean --dry-run            # show what would be removed
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";

const DIST_DIRS = ["dist", "build", "out", ".next", ".nuxt", ".output", ".svelte-kit", "storybook-static", "coverage", ".turbo"];
const CACHE_DIRS = [".cache", ".parcel-cache", ".rollup.cache", "node_modules/.cache", "node_modules/.vite"];

async function dirSizeKb(dirPath) {
  let totalBytes = 0;
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        totalBytes += await dirSizeKb(full);
      } else {
        try {
          const stat = await fs.stat(full);
          totalBytes += stat.size;
        } catch {}
      }
    }
  } catch {}
  return totalBytes;
}

async function removeDir(dirPath) {
  try {
    await fs.rm(dirPath, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function fmtBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export async function cmdClean(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: runtime.json === true },
      modules: { type: "boolean", default: false },
      dist: { type: "boolean", default: false },
      cache: { type: "boolean", default: false },
      all: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better clean [options]

Remove build artifacts and ephemeral directories.

By default removes: node_modules, dist/build/out/coverage

Options:
  --modules      Remove only node_modules
  --dist         Remove only dist/build/out and similar
  --cache        Remove .cache and build tool caches
  --all          Remove everything (modules + dist + cache)
  --dry-run      Show what would be removed without deleting
  --json         Machine-readable output
  -h, --help     Show this help

Examples:
  better clean                 # node_modules + dist
  better clean --modules       # just node_modules
  better clean --all --dry-run # preview all removals
`);
    return;
  }

  const cwd = process.cwd();
  const doModules = values.all || values.modules || (!values.dist && !values.cache);
  const doDist = values.all || values.dist || (!values.modules && !values.cache);
  const doCache = values.all || values.cache;

  const targets = [];
  if (doModules) targets.push(path.join(cwd, "node_modules"));
  if (doDist) {
    for (const dir of DIST_DIRS) targets.push(path.join(cwd, dir));
  }
  if (doCache) {
    for (const dir of CACHE_DIRS) targets.push(path.join(cwd, dir));
  }

  const results = [];
  let totalFreed = 0;

  for (const target of targets) {
    try {
      await fs.access(target);
    } catch {
      continue; // doesn't exist
    }

    const size = await dirSizeKb(target);
    totalFreed += size;

    if (!values["dry-run"]) {
      const ok = await removeDir(target);
      results.push({ path: path.relative(cwd, target), size, removed: ok });
    } else {
      results.push({ path: path.relative(cwd, target), size, removed: false, dry_run: true });
    }
  }

  if (values.json) {
    printJson({
      ok: true,
      kind: "better.clean",
      dry_run: values["dry-run"],
      removed: results,
      total_freed_bytes: totalFreed,
      total_freed: fmtBytes(totalFreed),
    });
    return;
  }

  if (results.length === 0) {
    printText("Nothing to clean.");
    return;
  }

  const label = values["dry-run"] ? "Would remove" : "Removed";
  printText(`\n\x1b[1mbetter clean\x1b[0m${values["dry-run"] ? " \x1b[33m(dry run)\x1b[0m" : ""}\n`);
  for (const r of results) {
    const icon = values["dry-run"] ? "~" : "\x1b[31m✖\x1b[0m";
    printText(`  ${icon}  ${r.path.padEnd(36)} \x1b[90m${fmtBytes(r.size)}\x1b[0m`);
  }
  printText(`\n\x1b[1m${label} ${fmtBytes(totalFreed)}\x1b[0m across ${results.length} director${results.length === 1 ? "y" : "ies"}`);

  if (doModules && !values["dry-run"] && results.some(r => r.path === "node_modules")) {
    printText("\x1b[90mRun `better install` to restore node_modules.\x1b[0m");
  }
}
