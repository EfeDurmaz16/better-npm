/**
 * better deprecations — scan for deprecated packages
 *
 * Checks all installed packages against the npm registry for
 * deprecation notices and suggests alternatives.
 *
 * Usage:
 *   better deprecations               # scan all direct deps
 *   better deprecations --all         # include transitive
 *   better deprecations --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import https from "node:https";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

const KNOWN_DEPRECATIONS = new Map([
  ["request", "Use node-fetch, got, or axios instead"],
  ["node-uuid", "Use the 'uuid' package instead"],
  ["jade", "Renamed to 'pug'"],
  ["bower", "Use npm workspaces or yarn workspaces instead"],
  ["grunt", "Consider modern alternatives like Vite or esbuild"],
  ["coffee-script", "Use TypeScript or modern JS instead"],
  ["q", "Use native Promises or async/await"],
  ["when", "Use native Promises"],
  ["bluebird", "Use native Promises"],
  ["underscore", "Consider lodash or native ES6+ methods"],
  ["npmlog", "Use the 'proc-log' package instead"],
  ["har-validator", "No longer maintained, use joi or yup"],
  ["uuid", null], // not deprecated, adding for completeness
]);

async function fetchDeprecation(name, version) {
  return new Promise((resolve) => {
    const url = `https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`;
    https.get(url, {
      headers: { "Accept": "application/json", "User-Agent": "better-npm/0.1" },
      timeout: 5000,
    }, (res) => {
      let body = "";
      res.on("data", c => { body += c; });
      res.on("end", () => {
        try {
          const data = JSON.parse(body);
          resolve(data.deprecated || null);
        } catch { resolve(null); }
      });
    }).on("error", () => resolve(null)).on("timeout", () => resolve(null));
  });
}

export async function cmdDeprecations(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: runtime.json === true },
      all: { type: "boolean", default: false },
      "offline": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better deprecations [options]

Scan for deprecated packages in node_modules.
Checks npm registry and known deprecation list.

Options:
  --all           Include transitive dependencies (slower)
  --offline       Use only built-in known-deprecation list
  --json          Machine-readable output
  -h, --help      Show this help

Examples:
  better deprecations
  better deprecations --all
  better deprecations --offline
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

  // Get package list
  const directDeps = {
    ...pkgJson.dependencies,
    ...pkgJson.devDependencies,
  };

  let checkList;
  if (values.all) {
    // Read from package-lock for all installed
    const lockPath = path.join(projectRoot, "package-lock.json");
    try {
      const lock = JSON.parse(await fs.readFile(lockPath, "utf8"));
      checkList = [];
      for (const [pkgPath, info] of Object.entries(lock.packages || {})) {
        if (!pkgPath || pkgPath === "") continue;
        const name = pkgPath.startsWith("node_modules/") ? pkgPath.slice(13) : pkgPath;
        if (!name || name.includes("/node_modules/")) continue;
        // Check lockfile deprecated flag first
        if (info.deprecated) {
          checkList.push({ name, version: info.version, deprecated: info.deprecated });
        } else {
          checkList.push({ name, version: info.version, deprecated: null });
        }
      }
    } catch {
      checkList = Object.keys(directDeps).map(n => ({ name: n, version: directDeps[n], deprecated: null }));
    }
  } else {
    // Check direct deps + lockfile deprecated flags
    const lockPath = path.join(projectRoot, "package-lock.json");
    const lockDeprecated = {};
    try {
      const lock = JSON.parse(await fs.readFile(lockPath, "utf8"));
      for (const [pkgPath, info] of Object.entries(lock.packages || {})) {
        if (!pkgPath || pkgPath === "") continue;
        const name = pkgPath.startsWith("node_modules/") ? pkgPath.slice(13) : pkgPath;
        if (name && !name.includes("/node_modules/") && info.deprecated) {
          lockDeprecated[name] = info.deprecated;
        }
      }
    } catch {}
    checkList = Object.keys(directDeps).map(n => ({
      name: n,
      version: directDeps[n],
      deprecated: lockDeprecated[n] || null,
    }));
  }

  if (!values.json) {
    process.stderr.write(`\x1b[90mChecking ${checkList.length} packages for deprecations…\x1b[0m\n`);
  }

  const deprecated = [];

  // First pass: known deprecations and lockfile flags
  const toFetch = [];
  for (const { name, version, deprecated: lockDep } of checkList) {
    if (lockDep) {
      deprecated.push({ name, version, message: lockDep, source: "lockfile" });
      continue;
    }
    const knownMsg = KNOWN_DEPRECATIONS.get(name);
    if (knownMsg !== undefined && knownMsg !== null) {
      deprecated.push({ name, version, message: `Known deprecated. ${knownMsg}`, source: "known" });
      continue;
    }
    if (!values.offline) {
      toFetch.push({ name, version });
    }
  }

  // Second pass: fetch from registry for remaining
  if (!values.offline && toFetch.length > 0) {
    const BATCH = 5;
    for (let i = 0; i < toFetch.length; i += BATCH) {
      const batch = toFetch.slice(i, i + BATCH);
      const results = await Promise.all(batch.map(async ({ name, version }) => {
        const cleanVersion = String(version).replace(/^[\^~>=<\s]+/, "").split(" ")[0] || "latest";
        const msg = await fetchDeprecation(name, cleanVersion);
        return msg ? { name, version, message: msg, source: "registry" } : null;
      }));
      for (const r of results) {
        if (r) deprecated.push(r);
      }
    }
  }

  const total = checkList.length;

  if (values.json) {
    printJson({
      ok: deprecated.length === 0,
      kind: "better.deprecations",
      deprecated,
      total_checked: total,
      deprecated_count: deprecated.length,
    });
    if (deprecated.length > 0) process.exitCode = 1;
    return;
  }

  printText(`\n\x1b[1mbetter deprecations\x1b[0m — checked ${total} packages\n`);

  if (deprecated.length === 0) {
    printText(`\x1b[32m✔ No deprecated packages found.\x1b[0m`);
    return;
  }

  printText(`\x1b[31m${deprecated.length} deprecated package(s):\x1b[0m\n`);
  for (const d of deprecated) {
    printText(`  \x1b[31m✖\x1b[0m  \x1b[1m${d.name}\x1b[0m \x1b[90m(${String(d.version).replace(/^[\^~>=<]+/, "")})\x1b[0m`);
    if (d.message && d.message !== "true") {
      printText(`       \x1b[90m${d.message.slice(0, 120)}\x1b[0m`);
    }
  }

  process.exitCode = 1;
}
