/**
 * better types-check — TypeScript types availability check
 *
 * Checks if installed packages have TypeScript type definitions
 * (either bundled or via @types/* packages).
 *
 * Usage:
 *   better types-check                # check all prod deps
 *   better types-check --install      # suggest @types installs
 *   better types-check lodash express # check specific packages
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import https from "node:https";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

// Known packages that have bundled types (no @types needed)
const HAS_BUNDLED_TYPES = new Set([
  "typescript", "ts-node", "tsx", "esbuild", "vite", "vitest",
  "zod", "trpc", "prisma", "drizzle-orm", "kysely",
  "fastify", "hono", "remix", "next", "nuxt",
  "rxjs", "mobx", "recoil", "jotai", "zustand",
  "date-fns", "luxon", "dayjs",
  "axios", "ky", "got",
  "chalk", "commander", "yargs",
  "jest", "mocha", "vitest",
]);

async function checkBundledTypes(nmPath, name) {
  // Check if package has types field or index.d.ts
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(nmPath, name, "package.json"), "utf8"));
    if (pkg.types || pkg.typings) return { hasTypes: true, source: "bundled-field" };
    if (pkg.exports?.types) return { hasTypes: true, source: "exports-types" };

    // Check for index.d.ts
    try {
      await fs.access(path.join(nmPath, name, "index.d.ts"));
      return { hasTypes: true, source: "index.d.ts" };
    } catch {}
  } catch {}
  return { hasTypes: false, source: null };
}

async function checkAtTypes(nmPath, name) {
  // Check if @types/<name> is installed
  const atTypesName = name.startsWith("@") ? name.replace("/", "__").slice(1) : name;
  try {
    await fs.access(path.join(nmPath, "@types", atTypesName, "package.json"));
    return true;
  } catch {
    return false;
  }
}

async function fetchAtTypesExists(name) {
  return new Promise((resolve) => {
    const atTypesName = name.startsWith("@") ? name.replace("/", "__").slice(1) : name;
    const url = `https://registry.npmjs.org/@types/${atTypesName}/latest`;
    https.get(url, {
      headers: { "Accept": "application/json", "User-Agent": "better-npm/0.1" },
      timeout: 5000,
    }, (res) => {
      resolve(res.statusCode === 200);
    }).on("error", () => resolve(false)).on("timeout", () => resolve(false));
  });
}

export async function cmdTypesCheck(argv) {
  const runtime = getRuntimeConfig();
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: runtime.json === true },
      install: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better types-check [packages...] [options]

Check TypeScript type definitions availability for installed packages.

Options:
  --install    Show suggested @types/* install command
  --json       Machine-readable output
  -h, --help   Show this help

Examples:
  better types-check
  better types-check lodash express
  better types-check --install
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;
  const nmPath = path.join(projectRoot, "node_modules");

  let pkgJson;
  try {
    pkgJson = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8"));
  } catch {
    const msg = "Cannot read package.json";
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`Error: ${msg}`); }
    process.exitCode = 1;
    return;
  }

  // Check if project uses TypeScript
  const usesTypeScript = Boolean(
    pkgJson.devDependencies?.typescript ||
    pkgJson.dependencies?.typescript
  );

  if (!usesTypeScript) {
    if (values.json) {
      printJson({ ok: true, kind: "better.types-check", typescript: false, message: "TypeScript not found in dependencies" });
    } else {
      printText("\x1b[90mTypeScript not detected in this project.\x1b[0m");
    }
    return;
  }

  const prodDeps = Object.keys(pkgJson.dependencies || {});
  const targetNames = positionals.length > 0 ? positionals : prodDeps;

  if (!values.json) {
    process.stderr.write(`\x1b[90mChecking types for ${targetNames.length} packages…\x1b[0m\n`);
  }

  const BATCH = 10;
  const results = [];

  for (let i = 0; i < targetNames.length; i += BATCH) {
    const batch = targetNames.slice(i, i + BATCH);
    const batchResults = await Promise.all(batch.map(async (name) => {
      // Skip @types packages themselves
      if (name.startsWith("@types/")) return null;

      // Check known bundled types
      if (HAS_BUNDLED_TYPES.has(name)) {
        return { name, hasTypes: true, source: "known-bundled" };
      }

      // Check installed bundled types
      const bundled = await checkBundledTypes(nmPath, name);
      if (bundled.hasTypes) return { name, hasTypes: true, source: bundled.source };

      // Check @types/* installed
      const hasAtTypes = await checkAtTypes(nmPath, name);
      if (hasAtTypes) return { name, hasTypes: true, source: "@types" };

      // Check registry for @types/* availability
      const atTypesAvailable = await fetchAtTypesExists(name);
      return {
        name,
        hasTypes: false,
        source: null,
        atTypesAvailable,
        suggestion: atTypesAvailable ? `npm install -D @types/${name}` : null,
      };
    }));

    for (const r of batchResults) {
      if (r) results.push(r);
    }
  }

  const missing = results.filter(r => !r.hasTypes);
  const present = results.filter(r => r.hasTypes);
  const installable = missing.filter(r => r.atTypesAvailable);

  if (values.json) {
    printJson({
      ok: missing.length === 0,
      kind: "better.types-check",
      typescript: true,
      checked: results.length,
      with_types: present.length,
      missing_types: missing.length,
      results,
      install_suggestions: installable.map(r => r.suggestion).filter(Boolean),
    });
    if (missing.length > 0) process.exitCode = 1;
    return;
  }

  printText(`\n\x1b[1mbetter types-check\x1b[0m — ${results.length} packages checked\n`);

  if (missing.length === 0) {
    printText(`\x1b[32m✔ All packages have TypeScript types.\x1b[0m`);
    return;
  }

  printText(`\x1b[31m${missing.length} package(s) missing types:\x1b[0m\n`);
  for (const r of missing) {
    const suggestion = r.atTypesAvailable
      ? `  \x1b[90m→ install: npm install -D @types/${r.name}\x1b[0m`
      : `  \x1b[90m→ no @types available (add declare module or use // @ts-ignore)\x1b[0m`;
    printText(`  \x1b[33m⚠\x1b[0m  ${r.name}`);
    printText(suggestion);
  }

  if (values.install && installable.length > 0) {
    const pkgList = installable.map(r => `@types/${r.name}`).join(" ");
    printText(`\n\x1b[1mInstall missing @types:\x1b[0m`);
    printText(`  npm install -D ${pkgList}`);
  }

  process.exitCode = 1;
}
