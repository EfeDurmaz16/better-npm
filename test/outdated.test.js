import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { makeTempDir, rmrf, writeJson } from "./helpers.js";
import { cmdOutdated } from "../src/commands/outdated.js";
import { setRuntimeConfig } from "../src/lib/config.js";
import { configureLogger } from "../src/lib/log.js";

// Helper to capture stdout
function captureStdout(fn) {
  const originalWrite = process.stdout.write;
  let output = "";
  process.stdout.write = (chunk) => {
    output += chunk;
    return true;
  };
  try {
    fn();
    return output;
  } finally {
    process.stdout.write = originalWrite;
  }
}

async function captureStdoutAsync(fn) {
  const originalWrite = process.stdout.write;
  let output = "";
  process.stdout.write = (chunk) => {
    output += chunk;
    return true;
  };
  try {
    await fn();
    return output;
  } finally {
    process.stdout.write = originalWrite;
  }
}

// Setup for all tests
configureLogger({ level: "silent" });
setRuntimeConfig({ json: false, logLevel: "silent" });

test("outdated --help shows usage", async () => {
  const output = await captureStdoutAsync(() => cmdOutdated(["--help"]));
  assert.match(output, /Usage:/);
  assert.match(output, /better outdated/);
  assert.match(output, /--json/);
  assert.match(output, /--production/);
  assert.match(output, /--level/);
});

test("outdated --json produces valid schema with empty deps", async () => {
  const dir = await makeTempDir("better-outdated-empty-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "outdated-empty-test",
      version: "1.0.0"
    });

    const output = await captureStdoutAsync(() =>
      cmdOutdated(["--json", "--project-root", dir])
    );

    const parsed = JSON.parse(output);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.kind, "better.outdated");
    assert.equal(parsed.schemaVersion, 1);
    assert.ok(Array.isArray(parsed.packages));
    assert.equal(parsed.packages.length, 0);
    assert.ok(parsed.summary);
    assert.equal(parsed.summary.totalChecked, 0);
    assert.equal(parsed.summary.upToDate, 0);
    assert.equal(parsed.summary.outdated, 0);
  } finally {
    await rmrf(dir);
  }
});

test("outdated handles missing package.json", async () => {
  const dir = await makeTempDir("better-outdated-missing-");
  try {
    const output = await captureStdoutAsync(() =>
      cmdOutdated(["--json", "--project-root", dir])
    );

    const parsed = JSON.parse(output);
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /package\.json/);
    assert.equal(process.exitCode, 1);
    process.exitCode = 0; // Reset
  } finally {
    await rmrf(dir);
  }
});

test("outdated --json with lockfile produces valid output", { skip: "Skipped to avoid slow registry calls in CI" }, async () => {
  const dir = await makeTempDir("better-outdated-lockfile-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "outdated-lockfile-test",
      version: "1.0.0",
      dependencies: {
        "left-pad": "^1.0.0"
      },
      devDependencies: {
        "is-number": "^6.0.0"
      }
    });

    await writeJson(path.join(dir, "package-lock.json"), {
      name: "outdated-lockfile-test",
      version: "1.0.0",
      lockfileVersion: 3,
      packages: {
        "": {
          name: "outdated-lockfile-test",
          version: "1.0.0",
          dependencies: {
            "left-pad": "^1.0.0"
          },
          devDependencies: {
            "is-number": "^6.0.0"
          }
        },
        "node_modules/left-pad": {
          version: "1.0.0",
          resolved: "https://registry.npmjs.org/left-pad/-/left-pad-1.0.0.tgz",
          integrity: "sha1-test"
        },
        "node_modules/is-number": {
          version: "6.0.0",
          resolved: "https://registry.npmjs.org/is-number/-/is-number-6.0.0.tgz",
          integrity: "sha1-test",
          dev: true
        }
      }
    });

    const output = await captureStdoutAsync(() =>
      cmdOutdated(["--json", "--project-root", dir])
    );

    const parsed = JSON.parse(output);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.kind, "better.outdated");
    assert.equal(parsed.schemaVersion, 1);
    assert.ok(Array.isArray(parsed.packages));
    assert.ok(parsed.summary);
    assert.equal(typeof parsed.summary.totalChecked, "number");
    assert.equal(typeof parsed.summary.upToDate, "number");
    assert.equal(typeof parsed.summary.outdated, "number");
    assert.equal(typeof parsed.summary.major, "number");
    assert.equal(typeof parsed.summary.minor, "number");
    assert.equal(typeof parsed.summary.patch, "number");

    // Verify package structure if any packages are outdated
    if (parsed.packages.length > 0) {
      const pkg = parsed.packages[0];
      assert.ok(pkg.name);
      assert.ok(pkg.current);
      assert.ok(pkg.latest);
      assert.ok(pkg.wanted);
      assert.ok(pkg.range);
      assert.ok(["patch", "minor", "major", "prerelease", "unknown"].includes(pkg.updateType));
      assert.equal(typeof pkg.isDev, "boolean");
    }
  } finally {
    await rmrf(dir);
  }
});

test("outdated --production filters devDependencies", { skip: "Skipped to avoid slow registry calls in CI" }, async () => {
  const dir = await makeTempDir("better-outdated-prod-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "outdated-prod-test",
      version: "1.0.0",
      dependencies: {
        "left-pad": "^1.0.0"
      },
      devDependencies: {
        "is-number": "^6.0.0"
      }
    });

    await writeJson(path.join(dir, "package-lock.json"), {
      name: "outdated-prod-test",
      version: "1.0.0",
      lockfileVersion: 3,
      packages: {
        "": {
          name: "outdated-prod-test",
          version: "1.0.0"
        },
        "node_modules/left-pad": {
          version: "1.0.0"
        },
        "node_modules/is-number": {
          version: "6.0.0",
          dev: true
        }
      }
    });

    const output = await captureStdoutAsync(() =>
      cmdOutdated(["--json", "--production", "--project-root", dir])
    );

    const parsed = JSON.parse(output);
    assert.equal(parsed.ok, true);

    // Should only check production dependency (left-pad), not devDependency (is-number)
    assert.equal(parsed.summary.totalChecked, 1);

    // Verify no devDependencies in results
    const devPackages = parsed.packages.filter(p => p.isDev === true);
    assert.equal(devPackages.length, 0);
  } finally {
    await rmrf(dir);
  }
});

test("outdated handles missing lockfile gracefully", { skip: "Skipped to avoid slow registry calls in CI" }, async () => {
  const dir = await makeTempDir("better-outdated-no-lock-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "outdated-no-lock-test",
      version: "1.0.0",
      dependencies: {
        "left-pad": "^1.0.0"
      }
    });

    // No package-lock.json created

    const output = await captureStdoutAsync(() =>
      cmdOutdated(["--json", "--project-root", dir])
    );

    const parsed = JSON.parse(output);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.kind, "better.outdated");
    // Without lockfile, no current versions, so no outdated packages reported
    assert.ok(Array.isArray(parsed.packages));
  } finally {
    await rmrf(dir);
  }
});

test("outdated text output shows table", async () => {
  const dir = await makeTempDir("better-outdated-text-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "outdated-text-test",
      version: "1.0.0"
    });

    const output = await captureStdoutAsync(() =>
      cmdOutdated(["--project-root", dir])
    );

    // With no dependencies, should show "up to date" or similar message
    assert.match(output, /No dependencies|up to date/i);
  } finally {
    await rmrf(dir);
  }
});

test("outdated --level filters by update type", { skip: "Skipped to avoid slow registry calls in CI" }, async () => {
  const dir = await makeTempDir("better-outdated-level-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "outdated-level-test",
      version: "1.0.0",
      dependencies: {
        "left-pad": "^1.0.0"
      }
    });

    await writeJson(path.join(dir, "package-lock.json"), {
      name: "outdated-level-test",
      version: "1.0.0",
      lockfileVersion: 3,
      packages: {
        "": {
          name: "outdated-level-test",
          version: "1.0.0"
        },
        "node_modules/left-pad": {
          version: "1.0.0"
        }
      }
    });

    const output = await captureStdoutAsync(() =>
      cmdOutdated(["--json", "--level", "major", "--project-root", dir])
    );

    const parsed = JSON.parse(output);
    assert.equal(parsed.ok, true);

    // All packages in result should be major updates
    const nonMajor = parsed.packages.filter(p => p.updateType !== "major");
    assert.equal(nonMajor.length, 0);
  } finally {
    await rmrf(dir);
  }
});
