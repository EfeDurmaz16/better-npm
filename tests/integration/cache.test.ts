import { describe, it, expect, afterEach } from 'vitest';
import { TestProject, runCLI, parseJSON } from '../helpers/test-utils.js';

describe('better cache command', () => {
  let project: TestProject | null = null;

  afterEach(() => {
    if (project) {
      project.destroy();
      project = null;
    }
  });

  describe('cache stats', () => {
    it('should show cache statistics', async () => {
      project = await TestProject.create({ fixture: 'simple-project' });

      const result = await runCLI(['cache', 'stats'], {
        cwd: project.dir,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/Cache Statistics|Location/i);
      expect(result.stdout).toMatch(/Total Size|Packages/i);
    }, 30000);

    it('should output cache stats as JSON', async () => {
      project = await TestProject.create({ fixture: 'simple-project' });

      const result = await runCLI(['cache', 'stats', '--json'], {
        cwd: project.dir,
      });

      expect(result.exitCode).toBe(0);

      const output = parseJSON(result.stdout);
      expect(output).toHaveProperty('root');
      expect(output).toHaveProperty('totalSize');
      expect(output).toHaveProperty('packageCount');
      expect(typeof output.totalSize).toBe('number');
      expect(typeof output.packageCount).toBe('number');
    }, 30000);

    it('should show cache size in human-readable format', async () => {
      project = await TestProject.create({ fixture: 'simple-project' });

      const result = await runCLI(['cache', 'stats'], {
        cwd: project.dir,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/B|KB|MB|GB/);
    }, 30000);
  });

  describe('cache clean', () => {
    it('should clean temporary files', async () => {
      project = await TestProject.create({ fixture: 'simple-project' });

      const result = await runCLI(['cache', 'clean'], {
        cwd: project.dir,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/Cleaned|cleaned/i);
    }, 30000);

    it('should output clean results as JSON', async () => {
      project = await TestProject.create({ fixture: 'simple-project' });

      const result = await runCLI(['cache', 'clean', '--json'], {
        cwd: project.dir,
      });

      expect(result.exitCode).toBe(0);

      const output = parseJSON(result.stdout);
      expect(output).toHaveProperty('cleaned');
      expect(typeof output.cleaned).toBe('number');
    }, 30000);
  });

  describe('cache gc', () => {
    it('should run garbage collection in dry-run mode', async () => {
      project = await TestProject.create({ fixture: 'simple-project' });

      const result = await runCLI(['cache', 'gc', '--dry-run'], {
        cwd: project.dir,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/Would remove/i);
    }, 30000);

    it('should run garbage collection', async () => {
      project = await TestProject.create({ fixture: 'simple-project' });

      const result = await runCLI(['cache', 'gc'], {
        cwd: project.dir,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/Removed|removed/i);
    }, 30000);

    it('should output gc results as JSON', async () => {
      project = await TestProject.create({ fixture: 'simple-project' });

      const result = await runCLI(['cache', 'gc', '--json'], {
        cwd: project.dir,
      });

      expect(result.exitCode).toBe(0);

      const output = parseJSON(result.stdout);
      expect(output).toHaveProperty('entriesRemoved');
      expect(output).toHaveProperty('bytesFreed');
      expect(typeof output.entriesRemoved).toBe('number');
      expect(typeof output.bytesFreed).toBe('number');
    }, 30000);

    it('should respect max-age flag', async () => {
      project = await TestProject.create({ fixture: 'simple-project' });

      const result = await runCLI(['cache', 'gc', '--max-age', '30', '--dry-run'], {
        cwd: project.dir,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBeTruthy();
    }, 30000);
  });

  describe('cache explain', () => {
    it('should explain package cache status', async () => {
      project = await TestProject.create({ fixture: 'simple-project' });

      const result = await runCLI(['cache', 'explain', 'lodash'], {
        cwd: project.dir,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/Package:|Cached:|Status:/);
    }, 30000);

    it('should explain package with version', async () => {
      project = await TestProject.create({ fixture: 'simple-project' });

      const result = await runCLI(['cache', 'explain', 'lodash@4.17.21'], {
        cwd: project.dir,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/lodash/);
    }, 30000);

    it('should output explain results as JSON', async () => {
      project = await TestProject.create({ fixture: 'simple-project' });

      const result = await runCLI(['cache', 'explain', 'lodash', '--json'], {
        cwd: project.dir,
      });

      expect(result.exitCode).toBe(0);

      const output = parseJSON(result.stdout);
      expect(output).toHaveProperty('package');
      expect(output).toHaveProperty('cached');
      expect(output).toHaveProperty('reason');
      expect(output.package).toBe('lodash');
      expect(typeof output.cached).toBe('boolean');
    }, 30000);

    it('should handle scoped packages', async () => {
      project = await TestProject.create({ fixture: 'duplicate-deps' });

      const result = await runCLI(['cache', 'explain', '@types/react'], {
        cwd: project.dir,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/@types\/react/);
    }, 30000);

    it('should handle missing package argument', async () => {
      project = await TestProject.create({ fixture: 'simple-project' });

      const result = await runCLI(['cache', 'explain'], {
        cwd: project.dir,
      });

      // Should show error or usage
      expect(result.exitCode).toBe(1);
      expect(result.stdout || result.stderr).toMatch(/Usage|package/i);
    }, 30000);
  });

  describe('unknown subcommand', () => {
    it('should handle unknown cache subcommand', async () => {
      project = await TestProject.create({ fixture: 'simple-project' });

      const result = await runCLI(['cache', 'unknown'], {
        cwd: project.dir,
      });

      expect(result.exitCode).toBe(1);
      expect(result.stdout || result.stderr).toMatch(/Unknown|Available/i);
    }, 30000);
  });
});
