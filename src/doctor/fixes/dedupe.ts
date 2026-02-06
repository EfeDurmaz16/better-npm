import { spawnSync } from 'node:child_process';
import { detectPackageManager } from '../../adapters/index.js';
import { getLogger } from '../../observability/logger.js';

export interface FixResult {
  fixId: string;
  applied: boolean;
  message: string;
  details?: string;
}

export async function runDedupeFix(cwd: string, dryRun: boolean): Promise<FixResult> {
  const logger = getLogger();
  const adapter = await detectPackageManager(cwd);

  if (!adapter) {
    return {
      fixId: 'dedupe',
      applied: false,
      message: 'Could not detect package manager',
    };
  }

  const dedupeCommand = getDedupeCommand(adapter.name);

  if (dryRun) {
    return {
      fixId: 'dedupe',
      applied: false,
      message: `Would run: ${adapter.name} ${dedupeCommand}`,
    };
  }

  logger.info('Running dedupe', { pm: adapter.name });

  const result = spawnSync(adapter.name, [dedupeCommand], {
    cwd,
    stdio: 'pipe',
    encoding: 'utf-8',
  });

  return {
    fixId: 'dedupe',
    applied: result.status === 0,
    message: result.status === 0 ? 'Dedupe completed successfully' : 'Dedupe failed',
    details: result.stderr || result.stdout,
  };
}

function getDedupeCommand(pm: string): string {
  switch (pm) {
    case 'npm': return 'dedupe';
    case 'pnpm': return 'dedupe';
    case 'yarn': return 'dedupe';
    default: return 'dedupe';
  }
}
