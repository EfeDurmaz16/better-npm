import { parseSeverity, extractAffectedRanges, summarizeVuln } from "./osv.js";

/**
 * Vulnerability dependency graph builder.
 * Maps vulnerabilities to their transitive exposure paths
 * through the dependency tree.
 *
 * Zero dependencies — pure data structure manipulation.
 */

/**
 * Severity weights for risk score calculation.
 */
const SEVERITY_WEIGHTS = {
  critical: 10,
  high: 7,
  medium: 4,
  low: 1,
  unknown: 2
};

/**
 * Build a vulnerability graph from scan results.
 *
 * @param {Array<{name: string, version: string, vulns: Object[]}>} scanResults - From OSV batch query
 * @param {Object} dependencyTree - Dependency graph {name -> {version, dependencies: {name: version}}}
 * @returns {VulnGraph}
 *
 * @typedef {Object} VulnGraph
 * @property {Map<string, VulnNode>} nodes - Package key -> vulnerability info
 * @property {Map<string, string[]>} edges - Package key -> dependent package keys
 * @property {VulnSummary} summary
 */
export function buildVulnGraph(scanResults, dependencyTree) {
  const nodes = new Map();
  const edges = new Map();

  // Build nodes for packages with vulnerabilities
  for (const result of scanResults) {
    if (!result.vulns || result.vulns.length === 0) continue;

    const key = `${result.name}@${result.version}`;
    nodes.set(key, {
      name: result.name,
      version: result.version,
      vulns: result.vulns.map(v => ({
        ...summarizeVuln(v),
        ranges: extractAffectedRanges(v, result.name),
        raw: v
      })),
      severity: highestSeverity(result.vulns),
      riskScore: calculatePackageRisk(result.vulns),
      isDirect: false, // filled below
      exposurePaths: [] // filled below
    });
  }

  // Build dependency edges (reverse: who depends on vulnerable packages)
  if (dependencyTree && typeof dependencyTree === "object") {
    for (const [parentName, parentInfo] of Object.entries(dependencyTree)) {
      const parentKey = `${parentName}@${parentInfo.version ?? "0.0.0"}`;
      const deps = parentInfo.dependencies ?? {};

      for (const [depName, depVersion] of Object.entries(deps)) {
        const depKey = `${depName}@${depVersion}`;
        if (!edges.has(depKey)) edges.set(depKey, []);
        edges.get(depKey).push(parentKey);
      }
    }
  }

  // Mark direct dependencies
  const rootDeps = dependencyTree?.__root__?.dependencies ?? {};
  for (const [name, version] of Object.entries(rootDeps)) {
    const key = `${name}@${version}`;
    if (nodes.has(key)) {
      nodes.get(key).isDirect = true;
    }
  }

  // Calculate exposure paths for each vulnerable package
  for (const [key, node] of nodes) {
    node.exposurePaths = findExposurePaths(key, edges, 10);
  }

  const summary = computeSummary(nodes);

  return { nodes, edges, summary };
}

/**
 * Find all paths from a vulnerable package up to root dependencies.
 * Limited to maxDepth to prevent excessive traversal.
 */
function findExposurePaths(startKey, edges, maxDepth) {
  const paths = [];
  const visited = new Set();

  function dfs(key, currentPath) {
    if (currentPath.length > maxDepth) return;
    if (visited.has(key)) return;
    visited.add(key);

    const dependents = edges.get(key) ?? [];
    if (dependents.length === 0) {
      // This is a root-level dependency
      paths.push([...currentPath]);
      return;
    }

    for (const dependent of dependents) {
      dfs(dependent, [...currentPath, dependent]);
    }

    visited.delete(key);
  }

  dfs(startKey, [startKey]);

  // Limit total paths to prevent explosion
  return paths.slice(0, 20);
}

/**
 * Get the highest severity among a list of vulnerabilities.
 */
function highestSeverity(vulns) {
  const order = ["critical", "high", "medium", "low", "unknown"];
  let highest = "unknown";

  for (const vuln of vulns) {
    const s = parseSeverity(vuln);
    if (order.indexOf(s) < order.indexOf(highest)) {
      highest = s;
    }
  }

  return highest;
}

/**
 * Calculate risk score for a package based on its vulnerabilities.
 * Score is 0-100.
 */
function calculatePackageRisk(vulns) {
  if (vulns.length === 0) return 0;

  let totalWeight = 0;
  for (const vuln of vulns) {
    const severity = parseSeverity(vuln);
    totalWeight += SEVERITY_WEIGHTS[severity] ?? 2;
  }

  // Normalize: one critical vuln = 50 risk, more vulns increase further
  return Math.min(100, Math.round((totalWeight / 10) * 50));
}

/**
 * Compute overall vulnerability summary.
 */
function computeSummary(nodes) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };
  let totalVulns = 0;
  let directVulnPackages = 0;
  let transitiveVulnPackages = 0;

  for (const [, node] of nodes) {
    totalVulns += node.vulns.length;
    for (const v of node.vulns) {
      counts[v.severity] = (counts[v.severity] ?? 0) + 1;
    }
    if (node.isDirect) directVulnPackages++;
    else transitiveVulnPackages++;
  }

  const overallRisk = calculateOverallRisk(nodes);

  return {
    totalVulnerabilities: totalVulns,
    affectedPackages: nodes.size,
    directVulnPackages,
    transitiveVulnPackages,
    severityCounts: counts,
    overallRiskScore: overallRisk,
    riskLevel: riskLevel(overallRisk)
  };
}

/**
 * Calculate overall project risk score (0-100).
 */
function calculateOverallRisk(nodes) {
  if (nodes.size === 0) return 0;

  let maxRisk = 0;
  let weightedSum = 0;

  for (const [, node] of nodes) {
    const risk = node.riskScore;
    if (risk > maxRisk) maxRisk = risk;
    // Direct dependencies have 2x weight
    weightedSum += node.isDirect ? risk * 2 : risk;
  }

  // Overall risk is weighted towards the maximum risk found
  return Math.min(100, Math.round(maxRisk * 0.6 + (weightedSum / nodes.size) * 0.4));
}

/**
 * Convert risk score to a human-readable level.
 */
function riskLevel(score) {
  if (score >= 80) return "critical";
  if (score >= 60) return "high";
  if (score >= 30) return "medium";
  if (score > 0) return "low";
  return "none";
}

/**
 * Generate upgrade suggestions for vulnerable packages.
 *
 * @param {VulnGraph} graph
 * @returns {Array<{name: string, currentVersion: string, fixedVersion: string|null, severity: string, vulnCount: number}>}
 */
export function suggestUpgrades(graph) {
  const suggestions = [];

  for (const [, node] of graph.nodes) {
    const fixedVersions = new Set();

    for (const vuln of node.vulns) {
      for (const range of vuln.ranges) {
        if (range.fixed) fixedVersions.add(range.fixed);
      }
    }

    // Pick the highest fixed version as recommendation
    const sortedFixed = [...fixedVersions].sort(compareSemver).reverse();

    suggestions.push({
      name: node.name,
      currentVersion: node.version,
      fixedVersion: sortedFixed[0] ?? null,
      severity: node.severity,
      vulnCount: node.vulns.length,
      isDirect: node.isDirect,
      exposureDepth: maxPathLength(node.exposurePaths)
    });
  }

  // Sort by severity (critical first), then by direct deps first
  const severityOrder = { critical: 0, high: 1, medium: 2, low: 3, unknown: 4 };
  suggestions.sort((a, b) => {
    const sa = severityOrder[a.severity] ?? 4;
    const sb = severityOrder[b.severity] ?? 4;
    if (sa !== sb) return sa - sb;
    if (a.isDirect !== b.isDirect) return a.isDirect ? -1 : 1;
    return b.vulnCount - a.vulnCount;
  });

  return suggestions;
}

/**
 * Basic semver comparison for sorting.
 */
function compareSemver(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va !== vb) return va - vb;
  }
  return 0;
}

/**
 * Get the max path length from exposure paths.
 */
function maxPathLength(paths) {
  if (!paths || paths.length === 0) return 0;
  return Math.max(...paths.map((p) => p.length));
}

/**
 * Format the vulnerability graph for JSON output.
 */
export function graphToJson(graph) {
  const vulnerabilities = [];

  for (const [key, node] of graph.nodes) {
    vulnerabilities.push({
      package: node.name,
      version: node.version,
      isDirect: node.isDirect,
      severity: node.severity,
      riskScore: node.riskScore,
      vulnerabilities: node.vulns.map(v => ({
        id: v.id,
        aliases: v.aliases,
        summary: v.summary,
        severity: v.severity,
        published: v.published,
        fixedVersions: v.ranges
          .filter(r => r.fixed)
          .map(r => r.fixed)
      })),
      exposurePaths: node.exposurePaths.map(p => p.join(" > "))
    });
  }

  return {
    summary: graph.summary,
    vulnerabilities,
    upgradeSuggestions: suggestUpgrades(graph)
  };
}

/**
 * Format exposure path for human-readable display.
 */
export function formatExposurePath(pathArray) {
  if (!pathArray || pathArray.length === 0) return "";
  if (pathArray.length === 1) return pathArray[0] + " (direct)";
  return pathArray.join(" > ");
}
