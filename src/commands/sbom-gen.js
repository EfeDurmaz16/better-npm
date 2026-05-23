/**
 * better sbom-gen — generate Software Bill of Materials (SBOM)
 *
 * Generates a Software Bill of Materials in SPDX or CycloneDX format
 * listing all installed dependencies with versions, licenses, and
 * integrity hashes.
 *
 * Usage:
 *   better sbom-gen
 *   better sbom-gen --format cyclonedx
 *   better sbom-gen --output sbom.json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import { runGenerateSbomNapi } from "../lib/core.js";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

function spdxId(name, version) {
  return `SPDXRef-Package-${name.replace(/[^a-zA-Z0-9.-]/g, "-")}-${version}`;
}

function generateSpdx(pkgJson, packages) {
  const now = new Date().toISOString();
  const docNamespace = `https://spdx.org/spdxdocs/${pkgJson.name || "unknown"}-${pkgJson.version || "0.0.0"}-${Date.now()}`;

  const lines = [
    `SPDXVersion: SPDX-2.3`,
    `DataLicense: CC0-1.0`,
    `SPDXID: SPDXRef-DOCUMENT`,
    `DocumentName: ${pkgJson.name || "unknown"}`,
    `DocumentNamespace: ${docNamespace}`,
    ``,
    `PackageName: ${pkgJson.name || "unknown"}`,
    `SPDXID: SPDXRef-Package-root`,
    `PackageVersion: ${pkgJson.version || "0.0.0"}`,
    `FilesAnalyzed: false`,
    `PackageLicenseConcluded: ${pkgJson.license || "NOASSERTION"}`,
    `PackageLicenseDeclared: ${pkgJson.license || "NOASSERTION"}`,
    `PackageCopyrightText: NOASSERTION`,
    ``,
  ];

  for (const pkg of packages) {
    lines.push(`PackageName: ${pkg.name}`);
    lines.push(`SPDXID: ${spdxId(pkg.name, pkg.version)}`);
    lines.push(`PackageVersion: ${pkg.version}`);
    if (pkg.integrity) lines.push(`PackageChecksum: SHA1: ${pkg.integrity.split("-")[1] || ""}`);
    lines.push(`FilesAnalyzed: false`);
    lines.push(`PackageLicenseConcluded: ${pkg.license || "NOASSERTION"}`);
    lines.push(`PackageLicenseDeclared: ${pkg.license || "NOASSERTION"}`);
    lines.push(`PackageCopyrightText: NOASSERTION`);
    lines.push(`Relationship: SPDXRef-Package-root DEPENDS_ON ${spdxId(pkg.name, pkg.version)}`);
    lines.push(``);
  }

  return lines.join("\n");
}

function generateCycloneDx(pkgJson, packages) {
  const serialNumber = `urn:uuid:${crypto.randomUUID()}`;
  const components = packages.map(pkg => ({
    type: "library",
    name: pkg.name,
    version: pkg.version,
    purl: `pkg:npm/${encodeURIComponent(pkg.name)}@${pkg.version}`,
    licenses: pkg.license ? [{ license: { id: pkg.license } }] : [],
    hashes: pkg.integrity ? [{ alg: "SHA-256", content: pkg.integrity.replace(/^sha256-/, "") }] : [],
  }));

  return JSON.stringify({
    bomFormat: "CycloneDX",
    specVersion: "1.4",
    serialNumber,
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
  }, null, 2);
}

export async function cmdSbomGen(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:           { type: "boolean", default: runtime.json === true },
      help:           { type: "boolean", short: "h", default: false },
      format:         { type: "string", default: "cyclonedx" },
      output:         { type: "string", short: "o" },
      "prod-only":    { type: "boolean", default: false },
      "project-root": { type: "string" },
      vex:            { type: "boolean", default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better sbom-gen [options]

Generate a Software Bill of Materials (SBOM).

Options:
  --format <f>   Output format: cyclonedx|spdx (default: cyclonedx)
  -o, --output <f>  Write to file (default: stdout)
  --prod-only    Only include production dependencies
  --json         Machine-readable metadata output
  -h, --help     Show this help

Generates an SBOM listing all dependencies with versions,
licenses, and integrity hashes for supply chain compliance.
`);
    return;
  }

  const format = values.format.toLowerCase();
  if (!["cyclonedx", "spdx"].includes(format)) {
    printText(`Error: Invalid format: ${format}. Use cyclonedx or spdx.`);
    process.exitCode = 1;
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = values["project-root"]
    ? { root: path.resolve(values["project-root"]) }
    : await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;
  const nmPath = path.join(projectRoot, "node_modules");

  if (!values.json) {
    process.stderr.write(`\x1b[90mGenerating ${format.toUpperCase()} SBOM...\x1b[0m\n`);
  }

  // NAPI fast path: use Rust SBOM generator (includes integrity hashes from lockfile)
  const lockfilePath = path.join(projectRoot, "package-lock.json");
  const napiSbom = runGenerateSbomNapi(projectRoot, lockfilePath, format, values.vex === true);
  if (napiSbom?.ok && napiSbom.sbom) {
    const sbomData = typeof napiSbom.sbom === "string" ? napiSbom.sbom : JSON.stringify(napiSbom.sbom, null, 2);
    // Count packages from sbom
    let pkgCount = 0;
    try {
      const parsed = JSON.parse(sbomData);
      pkgCount = parsed.components?.length ?? parsed.packages?.length ?? parsed.packages ?? 0;
    } catch {}
    if (values.output) {
      const outputPath = path.resolve(cwd, values.output);
      await fs.writeFile(outputPath, sbomData, "utf8");
      if (values.json) {
        printJson({ ok: true, kind: "better.sbom-gen", format, packages: pkgCount, outputPath });
      } else {
        printText(`\x1b[32m✔ SBOM written to: ${values.output}\x1b[0m`);
        printText(`  Format: ${format.toUpperCase()}  |  Packages: ${pkgCount}`);
      }
    } else if (values.json) {
      printJson({ ok: true, kind: "better.sbom-gen", format, packages: pkgCount });
    } else {
      process.stdout.write(sbomData + "\n");
    }
    return;
  }
  // JS fallback below

  let pkgJson = {};
  try { pkgJson = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8")); } catch {}

  const depsToInclude = values["prod-only"]
    ? Object.keys(pkgJson.dependencies || {})
    : Object.keys({ ...pkgJson.dependencies, ...pkgJson.devDependencies });

  const packages = [];
  const BATCH = 20;
  for (let i = 0; i < depsToInclude.length; i += BATCH) {
    const batch = depsToInclude.slice(i, i + BATCH);
    await Promise.all(batch.map(async (dep) => {
      try {
        const depPkg = JSON.parse(await fs.readFile(path.join(nmPath, dep, "package.json"), "utf8"));
        packages.push({
          name: depPkg.name || dep,
          version: depPkg.version || "0.0.0",
          license: depPkg.license || null,
          integrity: null, // from lockfile ideally
        });
      } catch {}
    }));
  }

  packages.sort((a, b) => a.name.localeCompare(b.name));

  let sbom;
  if (format === "spdx") {
    sbom = generateSpdx(pkgJson, packages);
  } else {
    sbom = generateCycloneDx(pkgJson, packages);
  }

  if (values.output) {
    const outputPath = path.resolve(cwd, values.output);
    await fs.writeFile(outputPath, sbom, "utf8");
    if (values.json) {
      printJson({ ok: true, kind: "better.sbom-gen", format, packages: packages.length, outputPath });
    } else {
      printText(`\x1b[32m✔ SBOM written to: ${values.output}\x1b[0m`);
      printText(`  Format: ${format.toUpperCase()}  |  Packages: ${packages.length}`);
    }
  } else {
    process.stdout.write(sbom + "\n");
  }
}
