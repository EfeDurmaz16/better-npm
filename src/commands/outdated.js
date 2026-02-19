import { parseArgs } from "node:util";
import fs from "node:fs/promises";
import https from "node:https";
import path from "node:path";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import { childLogger } from "../lib/log.js";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

async function readJsonFile(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function httpsGet(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs }, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        if (res.statusCode === 200) {
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(new Error(`Failed to parse JSON from ${url}: ${err.message}`));
          }
        } else if (res.statusCode === 404) {
          resolve(null);
        } else {
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`Request timeout for ${url}`));
    });
  });
}

async function fetchPackageInfo(name, timeoutMs) {
  const url = `https://registry.npmjs.org/${encodeURIComponent(name)}`;
  return await httpsGet(url, timeoutMs);
}

function parseVersion(ver) {
  if (!ver) return null;
  const match = ver.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
    original: ver
  };
}

function compareVersions(a, b) {
  const aParsed = parseVersion(a);
  const bParsed = parseVersion(b);
  if (!aParsed || !bParsed) return 0;
  if (aParsed.major !== bParsed.major) return aParsed.major - bParsed.major;
  if (aParsed.minor !== bParsed.minor) return aParsed.minor - bParsed.minor;
  return aParsed.patch - bParsed.patch;
}

function satisfiesRange(version, range) {
  if (!range || !version) return false;

  // Simple range matching - handle common cases
  if (range === "*" || range === "latest") return true;

  // Exact version
  if (range === version) return true;

  // Remove leading = if present
  const cleanRange = range.replace(/^=/, "");

  // ^1.2.3 - compatible with 1.x.x (same major)
  if (cleanRange.startsWith("^")) {
    const baseVer = parseVersion(cleanRange.slice(1));
    const testVer = parseVersion(version);
    if (!baseVer || !testVer) return false;
    if (baseVer.major === 0) {
      // ^0.x.y is stricter - same minor
      return testVer.major === baseVer.major && testVer.minor === baseVer.minor && testVer.patch >= baseVer.patch;
    }
    return testVer.major === baseVer.major && compareVersions(version, cleanRange.slice(1)) >= 0;
  }

  // ~1.2.3 - compatible with 1.2.x (same minor)
  if (cleanRange.startsWith("~")) {
    const baseVer = parseVersion(cleanRange.slice(1));
    const testVer = parseVersion(version);
    if (!baseVer || !testVer) return false;
    return testVer.major === baseVer.major && testVer.minor === baseVer.minor && testVer.patch >= baseVer.patch;
  }

  // >=1.2.3
  if (cleanRange.startsWith(">=")) {
    return compareVersions(version, cleanRange.slice(2)) >= 0;
  }

  // >1.2.3
  if (cleanRange.startsWith(">")) {
    return compareVersions(version, cleanRange.slice(1)) > 0;
  }

  // <=1.2.3
  if (cleanRange.startsWith("<=")) {
    return compareVersions(version, cleanRange.slice(2)) <= 0;
  }

  // <1.2.3
  if (cleanRange.startsWith("<")) {
    return compareVersions(version, cleanRange.slice(1)) < 0;
  }

  // Exact match
  return version === cleanRange;
}

function findMaxSatisfying(versions, range) {
  if (!Array.isArray(versions) || versions.length === 0) return null;

  const satisfying = versions.filter(v => satisfiesRange(v, range));
  if (satisfying.length === 0) return null;

  return satisfying.reduce((max, ver) => {
    return compareVersions(ver, max) > 0 ? ver : max;
  });
}

function classifyUpdate(current, wanted, latest) {
  if (!current || !latest) return null;
  if (current === latest) return null;

  const currentParsed = parseVersion(current);
  const latestParsed = parseVersion(latest);

  if (!currentParsed || !latestParsed) return "unknown";

  if (latestParsed.major > currentParsed.major) return "major";
  if (latestParsed.minor > currentParsed.minor) return "minor";
  if (latestParsed.patch > currentParsed.patch) return "patch";

  return "prerelease";
}

export async function cmdOutdated(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    printText(`Usage:
  better outdated [--json] [--production] [--level patch|minor|major]
                  [--project-root PATH]

Check installed packages for newer versions available in the npm registry.

Options:
  --json              Output machine-readable JSON
  --production        Only check dependencies (skip devDependencies)
  --level LEVEL       Filter by minimum update level (patch|minor|major)
  --project-root PATH Override project root directory
  -h, --help          Show this help

Output:
  - Text mode: Table with package name, current, wanted, latest, and update type
  - JSON mode: Structured data with package details and summary statistics
`);
    return;
  }

  const runtime = getRuntimeConfig();
  const commandLogger = childLogger({ command: "outdated" });

  const { values } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: runtime.json === true },
      "project-root": { type: "string" },
      production: { type: "boolean", default: false },
      level: { type: "string" }
    },
    allowPositionals: true,
    strict: false
  });

  const invocationCwd = process.cwd();
  const resolvedRoot = values["project-root"]
    ? { root: path.resolve(values["project-root"]), reason: "flag:--project-root" }
    : await resolveInstallProjectRoot(invocationCwd);
  const projectRoot = resolvedRoot.root;

  const minLevel = values.level;
  if (minLevel && !["patch", "minor", "major"].includes(minLevel)) {
    throw new Error(`Invalid --level '${minLevel}'. Expected patch|minor|major.`);
  }

  commandLogger.info("outdated.start", { projectRoot, production: values.production });

  const packageJsonPath = path.join(projectRoot, "package.json");
  const lockfilePath = path.join(projectRoot, "package-lock.json");

  const packageJson = await readJsonFile(packageJsonPath);
  if (!packageJson) {
    const err = new Error("package.json not found");
    if (values.json) {
      printJson({
        ok: false,
        kind: "better.outdated",
        schemaVersion: 1,
        error: err.message
      });
    } else {
      printText(`Error: ${err.message}`);
    }
    process.exitCode = 1;
    return;
  }

  const lockfile = await readJsonFile(lockfilePath);

  const dependencies = packageJson.dependencies ?? {};
  const devDependencies = values.production ? {} : (packageJson.devDependencies ?? {});
  const allDeps = { ...dependencies, ...devDependencies };

  if (Object.keys(allDeps).length === 0) {
    const result = {
      ok: true,
      kind: "better.outdated",
      schemaVersion: 1,
      packages: [],
      summary: {
        totalChecked: 0,
        upToDate: 0,
        outdated: 0,
        major: 0,
        minor: 0,
        patch: 0
      }
    };
    if (values.json) {
      printJson(result);
    } else {
      printText("No dependencies to check.");
    }
    return;
  }

  const packages = [];
  const checkedCount = Object.keys(allDeps).length;
  let processedCount = 0;

  for (const [name, range] of Object.entries(allDeps)) {
    processedCount++;
    commandLogger.info("outdated.check", { name, progress: `${processedCount}/${checkedCount}` });

    const isDev = !dependencies[name] && devDependencies[name];

    // Get current version from lockfile
    let current = null;
    if (lockfile?.packages) {
      const pkgKey = `node_modules/${name}`;
      const lockEntry = lockfile.packages[pkgKey];
      current = lockEntry?.version ?? null;
    }

    // Fetch registry info
    let registryData = null;
    try {
      registryData = await fetchPackageInfo(name, 10000);
    } catch (err) {
      commandLogger.warn("outdated.registry_error", { name, error: err.message });
      // Continue with null data - will be marked as unavailable
    }

    if (!registryData) {
      // Package not found or error - skip
      continue;
    }

    const latest = registryData["dist-tags"]?.latest ?? null;
    const allVersions = Object.keys(registryData.versions ?? {});
    const wanted = findMaxSatisfying(allVersions, range) ?? latest;

    const updateType = classifyUpdate(current, wanted, latest);

    if (!current) {
      // Package declared but not in lockfile - skip or report
      continue;
    }

    if (updateType) {
      packages.push({
        name,
        current,
        wanted,
        latest,
        range,
        updateType,
        isDev
      });
    }
  }

  // Filter by level if specified
  let filteredPackages = packages;
  if (minLevel) {
    const levelPriority = { patch: 1, minor: 2, major: 3 };
    const minPriority = levelPriority[minLevel];
    filteredPackages = packages.filter(pkg => {
      const pkgPriority = levelPriority[pkg.updateType] ?? 0;
      return pkgPriority >= minPriority;
    });
  }

  const summary = {
    totalChecked: checkedCount,
    upToDate: checkedCount - packages.length,
    outdated: packages.length,
    major: packages.filter(p => p.updateType === "major").length,
    minor: packages.filter(p => p.updateType === "minor").length,
    patch: packages.filter(p => p.updateType === "patch").length
  };

  const result = {
    ok: true,
    kind: "better.outdated",
    schemaVersion: 1,
    packages: filteredPackages,
    summary
  };

  if (values.json) {
    printJson(result);
  } else {
    if (filteredPackages.length === 0) {
      printText("All packages are up to date.");
    } else {
      const lines = ["Package updates available:", ""];

      // Table header
      const nameWidth = Math.max(20, ...filteredPackages.map(p => p.name.length));
      const header = `${"Package".padEnd(nameWidth)} ${"Current".padEnd(12)} ${"Wanted".padEnd(12)} ${"Latest".padEnd(12)} Type`;
      lines.push(header);
      lines.push("-".repeat(header.length));

      // Table rows
      for (const pkg of filteredPackages) {
        const row = `${pkg.name.padEnd(nameWidth)} ${pkg.current.padEnd(12)} ${pkg.wanted.padEnd(12)} ${pkg.latest.padEnd(12)} ${pkg.updateType}`;
        lines.push(row);
      }

      lines.push("");
      lines.push(`Summary: ${summary.outdated} outdated (${summary.major} major, ${summary.minor} minor, ${summary.patch} patch)`);

      printText(lines.join("\n"));
    }
  }
}
