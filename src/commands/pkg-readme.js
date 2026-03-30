/**
 * better pkg-readme — view a package's README from npm registry
 *
 * Fetches and displays the README for an npm package directly in
 * the terminal without leaving your workflow.
 *
 * Usage:
 *   better pkg-readme lodash
 *   better pkg-readme express --raw
 *   better pkg-readme chalk --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import https from "node:https";

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "better-npm/1.0" }, timeout: 12000 }, (res) => {
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

// Minimal Markdown → terminal rendering
function renderMarkdown(md, maxWidth = 100) {
  const lines = md.split("\n");
  const out = [];
  let inCode = false;
  let codeLines = [];
  let codeLang = "";

  for (const raw of lines) {
    if (raw.startsWith("```")) {
      if (inCode) {
        // End code block — print with dim style
        out.push(`\x1b[90m${codeLines.slice(0, 10).join("\n")}\x1b[0m`);
        if (codeLines.length > 10) out.push(`\x1b[90m... (${codeLines.length - 10} more lines)\x1b[0m`);
        codeLines = [];
        inCode = false;
      } else {
        inCode = true;
        codeLang = raw.slice(3).trim();
      }
      continue;
    }
    if (inCode) { codeLines.push(raw); continue; }

    // Headings
    const h3 = raw.match(/^###\s+(.+)/);
    const h2 = raw.match(/^##\s+(.+)/);
    const h1 = raw.match(/^#\s+(.+)/);
    if (h1) { out.push(`\n\x1b[1m\x1b[4m${h1[1]}\x1b[0m`); continue; }
    if (h2) { out.push(`\n\x1b[1m${h2[1]}\x1b[0m`); continue; }
    if (h3) { out.push(`\x1b[1m${h3[1]}\x1b[0m`); continue; }

    // Horizontal rule
    if (/^[-*_]{3,}$/.test(raw.trim())) { out.push(`\x1b[90m${"─".repeat(40)}\x1b[0m`); continue; }

    // Inline formatting (simplified)
    let line = raw
      .replace(/`([^`]+)`/g, "\x1b[36m$1\x1b[0m")
      .replace(/\*\*([^*]+)\*\*/g, "\x1b[1m$1\x1b[0m")
      .replace(/\*([^*]+)\*/g, "\x1b[3m$1\x1b[0m")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "\x1b[4m$1\x1b[0m")
      .replace(/!\[[^\]]*\]\([^)]+\)/g, "");  // strip images

    // Truncate very long lines
    if (line.length > maxWidth + 50) line = line.slice(0, maxWidth + 50) + "…";

    out.push(line);
  }
  return out.join("\n");
}

export async function cmdPkgReadme(argv) {
  const runtime = getRuntimeConfig();
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json:  { type: "boolean", default: runtime.json === true },
      help:  { type: "boolean", short: "h", default: false },
      raw:   { type: "boolean", default: false },
      lines: { type: "string", default: "200" },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better pkg-readme <package> [options]

View a package's README from the npm registry.

Options:
  --raw          Show raw Markdown (no rendering)
  --lines <n>    Max lines to show (default: 200)
  --json         Machine-readable output (includes raw readme)
  -h, --help     Show this help

Examples:
  better pkg-readme lodash
  better pkg-readme express --lines 100
  better pkg-readme chalk --raw
`);
    return;
  }

  if (positionals.length === 0) {
    printText("Usage: better pkg-readme <package>\nRun: better pkg-readme --help for more info.");
    process.exitCode = 1;
    return;
  }

  const pkgName = positionals[0];
  const maxLines = Math.max(10, Math.min(2000, parseInt(values.lines) || 200));

  if (!values.json) {
    process.stderr.write(`\x1b[90mFetching README for ${pkgName}…\x1b[0m\n`);
  }

  let meta;
  try {
    const res = await httpsGet(`https://registry.npmjs.org/${encodeURIComponent(pkgName)}/latest`);
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    meta = JSON.parse(res.body);
  } catch (err) {
    const msg = `Failed to fetch ${pkgName}: ${err.message}`;
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`\x1b[31mError: ${msg}\x1b[0m`); }
    process.exitCode = 1;
    return;
  }

  const readme = meta.readme || "";
  const version = meta.version;
  const description = meta.description || "";

  if (!readme || readme === "ERROR: No README data found!") {
    const msg = `No README found for ${pkgName}`;
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`\x1b[33m⚠ ${msg}\x1b[0m`); }
    return;
  }

  if (values.json) {
    printJson({
      ok: true,
      kind: "better.pkg-readme",
      package: pkgName,
      version,
      description,
      readmeLength: readme.length,
      readme,
    });
    return;
  }

  printText(`\n\x1b[1mbetter pkg-readme\x1b[0m — \x1b[1m${pkgName}@${version}\x1b[0m`);
  if (description) printText(`\x1b[90m${description}\x1b[0m`);
  printText(`\x1b[90m${"─".repeat(60)}\x1b[0m\n`);

  let content;
  if (values.raw) {
    content = readme;
  } else {
    content = renderMarkdown(readme);
  }

  const contentLines = content.split("\n");
  const shown = contentLines.slice(0, maxLines);
  printText(shown.join("\n"));

  if (contentLines.length > maxLines) {
    printText(`\n\x1b[90m… ${contentLines.length - maxLines} more lines. Use --lines ${contentLines.length} to see all.\x1b[0m`);
  }
  printText("");
}
