import { describe, it, expect } from 'vitest';
import { detectDuplicates } from '../src/analyzer/duplicates.js';
import { DependencyGraph, DependencyNode } from '../src/analyzer/graph.js';

describe('Duplicate Detection', () => {
  function createMockGraph(packages: DependencyNode[]): DependencyGraph {
    const packagesMap = new Map<string, DependencyNode>();
    const directDeps: string[] = [];

    packages.forEach(pkg => {
      // Use path as part of the key to allow multiple instances of same version
      const key = `${pkg.name}@${pkg.version}:${pkg.path}`;
      packagesMap.set(key, pkg);
      if (pkg.isDirect) {
        directDeps.push(key);
      }
    });

    return {
      root: {
        name: 'test-project',
        version: '1.0.0',
        path: '/test',
        dependencies: directDeps,
      },
      packages: packagesMap,
      totalPackages: packages.length,
    };
  }

  describe('detectDuplicates', () => {
    it('should detect no duplicates when all packages are unique', () => {
      const graph = createMockGraph([
        {
          name: 'lodash',
          version: '4.17.21',
          path: '/node_modules/lodash',
          size: 1000000,
          dependencies: [],
          isDirect: true,
        },
        {
          name: 'axios',
          version: '1.0.0',
          path: '/node_modules/axios',
          size: 500000,
          dependencies: [],
          isDirect: true,
        },
      ]);

      const result = detectDuplicates(graph);

      expect(result.duplicates).toHaveLength(0);
      expect(result.totalDuplicatePackages).toBe(0);
      expect(result.totalWastedBytes).toBe(0);
    });

    it('should detect duplicate packages with different versions', () => {
      const graph = createMockGraph([
        {
          name: 'lodash',
          version: '4.17.21',
          path: '/node_modules/lodash',
          size: 1000000,
          dependencies: [],
          isDirect: true,
        },
        {
          name: 'lodash',
          version: '4.17.20',
          path: '/node_modules/pkg-a/node_modules/lodash',
          size: 990000,
          dependencies: [],
          isDirect: false,
        },
      ]);

      const result = detectDuplicates(graph);

      expect(result.duplicates).toHaveLength(1);
      expect(result.duplicates[0].package).toBe('lodash');
      expect(result.duplicates[0].versions).toHaveLength(2);
      expect(result.duplicates[0].totalInstances).toBe(2);
      expect(result.totalDuplicatePackages).toBe(1);
    });

    it('should calculate wasted bytes correctly', () => {
      const graph = createMockGraph([
        {
          name: 'lodash',
          version: '4.17.21',
          path: '/node_modules/lodash',
          size: 1000000,
          dependencies: [],
          isDirect: true,
        },
        {
          name: 'lodash',
          version: '4.17.20',
          path: '/node_modules/pkg-a/node_modules/lodash',
          size: 1000000,
          dependencies: [],
          isDirect: false,
        },
      ]);

      const result = detectDuplicates(graph);

      // Total size is 2,000,000, but we only need 1,000,000
      // Wasted bytes should be approximately 1,000,000
      expect(result.totalWastedBytes).toBeGreaterThan(0);
      expect(result.duplicates[0].wastedBytes).toBeGreaterThan(0);
    });

    it('should suggest highest semver version', () => {
      const graph = createMockGraph([
        {
          name: 'react',
          version: '17.0.0',
          path: '/node_modules/pkg-a/node_modules/react',
          size: 500000,
          dependencies: [],
          isDirect: false,
        },
        {
          name: 'react',
          version: '18.2.0',
          path: '/node_modules/react',
          size: 550000,
          dependencies: [],
          isDirect: true,
        },
        {
          name: 'react',
          version: '18.1.0',
          path: '/node_modules/pkg-b/node_modules/react',
          size: 540000,
          dependencies: [],
          isDirect: false,
        },
      ]);

      const result = detectDuplicates(graph);

      expect(result.duplicates[0].suggestedVersion).toBe('18.2.0');
    });

    it('should sort versions by semver descending', () => {
      const graph = createMockGraph([
        {
          name: 'package',
          version: '1.0.0',
          path: '/node_modules/p1',
          size: 100000,
          dependencies: [],
          isDirect: false,
        },
        {
          name: 'package',
          version: '2.5.3',
          path: '/node_modules/p2',
          size: 100000,
          dependencies: [],
          isDirect: false,
        },
        {
          name: 'package',
          version: '2.1.0',
          path: '/node_modules/p3',
          size: 100000,
          dependencies: [],
          isDirect: false,
        },
      ]);

      const result = detectDuplicates(graph);

      expect(result.duplicates[0].versions[0].version).toBe('2.5.3');
      expect(result.duplicates[0].versions[1].version).toBe('2.1.0');
      expect(result.duplicates[0].versions[2].version).toBe('1.0.0');
    });

    it('should handle multiple duplicate packages', () => {
      const graph = createMockGraph([
        { name: 'lodash', version: '4.17.21', path: '/a', size: 1000000, dependencies: [], isDirect: true },
        { name: 'lodash', version: '4.17.20', path: '/b', size: 1000000, dependencies: [], isDirect: false },
        { name: 'axios', version: '1.0.0', path: '/c', size: 500000, dependencies: [], isDirect: true },
        { name: 'axios', version: '0.27.0', path: '/d', size: 480000, dependencies: [], isDirect: false },
      ]);

      const result = detectDuplicates(graph);

      expect(result.duplicates).toHaveLength(2);
      expect(result.totalDuplicatePackages).toBe(2);
    });

    it('should sort duplicates by wasted bytes descending', () => {
      const graph = createMockGraph([
        { name: 'small', version: '1.0.0', path: '/a', size: 10000, dependencies: [], isDirect: false },
        { name: 'small', version: '2.0.0', path: '/b', size: 10000, dependencies: [], isDirect: false },
        { name: 'large', version: '1.0.0', path: '/c', size: 5000000, dependencies: [], isDirect: false },
        { name: 'large', version: '2.0.0', path: '/d', size: 5000000, dependencies: [], isDirect: false },
      ]);

      const result = detectDuplicates(graph);

      expect(result.duplicates[0].package).toBe('large');
      expect(result.duplicates[1].package).toBe('small');
    });

    it('should track paths for each version', () => {
      const graph = createMockGraph([
        {
          name: 'pkg',
          version: '1.0.0',
          path: '/node_modules/pkg',
          size: 100000,
          dependencies: [],
          isDirect: true,
        },
        {
          name: 'pkg',
          version: '1.0.0',
          path: '/node_modules/a/node_modules/pkg',
          size: 100000,
          dependencies: [],
          isDirect: false,
        },
        {
          name: 'pkg',
          version: '2.0.0',
          path: '/node_modules/b/node_modules/pkg',
          size: 110000,
          dependencies: [],
          isDirect: false,
        },
      ]);

      const result = detectDuplicates(graph);

      const v1 = result.duplicates[0].versions.find(v => v.version === '1.0.0');
      const v2 = result.duplicates[0].versions.find(v => v.version === '2.0.0');

      expect(v1?.count).toBe(2);
      expect(v1?.paths).toHaveLength(2);
      expect(v2?.count).toBe(1);
      expect(v2?.paths).toHaveLength(1);
    });

    it('should handle version comparison edge cases', () => {
      const graph = createMockGraph([
        { name: 'pkg', version: '1.0.0', path: '/a', size: 100000, dependencies: [], isDirect: false },
        { name: 'pkg', version: '1.0.0-beta', path: '/b', size: 100000, dependencies: [], isDirect: false },
        { name: 'pkg', version: '1.0.10', path: '/c', size: 100000, dependencies: [], isDirect: false },
        { name: 'pkg', version: '1.0.2', path: '/d', size: 100000, dependencies: [], isDirect: false },
      ]);

      const result = detectDuplicates(graph);

      expect(result.duplicates).toHaveLength(1);
      expect(result.duplicates[0].versions).toHaveLength(4);
    });

    it('should handle empty graph', () => {
      const graph = createMockGraph([]);

      const result = detectDuplicates(graph);

      expect(result.duplicates).toHaveLength(0);
      expect(result.totalDuplicatePackages).toBe(0);
      expect(result.totalWastedBytes).toBe(0);
    });

    it('should not report negative wasted bytes', () => {
      const graph = createMockGraph([
        { name: 'pkg', version: '1.0.0', path: '/a', size: 100000, dependencies: [], isDirect: false },
        { name: 'pkg', version: '2.0.0', path: '/b', size: 50000, dependencies: [], isDirect: false },
      ]);

      const result = detectDuplicates(graph);

      expect(result.duplicates[0].wastedBytes).toBeGreaterThanOrEqual(0);
      expect(result.totalWastedBytes).toBeGreaterThanOrEqual(0);
    });

    it('should aggregate size correctly for multiple instances of same version', () => {
      const graph = createMockGraph([
        { name: 'pkg', version: '1.0.0', path: '/a', size: 100000, dependencies: [], isDirect: false },
        { name: 'pkg', version: '1.0.0', path: '/b', size: 100000, dependencies: [], isDirect: false },
        { name: 'pkg', version: '1.0.0', path: '/c', size: 100000, dependencies: [], isDirect: false },
        { name: 'pkg', version: '2.0.0', path: '/d', size: 110000, dependencies: [], isDirect: false },
      ]);

      const result = detectDuplicates(graph);

      const v1 = result.duplicates[0].versions.find(v => v.version === '1.0.0');

      expect(v1?.count).toBe(3);
      expect(v1?.size).toBe(300000);
    });
  });
});
