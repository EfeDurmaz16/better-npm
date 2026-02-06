import { BetterConfig } from './schema.js';
import { getCacheRoot } from '../utils/paths.js';

export function getDefaultConfig(): BetterConfig {
  return {
    packageManager: 'auto',
    cacheDir: getCacheRoot(),
    logLevel: 'info',
    healthThreshold: 70,
    telemetry: false,
    json: false,
  };
}
