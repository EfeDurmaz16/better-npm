import { parseArgs } from "node:util";
import path from "node:path";
import fs from "node:fs/promises";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import { childLogger } from "../lib/log.js";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";
import { queryBatch, summarizeVuln, parseSeverity } from "../lib/osv.js";
import { buildVulnGraph, suggestUpgrades, graphToJson, formatExposurePath } from "../lib/vulnGraph.js";
import { resolveWorkspacePackages } from "../lib/workspaces.js";

async function readJsonFile(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Extract packages from package-lock.json (npm lockfile v2/v3).
 */
function extractPackagesFromNpmLock(lock) {
  const packages = [];
  const depTree = { __root__: { version: "0.0.0", dependencies: {} } };

  if (lock.packages) {
    // v2/v3 format
    const rootDeps = lock.packages[""]?.dependencies ?? {};
    depTree.__root__.dependencies = {};

    for (const [pkgPath, info] of Object.entries(lock.packages)) {
      if (pkgPath === "") continue;
      const name = pkgPath.replace(/^node_modules\//, "").replace(/.*node_modules\//, "");
      if (!name || !info.version) continue;

      packages.push({ name, version: info.version });
      depTree[name] = {
        version: info.version,
        dependencies: { ...(info.dependencies ?? {}), ...(info.devDependencies ?? {}) }
      };

      // Track root-level deps
      if (!pkgPath.includes("node_modules/node_modules/")) {
        depTree.__root__.dependencies[name] = info.version;
      }
    }
  } else if (lock.dependencies) {
    // v1 format
    function walkDeps(deps, parentKey) {
      for (const [name, info] of Object.entries(deps)) {
        if (!info.version) continue;
        packages.push({ name, version: info.version });
        depTree[name] = {
          version: info.version,
          dependencies: {}
        };
        if (parentKey === "__root__") {
          depTree.__root__.dependencies[name] = info.version;
        }
        if (info.dependencies) {
          walkDeps(info.dependencies, name);
          for (const [subName, subInfo] of Object.entries(info.dependencies)) {
            depTree[name].dependencies[subName] = subInfo.version ?? "*";
          }
        }
      }
    }
    walkDeps(lock.dependencies, "__root__");
  }

  return { packages, depTree };
}

/**
 * Extract packages from pnpm-lock.yaml (minimal YAML parsing).
 */
function extractPackagesFromPnpmLock(raw) {
  const packages = [];
  const depTree = { __root__: { version: "0.0.0", dependencies: {} } };
  let inPackages = false;

  for (const line of raw.split("\n")) {
    if (line.startsWith("packages:")) {
      inPackages = true;
      continue;
    }
    if (inPackages && /^\S/.test(line) && !line.startsWith(" ")) {
      inPackages = false;
      continue;
    }
    if (inPackages) {
      // Match package entries like "  /lodash@4.17.21:" or "  lodash@4.17.21:"
      const match = line.match(/^\s+\/?(.+?)@(\d[^:]*?):/);
      if (match) {
        const name = match[1];
        const version = match[2];
        packages.push({ name, version });
        depTree[name] = { version, dependencies: {} };
        depTree.__root__.dependencies[name] = version;
      }
    }
  }

  return { packages, depTree };
}

/**
 * Extract packages from yarn.lock (minimal parsing).
 */
function extractPackagesFromYarnLock(raw) {
  const packages = [];
  const depTree = { __root__: { version: "0.0.0", dependencies: {} } };
  const seen = new Set();

  const blocks = raw.split("\n\n");
  for (const block of blocks) {
    const lines = block.split("\n");
    const header = lines[0]?.trim();
    if (!header || header.startsWith("#")) continue;

    let name = null;
    let version = null;

    // Parse header for package name
    const headerMatch = header.match(/^"?(@?[^@\s"]+)@/);
    if (headerMatch) name = headerMatch[1];

    // Find version line
    for (const line of lines) {
      const vMatch = line.match(/^\s+version\s+"?([^"\s]+)"?/);
      if (vMatch) {
        version = vMatch[1];
        break;
      }
    }

    if (name && version) {
      const key = `${name}@${version}`;
      if (!seen.has(key)) {
        seen.add(key);
        packages.push({ name, version });
        depTree[name] = { version, dependencies: {} };
        depTree.__root__.dependencies[name] = version;
      }
    }
  }

  return { packages, depTree };
}

async function resolvePackagesFromLockfile(projectRoot) {
  // Try npm lockfile first
  const npmLock = await readJsonFile(path.join(projectRoot, "package-lock.json"));
  if (npmLock) {
    return { ok: true, lockfile: "package-lock.json", ...extractPackagesFromNpmLock(npmLock) };
  }

  // Try pnpm lockfile
  try {
    const pnpmRaw = await fs.readFile(path.join(projectRoot, "pnpm-lock.yaml"), "utf8");
    return { ok: true, lockfile: "pnpm-lock.yaml", ...extractPackagesFromPnpmLock(pnpmRaw) };
  } catch {
    // not found
  }

  // Try yarn lockfile
  try {
    const yarnRaw = await fs.readFile(path.join(projectRoot, "yarn.lock"), "utf8");
    return { ok: true, lockfile: "yarn.lock", ...extractPackagesFromYarnLock(yarnRaw) };
  } catch {
    // not found
  }

  return { ok: false, reason: "no_lockfile_found", packages: [], depTree: {} };
}

export async function cmdAudit(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    printText(`Usage:
  better audit [options]

Options:
  --json                Machine-readable JSON output
  --project-root PATH   Override project root
  --severity LEVEL      Minimum severity to report (critical|high|medium|low) [default: low]
  --fix                 Show upgrade suggestions
  --fail-on LEVEL       Exit with code 1 if vulns at this severity or above [default: none]
  --timeout MS          API timeout in milliseconds [default: 15000]
  --workspace           Scan all workspace packages
`);
    return;
  }

  const runtime = getRuntimeConfig();
  const logger = childLogger({ command: "audit" });
  const { values } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: runtime.json === true },
      "project-root": { type: "string" },
      severity: { type: "string", default: "low" },
      fix: { type: "boolean", default: false },
      "fail-on": { type: "string", default: "none" },
      timeout: { type: "string", default: "15000" },
      workspace: { type: "boolean", default: false }
    },
    allowPositionals: true,
    strict: false
  });

  const jsonOutput = values.json;
  const minSeverity = values.severity;
  const severityOrder = { critical: 0, high: 1, medium: 2, low: 3, unknown: 4 };
  if (!(minSeverity in severityOrder)) {
    throw new Error(`Unknown --severity '${minSeverity}'. Expected critical|high|medium|low.`);
  }

  const failOn = values["fail-on"];
  if (failOn !== "none" && !(failOn in severityOrder)) {
    throw new Error(`Unknown --fail-on '${failOn}'. Expected none|critical|high|medium|low.`);
  }

  const resolvedRoot = values["project-root"]
    ? { root: path.resolve(values["project-root"]), reason: "flag:--project-root" }
    : await resolveInstallProjectRoot(process.cwd());
  const projectRoot = resolvedRoot.root;

  logger.info("audit.start", { projectRoot });

  // Workspace mode: scan all workspace packages
  if (values.workspace) {
    const wsResult = await resolveWorkspacePackages(projectRoot);
    if (!wsResult.ok) {
      throw new Error(`No workspace configuration found in ${projectRoot}.`);
    }

    if (!jsonOutput) printText(`Scanning ${wsResult.packages.length} workspace packages...`);

    const allPackages = [];
    const mergedDepTree = { __root__: { version: "0.0.0", dependencies: {} } };
    const lockfiles = [];

    for (const pkg of wsResult.packages) {
      const lockResult = await resolvePackagesFromLockfile(pkg.dir);
      if (lockResult.ok) {
        allPackages.push(...lockResult.packages);
        Object.assign(mergedDepTree, lockResult.depTree);
        Object.assign(mergedDepTree.__root__.dependencies, lockResult.depTree.__root__?.dependencies ?? {});
        lockfiles.push({ name: pkg.name, lockfile: lockResult.lockfile });
        if (!jsonOutput) printText(`  ${pkg.name}: ${lockResult.packages.length} packages (${lockResult.lockfile})`);
      }
    }

    // Also scan the root lockfile
    const rootLock = await resolvePackagesFromLockfile(projectRoot);
    if (rootLock.ok) {
      allPackages.push(...rootLock.packages);
      Object.assign(mergedDepTree, rootLock.depTree);
      Object.assign(mergedDepTree.__root__.dependencies, rootLock.depTree.__root__?.dependencies ?? {});
    }

    // Deduplicate and continue with merged results
    const seen = new Set();
    const uniquePackages = allPackages.filter(p => {
      const key = `${p.name}@${p.version}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    if (!jsonOutput) printText(`Total: ${uniquePackages.length} unique packages across ${wsResult.packages.length} workspaces`);

    const scanResult = await queryBatch(uniquePackages);
    if (!scanResult.ok) throw new Error(`OSV API error: ${scanResult.reason}`);

    const graph = buildVulnGraph(scanResult.results, mergedDepTree);
    return finalizeAudit({ graph, uniquePackages, projectRoot, lockfile: "workspace", jsonOutput, minSeverity, severityOrder, failOn, values, logger });
  }

  // Step 1: Resolve packages from lockfile
  if (!jsonOutput) printText("Resolving packages from lockfile...");
  const lockResult = await resolvePackagesFromLockfile(projectRoot);
  if (!lockResult.ok) {
    const err = new Error(`No lockfile found in ${projectRoot}. Run your package manager's install first.`);
    throw err;
  }

  const { packages, depTree, lockfile } = lockResult;
  if (!jsonOutput) printText(`Found ${packages.length} packages in ${lockfile}`);

  // Deduplicate packages (same name+version)
  const seen = new Set();
  const uniquePackages = packages.filter(p => {
    const key = `${p.name}@${p.version}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Step 2: Query OSV.dev for vulnerabilities
  if (!jsonOutput) printText(`Scanning ${uniquePackages.length} unique packages against OSV.dev...`);
  const scanResult = await queryBatch(uniquePackages);

  if (!scanResult.ok) {
    throw new Error(`OSV API error: ${scanResult.reason}`);
  }

  // Step 3: Build vulnerability graph
  const graph = buildVulnGraph(scanResult.results, depTree);

  return finalizeAudit({ graph, uniquePackages, projectRoot, lockfile, jsonOutput, minSeverity, severityOrder, failOn, values, logger });
}

function finalizeAudit({ graph, uniquePackages, projectRoot, lockfile, jsonOutput, minSeverity, severityOrder, failOn, values, logger }) {
  // Filter by severity
  const minIdx = severityOrder[minSeverity];
  const filteredVulns = [];
  for (const [, node] of graph.nodes) {
    const nodeIdx = severityOrder[node.severity] ?? 4;
    if (nodeIdx <= minIdx) {
      filteredVulns.push(node);
    }
  }

  // Generate report
  const report = {
    ok: true,
    kind: "better.audit.report",
    schemaVersion: 1,
    projectRoot,
    lockfile,
    scannedPackages: uniquePackages.length,
    ...graphToJson(graph),
    minSeverity
  };

  if (jsonOutput) {
    printJson(report);
  } else {
    const summary = graph.summary;

    printText("");
    if (summary.totalVulnerabilities === 0) {
      printText("No vulnerabilities found!");
    } else {
      printText(`Found ${summary.totalVulnerabilities} vulnerabilities in ${summary.affectedPackages} packages`);
      printText("");

      const counts = summary.severityCounts;
      const parts = [];
      if (counts.critical > 0) parts.push(`  critical: ${counts.critical}`);
      if (counts.high > 0) parts.push(`  high: ${counts.high}`);
      if (counts.medium > 0) parts.push(`  medium: ${counts.medium}`);
      if (counts.low > 0) parts.push(`  low: ${counts.low}`);
      printText(parts.join("\n"));
      printText("");

      printText(`Overall risk: ${summary.riskLevel} (score: ${summary.overallRiskScore}/100)`);
      printText("");

      for (const node of filteredVulns) {
        printText(`${node.isDirect ? "direct" : "transitive"} | ${node.name}@${node.version} | ${node.severity}`);
        for (const vuln of node.vulns) {
          printText(`  ${vuln.id}: ${vuln.summary}`);
          if (vuln.ranges?.length > 0) {
            const fixed = vuln.ranges.filter(r => r.fixed).map(r => r.fixed);
            if (fixed.length > 0) {
              printText(`    fix: upgrade to ${fixed.join(" or ")}`);
            }
          }
        }
        if (node.exposurePaths.length > 0) {
          printText(`  exposure: ${formatExposurePath(node.exposurePaths[0])}`);
        }
        printText("");
      }

      if (values.fix) {
        const suggestions = suggestUpgrades(graph);
        if (suggestions.length > 0) {
          printText("Suggested upgrades:");
          for (const s of suggestions) {
            const fixStr = s.fixedVersion ? ` -> ${s.fixedVersion}` : " (no fix available)";
            printText(`  ${s.name}@${s.currentVersion}${fixStr} (${s.severity}, ${s.vulnCount} vuln${s.vulnCount > 1 ? "s" : ""})`);
          }
        }
      }
    }
  }

  // Set exit code based on --fail-on
  if (failOn !== "none") {
    const failIdx = severityOrder[failOn];
    for (const [, node] of graph.nodes) {
      const nodeIdx = severityOrder[node.severity] ?? 4;
      if (nodeIdx <= failIdx) {
        process.exitCode = 1;
        break;
      }
    }
  }

  logger.info("audit.end", {
    totalVulnerabilities: graph.summary.totalVulnerabilities,
    riskScore: graph.summary.overallRiskScore
  });
}
