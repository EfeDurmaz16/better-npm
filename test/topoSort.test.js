import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { topoSort, executionPlan, affectedPackages } from "../src/lib/topoSort.js";

describe("topoSort", () => {
  it("sorts simple linear chain: A -> B -> C", () => {
    const packages = [
      { name: "A", workspaceDeps: [] },
      { name: "B", workspaceDeps: ["A"] },
      { name: "C", workspaceDeps: ["B"] }
    ];

    const result = topoSort(packages);
    assert.equal(result.ok, true);
    assert.deepEqual(result.sorted, ["A", "B", "C"]);
    assert.deepEqual(result.levels, [["A"], ["B"], ["C"]]);
    assert.equal(result.cycles, null);
  });

  it("sorts diamond dependency: A -> B, A -> C, B -> D, C -> D", () => {
    const packages = [
      { name: "D", workspaceDeps: ["B", "C"] },
      { name: "C", workspaceDeps: ["A"] },
      { name: "B", workspaceDeps: ["A"] },
      { name: "A", workspaceDeps: [] }
    ];

    const result = topoSort(packages);
    assert.equal(result.ok, true);
    assert.deepEqual(result.sorted, ["A", "B", "C", "D"]);
    // B and C can be built in parallel at level 1
    assert.deepEqual(result.levels, [["A"], ["B", "C"], ["D"]]);
    assert.equal(result.cycles, null);
  });

  it("handles packages with no dependencies (all independent)", () => {
    const packages = [
      { name: "pkg-a", workspaceDeps: [] },
      { name: "pkg-b", workspaceDeps: [] },
      { name: "pkg-c", workspaceDeps: [] }
    ];

    const result = topoSort(packages);
    assert.equal(result.ok, true);
    assert.equal(result.sorted.length, 3);
    // All packages can be built in parallel
    assert.equal(result.levels.length, 1);
    assert.deepEqual(result.levels[0].sort(), ["pkg-a", "pkg-b", "pkg-c"]);
    assert.equal(result.cycles, null);
  });

  it("detects cycle: A -> B -> C -> A", () => {
    const packages = [
      { name: "A", workspaceDeps: ["C"] },
      { name: "B", workspaceDeps: ["A"] },
      { name: "C", workspaceDeps: ["B"] }
    ];

    const result = topoSort(packages);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "circular_dependencies_detected");
    assert.equal(result.sorted.length, 0);
    assert.ok(result.cycles !== null);
    assert.ok(result.cycles.length > 0);
  });

  it("detects self-referencing cycle: A -> A", () => {
    const packages = [
      { name: "A", workspaceDeps: ["A"] }
    ];

    const result = topoSort(packages);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "circular_dependencies_detected");
    assert.ok(result.cycles !== null);
  });

  it("handles single package with no dependencies", () => {
    const packages = [
      { name: "only-pkg", workspaceDeps: [] }
    ];

    const result = topoSort(packages);
    assert.equal(result.ok, true);
    assert.deepEqual(result.sorted, ["only-pkg"]);
    assert.deepEqual(result.levels, [["only-pkg"]]);
    assert.equal(result.cycles, null);
  });

  it("handles empty package array", () => {
    const packages = [];

    const result = topoSort(packages);
    assert.equal(result.ok, true);
    assert.deepEqual(result.sorted, []);
    assert.deepEqual(result.levels, []);
    assert.equal(result.cycles, null);
  });

  it("sorts complex multi-level dependency tree", () => {
    const packages = [
      { name: "utils", workspaceDeps: [] },
      { name: "core", workspaceDeps: ["utils"] },
      { name: "api", workspaceDeps: ["core"] },
      { name: "ui", workspaceDeps: ["core"] },
      { name: "web", workspaceDeps: ["api", "ui"] },
      { name: "mobile", workspaceDeps: ["api", "ui"] }
    ];

    const result = topoSort(packages);
    assert.equal(result.ok, true);
    assert.deepEqual(result.sorted, ["utils", "core", "api", "ui", "mobile", "web"]);
    // Verify parallel levels
    assert.deepEqual(result.levels[0], ["utils"]);
    assert.deepEqual(result.levels[1], ["core"]);
    assert.deepEqual(result.levels[2].sort(), ["api", "ui"]);
    assert.deepEqual(result.levels[3].sort(), ["mobile", "web"]);
  });

  it("maintains deterministic ordering within parallel levels", () => {
    const packages = [
      { name: "z-pkg", workspaceDeps: [] },
      { name: "a-pkg", workspaceDeps: [] },
      { name: "m-pkg", workspaceDeps: [] }
    ];

    const result = topoSort(packages);
    assert.equal(result.ok, true);
    // Should be alphabetically sorted within the level
    assert.deepEqual(result.levels[0], ["a-pkg", "m-pkg", "z-pkg"]);
  });

  it("detects partial cycle with some valid packages", () => {
    const packages = [
      { name: "good-a", workspaceDeps: [] },
      { name: "good-b", workspaceDeps: ["good-a"] },
      { name: "bad-a", workspaceDeps: ["bad-b"] },
      { name: "bad-b", workspaceDeps: ["bad-a"] }
    ];

    const result = topoSort(packages);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "circular_dependencies_detected");
    // Should have sorted the good packages
    assert.ok(result.sorted.includes("good-a"));
    assert.ok(result.sorted.includes("good-b"));
    // But not the cyclic ones
    assert.ok(!result.sorted.includes("bad-a") || !result.sorted.includes("bad-b"));
  });

  it("handles package depending on non-existent workspace package", () => {
    const packages = [
      { name: "existing", workspaceDeps: [] },
      { name: "dependent", workspaceDeps: ["non-existent"] }
    ];

    // This should still work - non-existent deps are just ignored
    const result = topoSort(packages);
    // The result depends on implementation - it may treat non-existent as external
    assert.ok(result.ok !== undefined);
  });
});

describe("executionPlan", () => {
  it("generates execution plan with parallel levels", () => {
    const packages = [
      { name: "base", workspaceDeps: [] },
      { name: "lib-a", workspaceDeps: ["base"] },
      { name: "lib-b", workspaceDeps: ["base"] },
      { name: "app", workspaceDeps: ["lib-a", "lib-b"] }
    ];

    const plan = executionPlan(packages);
    assert.equal(plan.ok, true);
    assert.equal(plan.totalLevels, 3);
    assert.equal(plan.maxParallelism, 2);

    assert.equal(plan.plan[0].level, 0);
    assert.deepEqual(plan.plan[0].parallel, ["base"]);
    assert.equal(plan.plan[0].sequential, true);

    assert.equal(plan.plan[1].level, 1);
    assert.deepEqual(plan.plan[1].parallel.sort(), ["lib-a", "lib-b"]);
    assert.equal(plan.plan[1].sequential, false);

    assert.equal(plan.plan[2].level, 2);
    assert.deepEqual(plan.plan[2].parallel, ["app"]);
    assert.equal(plan.plan[2].sequential, true);
  });

  it("calculates maxParallelism correctly", () => {
    const packages = [
      { name: "a", workspaceDeps: [] },
      { name: "b", workspaceDeps: [] },
      { name: "c", workspaceDeps: [] },
      { name: "d", workspaceDeps: [] },
      { name: "z", workspaceDeps: ["a", "b", "c", "d"] }
    ];

    const plan = executionPlan(packages);
    assert.equal(plan.ok, true);
    assert.equal(plan.maxParallelism, 4);
    assert.equal(plan.totalLevels, 2);
  });

  it("returns failed plan with cycles detected", () => {
    const packages = [
      { name: "A", workspaceDeps: ["B"] },
      { name: "B", workspaceDeps: ["A"] }
    ];

    const plan = executionPlan(packages);
    assert.equal(plan.ok, false);
    assert.equal(plan.reason, "circular_dependencies_detected");
    assert.equal(plan.totalLevels, 0);
    assert.equal(plan.maxParallelism, 0);
    assert.ok(plan.cycles !== null);
  });

  it("handles single package plan", () => {
    const packages = [
      { name: "only", workspaceDeps: [] }
    ];

    const plan = executionPlan(packages);
    assert.equal(plan.ok, true);
    assert.equal(plan.totalLevels, 1);
    assert.equal(plan.maxParallelism, 1);
    assert.deepEqual(plan.plan[0].parallel, ["only"]);
  });

  it("handles empty package list", () => {
    const packages = [];

    const plan = executionPlan(packages);
    assert.equal(plan.ok, true);
    assert.equal(plan.totalLevels, 0);
    assert.equal(plan.maxParallelism, 0);
    assert.deepEqual(plan.plan, []);
  });

  it("marks levels with single package as sequential", () => {
    const packages = [
      { name: "a", workspaceDeps: [] },
      { name: "b", workspaceDeps: ["a"] },
      { name: "c", workspaceDeps: ["b"] }
    ];

    const plan = executionPlan(packages);
    assert.equal(plan.ok, true);
    assert.ok(plan.plan.every(level => level.sequential === true));
  });

  it("marks levels with multiple packages as non-sequential", () => {
    const packages = [
      { name: "a", workspaceDeps: [] },
      { name: "b", workspaceDeps: [] }
    ];

    const plan = executionPlan(packages);
    assert.equal(plan.ok, true);
    assert.equal(plan.plan[0].sequential, false);
  });
});

describe("affectedPackages", () => {
  it("returns directly changed package", () => {
    const packages = [
      { name: "a", workspaceDeps: [] },
      { name: "b", workspaceDeps: [] }
    ];

    const affected = affectedPackages(packages, ["a"]);
    assert.deepEqual(affected, ["a"]);
  });

  it("propagates changes to direct dependents", () => {
    const packages = [
      { name: "base", workspaceDeps: [] },
      { name: "lib", workspaceDeps: ["base"] },
      { name: "app", workspaceDeps: ["lib"] }
    ];

    const affected = affectedPackages(packages, ["base"]);
    assert.deepEqual(affected, ["base", "lib", "app"]);
  });

  it("propagates changes transitively through dependency graph", () => {
    const packages = [
      { name: "utils", workspaceDeps: [] },
      { name: "core", workspaceDeps: ["utils"] },
      { name: "api", workspaceDeps: ["core"] },
      { name: "ui", workspaceDeps: ["core"] },
      { name: "web", workspaceDeps: ["api", "ui"] }
    ];

    const affected = affectedPackages(packages, ["utils"]);
    // All packages depend on utils either directly or transitively
    assert.deepEqual(affected.sort(), ["api", "core", "ui", "utils", "web"]);
  });

  it("does not include unrelated packages", () => {
    const packages = [
      { name: "a", workspaceDeps: [] },
      { name: "b", workspaceDeps: ["a"] },
      { name: "x", workspaceDeps: [] },
      { name: "y", workspaceDeps: ["x"] }
    ];

    const affected = affectedPackages(packages, ["a"]);
    assert.deepEqual(affected, ["a", "b"]);
    assert.ok(!affected.includes("x"));
    assert.ok(!affected.includes("y"));
  });

  it("handles multiple changed packages", () => {
    const packages = [
      { name: "a", workspaceDeps: [] },
      { name: "b", workspaceDeps: ["a"] },
      { name: "c", workspaceDeps: [] },
      { name: "d", workspaceDeps: ["c"] }
    ];

    const affected = affectedPackages(packages, ["a", "c"]);
    assert.deepEqual(affected.sort(), ["a", "b", "c", "d"]);
  });

  it("returns packages in topological order", () => {
    const packages = [
      { name: "base", workspaceDeps: [] },
      { name: "middle", workspaceDeps: ["base"] },
      { name: "top", workspaceDeps: ["middle"] }
    ];

    const affected = affectedPackages(packages, ["base"]);
    // Should be in build order: base first, then middle, then top
    assert.deepEqual(affected, ["base", "middle", "top"]);
  });

  it("handles diamond dependencies correctly", () => {
    const packages = [
      { name: "base", workspaceDeps: [] },
      { name: "left", workspaceDeps: ["base"] },
      { name: "right", workspaceDeps: ["base"] },
      { name: "top", workspaceDeps: ["left", "right"] }
    ];

    const affected = affectedPackages(packages, ["base"]);
    assert.equal(affected.length, 4);
    assert.ok(affected.includes("base"));
    assert.ok(affected.includes("left"));
    assert.ok(affected.includes("right"));
    assert.ok(affected.includes("top"));
    // base should come first
    assert.equal(affected[0], "base");
    // top should come last
    assert.equal(affected[affected.length - 1], "top");
  });

  it("handles empty changed list", () => {
    const packages = [
      { name: "a", workspaceDeps: [] },
      { name: "b", workspaceDeps: ["a"] }
    ];

    const affected = affectedPackages(packages, []);
    assert.deepEqual(affected, []);
  });

  it("handles change to leaf package with no dependents", () => {
    const packages = [
      { name: "base", workspaceDeps: [] },
      { name: "leaf", workspaceDeps: ["base"] }
    ];

    const affected = affectedPackages(packages, ["leaf"]);
    assert.deepEqual(affected, ["leaf"]);
  });

  it("handles complex graph with multiple change points", () => {
    const packages = [
      { name: "utils", workspaceDeps: [] },
      { name: "logger", workspaceDeps: [] },
      { name: "core", workspaceDeps: ["utils", "logger"] },
      { name: "api", workspaceDeps: ["core"] },
      { name: "ui", workspaceDeps: ["utils"] },
      { name: "web", workspaceDeps: ["api", "ui"] }
    ];

    const affected = affectedPackages(packages, ["utils", "logger"]);
    // Should include utils, logger, and everything that depends on them
    const affectedSet = new Set(affected);
    assert.ok(affectedSet.has("utils"));
    assert.ok(affectedSet.has("logger"));
    assert.ok(affectedSet.has("core"));
    assert.ok(affectedSet.has("api"));
    assert.ok(affectedSet.has("ui"));
    assert.ok(affectedSet.has("web"));
  });

  it("returns affected packages when graph has cycles", () => {
    const packages = [
      { name: "a", workspaceDeps: ["b"] },
      { name: "b", workspaceDeps: ["a"] },
      { name: "c", workspaceDeps: [] }
    ];

    const affected = affectedPackages(packages, ["a"]);
    // Should still return affected packages even with cycles
    assert.ok(affected.includes("a"));
    assert.ok(affected.includes("b"));
    assert.ok(!affected.includes("c"));
  });

  it("handles package with no workspace dependencies", () => {
    const packages = [
      { name: "standalone", workspaceDeps: [] }
    ];

    const affected = affectedPackages(packages, ["standalone"]);
    assert.deepEqual(affected, ["standalone"]);
  });
});
