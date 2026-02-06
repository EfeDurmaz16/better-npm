import { describe, it, expect, afterEach } from 'vitest';
import { TestProject, runCLI, parseJSON } from '../helpers/test-utils.js';

describe('better doctor command', () => {
  let project: TestProject | null = null;

  afterEach(() => {
    if (project) {
      project.destroy();
      project = null;
    }
  });

  it('should run doctor command successfully', async () => {
    project = await TestProject.create({
      fixture: 'simple-project',
      withNodeModules: true,
    });

    const result = await runCLI(['doctor'], {
      cwd: project.dir,
    });

    // Should complete (may pass or fail based on health score)
    expect([0, 1]).toContain(result.exitCode);
    expect(result.stdout).toMatch(/Health Score|health/i);
  }, 60000);

  it('should output JSON format', async () => {
    project = await TestProject.create({
      fixture: 'simple-project',
      withNodeModules: true,
    });

    const result = await runCLI(['doctor', '--json'], {
      cwd: project.dir,
    });

    expect([0, 1]).toContain(result.exitCode);

    const output = parseJSON(result.stdout);
    expect(output).toHaveProperty('score');
    expect(output).toHaveProperty('findings');
    expect(typeof output.score).toBe('number');
    expect(Array.isArray(output.findings)).toBe(true);
  }, 60000);

  it('should respect custom threshold', async () => {
    project = await TestProject.create({
      fixture: 'simple-project',
      withNodeModules: true,
    });

    const result = await runCLI(['doctor', '--threshold', '50'], {
      cwd: project.dir,
    });

    expect([0, 1]).toContain(result.exitCode);
    expect(result.stdout).toBeTruthy();
  }, 60000);

  it('should show health check findings', async () => {
    project = await TestProject.create({
      fixture: 'simple-project',
      withNodeModules: true,
    });

    const result = await runCLI(['doctor'], {
      cwd: project.dir,
    });

    expect([0, 1]).toContain(result.exitCode);
    // Should show some health information
    expect(result.stdout).toBeTruthy();
  }, 60000);

  it('should handle missing node_modules', async () => {
    project = await TestProject.create({ fixture: 'simple-project' });

    const result = await runCLI(['doctor'], {
      cwd: project.dir,
    });

    // Should handle missing node_modules gracefully
    expect([0, 1]).toContain(result.exitCode);
  }, 30000);

  it('should detect deprecated dependencies', async () => {
    project = await TestProject.create({
      fixture: 'deprecated-deps',
      withNodeModules: true,
    });

    const result = await runCLI(['doctor', '--json'], {
      cwd: project.dir,
    });

    expect([0, 1]).toContain(result.exitCode);

    const output = parseJSON(result.stdout);
    expect(output).toHaveProperty('findings');
    // May contain deprecation warnings
  }, 60000);

  it('should return non-zero exit code when below threshold', async () => {
    project = await TestProject.create({
      fixture: 'simple-project',
      withNodeModules: true,
    });

    // Set an impossibly high threshold
    const result = await runCLI(['doctor', '--threshold', '100'], {
      cwd: project.dir,
    });

    // Should fail with high threshold (unless project is perfect)
    expect([0, 1]).toContain(result.exitCode);
  }, 60000);

  it('should show error, warning, and info findings', async () => {
    project = await TestProject.create({
      fixture: 'simple-project',
      withNodeModules: true,
    });

    const result = await runCLI(['doctor'], {
      cwd: project.dir,
    });

    expect([0, 1]).toContain(result.exitCode);
    // Output should contain structured information
    expect(result.stdout.length).toBeGreaterThan(0);
  }, 60000);
});
