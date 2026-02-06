import * as fs from 'node:fs';
import * as path from 'node:path';
import { DependencyGraph } from './graph.js';

export interface DeprecatedPackage {
  name: string;
  version: string;
  path: string;
  deprecationMessage: string;
  dependedOnBy: string[];  // packages that depend on this
}

export interface DeprecationReport {
  deprecatedPackages: DeprecatedPackage[];
  totalDeprecated: number;
}

export function detectDeprecated(graph: DependencyGraph, rootDir: string): DeprecationReport {
  const deprecatedPackages: DeprecatedPackage[] = [];
  const deprecatedMap = new Map<string, DeprecatedPackage>();

  // Iterate through all packages in the graph
  for (const [packageId, node] of graph.packages.entries()) {
    const packageJsonPath = path.join(node.path, 'package.json');

    // Check if package.json exists
    if (!fs.existsSync(packageJsonPath)) {
      continue;
    }

    try {
      // Read and parse package.json
      const packageJsonContent = fs.readFileSync(packageJsonPath, 'utf-8');
      const packageJson = JSON.parse(packageJsonContent);

      // Check for deprecated field
      if (packageJson.deprecated) {
        // Handle both string and boolean deprecated fields
        const deprecationMessage = typeof packageJson.deprecated === 'string'
          ? packageJson.deprecated
          : 'This package is deprecated';

        const deprecatedPackage: DeprecatedPackage = {
          name: node.name,
          version: node.version,
          path: node.path,
          deprecationMessage,
          dependedOnBy: []
        };

        deprecatedMap.set(packageId, deprecatedPackage);
      }
    } catch (error) {
      // Silently skip if package.json can't be read or parsed
      continue;
    }
  }

  // Find which packages depend on deprecated ones
  for (const [packageId, deprecatedPkg] of deprecatedMap.entries()) {
    // Check all packages to find dependents
    for (const [dependerPackageId, dependerNode] of graph.packages.entries()) {
      // Check if this package depends on the deprecated package
      if (dependerNode.dependencies.includes(packageId)) {
        const dependerIdentifier = `${dependerNode.name}@${dependerNode.version}`;
        deprecatedPkg.dependedOnBy.push(dependerIdentifier);
      }
    }

    // Also check if root directly depends on this deprecated package
    if (graph.root.dependencies.includes(packageId)) {
      deprecatedPkg.dependedOnBy.push('root');
    }

    deprecatedPackages.push(deprecatedPkg);
  }

  return {
    deprecatedPackages,
    totalDeprecated: deprecatedPackages.length
  };
}
