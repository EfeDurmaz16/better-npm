/**
 * better compare <pkgA> <pkgB> — compare two npm packages
 *
 * Shows a side-by-side comparison of two packages including
 * downloads, size, license, dependencies, and metadata.
 *
 * Usage:
 *   better compare lodash ramda
 *   better compare axios got --json
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

function fmtNum(n) {
  if (n === null || n === undefined) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

function fmtBytes(n) {
  if (!n) return "—";
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

function timeSince(iso) {
  if (!iso) return "—";
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days < 1) return "today";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

async function fetchPackageData(name) {
  const encoded = encodeURIComponent(name).replace(/%40/g, "@");
  const [meta, downloads] = await Promise.all([
    fetchJson(`https://registry.npmjs.org/${encoded}/latest`),
    fetchJson(`https://api.npmjs.org/downloads/point/last-week/${encoded}`),
  ]);

  if (!meta) return null;

  return {
    name,
    version: meta.version,
    description: meta.description || "",
    license: meta.license || "—",
    author: typeof meta.author === "object" ? meta.author?.name : (meta.author || "—"),
    homepage: meta.homepage || meta.repository?.url?.replace(/^git\+/, "").replace(/\.git$/, "") || "—",
    keywords: (meta.keywords || []).slice(0, 6),
    publishedAt: meta.time?.modified || null,
    dependencies: Object.keys(meta.dependencies || {}).length,
    devDependencies: Object.keys(meta.devDependencies || {}).length,
    peerDependencies: Object.keys(meta.peerDependencies || {}).length,
    unpackedSize: meta.dist?.unpackedSize || null,
    weeklyDownloads: downloads?.downloads || null,
    deprecated: meta.deprecated || null,
    engines: meta.engines?.node || null,
    typescript: !!(meta.types || meta.typings),
  };
}

function pad(str, len) {
  const s = String(str ?? "—");
  return s.length <= len ? s + " ".repeat(len - s.length) : s.slice(0, len - 3) + "...";
}

export async function cmdCompare(argv) {
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

  if (values.help || positionals.length < 2) {
    printText(`Usage: better compare <packageA> <packageB> [options]

Compare two npm packages side-by-side.

Options:
  --json       Machine-readable output
  -h, --help   Show this help

Examples:
  better compare lodash ramda
  better compare axios got fetch
`);
    if (positionals.length < 2) process.exitCode = 1;
    return;
  }

  const pkgs = positionals.slice(0, 4); // max 4 packages

  if (!values.json) {
    process.stderr.write(`\x1b[90mFetching data for ${pkgs.join(", ")}…\x1b[0m\n`);
  }

  const results = await Promise.all(pkgs.map(fetchPackageData));

  if (values.json) {
    printJson({
      ok: true,
      kind: "better.compare",
      packages: results,
    });
    return;
  }

  const valid = results.filter(Boolean);
  if (valid.length < 2) {
    printText(`\x1b[31mCould not fetch data for one or more packages.\x1b[0m`);
    process.exitCode = 1;
    return;
  }

  printText(`\n\x1b[1mbetter compare\x1b[0m\n`);

  // Build comparison rows
  const COL = 24;
  const LABEL_W = 22;

  // Header
  let header = " ".repeat(LABEL_W);
  for (const r of valid) header += `  \x1b[1m${pad(r.name, COL)}\x1b[0m`;
  printText(header);

  const sep = " ".repeat(LABEL_W) + "  " + valid.map(() => "─".repeat(COL)).join("  ");
  printText(sep);

  function row(label, ...vals) {
    let line = `  \x1b[90m${pad(label, LABEL_W - 2)}\x1b[0m`;
    for (const v of vals) line += `  ${pad(v, COL)}`;
    printText(line);
  }

  const vers = valid.map(r => r.version);
  row("Version", ...vers);

  const descs = valid.map(r => r.description.slice(0, COL));
  row("Description", ...descs);

  const licenses = valid.map(r => r.license);
  row("License", ...licenses);

  // Weekly downloads — highlight max
  const dlNums = valid.map(r => r.weeklyDownloads);
  const maxDl = Math.max(...dlNums.filter(Boolean));
  const dlStrs = valid.map(r => {
    const s = fmtNum(r.weeklyDownloads);
    return r.weeklyDownloads === maxDl ? `\x1b[32m${s}\x1b[0m` : s;
  });
  row("Weekly downloads", ...dlStrs);

  // Size — highlight min
  const sizes = valid.map(r => r.unpackedSize);
  const minSize = Math.min(...sizes.filter(Boolean));
  const sizeStrs = valid.map(r => {
    const s = fmtBytes(r.unpackedSize);
    return r.unpackedSize === minSize ? `\x1b[32m${s}\x1b[0m` : s;
  });
  row("Unpacked size", ...sizeStrs);

  // Dependencies — highlight min
  const depCounts = valid.map(r => r.dependencies);
  const minDeps = Math.min(...depCounts);
  const depStrs = valid.map(r => {
    const s = String(r.dependencies);
    return r.dependencies === minDeps ? `\x1b[32m${s}\x1b[0m` : s;
  });
  row("Dependencies", ...depStrs);

  row("Peer deps", ...valid.map(r => String(r.peerDependencies)));

  const tsStrs = valid.map(r => r.typescript ? "\x1b[32myes\x1b[0m" : "\x1b[90mno\x1b[0m");
  row("TypeScript types", ...tsStrs);

  const engStrs = valid.map(r => r.engines || "—");
  row("Node engine", ...engStrs);

  const updatedStrs = valid.map(r => timeSince(r.publishedAt));
  row("Last updated", ...updatedStrs);

  for (const r of valid) {
    if (r.deprecated) {
      printText(`\n  \x1b[31m⚠ ${r.name} is deprecated:\x1b[0m ${r.deprecated}`);
    }
  }

  printText("");
}
