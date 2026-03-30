/**
 * better semver-check — test semver range expressions
 *
 * Interactive semver range tester. Check whether versions satisfy
 * ranges, find the highest matching version, and explore semver
 * operations without needing to write code.
 *
 * Usage:
 *   better semver-check "^1.2.3" "1.5.0"
 *   better semver-check --range ">=2.0.0 <3.0.0" --version "2.4.1"
 *   better semver-check lodash --check "^4.0.0"
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import https from "node:https";

// Minimal semver satisfaction without dependencies
function parseVersion(v) {
  const s = String(v).replace(/^v/, "").split(/[-+]/)[0].split(".");
  return [parseInt(s[0]) || 0, parseInt(s[1]) || 0, parseInt(s[2]) || 0];
}

function cmp(a, b) {
  const [am, ami, ap] = parseVersion(a);
  const [bm, bmi, bp] = parseVersion(b);
  if (am !== bm) return am - bm;
  if (ami !== bmi) return ami - bmi;
  return ap - bp;
}

function satisfiesSingle(version, constraint) {
  const c = constraint.trim();
  if (!c || c === "*" || c === "x") return true;

  const tilde = c.startsWith("~");
  const caret = c.startsWith("^");
  const strip = c.replace(/^[~^>=<! ]+/, "").trim();
  const [major, minor, patch] = parseVersion(strip);
  const [vm, vmi, vp] = parseVersion(version);

  if (caret) {
    if (major > 0) return vm === major && cmp(version, strip) >= 0;
    if (minor > 0) return vm === 0 && vmi === minor && cmp(version, strip) >= 0;
    return vm === 0 && vmi === 0 && vp >= patch;
  }
  if (tilde) {
    return vm === major && vmi === minor && cmp(version, strip) >= 0;
  }
  if (c.startsWith(">=")) return cmp(version, strip) >= 0;
  if (c.startsWith(">"))  return cmp(version, strip) > 0;
  if (c.startsWith("<=")) return cmp(version, strip) <= 0;
  if (c.startsWith("<"))  return cmp(version, strip) < 0;
  if (c.startsWith("!=")) return cmp(version, strip) !== 0;
  // exact
  return cmp(version, strip) === 0;
}

function satisfiesRange(version, range) {
  if (!range || range === "*") return true;
  // Handle || (OR)
  const orParts = range.split("||").map(s => s.trim());
  return orParts.some(part => {
    // AND: space-separated constraints
    const andParts = part.split(/\s+/).filter(Boolean);
    return andParts.every(c => satisfiesSingle(version, c));
  });
}

function fetchAllVersions(name) {
  return new Promise((resolve) => {
    const encoded = encodeURIComponent(name).replace(/%40/g, "@");
    https.get(`https://registry.npmjs.org/${encoded}`, {
      headers: { "Accept": "application/json", "User-Agent": "better-npm/0.1" },
      timeout: 8000,
    }, (res) => {
      let body = "";
      res.on("data", c => { body += c; });
      res.on("end", () => {
        try {
          const data = JSON.parse(body);
          resolve(Object.keys(data.versions || {}));
        } catch { resolve(null); }
      });
    }).on("error", () => resolve(null)).on("timeout", () => resolve(null));
  });
}

export async function cmdSemverCheck(argv) {
  const runtime = getRuntimeConfig();
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json:    { type: "boolean", default: runtime.json === true },
      help:    { type: "boolean", short: "h", default: false },
      range:   { type: "string" },
      version: { type: "string" },
      check:   { type: "string" },
      pkg:     { type: "string" },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better semver-check [options] [range] [version...]

Test semver range expressions and find matching versions.

Modes:
  Range + version test:
    better semver-check "^1.2.3" "1.5.0" "2.0.0"

  Package + range (find matching published versions):
    better semver-check --pkg lodash --check "^4.17.0"

Options:
  --range <r>    Semver range to test
  --version <v>  Version to test against range
  --pkg <name>   Package name (fetch all published versions)
  --check <r>    Range to match against package versions
  --json         Machine-readable output
  -h, --help     Show this help

Examples:
  better semver-check "^1.2.3" "1.5.0"
  better semver-check --pkg react --check ">=17.0.0 <19.0.0"
  better semver-check ">=1.0.0 <2.0.0" "0.9" "1.0" "1.5" "2.0"
`);
    return;
  }

  // Mode 1: test specific versions against a range
  if (positionals.length >= 2 || (values.range && values.version)) {
    const range = values.range || positionals[0];
    const testVersions = values.version
      ? [values.version]
      : positionals.slice(1);

    const results = testVersions.map(v => ({
      version: v,
      satisfies: satisfiesRange(v, range),
    }));

    if (values.json) {
      printJson({
        ok: true,
        kind: "better.semver-check",
        range,
        results,
        allSatisfy: results.every(r => r.satisfies),
      });
      return;
    }

    printText(`\n\x1b[1mbetter semver-check\x1b[0m — range: \x1b[33m${range}\x1b[0m\n`);
    for (const r of results) {
      const icon = r.satisfies ? "\x1b[32m✔\x1b[0m" : "\x1b[31m✖\x1b[0m";
      const label = r.satisfies ? "\x1b[32msatisfies\x1b[0m" : "\x1b[31mdoes not satisfy\x1b[0m";
      printText(`  ${icon}  \x1b[1m${r.version}\x1b[0m  ${label}`);
    }
    printText("");
    return;
  }

  // Mode 2: find matching published versions for a package
  const pkgName = values.pkg || positionals[0];
  const checkRange = values.check || positionals[1];

  if (!pkgName) {
    printText(`Usage: better semver-check <range> <version...>\n       better semver-check --pkg <name> --check <range>`);
    process.exitCode = 1;
    return;
  }

  if (!values.json) {
    process.stderr.write(`\x1b[90mFetching versions for ${pkgName}…\x1b[0m\n`);
  }

  const allVersions = await fetchAllVersions(pkgName);
  if (!allVersions) {
    const msg = `Package "${pkgName}" not found`;
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`\x1b[31mError: ${msg}\x1b[0m`); }
    process.exitCode = 1;
    return;
  }

  const stableVersions = allVersions.filter(v => !v.includes("-"));
  stableVersions.sort(cmp);

  const filtered = checkRange
    ? stableVersions.filter(v => satisfiesRange(v, checkRange))
    : stableVersions;

  if (values.json) {
    printJson({
      ok: true,
      kind: "better.semver-check",
      package: pkgName,
      range: checkRange || "*",
      totalVersions: stableVersions.length,
      matchingVersions: filtered.length,
      versions: filtered,
      latest: filtered[filtered.length - 1] || null,
    });
    return;
  }

  printText(`\n\x1b[1mbetter semver-check\x1b[0m — ${pkgName}`);
  if (checkRange) {
    printText(`Range: \x1b[33m${checkRange}\x1b[0m  (${filtered.length}/${stableVersions.length} versions match)\n`);
  } else {
    printText(`All stable versions (${stableVersions.length} total)\n`);
  }

  if (filtered.length === 0) {
    printText(`\x1b[31mNo versions match the range.\x1b[0m`);
    return;
  }

  // Show last 20 matching
  const shown = filtered.slice(-20);
  if (filtered.length > 20) printText(`\x1b[90m... ${filtered.length - 20} older versions omitted ...\x1b[0m`);

  for (const v of shown) {
    const isLast = v === filtered[filtered.length - 1];
    printText(`  ${isLast ? "\x1b[32m✔\x1b[0m" : " "} ${isLast ? `\x1b[1m${v}\x1b[0m \x1b[90m(latest match)\x1b[0m` : v}`);
  }

  printText(`\n\x1b[90mLatest matching: \x1b[1m${filtered[filtered.length - 1]}\x1b[0m`);
  printText("");
}
