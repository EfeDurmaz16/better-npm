import * as fs from 'node:fs';
import * as path from 'node:path';

export interface DirectoryEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

export interface SizeResult {
  logicalSize: number;
  physicalSize: number;
  fileCount: number;
}

/**
 * Scans a directory and returns all entries (non-recursive by default)
 */
export async function scanDirectory(dirPath: string, recursive = false): Promise<DirectoryEntry[]> {
  try {
    if (!fs.existsSync(dirPath)) {
      return [];
    }

    const entries: DirectoryEntry[] = [];
    const items = await fs.promises.readdir(dirPath, { withFileTypes: true });

    for (const item of items) {
      const fullPath = path.join(dirPath, item.name);
      entries.push({
        name: item.name,
        path: fullPath,
        isDirectory: item.isDirectory(),
      });

      if (recursive && item.isDirectory()) {
        const subEntries = await scanDirectory(fullPath, true);
        entries.push(...subEntries);
      }
    }

    return entries;
  } catch (error) {
    // Directory doesn't exist or is inaccessible
    return [];
  }
}

/**
 * Counts packages in node_modules by counting directories
 */
export async function countPackages(nodeModulesPath: string): Promise<number> {
  try {
    if (!fs.existsSync(nodeModulesPath)) {
      return 0;
    }

    let count = 0;
    const entries = await fs.promises.readdir(nodeModulesPath, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name.startsWith('@')) {
          // Scoped package - count subdirectories
          const scopePath = path.join(nodeModulesPath, entry.name);
          const scopedPackages = await fs.promises.readdir(scopePath, { withFileTypes: true });
          count += scopedPackages.filter(e => e.isDirectory()).length;
        } else if (entry.name !== '.bin' && entry.name !== '.cache') {
          count++;
        }
      }
    }

    return count;
  } catch (error) {
    return 0;
  }
}

/**
 * Calculates both logical and physical size of a directory
 * - Logical size: sum of all file sizes (counts hardlinks multiple times)
 * - Physical size: sum of unique inodes (counts hardlinks once)
 */
export async function calculateSize(dirPath: string): Promise<SizeResult> {
  const hardlinkTracker = new Map<string, boolean>();
  let logicalSize = 0;
  let physicalSize = 0;
  let fileCount = 0;

  async function scanDir(dir: string): Promise<void> {
    try {
      if (!fs.existsSync(dir)) {
        return;
      }

      const entries = await fs.promises.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          await scanDir(fullPath);
        } else if (entry.isFile() || entry.isSymbolicLink()) {
          try {
            const stats = await fs.promises.stat(fullPath);
            fileCount++;
            logicalSize += stats.size;

            // Track hardlinks via inode+dev
            const key = `${stats.dev}:${stats.ino}`;
            if (!hardlinkTracker.has(key)) {
              hardlinkTracker.set(key, true);
              physicalSize += stats.size;
            }
          } catch {
            // Skip files we can't stat
          }
        }
      }
    } catch (error) {
      // Skip directories we can't read
    }
  }

  await scanDir(dirPath);

  return {
    logicalSize,
    physicalSize,
    fileCount,
  };
}

/**
 * Counts packages from a lockfile
 */
export function countLockfilePackages(lockfilePath: string): number {
  try {
    if (!fs.existsSync(lockfilePath)) {
      return 0;
    }

    const content = fs.readFileSync(lockfilePath, 'utf-8');
    const filename = path.basename(lockfilePath);

    if (filename === 'package-lock.json') {
      // npm lockfile - count packages in "packages" object (v2+) or "dependencies" (v1)
      const lockfile = JSON.parse(content);
      if (lockfile.packages) {
        // v2+ format: packages object, exclude the root ""
        return Object.keys(lockfile.packages).filter(key => key !== '').length;
      } else if (lockfile.dependencies) {
        // v1 format: count dependencies recursively
        return countDependenciesRecursive(lockfile.dependencies);
      }
      return 0;
    } else if (filename === 'pnpm-lock.yaml') {
      // pnpm lockfile - count entries in packages section
      const packagesMatch = content.match(/^packages:/m);
      if (!packagesMatch) return 0;

      // Count lines that start with two spaces followed by a package reference
      // These are in the format: "  '@scope/package@version':" or "  /package@version:"
      const packageLines = content.split('\n').filter(line =>
        /^  ['"]?[@/]/.test(line) && line.includes(':')
      );
      return packageLines.length;
    } else if (filename === 'yarn.lock') {
      // yarn lockfile - count package entries (lines ending with :)
      // Format: "package@version:", "package@npm:version:", etc.
      const entries = content.split('\n').filter(line =>
        /^[^#\s].*:$/.test(line.trim()) && !line.includes('"')
      );
      return entries.length;
    }

    return 0;
  } catch (error) {
    return 0;
  }
}

function countDependenciesRecursive(deps: Record<string, any>): number {
  let count = Object.keys(deps).length;
  for (const dep of Object.values(deps)) {
    if (dep.dependencies) {
      count += countDependenciesRecursive(dep.dependencies);
    }
  }
  return count;
}

/**
 * Formats bytes to human-readable string
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';

  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}
