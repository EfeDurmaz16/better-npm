export { runDedupeFix, type FixResult } from './dedupe.js';

export async function runAllFixes(cwd: string, dryRun: boolean) {
  const { runDedupeFix } = await import('./dedupe.js');
  const results = [];

  // Run dedupe
  results.push(await runDedupeFix(cwd, dryRun));

  return results;
}
