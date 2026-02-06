import { DependencyGraph } from '../analyzer/graph.js';
import { DepthAnalysis } from '../analyzer/depth.js';
import { DeprecationReport } from '../analyzer/deprecation.js';
import { DuplicateAnalysis } from '../analyzer/duplicates.js';

export type Severity = 'error' | 'warning' | 'info';

export interface Finding {
  checkId: string;
  severity: Severity;
  message: string;
  package?: string;
  suggestion?: string;
  weight: number;
}

export interface HealthCheck {
  id: string;
  name: string;
  description: string;
  run(context: HealthCheckContext): Promise<Finding[]>;
}

export interface HealthCheckContext {
  cwd: string;
  graph: DependencyGraph;
  duplicates: DuplicateAnalysis;
  depth: DepthAnalysis;
  deprecated: DeprecationReport;
}

export interface HealthReport {
  score: number;
  findings: Finding[];
  checksPassed: string[];
  checksFailed: string[];
}

export class HealthEngine {
  private checks: HealthCheck[] = [];

  register(check: HealthCheck): void {
    this.checks.push(check);
  }

  async run(context: HealthCheckContext): Promise<HealthReport> {
    // Run all checks in parallel
    const results = await Promise.all(
      this.checks.map((check) => check.run(context))
    );

    const findings = results.flat();

    // Import score calculator
    const { calculateScore } = await import('./score.js');
    const score = calculateScore(findings);

    // Determine which checks passed/failed
    const checksPassed: string[] = [];
    const checksFailed: string[] = [];

    for (let i = 0; i < this.checks.length; i++) {
      const result = results[i];
      const check = this.checks[i];
      if (result && check) {
        if (result.length === 0) {
          checksPassed.push(check.id);
        } else {
          checksFailed.push(check.id);
        }
      }
    }

    return {
      score,
      findings,
      checksPassed,
      checksFailed,
    };
  }
}
