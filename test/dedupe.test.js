import { test } from "node:test";
import assert from "node:assert";
import path from "node:path";
import { makeTempDir, rmrf, writeJson } from "./helpers.js";
import { cmdDedupe } from "../src/commands/dedupe.js";
import { setRuntimeConfig } from "../src/lib/config.js";
import { configureLogger } from "../src/lib/log.js";

// Capture stdout during command execution
async function captureOutput(fn) {
  const chunks = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = function(chunk) {
    chunks.push(chunk);
    return true;
  };
  try {
    await fn();
  } finally {
    process.stdout.write = originalWrite;
  }
  return chunks.join("");
}

async function runDedupe(cwd, args = []) {
  // Configure runtime for JSON output
  setRuntimeConfig({ json: true, logLevel: "silent" });
  configureLogger({ level: "silent" });

  const output = await captureOutput(() =>
    cmdDedupe(["--json", "--project-root", cwd, ...args])
  );

  return JSON.parse(output);
}

test("dedupe: no duplicates in clean project", async () => {
  const tmpDir = await makeTempDir();
  try {
    await writeJson(path.join(tmpDir, "package.json"), {
      name: "test-project",
      version: "1.0.0",
      dependencies: {
        "lodash": "^4.17.21"
      }
    });

    await writeJson(path.join(tmpDir, "package-lock.json"), {
      name: "test-project",
      version: "1.0.0",
      lockfileVersion: 2,
      requires: true,
      packages: {
        "": {
          name: "test-project",
          version: "1.0.0",
          dependencies: {
            "lodash": "^4.17.21"
          }
        },
        "node_modules/lodash": {
          version: "4.17.21",
          resolved: "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz",
          integrity: "sha512-xxx"
        }
      }
    });

    const result = await runDedupe(tmpDir);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.kind, "better.dedupe");
    assert.strictEqual(result.schemaVersion, 1);
    assert.strictEqual(result.duplicates.length, 0);
    assert.strictEqual(result.summary.totalDuplicates, 0);
    assert.strictEqual(result.summary.deduplicatable, 0);
    assert.strictEqual(result.summary.estimatedSavedPackages, 0);
  } finally {
    await rmrf(tmpDir);
  }
});

test("dedupe: detects duplicate package with different versions", async () => {
  const tmpDir = await makeTempDir();
  try {
    await writeJson(path.join(tmpDir, "package.json"), {
      name: "test-project",
      version: "1.0.0",
      dependencies: {
        "debug": "^4.3.4"
      }
    });

    await writeJson(path.join(tmpDir, "package-lock.json"), {
      name: "test-project",
      version: "1.0.0",
      lockfileVersion: 2,
      requires: true,
      packages: {
        "": {
          name: "test-project",
          version: "1.0.0",
          dependencies: {
            "debug": "^4.3.4"
          }
        },
        "node_modules/debug": {
          version: "4.3.4",
          resolved: "https://registry.npmjs.org/debug/-/debug-4.3.4.tgz",
          integrity: "sha512-xxx"
        },
        "node_modules/some-package": {
          version: "1.0.0",
          resolved: "https://registry.npmjs.org/some-package/-/some-package-1.0.0.tgz",
          integrity: "sha512-yyy",
          dependencies: {
            "debug": "^4.3.5"
          }
        },
        "node_modules/some-package/node_modules/debug": {
          version: "4.3.5",
          resolved: "https://registry.npmjs.org/debug/-/debug-4.3.5.tgz",
          integrity: "sha512-zzz"
        }
      }
    });

    const result = await runDedupe(tmpDir);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.duplicates.length, 1);
    assert.strictEqual(result.duplicates[0].name, "debug");
    assert.deepStrictEqual(result.duplicates[0].versions, ["4.3.5", "4.3.4"]);
    assert.strictEqual(result.duplicates[0].instances, 2);
  } finally {
    await rmrf(tmpDir);
  }
});

test("dedupe: identifies deduplicatable packages (compatible ranges)", async () => {
  const tmpDir = await makeTempDir();
  try {
    await writeJson(path.join(tmpDir, "package.json"), {
      name: "test-project",
      version: "1.0.0"
    });

    await writeJson(path.join(tmpDir, "package-lock.json"), {
      name: "test-project",
      version: "1.0.0",
      lockfileVersion: 2,
      requires: true,
      packages: {
        "": {
          name: "test-project",
          version: "1.0.0"
        },
        "node_modules/chalk": {
          version: "2.4.1",
          resolved: "https://registry.npmjs.org/chalk/-/chalk-2.4.1.tgz",
          integrity: "sha512-aaa"
        },
        "node_modules/pkg-a": {
          version: "1.0.0"
        },
        "node_modules/pkg-a/node_modules/chalk": {
          version: "2.4.2",
          resolved: "https://registry.npmjs.org/chalk/-/chalk-2.4.2.tgz",
          integrity: "sha512-bbb"
        }
      }
    });

    const result = await runDedupe(tmpDir);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.duplicates.length, 1);

    const chalkDup = result.duplicates.find(d => d.name === "chalk");
    assert.ok(chalkDup, "chalk duplicate should exist");
    assert.strictEqual(chalkDup.canDedupe, true);
    assert.strictEqual(chalkDup.targetVersion, "2.4.2");
    assert.strictEqual(chalkDup.savedInstances, 1);
  } finally {
    await rmrf(tmpDir);
  }
});

test("dedupe: reports correct summary counts", async () => {
  const tmpDir = await makeTempDir();
  try {
    await writeJson(path.join(tmpDir, "package.json"), {
      name: "test-project",
      version: "1.0.0"
    });

    await writeJson(path.join(tmpDir, "package-lock.json"), {
      name: "test-project",
      version: "1.0.0",
      lockfileVersion: 2,
      requires: true,
      packages: {
        "": {
          name: "test-project",
          version: "1.0.0"
        },
        // Deduplicatable: debug 4.3.4 and 4.3.5
        "node_modules/debug": {
          version: "4.3.4",
          resolved: "https://registry.npmjs.org/debug/-/debug-4.3.4.tgz"
        },
        "node_modules/pkg-a/node_modules/debug": {
          version: "4.3.5",
          resolved: "https://registry.npmjs.org/debug/-/debug-4.3.5.tgz"
        },
        // NOT deduplicatable: lodash 3.x and 4.x (major version conflict)
        "node_modules/lodash": {
          version: "3.10.1",
          resolved: "https://registry.npmjs.org/lodash/-/lodash-3.10.1.tgz"
        },
        "node_modules/pkg-b/node_modules/lodash": {
          version: "4.17.21",
          resolved: "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz"
        },
        // Deduplicatable: chalk 2.4.1 and 2.4.2
        "node_modules/chalk": {
          version: "2.4.1",
          resolved: "https://registry.npmjs.org/chalk/-/chalk-2.4.1.tgz"
        },
        "node_modules/pkg-c/node_modules/chalk": {
          version: "2.4.2",
          resolved: "https://registry.npmjs.org/chalk/-/chalk-2.4.2.tgz"
        },
        "node_modules/pkg-d/node_modules/chalk": {
          version: "2.4.2",
          resolved: "https://registry.npmjs.org/chalk/-/chalk-2.4.2.tgz"
        }
      }
    });

    const result = await runDedupe(tmpDir);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.summary.totalDuplicates, 3); // debug, lodash, chalk
    assert.strictEqual(result.summary.deduplicatable, 2); // debug and chalk (not lodash)

    // debug: 2 instances -> 1 saved
    // chalk: 3 instances -> 2 saved
    // Total: 3 saved
    assert.strictEqual(result.summary.estimatedSavedPackages, 3);
  } finally {
    await rmrf(tmpDir);
  }
});

test("dedupe: --json flag produces valid JSON", async () => {
  const tmpDir = await makeTempDir();
  try {
    await writeJson(path.join(tmpDir, "package.json"), {
      name: "test-project",
      version: "1.0.0"
    });

    await writeJson(path.join(tmpDir, "package-lock.json"), {
      name: "test-project",
      version: "1.0.0",
      lockfileVersion: 2,
      requires: true,
      packages: {
        "": {
          name: "test-project",
          version: "1.0.0"
        },
        "node_modules/ms": {
          version: "2.1.2",
          resolved: "https://registry.npmjs.org/ms/-/ms-2.1.2.tgz"
        }
      }
    });

    const result = await runDedupe(tmpDir);

    // Should be valid JSON with expected schema
    assert.strictEqual(typeof result, "object");
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.kind, "better.dedupe");
    assert.strictEqual(result.schemaVersion, 1);
    assert.ok(Array.isArray(result.duplicates));
    assert.ok(result.summary);
    assert.strictEqual(typeof result.summary.totalDuplicates, "number");
    assert.strictEqual(typeof result.summary.deduplicatable, "number");
    assert.strictEqual(typeof result.summary.estimatedSavedPackages, "number");
  } finally {
    await rmrf(tmpDir);
  }
});

test("dedupe: handles missing package-lock.json", async () => {
  const tmpDir = await makeTempDir();
  try {
    await writeJson(path.join(tmpDir, "package.json"), {
      name: "test-project",
      version: "1.0.0"
    });

    // No package-lock.json created

    const result = await runDedupe(tmpDir);

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.kind, "better.dedupe");
    assert.ok(result.error.includes("not found"));
  } finally {
    await rmrf(tmpDir);
  }
});

test("dedupe: handles npm lockfile v1 format", async () => {
  const tmpDir = await makeTempDir();
  try {
    await writeJson(path.join(tmpDir, "package.json"), {
      name: "test-project",
      version: "1.0.0"
    });

    await writeJson(path.join(tmpDir, "package-lock.json"), {
      name: "test-project",
      version: "1.0.0",
      lockfileVersion: 1,
      requires: true,
      dependencies: {
        "debug": {
          version: "4.3.4",
          resolved: "https://registry.npmjs.org/debug/-/debug-4.3.4.tgz",
          integrity: "sha512-xxx"
        },
        "some-package": {
          version: "1.0.0",
          resolved: "https://registry.npmjs.org/some-package/-/some-package-1.0.0.tgz",
          dependencies: {
            "debug": {
              version: "4.3.5",
              resolved: "https://registry.npmjs.org/debug/-/debug-4.3.5.tgz"
            }
          }
        }
      }
    });

    const result = await runDedupe(tmpDir);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.duplicates.length, 1);
    assert.strictEqual(result.duplicates[0].name, "debug");
    assert.strictEqual(result.duplicates[0].instances, 2);
  } finally {
    await rmrf(tmpDir);
  }
});

test("dedupe: handles scoped packages", async () => {
  const tmpDir = await makeTempDir();
  try {
    await writeJson(path.join(tmpDir, "package.json"), {
      name: "test-project",
      version: "1.0.0"
    });

    await writeJson(path.join(tmpDir, "package-lock.json"), {
      name: "test-project",
      version: "1.0.0",
      lockfileVersion: 2,
      requires: true,
      packages: {
        "": {
          name: "test-project",
          version: "1.0.0"
        },
        "node_modules/@babel/core": {
          version: "7.20.0",
          resolved: "https://registry.npmjs.org/@babel/core/-/core-7.20.0.tgz"
        },
        "node_modules/pkg-a/node_modules/@babel/core": {
          version: "7.21.0",
          resolved: "https://registry.npmjs.org/@babel/core/-/core-7.21.0.tgz"
        }
      }
    });

    const result = await runDedupe(tmpDir);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.duplicates.length, 1);
    assert.strictEqual(result.duplicates[0].name, "@babel/core");
    assert.deepStrictEqual(result.duplicates[0].versions, ["7.21.0", "7.20.0"]);
  } finally {
    await rmrf(tmpDir);
  }
});
