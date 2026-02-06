import { Finding } from './engine.js';

/**
 * Calculate health score from findings
 * Score = 100 - sum(finding.weight), capped at [0, 100]
 */
export function calculateScore(findings: Finding[]): number {
  const totalDeductions = findings.reduce((sum, f) => sum + f.weight, 0);
  return Math.max(0, Math.min(100, 100 - totalDeductions));
}
