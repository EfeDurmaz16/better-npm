/**
 * better registry-health — check npm registry connectivity and latency
 *
 * Pings the configured npm registry (and optionally mirrors), measures
 * response times, and reports on registry health status.
 *
 * Usage:
 *   better registry-health
 *   better registry-health --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import https from "node:https";
import http from "node:http";
import { spawnSync } from "node:child_process";

function httpGet(url, timeout = 8000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const mod = url.startsWith("https") ? https : http;
    const req = mod.get(url, { headers: { "User-Agent": "better-npm/1.0" }, timeout }, (res) => {
      const latency = Date.now() - start;
      res.resume(); // drain response
      resolve({ ok: res.statusCode < 400, status: res.statusCode, latency, url });
    });
    req.on("error", () => resolve({ ok: false, status: null, latency: Date.now() - start, url }));
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, status: null, latency: timeout, url, timedOut: true }); });
  });
}

function bar(latency, max = 2000) {
  const pct = Math.min(latency / max, 1);
  const width = 20;
  const filled = Math.round(pct * width);
  const color = latency < 300 ? "\x1b[32m" : latency < 1000 ? "\x1b[33m" : "\x1b[31m";
  return `${color}${"█".repeat(filled)}${"░".repeat(width - filled)}\x1b[0m ${latency}ms`;
}

export async function cmdRegistryHealth(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:  { type: "boolean", default: runtime.json === true },
      help:  { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better registry-health [options]

Check npm registry connectivity and latency.

Options:
  --json       Machine-readable output
  -h, --help   Show this help

Checks:
  • Configured npm registry reachability
  • Response time and latency measurement
  • npm ping endpoint
  • Common registry mirrors
`);
    return;
  }

  if (!values.json) {
    printText(`\n\x1b[1mbetter registry-health\x1b[0m\n`);
    process.stderr.write(`\x1b[90mChecking registry health...\x1b[0m\n`);
  }

  // Get configured registry
  const npmRegistry = (() => {
    const r = spawnSync("npm", ["config", "get", "registry"], { encoding: "utf8", timeout: 5000 });
    return r.status === 0 ? r.stdout.trim() : "https://registry.npmjs.org/";
  })();

  const registriesToCheck = [
    { name: "npm (configured)", url: npmRegistry.replace(/\/$/, "") },
    { name: "npm search",       url: "https://www.npmjs.com" },
  ];

  // Add well-known mirrors if different from configured
  const mirrors = [
    { name: "npmmirror (China)", url: "https://registry.npmmirror.com" },
    { name: "Yarn",              url: "https://registry.yarnpkg.com" },
  ];
  for (const m of mirrors) {
    if (!npmRegistry.includes(new URL(m.url).hostname)) {
      registriesToCheck.push(m);
    }
  }

  // Check all registries concurrently
  const results = await Promise.all(registriesToCheck.map(async (reg) => {
    const pingUrl = reg.url + "/-/ping";
    const r = await httpGet(pingUrl, 8000);
    return { ...reg, ...r, pingUrl };
  }));

  const allOk = results.every(r => r.ok);
  const primary = results[0];

  if (values.json) {
    printJson({
      ok: primary.ok,
      kind: "better.registry-health",
      registry: npmRegistry,
      results: results.map(r => ({
        name: r.name,
        url: r.url,
        ok: r.ok,
        status: r.status,
        latency: r.latency,
        timedOut: r.timedOut || false,
      })),
    });
    if (!primary.ok) process.exitCode = 1;
    return;
  }

  printText(`  Registry: \x1b[1m${npmRegistry}\x1b[0m\n`);

  for (const r of results) {
    const icon = r.ok ? "\x1b[32m✔\x1b[0m" : "\x1b[31m✘\x1b[0m";
    const latencyBar = r.ok ? `  ${bar(r.latency)}` : (r.timedOut ? "  \x1b[31mtimeout\x1b[0m" : `  \x1b[31mHTTP ${r.status || "error"}\x1b[0m`);
    printText(`  ${icon}  ${r.name.padEnd(24)}${latencyBar}`);
  }

  printText("");
  if (!primary.ok) {
    printText(`\x1b[31m✘ Configured registry is unreachable. Check your network or proxy settings.\x1b[0m`);
    process.exitCode = 1;
  } else {
    const grade = primary.latency < 300 ? "Excellent" : primary.latency < 800 ? "Good" : primary.latency < 2000 ? "Slow" : "Very slow";
    printText(`\x1b[32m✔ Registry is reachable.\x1b[0m  Latency: ${grade} (${primary.latency}ms)`);
  }
  printText("");
}
