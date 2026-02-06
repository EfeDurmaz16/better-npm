import { describe, it, expect } from 'vitest';
import { formatBytes } from '../src/fs/size.js';

describe('Size Utilities', () => {
  describe('formatBytes', () => {
    it('should format 0 bytes', () => {
      expect(formatBytes(0)).toBe('0 B');
    });

    it('should format bytes', () => {
      expect(formatBytes(1)).toBe('1.00 B');
      expect(formatBytes(512)).toBe('512.00 B');
      expect(formatBytes(1023)).toBe('1023.00 B');
    });

    it('should format kilobytes', () => {
      expect(formatBytes(1024)).toBe('1.00 KB');
      expect(formatBytes(1536)).toBe('1.50 KB');
      expect(formatBytes(2048)).toBe('2.00 KB');
      expect(formatBytes(10240)).toBe('10.00 KB');
    });

    it('should format megabytes', () => {
      expect(formatBytes(1024 * 1024)).toBe('1.00 MB');
      expect(formatBytes(1024 * 1024 * 1.5)).toBe('1.50 MB');
      expect(formatBytes(1024 * 1024 * 10)).toBe('10.00 MB');
      expect(formatBytes(1024 * 1024 * 100)).toBe('100.00 MB');
    });

    it('should format gigabytes', () => {
      expect(formatBytes(1024 * 1024 * 1024)).toBe('1.00 GB');
      expect(formatBytes(1024 * 1024 * 1024 * 2.5)).toBe('2.50 GB');
      expect(formatBytes(1024 * 1024 * 1024 * 10)).toBe('10.00 GB');
    });

    it('should format terabytes', () => {
      expect(formatBytes(1024 * 1024 * 1024 * 1024)).toBe('1.00 TB');
      expect(formatBytes(1024 * 1024 * 1024 * 1024 * 5)).toBe('5.00 TB');
    });

    it('should handle fractional values', () => {
      expect(formatBytes(1536)).toBe('1.50 KB');
      expect(formatBytes(1024 * 1024 * 1.234)).toBe('1.23 MB');
      expect(formatBytes(1024 * 1024 * 1024 * 3.456)).toBe('3.46 GB');
    });

    it('should handle very large numbers', () => {
      const largeNumber = 1024 * 1024 * 1024 * 1024 * 100;
      expect(formatBytes(largeNumber)).toBe('100.00 TB');
    });

    it('should handle very small numbers', () => {
      expect(formatBytes(1)).toBe('1.00 B');
      expect(formatBytes(10)).toBe('10.00 B');
      expect(formatBytes(100)).toBe('100.00 B');
    });

    it('should use correct rounding', () => {
      // 1.996 KB should round to 2.00 KB
      expect(formatBytes(2044)).toBe('2.00 KB');
      // 1.994 KB should round to 1.99 KB
      expect(formatBytes(2042)).toBe('1.99 KB');
    });
  });
});
