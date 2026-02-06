import * as fs from 'node:fs';
import * as path from 'node:path';
import { getCacheManager, type CacheEntry } from './manager.js';
import { getLogger } from '../observability/logger.js';

export interface GCOptions {
  maxAge?: number | undefined; // milliseconds, default 30 days
  dryRun?: boolean | undefined;
}

export interface GCResult {
  entriesRemoved: number;
  bytesFreed: number;
  entries: { path: string; size: number; age: number }[];
}

interface OldEntry {
  path: string;
  size: number;
  createdAt: Date;
}

async function findOldEntries(
  dir: string,
  maxAge: number,
  now: number
): Promise<OldEntry[]> {
  const oldEntries: OldEntry[] = [];

  if (!fs.existsSync(dir)) return oldEntries;

  const items = fs.readdirSync(dir, { withFileTypes: true });

  for (const item of items) {
    const fullPath = path.join(dir, item.name);

    if (item.isDirectory()) {
      // Check if this is a package version directory (leaf node)
      const hasFiles = fs
        .readdirSync(fullPath, { withFileTypes: true })
        .some((subItem) => subItem.isFile());

      if (hasFiles) {
        // This is a package version directory
        const stat = fs.statSync(fullPath);
        const age = now - stat.birthtime.getTime();

        if (age > maxAge) {
          // Calculate directory size
          const size = getDirectorySize(fullPath);
          oldEntries.push({
            path: fullPath,
            size,
            createdAt: stat.birthtime,
          });
        }
      } else {
        // Recurse into package name directories
        const subEntries = await findOldEntries(fullPath, maxAge, now);
        oldEntries.push(...subEntries);
      }
    }
  }

  return oldEntries;
}

function getDirectorySize(dir: string): number {
  let size = 0;

  const items = fs.readdirSync(dir, { withFileTypes: true });

  for (const item of items) {
    const fullPath = path.join(dir, item.name);

    if (item.isDirectory()) {
      size += getDirectorySize(fullPath);
    } else if (item.isFile()) {
      const stat = fs.statSync(fullPath);
      size += stat.size;
    }
  }

  return size;
}

export async function runGarbageCollection(
  options: GCOptions = {}
): Promise<GCResult> {
  const logger = getLogger();
  const cache = getCacheManager();
  const maxAge = options.maxAge ?? 30 * 24 * 60 * 60 * 1000; // 30 days
  const now = Date.now();

  await cache.initialize();

  const packagesDir = cache.getPath('packages');

  const result: GCResult = {
    entriesRemoved: 0,
    bytesFreed: 0,
    entries: [],
  };

  // Scan for old entries
  const oldEntries = await findOldEntries(packagesDir, maxAge, now);

  for (const entry of oldEntries) {
    result.entries.push({
      path: entry.path,
      size: entry.size,
      age: now - entry.createdAt.getTime(),
    });
    result.bytesFreed += entry.size;

    if (!options.dryRun) {
      fs.rmSync(entry.path, { recursive: true, force: true });
      result.entriesRemoved++;
    }
  }

  if (options.dryRun) {
    logger.info('Dry run - no files removed', { wouldRemove: oldEntries.length });
  } else {
    logger.info('Garbage collection complete', { removed: result.entriesRemoved });
  }

  return result;
}
