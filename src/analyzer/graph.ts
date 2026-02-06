import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { calculateSize } from '../fs/size.js';

export interface DependencyNode {
  name: string;
  version: string;
  path: string;
  size: number;
  dependencies: string[]; // package@version identifiers
  isDirect: boolean;
}

export interface DependencyGraph {
  root: {
    name: string;
    version: string;
    path: string;
    dependencies: string[]; // direct dependency package@version identifiers
  };
  packages: Map<string, DependencyNode>; // key: package@version
  totalPackages: number;
}

interface PackageJson {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

function readPackageJson(path: string): PackageJson | null {
  try {
    const content = readFileSync(path, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function getPackageSize(packagePath: string): number {
  try {
    const sizeResult = calculateSize(packagePath, {
      excludeDirs: ['.git', '.DS_Store', 'node_modules'],
    });
    return sizeResult.physicalSize;
  } catch {
    return 0;
  }
}

function findPackageJsonUp(startPath: string): string | null {
  let currentPath = startPath;
  while (currentPath !== dirname(currentPath)) {
    const pkgPath = join(currentPath, 'package.json');
    if (existsSync(pkgPath)) {
      return pkgPath;
    }
    currentPath = dirname(currentPath);
  }
  return null;
}

export function buildDependencyGraph(nodeModulesPath: string): DependencyGraph {
  const packages = new Map<string, DependencyNode>();

  // Find root package.json (go up from node_modules to project root)
  const projectRoot = dirname(nodeModulesPath);
  const rootPkgPath = join(projectRoot, 'package.json');
  const rootPkg = readPackageJson(rootPkgPath);

  if (!rootPkg) {
    throw new Error(`Could not find package.json at ${rootPkgPath}`);
  }

  // Collect all direct dependencies from root
  const rootDirectDeps = new Set<string>();
  const allRootDeps = {
    ...rootPkg.dependencies,
    ...rootPkg.devDependencies,
  };

  // Recursively walk node_modules
  function walkNodeModules(nmPath: string, visited = new Set<string>()) {
    if (!existsSync(nmPath)) {
      return;
    }

    // Avoid infinite loops from circular symlinks
    const realPath = resolve(nmPath);
    if (visited.has(realPath)) {
      return;
    }
    visited.add(realPath);

    let entries;
    try {
      entries = readdirSync(nmPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const entryPath = join(nmPath, entry.name);

      // Handle scoped packages (@org/package)
      if (entry.isDirectory() && entry.name.startsWith('@')) {
        let scopedEntries;
        try {
          scopedEntries = readdirSync(entryPath, { withFileTypes: true });
        } catch {
          continue;
        }

        for (const scopedEntry of scopedEntries) {
          if (scopedEntry.isDirectory()) {
            const scopedPkgPath = join(entryPath, scopedEntry.name);
            processPackage(scopedPkgPath, visited);
          }
        }
      } else if (entry.isDirectory()) {
        processPackage(entryPath, visited);
      }
    }
  }

  function processPackage(packagePath: string, visited: Set<string>) {
    const pkgJsonPath = join(packagePath, 'package.json');
    const pkg = readPackageJson(pkgJsonPath);

    if (!pkg) {
      return;
    }

    const packageKey = `${pkg.name}@${pkg.version}`;

    // Skip if already processed
    if (packages.has(packageKey)) {
      return;
    }

    // Get dependencies from this package
    const deps = pkg.dependencies || {};
    const depsList: string[] = [];

    // For each dependency, try to resolve its version
    for (const depName of Object.keys(deps)) {
      // Try to find the actual installed version
      const resolvedVersion = resolveInstalledVersion(depName, packagePath);
      if (resolvedVersion) {
        depsList.push(`${depName}@${resolvedVersion}`);
      }
    }

    // Check if this is a direct dependency
    const isDirect = allRootDeps.hasOwnProperty(pkg.name);

    // Calculate package size
    const size = getPackageSize(packagePath);

    packages.set(packageKey, {
      name: pkg.name,
      version: pkg.version,
      path: packagePath,
      size,
      dependencies: depsList,
      isDirect,
    });

    if (isDirect) {
      rootDirectDeps.add(packageKey);
    }

    // Walk nested node_modules
    const nestedNm = join(packagePath, 'node_modules');
    if (existsSync(nestedNm)) {
      walkNodeModules(nestedNm, visited);
    }
  }

  function resolveInstalledVersion(packageName: string, fromPath: string): string | null {
    // Try to find the package in node_modules hierarchy
    let currentPath = fromPath;

    while (currentPath !== dirname(currentPath)) {
      const nmPath = join(currentPath, 'node_modules');
      const packagePath = packageName.startsWith('@')
        ? join(nmPath, packageName)
        : join(nmPath, packageName);

      const pkgJsonPath = join(packagePath, 'package.json');

      if (existsSync(pkgJsonPath)) {
        const pkg = readPackageJson(pkgJsonPath);
        if (pkg && pkg.version) {
          return pkg.version;
        }
      }

      currentPath = dirname(currentPath);
    }

    return null;
  }

  // Start walking from the main node_modules
  walkNodeModules(nodeModulesPath);

  return {
    root: {
      name: rootPkg.name,
      version: rootPkg.version,
      path: projectRoot,
      dependencies: Array.from(rootDirectDeps),
    },
    packages,
    totalPackages: packages.size,
  };
}
