/**
 * Topological sort for workspace package dependency graphs.
 * Supports cycle detection and parallel execution levels.
 * Zero dependencies — uses only built-in data structures.
 */

/**
 * Topologically sort workspace packages by their inter-workspace dependencies.
 * Uses Kahn's algorithm for deterministic, stable ordering.
 *
 * @param {Array<{name: string, workspaceDeps: string[]}>} packages - Workspace packages
 * @returns {{
 *   ok: boolean,
 *   sorted: string[],
 *   levels: string[][],
 *   cycles: string[][] | null,
 *   reason?: string
 * }}
 *
 * `sorted` is a flat topological order (build these first to last).
 * `levels` groups packages that can be built in parallel within each level.
 * `cycles` is non-null if circular dependencies are detected.
 */
export function topoSort(packages) {
  const graph = new Map();    // name -> Set of dependency names
  const inDegree = new Map(); // name -> number of incoming edges
  const allNames = new Set();

  // Build adjacency graph (only workspace-internal edges)
  for (const pkg of packages) {
    const name = pkg.name;
    allNames.add(name);
    if (!graph.has(name)) graph.set(name, new Set());
    if (!inDegree.has(name)) inDegree.set(name, 0);

    for (const dep of pkg.workspaceDeps) {
      if (!allNames.has(dep)) allNames.add(dep);
      if (!graph.has(dep)) graph.set(dep, new Set());
      if (!inDegree.has(dep)) inDegree.set(dep, 0);

      // Edge: dep -> name (name depends on dep, so dep must come first)
      graph.get(dep).add(name);
      inDegree.set(name, (inDegree.get(name) ?? 0) + 1);
    }
  }

  // Kahn's algorithm with level tracking
  const sorted = [];
  const levels = [];
  let queue = [];

  // Start with nodes that have no dependencies
  for (const name of allNames) {
    if ((inDegree.get(name) ?? 0) === 0) {
      queue.push(name);
    }
  }
  queue.sort(); // deterministic ordering within levels

  while (queue.length > 0) {
    levels.push([...queue]);
    sorted.push(...queue);

    const nextQueue = [];
    for (const name of queue) {
      for (const dependent of (graph.get(name) ?? [])) {
        const newDegree = (inDegree.get(dependent) ?? 1) - 1;
        inDegree.set(dependent, newDegree);
        if (newDegree === 0) {
          nextQueue.push(dependent);
        }
      }
    }
    nextQueue.sort(); // deterministic
    queue = nextQueue;
  }

  // Detect cycles: if we didn't process all nodes, there are cycles
  if (sorted.length < allNames.size) {
    const remaining = [...allNames].filter(n => !sorted.includes(n));
    const cycles = detectCycles(packages, remaining);
    return {
      ok: false,
      sorted,
      levels,
      cycles,
      remaining,
      reason: "circular_dependencies_detected"
    };
  }

  return { ok: true, sorted, levels, cycles: null };
}

/**
 * Detect cycles among remaining (unsorted) nodes using DFS.
 */
function detectCycles(packages, remaining) {
  const remainingSet = new Set(remaining);
  const adjList = new Map();

  for (const pkg of packages) {
    if (!remainingSet.has(pkg.name)) continue;
    const deps = pkg.workspaceDeps.filter(d => remainingSet.has(d));
    adjList.set(pkg.name, deps);
  }

  const visited = new Set();
  const inStack = new Set();
  const cycles = [];

  function dfs(node, path) {
    if (inStack.has(node)) {
      const cycleStart = path.indexOf(node);
      if (cycleStart >= 0) {
        cycles.push(path.slice(cycleStart));
      }
      return;
    }
    if (visited.has(node)) return;

    visited.add(node);
    inStack.add(node);
    path.push(node);

    for (const dep of (adjList.get(node) ?? [])) {
      dfs(dep, [...path]);
    }

    inStack.delete(node);
  }

  for (const node of remaining) {
    if (!visited.has(node)) {
      dfs(node, []);
    }
  }

  return cycles.length > 0 ? cycles : null;
}

/**
 * Get the execution plan: which packages can run in parallel at each step.
 * Useful for parallel install/build orchestration.
 *
 * @param {Array<{name: string, workspaceDeps: string[]}>} packages
 * @returns {{
 *   ok: boolean,
 *   plan: Array<{level: number, parallel: string[], sequential: boolean}>,
 *   totalLevels: number,
 *   maxParallelism: number
 * }}
 */
export function executionPlan(packages) {
  const result = topoSort(packages);

  if (!result.ok) {
    return {
      ok: false,
      plan: [],
      totalLevels: 0,
      maxParallelism: 0,
      reason: result.reason,
      cycles: result.cycles
    };
  }

  const plan = result.levels.map((pkgs, i) => ({
    level: i,
    parallel: pkgs,
    sequential: pkgs.length === 1
  }));

  const maxParallelism = Math.max(...result.levels.map(l => l.length), 0);

  return {
    ok: true,
    plan,
    totalLevels: result.levels.length,
    maxParallelism
  };
}

/**
 * Filter packages that are affected by changes (for incremental builds).
 * Given a set of changed package names, returns all packages that need rebuilding
 * (the changed packages plus all their transitive dependents).
 *
 * @param {Array<{name: string, workspaceDeps: string[]}>} packages
 * @param {string[]} changedNames - Names of packages that changed
 * @returns {string[]} - Names of all affected packages in topological order
 */
export function affectedPackages(packages, changedNames) {
  const changedSet = new Set(changedNames);
  const affected = new Set(changedNames);

  // Build reverse dependency graph
  const reverseDeps = new Map();
  for (const pkg of packages) {
    for (const dep of pkg.workspaceDeps) {
      if (!reverseDeps.has(dep)) reverseDeps.set(dep, new Set());
      reverseDeps.get(dep).add(pkg.name);
    }
  }

  // BFS from changed packages through reverse deps
  const queue = [...changedNames];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const dependent of (reverseDeps.get(current) ?? [])) {
      if (!affected.has(dependent)) {
        affected.add(dependent);
        queue.push(dependent);
      }
    }
  }

  // Return in topological order
  const result = topoSort(packages);
  if (!result.ok) return [...affected];
  return result.sorted.filter(name => affected.has(name));
}
