export interface BetterConfig {
  packageManager: 'npm' | 'pnpm' | 'yarn' | 'auto';
  cacheDir: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error' | 'silent';
  healthThreshold: number; // 0-100
  telemetry: boolean;
  json: boolean;
}

export type PartialConfig = Partial<BetterConfig>;

// Validation errors
export interface ValidationError {
  path: string;
  message: string;
}

// Validate and return errors (empty array if valid)
export function validateConfig(config: unknown): ValidationError[] {
  const errors: ValidationError[] = [];

  if (typeof config !== 'object' || config === null) {
    errors.push({ path: 'root', message: 'Config must be an object' });
    return errors;
  }

  const cfg = config as Record<string, unknown>;

  // Validate packageManager
  if ('packageManager' in cfg) {
    const validManagers = ['npm', 'pnpm', 'yarn', 'auto'];
    if (typeof cfg['packageManager'] !== 'string' || !validManagers.includes(cfg['packageManager'] as string)) {
      errors.push({
        path: 'packageManager',
        message: `Must be one of: ${validManagers.join(', ')}`
      });
    }
  }

  // Validate cacheDir
  if ('cacheDir' in cfg) {
    if (typeof cfg['cacheDir'] !== 'string' || (cfg['cacheDir'] as string).trim() === '') {
      errors.push({
        path: 'cacheDir',
        message: 'Must be a non-empty string'
      });
    }
  }

  // Validate logLevel
  if ('logLevel' in cfg) {
    const validLevels = ['debug', 'info', 'warn', 'error', 'silent'];
    if (typeof cfg['logLevel'] !== 'string' || !validLevels.includes(cfg['logLevel'] as string)) {
      errors.push({
        path: 'logLevel',
        message: `Must be one of: ${validLevels.join(', ')}`
      });
    }
  }

  // Validate healthThreshold
  if ('healthThreshold' in cfg) {
    if (typeof cfg['healthThreshold'] !== 'number' ||
        !Number.isFinite(cfg['healthThreshold'] as number) ||
        (cfg['healthThreshold'] as number) < 0 ||
        (cfg['healthThreshold'] as number) > 100) {
      errors.push({
        path: 'healthThreshold',
        message: 'Must be a number between 0 and 100'
      });
    }
  }

  // Validate telemetry
  if ('telemetry' in cfg) {
    if (typeof cfg['telemetry'] !== 'boolean') {
      errors.push({
        path: 'telemetry',
        message: 'Must be a boolean'
      });
    }
  }

  // Validate json
  if ('json' in cfg) {
    if (typeof cfg['json'] !== 'boolean') {
      errors.push({
        path: 'json',
        message: 'Must be a boolean'
      });
    }
  }

  // Check for unknown keys
  const knownKeys = ['packageManager', 'cacheDir', 'logLevel', 'healthThreshold', 'telemetry', 'json'];
  for (const key of Object.keys(cfg)) {
    if (!knownKeys.includes(key)) {
      errors.push({
        path: key,
        message: 'Unknown configuration key'
      });
    }
  }

  return errors;
}

// Type guard
export function isValidConfig(config: unknown): config is PartialConfig {
  return validateConfig(config).length === 0;
}
