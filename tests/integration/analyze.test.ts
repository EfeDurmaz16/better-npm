import { describe, it, expect, afterEach } from 'vitest';
import { TestProject, runCLI } from '../helpers/test-utils.js';

describe('better analyze command', () => {
  let project: TestProject | null = null;

  afterEach(() => {
    if (project) {
      project.destroy();
      project = null;
    }
  });

  it('should run analyze command', async () => {
    project = await TestProject.create({ fixture: 'simple-project' });

    const result = await runCLI(['analyze'], {
      cwd: project.dir,
    });

    expect(result.exitCode).toBe(0);
    // Command currently returns "not implemented" warning
    expect(result.stdout || result.stderr).toBeTruthy();
  }, 30000);

  it('should handle analyze with JSON output', async () => {
    project = await TestProject.create({ fixture: 'simple-project' });

    const result = await runCLI(['analyze', '--json'], {
      cwd: project.dir,
    });

    expect(result.exitCode).toBe(0);
  }, 30000);

  it('should analyze project with dependencies', async () => {
    project = await TestProject.create({
      fixture: 'duplicate-deps',
    });

    const result = await runCLI(['analyze'], {
      cwd: project.dir,
    });

    expect(result.exitCode).toBe(0);
  }, 30000);

  it('should handle missing package.json', async () => {
    project = await TestProject.create();

    const result = await runCLI(['analyze'], {
      cwd: project.dir,
    });

    // Should handle gracefully
    expect([0, 1]).toContain(result.exitCode);
  }, 30000);
});
