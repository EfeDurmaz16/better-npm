#!/usr/bin/env node
/**
 * Example demonstrating the configuration system
 *
 * Run with: node --loader ts-node/esm examples/config-example.ts
 * Or after build: node examples/config-example.js
 */

import { loadConfig, setConfig, getConfig } from '../src/config/loader.js';
import { validateConfig } from '../src/config/schema.js';

async function main() {
  console.log('=== Better CLI Configuration System Demo ===\n');

  // 1. Load configuration (merges defaults, env vars, config files, CLI flags)
  console.log('1. Loading configuration...');
  const config = await loadConfig({
    cliFlags: {
      logLevel: 'debug',
      json: false,
    }
  });

  console.log('Loaded config:', JSON.stringify(config, null, 2));

  // 2. Validate configuration
  console.log('\n2. Validating configuration...');
  const errors = validateConfig(config);
  if (errors.length === 0) {
    console.log('✓ Configuration is valid');
  } else {
    console.log('✗ Configuration has errors:', errors);
  }

  // 3. Set global config
  console.log('\n3. Setting global config...');
  setConfig(config);

  // 4. Access global config
  console.log('\n4. Accessing global config...');
  const globalConfig = getConfig();
  console.log('Package Manager:', globalConfig.packageManager);
  console.log('Log Level:', globalConfig.logLevel);
  console.log('Cache Directory:', globalConfig.cacheDir);
  console.log('Health Threshold:', globalConfig.healthThreshold);
  console.log('Telemetry:', globalConfig.telemetry);

  // 5. Demonstrate validation errors
  console.log('\n5. Testing validation with invalid config...');
  const invalidConfig = {
    packageManager: 'invalid',
    healthThreshold: 150,
    logLevel: 'trace',
  };
  const validationErrors = validateConfig(invalidConfig);
  console.log('Validation errors:', validationErrors);

  console.log('\n✓ Configuration system working correctly!');
}

main().catch(console.error);
