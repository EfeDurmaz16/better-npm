import { test } from "node:test";
import assert from "node:assert";
import path from "node:path";
import { spawn } from "node:child_process";
import { makeTempDir, rmrf, writeJson, writeFile } from "./helpers.js";
import {
  loadScriptPolicy,
  isScriptAllowed,
  saveScriptPolicy,
  scanNodeModulesForScripts
} from "../src/lib/scriptPolicy.js";

function runCli(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const cliPath = path.join(process.cwd(), "src", "cli.js");
    const child = spawn("node", [cliPath, ...args], {
      cwd: opts.cwd ?? process.cwd(),
      env: { ...process.env, ...opts.env }
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });

    child.on("error", reject);
  });
}

test("default policy blocks all scripts", async () => {
  const tempDir = await makeTempDir();
  try {
    const policy = await loadScriptPolicy(tempDir);
    assert.strictEqual(policy.defaultPolicy, "block");
    assert.strictEqual(isScriptAllowed("some-package", "install", policy), false);
  } finally {
    await rmrf(tempDir);
  }
});

test("allowed package passes check", async () => {
  const tempDir = await makeTempDir();
  try {
    const policy = {
      defaultPolicy: "block",
      allowedPackages: ["esbuild", "sharp"],
      blockedPackages: [],
      allowedScriptTypes: [],
      trustedScopes: []
    };

    assert.strictEqual(isScriptAllowed("esbuild", "postinstall", policy), true);
    assert.strictEqual(isScriptAllowed("sharp", "install", policy), true);
    assert.strictEqual(isScriptAllowed("untrusted", "install", policy), false);
  } finally {
    await rmrf(tempDir);
  }
});

test("blocked package fails check", async () => {
  const tempDir = await makeTempDir();
  try {
    const policy = {
      defaultPolicy: "allow",
      allowedPackages: [],
      blockedPackages: ["malicious-pkg"],
      allowedScriptTypes: [],
      trustedScopes: []
    };

    assert.strictEqual(isScriptAllowed("malicious-pkg", "install", policy), false);
    assert.strictEqual(isScriptAllowed("good-pkg", "install", policy), true);
  } finally {
    await rmrf(tempDir);
  }
});

test("trusted scopes are allowed", async () => {
  const tempDir = await makeTempDir();
  try {
    const policy = {
      defaultPolicy: "block",
      allowedPackages: [],
      blockedPackages: [],
      allowedScriptTypes: [],
      trustedScopes: ["@myorg", "@internal"]
    };

    assert.strictEqual(isScriptAllowed("@myorg/package-a", "install", policy), true);
    assert.strictEqual(isScriptAllowed("@internal/tool", "postinstall", policy), true);
    assert.strictEqual(isScriptAllowed("@other/package", "install", policy), false);
    assert.strictEqual(isScriptAllowed("regular-package", "install", policy), false);
  } finally {
    await rmrf(tempDir);
  }
});

test("save and load policy roundtrip from .better-scripts.json", async () => {
  const tempDir = await makeTempDir();
  try {
    const originalPolicy = {
      defaultPolicy: "block",
      allowedPackages: ["pkg-a", "pkg-b"],
      blockedPackages: ["bad-pkg"],
      allowedScriptTypes: ["postinstall"],
      trustedScopes: ["@trusted"]
    };

    await saveScriptPolicy(tempDir, originalPolicy);
    const loadedPolicy = await loadScriptPolicy(tempDir);

    assert.deepStrictEqual(loadedPolicy, originalPolicy);
  } finally {
    await rmrf(tempDir);
  }
});

test("load policy from package.json betterScripts field", async () => {
  const tempDir = await makeTempDir();
  try {
    const pkg = {
      name: "test-project",
      version: "1.0.0",
      betterScripts: {
        defaultPolicy: "block",
        allowedPackages: ["esbuild"],
        trustedScopes: ["@mycompany"]
      }
    };

    await writeJson(path.join(tempDir, "package.json"), pkg);
    const policy = await loadScriptPolicy(tempDir);

    assert.strictEqual(policy.defaultPolicy, "block");
    assert.deepStrictEqual(policy.allowedPackages, ["esbuild"]);
    assert.deepStrictEqual(policy.trustedScopes, ["@mycompany"]);
  } finally {
    await rmrf(tempDir);
  }
});

test("scan detects install scripts in node_modules", async () => {
  const tempDir = await makeTempDir();
  try {
    const nodeModulesPath = path.join(tempDir, "node_modules");

    // Create fake packages with install scripts
    await writeJson(path.join(nodeModulesPath, "pkg-with-install", "package.json"), {
      name: "pkg-with-install",
      version: "1.0.0",
      scripts: {
        install: "node install.js",
        test: "echo test"
      }
    });

    await writeJson(path.join(nodeModulesPath, "pkg-with-postinstall", "package.json"), {
      name: "pkg-with-postinstall",
      version: "2.0.0",
      scripts: {
        postinstall: "node build.js"
      }
    });

    await writeJson(path.join(nodeModulesPath, "pkg-no-scripts", "package.json"), {
      name: "pkg-no-scripts",
      version: "1.0.0"
    });

    await writeJson(path.join(nodeModulesPath, "@scoped", "pkg", "package.json"), {
      name: "@scoped/pkg",
      version: "3.0.0",
      scripts: {
        preinstall: "echo preinstall",
        prepare: "echo prepare"
      }
    });

    const results = await scanNodeModulesForScripts(nodeModulesPath);

    assert.strictEqual(results.length, 3);

    const pkgNames = results.map(r => r.name).sort();
    assert.deepStrictEqual(pkgNames, ["@scoped/pkg", "pkg-with-install", "pkg-with-postinstall"]);

    const installPkg = results.find(r => r.name === "pkg-with-install");
    assert.ok(installPkg);
    assert.strictEqual(installPkg.version, "1.0.0");
    assert.ok(installPkg.scripts.install);
    assert.strictEqual(installPkg.scripts.test, undefined);

    const postinstallPkg = results.find(r => r.name === "pkg-with-postinstall");
    assert.ok(postinstallPkg);
    assert.ok(postinstallPkg.scripts.postinstall);

    const scopedPkg = results.find(r => r.name === "@scoped/pkg");
    assert.ok(scopedPkg);
    assert.ok(scopedPkg.scripts.preinstall);
    assert.ok(scopedPkg.scripts.prepare);
  } finally {
    await rmrf(tempDir);
  }
});

test("CLI: better scripts scan --json produces valid output (direct command test)", async (t) => {
  const tempDir = await makeTempDir();
  try {
    const nodeModulesPath = path.join(tempDir, "node_modules");

    await writeJson(path.join(nodeModulesPath, "esbuild", "package.json"), {
      name: "esbuild",
      version: "0.19.0",
      scripts: {
        postinstall: "node install.js"
      }
    });

    await writeJson(path.join(nodeModulesPath, "sharp", "package.json"), {
      name: "sharp",
      version: "0.32.0",
      scripts: {
        install: "node-gyp rebuild"
      }
    });

    // Import command directly and test
    const { cmdScripts } = await import("../src/commands/scripts.js");
    const { setRuntimeConfig } = await import("../src/lib/config.js");

    // Capture output
    let capturedOutput = "";
    const originalWrite = process.stdout.write;
    process.stdout.write = (chunk) => {
      capturedOutput += chunk;
      return true;
    };

    try {
      setRuntimeConfig({ json: true });
      await cmdScripts(["scan", "--json", "--project-root", tempDir]);
    } finally {
      process.stdout.write = originalWrite;
    }

    const output = JSON.parse(capturedOutput);
    assert.strictEqual(output.ok, true);
    assert.strictEqual(output.kind, "better.scripts.scan");
    assert.strictEqual(output.schemaVersion, 1);
    assert.ok(Array.isArray(output.packages));
    assert.strictEqual(output.packages.length, 2);
    assert.ok(output.summary);
    assert.strictEqual(output.summary.totalWithScripts, 2);
    assert.strictEqual(output.summary.allowed, 0);
    assert.strictEqual(output.summary.blocked, 2);

    const esbuildEntry = output.packages.find(p => p.name === "esbuild");
    assert.ok(esbuildEntry);
    assert.strictEqual(esbuildEntry.version, "0.19.0");
    assert.strictEqual(esbuildEntry.policy, "blocked");
    assert.ok(esbuildEntry.scripts.postinstall);
  } finally {
    await rmrf(tempDir);
  }
});

test("CLI: better scripts allow adds to allowlist (direct command test)", async () => {
  const tempDir = await makeTempDir();
  try {
    const { cmdScripts } = await import("../src/commands/scripts.js");
    const { setRuntimeConfig } = await import("../src/lib/config.js");

    let capturedOutput = "";
    const originalWrite = process.stdout.write;
    process.stdout.write = (chunk) => {
      capturedOutput += chunk;
      return true;
    };

    try {
      setRuntimeConfig({ json: true });
      await cmdScripts(["allow", "esbuild", "--json", "--project-root", tempDir]);
    } finally {
      process.stdout.write = originalWrite;
    }

    const output = JSON.parse(capturedOutput);
    assert.strictEqual(output.ok, true);
    assert.strictEqual(output.kind, "better.scripts.allow");
    assert.strictEqual(output.package, "esbuild");
    assert.ok(output.policy.allowedPackages.includes("esbuild"));

    // Verify it was persisted
    const policy = await loadScriptPolicy(tempDir);
    assert.ok(policy.allowedPackages.includes("esbuild"));
  } finally {
    await rmrf(tempDir);
  }
});

test("CLI: better scripts block adds to blocklist (direct command test)", async () => {
  const tempDir = await makeTempDir();
  try {
    const { cmdScripts } = await import("../src/commands/scripts.js");
    const { setRuntimeConfig } = await import("../src/lib/config.js");

    setRuntimeConfig({ json: true });

    // First add to allowlist
    let capturedOutput = "";
    const originalWrite = process.stdout.write;
    process.stdout.write = (chunk) => {
      capturedOutput += chunk;
      return true;
    };

    try {
      await cmdScripts(["allow", "suspect-pkg", "--project-root", tempDir]);
      capturedOutput = ""; // Reset for next command

      // Then block it
      await cmdScripts(["block", "suspect-pkg", "--json", "--project-root", tempDir]);
    } finally {
      process.stdout.write = originalWrite;
    }

    const output = JSON.parse(capturedOutput);
    assert.strictEqual(output.ok, true);
    assert.strictEqual(output.kind, "better.scripts.block");
    assert.strictEqual(output.package, "suspect-pkg");
    assert.ok(output.policy.blockedPackages.includes("suspect-pkg"));
    assert.ok(!output.policy.allowedPackages.includes("suspect-pkg"));

    // Verify it was persisted
    const policy = await loadScriptPolicy(tempDir);
    assert.ok(policy.blockedPackages.includes("suspect-pkg"));
    assert.ok(!policy.allowedPackages.includes("suspect-pkg"));
  } finally {
    await rmrf(tempDir);
  }
});

test("CLI: better scripts list shows policy (direct command test)", async () => {
  const tempDir = await makeTempDir();
  try {
    const policy = {
      defaultPolicy: "block",
      allowedPackages: ["pkg-a", "pkg-b"],
      blockedPackages: ["bad-pkg"],
      allowedScriptTypes: ["postinstall"],
      trustedScopes: ["@trusted"]
    };

    await saveScriptPolicy(tempDir, policy);

    const { cmdScripts } = await import("../src/commands/scripts.js");
    const { setRuntimeConfig } = await import("../src/lib/config.js");

    let capturedOutput = "";
    const originalWrite = process.stdout.write;
    process.stdout.write = (chunk) => {
      capturedOutput += chunk;
      return true;
    };

    try {
      setRuntimeConfig({ json: true });
      await cmdScripts(["list", "--json", "--project-root", tempDir]);
    } finally {
      process.stdout.write = originalWrite;
    }

    const output = JSON.parse(capturedOutput);
    assert.strictEqual(output.ok, true);
    assert.strictEqual(output.kind, "better.scripts.list");
    assert.deepStrictEqual(output.policy, policy);
  } finally {
    await rmrf(tempDir);
  }
});

test("allowed script types work correctly", async () => {
  const tempDir = await makeTempDir();
  try {
    const policy = {
      defaultPolicy: "block",
      allowedPackages: [],
      blockedPackages: [],
      allowedScriptTypes: ["postinstall"],
      trustedScopes: []
    };

    assert.strictEqual(isScriptAllowed("any-package", "postinstall", policy), true);
    assert.strictEqual(isScriptAllowed("any-package", "install", policy), false);
    assert.strictEqual(isScriptAllowed("any-package", "preinstall", policy), false);
  } finally {
    await rmrf(tempDir);
  }
});

test("blocklist takes precedence over allowlist", async () => {
  const tempDir = await makeTempDir();
  try {
    const policy = {
      defaultPolicy: "allow",
      allowedPackages: ["suspect-pkg"],
      blockedPackages: ["suspect-pkg"],
      allowedScriptTypes: [],
      trustedScopes: []
    };

    // Blocked should win even if also in allowed
    assert.strictEqual(isScriptAllowed("suspect-pkg", "install", policy), false);
  } finally {
    await rmrf(tempDir);
  }
});

test("scan with allowlist shows correct policy status (direct command test)", async () => {
  const tempDir = await makeTempDir();
  try {
    const nodeModulesPath = path.join(tempDir, "node_modules");

    await writeJson(path.join(nodeModulesPath, "allowed-pkg", "package.json"), {
      name: "allowed-pkg",
      version: "1.0.0",
      scripts: { install: "echo install" }
    });

    await writeJson(path.join(nodeModulesPath, "blocked-pkg", "package.json"), {
      name: "blocked-pkg",
      version: "1.0.0",
      scripts: { install: "echo install" }
    });

    const policy = {
      defaultPolicy: "block",
      allowedPackages: ["allowed-pkg"],
      blockedPackages: [],
      allowedScriptTypes: [],
      trustedScopes: []
    };

    await saveScriptPolicy(tempDir, policy);

    const { cmdScripts } = await import("../src/commands/scripts.js");
    const { setRuntimeConfig } = await import("../src/lib/config.js");

    let capturedOutput = "";
    const originalWrite = process.stdout.write;
    process.stdout.write = (chunk) => {
      capturedOutput += chunk;
      return true;
    };

    try {
      setRuntimeConfig({ json: true });
      await cmdScripts(["scan", "--json", "--project-root", tempDir]);
    } finally {
      process.stdout.write = originalWrite;
    }

    const output = JSON.parse(capturedOutput);
    assert.strictEqual(output.summary.allowed, 1);
    assert.strictEqual(output.summary.blocked, 1);

    const allowedEntry = output.packages.find(p => p.name === "allowed-pkg");
    assert.strictEqual(allowedEntry.policy, "allowed");
    assert.strictEqual(allowedEntry.reason, "in allowlist");

    const blockedEntry = output.packages.find(p => p.name === "blocked-pkg");
    assert.strictEqual(blockedEntry.policy, "blocked");
  } finally {
    await rmrf(tempDir);
  }
});

test("empty node_modules returns empty scan", async () => {
  const tempDir = await makeTempDir();
  try {
    const nodeModulesPath = path.join(tempDir, "node_modules");
    const results = await scanNodeModulesForScripts(nodeModulesPath);
    assert.strictEqual(results.length, 0);
  } finally {
    await rmrf(tempDir);
  }
});

test("invalid package names return false", async () => {
  const policy = {
    defaultPolicy: "allow",
    allowedPackages: [],
    blockedPackages: [],
    allowedScriptTypes: [],
    trustedScopes: []
  };

  assert.strictEqual(isScriptAllowed(null, "install", policy), false);
  assert.strictEqual(isScriptAllowed(undefined, "install", policy), false);
  assert.strictEqual(isScriptAllowed("", "install", policy), false);
});

test("CLI: better scripts scan text output (direct command test)", async () => {
  const tempDir = await makeTempDir();
  try {
    const nodeModulesPath = path.join(tempDir, "node_modules");

    await writeJson(path.join(nodeModulesPath, "test-pkg", "package.json"), {
      name: "test-pkg",
      version: "1.0.0",
      scripts: { postinstall: "node install.js" }
    });

    const { cmdScripts } = await import("../src/commands/scripts.js");
    const { setRuntimeConfig } = await import("../src/lib/config.js");

    let capturedOutput = "";
    const originalWrite = process.stdout.write;
    process.stdout.write = (chunk) => {
      capturedOutput += chunk;
      return true;
    };

    try {
      setRuntimeConfig({ json: false });
      await cmdScripts(["scan", "--project-root", tempDir]);
    } finally {
      process.stdout.write = originalWrite;
    }

    assert.ok(capturedOutput.includes("Install Script Scan Results"));
    assert.ok(capturedOutput.includes("test-pkg@1.0.0"));
  } finally {
    await rmrf(tempDir);
  }
});
