/**
 * better deps-check — audit dependency placement
 *
 * Scans source code to find packages listed in "dependencies" that
 * are only ever used in test/build/dev contexts and should be moved
 * to "devDependencies". Also flags devDependencies imported in
 * production code.
 *
 * Usage:
 *   better deps-check
 *   better deps-check --fix
 *   better deps-check --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

// Directories/files considered "dev" context
const DEV_PATTERNS = [
  /^test[s]?\//i,
  /\.test\.[jt]sx?$/,
  /\.spec\.[jt]sx?$/,
  /^__tests__\//,
  /^scripts\//,
  /^tools\//,
  /^\.storybook\//,
  /webpack\.config\./,
  /vite\.config\./,
  /rollup\.config\./,
  /jest\.config\./,
  /vitest\.config\./,
  /babel\.config\./,
  /\.eslintrc/,
  /\.prettierrc/,
];

// Directories/files considered "production" context
const PROD_PATTERNS = [
  /^src\//,
  /^lib\//,
  /^app\//,
  /^server\//,
  /^api\//,
  /^pages\//,
  /^components\//,
];

// Known build/dev tools that should always be devDeps
const ALWAYS_DEV = new Set([
  "webpack", "webpack-cli", "webpack-dev-server",
  "vite", "rollup", "parcel", "esbuild",
  "babel-core", "@babel/core", "@babel/preset-env", "@babel/preset-react", "@babel/preset-typescript",
  "typescript", "ts-node", "tsx", "tsup",
  "jest", "vitest", "mocha", "jasmine", "tape", "ava",
  "@jest/core", "@jest/globals", "jest-environment-node",
  "eslint", "prettier", "stylelint",
  "@typescript-eslint/parser", "@typescript-eslint/eslint-plugin",
  "husky", "lint-staged", "commitlint",
  "nodemon", "ts-node-dev",
  "cross-env", "rimraf", "concurrently",
  "storybook", "@storybook/react",
  "cypress", "playwright", "@playwright/test",
  "supertest", "chai", "sinon",
  "webpack-bundle-analyzer",
  "source-map-loader", "css-loader", "style-loader", "sass-loader",
  "copy-webpack-plugin", "html-webpack-plugin",
]);

const IMPORT_RE = /(?:require\(['"]|from\s+['"]|import\s+['"])(@?[^'"./][^'"]*)/g;

async function collectJsFiles(dir, maxDepth = 5) {
  const files = [];
  async function walk(current, depth) {
    if (depth > maxDepth) return;
    let entries;
    try { entries = await fs.readdir(current, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const fullPath = path.join(current, e.name);
      if (e.isDirectory()) await walk(fullPath, depth + 1);
      else if (/\.[jt]sx?$/.test(e.name) || e.name.endsWith(".mjs") || e.name.endsWith(".cjs")) {
        files.push(fullPath);
      }
    }
  }
  await walk(dir, 0);
  return files;
}

function extractImports(content) {
  const imports = new Set();
  let m;
  const re = new RegExp(IMPORT_RE.source, "g");
  while ((m = re.exec(content)) !== null) {
    const pkg = m[1];
    // Normalize to package name (drop subpath)
    const parts = pkg.startsWith("@") ? pkg.split("/").slice(0, 2) : [pkg.split("/")[0]];
    imports.add(parts.join("/"));
  }
  return imports;
}

export async function cmdDepsCheck(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:   { type: "boolean", default: runtime.json === true },
      help:   { type: "boolean", short: "h", default: false },
      fix:    { type: "boolean", default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better deps-check [options]

Audit dependency placement — find prod deps used only in dev context
and devDeps accidentally imported in production code.

Options:
  --fix        Move misplaced deps automatically in package.json
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

  const prodDeps = new Set(Object.keys(pkgJson.dependencies || {}));
  const devDeps = new Set(Object.keys(pkgJson.devDependencies || {}));

  const files = await collectJsFiles(projectRoot);

  // Map: package -> { devFiles, prodFiles }
  const usage = {};

  for (const file of files) {
    let content;
    try { content = await fs.readFile(file, "utf8"); } catch { continue; }
    const imports = extractImports(content);
    const relPath = path.relative(projectRoot, file).replace(/\\/g, "/");
    const isDev = DEV_PATTERNS.some(p => p.test(relPath));
    const isProd = PROD_PATTERNS.some(p => p.test(relPath));

    for (const pkg of imports) {
      if (!prodDeps.has(pkg) && !devDeps.has(pkg)) continue;
      if (!usage[pkg]) usage[pkg] = { devFiles: [], prodFiles: [] };
      if (isDev) usage[pkg].devFiles.push(relPath);
      else if (isProd) usage[pkg].prodFiles.push(relPath);
    }
  }

  // Find prod deps that should be dev
  const shouldBeDev = [];
  for (const pkg of prodDeps) {
    if (ALWAYS_DEV.has(pkg)) {
      shouldBeDev.push({ pkg, reason: "known dev/build tool", devFiles: [], prodFiles: [] });
      continue;
    }
    const u = usage[pkg];
    if (!u) continue; // not imported anywhere in analyzed files
    if (u.devFiles.length > 0 && u.prodFiles.length === 0) {
      shouldBeDev.push({ pkg, reason: "only used in dev files", devFiles: u.devFiles.slice(0, 3), prodFiles: [] });
    }
  }

  // Find dev deps imported in production code
  const shouldBeProd = [];
  for (const pkg of devDeps) {
    const u = usage[pkg];
    if (!u) continue;
    if (u.prodFiles.length > 0) {
      shouldBeProd.push({ pkg, reason: "imported in production files", prodFiles: u.prodFiles.slice(0, 3) });
    }
  }

  const allOk = shouldBeDev.length === 0 && shouldBeProd.length === 0;

  if (values.json) {
    printJson({
      ok: allOk,
      kind: "better.deps-check",
      shouldBeDev: shouldBeDev.map(s => ({ pkg: s.pkg, reason: s.reason })),
      shouldBeProd: shouldBeProd.map(s => ({ pkg: s.pkg, reason: s.reason })),
    });
    if (!allOk) process.exitCode = 1;
    return;
  }

  printText(`\n\x1b[1mbetter deps-check\x1b[0m — ${files.length} files scanned\n`);

  if (allOk) {
    printText(`\x1b[32m✔ Dependency placement looks correct.\x1b[0m`);
    return;
  }

  if (shouldBeDev.length > 0) {
    printText(`\x1b[33m${shouldBeDev.length} prod dep(s) that should be in devDependencies:\x1b[0m\n`);
    for (const s of shouldBeDev) {
      printText(`  \x1b[33m⚠\x1b[0m  ${s.pkg}`);
      printText(`       \x1b[90m→ ${s.reason}\x1b[0m`);
      for (const f of s.devFiles) printText(`       \x1b[90m  used in: ${f}\x1b[0m`);
    }
    printText("");
  }

  if (shouldBeProd.length > 0) {
    printText(`\x1b[31m${shouldBeProd.length} devDep(s) imported in production code:\x1b[0m\n`);
    for (const s of shouldBeProd) {
      printText(`  \x1b[31m✖\x1b[0m  ${s.pkg}`);
      printText(`       \x1b[90m→ ${s.reason}\x1b[0m`);
      for (const f of s.prodFiles) printText(`       \x1b[90m  in: ${f}\x1b[0m`);
    }
    printText("");
  }

  if (values.fix && shouldBeDev.length > 0) {
    // Move shouldBeDev packages to devDependencies
    const updatedPkg = { ...pkgJson };
    if (!updatedPkg.devDependencies) updatedPkg.devDependencies = {};
    for (const { pkg } of shouldBeDev) {
      const version = updatedPkg.dependencies[pkg];
      if (version) {
        updatedPkg.devDependencies[pkg] = version;
        delete updatedPkg.dependencies[pkg];
      }
    }
    await fs.writeFile(
      path.join(projectRoot, "package.json"),
      JSON.stringify(updatedPkg, null, 2) + "\n",
      "utf8"
    );
    printText(`\x1b[32m✔ Moved ${shouldBeDev.length} package(s) to devDependencies.\x1b[0m`);
    printText(`\x1b[90mRun: npm install\x1b[0m`);
  } else if (shouldBeDev.length > 0) {
    printText(`\x1b[90mRun: better deps-check --fix to move these to devDependencies\x1b[0m`);
  }

  if (!allOk) process.exitCode = 1;
}
