import { parseArgs } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import { childLogger } from "../lib/log.js";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

const HELP = `
Usage: better license [options]

Scan node_modules for package licenses and report them.

Options:
  --help, -h          Show this help message
  --json              Output in JSON format
  --project-root PATH Override project root directory
  --allow LIST        Comma-separated list of allowed licenses (exit 1 if others found)
  --deny LIST         Comma-separated list of denied licenses (exit 1 if found)

Examples:
  better license
  better license --json
  better license --allow "MIT,ISC,Apache-2.0"
  better license --deny "GPL-3.0,AGPL-3.0"
`;

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readJsonSafe(p) {
  try {
    const raw = await fs.readFile(p, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function readFileSafe(p) {
  try {
    return await fs.readFile(p, "utf8");
  } catch {
    return null;
  }
}

const LICENSE_FILE_NAMES = [
  "LICENSE",
  "LICENSE.md",
  "LICENSE.txt",
  "LICENCE",
  "LICENCE.md",
  "LICENCE.txt"
];

const SPDX_PATTERNS = [
  /\b(MIT)\b/i,
  /\b(ISC)\b/i,
  /\b(Apache-2\.0)\b/i,
  /\b(BSD-2-Clause)\b/i,
  /\b(BSD-3-Clause)\b/i,
  /\b(GPL-3\.0)\b/i,
  /\b(GPL-2\.0)\b/i,
  /\b(AGPL-3\.0)\b/i,
  /\b(LGPL-3\.0)\b/i,
  /\b(MPL-2\.0)\b/i,
  /\b(CC0-1\.0)\b/i,
  /\b(Unlicense)\b/i
];

function detectLicenseFromText(text) {
  if (!text) return null;

  for (const pattern of SPDX_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      return match[1].toUpperCase();
    }
  }

  if (/MIT License/i.test(text)) return "MIT";
  if (/ISC License/i.test(text)) return "ISC";
  if (/Apache License/i.test(text)) return "Apache-2.0";
  if (/BSD.*2-Clause/i.test(text)) return "BSD-2-Clause";
  if (/BSD.*3-Clause/i.test(text)) return "BSD-3-Clause";

  return null;
}

async function getLicenseForPackage(packagePath) {
  const pkgJsonPath = path.join(packagePath, "package.json");
  const pkg = await readJsonSafe(pkgJsonPath);

  if (!pkg) {
    return null;
  }

  let license = null;

  if (pkg.license) {
    if (typeof pkg.license === "string") {
      license = pkg.license;
    } else if (typeof pkg.license === "object" && pkg.license.type) {
      license = pkg.license.type;
    }
  }

  if (!license && pkg.licenses && Array.isArray(pkg.licenses) && pkg.licenses.length > 0) {
    const first = pkg.licenses[0];
    license = typeof first === "string" ? first : first?.type;
  }

  if (!license) {
    for (const fileName of LICENSE_FILE_NAMES) {
      const licensePath = path.join(packagePath, fileName);
      const licenseText = await readFileSafe(licensePath);
      if (licenseText) {
        license = detectLicenseFromText(licenseText);
        if (license) break;
      }
    }
  }

  return {
    name: pkg.name || path.basename(packagePath),
    version: pkg.version || "unknown",
    license: license || "UNKNOWN",
    path: packagePath
  };
}

async function scanNodeModules(nodeModulesPath) {
  const packages = [];

  if (!(await exists(nodeModulesPath))) {
    return packages;
  }

  const entries = await fs.readdir(nodeModulesPath, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const entryPath = path.join(nodeModulesPath, entry.name);

    if (entry.name.startsWith("@")) {
      const scopedEntries = await fs.readdir(entryPath, { withFileTypes: true });
      for (const scopedEntry of scopedEntries) {
        if (!scopedEntry.isDirectory()) continue;
        const scopedPath = path.join(entryPath, scopedEntry.name);
        const pkgInfo = await getLicenseForPackage(scopedPath);
        if (pkgInfo) {
          packages.push(pkgInfo);
        }

        const nestedNodeModules = path.join(scopedPath, "node_modules");
        if (await exists(nestedNodeModules)) {
          const nested = await scanNodeModules(nestedNodeModules);
          packages.push(...nested);
        }
      }
    } else {
      const pkgInfo = await getLicenseForPackage(entryPath);
      if (pkgInfo) {
        packages.push(pkgInfo);
      }

      const nestedNodeModules = path.join(entryPath, "node_modules");
      if (await exists(nestedNodeModules)) {
        const nested = await scanNodeModules(nestedNodeModules);
        packages.push(...nested);
      }
    }
  }

  return packages;
}

function buildSummary(packages, allowList, denyList) {
  const byLicense = {};
  const violations = [];

  for (const pkg of packages) {
    byLicense[pkg.license] = (byLicense[pkg.license] || 0) + 1;
  }

  if (allowList && allowList.length > 0) {
    const allowSet = new Set(allowList);
    for (const pkg of packages) {
      if (!allowSet.has(pkg.license)) {
        violations.push({
          type: "not-allowed",
          package: pkg.name,
          version: pkg.version,
          license: pkg.license,
          message: `License "${pkg.license}" is not in the allow list`
        });
      }
    }
  }

  if (denyList && denyList.length > 0) {
    const denySet = new Set(denyList);
    for (const pkg of packages) {
      if (denySet.has(pkg.license)) {
        violations.push({
          type: "denied",
          package: pkg.name,
          version: pkg.version,
          license: pkg.license,
          message: `License "${pkg.license}" is in the deny list`
        });
      }
    }
  }

  return {
    totalPackages: packages.length,
    byLicense,
    violations
  };
}

function formatTextOutput(packages, summary) {
  const lines = [];

  lines.push(`Total packages: ${summary.totalPackages}\n`);

  const licenseGroups = {};
  for (const pkg of packages) {
    if (!licenseGroups[pkg.license]) {
      licenseGroups[pkg.license] = [];
    }
    licenseGroups[pkg.license].push(pkg);
  }

  const sortedLicenses = Object.keys(licenseGroups).sort((a, b) => {
    if (a === "UNKNOWN") return 1;
    if (b === "UNKNOWN") return -1;
    return licenseGroups[b].length - licenseGroups[a].length;
  });

  for (const license of sortedLicenses) {
    const pkgs = licenseGroups[license];
    lines.push(`${license} (${pkgs.length} packages):`);
    for (const pkg of pkgs.sort((a, b) => a.name.localeCompare(b.name))) {
      lines.push(`  ${pkg.name}@${pkg.version}`);
    }
    lines.push("");
  }

  if (summary.violations.length > 0) {
    lines.push("VIOLATIONS:");
    for (const violation of summary.violations) {
      lines.push(`  [${violation.type.toUpperCase()}] ${violation.package}@${violation.version}: ${violation.message}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export async function cmdLicense(argv) {
  const logger = childLogger({ cmd: "license" });

  const parsed = parseArgs({
    args: argv,
    options: {
      help: { type: "boolean", short: "h" },
      json: { type: "boolean" },
      "project-root": { type: "string" },
      allow: { type: "string" },
      deny: { type: "string" }
    },
    allowPositionals: true
  });

  if (parsed.values.help) {
    printText(HELP);
    return;
  }

  const config = getRuntimeConfig();
  const isJson = parsed.values.json ?? config.json;

  let projectRoot;
  if (parsed.values["project-root"]) {
    projectRoot = path.resolve(parsed.values["project-root"]);
  } else {
    const resolved = await resolveInstallProjectRoot(process.cwd());
    projectRoot = resolved.root;
    logger.debug("Resolved project root", { root: projectRoot, reason: resolved.reason });
  }

  const allowList = parsed.values.allow
    ? parsed.values.allow.split(",").map((s) => s.trim()).filter(Boolean)
    : null;

  const denyList = parsed.values.deny
    ? parsed.values.deny.split(",").map((s) => s.trim()).filter(Boolean)
    : null;

  logger.info("Scanning node_modules for licenses", { projectRoot });

  const nodeModulesPath = path.join(projectRoot, "node_modules");
  const packages = await scanNodeModules(nodeModulesPath);

  logger.info("License scan complete", { packageCount: packages.length });

  const summary = buildSummary(packages, allowList, denyList);

  if (isJson) {
    printJson({
      ok: summary.violations.length === 0,
      kind: "better.license",
      schemaVersion: 1,
      packages,
      summary
    });
  } else {
    printText(formatTextOutput(packages, summary));
  }

  if (summary.violations.length > 0) {
    process.exitCode = 1;
  }
}
