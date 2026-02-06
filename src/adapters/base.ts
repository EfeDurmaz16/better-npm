export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  duration: number; // ms
}

export interface InstallOptions {
  frozen?: boolean;
  production?: boolean;
  args?: string[];
}

export abstract class PackageManagerAdapter {
  abstract readonly name: string;
  abstract readonly lockfile: string;

  protected version: string = '';
  protected cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  // Check if this adapter applies to the current directory
  abstract detect(): Promise<boolean>;

  // Get the version of this package manager
  abstract getVersion(): Promise<string>;

  // Build the install command
  abstract getInstallCommand(options: InstallOptions): string[];

  // Get the cache directory for this PM
  abstract getCachePath(): string;

  // Run the install command
  async install(options: InstallOptions = {}): Promise<ExecResult> {
    const cmd = this.getInstallCommand(options);
    return this.exec(cmd);
  }

  // Execute a command
  protected async exec(args: string[]): Promise<ExecResult> {
    const { spawn } = await import('node:child_process');
    const start = performance.now();

    return new Promise((resolve) => {
      const proc = spawn(args[0]!, args.slice(1), {
        cwd: this.cwd,
        stdio: ['inherit', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
      });

      let stdout = '';
      let stderr = '';

      proc.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        resolve({
          exitCode: code ?? 1,
          stdout,
          stderr,
          duration: Math.round(performance.now() - start),
        });
      });

      proc.on('error', (err) => {
        resolve({
          exitCode: 1,
          stdout,
          stderr: err.message,
          duration: Math.round(performance.now() - start),
        });
      });
    });
  }

  // Check if a command exists
  protected async commandExists(cmd: string): Promise<boolean> {
    const { execFileNoThrow } = await import('../utils/execFileNoThrow.js');
    const command = process.platform === 'win32' ? 'where' : 'which';
    const result = await execFileNoThrow(command, [cmd]);
    return result.exitCode === 0;
  }
}
