/**
 * better search — search npm (and other registries) for packages
 *
 * Usage:
 *   better search <query> [--json] [--limit N] [--registry URL]
 */
import { parseArgs } from "node:util";
import https from "node:https";
import http from "node:http";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import { findBetterCore } from "../lib/core.js";
import { runCommand } from "../lib/spawn.js";

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https:") ? https : http;
    const req = mod.get(url, { timeout: 10000 }, (res) => {
      let body = "";
      res.on("data", chunk => { body += chunk; });
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(body);
        } else {
          reject(new Error(`HTTP ${res.statusCode} from ${url}`));
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Request timed out")); });
  });
}

async function searchNpm(query, { limit = 20, registry = "https://registry.npmjs.org" } = {}) {
  const encoded = encodeURIComponent(query);
  const url = `${registry}/-/v1/search?text=${encoded}&size=${limit}`;
  const body = await httpsGet(url);
  const data = JSON.parse(body);
  return (data.objects ?? []).map(obj => ({
    name: obj.package?.name ?? "",
    version: obj.package?.version ?? "",
    description: obj.package?.description ?? "",
    keywords: obj.package?.keywords ?? [],
    author: obj.package?.author?.name ?? null,
    date: obj.package?.date ?? null,
    links: {
      npm: obj.package?.links?.npm ?? null,
      homepage: obj.package?.links?.homepage ?? null,
      repository: obj.package?.links?.repository ?? null
    },
    score: {
      final: obj.score?.final ?? 0,
      quality: obj.score?.detail?.quality ?? 0,
      popularity: obj.score?.detail?.popularity ?? 0,
      maintenance: obj.score?.detail?.maintenance ?? 0
    },
    searchScore: obj.searchScore ?? 0
  }));
}

export async function cmdSearch(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    printText(`Usage:
  better search <query> [--json] [--limit N] [--registry URL]

Search for packages in the npm registry.

Options:
  --limit N       Number of results (default: 20, max: 250)
  --registry URL  Registry URL (default: https://registry.npmjs.org)
  --json          Structured JSON output
`);
    return;
  }

  const runtime = getRuntimeConfig();
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: runtime.json === true },
      limit: { type: "string", default: "20" },
      registry: { type: "string", default: "https://registry.npmjs.org" }
    },
    allowPositionals: true,
    strict: false
  });

  const query = positionals.join(" ").trim();
  if (!query) {
    printText("Error: provide a search query.\n\nUsage: better search <query>");
    process.exitCode = 1;
    return;
  }

  const limit = Math.min(250, Math.max(1, Number.parseInt(values.limit, 10) || 20));

  // Try better-core first (may have AI-ranked results or multi-registry support)
  const corePath = await findBetterCore();
  if (corePath) {
    const args = ["search", query, "--limit", String(limit)];
    if (values.json) args.push("--json");
    if (values.registry !== "https://registry.npmjs.org") args.push("--registry", values.registry);
    const res = await runCommand(corePath, args, { passthroughStdio: true });
    if (res.exitCode === 0) { process.exitCode = 0; return; }
  }

  // JS-native fallback via npm registry search API
  try {
    const results = await searchNpm(query, { limit, registry: values.registry });

    const out = {
      ok: true,
      kind: "better.search",
      schemaVersion: 1,
      query,
      total: results.length,
      registry: values.registry,
      results
    };

    if (values.json) {
      printJson(out);
      return;
    }

    if (results.length === 0) {
      printText(`No packages found for "${query}"`);
      return;
    }

    const lines = [`Search results for "${query}" (${results.length} found)\n`];
    for (const r of results) {
      lines.push(`${r.name}@${r.version}`);
      if (r.description) lines.push(`  ${r.description}`);
      lines.push(`  score: ${(r.score.final * 100).toFixed(0)}  |  quality: ${(r.score.quality * 100).toFixed(0)}  popularity: ${(r.score.popularity * 100).toFixed(0)}`);
      if (r.links.npm) lines.push(`  npm: ${r.links.npm}`);
      lines.push("");
    }
    printText(lines.join("\n"));
  } catch (err) {
    const out = { ok: false, kind: "better.search", error: err.message };
    if (values.json) printJson(out);
    else printText(`Error: ${err.message}`);
    process.exitCode = 1;
  }
}
