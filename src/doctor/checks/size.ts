import { HealthCheck, Finding, HealthCheckContext } from '../engine.js';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

/**
 * Get directory size recursively
 */
async function getDirectorySize(dirPath: string): Promise<number> {
  let totalSize = 0;

  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);

      if (entry.isDirectory()) {
        totalSize += await getDirectorySize(fullPath);
      } else if (entry.isFile()) {
        const stats = await fs.stat(fullPath);
        totalSize += stats.size;
      }
    }
  } catch (error) {
    // Ignore permission errors and continue
  }

  return totalSize;
}

export const sizeCheck: HealthCheck = {
  id: 'size',
  name: 'Large node_modules',
  description: 'Checks for large node_modules directory',

  async run(context: HealthCheckContext): Promise<Finding[]> {
    const findings: Finding[] = [];
    const nodeModulesPath = path.join(context.cwd, 'node_modules');

    try {
      // Check if node_modules exists
      await fs.access(nodeModulesPath);

      // Calculate size
      const sizeBytes = await getDirectorySize(nodeModulesPath);
      const sizeMB = sizeBytes / (1024 * 1024);

      // Weight: 15 if size > 500MB
      const threshold = 500;

      if (sizeMB > threshold) {
        findings.push({
          checkId: 'size',
          severity: 'warning',
          message: `node_modules is ${sizeMB.toFixed(2)}MB, exceeding ${threshold}MB threshold`,
          suggestion: 'Consider removing unused dependencies or using lighter alternatives',
          weight: 15,
        });
      }
    } catch (error) {
      // node_modules doesn't exist or can't be accessed - not a finding
    }

    return findings;
  },
};
