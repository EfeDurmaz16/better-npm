import { PackageManagerAdapter, InstallOptions } from './base.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export class YarnClassicAdapter extends PackageManagerAdapter {
  readonly name = 'yarn-classic';
  readonly lockfile = 'yarn.lock';

  async detect(): Promise<boolean> {
    const hasLockfile = fs.existsSync(path.join(this.cwd, 'yarn.lock'));
    if (!hasLockfile) return false;

    // Check it's NOT Berry (no .yarnrc.yml)
    const hasYarnrcYml = fs.existsSync(path.join(this.cwd, '.yarnrc.yml'));
    if (hasYarnrcYml) return false;

    // Check yarn version is 1.x
    const version = await this.getVersion();
    return version.startsWith('1.');
  }

  async getVersion(): Promise<string> {
    if (this.version) return this.version;

    const { execFileNoThrow } = await import('../utils/execFileNoThrow.js');
    const result = await execFileNoThrow('yarn', ['--version']);
    this.version = result.exitCode === 0 ? result.stdout.trim() : 'unknown';
    return this.version;
  }

  getInstallCommand(options: InstallOptions): string[] {
    const cmd = ['yarn'];

    if (options.frozen) {
      cmd.push('install', '--frozen-lockfile');
    } else {
      cmd.push('install');
    }

    if (options.production) {
      cmd.push('--production');
    }

    if (options.args) {
      cmd.push(...options.args);
    }

    return cmd;
  }

  getCachePath(): string {
    if (process.env['YARN_CACHE_FOLDER']) {
      return process.env['YARN_CACHE_FOLDER'];
    }

    // Default yarn cache location
    const platform = os.platform();
    if (platform === 'darwin') {
      return path.join(os.homedir(), 'Library', 'Caches', 'Yarn');
    }
    if (platform === 'win32') {
      return path.join(process.env['LOCALAPPDATA'] ?? os.homedir(), 'Yarn', 'Cache');
    }
    return path.join(os.homedir(), '.cache', 'yarn');
  }
}
