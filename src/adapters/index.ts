import { PackageManagerAdapter } from './base.js';
import { NpmAdapter } from './npm.js';
import { PnpmAdapter } from './pnpm.js';
import { YarnClassicAdapter } from './yarn-classic.js';
import { YarnBerryAdapter } from './yarn-berry.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

export { PackageManagerAdapter, ExecResult, InstallOptions } from './base.js';
export { NpmAdapter } from './npm.js';
export { PnpmAdapter } from './pnpm.js';
export { YarnClassicAdapter } from './yarn-classic.js';
export { YarnBerryAdapter } from './yarn-berry.js';

export type PackageManagerName = 'npm' | 'pnpm' | 'yarn-classic' | 'yarn-berry';

// Detect and return the appropriate adapter
export async function detectPackageManager(cwd: string = process.cwd()): Promise<PackageManagerAdapter> {
  // Check package.json#packageManager first
  const pkgPath = path.join(cwd, 'package.json');
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    if (pkg.packageManager) {
      const pm = parsePackageManager(pkg.packageManager);
      if (pm) {
        const adapter = createAdapter(pm, cwd);
        if (await adapter.detect()) {
          return adapter;
        }
      }
    }
  }

  // Try detection in order of specificity
  // pnpm first (has unique lockfile)
  const pnpm = new PnpmAdapter(cwd);
  if (await pnpm.detect()) return pnpm;

  // Yarn Berry before Classic (has .yarnrc.yml)
  const yarnBerry = new YarnBerryAdapter(cwd);
  if (await yarnBerry.detect()) return yarnBerry;

  // Yarn Classic
  const yarnClassic = new YarnClassicAdapter(cwd);
  if (await yarnClassic.detect()) return yarnClassic;

  // npm last (most common fallback)
  const npm = new NpmAdapter(cwd);
  if (await npm.detect()) return npm;

  // Default to npm if nothing detected
  return npm;
}

function parsePackageManager(value: string): PackageManagerName | null {
  // Format: "npm@9.0.0" or "pnpm@8.0.0" or "yarn@3.0.0"
  const match = value.match(/^(npm|pnpm|yarn)@/);
  if (!match) return null;

  const name = match[1];
  if (name === 'yarn') {
    // Need to determine Classic vs Berry from version
    const versionMatch = value.match(/@(\d+)/);
    const major = parseInt(versionMatch?.[1] ?? '1', 10);
    return major >= 2 ? 'yarn-berry' : 'yarn-classic';
  }

  return name as PackageManagerName;
}

function createAdapter(name: PackageManagerName, cwd: string): PackageManagerAdapter {
  switch (name) {
    case 'npm':
      return new NpmAdapter(cwd);
    case 'pnpm':
      return new PnpmAdapter(cwd);
    case 'yarn-classic':
      return new YarnClassicAdapter(cwd);
    case 'yarn-berry':
      return new YarnBerryAdapter(cwd);
  }
}
