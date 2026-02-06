import { HealthCheck, Finding, HealthCheckContext } from '../engine.js';

export const depthCheck: HealthCheck = {
  id: 'depth',
  name: 'Excessive Depth',
  description: 'Checks for excessive dependency depth',

  async run(context: HealthCheckContext): Promise<Finding[]> {
    const findings: Finding[] = [];
    const { depth } = context;

    // Weight: 10 if max depth > 10
    const threshold = 10;

    if (depth.maxDepth > threshold) {
      findings.push({
        checkId: 'depth',
        severity: 'warning',
        message: `Dependency tree depth is ${depth.maxDepth}, exceeding threshold of ${threshold}`,
        suggestion: 'Consider flattening dependencies or reviewing dependency structure',
        weight: 10,
      });
    }

    return findings;
  },
};
