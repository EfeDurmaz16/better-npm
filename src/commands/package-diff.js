/**
 * better package-diff <pkg> <v1> <v2> — diff two versions of a package
 *
 * Shows what changed between two published versions of a package:
 * changelog entries, new/removed exports, size change, and deps.
 *
 * Usage:
 *   better package-diff lodash 4.16.0 4.17.21
 *   better package-diff express 4.18.0 5.0.0
 *   better package-diff react --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import https from "node:https";

function fetchJson(url) {
  return new Promise((resolve) => {
    https.get(url, {
      headers: { "Accept": "application/json", "User-Agent": "better-npm/0.1" },
      timeout: 8000,
    }, (res) => {
      let body = "";
      res.on("data", c => { body += c; });
      res.on("end", () => {
        try { resolve(JSON.parse(body)); } catch { resolve(null); }
      });
    }).on("error", () => resolve(null)).on("timeout", () => resolve(null));
  });
}

function fmtBytes(n) {
  if (!n) return "—";
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function diffDeps(oldDeps, newDeps) {
  const old_ = oldDeps || {};
  const new_ = newDeps || {};
  const added   = Object.keys(new_).filter(k => !old_[k]);
  const removed = Object.keys(old_).filter(k => !new_[k]);
  const changed = Object.keys(new_).filter(k => old_[k] && old_[k] !== new_[k])
    .map(k => ({ name: k, from: old_[k], to: new_[k] }));
  return { added, removed, changed };
}

function diffExports(oldPkg, newPkg) {
  const getExportKeys = (pkg) => {
    if (!pkg.exports) return new Set(["main"]);
    if (typeof pkg.exports === "string") return new Set(["."]);
    return new Set(Object.keys(pkg.exports));
  };

  const oldKeys = getExportKeys(oldPkg);
  const newKeys = getExportKeys(newPkg);

  return {
    added: [...newKeys].filter(k => !oldKeys.has(k)),
    removed: [...oldKeys].filter(k => !newKeys.has(k)),
  };
}

export async function cmdPackageDiff(argv) {
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
    printText(`Usage: better package-diff <package> [v1] [v2] [options]

Show changes between two versions of a published package.

Arguments:
  package   Package name
  v1        First version (default: one before latest)
  v2        Second version (default: latest)

Options:
  --json       Machine-readable output
  -h, --help   Show this help

Examples:
  better package-diff lodash 4.16.0 4.17.21
  better package-diff express 4.18.0 5.0.0
  better package-diff react  (compares last two stable releases)
`);
    return;
  }

  if (positionals.length < 1) {
    printText(`Usage: better package-diff <package> [v1] [v2] [--json]`);
    process.exitCode = 1;
    return;
  }

  const pkgName = positionals[0];

  if (!values.json) {
    process.stderr.write(`\x1b[90mFetching metadata for ${pkgName}…\x1b[0m\n`);
  }

  const encoded = encodeURIComponent(pkgName).replace(/%40/g, "@");
  const meta = await fetchJson(`https://registry.npmjs.org/${encoded}`);

  if (!meta?.versions) {
    const msg = `Package "${pkgName}" not found`;
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`\x1b[31mError: ${msg}\x1b[0m`); }
    process.exitCode = 1;
    return;
  }

  // Determine v1 and v2
  const stableVersions = Object.keys(meta.versions)
    .filter(v => !v.includes("-"))
    .sort((a, b) => {
      const [am, ami, ap] = a.split(".").map(Number);
      const [bm, bmi, bp] = b.split(".").map(Number);
      if (am !== bm) return am - bm;
      if (ami !== bmi) return ami - bmi;
      return ap - bp;
    });

  const latest = meta["dist-tags"]?.latest || stableVersions[stableVersions.length - 1];
  const latestIdx = stableVersions.indexOf(latest);
  const prevVersion = stableVersions[Math.max(0, latestIdx - 1)];

  const v1 = positionals[1] || prevVersion;
  const v2 = positionals[2] || latest;

  if (!meta.versions[v1]) {
    const msg = `Version ${v1} not found for ${pkgName}`;
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`\x1b[31mError: ${msg}\x1b[0m`); }
    process.exitCode = 1;
    return;
  }

  if (!meta.versions[v2]) {
    const msg = `Version ${v2} not found for ${pkgName}`;
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`\x1b[31mError: ${msg}\x1b[0m`); }
    process.exitCode = 1;
    return;
  }

  const pkg1 = meta.versions[v1];
  const pkg2 = meta.versions[v2];

  const sizeChange = (pkg2.dist?.unpackedSize || 0) - (pkg1.dist?.unpackedSize || 0);
  const sizeChangePct = pkg1.dist?.unpackedSize
    ? (sizeChange / pkg1.dist.unpackedSize) * 100
    : null;

  const depDiff = diffDeps(pkg1.dependencies, pkg2.dependencies);
  const devDepDiff = diffDeps(pkg1.devDependencies, pkg2.devDependencies);
  const exportsDiff = diffExports(pkg1, pkg2);

  const deprecatedAdded = !pkg1.deprecated && !!pkg2.deprecated;
  const licenseChanged = pkg1.license !== pkg2.license;
  const enginesChanged = JSON.stringify(pkg1.engines) !== JSON.stringify(pkg2.engines);

  const publishDates = {
    v1: meta.time?.[v1] || null,
    v2: meta.time?.[v2] || null,
  };

  if (values.json) {
    printJson({
      ok: true,
      kind: "better.package-diff",
      name: pkgName,
      from: v1,
      to: v2,
      size: {
        from: pkg1.dist?.unpackedSize || null,
        to: pkg2.dist?.unpackedSize || null,
        change: sizeChange,
        changePct: sizeChangePct,
      },
      dependencies: depDiff,
      devDependencies: devDepDiff,
      exports: exportsDiff,
      deprecated: deprecatedAdded,
      licenseChanged,
      enginesChanged,
    });
    return;
  }

  printText(`\n\x1b[1mbetter package-diff\x1b[0m — ${pkgName}\n`);
  printText(`  \x1b[1m${v1}\x1b[0m → \x1b[1m${v2}\x1b[0m`);
  if (publishDates.v1) printText(`  \x1b[90mPublished: ${new Date(publishDates.v1).toLocaleDateString()} → ${new Date(publishDates.v2 || "").toLocaleDateString()}\x1b[0m`);
  printText("");

  // Size
  const s1 = fmtBytes(pkg1.dist?.unpackedSize);
  const s2 = fmtBytes(pkg2.dist?.unpackedSize);
  const sizeLine = `  Size: ${s1} → ${s2}`;
  if (sizeChange !== 0) {
    const sign = sizeChange > 0 ? "+" : "";
    const col = sizeChange > 0 ? "\x1b[33m" : "\x1b[32m";
    printText(`${sizeLine}  ${col}${sign}${fmtBytes(Math.abs(sizeChange))} (${sign}${(sizeChangePct || 0).toFixed(1)}%)\x1b[0m`);
  } else {
    printText(`${sizeLine}  \x1b[90m(no change)\x1b[0m`);
  }

  // Warnings
  if (deprecatedAdded) printText(`\n  \x1b[31m⚠ Deprecated in ${v2}: ${pkg2.deprecated}\x1b[0m`);
  if (licenseChanged) printText(`\n  \x1b[33m⚠ License changed: ${pkg1.license} → ${pkg2.license}\x1b[0m`);
  if (enginesChanged) printText(`\n  \x1b[33m⚠ Engine requirements changed\x1b[0m`);

  // Dependencies
  const totalDepChanges = depDiff.added.length + depDiff.removed.length + depDiff.changed.length;
  if (totalDepChanges > 0) {
    printText(`\n  \x1b[1mDependencies (${totalDepChanges > 0 ? totalDepChanges + " change(s)" : "no changes"}):\x1b[0m`);
    for (const d of depDiff.added)   printText(`    \x1b[32m+\x1b[0m ${d}  ${pkg2.dependencies[d]}`);
    for (const d of depDiff.removed) printText(`    \x1b[31m-\x1b[0m ${d}`);
    for (const d of depDiff.changed) printText(`    \x1b[33m~\x1b[0m ${d.name}  ${d.from} → ${d.to}`);
  } else {
    printText(`\n  \x1b[90mDependencies: no changes\x1b[0m`);
  }

  // Exports
  if (exportsDiff.added.length > 0 || exportsDiff.removed.length > 0) {
    printText(`\n  \x1b[1mExports:\x1b[0m`);
    for (const e of exportsDiff.added)   printText(`    \x1b[32m+ ${e}\x1b[0m`);
    for (const e of exportsDiff.removed) printText(`    \x1b[31m- ${e}\x1b[0m`);
  }

  printText("");
}
