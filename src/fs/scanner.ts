import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface ScanOptions {
  excludeDirs?: string[];
  followSymlinks?: boolean;
}

export interface FileInfo {
  path: string;
  size: number;
  isDirectory: boolean;
  isSymlink: boolean;
  ino: number;
  dev: number;
}

/**
 * Recursively scan a directory and yield all files
 */
export function* scanDirectory(
  dir: string,
  options: ScanOptions = {}
): Generator<FileInfo> {
  const { excludeDirs = ['.git', '.DS_Store'], followSymlinks = false } = options;

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    // Skip directories we can't read
    return;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    if (excludeDirs.includes(entry.name)) {
      continue;
    }

    let stat;
    try {
      stat = statSync(fullPath, { bigint: false });
    } catch (err) {
      // Skip files we can't stat
      continue;
    }

    const isSymlink = entry.isSymbolicLink();

    if (stat.isDirectory()) {
      yield {
        path: fullPath,
        size: 0,
        isDirectory: true,
        isSymlink,
        ino: stat.ino,
        dev: stat.dev,
      };

      // Recurse into directory unless it's a symlink and we're not following them
      if (!isSymlink || followSymlinks) {
        yield* scanDirectory(fullPath, options);
      }
    } else if (stat.isFile()) {
      yield {
        path: fullPath,
        size: stat.size,
        isDirectory: false,
        isSymlink,
        ino: stat.ino,
        dev: stat.dev,
      };
    }
  }
}
