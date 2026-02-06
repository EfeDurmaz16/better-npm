import { HealthCheck, Finding, HealthCheckContext } from '../engine.js';

export const duplicatesCheck: HealthCheck = {
  id: 'duplicates',
  name: 'Duplicate Packages',
  description: 'Checks for duplicate package versions',

  async run(context: HealthCheckContext): Promise<Finding[]> {
    const findings: Finding[] = [];
    const { duplicates } = context;

    // Weight: 2 each, max 20 total
    const maxFindings = 10; // 10 * 2 = 20 max weight
    const duplicatesToReport = duplicates.duplicates.slice(0, maxFindings);

    for (const dup of duplicatesToReport) {
      findings.push({
        checkId: 'duplicates',
        severity: 'warning',
        message: `Package '${dup.package}' has ${dup.versions.length} versions installed`,
        package: dup.package,
        suggestion: `Run 'npm dedupe' to consolidate package versions`,
        weight: 2,
      });
    }

    return findings;
  },
};
