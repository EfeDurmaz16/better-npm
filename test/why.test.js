import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { makeTempDir, rmrf, writeJson } from "./helpers.js";

const execFileAsync = promisify(execFile);
const betterBin = path.resolve(process.cwd(), "bin", "better.js");

/**
 * Helper to run 'better why' and parse JSON output
 */
async function runWhy(dir, packageName, args = []) {
  const { stdout } = await execFileAsync(
    process.execPath,
    [betterBin, "why", packageName, ...args],
    {
      cwd: dir,
      env: {
        ...process.env,
        BETTER_LOG_LEVEL: "silent"
      },
      timeout: 30_000
    }
  );
  return JSON.parse(stdout);
}

/**
 * Create a test project with a specific dependency tree
 */
async function createTestProject(dir, lockfileData) {
  await writeJson(path.join(dir, "package.json"), {
    name: "why-test-project",
    version: "1.0.0",
    dependencies: lockfileData.rootDeps || {}
  });

  await writeJson(path.join(dir, "package-lock.json"), lockfileData.lock);
}

test("why - direct dependency is found and marked isDirect=true", async (t) => {
  const dir = await makeTempDir("better-why-direct-");
  try {
    await createTestProject(dir, {
      rootDeps: {
        lodash: "^4.17.21"
      },
      lock: {
        name: "why-test-project",
        version: "1.0.0",
        lockfileVersion: 3,
        requires: true,
        packages: {
          "": {
            name: "why-test-project",
            version: "1.0.0",
            dependencies: {
              lodash: "^4.17.21"
            }
          },
          "node_modules/lodash": {
            version: "4.17.21",
            resolved: "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz",
            integrity: "sha512-v2kDEe57lecTulaDIuNTPy3Ry4gLGJ6Z1O3vE1krgXZNrsQ+LFTGHVxVjcXPs17LhbZVGedAJv8XZ1tvj5FvSg=="
          }
        }
      }
    });

    const result = await runWhy(dir, "lodash", ["--json"]);

    assert.equal(result.ok, true);
    assert.equal(result.kind, "better.why");
    assert.equal(result.schemaVersion, 1);
    assert.equal(result.package, "lodash");
    assert.equal(result.version, "4.17.21");
    assert.equal(result.isDirect, true);
    assert.ok(Array.isArray(result.dependencyPaths));
    assert.ok(result.dependencyPaths.length > 0);
    assert.equal(result.totalPaths, result.dependencyPaths.length);
  } finally {
    await rmrf(dir);
  }
});

test("why - transitive dependency shows correct path", async (t) => {
  const dir = await makeTempDir("better-why-transitive-");
  try {
    await createTestProject(dir, {
      rootDeps: {
        express: "^4.18.2"
      },
      lock: {
        name: "why-test-project",
        version: "1.0.0",
        lockfileVersion: 3,
        requires: true,
        packages: {
          "": {
            name: "why-test-project",
            version: "1.0.0",
            dependencies: {
              express: "^4.18.2"
            }
          },
          "node_modules/express": {
            version: "4.18.2",
            resolved: "https://registry.npmjs.org/express/-/express-4.18.2.tgz",
            dependencies: {
              "body-parser": "1.20.1"
            }
          },
          "node_modules/body-parser": {
            version: "1.20.1",
            resolved: "https://registry.npmjs.org/body-parser/-/body-parser-1.20.1.tgz",
            integrity: "sha512-jWi7abTbYwajOytWCQc37VulmWiRae5RyTpaCyDcS5/lMdtwSz5lOpDE67srw/HYe35f1z3fDQw+3txg7gNtWw=="
          }
        }
      }
    });

    const result = await runWhy(dir, "body-parser", ["--json"]);

    assert.equal(result.ok, true);
    assert.equal(result.package, "body-parser");
    assert.equal(result.version, "1.20.1");
    assert.equal(result.isDirect, false);
    assert.ok(result.dependencyPaths.length > 0);

    // Should have a path like ["express", "body-parser"]
    const hasExpectedPath = result.dependencyPaths.some(
      path => path.length === 2 && path[0] === "express" && path[1] === "body-parser"
    );
    assert.ok(hasExpectedPath, "Should have path from express to body-parser");
  } finally {
    await rmrf(dir);
  }
});

test("why - package not found returns appropriate error", async (t) => {
  const dir = await makeTempDir("better-why-notfound-");
  try {
    await createTestProject(dir, {
      rootDeps: {
        lodash: "^4.17.21"
      },
      lock: {
        name: "why-test-project",
        version: "1.0.0",
        lockfileVersion: 3,
        requires: true,
        packages: {
          "": {
            name: "why-test-project",
            version: "1.0.0",
            dependencies: {
              lodash: "^4.17.21"
            }
          },
          "node_modules/lodash": {
            version: "4.17.21",
            resolved: "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz"
          }
        }
      }
    });

    // Command will exit with code 1, so we need to catch the error
    try {
      await runWhy(dir, "nonexistent-package", ["--json"]);
      assert.fail("Should have thrown an error");
    } catch (err) {
      // Parse the JSON from stdout before the command failed
      const stdoutMatch = err.stdout || "";
      const result = JSON.parse(stdoutMatch);
      assert.equal(result.ok, false);
      assert.equal(result.kind, "better.why");
      assert.equal(result.package, "nonexistent-package");
      assert.ok(result.error);
      assert.match(result.error, /not found/i);
    }
  } finally {
    await rmrf(dir);
  }
});

test("why - multiple paths are all reported", async (t) => {
  const dir = await makeTempDir("better-why-multipaths-");
  try {
    await createTestProject(dir, {
      rootDeps: {
        express: "^4.18.2",
        webpack: "^5.75.0"
      },
      lock: {
        name: "why-test-project",
        version: "1.0.0",
        lockfileVersion: 3,
        requires: true,
        packages: {
          "": {
            name: "why-test-project",
            version: "1.0.0",
            dependencies: {
              express: "^4.18.2",
              webpack: "^5.75.0"
            }
          },
          "node_modules/express": {
            version: "4.18.2",
            dependencies: {
              lodash: "^4.17.0"
            }
          },
          "node_modules/webpack": {
            version: "5.75.0",
            dependencies: {
              lodash: "^4.17.0"
            }
          },
          "node_modules/lodash": {
            version: "4.17.21",
            resolved: "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz"
          }
        }
      }
    });

    const result = await runWhy(dir, "lodash", ["--json"]);

    assert.equal(result.ok, true);
    assert.equal(result.package, "lodash");
    assert.equal(result.isDirect, false);
    assert.ok(result.totalPaths >= 2, "Should have at least 2 paths to lodash");

    // Check that we have paths through both express and webpack
    const pathsAsStrings = result.dependencyPaths.map(p => p.join(" -> "));
    const hasExpressPath = pathsAsStrings.some(p => p.includes("express"));
    const hasWebpackPath = pathsAsStrings.some(p => p.includes("webpack"));

    assert.ok(hasExpressPath, "Should have path through express");
    assert.ok(hasWebpackPath, "Should have path through webpack");
  } finally {
    await rmrf(dir);
  }
});

test("why - works with --json flag", async (t) => {
  const dir = await makeTempDir("better-why-json-");
  try {
    await createTestProject(dir, {
      rootDeps: {
        lodash: "^4.17.21"
      },
      lock: {
        name: "why-test-project",
        version: "1.0.0",
        lockfileVersion: 3,
        requires: true,
        packages: {
          "": {
            name: "why-test-project",
            version: "1.0.0",
            dependencies: {
              lodash: "^4.17.21"
            }
          },
          "node_modules/lodash": {
            version: "4.17.21",
            resolved: "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz"
          }
        }
      }
    });

    const result = await runWhy(dir, "lodash", ["--json"]);

    // Verify JSON structure
    assert.equal(typeof result, "object");
    assert.equal(result.ok, true);
    assert.equal(result.kind, "better.why");
    assert.equal(result.schemaVersion, 1);
    assert.ok("package" in result);
    assert.ok("version" in result);
    assert.ok("isDirect" in result);
    assert.ok("dependencyPaths" in result);
    assert.ok("dependedOnBy" in result);
    assert.ok("totalPaths" in result);
  } finally {
    await rmrf(dir);
  }
});

test("why - dependedOnBy shows reverse dependencies", async (t) => {
  const dir = await makeTempDir("better-why-reversedeps-");
  try {
    await createTestProject(dir, {
      rootDeps: {
        express: "^4.18.2",
        webpack: "^5.75.0"
      },
      lock: {
        name: "why-test-project",
        version: "1.0.0",
        lockfileVersion: 3,
        requires: true,
        packages: {
          "": {
            name: "why-test-project",
            version: "1.0.0",
            dependencies: {
              express: "^4.18.2",
              webpack: "^5.75.0"
            }
          },
          "node_modules/express": {
            version: "4.18.2",
            dependencies: {
              lodash: "^4.17.0"
            }
          },
          "node_modules/webpack": {
            version: "5.75.0",
            dependencies: {
              lodash: "^4.17.21"
            }
          },
          "node_modules/lodash": {
            version: "4.17.21",
            resolved: "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz"
          }
        }
      }
    });

    const result = await runWhy(dir, "lodash", ["--json"]);

    assert.equal(result.ok, true);
    assert.ok(Array.isArray(result.dependedOnBy));
    assert.ok(result.dependedOnBy.length >= 2, "Should have at least 2 reverse deps");

    // Check structure of reverse deps
    for (const dep of result.dependedOnBy) {
      assert.ok("name" in dep);
      assert.ok("version" in dep);
      assert.ok("range" in dep);
      assert.equal(typeof dep.name, "string");
      assert.equal(typeof dep.version, "string");
      assert.equal(typeof dep.range, "string");
    }

    // Should include both express and webpack
    const depNames = result.dependedOnBy.map(d => d.name);
    assert.ok(depNames.includes("express"));
    assert.ok(depNames.includes("webpack"));
  } finally {
    await rmrf(dir);
  }
});

test("why - handles missing lockfile gracefully", async (t) => {
  const dir = await makeTempDir("better-why-nolockfile-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "no-lockfile-project",
      version: "1.0.0"
    });

    // Command will exit with code 1
    try {
      await runWhy(dir, "lodash", ["--json"]);
      assert.fail("Should have thrown an error");
    } catch (err) {
      // Parse JSON from stdout
      const stdoutMatch = err.stdout || "";
      const result = JSON.parse(stdoutMatch);
      assert.equal(result.ok, false);
      assert.match(result.error.message, /No lockfile found/);
    }
  } finally {
    await rmrf(dir);
  }
});

test("why - handles missing package argument", async (t) => {
  const dir = await makeTempDir("better-why-noarg-");
  try {
    await createTestProject(dir, {
      rootDeps: {},
      lock: {
        name: "why-test-project",
        version: "1.0.0",
        lockfileVersion: 3,
        requires: true,
        packages: {
          "": {
            name: "why-test-project",
            version: "1.0.0"
          }
        }
      }
    });

    await assert.rejects(
      async () => {
        await runWhy(dir, "", ["--json"]);
      },
      (err) => {
        // The command may exit with error but not throw, check for JSON error output
        return true;
      }
    );
  } finally {
    await rmrf(dir);
  }
});

test("why - text output mode works", async (t) => {
  const dir = await makeTempDir("better-why-text-");
  try {
    await createTestProject(dir, {
      rootDeps: {
        lodash: "^4.17.21"
      },
      lock: {
        name: "why-test-project",
        version: "1.0.0",
        lockfileVersion: 3,
        requires: true,
        packages: {
          "": {
            name: "why-test-project",
            version: "1.0.0",
            dependencies: {
              lodash: "^4.17.21"
            }
          },
          "node_modules/lodash": {
            version: "4.17.21",
            resolved: "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz"
          }
        }
      }
    });

    const { stdout } = await execFileAsync(
      process.execPath,
      [betterBin, "why", "lodash"],
      {
        cwd: dir,
        env: {
          ...process.env,
          BETTER_LOG_LEVEL: "silent"
        },
        timeout: 30_000
      }
    );

    // Should contain package name and version
    assert.match(stdout, /lodash/);
    assert.match(stdout, /4\.17\.21/);
    assert.match(stdout, /DIRECT/i);
  } finally {
    await rmrf(dir);
  }
});
