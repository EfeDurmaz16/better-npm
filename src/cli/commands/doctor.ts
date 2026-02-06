import * as path from 'node:path';
import type { Command, CommandContext } from './index.js';
import { registerCommand } from './index.js';
import { buildDependencyGraph } from '../../analyzer/graph.js';
import { detectDuplicates } from '../../analyzer/duplicates.js';
import { analyzeDepth } from '../../analyzer/depth.js';
import { detectDeprecated } from '../../analyzer/deprecation.js';
import { HealthEngine, type HealthCheckContext, type HealthReport } from '../../doctor/engine.js';
import { allChecks } from '../../doctor/checks/index.js';
import { getLogger } from '../../observability/logger.js';

const doctorCommand: Command = {
  name: 'doctor',
  description: 'Check system health and configuration',
  async run(ctx: CommandContext): Promise<number> {
    const logger = getLogger();
    const cwd = process.cwd();

    // Parse options from flags
    const jsonOutput = ctx.args.flags['json'] === true;
    const fix = ctx.args.flags['fix'] === true;
    const threshold = typeof ctx.args.flags['threshold'] === 'string'
      ? parseInt(ctx.args.flags['threshold'], 10)
      : (typeof ctx.config['healthThreshold'] === 'number' ? ctx.config['healthThreshold'] : 70);

    logger.info('Running health checks', { cwd, threshold });

    try {
      // Build context
      const nodeModulesPath = path.join(cwd, 'node_modules');
      const graph = buildDependencyGraph(nodeModulesPath);
      const duplicates = detectDuplicates(graph);
      const depth = analyzeDepth(graph);
      const deprecated = detectDeprecated(graph, nodeModulesPath);

      const context: HealthCheckContext = {
        cwd,
        graph,
        duplicates,
        depth,
        deprecated,
      };

      // Run checks
      const engine = new HealthEngine();
      allChecks.forEach(check => engine.register(check));
      const report = await engine.run(context);

      // Output
      if (jsonOutput) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        printReport(report, threshold, ctx.output);
      }

      // Exit code based on threshold
      if (report.score < threshold) {
        logger.warn('Health score below threshold', { score: report.score, threshold });
        return 1;
      }

      return 0;
    } catch (error) {
      logger.error('Doctor command failed', { error: String(error) });
      ctx.output.error(`Failed to run health checks: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  },
};

function printReport(report: HealthReport, threshold: number, output: any): void {
  const scoreColor = report.score >= threshold ? '32' : '31'; // green/red
  console.log(`\nHealth Score: \x1b[${scoreColor}m${report.score}/100\x1b[0m\n`);

  const errors = report.findings.filter(f => f.severity === 'error');
  const warnings = report.findings.filter(f => f.severity === 'warning');
  const infos = report.findings.filter(f => f.severity === 'info');

  if (errors.length > 0) {
    console.log(`ERRORS (${errors.length}):`);
    errors.forEach(f => console.log(`  - [${f.checkId}] ${f.message}`));
    console.log('');
  }

  if (warnings.length > 0) {
    console.log(`WARNINGS (${warnings.length}):`);
    warnings.forEach(f => console.log(`  - [${f.checkId}] ${f.message}`));
    console.log('');
  }

  if (infos.length > 0) {
    console.log(`INFO (${infos.length}):`);
    infos.forEach(f => console.log(`  - [${f.checkId}] ${f.message}`));
    console.log('');
  }

  if (report.findings.length === 0) {
    console.log('No issues found!\n');
  }

  console.log(`Run 'better doctor --fix' to attempt automatic fixes.`);
}

registerCommand(doctorCommand);

export default doctorCommand;
