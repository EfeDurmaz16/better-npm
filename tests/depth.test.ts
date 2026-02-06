import { describe, it, expect } from 'vitest';
import { analyzeDepth } from '../src/analyzer/depth.js';
import { DependencyGraph } from '../src/analyzer/graph.js';

describe('Depth Analysis', () => {
  describe('analyzeDepth', () => {
    it('should handle graph with no dependencies', () => {
      const graph: DependencyGraph = {
        root: {
          name: 'test-project',
          version: '1.0.0',
          path: '/test',
          dependencies: [],
        },
        packages: new Map(),
        totalPackages: 0,
      };

      const result = analyzeDepth(graph);

      expect(result.maxDepth).toBe(0);
      expect(result.longestChain).toEqual([]);
      expect(result.averageDepth).toBe(0);
      expect(result.depthDistribution.size).toBe(0);
    });

    it('should calculate depth for single level dependencies', () => {
      const graph: DependencyGraph = {
        root: {
          name: 'test-project',
          version: '1.0.0',
          path: '/test',
          dependencies: ['lodash@4.17.21', 'axios@1.0.0'],
        },
        packages: new Map([
          [
            'lodash@4.17.21',
            {
              name: 'lodash',
              version: '4.17.21',
              path: '/node_modules/lodash',
              size: 1000000,
              dependencies: [],
              isDirect: true,
            },
          ],
          [
            'axios@1.0.0',
            {
              name: 'axios',
              version: '1.0.0',
              path: '/node_modules/axios',
              size: 500000,
              dependencies: [],
              isDirect: true,
            },
          ],
        ]),
        totalPackages: 2,
      };

      const result = analyzeDepth(graph);

      expect(result.maxDepth).toBe(1);
      expect(result.averageDepth).toBe(1);
      expect(result.depthDistribution.get(1)).toHaveLength(2);
    });

    it('should calculate depth for nested dependencies', () => {
      const graph: DependencyGraph = {
        root: {
          name: 'test-project',
          version: '1.0.0',
          path: '/test',
          dependencies: ['a@1.0.0'],
        },
        packages: new Map([
          [
            'a@1.0.0',
            {
              name: 'a',
              version: '1.0.0',
              path: '/node_modules/a',
              size: 100000,
              dependencies: ['b@1.0.0'],
              isDirect: true,
            },
          ],
          [
            'b@1.0.0',
            {
              name: 'b',
              version: '1.0.0',
              path: '/node_modules/b',
              size: 100000,
              dependencies: ['c@1.0.0'],
              isDirect: false,
            },
          ],
          [
            'c@1.0.0',
            {
              name: 'c',
              version: '1.0.0',
              path: '/node_modules/c',
              size: 100000,
              dependencies: [],
              isDirect: false,
            },
          ],
        ]),
        totalPackages: 3,
      };

      const result = analyzeDepth(graph);

      expect(result.maxDepth).toBe(3);
      expect(result.longestChain).toEqual(['a@1.0.0', 'b@1.0.0', 'c@1.0.0']);
      expect(result.depthDistribution.get(1)).toEqual(['a@1.0.0']);
      expect(result.depthDistribution.get(2)).toEqual(['b@1.0.0']);
      expect(result.depthDistribution.get(3)).toEqual(['c@1.0.0']);
    });

    it('should find longest chain in tree with multiple branches', () => {
      const graph: DependencyGraph = {
        root: {
          name: 'test-project',
          version: '1.0.0',
          path: '/test',
          dependencies: ['a@1.0.0', 'x@1.0.0'],
        },
        packages: new Map([
          [
            'a@1.0.0',
            {
              name: 'a',
              version: '1.0.0',
              path: '/node_modules/a',
              size: 100000,
              dependencies: ['b@1.0.0'],
              isDirect: true,
            },
          ],
          [
            'b@1.0.0',
            {
              name: 'b',
              version: '1.0.0',
              path: '/node_modules/b',
              size: 100000,
              dependencies: ['c@1.0.0'],
              isDirect: false,
            },
          ],
          [
            'c@1.0.0',
            {
              name: 'c',
              version: '1.0.0',
              path: '/node_modules/c',
              size: 100000,
              dependencies: ['d@1.0.0'],
              isDirect: false,
            },
          ],
          [
            'd@1.0.0',
            {
              name: 'd',
              version: '1.0.0',
              path: '/node_modules/d',
              size: 100000,
              dependencies: [],
              isDirect: false,
            },
          ],
          [
            'x@1.0.0',
            {
              name: 'x',
              version: '1.0.0',
              path: '/node_modules/x',
              size: 100000,
              dependencies: ['y@1.0.0'],
              isDirect: true,
            },
          ],
          [
            'y@1.0.0',
            {
              name: 'y',
              version: '1.0.0',
              path: '/node_modules/y',
              size: 100000,
              dependencies: [],
              isDirect: false,
            },
          ],
        ]),
        totalPackages: 6,
      };

      const result = analyzeDepth(graph);

      expect(result.maxDepth).toBe(4);
      expect(result.longestChain).toEqual(['a@1.0.0', 'b@1.0.0', 'c@1.0.0', 'd@1.0.0']);
    });

    it('should calculate average depth correctly', () => {
      const graph: DependencyGraph = {
        root: {
          name: 'test-project',
          version: '1.0.0',
          path: '/test',
          dependencies: ['a@1.0.0', 'b@1.0.0', 'c@1.0.0'],
        },
        packages: new Map([
          [
            'a@1.0.0',
            {
              name: 'a',
              version: '1.0.0',
              path: '/node_modules/a',
              size: 100000,
              dependencies: [],
              isDirect: true,
            },
          ],
          [
            'b@1.0.0',
            {
              name: 'b',
              version: '1.0.0',
              path: '/node_modules/b',
              size: 100000,
              dependencies: ['d@1.0.0'],
              isDirect: true,
            },
          ],
          [
            'c@1.0.0',
            {
              name: 'c',
              version: '1.0.0',
              path: '/node_modules/c',
              size: 100000,
              dependencies: ['e@1.0.0'],
              isDirect: true,
            },
          ],
          [
            'd@1.0.0',
            {
              name: 'd',
              version: '1.0.0',
              path: '/node_modules/d',
              size: 100000,
              dependencies: [],
              isDirect: false,
            },
          ],
          [
            'e@1.0.0',
            {
              name: 'e',
              version: '1.0.0',
              path: '/node_modules/e',
              size: 100000,
              dependencies: ['f@1.0.0'],
              isDirect: false,
            },
          ],
          [
            'f@1.0.0',
            {
              name: 'f',
              version: '1.0.0',
              path: '/node_modules/f',
              size: 100000,
              dependencies: [],
              isDirect: false,
            },
          ],
        ]),
        totalPackages: 6,
      };

      const result = analyzeDepth(graph);

      // Depths: a=1, b=1, c=1, d=2, e=2, f=3
      // Average = (1+1+1+2+2+3) / 6 = 10/6 = 1.67
      expect(result.averageDepth).toBeCloseTo(1.67, 1);
    });

    it('should handle circular dependencies gracefully', () => {
      // Create a circular dependency scenario
      // Note: Real package managers prevent this, but we should handle it
      const graph: DependencyGraph = {
        root: {
          name: 'test-project',
          version: '1.0.0',
          path: '/test',
          dependencies: ['a@1.0.0'],
        },
        packages: new Map([
          [
            'a@1.0.0',
            {
              name: 'a',
              version: '1.0.0',
              path: '/node_modules/a',
              size: 100000,
              dependencies: ['b@1.0.0'],
              isDirect: true,
            },
          ],
          [
            'b@1.0.0',
            {
              name: 'b',
              version: '1.0.0',
              path: '/node_modules/b',
              size: 100000,
              dependencies: ['a@1.0.0'], // Circular reference
              isDirect: false,
            },
          ],
        ]),
        totalPackages: 2,
      };

      const result = analyzeDepth(graph);

      // Should not hang or crash
      expect(result.maxDepth).toBeGreaterThan(0);
      expect(result.longestChain.length).toBeGreaterThan(0);
    });

    it('should handle package with multiple parents at same depth', () => {
      const graph: DependencyGraph = {
        root: {
          name: 'test-project',
          version: '1.0.0',
          path: '/test',
          dependencies: ['a@1.0.0', 'b@1.0.0'],
        },
        packages: new Map([
          [
            'a@1.0.0',
            {
              name: 'a',
              version: '1.0.0',
              path: '/node_modules/a',
              size: 100000,
              dependencies: ['c@1.0.0'],
              isDirect: true,
            },
          ],
          [
            'b@1.0.0',
            {
              name: 'b',
              version: '1.0.0',
              path: '/node_modules/b',
              size: 100000,
              dependencies: ['c@1.0.0'],
              isDirect: true,
            },
          ],
          [
            'c@1.0.0',
            {
              name: 'c',
              version: '1.0.0',
              path: '/node_modules/c',
              size: 100000,
              dependencies: [],
              isDirect: false,
            },
          ],
        ]),
        totalPackages: 3,
      };

      const result = analyzeDepth(graph);

      // Package 'c' should only be counted once
      expect(result.depthDistribution.get(2)).toEqual(['c@1.0.0']);
    });

    it('should build correct depth distribution', () => {
      const graph: DependencyGraph = {
        root: {
          name: 'test-project',
          version: '1.0.0',
          path: '/test',
          dependencies: ['a@1.0.0', 'b@1.0.0'],
        },
        packages: new Map([
          [
            'a@1.0.0',
            {
              name: 'a',
              version: '1.0.0',
              path: '/node_modules/a',
              size: 100000,
              dependencies: ['c@1.0.0', 'd@1.0.0'],
              isDirect: true,
            },
          ],
          [
            'b@1.0.0',
            {
              name: 'b',
              version: '1.0.0',
              path: '/node_modules/b',
              size: 100000,
              dependencies: [],
              isDirect: true,
            },
          ],
          [
            'c@1.0.0',
            {
              name: 'c',
              version: '1.0.0',
              path: '/node_modules/c',
              size: 100000,
              dependencies: ['e@1.0.0'],
              isDirect: false,
            },
          ],
          [
            'd@1.0.0',
            {
              name: 'd',
              version: '1.0.0',
              path: '/node_modules/d',
              size: 100000,
              dependencies: [],
              isDirect: false,
            },
          ],
          [
            'e@1.0.0',
            {
              name: 'e',
              version: '1.0.0',
              path: '/node_modules/e',
              size: 100000,
              dependencies: [],
              isDirect: false,
            },
          ],
        ]),
        totalPackages: 5,
      };

      const result = analyzeDepth(graph);

      expect(result.depthDistribution.get(1)).toHaveLength(2); // a, b
      expect(result.depthDistribution.get(2)).toHaveLength(2); // c, d
      expect(result.depthDistribution.get(3)).toHaveLength(1); // e
    });

    it('should handle deep dependency chain', () => {
      const packages = new Map();
      const deps = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];

      for (let i = 0; i < deps.length; i++) {
        const name = deps[i];
        const nextDep = i < deps.length - 1 ? [`${deps[i + 1]}@1.0.0`] : [];
        packages.set(`${name}@1.0.0`, {
          name,
          version: '1.0.0',
          path: `/node_modules/${name}`,
          size: 100000,
          dependencies: nextDep,
          isDirect: i === 0,
        });
      }

      const graph: DependencyGraph = {
        root: {
          name: 'test-project',
          version: '1.0.0',
          path: '/test',
          dependencies: ['a@1.0.0'],
        },
        packages,
        totalPackages: deps.length,
      };

      const result = analyzeDepth(graph);

      expect(result.maxDepth).toBe(10);
      expect(result.longestChain).toHaveLength(10);
      expect(result.longestChain[0]).toBe('a@1.0.0');
      expect(result.longestChain[9]).toBe('j@1.0.0');
    });

    it('should handle missing package nodes gracefully', () => {
      const graph: DependencyGraph = {
        root: {
          name: 'test-project',
          version: '1.0.0',
          path: '/test',
          dependencies: ['a@1.0.0'],
        },
        packages: new Map([
          [
            'a@1.0.0',
            {
              name: 'a',
              version: '1.0.0',
              path: '/node_modules/a',
              size: 100000,
              dependencies: ['missing@1.0.0'], // Reference to non-existent package
              isDirect: true,
            },
          ],
        ]),
        totalPackages: 1,
      };

      const result = analyzeDepth(graph);

      // Should not crash, only process existing packages
      expect(result.maxDepth).toBe(1);
      expect(result.depthDistribution.get(1)).toEqual(['a@1.0.0']);
    });
  });
});
