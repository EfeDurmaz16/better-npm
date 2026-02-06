import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

const CLI_PATH = path.join(process.cwd(), 'bin/better.js');

// Helper to run better CLI
function runBetter(args: string[], cwd: string, options: any = {}) {
  const result = {
    stdout: '',
    stderr: '',
    exitCode: 0,
  };

  try {
    result.stdout = execFileSync('node', [CLI_PATH, ...args], {
      cwd,
      encoding: 'utf8',
      timeout: 60000,
      ...options,
    });
  } catch (err: any) {
    result.stderr = err.stderr || '';
    result.stdout = err.stdout || '';
    result.exitCode = err.status || 1;
  }

  return result;
}

// Check if bun is available
function bunAvailable() {
  try {
    execFileSync('bun', ['--version'], { encoding: 'utf8' });
    return true;
  } catch {
    return false;
  }
}

describe('bun engine', () => {
  const hasBun = bunAvailable();

  describe.skipIf(!hasBun)('--engine bun', () => {
    let tempDir: string;

    beforeAll(async () => {
      // Create temp directory with package.json
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'better-bun-test-'));
      await fs.writeFile(
        path.join(tempDir, 'package.json'),
        JSON.stringify(
          {
            name: 'bun-test',
            version: '1.0.0',
            dependencies: {
              'is-odd': '^3.0.1',
            },
          },
          null,
          2
        )
      );
    });

    afterAll(async () => {
      if (tempDir) {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    it('should run bun install when --engine bun', () => {
      const result = runBetter(['install', '--engine', 'bun', '--json'], tempDir);
      expect(result.exitCode).toBe(0);

      const report = JSON.parse(result.stdout);
      expect(report.engine).toBe('bun');
      expect(report.command.cmd).toBe('bun');
    }, 60000);

    it('should default to pm engine', () => {
      const result = runBetter(['install', '--json'], tempDir);
      expect(result.exitCode).toBe(0);

      const report = JSON.parse(result.stdout);
      expect(report.engine).toBe('pm');
    }, 60000);

    it('should enable parity check by default with bun engine', () => {
      const result = runBetter(['install', '--engine', 'bun', '--json'], tempDir);
      expect(result.exitCode).toBe(0);

      const report = JSON.parse(result.stdout);
      expect(report.parity).toBeDefined();
      expect(report.parity.mode).toBe('warn');
    }, 60000);

    it('should skip parity check when --parity-check off', () => {
      const result = runBetter(['install', '--engine', 'bun', '--parity-check', 'off', '--json'], tempDir);
      expect(result.exitCode).toBe(0);

      const report = JSON.parse(result.stdout);
      expect(report.parity).toBeUndefined();
    }, 60000);

    it('should include lockfilePolicy in report', () => {
      const result = runBetter(['install', '--engine', 'bun', '--json'], tempDir);
      expect(result.exitCode).toBe(0);

      const report = JSON.parse(result.stdout);
      expect(report.lockfilePolicy).toBe('keep');
    }, 60000);

    it('should allow bun.lockb with --lockfile-policy allow-engine', () => {
      const result = runBetter(['install', '--engine', 'bun', '--lockfile-policy', 'allow-engine', '--json'], tempDir);
      expect(result.exitCode).toBe(0);

      const report = JSON.parse(result.stdout);
      expect(report.lockfilePolicy).toBe('allow-engine');
    }, 60000);

    it('should have schemaVersion 2', () => {
      const result = runBetter(['install', '--engine', 'bun', '--json'], tempDir);
      expect(result.exitCode).toBe(0);

      const report = JSON.parse(result.stdout);
      expect(report.schemaVersion).toBe(2);
    }, 60000);

    it('should include lockfileMigration info with allow-engine policy', () => {
      const result = runBetter(['install', '--engine', 'bun', '--lockfile-policy', 'allow-engine', '--json'], tempDir);
      expect(result.exitCode).toBe(0);

      const report = JSON.parse(result.stdout);
      expect(report.lockfileMigration).toBeDefined();
      expect(report.lockfileMigration.status).toBe('migrating');
      expect(report.lockfileMigration.engineLockfile).toBe('bun.lockb');
    }, 60000);

    it('should set lockfileMigration to null with keep policy', () => {
      const result = runBetter(['install', '--engine', 'bun', '--lockfile-policy', 'keep', '--json'], tempDir);
      expect(result.exitCode).toBe(0);

      const report = JSON.parse(result.stdout);
      expect(report.lockfileMigration).toBeNull();
    }, 60000);

    it('should include parity check results in report', () => {
      const result = runBetter(['install', '--engine', 'bun', '--parity-check', 'warn', '--json'], tempDir);
      expect(result.exitCode).toBe(0);

      const report = JSON.parse(result.stdout);
      expect(report.parity).toBeDefined();
      expect(report.parity.ok).toBeDefined();
      expect(report.parity.mode).toBe('warn');
      expect(report.parity.checks).toBeDefined();
      expect(report.parity.checks.lockfileDrift).toBeDefined();
    }, 60000);

    it('should use bun cache directory', () => {
      const result = runBetter(['install', '--engine', 'bun', '--json'], tempDir);
      expect(result.exitCode).toBe(0);

      const report = JSON.parse(result.stdout);
      expect(report.cache).toBeDefined();
      expect(report.cache.pmCacheDir).toBeDefined();
    }, 60000);

    it('should include install metrics', () => {
      const result = runBetter(['install', '--engine', 'bun', '--json'], tempDir);
      expect(result.exitCode).toBe(0);

      const report = JSON.parse(result.stdout);
      expect(report.install).toBeDefined();
      expect(report.install.wallTimeMs).toBeGreaterThan(0);
    }, 60000);

    it('should include node_modules scan results', () => {
      const result = runBetter(['install', '--engine', 'bun', '--json'], tempDir);
      expect(result.exitCode).toBe(0);

      const report = JSON.parse(result.stdout);
      expect(report.nodeModules).toBeDefined();
      expect(report.nodeModules.path).toContain('node_modules');
    }, 60000);

    it('should handle parity-check strict mode', () => {
      const result = runBetter(['install', '--engine', 'bun', '--parity-check', 'strict', '--json'], tempDir);
      expect(result.exitCode).toBe(0);

      const report = JSON.parse(result.stdout);
      expect(report.parity).toBeDefined();
      expect(report.parity.mode).toBe('strict');
    }, 60000);
  });

  describe('--engine validation', () => {
    it('should reject invalid engine', () => {
      const result = runBetter(['install', '--engine', 'invalid'], process.cwd());
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('Unknown --engine');
    });

    it('should reject invalid parity-check mode', () => {
      const result = runBetter(['install', '--parity-check', 'invalid'], process.cwd());
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('Unknown --parity-check');
    });

    it('should reject invalid lockfile-policy', () => {
      const result = runBetter(['install', '--lockfile-policy', 'invalid'], process.cwd());
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('Unknown --lockfile-policy');
    });
  });

  describe('--engine pm (default)', () => {
    let tempDir: string;

    beforeAll(async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'better-pm-test-'));
      await fs.writeFile(
        path.join(tempDir, 'package.json'),
        JSON.stringify(
          {
            name: 'pm-test',
            version: '1.0.0',
            dependencies: {
              'is-even': '^1.0.0',
            },
          },
          null,
          2
        )
      );
    });

    afterAll(async () => {
      if (tempDir) {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    it('should not run parity check by default with pm engine', () => {
      const result = runBetter(['install', '--json'], tempDir);
      expect(result.exitCode).toBe(0);

      const report = JSON.parse(result.stdout);
      expect(report.engine).toBe('pm');
      expect(report.parity).toBeUndefined();
    }, 60000);

    it('should allow explicit parity check with pm engine', () => {
      const result = runBetter(['install', '--parity-check', 'warn', '--json'], tempDir);
      expect(result.exitCode).toBe(0);

      const report = JSON.parse(result.stdout);
      expect(report.engine).toBe('pm');
      expect(report.parity).toBeDefined();
      expect(report.parity.mode).toBe('warn');
    }, 60000);

    it('should use package manager cache with pm engine', () => {
      const result = runBetter(['install', '--json'], tempDir);
      expect(result.exitCode).toBe(0);

      const report = JSON.parse(result.stdout);
      expect(report.cache).toBeDefined();
      expect(report.cache.pmCacheDir).toBeDefined();
    }, 60000);
  });

  describe('report schema validation', () => {
    let tempDir: string;

    beforeAll(async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'better-schema-test-'));
      await fs.writeFile(
        path.join(tempDir, 'package.json'),
        JSON.stringify(
          {
            name: 'schema-test',
            version: '1.0.0',
            dependencies: {},
          },
          null,
          2
        )
      );
    });

    afterAll(async () => {
      if (tempDir) {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    it('should have all required report fields', () => {
      const result = runBetter(['install', '--json'], tempDir);
      expect(result.exitCode).toBe(0);

      const report = JSON.parse(result.stdout);
      expect(report.ok).toBe(true);
      expect(report.kind).toBe('better.install.report');
      expect(report.schemaVersion).toBe(2);
      expect(report.runId).toBeDefined();
      expect(report.startedAt).toBeDefined();
      expect(report.endedAt).toBeDefined();
      expect(report.projectRoot).toBe(tempDir);
      expect(report.pm).toBeDefined();
      expect(report.engine).toBeDefined();
      expect(report.mode).toBeDefined();
      expect(report.lockfilePolicy).toBeDefined();
      expect(report.cacheRoot).toBeDefined();
      expect(report.command).toBeDefined();
      expect(report.install).toBeDefined();
      expect(report.nodeModules).toBeDefined();
      expect(report.cache).toBeDefined();
      expect(report.baseline).toBeDefined();
    }, 60000);

    it('should have valid command structure', () => {
      const result = runBetter(['install', '--json'], tempDir);
      expect(result.exitCode).toBe(0);

      const report = JSON.parse(result.stdout);
      expect(report.command.cmd).toBeDefined();
      expect(report.command.args).toBeInstanceOf(Array);
    }, 60000);

    it('should have valid pm structure', () => {
      const result = runBetter(['install', '--json'], tempDir);
      expect(result.exitCode).toBe(0);

      const report = JSON.parse(result.stdout);
      expect(report.pm.name).toBeDefined();
      expect(report.pm.detected).toBeDefined();
      expect(report.pm.reason).toBeDefined();
    }, 60000);
  });
});
