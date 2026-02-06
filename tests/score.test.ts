import { describe, it, expect } from 'vitest';
import { calculateScore } from '../src/doctor/score.js';
import { Finding } from '../src/doctor/engine.js';

describe('Score Calculation', () => {
  describe('calculateScore', () => {
    it('should return 100 for no findings', () => {
      const score = calculateScore([]);
      expect(score).toBe(100);
    });

    it('should deduct weight from 100', () => {
      const findings: Finding[] = [
        {
          id: 'test-1',
          severity: 'warning',
          category: 'performance',
          title: 'Test Finding',
          description: 'Test',
          weight: 10,
          metadata: {},
        },
      ];

      const score = calculateScore(findings);
      expect(score).toBe(90);
    });

    it('should sum multiple finding weights', () => {
      const findings: Finding[] = [
        {
          id: 'test-1',
          severity: 'warning',
          category: 'performance',
          title: 'Finding 1',
          description: 'Test',
          weight: 10,
          metadata: {},
        },
        {
          id: 'test-2',
          severity: 'error',
          category: 'security',
          title: 'Finding 2',
          description: 'Test',
          weight: 25,
          metadata: {},
        },
        {
          id: 'test-3',
          severity: 'warning',
          category: 'performance',
          title: 'Finding 3',
          description: 'Test',
          weight: 5,
          metadata: {},
        },
      ];

      const score = calculateScore(findings);
      expect(score).toBe(60); // 100 - 10 - 25 - 5
    });

    it('should cap score at 0 (not go negative)', () => {
      const findings: Finding[] = [
        {
          id: 'test-1',
          severity: 'error',
          category: 'security',
          title: 'Critical Issue',
          description: 'Test',
          weight: 150,
          metadata: {},
        },
      ];

      const score = calculateScore(findings);
      expect(score).toBe(0);
    });

    it('should cap score at 100 (not go over)', () => {
      const findings: Finding[] = [
        {
          id: 'test-1',
          severity: 'info',
          category: 'performance',
          title: 'Negative Weight',
          description: 'Test',
          weight: -20,
          metadata: {},
        },
      ];

      const score = calculateScore(findings);
      expect(score).toBe(100);
    });

    it('should handle zero weight findings', () => {
      const findings: Finding[] = [
        {
          id: 'test-1',
          severity: 'info',
          category: 'performance',
          title: 'No Impact',
          description: 'Test',
          weight: 0,
          metadata: {},
        },
        {
          id: 'test-2',
          severity: 'info',
          category: 'performance',
          title: 'No Impact 2',
          description: 'Test',
          weight: 0,
          metadata: {},
        },
      ];

      const score = calculateScore(findings);
      expect(score).toBe(100);
    });

    it('should handle fractional weights', () => {
      const findings: Finding[] = [
        {
          id: 'test-1',
          severity: 'warning',
          category: 'performance',
          title: 'Small Issue',
          description: 'Test',
          weight: 2.5,
          metadata: {},
        },
        {
          id: 'test-2',
          severity: 'warning',
          category: 'performance',
          title: 'Small Issue 2',
          description: 'Test',
          weight: 3.7,
          metadata: {},
        },
      ];

      const score = calculateScore(findings);
      expect(score).toBeCloseTo(93.8, 1); // 100 - 2.5 - 3.7
    });

    it('should handle large number of small findings', () => {
      const findings: Finding[] = Array.from({ length: 50 }, (_, i) => ({
        id: `test-${i}`,
        severity: 'info' as const,
        category: 'performance' as const,
        title: `Finding ${i}`,
        description: 'Test',
        weight: 1,
        metadata: {},
      }));

      const score = calculateScore(findings);
      expect(score).toBe(50); // 100 - 50
    });

    it('should handle exact boundary at 0', () => {
      const findings: Finding[] = [
        {
          id: 'test-1',
          severity: 'error',
          category: 'security',
          title: 'Major Issue',
          description: 'Test',
          weight: 100,
          metadata: {},
        },
      ];

      const score = calculateScore(findings);
      expect(score).toBe(0);
    });

    it('should handle exact boundary at 100', () => {
      const findings: Finding[] = [
        {
          id: 'test-1',
          severity: 'info',
          category: 'performance',
          title: 'No Impact',
          description: 'Test',
          weight: 0,
          metadata: {},
        },
      ];

      const score = calculateScore(findings);
      expect(score).toBe(100);
    });

    it('should handle mixed positive and negative weights', () => {
      const findings: Finding[] = [
        {
          id: 'test-1',
          severity: 'warning',
          category: 'performance',
          title: 'Issue',
          description: 'Test',
          weight: 20,
          metadata: {},
        },
        {
          id: 'test-2',
          severity: 'info',
          category: 'performance',
          title: 'Bonus',
          description: 'Test',
          weight: -5,
          metadata: {},
        },
      ];

      const score = calculateScore(findings);
      expect(score).toBe(85); // 100 - 20 + 5
    });

    it('should return integer when result is whole number', () => {
      const findings: Finding[] = [
        {
          id: 'test-1',
          severity: 'warning',
          category: 'performance',
          title: 'Issue',
          description: 'Test',
          weight: 15,
          metadata: {},
        },
      ];

      const score = calculateScore(findings);
      expect(score).toBe(85);
      expect(Number.isInteger(score)).toBe(true);
    });

    it('should handle findings with different severity levels', () => {
      const findings: Finding[] = [
        {
          id: 'test-1',
          severity: 'error',
          category: 'security',
          title: 'Error',
          description: 'Test',
          weight: 30,
          metadata: {},
        },
        {
          id: 'test-2',
          severity: 'warning',
          category: 'performance',
          title: 'Warning',
          description: 'Test',
          weight: 10,
          metadata: {},
        },
        {
          id: 'test-3',
          severity: 'info',
          category: 'style',
          title: 'Info',
          description: 'Test',
          weight: 5,
          metadata: {},
        },
      ];

      const score = calculateScore(findings);
      expect(score).toBe(55); // 100 - 30 - 10 - 5
    });

    it('should ignore finding metadata and only use weight', () => {
      const findings: Finding[] = [
        {
          id: 'test-1',
          severity: 'warning',
          category: 'performance',
          title: 'Issue',
          description: 'Test',
          weight: 20,
          metadata: {
            someValue: 999,
            anotherValue: 'ignored',
          },
        },
      ];

      const score = calculateScore(findings);
      expect(score).toBe(80);
    });

    it('should handle very small weights', () => {
      const findings: Finding[] = [
        {
          id: 'test-1',
          severity: 'info',
          category: 'performance',
          title: 'Tiny Issue',
          description: 'Test',
          weight: 0.001,
          metadata: {},
        },
      ];

      const score = calculateScore(findings);
      expect(score).toBeCloseTo(99.999, 3);
    });

    it('should handle weights that sum to exactly 100', () => {
      const findings: Finding[] = [
        {
          id: 'test-1',
          severity: 'error',
          category: 'security',
          title: 'Issue 1',
          description: 'Test',
          weight: 50,
          metadata: {},
        },
        {
          id: 'test-2',
          severity: 'error',
          category: 'security',
          title: 'Issue 2',
          description: 'Test',
          weight: 50,
          metadata: {},
        },
      ];

      const score = calculateScore(findings);
      expect(score).toBe(0);
    });
  });
});
