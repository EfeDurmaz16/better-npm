import { DependencyGraph, DependencyNode } from './graph.js';

export interface VersionInfo {
  version: string;
  count: number;
  paths: string[];
  size: number;
}

export interface DuplicateReport {
  package: string;
  versions: VersionInfo[];
  totalInstances: number;
  wastedBytes: number;
  suggestedVersion: string;
}

export interface DuplicateAnalysis {
  duplicates: DuplicateReport[];
  totalWastedBytes: number;
  totalDuplicatePackages: number;
}

/**
 * Compares two semver version strings
 * Returns: negative if a < b, 0 if equal, positive if a > b
 */
function compareVersions(a: string, b: string): number {
  const aParts = a.split('.').map(p => parseInt(p, 10) || 0);
  const bParts = b.split('.').map(p => parseInt(p, 10) || 0);

  const maxLength = Math.max(aParts.length, bParts.length);

  for (let i = 0; i < maxLength; i++) {
    const aVal = aParts[i] || 0;
    const bVal = bParts[i] || 0;

    if (aVal !== bVal) {
      return aVal - bVal;
    }
  }

  return 0;
}

/**
 * Detect duplicate packages in dependency graph
 * Groups packages by name and identifies multiple versions
 */
export function detectDuplicates(graph: DependencyGraph): DuplicateAnalysis {
  // Map: packageName -> DependencyNode[]
  const packagesByName = new Map<string, DependencyNode[]>();

  // Group packages by name
  for (const node of graph.packages.values()) {
    const existing = packagesByName.get(node.name) || [];
    existing.push(node);
    packagesByName.set(node.name, existing);
  }

  const duplicates: DuplicateReport[] = [];
  let totalWastedBytes = 0;

  // Process packages with multiple versions
  for (const [packageName, nodes] of packagesByName.entries()) {
    // Group by version to get counts
    const versionMap = new Map<string, DependencyNode[]>();

    for (const node of nodes) {
      const existing = versionMap.get(node.version) || [];
      existing.push(node);
      versionMap.set(node.version, existing);
    }

    // Only report if there are multiple unique versions
    if (versionMap.size > 1) {
      const versions: VersionInfo[] = [];
      let totalSize = 0;
      let maxSize = 0;
      let totalInstances = 0;

      // Build version info
      for (const [version, versionNodes] of versionMap.entries()) {
        const versionSize = versionNodes.reduce((sum, n) => sum + n.size, 0);
        const count = versionNodes.length;

        versions.push({
          version,
          count,
          paths: versionNodes.map(n => n.path),
          size: versionSize,
        });

        totalSize += versionSize;
        maxSize = Math.max(maxSize, versionSize / count); // Average size per instance
        totalInstances += count;
      }

      // Sort versions by semver (highest first)
      versions.sort((a, b) => compareVersions(b.version, a.version));

      // Suggested version is the highest semver version
      const suggestedVersion = versions[0]?.version || '';

      // Wasted space calculation:
      // If we had only one version, we'd have maxSize * totalInstances
      // But we have totalSize, so wasted = totalSize - maxSize
      // Better: wasted = sum of all but the largest single instance size
      const singleInstanceSize = Math.max(...versions.map(v => v.size / v.count));
      const wastedBytes = Math.round(totalSize - singleInstanceSize);

      duplicates.push({
        package: packageName,
        versions,
        totalInstances,
        wastedBytes: Math.max(0, wastedBytes),
        suggestedVersion,
      });

      totalWastedBytes += Math.max(0, wastedBytes);
    }
  }

  // Sort duplicates by wasted bytes descending (highest impact first)
  duplicates.sort((a, b) => b.wastedBytes - a.wastedBytes);

  return {
    duplicates,
    totalWastedBytes,
    totalDuplicatePackages: duplicates.length,
  };
}
