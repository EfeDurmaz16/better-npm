import * as os from 'node:os';
import * as path from 'node:path';

export function getCacheRoot(): string {
  const platform = os.platform();

  // Check XDG_CACHE_HOME first (Linux standard)
  if (process.env['XDG_CACHE_HOME']) {
    return path.join(process.env['XDG_CACHE_HOME'], 'better');
  }

  switch (platform) {
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Caches', 'better');
    case 'win32':
      return path.join(process.env['LOCALAPPDATA'] ?? os.homedir(), 'better', 'cache');
    default:
      // Linux and others
      return path.join(os.homedir(), '.cache', 'better');
  }
}

export function getConfigRoot(): string {
  const platform = os.platform();

  if (process.env['XDG_CONFIG_HOME']) {
    return path.join(process.env['XDG_CONFIG_HOME'], 'better');
  }

  switch (platform) {
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support', 'better');
    case 'win32':
      return path.join(process.env['APPDATA'] ?? os.homedir(), 'better');
    default:
      return path.join(os.homedir(), '.config', 'better');
  }
}

export function getDataRoot(): string {
  const platform = os.platform();

  if (process.env['XDG_DATA_HOME']) {
    return path.join(process.env['XDG_DATA_HOME'], 'better');
  }

  switch (platform) {
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support', 'better', 'data');
    case 'win32':
      return path.join(process.env['LOCALAPPDATA'] ?? os.homedir(), 'better', 'data');
    default:
      return path.join(os.homedir(), '.local', 'share', 'better');
  }
}

export function ensureDir(dir: string): void {
  const fs = require('node:fs');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  }
}
