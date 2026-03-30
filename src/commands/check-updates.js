/**
 * better check-updates — show available updates organized by type
 *
 * Fetches the latest version of all dependencies and groups
 * updates by type (patch/minor/major). Similar to npm-check-updates
 * but built into better with richer output.
 *
 * Usage:
 *   better check-updates
 *   better check-updates react next
 *   better check-updates --major-only
 *   better check-updates --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import https from "node:https";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

function fetchLatestVersion(name) {
  return new Promise((resolve) => {
    const encoded = encodeURIComponent(name).replace(/%40/g, "@");
    https.get(`https://registry.npmjs.org/${encoded}/latest`, {
      headers: { "Accept": "application/json", "User-Agent": "better-npm/0.1" },
      timeout: 5000,
    }, (res) => {
      let body = "";
      res.on("data", c => { body += c; });
      res.on("end", () => {
        try { resolve(JSON.parse(body)?.version || null); }
        catch { resolve(null); }
      });
    }).on("error", () => resolve(null)).on("timeout", () => resolve(null));
  });
}

function parseVer(v) {
  const s = String(v).replace(/^[~^>=v\s]+/, "").split(".");
  return [parseInt(s[0]) || 0, parseInt(s[1]) || 0, parseInt(s[2]) || 0];
}

function bumpType(current, latest) {
  const [cm, cmi, cp] = parseVer(current);
  const [lm, lmi, lp] = parseVer(latest);
  if (lm > cm) return "major";
  if (lmi > cmi) return "minor";
  if (lp > cp) return "patch";
  return "none";
}

function keepPrefix(range) {
  return range.match(/^([~^])/)?.[1] ?? "";
}

export async function cmdCheckUpdates(argv) {
  const runtime = getRuntimeConfig();
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json:        { type: "boolean", default: runtime.json === true },
      help:        { type: "boolean", short: "h", default: false },
      "major-only":{ type: "boolean", default: false },
      "minor-only":{ type: "boolean", default: false },
      "patch-only":{ type: "boolean", default: false },
      dev:         { type: "boolean", default: false },
      all:         { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better check-updates [packages...] [options]

Show available package updates organized by bump type.

Options:
  --major-only   Show only major version updates
  --minor-only   Show only minor version updates
  --patch-only   Show only patch version updates
  --dev          Include devDependencies
  --all          Include both prod and dev dependencies
  --json         Machine-readable output
  -h, --help     Show this help

Examples:
  better check-updates
  better check-updates --major-only
  better check-updates react next --all
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

  const sections = {};
  if (values.all || !values.dev) {
    for (const [n, v] of Object.entries(pkgJson.dependencies || {})) {
      sections[n] = { range: v, section: "dependencies" };
    }
  }
  if (values.all || values.dev) {
    for (const [n, v] of Object.entries(pkgJson.devDependencies || {})) {
      sections[n] = { range: v, section: "devDependencies" };
    }
  }

  const targets = positionals.length > 0
    ? positionals.filter(p => sections[p])
    : Object.keys(sections);

  if (!values.json) {
    process.stderr.write(`\x1b[90mChecking ${targets.length} package(s)…\x1b[0m\n`);
  }

  const BATCH = 10;
  const updates = [];

  for (let i = 0; i < targets.length; i += BATCH) {
    const batch = targets.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(async (name) => {
      const { range, section } = sections[name];
      const latest = await fetchLatestVersion(name);
      if (!latest) return null;
      const type = bumpType(range, latest);
      if (type === "none") return null;
      return { name, current: range, latest, type, section };
    }));
    updates.push(...results.filter(Boolean));
  }

  // Filter by type flags
  let filtered = updates;
  if (values["major-only"]) filtered = updates.filter(u => u.type === "major");
  else if (values["minor-only"]) filtered = updates.filter(u => u.type === "minor");
  else if (values["patch-only"]) filtered = updates.filter(u => u.type === "patch");

  filtered.sort((a, b) => {
    const order = { major: 0, minor: 1, patch: 2 };
    return (order[a.type] ?? 3) - (order[b.type] ?? 3) || a.name.localeCompare(b.name);
  });

  if (values.json) {
    printJson({
      ok: true,
      kind: "better.check-updates",
      totalChecked: targets.length,
      updates: filtered.length,
      breakdown: {
        major: filtered.filter(u => u.type === "major").length,
        minor: filtered.filter(u => u.type === "minor").length,
        patch: filtered.filter(u => u.type === "patch").length,
      },
      packages: filtered,
    });
    return;
  }

  printText(`\n\x1b[1mbetter check-updates\x1b[0m — ${targets.length} packages checked\n`);

  if (filtered.length === 0) {
    printText(`\x1b[32m✔ All packages are up to date.\x1b[0m`);
    return;
  }

  const groups = { major: [], minor: [], patch: [] };
  for (const u of filtered) {
    if (groups[u.type]) groups[u.type].push(u);
  }

  const TYPE_COLORS = { major: "\x1b[31m", minor: "\x1b[33m", patch: "\x1b[32m" };
  const TYPE_LABELS = { major: "Major updates", minor: "Minor updates", patch: "Patch updates" };

  for (const type of ["major", "minor", "patch"]) {
    const group = groups[type];
    if (group.length === 0) continue;
    const col = TYPE_COLORS[type];
    printText(`${col}${TYPE_LABELS[type]} (${group.length}):\x1b[0m\n`);

    for (const u of group) {
      const prefix = keepPrefix(u.current);
      const newRange = `${prefix}${u.latest}`;
      printText(`  \x1b[1m${u.name.padEnd(32)}\x1b[0m ${u.current.padEnd(14)} → ${col}${newRange}\x1b[0m  \x1b[90m(${u.section})\x1b[0m`);
    }
    printText("");
  }

  const totalMajor = groups.major.length;
  const totalMinor = groups.minor.length;
  const totalPatch = groups.patch.length;

  const parts = [];
  if (totalMajor) parts.push(`\x1b[31m${totalMajor} major\x1b[0m`);
  if (totalMinor) parts.push(`\x1b[33m${totalMinor} minor\x1b[0m`);
  if (totalPatch) parts.push(`\x1b[32m${totalPatch} patch\x1b[0m`);
  printText(`${filtered.length} update(s) available: ${parts.join(", ")}`);
  printText(`\n\x1b[90mRun: better update-interactive — to select and apply updates\x1b[0m`);
}
