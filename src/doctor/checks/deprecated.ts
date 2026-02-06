import { HealthCheck, Finding, HealthCheckContext } from '../engine.js';

export const deprecatedCheck: HealthCheck = {
  id: 'deprecated',
  name: 'Deprecated Packages',
  description: 'Checks for deprecated packages',

  async run(context: HealthCheckContext): Promise<Finding[]> {
    const findings: Finding[] = [];
    const { deprecated } = context;

    // Weight: 5 each, max 25 total
    const maxFindings = 5; // 5 * 5 = 25 max weight
    const deprecatedToReport = deprecated.deprecatedPackages.slice(0, maxFindings);

    for (const dep of deprecatedToReport) {
      const message = dep.deprecationMessage
        ? `Package '${dep.name}@${dep.version}' is deprecated: ${dep.deprecationMessage}`
        : `Package '${dep.name}@${dep.version}' is deprecated`;

      findings.push({
        checkId: 'deprecated',
        severity: 'error',
        message,
        package: dep.name,
        suggestion: 'Find an alternative package or remove if unused',
        weight: 5,
      });
    }

    return findings;
  },
};
