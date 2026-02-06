import type { Command, CommandContext } from './index.js';
import { registerCommand } from './index.js';
import { detectPackageManager } from '../../adapters/index.js';
import { getLogger } from '../../observability/logger.js';
import { spawnWithOutput } from '../../utils/spawn.js';
import { countPackages, calculateSize, countLockfilePackages } from '../../fs/index.js';
import * as path from 'node:path';

interface InstallMetrics {
  duration: number;        // milliseconds
  packagesInstalled: number;
  packagesBefore: number;
  packagesAfter: number;
  sizeAdded: number;       // bytes
  sizeBefore: number;
  sizeAfter: number;
  cacheHits: 0;           // placeholder for future
  cacheMisses: 0;         // placeholder for future
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

const installCommand: Command = {
  name: 'install',
  description: 'Install dependencies with enhanced features',
  async run(ctx: CommandContext): Promise<number> {
    const logger = getLogger();
    const cwd = process.cwd();

    // Parse install-specific flags
    const dryRun = ctx.args.flags['dry-run'] === true;
    const frozen = ctx.args.flags['frozen'] === true;
    const production = ctx.args.flags['production'] === true;
    const jsonOutput = ctx.args.flags['json'] === true;

    try {
      // Detect package manager
      logger.debug('Detecting package manager', { cwd });
      const adapter = await detectPackageManager(cwd);
      logger.info('Detected package manager', { pm: adapter.name });

      // Build install command
      const installOptions = {
        frozen,
        production,
        args: ctx.args.positionals, // Additional packages to install
      };

      const commandArgs = adapter.getInstallCommand(installOptions);
      logger.debug('Install command', { command: commandArgs.join(' ') });

      if (dryRun) {
        // Get lockfile path and count packages
        const lockfilePath = path.join(cwd, adapter.lockfile);
        const estimatedPackages = countLockfilePackages(lockfilePath);

        const result = {
          dryRun: true,
          command: commandArgs.join(' '),
          packageManager: adapter.name,
          estimatedPackages,
          wouldExecute: commandArgs,
          lockfileExists: estimatedPackages > 0,
        };

        if (jsonOutput) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          ctx.output.log(`[Dry run] Would execute: ${result.command}`);
          if (estimatedPackages > 0) {
            ctx.output.log(`Estimated packages: ${estimatedPackages}`);
          } else {
            ctx.output.log('No lockfile found or lockfile is empty');
          }
        }

        return 0;
      }

      // Execute install
      ctx.output.log(`Installing with ${adapter.name}...`);
      const startTime = performance.now();

      const result = await spawnWithOutput(commandArgs[0]!, commandArgs.slice(1), {
        cwd,
        inheritStdio: true,
      });

      const durationSec = (result.duration / 1000).toFixed(2);

      // Report results
      if (result.exitCode === 0) {
        ctx.output.success(`Installation completed in ${durationSec}s`);
        logger.info('Install completed', {
          pm: adapter.name,
          durationMs: result.duration,
          exitCode: result.exitCode,
        });
      } else {
        ctx.output.error(`Installation failed (exit code ${result.exitCode})`);
        logger.error('Install failed', {
          pm: adapter.name,
          durationMs: result.duration,
          exitCode: result.exitCode,
        });
      }

      return result.exitCode;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      ctx.output.error(`Install failed: ${errorMessage}`);
      logger.error('Install error', { error: errorMessage });
      return 1;
    }
  },
};

registerCommand(installCommand);

export default installCommand;
