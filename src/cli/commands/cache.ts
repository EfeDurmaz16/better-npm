import type { Command, CommandContext } from './index.js';
import { registerCommand } from './index.js';
import { getCacheManager } from '../../cache/manager.js';
import { formatBytes } from '../../fs/size.js';
import { runGarbageCollection } from '../../cache/gc.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

const cacheCommand: Command = {
  name: 'cache',
  description: 'Manage dependency cache',
  async run(ctx: CommandContext): Promise<number> {
    const subcommand = ctx.args.positionals[0];
    const maxAgeFlag = ctx.args.flags['max-age'];
    const options: {
      json: boolean;
      dryRun: boolean;
      maxAge?: number;
    } = {
      json: ctx.args.flags['json'] === true,
      dryRun: ctx.args.flags['dry-run'] === true,
    };

    if (typeof maxAgeFlag === 'number') {
      options.maxAge = maxAgeFlag;
    }

    switch (subcommand) {
      case 'stats':
        await cacheStatsCommand(ctx, options);
        break;
      case 'clean':
        await cacheCleanCommand(ctx, options);
        break;
      case 'gc':
        await cacheGCCommand(ctx, options);
        break;
      case 'explain':
        await cacheExplainCommand(ctx, options);
        break;
      default:
        ctx.output.error(`Unknown cache subcommand: ${subcommand}`);
        ctx.output.log('Available: stats, clean, gc, explain');
        return 1;
    }

    return 0;
  },
};

async function cacheStatsCommand(
  ctx: CommandContext,
  options: { json: boolean }
): Promise<void> {
  const cache = getCacheManager();
  const stats = await cache.getStats();

  if (options.json) {
    ctx.output.json({
      root: stats.root,
      totalSize: stats.totalSize,
      packageCount: stats.packageCount,
      oldestEntry: stats.oldestEntry?.toISOString() ?? null,
      newestEntry: stats.newestEntry?.toISOString() ?? null,
    });
  } else {
    ctx.output.log('Cache Statistics:');
    ctx.output.log(`  Location: ${stats.root}`);
    ctx.output.log(`  Total Size: ${formatBytes(stats.totalSize)}`);
    ctx.output.log(`  Packages: ${stats.packageCount}`);
    if (stats.oldestEntry) {
      ctx.output.log(`  Oldest: ${stats.oldestEntry.toISOString()}`);
    }
    if (stats.newestEntry) {
      ctx.output.log(`  Newest: ${stats.newestEntry.toISOString()}`);
    }
  }
}

async function cacheCleanCommand(
  ctx: CommandContext,
  options: { json: boolean }
): Promise<void> {
  const cache = getCacheManager();
  const cleaned = await cache.cleanTmp();

  if (options.json) {
    ctx.output.json({ cleaned });
  } else {
    ctx.output.log(`Cleaned ${cleaned} temporary files`);
  }
}

async function cacheGCCommand(
  ctx: CommandContext,
  options: { json: boolean; dryRun: boolean; maxAge?: number }
): Promise<void> {
  const gcOptions: { dryRun: boolean; maxAge?: number } = {
    dryRun: options.dryRun,
  };

  if (options.maxAge !== undefined) {
    gcOptions.maxAge = options.maxAge;
  }

  const result = await runGarbageCollection(gcOptions);

  if (options.json) {
    ctx.output.json(result);
  } else {
    if (options.dryRun) {
      ctx.output.log(
        `Would remove ${result.entriesRemoved} packages (${formatBytes(result.bytesFreed)})`
      );
    } else {
      ctx.output.log(
        `Removed ${result.entriesRemoved} packages (${formatBytes(result.bytesFreed)})`
      );
    }
  }
}

async function cacheExplainCommand(
  ctx: CommandContext,
  options: { json: boolean }
): Promise<void> {
  const packageSpec = ctx.args.positionals[1];

  if (!packageSpec) {
    ctx.output.error('Usage: better cache explain <package[@version]>');
    process.exit(1);
  }

  const cache = getCacheManager();
  const [name, version] = parsePackageSpec(packageSpec);

  const result = {
    package: name,
    version: version || 'any',
    cached: false,
    path: null as string | null,
    reason: '' as string,
  };

  if (version) {
    const isCached = await cache.hasPackage(name, version);
    if (isCached) {
      result.cached = true;
      result.path = cache.getPackagePath(name, version);
      result.reason = 'Package found in cache';
    } else {
      result.reason = 'Package not in cache - will be downloaded on next install';
    }
  } else {
    // Check for any version
    const packagesDir = cache.getPath('packages');
    const safeName = name.replace(/\//g, '+');
    const packageDir = path.join(packagesDir, safeName);

    if (fs.existsSync(packageDir)) {
      const versions = fs.readdirSync(packageDir);
      result.cached = true;
      result.path = packageDir;
      result.reason = `Found ${versions.length} cached version(s): ${versions.join(', ')}`;
    } else {
      result.reason = 'No versions of this package are cached';
    }
  }

  if (options.json) {
    ctx.output.json(result);
  } else {
    ctx.output.log(`Package: ${result.package}${result.version !== 'any' ? '@' + result.version : ''}`);
    ctx.output.log(`Cached: ${result.cached ? 'Yes' : 'No'}`);
    if (result.path) {
      ctx.output.log(`Path: ${result.path}`);
    }
    ctx.output.log(`Status: ${result.reason}`);
  }
}

function parsePackageSpec(spec: string): [string, string | undefined] {
  // Handle @scope/package@version
  const lastAt = spec.lastIndexOf('@');
  if (lastAt > 0) {
    return [spec.slice(0, lastAt), spec.slice(lastAt + 1)];
  }
  return [spec, undefined];
}

registerCommand(cacheCommand);

export default cacheCommand;
