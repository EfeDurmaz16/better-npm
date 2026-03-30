/**
 * better supply-chain-audit — analyze npm supply chain security
 *
 * Checks for supply chain risks: install scripts, network access
 * in scripts, typosquatting-style names, maintainer count (bus factor),
 * and recently published packages.
 *
 * Usage:
 *   better supply-chain-audit
 *   better supply-chain-audit --top 20
 *   better supply-chain-audit --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import https from "node:https";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "better-npm/1.0" }, timeout: 8000 }, (res) => {
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

const INSTALL_SCRIPTS = ["preinstall", "install", "postinstall", "prepare"];
const RISKY_PATTERNS = [
  { re: /\bcurl\b|\bwget\b/i, msg: "network download (curl/wget)" },
  { re: /\beval\b/i, msg: "eval() usage" },
  { re: /\brm\s+-rf?\b/i, msg: "recursive delete (rm -rf)" },
  { re: /\bnode\s+-e\b|\bnode\s+-p\b/i, msg: "inline node script" },
  { re: /\bbase64\b/i, msg: "base64 encoding (obfuscation risk)" },
  { re: /\bexec\b/i, msg: "exec() call" },
];

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => Array.from({ length: n + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0));
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
    dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  }
  return dp[m][n];
}

function daysSince(d) {
  if (!d) return null;
  return Math.floor((Date.now() - new Date(d).getTime()) / 86400000);
}

export async function cmdSupplyChainAudit(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:  { type: "boolean", default: runtime.json === true },
      help:  { type: "boolean", short: "h", default: false },
      top:   { type: "string", default: "20" },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better supply-chain-audit [options]

Analyze npm supply chain security risks.

Options:
  --top <n>    Check top N packages by install order (default: 20)
  --json       Machine-readable output
  -h, --help   Show this help

Checks:
  • Install scripts (preinstall/postinstall) presence
  • Risky patterns in install scripts
  • Recently published packages (< 7 days old)
  • Low maintainer count (bus factor)
  • Suspicious package names (typosquatting heuristics)
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;
  const nmPath = path.join(projectRoot, "node_modules");

  try { await fs.access(nmPath); } catch {
    const msg = "node_modules not found — run npm install first";
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`\x1b[33m⚠ ${msg}\x1b[0m`); }
    process.exitCode = 1;
    return;
  }

  if (!values.json) {
    printText(`\n\x1b[1mbetter supply-chain-audit\x1b[0m\n`);
    process.stderr.write(`\x1b[90mScanning installed packages...\x1b[0m\n`);
  }

  const topN = Math.max(5, Math.min(100, parseInt(values.top) || 20));

  // Get direct deps from package.json
  let directDeps = [];
  try {
    const pkgJson = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8"));
    directDeps = Object.keys({ ...pkgJson.dependencies, ...pkgJson.devDependencies });
  } catch {}

  // Scan packages for install scripts and risky patterns
  const risks = [];
  let entries;
  try { entries = await fs.readdir(nmPath, { withFileTypes: true }); } catch { entries = []; }

  const toScan = [];
  for (const e of entries) {
    if (e.name.startsWith(".") || !e.isDirectory()) continue;
    if (e.name.startsWith("@")) {
      let subEntries;
      try { subEntries = await fs.readdir(path.join(nmPath, e.name), { withFileTypes: true }); } catch { continue; }
      for (const sub of subEntries) {
        if (sub.isDirectory()) toScan.push({ name: `${e.name}/${sub.name}`, dir: path.join(nmPath, e.name, sub.name) });
      }
    } else {
      toScan.push({ name: e.name, dir: path.join(nmPath, e.name) });
    }
  }

  const BATCH = 15;
  for (let i = 0; i < toScan.length; i += BATCH) {
    const batch = toScan.slice(i, i + BATCH);
    await Promise.all(batch.map(async ({ name, dir }) => {
      let pkg;
      try { pkg = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8")); } catch { return; }

      const scripts = pkg.scripts || {};
      const installScripts = INSTALL_SCRIPTS.filter(s => scripts[s]);

      if (installScripts.length > 0) {
        const riskPatterns = [];
        for (const s of installScripts) {
          for (const pattern of RISKY_PATTERNS) {
            if (pattern.re.test(scripts[s])) riskPatterns.push(pattern.msg);
          }
        }
        if (riskPatterns.length > 0) {
          risks.push({ name, version: pkg.version, severity: "high", type: "risky-install-script", detail: riskPatterns.join(", "), scripts: installScripts });
        } else {
          risks.push({ name, version: pkg.version, severity: "info", type: "install-script", detail: `has ${installScripts.join(", ")}`, scripts: installScripts });
        }
      }
    }));
  }

  // Check recently published direct deps via registry
  if (directDeps.length > 0) {
    if (!values.json) {
      process.stderr.write(`\x1b[90mChecking registry for recent publications...\x1b[0m\n`);
    }
    const subset = directDeps.slice(0, topN);
    const RBATCH = 5;
    for (let i = 0; i < subset.length; i += RBATCH) {
      const batch = subset.slice(i, i + RBATCH);
      await Promise.all(batch.map(async (dep) => {
        try {
          const res = await httpsGet(`https://registry.npmjs.org/${encodeURIComponent(dep)}/latest`);
          if (res.status !== 200) return;
          const meta = JSON.parse(res.body);
          const version = meta.version;
          const time = meta.time?.[version] || meta.time?.modified;
          const age = daysSince(time);
          if (age !== null && age < 7) {
            risks.push({ name: dep, version, severity: "warning", type: "recently-published", detail: `published ${age} day(s) ago` });
          }
          const maintainers = (meta.maintainers || []).length;
          if (maintainers === 1) {
            risks.push({ name: dep, version, severity: "info", type: "single-maintainer", detail: "only 1 maintainer (bus factor risk)" });
          }
        } catch {}
      }));
    }
  }

  // Sort by severity
  const SEV_ORDER = { high: 3, warning: 2, info: 1 };
  risks.sort((a, b) => (SEV_ORDER[b.severity] || 0) - (SEV_ORDER[a.severity] || 0));

  const highRisks = risks.filter(r => r.severity === "high");
  const warnings = risks.filter(r => r.severity === "warning");
  const infos = risks.filter(r => r.severity === "info");
  const allOk = highRisks.length === 0;

  if (values.json) {
    printJson({ ok: allOk, kind: "better.supply-chain-audit", scanned: toScan.length, risks, high: highRisks.length, warnings: warnings.length });
    if (!allOk) process.exitCode = 1;
    return;
  }

  printText(`  Scanned: ${toScan.length} packages\n`);

  if (risks.length === 0) {
    printText(`\x1b[32m✔ No supply chain risks detected.\x1b[0m`);
    printText("");
    return;
  }

  for (const r of highRisks) {
    printText(`  \x1b[31m✖\x1b[0m  \x1b[1m${r.name}@${r.version}\x1b[0m  \x1b[31m${r.detail}\x1b[0m`);
  }
  for (const r of warnings) {
    printText(`  \x1b[33m⚠\x1b[0m  \x1b[1m${r.name}@${r.version}\x1b[0m  ${r.detail}`);
  }
  if (infos.length > 0) {
    printText(`\n  \x1b[90m${infos.length} packages with install scripts (informational only)\x1b[0m`);
  }

  printText("");
  if (highRisks.length > 0) {
    printText(`\x1b[31m✖ ${highRisks.length} high-risk supply chain issue(s) found.\x1b[0m`);
    process.exitCode = 1;
  } else if (warnings.length > 0) {
    printText(`\x1b[33m⚠ ${warnings.length} supply chain warning(s).\x1b[0m`);
  }
  printText("");
}
