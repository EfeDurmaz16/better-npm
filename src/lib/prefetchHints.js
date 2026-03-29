/**
 * Prefetch hints (#23).
 *
 * Reads package.json scripts and source imports to determine which npm
 * packages are likely to be needed next, then pre-populates the resolver
 * cache (and optionally the CAS store).
 *
 * Detection sources:
 *   1. package.json#scripts — extract known tool names (jest, eslint, tsc, etc.)
 *   2. package.json#dependencies / devDependencies — all direct deps
 *   3. Source file imports — scan *.js / *.ts for `from '...'` / `require('...')`
 *      to find third-party imports not yet in node_modules
 *
 * Usage:
 *   import { collectHints, prefetchHints } from "./prefetchHints.js";
 *   const hints = await collectHints(projectRoot);
 *   await prefetchHints(hints, resolver);
 */

import fs from "node:fs/promises";
import path from "node:path";

// Well-known tools referenced in scripts
const SCRIPT_TOOL_MAP = {
  jest: "jest",
  vitest: "vitest",
  mocha: "mocha",
  jasmine: "jasmine",
  eslint: "eslint",
  prettier: "prettier",
  tsc: "typescript",
  "ts-node": "ts-node",
  tsx: "tsx",
  esbuild: "esbuild",
  rollup: "rollup",
  vite: "vite",
  webpack: "webpack",
  parcel: "parcel",
  turbo: "turbo",
  nx: "nx",
  lerna: "lerna",
  changesets: "@changesets/cli",
  "semantic-release": "semantic-release",
  "release-it": "release-it",
  rimraf: "rimraf",
  "cross-env": "cross-env",
  concurrently: "concurrently",
  nodemon: "nodemon",
  "ts-jest": "ts-jest",
  swc: "@swc/core",
  biome: "@biomejs/biome"
};

/**
 * Extract likely package names from an npm scripts object.
 * @param {Object} scripts  - package.json#scripts
 * @returns {string[]}
 */
export function hintsFromScripts(scripts) {
  if (!scripts || typeof scripts !== "object") return [];
  const found = new Set();

  for (const script of Object.values(scripts)) {
    if (typeof script !== "string") continue;
    // Split on shell operators and spaces
    const tokens = script.split(/[\s|&;]+/);
    for (const token of tokens) {
      // Strip flags and paths
      const base = token.split("/").pop().split("\\").pop().replace(/\.js$/, "");
      if (SCRIPT_TOOL_MAP[base]) {
        found.add(SCRIPT_TOOL_MAP[base]);
      }
      // npx / node_modules/.bin invocations
      if (token.includes("node_modules/.bin/")) {
        const binName = token.split("node_modules/.bin/")[1]?.split(/[\s]/)[0];
        if (binName) found.add(binName);
      }
    }
  }

  return [...found];
}

/**
 * Scan source files in a directory for third-party import/require statements.
 * Returns package names (not file paths).
 *
 * @param {string} dir           - directory to scan
 * @param {Object} [opts]
 * @param {number} [opts.maxFiles=200]
 * @param {string[]} [opts.extensions=['.js','.ts','.mjs','.cjs','.jsx','.tsx']]
 * @param {Set<string>} [opts.installed]  - already installed → skip
 * @returns {Promise<string[]>}
 */
export async function hintsFromSource(dir, opts = {}) {
  const {
    maxFiles = 200,
    extensions = [".js", ".ts", ".mjs", ".cjs", ".jsx", ".tsx"],
    installed = new Set()
  } = opts;

  const found = new Set();
  const IMPORT_RE = /(?:import|require)\s*\(?['"]([^'"./][^'"]*)['"]\)?/g;

  async function walk(d, depth = 0) {
    if (depth > 4) return;
    let entries;
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (found.size + installed.size > maxFiles) break;
      if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "dist") continue;

      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (entry.isFile() && extensions.includes(path.extname(entry.name))) {
        let content;
        try {
          content = await fs.readFile(full, "utf8");
        } catch {
          continue;
        }
        let m;
        IMPORT_RE.lastIndex = 0;
        while ((m = IMPORT_RE.exec(content)) !== null) {
          const spec = m[1];
          // Extract package name (handles scoped packages too)
          const pkgName = spec.startsWith("@")
            ? spec.split("/").slice(0, 2).join("/")
            : spec.split("/")[0];
          if (!installed.has(pkgName)) {
            found.add(pkgName);
          }
        }
      }
    }
  }

  await walk(dir);
  return [...found];
}

/**
 * Collect all prefetch hints for a project.
 *
 * @param {string} projectRoot
 * @returns {Promise<{ packages: string[], sources: { scripts: string[], imports: string[] } }>}
 */
export async function collectHints(projectRoot) {
  let pkg;
  try {
    pkg = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8"));
  } catch {
    return { packages: [], sources: { scripts: [], imports: [] } };
  }

  const installed = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {})
  ]);

  // 1. From scripts
  const scriptHints = hintsFromScripts(pkg.scripts ?? {});

  // 2. From source files (only packages not already installed)
  const importHints = await hintsFromSource(path.join(projectRoot, "src"), {
    installed,
    maxFiles: 100
  }).catch(() => []);

  // Combine: all installed deps + script tools + uninstalled imports
  const allPackages = [
    ...installed,
    ...scriptHints.filter(n => !installed.has(n)),
    ...importHints.filter(n => !installed.has(n))
  ];

  return {
    packages: [...new Set(allPackages)],
    sources: { scripts: scriptHints, imports: importHints }
  };
}

/**
 * Warm the resolver cache for the given package names.
 *
 * @param {string[]} packages
 * @param {import('./resolver.js').ParallelResolver} resolver
 * @returns {Promise<{ prefetched: number, durationMs: number }>}
 */
export async function prefetchToResolver(packages, resolver) {
  const start = Date.now();
  await resolver.prefetch(packages);
  return { prefetched: packages.length, durationMs: Date.now() - start };
}
