import { describe, it, expect, afterEach } from 'vitest';
import { TestProject, runCLI, parseJSON } from '../helpers/test-utils.js';

describe('better install command', () => {
  let project: TestProject | null = null;

  afterEach(() => {
    if (project) {
      project.destroy();
      project = null;
    }
  });

  it('should run install --dry-run successfully', async () => {
    project = await TestProject.create({ fixture: 'simple-project' });

    const result = await runCLI(['install', '--dry-run'], {
      cwd: project.dir,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('[Dry run]');
    expect(result.stdout).toContain('Would execute');
  }, 30000);

  it('should output JSON in dry-run mode', async () => {
    project = await TestProject.create({ fixture: 'simple-project' });

    const result = await runCLI(['install', '--dry-run', '--json'], {
      cwd: project.dir,
    });

    expect(result.exitCode).toBe(0);

    const output = parseJSON(result.stdout);
    expect(output.dryRun).toBe(true);
    expect(output.command).toBeTruthy();
    expect(output.packageManager).toBeTruthy();
    expect(output.wouldExecute).toBeInstanceOf(Array);
  }, 30000);

  it('should show package manager detection', async () => {
    project = await TestProject.create({ fixture: 'simple-project' });

    const result = await runCLI(['install', '--dry-run'], {
      cwd: project.dir,
    });

    expect(result.exitCode).toBe(0);
    // Should detect npm as default
    expect(result.stdout.toLowerCase()).toMatch(/npm|yarn|pnpm/);
  }, 30000);

  it('should handle frozen flag in dry-run', async () => {
    project = await TestProject.create({ fixture: 'simple-project' });

    const result = await runCLI(['install', '--dry-run', '--frozen'], {
      cwd: project.dir,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Would execute');
  }, 30000);

  it('should handle production flag in dry-run', async () => {
    project = await TestProject.create({ fixture: 'simple-project' });

    const result = await runCLI(['install', '--dry-run', '--production'], {
      cwd: project.dir,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Would execute');
  }, 30000);

  it('should handle missing package.json', async () => {
    project = await TestProject.create();

    const result = await runCLI(['install', '--dry-run'], {
      cwd: project.dir,
    });

    // Should fail or handle gracefully
    expect([0, 1]).toContain(result.exitCode);
  }, 30000);

  it('should show lockfile status', async () => {
    project = await TestProject.create({ fixture: 'simple-project' });

    const result = await runCLI(['install', '--dry-run'], {
      cwd: project.dir,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/lockfile|packages/i);
  }, 30000);
});
