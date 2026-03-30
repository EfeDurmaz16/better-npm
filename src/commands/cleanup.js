/**
 * better cleanup — deep clean project artifacts
 *
 * Removes node_modules, build artifacts, caches, coverage reports,
 * and other generated files. More thorough than `better clean`.
 *
 * Usage:
 *   better cleanup
 *   better cleanup --dry-run
 *   better cleanup --keep-modules
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

const CLEANUP_TARGETS = [
  { path: "node_modules",           label: "node_modules",           category: "deps",    risky: false },
  { path: "dist",                   label: "dist/",                  category: "build",   risky: false },
  { path: "build",                  label: "build/",                 category: "build",   risky: false },
  { path: ".next",                  label: ".next/ (Next.js cache)",  category: "build",   risky: false },
  { path: ".nuxt",                  label: ".nuxt/ (Nuxt cache)",     category: "build",   risky: false },
  { path: ".svelte-kit",            label: ".svelte-kit/",           category: "build",   risky: false },
  { path: "coverage",               label: "coverage/",              category: "test",    risky: false },
  { path: ".nyc_output",            label: ".nyc_output/",           category: "test",    risky: false },
  { path: ".cache",                 label: ".cache/",                category: "cache",   risky: false },
  { path: ".parcel-cache",          label: ".parcel-cache/",         category: "cache",   risky: false },
  { path: ".turbo",                 label: ".turbo/",                category: "cache",   risky: false },
  { path: ".eslintcache",           label: ".eslintcache",           category: "cache",   risky: false },
  { path: ".stylelintcache",        label: ".stylelintcache",        category: "cache",   risky: false },
  { path: "tsconfig.tsbuildinfo",   label: "tsconfig.tsbuildinfo",   category: "build",   risky: false },
  { path: "*.tsbuildinfo",          label: "*.tsbuildinfo",          category: "build",   risky: false, glob: true },
  { path: ".vite",                  label: ".vite/",                 category: "cache",   risky: false },
  { path: "tmp",                    label: "tmp/",                   category: "temp",    risky: false },
  { path: ".temp",                  label: ".temp/",                 category: "temp",    risky: false },
  { path: "audit-report.html",      label: "audit-report.html",      category: "report",  risky: false },
];

async function getDirSizeKb(dir) {
  let total = 0;
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        total += await getDirSizeKb(p);
      } else {
        try { total += (await fs.stat(p)).size; } catch {}
      }
    }
  } catch {}
  return total;
}

function fmtBytes(n) {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

export async function cmdCleanup(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:           { type: "boolean", default: runtime.json === true },
      help:           { type: "boolean", short: "h", default: false },
      "dry-run":      { type: "boolean", default: false },
      "keep-modules": { type: "boolean", default: false },
      "build-only":   { type: "boolean", default: false },
      "cache-only":   { type: "boolean", default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better cleanup [options]

Remove generated artifacts, caches, and build outputs.

Options:
  --dry-run        Preview what would be removed without deleting
  --keep-modules   Skip node_modules removal
  --build-only     Only remove build artifacts (dist, build, .next, etc.)
  --cache-only     Only remove cache directories
  --json           Machine-readable output
  -h, --help       Show this help

Examples:
  better cleanup
  better cleanup --dry-run
  better cleanup --keep-modules
  better cleanup --cache-only
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;

  // Filter targets
  let targets = CLEANUP_TARGETS.filter(t => !t.glob);

  if (values["keep-modules"]) {
    targets = targets.filter(t => t.path !== "node_modules");
  }
  if (values["build-only"]) {
    targets = targets.filter(t => t.category === "build");
  }
  if (values["cache-only"]) {
    targets = targets.filter(t => t.category === "cache");
  }

  // Check which exist and get sizes
  const toRemove = [];
  for (const target of targets) {
    const fullPath = path.join(projectRoot, target.path);
    try {
      const stat = await fs.stat(fullPath);
      const size = stat.isDirectory() ? await getDirSizeKb(fullPath) : stat.size;
      toRemove.push({ ...target, fullPath, size, isDir: stat.isDirectory() });
    } catch {}
  }

  const totalSize = toRemove.reduce((s, t) => s + t.size, 0);

  if (values.json) {
    const result = {
      ok: true,
      kind: "better.cleanup",
      dryRun: values["dry-run"],
      itemsToRemove: toRemove.length,
      totalSize,
      items: toRemove.map(t => ({ path: t.path, label: t.label, size: t.size, category: t.category })),
    };

    if (!values["dry-run"]) {
      for (const t of toRemove) {
        try {
          if (t.isDir) await fs.rm(t.fullPath, { recursive: true, force: true });
          else await fs.unlink(t.fullPath);
        } catch {}
      }
    }
    printJson(result);
    return;
  }

  printText(`\n\x1b[1mbetter cleanup\x1b[0m${values["dry-run"] ? " (dry-run)" : ""}\n`);

  if (toRemove.length === 0) {
    printText(`\x1b[32m✔ Nothing to clean — all targets already absent.\x1b[0m\n`);
    return;
  }

  for (const t of toRemove) {
    const sizeStr = fmtBytes(t.size);
    printText(`  \x1b[33m✗\x1b[0m  ${t.label.padEnd(35)} \x1b[90m${sizeStr}\x1b[0m`);
  }

  printText(`\n  Total: \x1b[1m${fmtBytes(totalSize)}\x1b[0m across ${toRemove.length} item(s)\n`);

  if (values["dry-run"]) {
    printText(`\x1b[90mDry-run: run without --dry-run to delete.\x1b[0m`);
    return;
  }

  let removed = 0;
  let failed = 0;
  for (const t of toRemove) {
    try {
      if (t.isDir) await fs.rm(t.fullPath, { recursive: true, force: true });
      else await fs.unlink(t.fullPath);
      removed++;
    } catch {
      failed++;
    }
  }

  if (failed === 0) {
    printText(`\x1b[32m✔ Removed ${removed} item(s) (${fmtBytes(totalSize)} freed).\x1b[0m`);
  } else {
    printText(`\x1b[33m⚠ Removed ${removed} item(s), ${failed} failed.\x1b[0m`);
  }
  printText("");
}
