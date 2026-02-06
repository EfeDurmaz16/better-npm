import * as fs from 'node:fs';
import * as path from 'node:path';
import { getCacheRoot } from '../utils/paths.js';
import { getLogger } from '../observability/logger.js';

export interface CacheConfig {
  root: string;
}

export interface CacheEntry {
  key: string;
  path: string;
  size: number;
  createdAt: Date;
  accessedAt: Date;
}

export class CacheManager {
  private root: string;
  private initialized: boolean = false;

  constructor(config?: Partial<CacheConfig>) {
    this.root = config?.root ?? getCacheRoot();
  }

  // Ensure cache directory structure exists
  async initialize(): Promise<void> {
    if (this.initialized) return;

    const logger = getLogger();
    const dirs = [
      this.root,
      path.join(this.root, 'packages'),
      path.join(this.root, 'metadata'),
      path.join(this.root, 'tmp'),
    ];

    for (const dir of dirs) {
      if (!fs.existsSync(dir)) {
        logger.debug('Creating cache directory', { path: dir });
        fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
      }
    }

    this.initialized = true;
    logger.info('Cache initialized', { root: this.root });
  }

  // Get the root cache directory
  getRoot(): string {
    return this.root;
  }

  // Get path for a specific cache type
  getPath(type: 'packages' | 'metadata' | 'tmp', ...parts: string[]): string {
    return path.join(this.root, type, ...parts);
  }

  // Get path for a package in cache
  getPackagePath(name: string, version: string): string {
    // Use scoped package handling
    const safeName = name.replace(/\//g, '+');
    return this.getPath('packages', safeName, version);
  }

  // Check if a package is cached
  async hasPackage(name: string, version: string): Promise<boolean> {
    const pkgPath = this.getPackagePath(name, version);
    return fs.existsSync(pkgPath);
  }

  // Get cache stats
  async getStats(): Promise<CacheStats> {
    await this.initialize();

    const packagesDir = this.getPath('packages');
    const stats: CacheStats = {
      root: this.root,
      totalSize: 0,
      packageCount: 0,
      oldestEntry: null,
      newestEntry: null,
    };

    if (!fs.existsSync(packagesDir)) {
      return stats;
    }

    const entries = await this.scanDirectory(packagesDir);
    stats.packageCount = entries.length;
    stats.totalSize = entries.reduce((sum, e) => sum + e.size, 0);

    if (entries.length > 0) {
      entries.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      stats.oldestEntry = entries[0]!.createdAt;
      stats.newestEntry = entries[entries.length - 1]!.createdAt;
    }

    return stats;
  }

  // Scan a directory recursively for cache entries
  private async scanDirectory(dir: string): Promise<CacheEntry[]> {
    const entries: CacheEntry[] = [];

    if (!fs.existsSync(dir)) return entries;

    const items = fs.readdirSync(dir, { withFileTypes: true });

    for (const item of items) {
      const fullPath = path.join(dir, item.name);

      if (item.isDirectory()) {
        // Recurse into subdirectories
        const subEntries = await this.scanDirectory(fullPath);
        entries.push(...subEntries);
      } else if (item.isFile()) {
        const stat = fs.statSync(fullPath);
        entries.push({
          key: path.relative(this.root, fullPath),
          path: fullPath,
          size: stat.size,
          createdAt: stat.birthtime,
          accessedAt: stat.atime,
        });
      }
    }

    return entries;
  }

  // Clean up temporary files
  async cleanTmp(): Promise<number> {
    const tmpDir = this.getPath('tmp');
    if (!fs.existsSync(tmpDir)) return 0;

    let cleaned = 0;
    const items = fs.readdirSync(tmpDir);

    for (const item of items) {
      const fullPath = path.join(tmpDir, item);
      fs.rmSync(fullPath, { recursive: true, force: true });
      cleaned++;
    }

    return cleaned;
  }
}

export interface CacheStats {
  root: string;
  totalSize: number;
  packageCount: number;
  oldestEntry: Date | null;
  newestEntry: Date | null;
}

// Singleton instance
let cacheManager: CacheManager | null = null;

export function getCacheManager(config?: Partial<CacheConfig>): CacheManager {
  if (!cacheManager) {
    cacheManager = new CacheManager(config);
  }
  return cacheManager;
}

export function setCacheManager(manager: CacheManager): void {
  cacheManager = manager;
}
