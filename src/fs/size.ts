import { scanDirectory, type ScanOptions } from './scanner.js';
import { HardlinkTracker } from './hardlinks.js';

export interface SizeResult {
  logicalSize: number;
  physicalSize: number;
  fileCount: number;
  directoryCount: number;
}

/**
 * Calculate both logical and physical size of a directory
 * - Logical size: sum of all file sizes (counts hardlinks multiple times)
 * - Physical size: sum of unique inodes (counts hardlinks once)
 */
export function calculateSize(dir: string, options?: ScanOptions): SizeResult {
  let logicalSize = 0;
  let physicalSize = 0;
  let fileCount = 0;
  let directoryCount = 0;

  const hardlinkTracker = new HardlinkTracker();

  for (const file of scanDirectory(dir, options)) {
    if (file.isDirectory) {
      directoryCount++;
    } else {
      fileCount++;
      logicalSize += file.size;

      // Only count physical size for first occurrence of each inode
      if (hardlinkTracker.isFirstOccurrence(file.ino, file.dev)) {
        physicalSize += file.size;
      }
    }
  }

  return {
    logicalSize,
    physicalSize,
    fileCount,
    directoryCount,
  };
}

/**
 * Format bytes into human-readable string
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${units[i]}`;
}
