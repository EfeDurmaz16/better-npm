import { DependencyGraph } from './graph.js';

export interface DepthAnalysis {
  maxDepth: number;
  longestChain: string[];  // Array of package@version
  depthDistribution: Map<number, string[]>; // depth -> packages at that depth
  averageDepth: number;
}

interface BFSNode {
  packageId: string;
  depth: number;
  path: string[];
}

export function analyzeDepth(graph: DependencyGraph): DepthAnalysis {
  const depthMap = new Map<string, number>();
  const pathMap = new Map<string, string[]>();
  const depthDistribution = new Map<number, string[]>();

  // BFS queue starting from root dependencies
  const queue: BFSNode[] = [];
  const visited = new Set<string>();

  // Initialize with root's direct dependencies
  for (const depId of graph.root.dependencies) {
    queue.push({
      packageId: depId,
      depth: 1,
      path: [depId]
    });
  }

  let maxDepth = 0;
  let longestChainNode: BFSNode | null = null;

  // BFS traversal
  while (queue.length > 0) {
    const current = queue.shift()!;
    const { packageId, depth, path } = current;

    // Skip if we've already visited this package at a shallower or equal depth
    if (visited.has(packageId)) {
      continue;
    }

    visited.add(packageId);

    // Update depth for this package
    depthMap.set(packageId, depth);
    pathMap.set(packageId, path);

    // Update depth distribution
    if (!depthDistribution.has(depth)) {
      depthDistribution.set(depth, []);
    }
    depthDistribution.get(depth)!.push(packageId);

    // Track maximum depth and longest chain
    if (depth > maxDepth) {
      maxDepth = depth;
      longestChainNode = current;
    }

    // Get package node from graph
    const packageNode = graph.packages.get(packageId);
    if (packageNode) {
      // Add children to queue
      for (const childId of packageNode.dependencies) {
        // Only add child if it exists in the graph and hasn't been visited
        if (!visited.has(childId) && graph.packages.has(childId)) {
          queue.push({
            packageId: childId,
            depth: depth + 1,
            path: [...path, childId]
          });
        }
      }
    }
  }

  // Calculate average depth
  const totalDepth = Array.from(depthMap.values()).reduce((sum, d) => sum + d, 0);
  const averageDepth = depthMap.size > 0 ? totalDepth / depthMap.size : 0;

  // Get longest chain
  const longestChain = longestChainNode ? longestChainNode.path : [];

  return {
    maxDepth,
    longestChain,
    depthDistribution,
    averageDepth
  };
}
