/**
 * better registry-status — check npm registry connectivity
 *
 * Pings the npm registry and configured registries, measures latency,
 * checks if specific packages are accessible, and shows npm status.
 *
 * Usage:
 *   better registry-status
 *   better registry-status --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import https from "node:https";
import http from "node:http";

function pingUrl(url, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, {
      headers: { "User-Agent": "better-npm/0.1", "Accept": "application/json" },
      timeout: timeoutMs,
    }, (res) => {
      let body = "";
      res.on("data", c => { body += c; });
      res.on("end", () => {
        const ms = Date.now() - start;
        resolve({
          url,
          ok: res.statusCode >= 200 && res.statusCode < 400,
          status: res.statusCode,
          latencyMs: ms,
          body: body.slice(0, 200),
        });
      });
    });
    req.on("error", (err) => {
      resolve({ url, ok: false, status: null, latencyMs: Date.now() - start, error: err.message });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve({ url, ok: false, status: null, latencyMs: timeoutMs, error: "timeout" });
    });
  });
}

function latencyBand(ms) {
  if (ms < 100) return "\x1b[32m";   // green — fast
  if (ms < 500) return "\x1b[33m";   // yellow — ok
  return "\x1b[31m";                  // red — slow
}

export async function cmdRegistryStatus(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:     { type: "boolean", default: runtime.json === true },
      help:     { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better registry-status [options]

Check npm registry connectivity and latency.

Options:
  --json       Machine-readable output
  -h, --help   Show this help
`);
    return;
  }

  const endpoints = [
    { name: "npm registry",          url: "https://registry.npmjs.org/" },
    { name: "npm API",               url: "https://api.npmjs.org/" },
    { name: "npm status page",       url: "https://status.npmjs.org/api/v2/status.json" },
  ];

  // Also ping a known package to test package resolution
  const testPkg = { name: "is-online (test)", url: "https://registry.npmjs.org/is-online/latest" };

  if (!values.json) {
    process.stderr.write(`\x1b[90mPinging ${endpoints.length + 1} endpoints…\x1b[0m\n`);
  }

  const [results, testResult] = await Promise.all([
    Promise.all(endpoints.map(e => pingUrl(e.url))),
    pingUrl(testPkg.url),
  ]);

  // Parse npm status page
  let npmStatus = "unknown";
  const statusResult = results.find(r => r.url.includes("status.npmjs.org"));
  if (statusResult?.ok && statusResult.body) {
    try {
      const statusData = JSON.parse(statusResult.body);
      npmStatus = statusData?.status?.description || "unknown";
    } catch {}
  }

  const allResults = [
    ...endpoints.map((e, i) => ({ ...e, ...results[i] })),
    { ...testPkg, ...testResult },
  ];

  const allOk = allResults.every(r => r.ok);
  const avgLatency = Math.round(
    allResults.filter(r => r.ok).reduce((s, r) => s + r.latencyMs, 0) /
    (allResults.filter(r => r.ok).length || 1)
  );

  if (values.json) {
    printJson({
      ok: allOk,
      kind: "better.registry-status",
      npmStatus,
      avgLatencyMs: avgLatency,
      endpoints: allResults.map(r => ({
        name: r.name,
        url: r.url,
        ok: r.ok,
        statusCode: r.status,
        latencyMs: r.latencyMs,
        error: r.error || null,
      })),
    });
    if (!allOk) process.exitCode = 1;
    return;
  }

  printText(`\n\x1b[1mbetter registry-status\x1b[0m\n`);

  if (npmStatus && npmStatus !== "unknown") {
    const statusColor = npmStatus.toLowerCase().includes("operational") ? "\x1b[32m" : "\x1b[33m";
    printText(`  npm status: ${statusColor}${npmStatus}\x1b[0m\n`);
  }

  for (const r of allResults) {
    if (r.url.includes("status.npmjs.org")) continue; // skip internal ping
    const icon = r.ok ? "\x1b[32m✔\x1b[0m" : "\x1b[31m✖\x1b[0m";
    const latColor = r.ok ? latencyBand(r.latencyMs) : "\x1b[31m";
    const latStr = r.ok ? `${latColor}${r.latencyMs}ms\x1b[0m` : `\x1b[31m${r.error || "failed"}\x1b[0m`;
    printText(`  ${icon}  ${r.name.padEnd(30)} ${latStr}`);
  }

  printText("");
  if (allOk) {
    printText(`\x1b[32m✔ Registry is reachable.\x1b[0m Average latency: ${avgLatency}ms`);
  } else {
    const failed = allResults.filter(r => !r.ok);
    printText(`\x1b[31m✖ ${failed.length} endpoint(s) unreachable.\x1b[0m Check your network connection.`);
    process.exitCode = 1;
  }
}
