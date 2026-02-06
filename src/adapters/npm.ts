import { PackageManagerAdapter, InstallOptions } from './base.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export class NpmAdapter extends PackageManagerAdapter {
  readonly name = 'npm';
  readonly lockfile = 'package-lock.json';

  async detect(): Promise<boolean> {
    // Check for package-lock.json or npm-shrinkwrap.json
    const hasPackageLock = fs.existsSync(path.join(this.cwd, 'package-lock.json'));
    const hasShrinkwrap = fs.existsSync(path.join(this.cwd, 'npm-shrinkwrap.json'));

    if (!hasPackageLock && !hasShrinkwrap) {
      return false;
    }

    // Verify npm is installed
    return this.commandExists('npm');
  }

  async getVersion(): Promise<string> {
    if (this.version) return this.version;

    const { execFileNoThrow } = await import('../utils/execFileNoThrow.js');
    const result = await execFileNoThrow('npm', ['--version']);
    this.version = result.exitCode === 0 ? result.stdout.trim() : 'unknown';
    return this.version;
  }

  getInstallCommand(options: InstallOptions): string[] {
    const cmd = ['npm'];

    if (options.frozen) {
      cmd.push('ci');
    } else {
      cmd.push('install');
    }

    if (options.production) {
      cmd.push('--omit=dev');
    }

    if (options.args) {
      cmd.push(...options.args);
    }

    return cmd;
  }

  getCachePath(): string {
    // npm cache is at ~/.npm
    if (process.env['npm_config_cache']) {
      return process.env['npm_config_cache'];
    }
    return path.join(os.homedir(), '.npm');
  }
}
