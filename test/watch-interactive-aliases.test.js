// test/watch-interactive-aliases.test.js
// Tests for: better watch, better interactive
// (semantic-version/upgrade-smart/ai-advisor/ai-review/mergeDriver are tested
//  via CLI routing aliases in other test files)

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

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

// ── watch ─────────────────────────────────────────────────────────────────────

test("watch --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["watch", "--help"], process.cwd());
  assert.ok(ok, "watch --help should succeed");
  assert.ok(
    stdout.includes("watch") || stdout.includes("monitor") || stdout.includes("interval"),
    "should describe watch options"
  );
});

// watch is a long-running daemon — only test --help

// ── interactive ───────────────────────────────────────────────────────────────

test("interactive --help shows usage", async () => {
  const { stdout, ok } = await runBetter(["interactive", "--help"], process.cwd());
  assert.ok(ok, "interactive --help should succeed");
  assert.ok(
    stdout.includes("interactive") || stdout.includes("TUI") || stdout.includes("terminal"),
    "should describe interactive options"
  );
});

// interactive requires TTY — only test --help
