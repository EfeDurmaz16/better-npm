/**
 * better explain — explain what a package does
 *
 * Fetches package metadata and README summary to give a quick
 * human-readable explanation of what a package does.
 *
 * Usage:
 *   better explain lodash
 *   better explain express react
 *   better explain --json lodash
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import https from "node:https";

function fetchNpmData(name) {
  return new Promise((resolve) => {
    const encoded = encodeURIComponent(name).replace(/%40/g, "@");
    https.get(`https://registry.npmjs.org/${encoded}/latest`, {
      headers: { "Accept": "application/json", "User-Agent": "better-npm/0.1" },
      timeout: 6000,
    }, (res) => {
      let body = "";
      res.on("data", c => { body += c; });
      res.on("end", () => {
        try { resolve(JSON.parse(body)); } catch { resolve(null); }
      });
    }).on("error", () => resolve(null)).on("timeout", () => resolve(null));
  });
}

function trimText(text, maxLen) {
  if (!text) return "";
  const clean = text.replace(/\n+/g, " ").replace(/\s+/g, " ").trim();
  if (clean.length <= maxLen) return clean;
  return clean.slice(0, maxLen - 3) + "...";
}

function extractReadmeSummary(readme) {
  if (!readme) return null;
  // Try to get first paragraph after the title
  const lines = readme.split("\n");
  let inContent = false;
  const paragraphLines = [];

  for (const line of lines) {
    const trimmed = line.trim();
    // Skip badges, images, and headings
    if (trimmed.startsWith("#") && paragraphLines.length === 0) {
      inContent = true;
      continue;
    }
    if (trimmed.startsWith("[![") || trimmed.startsWith("![") || trimmed.startsWith("<img")) continue;
    if (trimmed === "" && paragraphLines.length > 0) break;
    if (inContent && trimmed && !trimmed.startsWith("#") && !trimmed.startsWith("```")) {
      paragraphLines.push(trimmed);
    }
    if (!inContent && trimmed && !trimmed.startsWith("#")) {
      inContent = true;
      if (!trimmed.startsWith("[![") && !trimmed.startsWith("![")) {
        paragraphLines.push(trimmed);
      }
    }
  }

  const para = paragraphLines.join(" ").replace(/[#*`]/g, "").trim();
  return para.length > 30 ? trimText(para, 300) : null;
}

export async function cmdExplain(argv) {
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

  if (values.help || positionals.length === 0) {
    printText(`Usage: better explain <package> [packages...] [options]

Get a quick explanation of what npm packages do.

Options:
  --json       Machine-readable output
  -h, --help   Show this help

Examples:
  better explain lodash
  better explain express react axios
`);
    if (positionals.length === 0) process.exitCode = 1;
    return;
  }

  const pkgs = positionals;

  if (!values.json) {
    process.stderr.write(`\x1b[90mFetching info for ${pkgs.length} package(s)…\x1b[0m\n`);
  }

  const results = await Promise.all(pkgs.map(async (name) => {
    const data = await fetchNpmData(name);
    if (!data) return { name, error: "not found" };

    const readmeSummary = extractReadmeSummary(data.readme);

    return {
      name,
      version: data.version,
      description: data.description || "",
      readmeSummary,
      license: data.license,
      author: typeof data.author === "object" ? data.author?.name : data.author,
      keywords: (data.keywords || []).slice(0, 8),
      homepage: data.homepage,
      repo: data.repository?.url?.replace(/^git\+/, "").replace(/\.git$/, ""),
      weeklyDownloads: null, // would need separate API call
    };
  }));

  if (values.json) {
    printJson({
      ok: true,
      kind: "better.explain",
      results,
    });
    return;
  }

  for (const r of results) {
    printText(`\n\x1b[1m${r.name}\x1b[0m${r.version ? `@${r.version}` : ""}`);

    if (r.error) {
      printText(`  \x1b[31mError: ${r.error}\x1b[0m`);
      continue;
    }

    if (r.description) {
      printText(`  \x1b[1mWhat:\x1b[0m ${r.description}`);
    }

    if (r.readmeSummary && r.readmeSummary !== r.description) {
      printText(`  \x1b[1mDetails:\x1b[0m ${r.readmeSummary}`);
    }

    if (r.keywords?.length > 0) {
      printText(`  \x1b[1mKeywords:\x1b[0m ${r.keywords.join(", ")}`);
    }

    if (r.license) printText(`  \x1b[1mLicense:\x1b[0m ${r.license}`);
    if (r.homepage) printText(`  \x1b[1mLinks:\x1b[0m ${r.homepage}`);
    else if (r.repo) printText(`  \x1b[1mLinks:\x1b[0m ${r.repo}`);
  }

  printText("");
}
