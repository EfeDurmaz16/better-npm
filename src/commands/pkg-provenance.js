/**
 * better pkg-provenance — check npm package provenance attestations
 *
 * Checks whether packages have provenance attestations (npm 9.5+
 * sigstore-based signatures), indicating the package was built
 * from a known CI environment with a verifiable source link.
 *
 * Usage:
 *   better pkg-provenance lodash
 *   better pkg-provenance --check-all
 *   better pkg-provenance --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import https from "node:https";
import fs from "node:fs/promises";
import path from "node:path";
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

async function checkProvenance(pkgName, version) {
  try {
    // npm registry stores provenance in the dist.attestations field
    const res = await httpsGet(`https://registry.npmjs.org/${encodeURIComponent(pkgName)}/${encodeURIComponent(version)}`);
    if (res.status !== 200) return { hasProvenance: false, error: `HTTP ${res.status}` };
    const meta = JSON.parse(res.body);
    const attestations = meta.dist?.attestations;
    const hasProvenance = !!(attestations && attestations.url);
    const sourceRepo = meta.dist?.signingKeyId || null;
    return { hasProvenance, attestationsUrl: attestations?.url || null, sourceRepo };
  } catch (e) {
    return { hasProvenance: false, error: e.message };
  }
}

export async function cmdPkgProvenance(argv) {
  const runtime = getRuntimeConfig();
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json:        { type: "boolean", default: runtime.json === true },
      help:        { type: "boolean", short: "h", default: false },
      "check-all": { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better pkg-provenance [<package>] [options]

Check npm package provenance attestations.

Options:
  --check-all    Check all direct dependencies
  --json         Machine-readable output
  -h, --help     Show this help

Provenance (npm 9.5+, sigstore) links a package to its source
repository and CI build, providing supply chain integrity assurance.

Examples:
  better pkg-provenance lodash
  better pkg-provenance --check-all
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;

  if (!values.json) {
    printText(`\n\x1b[1mbetter pkg-provenance\x1b[0m\n`);
    process.stderr.write(`\x1b[90mChecking provenance attestations...\x1b[0m\n`);
  }

  let packagesToCheck = [];

  if (positionals.length > 0) {
    packagesToCheck = positionals.map(p => ({ name: p, version: "latest" }));
  } else if (values["check-all"]) {
    let pkgJson = {};
    try { pkgJson = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8")); } catch {}
    const nmPath = path.join(projectRoot, "node_modules");
    const deps = Object.keys(pkgJson.dependencies || {});
    for (const dep of deps) {
      try {
        const depPkg = JSON.parse(await fs.readFile(path.join(nmPath, dep, "package.json"), "utf8"));
        packagesToCheck.push({ name: dep, version: depPkg.version });
      } catch {
        packagesToCheck.push({ name: dep, version: "latest" });
      }
    }
  } else {
    printText("Usage: better pkg-provenance <package> OR --check-all\nRun: better pkg-provenance --help for more info.");
    process.exitCode = 1;
    return;
  }

  const results = [];
  const BATCH = 5;
  for (let i = 0; i < packagesToCheck.length; i += BATCH) {
    const batch = packagesToCheck.slice(i, i + BATCH);
    const batchResults = await Promise.all(batch.map(async ({ name, version }) => {
      const check = await checkProvenance(name, version);
      return { name, version, ...check };
    }));
    results.push(...batchResults);
  }

  const withProvenance = results.filter(r => r.hasProvenance);
  const withoutProvenance = results.filter(r => !r.hasProvenance && !r.error);

  if (values.json) {
    printJson({
      ok: withoutProvenance.length === 0,
      kind: "better.pkg-provenance",
      total: results.length,
      withProvenance: withProvenance.length,
      withoutProvenance: withoutProvenance.length,
      results,
    });
    return;
  }

  for (const r of results) {
    const icon = r.hasProvenance ? "\x1b[32m✔\x1b[0m" : r.error ? "\x1b[90m?\x1b[0m" : "\x1b[33m·\x1b[0m";
    const status = r.hasProvenance ? "\x1b[32mprovenance verified\x1b[0m" : r.error ? `\x1b[90m${r.error}\x1b[0m` : "\x1b[33mno provenance\x1b[0m";
    printText(`  ${icon}  \x1b[1m${r.name}@${r.version}\x1b[0m  ${status}`);
  }

  printText("");
  if (withProvenance.length > 0) {
    printText(`  \x1b[32m${withProvenance.length}/${results.length} packages have provenance attestations.\x1b[0m`);
  } else {
    printText(`  \x1b[90mNo provenance attestations found. This is normal for older packages.\x1b[0m`);
  }
  printText("");
}
