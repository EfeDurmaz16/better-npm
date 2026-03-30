import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import { spawnSync } from "node:child_process";
import { findBetterCore } from "../lib/core.js";
import { join } from "node:path";
import fs from "node:fs/promises";

/**
 * `better sbom [--format cyclonedx|spdx] [--output FILE]`
 * Generate a Software Bill of Materials from installed packages.
 */
export async function cmdSbom(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    printText(`Usage: better sbom [options]

Generate a Software Bill of Materials (SBOM) for installed packages.

Options:
  --format <fmt>   Output format: cyclonedx (default) | spdx
  --output <file>  Write to file instead of stdout
  --json           Machine-readable output
  -h, --help       Show this help

Examples:
  better sbom                             # CycloneDX JSON to stdout
  better sbom --format spdx --output sbom.spdx
  better sbom --output bom.json
`);
    return;
  }

  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: runtime.json === true },
      format: { type: "string", default: "cyclonedx" },
      output: { type: "string" },
    },
    allowPositionals: false,
    strict: false,
  });

  const useJson = values.json;
  const binPath = findBetterCore();

  if (binPath) {
    const args = ["sbom"];
    if (values.format) args.push("--format", values.format);
    if (values.output) args.push("--output", values.output);
    if (useJson) args.push("--json");
    const result = spawnSync(binPath, args, { cwd: process.cwd(), stdio: "inherit" });
    process.exitCode = result.status ?? 0;
    return;
  }

  // JS fallback: generate minimal CycloneDX SBOM from package-lock.json
  const cwd = process.cwd();
  try {
    const lockPath = join(cwd, "package-lock.json");
    const lock = JSON.parse(await fs.readFile(lockPath, "utf8"));
    const pkgJson = JSON.parse(await fs.readFile(join(cwd, "package.json"), "utf8"));

    const packages = lock.packages || {};
    const components = [];

    for (const [pkgPath, info] of Object.entries(packages)) {
      if (!pkgPath || pkgPath === "") continue;
      const name = pkgPath.startsWith("node_modules/") ? pkgPath.slice(13) : pkgPath;
      if (!name || name.includes("/node_modules/")) continue;
      components.push({
        type: "library",
        name,
        version: info.version || "unknown",
        purl: `pkg:npm/${encodeURIComponent(name)}@${info.version || "unknown"}`,
        hashes: info.integrity ? [{ alg: "SHA-512", content: info.integrity.replace("sha512-", "") }] : [],
      });
    }

    const sbom = {
      bomFormat: "CycloneDX",
      specVersion: "1.4",
      serialNumber: `urn:uuid:${Date.now().toString(16)}`,
      version: 1,
      metadata: {
        timestamp: new Date().toISOString(),
        component: {
          type: "application",
          name: pkgJson.name || "unknown",
          version: pkgJson.version || "0.0.0",
        },
      },
      components,
    };

    const output = JSON.stringify(sbom, null, 2);

    if (values.output) {
      await fs.writeFile(values.output, output);
      if (!useJson) printText(`SBOM written to ${values.output} (${components.length} components)`);
      else printJson({ ok: true, kind: "better.sbom", format: "cyclonedx", components: components.length, output: values.output });
    } else if (useJson) {
      printJson({ ok: true, kind: "better.sbom", format: "cyclonedx", ...sbom });
    } else {
      process.stdout.write(output + "\n");
    }
  } catch (err) {
    if (useJson) { printJson({ ok: false, error: err.message }); }
    else { printText(`Error: ${err.message}`); }
    process.exitCode = 1;
  }
}
