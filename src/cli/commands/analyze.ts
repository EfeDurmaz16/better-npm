import * as path from 'node:path';
import type { Command, CommandContext } from './index.js';
import { registerCommand } from './index.js';
import { buildDependencyGraph } from '../../analyzer/graph.js';
import { detectDuplicates } from '../../analyzer/duplicates.js';
import { analyzeDepth } from '../../analyzer/depth.js';
import { detectDeprecated } from '../../analyzer/deprecation.js';
import { formatBytes } from '../../fs/size.js';

const analyzeCommand: Command = {
  name: 'analyze',
  description: 'Analyze dependencies for issues and optimizations',
  async run(ctx: CommandContext): Promise<number> {
    const cwd = process.cwd();
    const nodeModulesPath = path.join(cwd, 'node_modules');

    // Parse flags
    const jsonOutput = ctx.args.flags['json'] === true;
    const duplicatesOnly = ctx.args.flags['duplicates'] === true;
    const depthOnly = ctx.args.flags['depth'] === true;
    const deprecatedOnly = ctx.args.flags['deprecated'] === true;

    try {
      // Build dependency graph
      const graph = buildDependencyGraph(nodeModulesPath);

      // Run analyses based on flags
      const shouldRunAll = !duplicatesOnly && !depthOnly && !deprecatedOnly;

      let duplicates;
      let depth;
      let deprecated;

      if (shouldRunAll || duplicatesOnly) {
        duplicates = detectDuplicates(graph);
      }

      if (shouldRunAll || depthOnly) {
        depth = analyzeDepth(graph);
      }

      if (shouldRunAll || deprecatedOnly) {
        deprecated = detectDeprecated(graph, cwd);
      }

      // Calculate total disk size
      let totalSize = 0;
      for (const node of graph.packages.values()) {
        totalSize += node.size;
      }

      // Count direct vs transitive dependencies
      let directCount = 0;
      let transitiveCount = 0;
      for (const node of graph.packages.values()) {
        if (node.isDirect) {
          directCount++;
        } else {
          transitiveCount++;
        }
      }

      // Output results
      if (jsonOutput) {
        const result: any = {
          totalPackages: graph.totalPackages,
          directDependencies: directCount,
          transitiveDependencies: transitiveCount,
          totalSize,
        };

        if (duplicates) {
          result.duplicates = {
            totalDuplicatePackages: duplicates.totalDuplicatePackages,
            totalWastedBytes: duplicates.totalWastedBytes,
            packages: duplicates.duplicates,
          };
        }

        if (depth) {
          result.depth = {
            maxDepth: depth.maxDepth,
            averageDepth: depth.averageDepth,
            longestChain: depth.longestChain,
          };
        }

        if (deprecated) {
          result.deprecated = {
            totalDeprecated: deprecated.totalDeprecated,
            packages: deprecated.deprecatedPackages,
          };
        }

        ctx.output.json(result);
      } else {
        // Human-readable output
        if (shouldRunAll) {
          ctx.output.log('\n=== Dependency Analysis ===\n');
          ctx.output.log(`Total packages: ${graph.totalPackages}`);
          ctx.output.log(`  Direct: ${directCount}`);
          ctx.output.log(`  Transitive: ${transitiveCount}`);
          ctx.output.log(`Total disk size: ${formatBytes(totalSize)}\n`);
        }

        // Duplicates section
        if (duplicates) {
          if (duplicatesOnly) {
            ctx.output.log('\n=== Duplicate Packages ===\n');
          } else {
            ctx.output.log('--- Duplicates ---');
          }

          if (duplicates.totalDuplicatePackages === 0) {
            ctx.output.log('No duplicate packages found.\n');
          } else {
            ctx.output.log(`Found ${duplicates.totalDuplicatePackages} packages with multiple versions`);
            ctx.output.log(`Wasted space: ${formatBytes(duplicates.totalWastedBytes)}\n`);

            for (const dup of duplicates.duplicates) {
              ctx.output.log(`${dup.package}:`);
              for (const ver of dup.versions) {
                ctx.output.log(`  - v${ver.version} (${ver.count} instance${ver.count > 1 ? 's' : ''}, ${formatBytes(ver.size)})`);
              }
              ctx.output.log(`  Suggested: v${dup.suggestedVersion}`);
              ctx.output.log(`  Wasted: ${formatBytes(dup.wastedBytes)}\n`);
            }
          }
        }

        // Depth section
        if (depth) {
          if (depthOnly) {
            ctx.output.log('\n=== Dependency Depth Analysis ===\n');
          } else {
            ctx.output.log('--- Depth Analysis ---');
          }

          ctx.output.log(`Max depth: ${depth.maxDepth}`);
          ctx.output.log(`Average depth: ${depth.averageDepth.toFixed(2)}\n`);

          if (depth.longestChain.length > 0) {
            ctx.output.log('Longest dependency chain:');
            depth.longestChain.forEach((pkg, idx) => {
              const indent = '  '.repeat(idx);
              ctx.output.log(`${indent}${idx + 1}. ${pkg}`);
            });
            ctx.output.log('');
          }
        }

        // Deprecated section
        if (deprecated) {
          if (deprecatedOnly) {
            ctx.output.log('\n=== Deprecated Packages ===\n');
          } else {
            ctx.output.log('--- Deprecated Packages ---');
          }

          if (deprecated.totalDeprecated === 0) {
            ctx.output.log('No deprecated packages found.\n');
          } else {
            ctx.output.log(`Found ${deprecated.totalDeprecated} deprecated package${deprecated.totalDeprecated > 1 ? 's' : ''}:\n`);

            for (const dep of deprecated.deprecatedPackages) {
              ctx.output.log(`${dep.name}@${dep.version}:`);
              ctx.output.log(`  Message: ${dep.deprecationMessage}`);
              if (dep.dependedOnBy.length > 0) {
                ctx.output.log(`  Used by: ${dep.dependedOnBy.slice(0, 5).join(', ')}${dep.dependedOnBy.length > 5 ? ` and ${dep.dependedOnBy.length - 5} more` : ''}`);
              }
              ctx.output.log('');
            }
          }
        }
      }

      return 0;
    } catch (error) {
      ctx.output.error(`Failed to analyze dependencies: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  },
};

registerCommand(analyzeCommand);

export default analyzeCommand;
