/**
 * Track hardlinks to avoid counting the same file multiple times
 */
export class HardlinkTracker {
  private seen = new Map<string, boolean>();

  /**
   * Check if we've seen this inode+dev combination before
   * @param ino inode number
   * @param dev device number
   * @returns true if this is the first time seeing this inode
   */
  isFirstOccurrence(ino: number, dev: number): boolean {
    const key = `${dev}:${ino}`;
    if (this.seen.has(key)) {
      return false;
    }
    this.seen.set(key, true);
    return true;
  }

  /**
   * Get the count of unique inodes tracked
   */
  getUniqueCount(): number {
    return this.seen.size;
  }

  /**
   * Reset the tracker
   */
  reset(): void {
    this.seen.clear();
  }
}
