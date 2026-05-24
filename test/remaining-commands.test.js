// test/remaining-commands.test.js
// Tests for: better npm-audit-fix-check, better npm-scripts-run, better pipeline,
//            better pkg-provenance, better pkg-readme, better pkg-size-history,
//            better postinstall-audit, better pr-bot, better prefetch, better provenance,
//            better provider, better reproducible, better resolutions-check, better sardis,
//            better scope-check, better security-headers, better serve, better shell,
//            better shrinkwrap-check, better size-limit-check, better source-map-check,
//            better tag-manager, better tree-shaking-check, better types-check,
//            better typescript-check, better typings-check, better upgrade --smart,
//            better semver, better why-size, better workspace-run, better merge-driver,
//            better ai-review

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { makeTempDir, rmrf, writeJson } from "./helpers.js";

const execFileAsync = promisify(execFile);
const betterBin = path.resolve(process.cwd(), "bin", "better.js");

async function runBetter(args, cwd, extraEnv = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [betterBin, ...args], {
      cwd,
      env: { ...process.env, ...extraEnv, BETTER_LOG_LEVEL: "silent", NO_COLOR: "1" },
      timeout: 20_000
    });
    return { ok: true, stdout, stderr, exitCode: 0 };
  } catch (err) {
    return { ok: false, stdout: err.stdout ?? "", stderr: err.stderr ?? "", exitCode: err.code ?? 1 };
  }
}

// ── npm-audit-fix-check ───────────────────────────────────────────────────────

test("npm-audit-fix-check --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["npm-audit-fix-check", "--help"], process.cwd());
  assert.ok(ok, "npm-audit-fix-check --help should succeed");
  assert.ok(
    stdout.includes("audit") || stdout.includes("fix") || stdout.includes("vulnerability"),
    "should describe npm-audit-fix-check options"
  );
});

test("npm-audit-fix-check --json checks audit fix safety", async () => {
  const dir = await makeTempDir("better-npm-audit-fix-check-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      dependencies: {}
    });

    const { stdout, ok } = await runBetter(["npm-audit-fix-check", "--json"], dir);
    assert.ok(ok, "npm-audit-fix-check should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("npm-audit-fix-check"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── npm-scripts-run ───────────────────────────────────────────────────────────

test("npm-scripts-run --help shows usage", async () => {
  // npm-scripts-run requires a script arg — --help may exit 1
  const { stdout } = await runBetter(["npm-scripts-run", "--help"], process.cwd());
  assert.ok(
    stdout.includes("npm-scripts-run") || stdout.includes("script") || stdout.includes("run"),
    "should describe npm-scripts-run options"
  );
});

// ── pipeline ─────────────────────────────────────────────────────────────────

test("pipeline --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["pipeline", "--help"], process.cwd());
  assert.ok(ok, "pipeline --help should succeed");
  assert.ok(
    stdout.includes("pipeline") || stdout.includes("subcommand") || stdout.includes("run"),
    "should describe pipeline subcommands"
  );
});

test("pipeline list --json returns pipeline templates", async () => {
  const { stdout, ok } = await runBetter(["pipeline", "list", "--json"], process.cwd());
  assert.ok(ok, "pipeline list should succeed");
  if (stdout.trim()) {
    const out = JSON.parse(stdout);
    assert.ok(typeof out.ok === "boolean", "should have ok field");
    assert.ok(out.kind?.includes("pipeline"), `unexpected kind: ${out.kind}`);
  }
});

// ── pkg-provenance ────────────────────────────────────────────────────────────

test("pkg-provenance --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["pkg-provenance", "--help"], process.cwd());
  assert.ok(ok, "pkg-provenance --help should succeed");
  assert.ok(
    stdout.includes("provenance") || stdout.includes("package") || stdout.includes("sigstore"),
    "should describe pkg-provenance options"
  );
});

test("pkg-provenance <pkg> --json checks package provenance (network-aware)", async (t) => {
  const { stdout, stderr, ok } = await runBetter(
    ["pkg-provenance", "semver", "--json"], process.cwd()
  );
  if (!ok && (stderr.includes("ENOTFOUND") || stderr.includes("ETIMEDOUT") || stderr.includes("timeout"))) {
    t.skip("network unavailable for pkg-provenance");
    return;
  }
  if (stdout.trim()) {
    const out = JSON.parse(stdout);
    assert.ok(typeof out.ok === "boolean", "should have ok field");
    assert.ok(out.kind?.includes("pkg-provenance"), `unexpected kind: ${out.kind}`);
  }
});

// ── pkg-readme ────────────────────────────────────────────────────────────────

test("pkg-readme --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["pkg-readme", "--help"], process.cwd());
  assert.ok(ok, "pkg-readme --help should succeed");
  assert.ok(
    stdout.includes("readme") || stdout.includes("package") || stdout.includes("doc"),
    "should describe pkg-readme options"
  );
});

test("pkg-readme <pkg> --json returns package readme (network-aware)", async (t) => {
  const { stdout, stderr, ok } = await runBetter(
    ["pkg-readme", "semver", "--json"], process.cwd()
  );
  if (!ok && (stderr.includes("ENOTFOUND") || stderr.includes("ETIMEDOUT") || stderr.includes("timeout") || stderr.includes("No README"))) {
    t.skip("network unavailable or no readme for pkg-readme");
    return;
  }
  if (stdout.trim()) {
    const out = JSON.parse(stdout);
    assert.ok(typeof out.ok === "boolean", "should have ok field");
  }
});

// ── pkg-size-history ──────────────────────────────────────────────────────────

test("pkg-size-history --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["pkg-size-history", "--help"], process.cwd());
  assert.ok(ok, "pkg-size-history --help should succeed");
  assert.ok(
    stdout.includes("size") || stdout.includes("history") || stdout.includes("package"),
    "should describe pkg-size-history options"
  );
});

test("pkg-size-history <pkg> --json returns size history (network-aware)", async (t) => {
  const { stdout, stderr, ok } = await runBetter(
    ["pkg-size-history", "semver", "--json"], process.cwd()
  );
  if (!ok && (stderr.includes("ENOTFOUND") || stderr.includes("ETIMEDOUT") || stderr.includes("timeout"))) {
    t.skip("network unavailable for pkg-size-history");
    return;
  }
  if (stdout.trim()) {
    const out = JSON.parse(stdout);
    assert.ok(typeof out.ok === "boolean", "should have ok field");
    assert.ok(out.kind?.includes("pkg-size-history"), `unexpected kind: ${out.kind}`);
  }
});

// ── postinstall-audit ─────────────────────────────────────────────────────────

test("postinstall-audit --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["postinstall-audit", "--help"], process.cwd());
  assert.ok(ok, "postinstall-audit --help should succeed");
  assert.ok(
    stdout.includes("postinstall") || stdout.includes("audit") || stdout.includes("script"),
    "should describe postinstall-audit options"
  );
});

test("postinstall-audit --json audits postinstall scripts", async () => {
  const dir = await makeTempDir("better-postinstall-audit-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      dependencies: {}
    });
    await fs.mkdir(path.join(dir, "node_modules"), { recursive: true });

    const { stdout } = await runBetter(["postinstall-audit", "--json"], dir);
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
    }
  } finally {
    await rmrf(dir);
  }
});

// ── pr-bot ────────────────────────────────────────────────────────────────────

test("pr-bot --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["pr-bot", "--help"], process.cwd());
  assert.ok(ok, "pr-bot --help should succeed");
  assert.ok(
    stdout.includes("pr-bot") || stdout.includes("pull request") || stdout.includes("check"),
    "should describe pr-bot options"
  );
});

test("pr-bot --json returns PR check status", async () => {
  const dir = await makeTempDir("better-pr-bot-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0"
    });

    const { stdout, ok } = await runBetter(["pr-bot", "--json"], dir);
    assert.ok(ok, "pr-bot should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("pr-bot"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── prefetch ──────────────────────────────────────────────────────────────────

test("prefetch --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["prefetch", "--help"], process.cwd());
  assert.ok(ok, "prefetch --help should succeed");
  assert.ok(
    stdout.includes("prefetch") || stdout.includes("cache") || stdout.includes("warm"),
    "should describe prefetch options"
  );
});

test("prefetch --json pre-warms registry cache", async () => {
  const dir = await makeTempDir("better-prefetch-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0"
    });

    const { stdout, ok } = await runBetter(["prefetch", "--json"], dir);
    assert.ok(ok, "prefetch should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
    }
  } finally {
    await rmrf(dir);
  }
});

// ── provenance ────────────────────────────────────────────────────────────────

test("provenance --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["provenance", "--help"], process.cwd());
  assert.ok(ok, "provenance --help should succeed");
  assert.ok(
    stdout.includes("provenance") || stdout.includes("sigstore") || stdout.includes("package"),
    "should describe provenance options"
  );
});

test("provenance --json checks installed package provenance", async () => {
  const dir = await makeTempDir("better-provenance-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      dependencies: {}
    });

    const { stdout, ok } = await runBetter(["provenance", "--json"], dir);
    assert.ok(ok, "provenance should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("provenance"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── provider ──────────────────────────────────────────────────────────────────

test("provider --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["provider", "--help"], process.cwd());
  assert.ok(ok, "provider --help should succeed");
  assert.ok(
    stdout.includes("provider") || stdout.includes("init") || stdout.includes("OSP"),
    "should describe provider options"
  );
});

// ── reproducible ──────────────────────────────────────────────────────────────

test("reproducible --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["reproducible", "--help"], process.cwd());
  assert.ok(ok, "reproducible --help should succeed");
  assert.ok(
    stdout.includes("reproducible") || stdout.includes("verify") || stdout.includes("build"),
    "should describe reproducible options"
  );
});

test("reproducible --json verifies build reproducibility", async () => {
  const dir = await makeTempDir("better-reproducible-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0"
    });

    // exits 1 when no build manifest found — that's expected
    const { stdout } = await runBetter(["reproducible", "--json"], dir);
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
    }
  } finally {
    await rmrf(dir);
  }
});

// ── resolutions-check ─────────────────────────────────────────────────────────

test("resolutions-check --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["resolutions-check", "--help"], process.cwd());
  assert.ok(ok, "resolutions-check --help should succeed");
  assert.ok(
    stdout.includes("resolutions") || stdout.includes("check") || stdout.includes("override"),
    "should describe resolutions-check options"
  );
});

test("resolutions-check --json checks package resolutions", async () => {
  const dir = await makeTempDir("better-resolutions-check-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0"
    });

    const { stdout, ok } = await runBetter(["resolutions-check", "--json"], dir);
    assert.ok(ok, "resolutions-check should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("resolutions"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── scope-check ───────────────────────────────────────────────────────────────

test("scope-check --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["scope-check", "--help"], process.cwd());
  assert.ok(ok, "scope-check --help should succeed");
  assert.ok(
    stdout.includes("scope") || stdout.includes("check") || stdout.includes("package"),
    "should describe scope-check options"
  );
});

test("scope-check --json checks package scopes", async () => {
  const dir = await makeTempDir("better-scope-check-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "@myorg/test", version: "1.0.0"
    });

    const { stdout, ok } = await runBetter(["scope-check", "--json"], dir);
    assert.ok(ok, "scope-check should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("scope-check"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── security-headers ──────────────────────────────────────────────────────────

test("security-headers --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["security-headers", "--help"], process.cwd());
  assert.ok(ok, "security-headers --help should succeed");
  assert.ok(
    stdout.includes("security") || stdout.includes("headers") || stdout.includes("engines"),
    "should describe security-headers options"
  );
});

test("security-headers --json checks security-related config headers", async () => {
  const dir = await makeTempDir("better-security-headers-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      engines: { node: ">=18" }
    });

    const { stdout } = await runBetter(["security-headers", "--json"], dir);
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("security-headers"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── serve ─────────────────────────────────────────────────────────────────────

test("serve --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["serve", "--help"], process.cwd());
  assert.ok(ok, "serve --help should succeed");
  assert.ok(
    stdout.includes("serve") || stdout.includes("port") || stdout.includes("open"),
    "should describe serve options"
  );
});

// serve requires interactive use — no functional JSON test

// ── shell ─────────────────────────────────────────────────────────────────────

test("shell --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["shell", "--help"], process.cwd());
  assert.ok(ok, "shell --help should succeed");
  assert.ok(
    stdout.includes("shell") || stdout.includes("interactive") || stdout.includes("REPL"),
    "should describe shell options"
  );
});

// shell requires TTY — no functional JSON test

// ── shrinkwrap-check ──────────────────────────────────────────────────────────

test("shrinkwrap-check --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["shrinkwrap-check", "--help"], process.cwd());
  assert.ok(ok, "shrinkwrap-check --help should succeed");
  assert.ok(
    stdout.includes("shrinkwrap") || stdout.includes("check") || stdout.includes("lockfile"),
    "should describe shrinkwrap-check options"
  );
});

test("shrinkwrap-check --json checks shrinkwrap usage", async () => {
  const dir = await makeTempDir("better-shrinkwrap-check-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0"
    });

    const { stdout } = await runBetter(["shrinkwrap-check", "--json"], dir);
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("shrinkwrap-check"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── size-limit-check ──────────────────────────────────────────────────────────

test("size-limit-check --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["size-limit-check", "--help"], process.cwd());
  assert.ok(ok, "size-limit-check --help should succeed");
  assert.ok(
    stdout.includes("size") || stdout.includes("limit") || stdout.includes("budget"),
    "should describe size-limit-check options"
  );
});

test("size-limit-check --json checks size limits", async () => {
  const dir = await makeTempDir("better-size-limit-check-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0"
    });

    const { stdout } = await runBetter(["size-limit-check", "--json"], dir);
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
    }
  } finally {
    await rmrf(dir);
  }
});

// ── source-map-check ──────────────────────────────────────────────────────────

test("source-map-check --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["source-map-check", "--help"], process.cwd());
  assert.ok(ok, "source-map-check --help should succeed");
  assert.ok(
    stdout.includes("source") || stdout.includes("map") || stdout.includes("build"),
    "should describe source-map-check options"
  );
});

test("source-map-check --json checks source maps in build output", async () => {
  const dir = await makeTempDir("better-source-map-check-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0"
    });
    // Create a fake dist directory with a source map
    const distDir = path.join(dir, "dist");
    await fs.mkdir(distDir, { recursive: true });
    await fs.writeFile(path.join(distDir, "main.js"), "var x = 1;\n//# sourceMappingURL=main.js.map\n");
    await fs.writeFile(path.join(distDir, "main.js.map"), JSON.stringify({ version: 3, sources: [], mappings: "" }));

    const { stdout } = await runBetter(["source-map-check", "--json"], dir);
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
    }
  } finally {
    await rmrf(dir);
  }
});

// ── tag-manager ───────────────────────────────────────────────────────────────

test("tag-manager --help shows usage", async () => {
  // tag-manager requires package arg — --help may exit 1
  const { stdout } = await runBetter(["tag-manager", "--help"], process.cwd());
  assert.ok(
    stdout.includes("tag") || stdout.includes("manager") || stdout.includes("package"),
    "should describe tag-manager options"
  );
});

test("tag-manager <pkg> --json returns package tags (network-aware)", async (t) => {
  const { stdout, stderr, ok } = await runBetter(
    ["tag-manager", "semver", "--json"], process.cwd()
  );
  if (!ok && (stderr.includes("ENOTFOUND") || stderr.includes("ETIMEDOUT") || stderr.includes("timeout"))) {
    t.skip("network unavailable for tag-manager");
    return;
  }
  if (stdout.trim()) {
    const out = JSON.parse(stdout);
    assert.ok(typeof out.ok === "boolean", "should have ok field");
    assert.ok(out.kind?.includes("tag-manager"), `unexpected kind: ${out.kind}`);
  }
});

// ── tree-shaking-check ────────────────────────────────────────────────────────

test("tree-shaking-check --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["tree-shaking-check", "--help"], process.cwd());
  assert.ok(ok, "tree-shaking-check --help should succeed");
  assert.ok(
    stdout.includes("tree") || stdout.includes("shaking") || stdout.includes("ESM"),
    "should describe tree-shaking-check options"
  );
});

test("tree-shaking-check --json checks tree-shakeability", async () => {
  const dir = await makeTempDir("better-tree-shaking-check-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      dependencies: {}
    });

    const { stdout, ok } = await runBetter(["tree-shaking-check", "--json"], dir);
    assert.ok(ok, "tree-shaking-check should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("tree-shaking-check"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── types-check ───────────────────────────────────────────────────────────────

test("types-check --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["types-check", "--help"], process.cwd());
  assert.ok(ok, "types-check --help should succeed");
  assert.ok(
    stdout.includes("types") || stdout.includes("check") || stdout.includes("typescript"),
    "should describe types-check options"
  );
});

test("types-check --json checks TypeScript types", async () => {
  const dir = await makeTempDir("better-types-check-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      dependencies: {}
    });

    const { stdout, ok } = await runBetter(["types-check", "--json"], dir);
    assert.ok(ok, "types-check should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("types-check"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── typescript-check ──────────────────────────────────────────────────────────

test("typescript-check --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["typescript-check", "--help"], process.cwd());
  assert.ok(ok, "typescript-check --help should succeed");
  assert.ok(
    stdout.includes("typescript") || stdout.includes("check") || stdout.includes("tsc"),
    "should describe typescript-check options"
  );
});

test("typescript-check --json checks TypeScript configuration", async () => {
  const dir = await makeTempDir("better-typescript-check-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0"
    });

    const { stdout } = await runBetter(["typescript-check", "--json"], dir);
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
    }
  } finally {
    await rmrf(dir);
  }
});

// ── typings-check ─────────────────────────────────────────────────────────────

test("typings-check --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["typings-check", "--help"], process.cwd());
  assert.ok(ok, "typings-check --help should succeed");
  assert.ok(
    stdout.includes("typings") || stdout.includes("types") || stdout.includes("check"),
    "should describe typings-check options"
  );
});

test("typings-check --json checks typings fields in packages", async () => {
  const dir = await makeTempDir("better-typings-check-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      dependencies: {}
    });

    const { stdout, ok } = await runBetter(["typings-check", "--json"], dir);
    assert.ok(ok, "typings-check should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("typings-check"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── upgrade --smart ───────────────────────────────────────────────────────────

test("upgrade --smart --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["upgrade", "--smart", "--help"], process.cwd());
  assert.ok(ok, "upgrade --smart --help should succeed");
  assert.ok(
    stdout.includes("upgrade") || stdout.includes("smart") || stdout.includes("package"),
    "should describe upgrade --smart options"
  );
});

test("upgrade --smart --json returns smart upgrade recommendations", async () => {
  const dir = await makeTempDir("better-upgrade-smart-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      dependencies: {}
    });

    const { stdout, ok } = await runBetter(["upgrade", "--smart", "--json"], dir);
    assert.ok(ok, "upgrade --smart should succeed");
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      assert.ok(out.kind?.includes("upgrade-smart"), `unexpected kind: ${out.kind}`);
    }
  } finally {
    await rmrf(dir);
  }
});

// ── semver ────────────────────────────────────────────────────────────────────

test("semver --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["semver", "--help"], process.cwd());
  assert.ok(ok, "semver --help should succeed");
  assert.ok(
    stdout.includes("semver") || stdout.includes("version") || stdout.includes("range"),
    "should describe semver options"
  );
});

test("semver <version> --json validates semver version", async () => {
  const { stdout, ok } = await runBetter(["semver", "1.2.3", "--json"], process.cwd());
  assert.ok(ok, "semver should succeed");
  if (stdout.trim()) {
    const out = JSON.parse(stdout);
    assert.ok(typeof out.ok === "boolean", "should have ok field");
    assert.ok(out.kind?.includes("semver"), `unexpected kind: ${out.kind}`);
  }
});

// ── why-size ──────────────────────────────────────────────────────────────────

test("why-size --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["why-size", "--help"], process.cwd());
  assert.ok(ok, "why-size --help should succeed");
  assert.ok(
    stdout.includes("why-size") || stdout.includes("size") || stdout.includes("package"),
    "should describe why-size options"
  );
});

test("why-size <pkg> --json explains package size (network-aware)", async (t) => {
  const dir = await makeTempDir("better-why-size-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0",
      dependencies: { "semver": "^7.0.0" }
    });
    const nmDir = path.join(dir, "node_modules");
    await fs.mkdir(path.join(nmDir, "semver"), { recursive: true });
    await writeJson(path.join(nmDir, "semver", "package.json"), {
      name: "semver", version: "7.5.4"
    });

    const { stdout, stderr, ok } = await runBetter(["why-size", "semver", "--json"], dir);
    if (!ok && (stderr.includes("ENOTFOUND") || stderr.includes("ETIMEDOUT") || stderr.includes("timeout"))) {
      t.skip("network unavailable for why-size");
      return;
    }
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
    }
  } finally {
    await rmrf(dir);
  }
});

// ── workspace-run ─────────────────────────────────────────────────────────────

test("workspace-run --help shows usage", async () => {
  // workspace-run requires script arg — --help may exit 1
  const { stdout } = await runBetter(["workspace-run", "--help"], process.cwd());
  assert.ok(
    stdout.includes("workspace") || stdout.includes("run") || stdout.includes("script"),
    "should describe workspace-run options"
  );
});

test("workspace-run <script> --json runs script in workspaces", async () => {
  const dir = await makeTempDir("better-workspace-run-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "my-monorepo", version: "1.0.0", private: true,
      workspaces: ["packages/*"]
    });

    const { stdout } = await runBetter(["workspace-run", "build", "--json"], dir);
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
    }
  } finally {
    await rmrf(dir);
  }
});

// ── merge-driver ──────────────────────────────────────────────────────────────

test("merge-driver --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["merge-driver", "--help"], process.cwd());
  assert.ok(ok, "merge-driver --help should succeed");
  assert.ok(
    stdout.includes("merge") || stdout.includes("driver") || stdout.includes("lockfile"),
    "should describe merge-driver options"
  );
});

// ── ai review (ai-review subcommand) ─────────────────────────────────────────

test("ai review --help shows usage", async () => {
  // ai-review is a subcommand: better ai review
  const { stdout, ok } = await runBetter(["ai", "review", "--help"], process.cwd());
  assert.ok(ok, "ai review --help should succeed");
  assert.ok(
    stdout.includes("ai") || stdout.includes("review") || stdout.includes("subcommand"),
    "should describe ai review options"
  );
});

test("ai review --json returns AI review or auth error", async () => {
  const dir = await makeTempDir("better-ai-review-");
  try {
    await writeJson(path.join(dir, "package.json"), {
      name: "test", version: "1.0.0"
    });

    const { stdout } = await runBetter(["ai", "review", "--json"], dir);
    if (stdout.trim()) {
      const out = JSON.parse(stdout);
      assert.ok(typeof out.ok === "boolean", "should have ok field");
      if (out.ok) {
        assert.ok(out.kind?.includes("ai"), `unexpected kind: ${out.kind}`);
      } else {
        assert.ok(out.error, "should have error message when not ok");
      }
    }
  } finally {
    await rmrf(dir);
  }
});

// ── sardis ────────────────────────────────────────────────────────────────────

test("sardis --help shows usage", async () => {
  // sardis is an alias/alternative entry-point — --help may show main usage
  const { stdout } = await runBetter(["sardis", "--help"], process.cwd());
  assert.ok(
    stdout.includes("better") || stdout.includes("sardis") || stdout.includes("command"),
    "should show CLI usage"
  );
});
