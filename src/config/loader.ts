import { BetterConfig, PartialConfig, validateConfig } from './schema.js';
import { getDefaultConfig } from './defaults.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

// Search order: CLI flags > env vars > config file > defaults
export interface LoadConfigOptions {
  cliFlags?: PartialConfig;
  configPath?: string;
  cwd?: string;
}

export async function loadConfig(options: LoadConfigOptions = {}): Promise<BetterConfig> {
  const defaults = getDefaultConfig();
  const envConfig = loadEnvConfig();
  const fileConfig = await loadFileConfig(options.configPath, options.cwd);

  // Merge in precedence order
  const merged = {
    ...defaults,
    ...fileConfig,
    ...envConfig,
    ...options.cliFlags,
  };

  // Validate final config
  const errors = validateConfig(merged);
  if (errors.length > 0) {
    throw new Error(`Invalid configuration: ${errors.map(e => `${e.path}: ${e.message}`).join(', ')}`);
  }

  return merged as BetterConfig;
}

// Load from environment variables
function loadEnvConfig(): PartialConfig {
  const config: PartialConfig = {};

  if (process.env['BETTER_PACKAGE_MANAGER']) {
    config.packageManager = process.env['BETTER_PACKAGE_MANAGER'] as any;
  }
  if (process.env['BETTER_CACHE_DIR']) {
    config.cacheDir = process.env['BETTER_CACHE_DIR'];
  }
  if (process.env['BETTER_LOG_LEVEL']) {
    config.logLevel = process.env['BETTER_LOG_LEVEL'] as any;
  }
  if (process.env['BETTER_HEALTH_THRESHOLD']) {
    config.healthThreshold = parseInt(process.env['BETTER_HEALTH_THRESHOLD'], 10);
  }
  if (process.env['BETTER_TELEMETRY']) {
    config.telemetry = process.env['BETTER_TELEMETRY'] === 'true';
  }

  return config;
}

// Load from config file
// Search: better.config.js, better.config.mjs, .betterrc, .betterrc.json, package.json#better
async function loadFileConfig(configPath?: string, cwd?: string): Promise<PartialConfig> {
  const searchDir = cwd ?? process.cwd();

  // If explicit path provided, use it
  if (configPath) {
    return loadConfigFile(configPath);
  }

  // Search for config files
  const candidates = [
    'better.config.js',
    'better.config.mjs',
    '.betterrc',
    '.betterrc.json',
  ];

  for (const candidate of candidates) {
    const fullPath = path.join(searchDir, candidate);
    if (fs.existsSync(fullPath)) {
      return loadConfigFile(fullPath);
    }
  }

  // Check package.json#better
  const pkgPath = path.join(searchDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      if (pkg.better) {
        return pkg.better as PartialConfig;
      }
    } catch {
      // Ignore invalid package.json
    }
  }

  return {};
}

async function loadConfigFile(filePath: string): Promise<PartialConfig> {
  const ext = path.extname(filePath);

  if (ext === '.js' || ext === '.mjs') {
    // Dynamic import for JS config
    // Convert to file URL for proper ESM import
    const fileUrl = pathToFileURL(path.resolve(filePath)).href;
    const module = await import(fileUrl);
    return module.default ?? module;
  }

  // JSON or .betterrc (treat as JSON)
  const content = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(content) as PartialConfig;
}

// Singleton for global access
let cachedConfig: BetterConfig | null = null;

export function getConfig(): BetterConfig {
  if (!cachedConfig) {
    throw new Error('Config not loaded. Call loadConfig() first.');
  }
  return cachedConfig;
}

export function setConfig(config: BetterConfig): void {
  cachedConfig = config;
}
