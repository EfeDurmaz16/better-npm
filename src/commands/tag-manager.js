/**
 * better tag-manager — manage npm dist-tags for packages
 *
 * Lists, adds, and removes dist-tags (like latest, beta, next) for
 * packages you maintain on the npm registry.
 *
 * Usage:
 *   better tag-manager <package>
 *   better tag-manager <package> --add beta 1.2.3-beta.0
 *   better tag-manager <package> --remove canary
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import https from "node:https";
import { spawnSync } from "node:child_process";

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "better-npm/1.0" }, timeout: 10000 }, (res) => {
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

export async function cmdTagManager(argv) {
  const runtime = getRuntimeConfig();
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json:    { type: "boolean", default: runtime.json === true },
      help:    { type: "boolean", short: "h", default: false },
      add:     { type: "string" },    // --add <tag>
      remove:  { type: "string" },    // --remove <tag>
      version: { type: "string" },    // version for --add
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better tag-manager <package> [options]

Manage npm dist-tags for packages you maintain.

Options:
  --add <tag>        Add a dist-tag (requires --version)
  --version <v>      Version for --add
  --remove <tag>     Remove a dist-tag
  --json             Machine-readable output
  -h, --help         Show this help

Examples:
  better tag-manager mypackage
  better tag-manager mypackage --add beta --version 1.2.3-beta.0
  better tag-manager mypackage --remove canary
`);
    return;
  }

  if (positionals.length === 0) {
    printText("Usage: better tag-manager <package>\nRun: better tag-manager --help for more info.");
    process.exitCode = 1;
    return;
  }

  const pkgName = positionals[0];

  if (!values.json) {
    printText(`\n\x1b[1mbetter tag-manager\x1b[0m — ${pkgName}\n`);
  }

  // Add tag
  if (values.add) {
    if (!values.version) {
      printText(`\x1b[31mError: --version required with --add\x1b[0m`);
      process.exitCode = 1;
      return;
    }
    const result = spawnSync("npm", ["dist-tag", "add", `${pkgName}@${values.version}`, values.add], { encoding: "utf8", stdio: "inherit" });
    if (values.json) {
      printJson({ ok: result.status === 0, kind: "better.tag-manager", action: "add", tag: values.add, version: values.version });
    }
    process.exitCode = result.status;
    return;
  }

  // Remove tag
  if (values.remove) {
    const result = spawnSync("npm", ["dist-tag", "rm", pkgName, values.remove], { encoding: "utf8", stdio: "inherit" });
    if (values.json) {
      printJson({ ok: result.status === 0, kind: "better.tag-manager", action: "remove", tag: values.remove });
    }
    process.exitCode = result.status;
    return;
  }

  // List tags (default)
  let tags = null;
  try {
    const res = await httpsGet(`https://registry.npmjs.org/-/package/${encodeURIComponent(pkgName)}/dist-tags`);
    if (res.status === 200) tags = JSON.parse(res.body);
  } catch {}

  if (!tags) {
    const msg = `Cannot fetch tags for ${pkgName}`;
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`\x1b[31mError: ${msg}\x1b[0m`); }
    process.exitCode = 1;
    return;
  }

  if (values.json) {
    printJson({ ok: true, kind: "better.tag-manager", package: pkgName, tags });
    return;
  }

  for (const [tag, version] of Object.entries(tags)) {
    const color = tag === "latest" ? "\x1b[32m" : tag === "beta" || tag === "next" ? "\x1b[33m" : "\x1b[90m";
    printText(`  ${color}${tag.padEnd(15)}\x1b[0m  ${version}`);
  }
  printText("");
}
