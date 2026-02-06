import { describe, it, expect, beforeEach } from 'vitest';
import { HardlinkTracker } from '../src/fs/hardlinks.js';

describe('HardlinkTracker', () => {
  let tracker: HardlinkTracker;

  beforeEach(() => {
    tracker = new HardlinkTracker();
  });

  describe('isFirstOccurrence', () => {
    it('should return true for first occurrence of inode', () => {
      const result = tracker.isFirstOccurrence(12345, 100);
      expect(result).toBe(true);
    });

    it('should return false for second occurrence of same inode', () => {
      tracker.isFirstOccurrence(12345, 100);
      const result = tracker.isFirstOccurrence(12345, 100);
      expect(result).toBe(false);
    });

    it('should track multiple inodes independently', () => {
      expect(tracker.isFirstOccurrence(1, 100)).toBe(true);
      expect(tracker.isFirstOccurrence(2, 100)).toBe(true);
      expect(tracker.isFirstOccurrence(3, 100)).toBe(true);

      expect(tracker.isFirstOccurrence(1, 100)).toBe(false);
      expect(tracker.isFirstOccurrence(2, 100)).toBe(false);
      expect(tracker.isFirstOccurrence(3, 100)).toBe(false);
    });

    it('should treat different devices as different inodes', () => {
      expect(tracker.isFirstOccurrence(12345, 100)).toBe(true);
      expect(tracker.isFirstOccurrence(12345, 200)).toBe(true);

      expect(tracker.isFirstOccurrence(12345, 100)).toBe(false);
      expect(tracker.isFirstOccurrence(12345, 200)).toBe(false);
    });

    it('should handle same inode on multiple devices', () => {
      const inode = 999;

      expect(tracker.isFirstOccurrence(inode, 1)).toBe(true);
      expect(tracker.isFirstOccurrence(inode, 2)).toBe(true);
      expect(tracker.isFirstOccurrence(inode, 3)).toBe(true);

      expect(tracker.isFirstOccurrence(inode, 1)).toBe(false);
      expect(tracker.isFirstOccurrence(inode, 2)).toBe(false);
      expect(tracker.isFirstOccurrence(inode, 3)).toBe(false);
    });

    it('should handle zero inode', () => {
      expect(tracker.isFirstOccurrence(0, 100)).toBe(true);
      expect(tracker.isFirstOccurrence(0, 100)).toBe(false);
    });

    it('should handle large inode numbers', () => {
      const largeInode = 9999999999;
      expect(tracker.isFirstOccurrence(largeInode, 100)).toBe(true);
      expect(tracker.isFirstOccurrence(largeInode, 100)).toBe(false);
    });
  });

  describe('getUniqueCount', () => {
    it('should return 0 for empty tracker', () => {
      expect(tracker.getUniqueCount()).toBe(0);
    });

    it('should return count of unique inodes', () => {
      tracker.isFirstOccurrence(1, 100);
      expect(tracker.getUniqueCount()).toBe(1);

      tracker.isFirstOccurrence(2, 100);
      expect(tracker.getUniqueCount()).toBe(2);

      tracker.isFirstOccurrence(3, 100);
      expect(tracker.getUniqueCount()).toBe(3);
    });

    it('should not increment count for duplicate inode', () => {
      tracker.isFirstOccurrence(1, 100);
      tracker.isFirstOccurrence(1, 100);
      tracker.isFirstOccurrence(1, 100);
      expect(tracker.getUniqueCount()).toBe(1);
    });

    it('should count same inode on different devices separately', () => {
      tracker.isFirstOccurrence(1, 100);
      tracker.isFirstOccurrence(1, 200);
      tracker.isFirstOccurrence(1, 300);
      expect(tracker.getUniqueCount()).toBe(3);
    });

    it('should maintain accurate count with mixed operations', () => {
      tracker.isFirstOccurrence(1, 100);
      tracker.isFirstOccurrence(2, 100);
      tracker.isFirstOccurrence(1, 100); // duplicate
      tracker.isFirstOccurrence(3, 100);
      tracker.isFirstOccurrence(2, 100); // duplicate
      tracker.isFirstOccurrence(4, 100);

      expect(tracker.getUniqueCount()).toBe(4);
    });
  });

  describe('reset', () => {
    it('should clear all tracked inodes', () => {
      tracker.isFirstOccurrence(1, 100);
      tracker.isFirstOccurrence(2, 100);
      tracker.isFirstOccurrence(3, 100);

      expect(tracker.getUniqueCount()).toBe(3);

      tracker.reset();

      expect(tracker.getUniqueCount()).toBe(0);
    });

    it('should allow tracking same inodes after reset', () => {
      tracker.isFirstOccurrence(1, 100);
      expect(tracker.isFirstOccurrence(1, 100)).toBe(false);

      tracker.reset();

      expect(tracker.isFirstOccurrence(1, 100)).toBe(true);
      expect(tracker.isFirstOccurrence(1, 100)).toBe(false);
    });

    it('should handle multiple resets', () => {
      tracker.isFirstOccurrence(1, 100);
      tracker.reset();
      tracker.reset();
      tracker.reset();

      expect(tracker.getUniqueCount()).toBe(0);
      expect(tracker.isFirstOccurrence(1, 100)).toBe(true);
    });

    it('should reset empty tracker without errors', () => {
      expect(() => tracker.reset()).not.toThrow();
      expect(tracker.getUniqueCount()).toBe(0);
    });
  });

  describe('integration scenarios', () => {
    it('should handle typical hardlink scenario', () => {
      // Simulate 3 hardlinks to the same file (same inode, same device)
      const inode = 12345;
      const device = 100;

      expect(tracker.isFirstOccurrence(inode, device)).toBe(true);
      expect(tracker.isFirstOccurrence(inode, device)).toBe(false);
      expect(tracker.isFirstOccurrence(inode, device)).toBe(false);

      expect(tracker.getUniqueCount()).toBe(1);
    });

    it('should handle multiple hardlink groups', () => {
      // Group 1: 2 hardlinks
      tracker.isFirstOccurrence(100, 1);
      tracker.isFirstOccurrence(100, 1);

      // Group 2: 3 hardlinks
      tracker.isFirstOccurrence(200, 1);
      tracker.isFirstOccurrence(200, 1);
      tracker.isFirstOccurrence(200, 1);

      // Group 3: 1 file (no hardlinks)
      tracker.isFirstOccurrence(300, 1);

      expect(tracker.getUniqueCount()).toBe(3);
    });

    it('should handle cross-device scenario', () => {
      // Same inode number but different devices (different files)
      expect(tracker.isFirstOccurrence(999, 1)).toBe(true);
      expect(tracker.isFirstOccurrence(999, 2)).toBe(true);
      expect(tracker.isFirstOccurrence(999, 3)).toBe(true);

      expect(tracker.getUniqueCount()).toBe(3);
    });
  });
});
