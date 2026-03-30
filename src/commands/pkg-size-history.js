/**
 * better pkg-size-history <package> — track a package's size over versions
 *
 * Shows how the unpacked size of a package has changed across recent
 * published versions, helping identify size regressions.
 *
 * Usage:
 *   better pkg-size-history lodash
 *   better pkg-size-history express --versions 10
 *   better pkg-size-history --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import https from "node:https";

function fetchJson(url) {
  return new Promise((resolve) => {
    https.get(url, {
      headers: { "Accept": "application/json", "User-Agent": "better-npm/0.1" },
      timeout: 10000,
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

function bar(n, max, width = 20) {
  if (!n || !max) return " ".repeat(width);
  const filled = Math.round((n / max) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function pctChange(prev, curr) {
  if (!prev || !curr) return null;
  return ((curr - prev) / prev) * 100;
}

function fmtPct(pct) {
  if (pct === null) return "";
  const sign = pct > 0 ? "+" : "";
  const col = pct > 10 ? "\x1b[31m" : pct > 0 ? "\x1b[33m" : "\x1b[32m";
  return ` ${col}${sign}${pct.toFixed(1)}%\x1b[0m`;
}

export async function cmdPkgSizeHistory(argv) {
  const runtime = getRuntimeConfig();
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json:     { type: "boolean", default: runtime.json === true },
      help:     { type: "boolean", short: "h", default: false },
      versions: { type: "string", default: "15" },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better pkg-size-history <package> [options]

Show unpacked size history across published versions.

Options:
  --versions <n>   Number of recent versions to show (default: 15)
  --json           Machine-readable output
  -h, --help       Show this help

Examples:
  better pkg-size-history lodash
  better pkg-size-history express --versions 20
`);
    return;
  }

  if (positionals.length === 0) {
    printText(`Usage: better pkg-size-history <package> [--versions <n>] [--json]`);
    process.exitCode = 1;
    return;
  }

  const pkgName = positionals[0];
  const maxVersions = Math.max(1, parseInt(values.versions) || 15);

  if (!values.json) {
    process.stderr.write(`\x1b[90mFetching version history for ${pkgName}…\x1b[0m\n`);
  }

  const encoded = encodeURIComponent(pkgName).replace(/%40/g, "@");
  const meta = await fetchJson(`https://registry.npmjs.org/${encoded}`);

  if (!meta || !meta.versions) {
    const msg = `Package "${pkgName}" not found`;
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`\x1b[31mError: ${msg}\x1b[0m`); }
    process.exitCode = 1;
    return;
  }

  const timeMap = meta.time || {};
  const allVersions = Object.keys(meta.versions)
    .filter(v => !v.includes("-")) // skip pre-releases
    .sort((a, b) => {
      const ta = new Date(timeMap[a] || 0).getTime();
      const tb = new Date(timeMap[b] || 0).getTime();
      return ta - tb;
    });

  const recent = allVersions.slice(-maxVersions);

  const BATCH = 5;
  const entries = [];

  for (let i = 0; i < recent.length; i += BATCH) {
    const batch = recent.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(async (version) => {
      const vData = meta.versions[version];
      const size = vData?.dist?.unpackedSize || null;
      const publishedAt = timeMap[version] || null;
      return { version, size, publishedAt };
    }));
    entries.push(...results);
  }

  if (values.json) {
    printJson({
      ok: true,
      kind: "better.pkg-size-history",
      name: pkgName,
      versionsShown: entries.length,
      entries,
    });
    return;
  }

  printText(`\n\x1b[1mbetter pkg-size-history\x1b[0m — ${pkgName} (last ${entries.length} stable versions)\n`);

  const maxSize = Math.max(...entries.map(e => e.size || 0));

  // Header
  printText(`  ${"Version".padEnd(16)} ${"Size".padEnd(12)} ${"Chart".padEnd(22)} Change`);
  printText(`  ${"─".repeat(16)} ${"─".repeat(12)} ${"─".repeat(22)} ${"─".repeat(10)}`);

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const prev = i > 0 ? entries[i - 1].size : null;
    const pct = pctChange(prev, e.size);
    const isLatest = e.version === meta["dist-tags"]?.latest;
    const label = isLatest ? `\x1b[32m${e.version}\x1b[0m` : e.version;

    const sizeStr = fmtBytes(e.size);
    const barStr = e.size ? `\x1b[36m${bar(e.size, maxSize)}\x1b[0m` : "—";
    const changeStr = i === 0 ? "\x1b[90m(first)\x1b[0m" : fmtPct(pct);

    printText(`  ${label.padEnd(isLatest ? 23 : 16)} ${sizeStr.padEnd(12)} ${barStr} ${changeStr}`);
  }

  const first = entries.find(e => e.size);
  const last = entries.slice().reverse().find(e => e.size);
  if (first && last && first !== last) {
    const totalPct = pctChange(first.size, last.size);
    printText(`\n  \x1b[90mTotal change from ${first.version} → ${last.version}:${fmtPct(totalPct)}\x1b[0m`);
    printText(`  \x1b[90m${fmtBytes(first.size)} → ${fmtBytes(last.size)}\x1b[0m`);
  }

  printText("");
}
