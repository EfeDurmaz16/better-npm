import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CacheManager } from '../src/cache/manager.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

describe('CacheManager', () => {
  let tempDir: string;
  let cacheManager: CacheManager;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'better-cache-test-'));
    cacheManager = new CacheManager({ root: tempDir });
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('initialization', () => {
    it('should initialize cache directories', async () => {
      await cacheManager.initialize();

      expect(fs.existsSync(tempDir)).toBe(true);
      expect(fs.existsSync(path.join(tempDir, 'packages'))).toBe(true);
      expect(fs.existsSync(path.join(tempDir, 'metadata'))).toBe(true);
      expect(fs.existsSync(path.join(tempDir, 'tmp'))).toBe(true);
    });

    it('should not error if directories already exist', async () => {
      await cacheManager.initialize();
      await expect(cacheManager.initialize()).resolves.not.toThrow();
    });

    it('should create nested directories recursively', async () => {
      const deepPath = path.join(os.tmpdir(), 'better-test-deep', 'nested', 'cache');
      const deepCache = new CacheManager({ root: deepPath });

      await deepCache.initialize();

      expect(fs.existsSync(deepPath)).toBe(true);
      expect(fs.existsSync(path.join(deepPath, 'packages'))).toBe(true);

      // Cleanup
      fs.rmSync(path.join(os.tmpdir(), 'better-test-deep'), { recursive: true, force: true });
    });
  });

  describe('getRoot', () => {
    it('should return cache root path', () => {
      expect(cacheManager.getRoot()).toBe(tempDir);
    });
  });

  describe('getPath', () => {
    it('should return path for packages', () => {
      const packagesPath = cacheManager.getPath('packages');
      expect(packagesPath).toBe(path.join(tempDir, 'packages'));
    });

    it('should return path for metadata', () => {
      const metadataPath = cacheManager.getPath('metadata');
      expect(metadataPath).toBe(path.join(tempDir, 'metadata'));
    });

    it('should return path for tmp', () => {
      const tmpPath = cacheManager.getPath('tmp');
      expect(tmpPath).toBe(path.join(tempDir, 'tmp'));
    });

    it('should handle additional path parts', () => {
      const fullPath = cacheManager.getPath('packages', 'lodash', '4.17.21');
      expect(fullPath).toBe(path.join(tempDir, 'packages', 'lodash', '4.17.21'));
    });
  });

  describe('getPackagePath', () => {
    it('should return path for unscoped package', () => {
      const pkgPath = cacheManager.getPackagePath('lodash', '4.17.21');
      expect(pkgPath).toBe(path.join(tempDir, 'packages', 'lodash', '4.17.21'));
    });

    it('should handle scoped packages', () => {
      const pkgPath = cacheManager.getPackagePath('@babel/core', '7.20.0');
      expect(pkgPath).toBe(path.join(tempDir, 'packages', '@babel+core', '7.20.0'));
    });

    it('should convert slashes to plus signs', () => {
      const pkgPath = cacheManager.getPackagePath('@org/package', '1.0.0');
      expect(pkgPath).toContain('@org+package');
    });
  });

  describe('hasPackage', () => {
    it('should return false for non-existent package', async () => {
      const exists = await cacheManager.hasPackage('lodash', '4.17.21');
      expect(exists).toBe(false);
    });

    it('should return true for existing package', async () => {
      await cacheManager.initialize();
      const pkgPath = cacheManager.getPackagePath('lodash', '4.17.21');
      fs.mkdirSync(pkgPath, { recursive: true });

      const exists = await cacheManager.hasPackage('lodash', '4.17.21');
      expect(exists).toBe(true);
    });

    it('should handle scoped packages', async () => {
      await cacheManager.initialize();
      const pkgPath = cacheManager.getPackagePath('@babel/core', '7.20.0');
      fs.mkdirSync(pkgPath, { recursive: true });

      const exists = await cacheManager.hasPackage('@babel/core', '7.20.0');
      expect(exists).toBe(true);
    });
  });

  describe('getStats', () => {
    it('should return empty stats for empty cache', async () => {
      const stats = await cacheManager.getStats();

      expect(stats.root).toBe(tempDir);
      expect(stats.totalSize).toBe(0);
      expect(stats.packageCount).toBe(0);
      expect(stats.oldestEntry).toBeNull();
      expect(stats.newestEntry).toBeNull();
    });

    it('should calculate stats for populated cache', async () => {
      await cacheManager.initialize();

      // Create some test files
      const pkg1Path = path.join(tempDir, 'packages', 'lodash', '4.17.21');
      fs.mkdirSync(pkg1Path, { recursive: true });
      fs.writeFileSync(path.join(pkg1Path, 'index.js'), 'module.exports = {}');

      const pkg2Path = path.join(tempDir, 'packages', 'axios', '1.0.0');
      fs.mkdirSync(pkg2Path, { recursive: true });
      fs.writeFileSync(path.join(pkg2Path, 'index.js'), 'module.exports = {};');

      const stats = await cacheManager.getStats();

      expect(stats.packageCount).toBe(2);
      expect(stats.totalSize).toBeGreaterThan(0);
      expect(stats.oldestEntry).toBeInstanceOf(Date);
      expect(stats.newestEntry).toBeInstanceOf(Date);
    });

    it('should handle nested directories', async () => {
      await cacheManager.initialize();

      const pkgPath = path.join(tempDir, 'packages', '@org', 'pkg', '1.0.0');
      fs.mkdirSync(pkgPath, { recursive: true });
      fs.writeFileSync(path.join(pkgPath, 'file1.js'), 'content1');
      fs.writeFileSync(path.join(pkgPath, 'file2.js'), 'content2');

      const subDir = path.join(pkgPath, 'subdir');
      fs.mkdirSync(subDir);
      fs.writeFileSync(path.join(subDir, 'file3.js'), 'content3');

      const stats = await cacheManager.getStats();

      expect(stats.packageCount).toBe(3);
      expect(stats.totalSize).toBeGreaterThan(0);
    });

    it('should calculate correct total size', async () => {
      await cacheManager.initialize();

      const pkgPath = path.join(tempDir, 'packages', 'test');
      fs.mkdirSync(pkgPath, { recursive: true });

      const content1 = 'x'.repeat(1000);
      const content2 = 'y'.repeat(2000);

      fs.writeFileSync(path.join(pkgPath, 'file1.txt'), content1);
      fs.writeFileSync(path.join(pkgPath, 'file2.txt'), content2);

      const stats = await cacheManager.getStats();

      expect(stats.totalSize).toBe(3000);
    });
  });

  describe('cleanTmp', () => {
    it('should return 0 when tmp is empty', async () => {
      await cacheManager.initialize();

      const cleaned = await cacheManager.cleanTmp();
      expect(cleaned).toBe(0);
    });

    it('should clean all files in tmp directory', async () => {
      await cacheManager.initialize();

      const tmpPath = path.join(tempDir, 'tmp');
      fs.writeFileSync(path.join(tmpPath, 'file1.tmp'), 'temp1');
      fs.writeFileSync(path.join(tmpPath, 'file2.tmp'), 'temp2');
      fs.mkdirSync(path.join(tmpPath, 'subdir'));
      fs.writeFileSync(path.join(tmpPath, 'subdir', 'file3.tmp'), 'temp3');

      const cleaned = await cacheManager.cleanTmp();

      expect(cleaned).toBe(3); // 2 files + 1 directory
      expect(fs.readdirSync(tmpPath)).toHaveLength(0);
    });

    it('should handle non-existent tmp directory', async () => {
      const cleaned = await cacheManager.cleanTmp();
      expect(cleaned).toBe(0);
    });

    it('should remove nested directories', async () => {
      await cacheManager.initialize();

      const tmpPath = path.join(tempDir, 'tmp');
      const nested = path.join(tmpPath, 'a', 'b', 'c');
      fs.mkdirSync(nested, { recursive: true });
      fs.writeFileSync(path.join(nested, 'file.txt'), 'nested');

      const cleaned = await cacheManager.cleanTmp();

      expect(cleaned).toBeGreaterThan(0);
      expect(fs.readdirSync(tmpPath)).toHaveLength(0);
    });
  });

  describe('edge cases', () => {
    it('should handle package names with special characters', () => {
      const pkgPath = cacheManager.getPackagePath('@org/my-package', '1.0.0-beta.1');
      expect(pkgPath).toContain('@org+my-package');
      expect(pkgPath).toContain('1.0.0-beta.1');
    });

    it('should handle empty version string', () => {
      const pkgPath = cacheManager.getPackagePath('package', '');
      expect(pkgPath).toContain('package');
    });

    it('should handle multiple slashes in scoped package', () => {
      // Edge case: malformed package name
      const pkgPath = cacheManager.getPackagePath('@org/sub/package', '1.0.0');
      expect(pkgPath).toContain('@org+sub+package');
    });

    it('should handle initialization race condition', async () => {
      // Call initialize multiple times simultaneously
      await Promise.all([
        cacheManager.initialize(),
        cacheManager.initialize(),
        cacheManager.initialize(),
      ]);

      expect(fs.existsSync(path.join(tempDir, 'packages'))).toBe(true);
    });
  });
});
