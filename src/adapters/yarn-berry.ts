import { PackageManagerAdapter, InstallOptions } from './base.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export class YarnBerryAdapter extends PackageManagerAdapter {
  readonly name = 'yarn-berry';
  readonly lockfile = 'yarn.lock';

  async detect(): Promise<boolean> {
    const hasLockfile = fs.existsSync(path.join(this.cwd, 'yarn.lock'));
    if (!hasLockfile) return false;

    // Check for .yarnrc.yml (Berry indicator)
    const hasYarnrcYml = fs.existsSync(path.join(this.cwd, '.yarnrc.yml'));
    if (hasYarnrcYml) return true;

    // Or check version is 2+
    const version = await this.getVersion();
    const major = parseInt(version.split('.')[0] ?? '0', 10);
    return major >= 2;
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
      cmd.push('install', '--immutable');
    } else {
      cmd.push('install');
    }

    // Note: Berry doesn't have a --production flag in the same way
    // It uses different mechanisms (plugins, etc.)

    if (options.args) {
      cmd.push(...options.args);
    }

    return cmd;
  }

  getCachePath(): string {
    // Berry uses cacheFolder in .yarnrc.yml, or global cache
    // Try to read from .yarnrc.yml
    const yarnrcPath = path.join(this.cwd, '.yarnrc.yml');
    if (fs.existsSync(yarnrcPath)) {
      const content = fs.readFileSync(yarnrcPath, 'utf-8');
      const match = content.match(/cacheFolder:\s*(.+)/);
      if (match?.[1]) {
        return match[1].trim();
      }
    }

    // Default global cache
    if (process.env['YARN_CACHE_FOLDER']) {
      return process.env['YARN_CACHE_FOLDER'];
    }

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
