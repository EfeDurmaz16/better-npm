import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { validateConfig, isValidConfig } from '../../src/config/schema.js';
import { getDefaultConfig } from '../../src/config/defaults.js';
import { loadConfig, setConfig, getConfig } from '../../src/config/loader.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

describe('Config Schema Validation', () => {
  it('should validate a valid config', () => {
    const config = {
      packageManager: 'npm' as const,
      cacheDir: '/tmp/cache',
      logLevel: 'info' as const,
      healthThreshold: 70,
      telemetry: false,
      json: false,
    };

    const errors = validateConfig(config);
    expect(errors).toHaveLength(0);
    expect(isValidConfig(config)).toBe(true);
  });

  it('should reject invalid packageManager', () => {
    const config = { packageManager: 'invalid' };
    const errors = validateConfig(config);
    expect(errors).toHaveLength(1);
    expect(errors[0].path).toBe('packageManager');
    expect(isValidConfig(config)).toBe(false);
  });

  it('should reject invalid logLevel', () => {
    const config = { logLevel: 'trace' };
    const errors = validateConfig(config);
    expect(errors).toHaveLength(1);
    expect(errors[0].path).toBe('logLevel');
  });

  it('should reject healthThreshold out of range', () => {
    const config1 = { healthThreshold: -1 };
    const errors1 = validateConfig(config1);
    expect(errors1).toHaveLength(1);
    expect(errors1[0].path).toBe('healthThreshold');

    const config2 = { healthThreshold: 101 };
    const errors2 = validateConfig(config2);
    expect(errors2).toHaveLength(1);
    expect(errors2[0].path).toBe('healthThreshold');
  });

  it('should reject non-boolean telemetry', () => {
    const config = { telemetry: 'yes' };
    const errors = validateConfig(config);
    expect(errors).toHaveLength(1);
    expect(errors[0].path).toBe('telemetry');
  });

  it('should reject non-object config', () => {
    const errors = validateConfig('not an object');
    expect(errors).toHaveLength(1);
    expect(errors[0].path).toBe('root');
  });

  it('should detect unknown keys', () => {
    const config = { unknownKey: 'value' };
    const errors = validateConfig(config);
    expect(errors).toHaveLength(1);
    expect(errors[0].path).toBe('unknownKey');
  });

  it('should accept partial config', () => {
    const config = { logLevel: 'debug' as const };
    const errors = validateConfig(config);
    expect(errors).toHaveLength(0);
  });

  it('should accept empty config', () => {
    const config = {};
    const errors = validateConfig(config);
    expect(errors).toHaveLength(0);
  });
});

describe('Default Config', () => {
  it('should return valid defaults', () => {
    const defaults = getDefaultConfig();
    expect(defaults.packageManager).toBe('auto');
    expect(defaults.logLevel).toBe('info');
    expect(defaults.healthThreshold).toBe(70);
    expect(defaults.telemetry).toBe(false);
    expect(defaults.json).toBe(false);
    expect(defaults.cacheDir).toBeTruthy();
    expect(validateConfig(defaults)).toHaveLength(0);
  });
});

describe('Config Loader', () => {
  let tempDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'better-test-'));
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    // Restore environment
    process.env = originalEnv;
    // Clean up temp directory
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should load defaults when no config exists', async () => {
    const config = await loadConfig({ cwd: tempDir });
    const defaults = getDefaultConfig();
    expect(config.packageManager).toBe(defaults.packageManager);
    expect(config.logLevel).toBe(defaults.logLevel);
  });

  it('should load from environment variables', async () => {
    process.env['BETTER_PACKAGE_MANAGER'] = 'pnpm';
    process.env['BETTER_LOG_LEVEL'] = 'debug';
    process.env['BETTER_HEALTH_THRESHOLD'] = '80';
    process.env['BETTER_TELEMETRY'] = 'true';

    const config = await loadConfig({ cwd: tempDir });
    expect(config.packageManager).toBe('pnpm');
    expect(config.logLevel).toBe('debug');
    expect(config.healthThreshold).toBe(80);
    expect(config.telemetry).toBe(true);
  });

  it('should load from .betterrc.json', async () => {
    const configFile = path.join(tempDir, '.betterrc.json');
    fs.writeFileSync(configFile, JSON.stringify({
      packageManager: 'yarn',
      logLevel: 'warn',
    }));

    const config = await loadConfig({ cwd: tempDir });
    expect(config.packageManager).toBe('yarn');
    expect(config.logLevel).toBe('warn');
  });

  it('should load from .betterrc', async () => {
    const configFile = path.join(tempDir, '.betterrc');
    fs.writeFileSync(configFile, JSON.stringify({
      packageManager: 'npm',
      healthThreshold: 85,
    }));

    const config = await loadConfig({ cwd: tempDir });
    expect(config.packageManager).toBe('npm');
    expect(config.healthThreshold).toBe(85);
  });

  it('should load from package.json#better', async () => {
    const pkgFile = path.join(tempDir, 'package.json');
    fs.writeFileSync(pkgFile, JSON.stringify({
      name: 'test-pkg',
      better: {
        packageManager: 'pnpm',
        json: true,
      }
    }));

    const config = await loadConfig({ cwd: tempDir });
    expect(config.packageManager).toBe('pnpm');
    expect(config.json).toBe(true);
  });

  it('should respect precedence: CLI > env > file > defaults', async () => {
    // File config
    const configFile = path.join(tempDir, '.betterrc.json');
    fs.writeFileSync(configFile, JSON.stringify({
      packageManager: 'yarn',
      logLevel: 'warn',
      healthThreshold: 50,
    }));

    // Environment variable
    process.env['BETTER_LOG_LEVEL'] = 'debug';
    process.env['BETTER_HEALTH_THRESHOLD'] = '60';

    // CLI flags
    const config = await loadConfig({
      cwd: tempDir,
      cliFlags: {
        healthThreshold: 90,
      }
    });

    // CLI wins for healthThreshold
    expect(config.healthThreshold).toBe(90);
    // Env wins for logLevel
    expect(config.logLevel).toBe('debug');
    // File wins for packageManager (no override)
    expect(config.packageManager).toBe('yarn');
  });

  it('should load from explicit config path', async () => {
    const configFile = path.join(tempDir, 'custom.json');
    fs.writeFileSync(configFile, JSON.stringify({
      packageManager: 'npm',
      telemetry: true,
    }));

    const config = await loadConfig({
      configPath: configFile,
      cwd: tempDir,
    });

    expect(config.packageManager).toBe('npm');
    expect(config.telemetry).toBe(true);
  });

  it('should throw on invalid config', async () => {
    const configFile = path.join(tempDir, '.betterrc.json');
    fs.writeFileSync(configFile, JSON.stringify({
      packageManager: 'invalid',
    }));

    await expect(loadConfig({ cwd: tempDir })).rejects.toThrow('Invalid configuration');
  });

  it('should handle missing package.json gracefully', async () => {
    const config = await loadConfig({ cwd: tempDir });
    expect(config).toBeTruthy();
  });

  it('should handle invalid package.json gracefully', async () => {
    const pkgFile = path.join(tempDir, 'package.json');
    fs.writeFileSync(pkgFile, 'not valid json');

    const config = await loadConfig({ cwd: tempDir });
    expect(config).toBeTruthy();
  });
});

describe('Config Singleton', () => {
  it('should throw when accessing config before loading', () => {
    expect(() => getConfig()).toThrow('Config not loaded');
  });

  it('should cache config after setting', () => {
    const testConfig = getDefaultConfig();
    setConfig(testConfig);
    const retrieved = getConfig();
    expect(retrieved).toEqual(testConfig);
  });
});
