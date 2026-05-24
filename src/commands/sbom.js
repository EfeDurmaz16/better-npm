import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import { findBetterCore } from "../lib/core.js";
import { runCommand } from "../lib/spawn.js";
import { join } from "node:path";
import fs from "node:fs/promises";

function spdxId(name, version) {
  return `SPDXRef-Package-${name.replace(/[^a-zA-Z0-9.-]/g, "-")}-${version.replace(/[^a-zA-Z0-9.-]/g, "-")}`;
}

function buildSpdx(pkgJson, components) {
  const now = new Date().toISOString();
  const docNamespace = `https://spdx.org/spdxdocs/${pkgJson.name || "unknown"}-${pkgJson.version || "0.0.0"}-${Date.now()}`;
  const lines = [
    "SPDXVersion: SPDX-2.3",
    "DataLicense: CC0-1.0",
    "SPDXID: SPDXRef-DOCUMENT",
    `DocumentName: ${pkgJson.name || "unknown"}`,
    `DocumentNamespace: ${docNamespace}`,
    `Creator: Tool: better-npm`,
    `Created: ${now}`,
    "",
    `PackageName: ${pkgJson.name || "unknown"}`,
    "SPDXID: SPDXRef-Package-root",
    `PackageVersion: ${pkgJson.version || "0.0.0"}`,
    "FilesAnalyzed: false",
    `PackageLicenseConcluded: ${pkgJson.license || "NOASSERTION"}`,
    `PackageLicenseDeclared: ${pkgJson.license || "NOASSERTION"}`,
    "PackageCopyrightText: NOASSERTION",
    ""
  ];
  for (const c of components) {
    lines.push(`PackageName: ${c.name}`);
    lines.push(`SPDXID: ${spdxId(c.name, c.version)}`);
    lines.push(`PackageVersion: ${c.version}`);
    lines.push(`PURL: ${c.purl}`);
    if (c.resolved) lines.push(`PackageDownloadLocation: ${c.resolved}`);
    else lines.push("PackageDownloadLocation: NOASSERTION");
    lines.push("FilesAnalyzed: false");
    lines.push(`PackageLicenseConcluded: ${c.license || "NOASSERTION"}`);
    lines.push(`PackageLicenseDeclared: ${c.license || "NOASSERTION"}`);
    lines.push("PackageCopyrightText: NOASSERTION");
    if (c.integrity) lines.push(`PackageChecksum: SHA-512: ${c.integrity.replace(/^sha512-/, "")}`);
    lines.push("");
  }
  for (const c of components) {
    lines.push(`Relationship: SPDXRef-Package-root DEPENDS_ON ${spdxId(c.name, c.version)}`);
  }
  return lines.join("\n") + "\n";
}

function buildCycloneDx(pkgJson, components, opts = {}) {
  const { includeVex = false } = opts;
  const sbom = {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    serialNumber: `urn:uuid:${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`,
    version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      tools: [{ vendor: "better-npm", name: "better", version: "0.3.0" }],
      component: {
        type: "application",
        bom_ref: "root",
        name: pkgJson.name || "unknown",
        version: pkgJson.version || "0.0.0",
        purl: `pkg:npm/${encodeURIComponent(pkgJson.name || "unknown")}@${pkgJson.version || "0.0.0"}`
      }
    },
    components: components.map(c => ({
      type: "library",
      "bom-ref": `${c.name}@${c.version}`,
      name: c.name,
      version: c.version,
      purl: c.purl,
      ...(c.resolved ? { externalReferences: [{ type: "distribution", url: c.resolved }] } : {}),
      ...(c.integrity ? { hashes: [{ alg: "SHA-512", content: c.integrity.replace(/^sha512-/, "") }] } : {}),
      ...(c.license ? { licenses: [{ license: { id: c.license } }] } : {})
    })),
    dependencies: [
      {
        ref: "root",
        dependsOn: components.map(c => `${c.name}@${c.version}`)
      }
    ]
  };
  if (includeVex) {
    sbom.vulnerabilities = [];
  }
  return sbom;
}

export async function cmdSbom(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    printText(`Usage: better sbom [options]

Generate a Software Bill of Materials (SBOM) for installed packages.

Options:
  --format <fmt>    Output format: cyclonedx (default) | spdx
  --output <file>   Write to file instead of stdout
  --vex             Include VEX (Vulnerability Exploitability eXchange) section
  --project-root    Path to project root
  --json            Machine-readable output wrapper
  -h, --help        Show this help

Examples:
  better sbom                                 # CycloneDX 1.6 JSON to stdout
  better sbom --format spdx --output sbom.spdx
  better sbom --vex --output bom.json
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
      vex: { type: "boolean", default: false },
      "project-root": { type: "string" }
    },
    allowPositionals: false,
    strict: false
  });

  const useJson = values.json;
  const format = String(values.format ?? "cyclonedx").toLowerCase();
  if (format !== "cyclonedx" && format !== "spdx") {
    printText(`Unknown format '${format}'. Expected cyclonedx|spdx.`);
    process.exitCode = 1;
    return;
  }

  const cwd = values["project-root"] ? String(values["project-root"]) : process.cwd();

  // Try to delegate to better-core binary
  const binPath = await findBetterCore();
  if (binPath) {
    const args = ["sbom"];
    if (values.format) args.push("--format", values.format);
    if (values.output) args.push("--output", values.output);
    if (values.vex) args.push("--vex");
    if (useJson) args.push("--json");
    const result = await runCommand(binPath, args, { cwd, passthroughStdio: true });
    process.exitCode = result.exitCode ?? 0;
    return;
  }

  // JS fallback: generate SBOM from package-lock.json
  try {
    const lockPath = join(cwd, "package-lock.json");
    const lock = JSON.parse(await fs.readFile(lockPath, "utf8"));
    const pkgJson = JSON.parse(await fs.readFile(join(cwd, "package.json"), "utf8"));
    const packages = lock.packages ?? {};

    const components = [];
    for (const [pkgPath, info] of Object.entries(packages)) {
      if (!pkgPath || pkgPath === "") continue;
      const name = pkgPath.startsWith("node_modules/")
        ? pkgPath.slice("node_modules/".length)
        : pkgPath;
      if (!name || name.includes("/node_modules/")) continue;
      components.push({
        name,
        version: info.version || "0.0.0",
        purl: `pkg:npm/${encodeURIComponent(name)}@${info.version || "0.0.0"}`,
        integrity: info.integrity ?? null,
        resolved: info.resolved ?? null,
        license: info.license ?? null
      });
    }

    if (format === "spdx") {
      const spdxText = buildSpdx(pkgJson, components);
      if (values.output) {
        await fs.writeFile(values.output, spdxText);
        if (!useJson) printText(`SBOM (SPDX 2.3) written to ${values.output} (${components.length} packages)`);
        else printJson({ ok: true, kind: "better.sbom", format: "spdx", specVersion: "2.3", components: components.length, output: values.output });
      } else {
        process.stdout.write(spdxText);
      }
      return;
    }

    // CycloneDX 1.6
    const sbom = buildCycloneDx(pkgJson, components, { includeVex: values.vex === true });
    const output = JSON.stringify(sbom, null, 2);

    if (values.output) {
      await fs.writeFile(values.output, output + "\n");
      if (!useJson) printText(`SBOM (CycloneDX 1.6) written to ${values.output} (${components.length} components)`);
      else printJson({ ok: true, kind: "better.sbom", format: "cyclonedx", specVersion: "1.6", components: components.length, output: values.output });
    } else if (useJson) {
      printJson({ ok: true, kind: "better.sbom", format: "cyclonedx", specVersion: "1.6", ...sbom });
    } else {
      process.stdout.write(output + "\n");
    }
  } catch (err) {
    if (useJson) printJson({ ok: false, kind: "better.sbom", error: err.message });
    else printText(`Error: ${err.message}`);
    process.exitCode = 1;
  }
}
