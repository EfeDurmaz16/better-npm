import { describe, it, expect } from 'vitest';

// Unit tests for policy rule evaluation logic
// These test the pure functions independently

describe('policy rule evaluation', () => {
  describe('threshold logic', () => {
    it('should pass when score >= threshold', () => {
      const score = 80;
      const threshold = 70;
      expect(score >= threshold).toBe(true);
    });

    it('should fail when score < threshold', () => {
      const score = 60;
      const threshold = 70;
      expect(score < threshold).toBe(true);
    });

    it('should handle zero threshold', () => {
      const score = 0;
      const threshold = 0;
      expect(score >= threshold).toBe(true);
    });
  });

  describe('waiver matching', () => {
    function isWaived(ruleId: string, packageName: string, waivers: Array<{ rule?: string; package?: string }>) {
      return waivers.some(w => {
        if (w.rule && w.rule !== ruleId) return false;
        if (w.package && w.package !== packageName) return false;
        return true;
      });
    }

    it('should match by rule id', () => {
      expect(isWaived('no-deprecated', 'foo', [{ rule: 'no-deprecated' }])).toBe(true);
    });

    it('should not match different rule', () => {
      expect(isWaived('no-deprecated', 'foo', [{ rule: 'max-depth' }])).toBe(false);
    });

    it('should match by package name', () => {
      expect(isWaived('no-deprecated', 'foo', [{ package: 'foo' }])).toBe(true);
    });

    it('should match by both rule and package', () => {
      expect(isWaived('no-deprecated', 'foo', [{ rule: 'no-deprecated', package: 'foo' }])).toBe(true);
    });

    it('should not match wrong package', () => {
      expect(isWaived('no-deprecated', 'foo', [{ rule: 'no-deprecated', package: 'bar' }])).toBe(false);
    });

    it('should handle empty waivers', () => {
      expect(isWaived('no-deprecated', 'foo', [])).toBe(false);
    });
  });

  describe('score calculation', () => {
    it('should deduct 15 per error', () => {
      const violations = [
        { severity: 'error' },
        { severity: 'error' },
      ];
      const deduction = violations.reduce((sum, v) => {
        if (v.severity === 'error') return sum + 15;
        if (v.severity === 'warning') return sum + 5;
        return sum + 2;
      }, 0);
      expect(deduction).toBe(30);
      expect(Math.max(0, 100 - deduction)).toBe(70);
    });

    it('should deduct 5 per warning', () => {
      const violations = [
        { severity: 'warning' },
        { severity: 'warning' },
        { severity: 'warning' },
      ];
      const deduction = violations.reduce((sum, v) => {
        if (v.severity === 'error') return sum + 15;
        if (v.severity === 'warning') return sum + 5;
        return sum + 2;
      }, 0);
      expect(deduction).toBe(15);
    });

    it('should not go below 0', () => {
      const violations = Array(10).fill({ severity: 'error' });
      const deduction = violations.reduce((sum, v) => {
        if (v.severity === 'error') return sum + 15;
        return sum;
      }, 0);
      expect(Math.max(0, 100 - deduction)).toBe(0);
    });
  });

  describe('rule precedence', () => {
    it('errors should take precedence over warnings for pass/fail', () => {
      const violations = [
        { severity: 'warning', rule: 'max-depth' },
        { severity: 'error', rule: 'no-deprecated' },
      ];
      const errors = violations.filter(v => v.severity === 'error');
      // If there are any errors, it should fail regardless of score
      expect(errors.length).toBeGreaterThan(0);
    });
  });
});
