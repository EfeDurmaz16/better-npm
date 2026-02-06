import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn } from 'node:child_process';

export interface TestProjectOptions {
  fixture?: string;
  withNodeModules?: boolean;
}

export class TestProject {
  public readonly dir: string;
  private cleanup: boolean = true;

  constructor(dir: string) {
    this.dir = dir;
  }

  static async create(options: TestProjectOptions = {}): Promise<TestProject> {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'better-test-'));
    const project = new TestProject(tempDir);

    if (options.fixture) {
      await project.copyFixture(options.fixture);
    }

    if (options.withNodeModules) {
      await project.installDependencies();
    }

    return project;
  }

  async copyFixture(fixtureName: string): Promise<void> {
    const fixtureDir = path.join(__dirname, '..', 'fixtures', fixtureName);
    await this.copyDir(fixtureDir, this.dir);
  }

  private async copyDir(src: string, dest: string): Promise<void> {
    if (!fs.existsSync(src)) {
      throw new Error(`Fixture not found: ${src}`);
    }

    const entries = fs.readdirSync(src, { withFileTypes: true });

    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);

      if (entry.isDirectory()) {
        fs.mkdirSync(destPath, { recursive: true });
        await this.copyDir(srcPath, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }

  async installDependencies(): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn('npm', ['install', '--no-audit', '--no-fund'], {
        cwd: this.dir,
        stdio: 'ignore',
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`npm install failed with code ${code}`));
        }
      });

      proc.on('error', reject);
    });
  }

  writeFile(filename: string, content: string): void {
    const filepath = path.join(this.dir, filename);
    fs.mkdirSync(path.dirname(filepath), { recursive: true });
    fs.writeFileSync(filepath, content, 'utf-8');
  }

  readFile(filename: string): string {
    const filepath = path.join(this.dir, filename);
    return fs.readFileSync(filepath, 'utf-8');
  }

  fileExists(filename: string): boolean {
    const filepath = path.join(this.dir, filename);
    return fs.existsSync(filepath);
  }

  disableCleanup(): void {
    this.cleanup = false;
  }

  destroy(): void {
    if (this.cleanup && fs.existsSync(this.dir)) {
      fs.rmSync(this.dir, { recursive: true, force: true });
    }
  }
}

export interface CLIResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  duration: number;
}

export async function runCLI(
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<CLIResult> {
  const startTime = performance.now();
  const cliPath = path.join(__dirname, '..', '..', 'dist', 'cli.js');

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';

    const proc = spawn('node', [cliPath, ...args], {
      cwd: options.cwd || process.cwd(),
      env: { ...process.env, ...options.env },
    });

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      const duration = performance.now() - startTime;
      resolve({
        exitCode: code ?? 0,
        stdout,
        stderr,
        duration,
      });
    });
  });
}

export function parseJSON<T = any>(output: string): T {
  try {
    return JSON.parse(output);
  } catch (error) {
    throw new Error(`Failed to parse JSON output: ${output}`);
  }
}
