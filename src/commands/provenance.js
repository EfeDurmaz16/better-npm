/**
 * better provenance — check package provenance and supply chain
 *
 * Fetches provenance attestation data from the npm registry for
 * installed packages, verifying they were built from CI/CD
 * and have signed artifacts.
 *
 * Usage:
 *   better provenance
 *   better provenance lodash express
 *   better provenance --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import https from "node:https";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";
import { runVerifyProvenanceNapi } from "../lib/core.js";

function fetchProvenance(name, version) {
  return new Promise((resolve) => {
    const encoded = encodeURIComponent(name).replace(/%40/g, "@");
    const url = `https://registry.npmjs.org/${encoded}/${encodeURIComponent(version)}`;
    https.get(url, {
      headers: { "Accept": "application/json", "User-Agent": "better-npm/0.1" },
      timeout: 6000,
    }, (res) => {
      let body = "";
      res.on("data", c => { body += c; });
      res.on("end", () => {
        try {
          const data = JSON.parse(body);
          const dist = data.dist || {};
          resolve({
            name,
            version,
            integrity: dist.integrity || null,
            signatures: dist.signatures || [],
            attestations: data._attestations || null,
            publishedAt: data.time || null,
          });
        } catch { resolve({ name, version, error: "parse error" }); }
      });
    }).on("error", () => resolve({ name, version, error: "network error" }))
      .on("timeout", () => resolve({ name, version, error: "timeout" }));
  });
}

export async function cmdProvenance(argv) {
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

  if (values.help) {
    printText(`Usage: better provenance [packages...] [options]

Check npm provenance attestations for installed packages.

Options:
  --json       Machine-readable output
  -h, --help   Show this help

Examples:
  better provenance
  better provenance lodash express
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;

  // NAPI fast path: full Sigstore attestation verification
  const mode = positionals.includes("--require") ? "require" : "verify";
  const napiResult = runVerifyProvenanceNapi(projectRoot, mode);
  if (napiResult?.ok) {
    const r = napiResult;
    const result = {
      ok: true, kind: "better.provenance",
      totalChecked: r.total_checked,
      withProvenance: r.with_provenance,
      withoutProvenance: r.without_provenance,
      verificationErrors: r.verification_errors,
      attestations: r.attestations ?? [],
    };
    if (values.json) { printJson(result); }
    else {
      printText(`Provenance check: ${r.with_provenance}/${r.total_checked} packages have valid attestations`);
      if (r.without_provenance > 0) printText(`  ${r.without_provenance} package(s) without provenance`);
      if (r.verification_errors > 0) printText(`  ${r.verification_errors} verification error(s)`);
    }
    return;
  }

  let pkgJson;
  try {
    pkgJson = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8"));
  } catch {
    const msg = "Cannot read package.json";
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`Error: ${msg}`); }
    process.exitCode = 1;
    return;
  }

  const nmPath = path.join(projectRoot, "node_modules");
  const targets = positionals.length > 0
    ? positionals
    : Object.keys(pkgJson.dependencies || {});

  if (targets.length === 0) {
    if (values.json) {
      printJson({ ok: true, kind: "better.provenance", message: "No production dependencies found" });
    } else {
      printText(`\x1b[90mNo production dependencies found.\x1b[0m`);
    }
    return;
  }

  if (!values.json) {
    process.stderr.write(`\x1b[90mChecking provenance for ${targets.length} package(s)…\x1b[0m\n`);
  }

  // Get installed versions
  const BATCH = 8;
  const results = [];

  for (let i = 0; i < targets.length; i += BATCH) {
    const batch = targets.slice(i, i + BATCH);
    const batchResults = await Promise.all(batch.map(async (name) => {
      let version = null;
      try {
        const depPkg = JSON.parse(await fs.readFile(path.join(nmPath, name, "package.json"), "utf8"));
        version = depPkg.version;
      } catch {}

      if (!version) return { name, version: null, error: "not installed" };

      return fetchProvenance(name, version);
    }));
    results.push(...batchResults);
  }

  const withAttestation = results.filter(r => r.attestations || r.signatures?.length > 0);
  const withIntegrity = results.filter(r => r.integrity);
  const errors = results.filter(r => r.error);

  if (values.json) {
    printJson({
      ok: true,
      kind: "better.provenance",
      checked: results.length,
      withAttestation: withAttestation.length,
      withIntegrity: withIntegrity.length,
      errors: errors.length,
      results,
    });
    return;
  }

  printText(`\n\x1b[1mbetter provenance\x1b[0m — ${results.length} package(s)\n`);
  printText(`  With integrity hashes: \x1b[32m${withIntegrity.length}/${results.length}\x1b[0m`);
  printText(`  With provenance:       \x1b[${withAttestation.length > 0 ? "32" : "33"}m${withAttestation.length}/${results.length}\x1b[0m\n`);

  for (const r of results) {
    if (r.error) {
      printText(`  \x1b[90m?  ${r.name}  (${r.error})\x1b[0m`);
      continue;
    }

    const hasIntegrity = Boolean(r.integrity);
    const hasAttestation = Boolean(r.attestations || r.signatures?.length > 0);
    const icon = hasAttestation ? "\x1b[32m✔\x1b[0m" : hasIntegrity ? "\x1b[33m·\x1b[0m" : "\x1b[31m✖\x1b[0m";

    const provenanceStr = hasAttestation
      ? "\x1b[32m provenance\x1b[0m"
      : hasIntegrity
      ? "\x1b[90m integrity only\x1b[0m"
      : "\x1b[31m no integrity\x1b[0m";

    printText(`  ${icon}  ${r.name}@${r.version}${provenanceStr}`);
  }

  printText("");
  if (withAttestation.length === 0) {
    printText(`\x1b[90mMost packages don't yet publish provenance attestations.\x1b[0m`);
    printText(`\x1b[90mSee: https://docs.npmjs.com/generating-provenance-statements\x1b[0m`);
  }
}
