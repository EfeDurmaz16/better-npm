/**
 * better package-json-diff — diff two versions of a package's package.json
 *
 * Shows what changed in a package's package.json between two versions:
 * new/removed dependencies, script changes, field changes.
 *
 * Usage:
 *   better package-json-diff lodash 4.16.0 4.17.21
 *   better package-json-diff express 4.18.0 5.0.0
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import https from "node:https";

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

function diffObjects(before, after, path = "") {
  const changes = [];
  const allKeys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);

  for (const key of [...allKeys].sort()) {
    const bVal = before?.[key];
    const aVal = after?.[key];
    const fullPath = path ? `${path}.${key}` : key;

    if (bVal === undefined) {
      changes.push({ type: "added", path: fullPath, value: aVal });
    } else if (aVal === undefined) {
      changes.push({ type: "removed", path: fullPath, value: bVal });
    } else if (typeof bVal === "object" && typeof aVal === "object" && bVal !== null && aVal !== null && !Array.isArray(bVal) && !Array.isArray(aVal)) {
      changes.push(...diffObjects(bVal, aVal, fullPath));
    } else if (JSON.stringify(bVal) !== JSON.stringify(aVal)) {
      changes.push({ type: "changed", path: fullPath, before: bVal, after: aVal });
    }
  }
  return changes;
}

export async function cmdPackageJsonDiff(argv) {
  const runtime = getRuntimeConfig();
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json:  { type: "boolean", default: runtime.json === true },
      help:  { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better package-json-diff <package> <version1> <version2>

Diff package.json between two versions of a package.

Options:
  --json       Machine-readable output
  -h, --help   Show this help

Examples:
  better package-json-diff lodash 4.16.0 4.17.21
  better package-json-diff express 4.18.0 5.0.0
`);
    return;
  }

  if (positionals.length < 3) {
    printText("Usage: better package-json-diff <package> <version1> <version2>\nRun: better package-json-diff --help for more info.");
    process.exitCode = 1;
    return;
  }

  const [pkgName, v1, v2] = positionals;

  if (!values.json) {
    printText(`\n\x1b[1mbetter package-json-diff\x1b[0m — ${pkgName} ${v1} → ${v2}\n`);
    process.stderr.write(`\x1b[90mFetching package metadata...\x1b[0m\n`);
  }

  let meta1 = null, meta2 = null;
  try {
    const [r1, r2] = await Promise.all([
      httpsGet(`https://registry.npmjs.org/${encodeURIComponent(pkgName)}/${encodeURIComponent(v1)}`),
      httpsGet(`https://registry.npmjs.org/${encodeURIComponent(pkgName)}/${encodeURIComponent(v2)}`),
    ]);
    if (r1.status === 200) meta1 = JSON.parse(r1.body);
    if (r2.status === 200) meta2 = JSON.parse(r2.body);
  } catch {}

  if (!meta1 || !meta2) {
    const msg = `Could not fetch both versions of ${pkgName}`;
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`\x1b[31mError: ${msg}\x1b[0m`); }
    process.exitCode = 1;
    return;
  }

  // Focus on interesting fields
  const IMPORTANT_FIELDS = ["version", "description", "main", "module", "exports", "types", "typings", "license", "engines", "os", "cpu", "dependencies", "peerDependencies", "optionalDependencies", "scripts", "keywords"];
  const before = {};
  const after = {};
  for (const field of IMPORTANT_FIELDS) {
    if (meta1[field] !== undefined) before[field] = meta1[field];
    if (meta2[field] !== undefined) after[field] = meta2[field];
  }

  const changes = diffObjects(before, after);

  if (values.json) {
    printJson({ ok: true, kind: "better.package-json-diff", package: pkgName, from: v1, to: v2, changes });
    return;
  }

  if (changes.length === 0) {
    printText(`  \x1b[90mNo changes in key package.json fields.\x1b[0m\n`);
    return;
  }

  for (const c of changes) {
    if (c.type === "added") {
      const val = typeof c.value === "object" ? JSON.stringify(c.value).slice(0, 60) : String(c.value).slice(0, 60);
      printText(`  \x1b[32m+\x1b[0m  \x1b[1m${c.path}\x1b[0m: \x1b[32m${val}\x1b[0m`);
    } else if (c.type === "removed") {
      const val = typeof c.value === "object" ? JSON.stringify(c.value).slice(0, 60) : String(c.value).slice(0, 60);
      printText(`  \x1b[31m-\x1b[0m  \x1b[1m${c.path}\x1b[0m: \x1b[31m${val}\x1b[0m`);
    } else {
      const b = typeof c.before === "object" ? JSON.stringify(c.before).slice(0, 40) : String(c.before).slice(0, 40);
      const a = typeof c.after === "object" ? JSON.stringify(c.after).slice(0, 40) : String(c.after).slice(0, 40);
      printText(`  \x1b[33m~\x1b[0m  \x1b[1m${c.path}\x1b[0m: \x1b[31m${b}\x1b[0m → \x1b[32m${a}\x1b[0m`);
    }
  }
  printText("");
}
