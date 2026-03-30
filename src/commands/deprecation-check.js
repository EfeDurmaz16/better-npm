/**
 * better deprecation-check — check for deprecated packages with alternatives
 *
 * Scans installed packages for deprecation notices and suggests
 * modern replacements where available.
 *
 * Usage:
 *   better deprecation-check
 *   better deprecation-check --prod-only
 *   better deprecation-check --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import https from "node:https";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "better-npm/1.0" }, timeout: 8000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolve(httpsGet(res.headers.location));
        return;
      }
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
  });
}

// Known deprecated packages and their alternatives
const KNOWN_ALTERNATIVES = {
  "request": "axios, node-fetch, or got",
  "moment": "date-fns, luxon, or dayjs",
  "lodash": "native ES2015+ or lodash-es",
  "underscore": "native ES2015+ or lodash",
  "glob": "fast-glob or tinyglobby",
  "rimraf": "native fs.rm() (Node.js 14.14+)",
  "mkdirp": "native fs.mkdir({ recursive: true })",
  "uuid": "nanoid or crypto.randomUUID()",
  "node-uuid": "crypto.randomUUID()",
  "colors": "chalk or picocolors",
  "color": "chalk or picocolors",
  "chalk@4": "chalk@5 (ESM only) or picocolors",
  "querystring": "native URLSearchParams",
  "url": "native URL class",
  "path": "native path module",
  "inherits": "native class extends",
  "core-js@2": "core-js@3",
  "babel-polyfill": "@babel/polyfill or core-js@3",
  "jade": "pug",
  "coffee-script": "typescript",
  "bower": "npm or yarn",
  "grunt": "npm scripts or gulp",
};

export async function cmdDeprecationCheck(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:       { type: "boolean", default: runtime.json === true },
      help:       { type: "boolean", short: "h", default: false },
      "prod-only":{ type: "boolean", default: false },
      "no-fetch": { type: "boolean", default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better deprecation-check [options]

Find deprecated packages and suggest modern alternatives.

Options:
  --prod-only    Only check production dependencies
  --no-fetch     Only check local package.json files (skip registry)
  --json         Machine-readable output
  -h, --help     Show this help
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;
  const nmPath = path.join(projectRoot, "node_modules");

  if (!values.json) {
    printText(`\n\x1b[1mbetter deprecation-check\x1b[0m\n`);
    process.stderr.write(`\x1b[90mScanning for deprecated packages...\x1b[0m\n`);
  }

  let pkgJson;
  try { pkgJson = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8")); } catch { pkgJson = {}; }

  const depsToCheck = values["prod-only"]
    ? Object.keys(pkgJson.dependencies || {})
    : Object.keys({ ...pkgJson.dependencies, ...pkgJson.devDependencies });

  const deprecated = [];

  // Check local node_modules first (faster)
  const BATCH = 15;
  for (let i = 0; i < depsToCheck.length; i += BATCH) {
    const batch = depsToCheck.slice(i, i + BATCH);
    await Promise.all(batch.map(async (dep) => {
      try {
        const pkg = JSON.parse(await fs.readFile(path.join(nmPath, dep, "package.json"), "utf8"));
        if (pkg.deprecated) {
          const alt = KNOWN_ALTERNATIVES[dep] || extractAlternativeFromMessage(pkg.deprecated);
          deprecated.push({ name: dep, version: pkg.version, message: pkg.deprecated, alternative: alt, source: "installed" });
        }
      } catch {}
    }));
  }

  // Also check known problematic packages not yet installed
  if (!values["no-fetch"] && depsToCheck.length > 0) {
    const notInstalled = depsToCheck.filter(d => !deprecated.find(dep => dep.name === d));
    const FBATCH = 5;
    for (let i = 0; i < Math.min(notInstalled.length, 20); i += FBATCH) {
      const batch = notInstalled.slice(i, i + FBATCH);
      await Promise.all(batch.map(async (dep) => {
        if (KNOWN_ALTERNATIVES[dep]) {
          // Check if this is actually deprecated
          try {
            const res = await httpsGet(`https://registry.npmjs.org/${encodeURIComponent(dep)}/latest`);
            if (res.status === 200) {
              const meta = JSON.parse(res.body);
              if (meta.deprecated) {
                deprecated.push({ name: dep, version: meta.version, message: meta.deprecated, alternative: KNOWN_ALTERNATIVES[dep], source: "registry" });
              }
            }
          } catch {}
        }
      }));
    }
  }

  const errors = deprecated.filter(d => !d.alternative || d.message.toLowerCase().includes("do not use"));
  const allOk = deprecated.length === 0;

  if (values.json) {
    printJson({ ok: allOk, kind: "better.deprecation-check", deprecated, count: deprecated.length });
    if (!allOk) process.exitCode = 1;
    return;
  }

  if (deprecated.length === 0) {
    printText(`\x1b[32m✔ No deprecated packages found.\x1b[0m`);
    printText("");
    return;
  }

  for (const d of deprecated) {
    printText(`  \x1b[33m⚠\x1b[0m  \x1b[1m${d.name}@${d.version}\x1b[0m`);
    const msg = d.message.length > 100 ? d.message.slice(0, 100) + "..." : d.message;
    printText(`       \x1b[90m${msg}\x1b[0m`);
    if (d.alternative) printText(`       \x1b[32m→ Consider: ${d.alternative}\x1b[0m`);
  }

  printText(`\n\x1b[33m⚠ ${deprecated.length} deprecated package(s) found.\x1b[0m`);
  printText("");
}

function extractAlternativeFromMessage(msg) {
  const m = msg.match(/use\s+([`"']?[\w@/-]+[`"']?)/i)
    || msg.match(/instead\s+use\s+([`"']?[\w@/-]+[`"']?)/i)
    || msg.match(/replaced\s+by\s+([`"']?[\w@/-]+[`"']?)/i);
  return m ? m[1].replace(/[`"']/g, "") : null;
}
