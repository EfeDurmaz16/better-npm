import { PackageManagerAdapter, InstallOptions } from './base.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export class PnpmAdapter extends PackageManagerAdapter {
  readonly name = 'pnpm';
  readonly lockfile = 'pnpm-lock.yaml';

  async detect(): Promise<boolean> {
    const hasLockfile = fs.existsSync(path.join(this.cwd, 'pnpm-lock.yaml'));
    if (!hasLockfile) return false;
    return this.commandExists('pnpm');
  }

  async getVersion(): Promise<string> {
    if (this.version) return this.version;

    const { execFileNoThrow } = await import('../utils/execFileNoThrow.js');
    const result = await execFileNoThrow('pnpm', ['--version']);
    this.version = result.exitCode === 0 ? result.stdout.trim() : 'unknown';
    return this.version;
  }

  getInstallCommand(options: InstallOptions): string[] {
    const cmd = ['pnpm', 'install'];

    if (options.frozen) {
      cmd.push('--frozen-lockfile');
    }

    if (options.production) {
      cmd.push('--prod');
    }

    if (options.args) {
      cmd.push(...options.args);
    }

    return cmd;
  }

  getCachePath(): string {
    // pnpm store directory
    if (process.env['PNPM_HOME']) {
      return path.join(process.env['PNPM_HOME'], 'store');
    }

    // Default locations
    const platform = os.platform();
    if (platform === 'win32') {
      return path.join(process.env['LOCALAPPDATA'] ?? os.homedir(), 'pnpm', 'store');
    }
    return path.join(os.homedir(), '.local', 'share', 'pnpm', 'store');
  }
}
