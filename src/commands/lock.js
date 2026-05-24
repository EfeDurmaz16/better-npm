import { parseArgs } from "node:util";
import path from "node:path";
import fs from "node:fs/promises";
import { printJson, printText } from "../lib/output.js";
import { detectPackageManager } from "../pm/detect.js";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";
import { getRuntimeConfig } from "../lib/config.js";
import { hashLockfile, buildRuntimeFingerprint, deriveGlobalCacheContext, resolvePrimaryLockfile } from "../lib/globalCache.js";
import { findBetterCore, runGenerateLockMetadataNapi, runVerifyLockMetadataNapi } from "../lib/core.js";
import { runCommand } from "../lib/spawn.js";

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

async function detectLockPackageManager(projectRoot) {
  const pkgPath = path.join(projectRoot, "package.json");
  if (await exists(pkgPath)) {
    try {
      const pkg = JSON.parse(await fs.readFile(pkgPath, "utf8"));
      const declared = typeof pkg?.packageManager === "string" ? pkg.packageManager : "";
      const [name] = declared.split("@");
      if (name === "npm" || name === "pnpm" || name === "yarn" || name === "bun") {
        return { pm: name, reason: "package.json#packageManager" };
      }
    } catch {
      // ignore invalid package.json and continue with file-based detection
    }
  }

  const detected = await detectPackageManager(projectRoot);
  if (detected.reason !== "default") return detected;

  const bunLock = await resolvePrimaryLockfile(projectRoot, { pm: "bun", engine: "pm" });
  if (bunLock?.file) return { pm: "bun", reason: bunLock.file };
  return detected;
}

async function resolveLockProjectRoot(startDir, projectRootFlag) {
  if (projectRootFlag) return { root: path.resolve(projectRootFlag), reason: "flag:--project-root" };
  const cwd = path.resolve(startDir);
  if (await exists(path.join(cwd, "package.json"))) {
    return { root: cwd, reason: "found:cwd-package.json" };
  }
  return await resolveInstallProjectRoot(cwd);
}

function normalizeScriptsMode(value) {
  return value === "off" ? "off" : "rebuild";
}

function makeLockDocument(payload) {
  return {
    kind: "better.lock",
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    projectRoot: payload.projectRoot,
    projectRootResolution: payload.projectRootResolution,
    pm: payload.pm,
    engine: payload.engine,
    cacheMode: payload.cacheMode,
    scriptsMode: payload.scriptsMode,
    frozen: payload.frozen,
    production: payload.production,
    lockfile: payload.lockfile,
    fingerprint: payload.fingerprint,
    key: payload.key
  };
}

export async function cmdLock(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    printText(`Usage:
  better lock [generate] [--json] [--project-root PATH] [--out FILE]
              [--pm auto|npm|pnpm|yarn|bun] [--engine pm|bun|better]
              [--cache-mode strict|relaxed] [--cache-scripts rebuild|off]
              [--frozen] [--production] [--cache-key-salt VALUE]
  better lock verify [--json] [--project-root PATH] [--file FILE]
  better lock setup-merge-driver [--json] [--project-root PATH]
  better lock merge <base> <ours> <theirs> [--project-root PATH] [--json]
`);
    return;
  }

  // Subcommands that delegate to the Rust binary
  const subcommand = argv[0] ?? "generate";
  if (subcommand === "setup-merge-driver") {
    return await cmdLockSetupMergeDriver(argv.slice(1));
  }
  if (subcommand === "merge") {
    return await cmdLockMerge(argv.slice(1));
  }

  const runtime = getRuntimeConfig();
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: runtime.json === true },
      "project-root": { type: "string" },
      out: { type: "string" },
      file: { type: "string" },
      pm: { type: "string", default: "auto" },
      engine: { type: "string", default: "pm" },
      "cache-mode": { type: "string", default: "strict" },
      "cache-scripts": { type: "string", default: "rebuild" },
      "cache-key-salt": { type: "string" },
      frozen: { type: "boolean", default: false },
      production: { type: "boolean", default: false }
    },
    allowPositionals: true,
    strict: false
  });

  const action = positionals[0] === "verify" ? "verify" : positionals[0] === "metadata" ? "metadata" : "generate";
  const resolvedRoot = await resolveLockProjectRoot(process.cwd(), values["project-root"]);
  const projectRoot = resolvedRoot.root;

  if (action === "metadata") {
    const subaction = positionals[1] ?? "generate";
    if (subaction === "verify") {
      const napiResult = runVerifyLockMetadataNapi(projectRoot);
      if (napiResult?.ok) {
        const d = napiResult.data;
        if (values.json) { printJson({ ok: true, kind: "better.lock.metadata.verify", ...d }); return; }
        printText([
          `better lock metadata verify: ${d?.matches ? "PASS" : "FAIL"}`,
          `- key matches: ${d?.keyMatches}`,
          `- lockfile hash matches: ${d?.lockfileMatches}`,
          `- current key: ${d?.current?.key ?? "n/a"}`,
        ].join("\n"));
        process.exitCode = d?.matches ? 0 : 1;
        return;
      }
    } else {
      const napiResult = runGenerateLockMetadataNapi(projectRoot);
      if (napiResult?.ok) {
        const d = napiResult.data;
        if (values.json) { printJson({ ok: true, kind: "better.lock.metadata.generate", ...d }); return; }
        printText([
          `better lock metadata generate`,
          `- key: ${d?.key ?? "n/a"}`,
          `- lockfile: ${d?.lockfile ?? "n/a"}`,
          `- lockfile hash: ${d?.lockfileHash ?? "n/a"}`,
          `- platform: ${d?.fingerprint?.platform}/${d?.fingerprint?.arch} node${d?.fingerprint?.nodeMajor}`,
        ].join("\n"));
        return;
      }
    }
  }

  const detected = await detectLockPackageManager(projectRoot);
  const pm = values.pm === "auto" ? detected.pm : values.pm;
  const engine = String(values.engine ?? "pm");
  const cacheMode = String(values["cache-mode"] ?? "strict");
  const scriptsMode = normalizeScriptsMode(values["cache-scripts"]);
  const frozen = values.frozen === true;
  const production = values.production === true;
  const cacheKeySalt = values["cache-key-salt"] ?? null;

  if (pm !== "npm" && pm !== "pnpm" && pm !== "yarn" && pm !== "bun") {
    throw new Error(`Unknown --pm '${pm}'. Expected npm|pnpm|yarn|bun|auto.`);
  }
  if (engine !== "pm" && engine !== "bun" && engine !== "better") {
    throw new Error(`Unknown --engine '${engine}'. Expected pm|bun|better.`);
  }
  if (cacheMode !== "strict" && cacheMode !== "relaxed") {
    throw new Error(`Unknown --cache-mode '${cacheMode}'. Expected strict|relaxed.`);
  }

  const lock = await hashLockfile(projectRoot, { pm, engine });
  if (!lock.ok || !lock.lockHash || !lock.lockfile?.file) {
    const out = {
      ok: false,
      kind: `better.lock.${action}`,
      schemaVersion: 1,
      reason: lock.reason ?? "lockfile_not_found",
      projectRoot
    };
    if (values.json) printJson(out);
    else printText(`better lock ${action}: ${out.reason}`);
    process.exitCode = 1;
    return;
  }

  const fingerprintAll = buildRuntimeFingerprint({
    pm,
    engine,
    scriptsMode,
    frozen,
    production,
    cacheKeySalt
  });
  const fingerprint = cacheMode === "relaxed" ? fingerprintAll.relaxed : fingerprintAll.strict;
  const derived = await deriveGlobalCacheContext(projectRoot, {
    pm,
    engine,
    cacheMode,
    scriptsMode,
    frozen,
    production,
    cacheKeySalt
  });

  const current = makeLockDocument({
    projectRoot,
    projectRootResolution: { root: projectRoot, reason: resolvedRoot.reason },
    pm: { selected: pm, detected: detected.pm, reason: detected.reason },
    engine,
    cacheMode,
    scriptsMode,
    frozen,
    production,
    lockfile: {
      file: lock.lockfile.file,
      hash: lock.lockHash
    },
    fingerprint,
    key: derived.key
  });

  const defaultFile = path.join(projectRoot, "better.lock.json");
  const targetFile = path.resolve(values.file ?? values.out ?? defaultFile);

  if (action === "generate") {
    await fs.writeFile(targetFile, `${JSON.stringify(current, null, 2)}\n`);
    const out = {
      ok: true,
      kind: "better.lock.generate",
      schemaVersion: 1,
      file: targetFile,
      key: current.key,
      lockfile: current.lockfile,
      pm: current.pm,
      engine: current.engine,
      cacheMode: current.cacheMode
    };
    if (values.json) printJson(out);
    else {
      printText(
        [
          "better lock generate",
          `- file: ${targetFile}`,
          `- key: ${current.key}`,
          `- lockfile: ${current.lockfile.file}`,
          `- cache mode: ${current.cacheMode}`
        ].join("\n")
      );
    }
    return;
  }

  if (!(await exists(targetFile))) {
    const out = {
      ok: false,
      kind: "better.lock.verify",
      schemaVersion: 1,
      file: targetFile,
      reason: "lock_file_missing"
    };
    if (values.json) printJson(out);
    else printText(`better lock verify: missing lock file (${targetFile})`);
    process.exitCode = 1;
    return;
  }

  const expected = await readJson(targetFile);
  const checks = {
    kindMatches: expected?.kind === "better.lock",
    schemaMatches: Number(expected?.schemaVersion) === 1,
    keyMatches: String(expected?.key ?? "") === String(current.key ?? ""),
    lockfileMatches:
      String(expected?.lockfile?.file ?? "") === String(current.lockfile.file ?? "") &&
      String(expected?.lockfile?.hash ?? "") === String(current.lockfile.hash ?? ""),
    cacheModeMatches: String(expected?.cacheMode ?? "") === String(current.cacheMode ?? "")
  };
  const ok = Object.values(checks).every(Boolean);
  const out = {
    ok,
    kind: "better.lock.verify",
    schemaVersion: 1,
    file: targetFile,
    checks,
    expected: {
      key: expected?.key ?? null,
      lockfile: expected?.lockfile ?? null,
      cacheMode: expected?.cacheMode ?? null
    },
    current: {
      key: current.key,
      lockfile: current.lockfile,
      cacheMode: current.cacheMode
    }
  };
  if (values.json) printJson(out);
  else {
    printText(
      [
        "better lock verify",
        `- file: ${targetFile}`,
        `- status: ${ok ? "ok" : "drift_detected"}`,
        `- key match: ${checks.keyMatches}`,
        `- lockfile match: ${checks.lockfileMatches}`
      ].join("\n")
    );
  }
  if (!ok) process.exitCode = 1;
}

async function cmdLockSetupMergeDriver(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: runtime.json === true },
      "project-root": { type: "string" }
    },
    strict: false
  });
  const projectRoot = values["project-root"]
    ? path.resolve(values["project-root"])
    : process.cwd();

  const corePath = await findBetterCore();
  if (corePath) {
    const res = await runCommand(corePath, ["lock", "--project-root", projectRoot, "install-driver"], {
      cwd: projectRoot, passthroughStdio: false, captureLimitBytes: 64 * 1024
    });
    if (res.exitCode === 0) {
      let parsed = null;
      try { parsed = JSON.parse(res.stdout); } catch { /* ignore */ }
      if (values.json) {
        printJson(parsed ?? { ok: true, kind: "better.lock.install-driver" });
      } else {
        printText(parsed?.filesModified?.length
          ? `better lock setup-merge-driver: configured (${parsed.filesModified.join(", ")})`
          : "better lock setup-merge-driver: merge driver installed");
      }
      return;
    }
  }

  // Fallback: write .gitattributes and .git/config entries manually
  const gitattributes = path.join(projectRoot, ".gitattributes");
  let existing = "";
  try { existing = await fs.readFile(gitattributes, "utf8"); } catch { /* new file */ }
  const entry = "better.lock.json merge=betterlockjson";
  if (!existing.includes(entry)) {
    await fs.writeFile(gitattributes, `${existing.trimEnd()}\n${entry}\n`);
  }

  const gitConfig = path.join(projectRoot, ".git", "config");
  const driverBlock = `[merge "betterlockjson"]\n\tname = better.lock.json merge driver\n\tdriver = better-core lock --project-root %P merge %O %A %B\n`;
  let gitCfg = "";
  try { gitCfg = await fs.readFile(gitConfig, "utf8"); } catch { /* no git dir */ }
  if (!gitCfg.includes('[merge "betterlockjson"]')) {
    try { await fs.appendFile(gitConfig, `\n${driverBlock}`); } catch { /* readonly or no .git */ }
  }

  const out = { ok: true, kind: "better.lock.install-driver", installed: true, filesModified: [".gitattributes"] };
  if (values.json) printJson(out);
  else printText(`better lock setup-merge-driver: .gitattributes updated`);
}

async function cmdLockMerge(argv) {
  const runtime = getRuntimeConfig();
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: runtime.json === true },
      "project-root": { type: "string" }
    },
    allowPositionals: true,
    strict: false
  });
  if (positionals.length < 3) {
    printText("Usage: better lock merge <base> <ours> <theirs>");
    process.exitCode = 1;
    return;
  }
  const [base, ours, theirs] = positionals;
  const projectRoot = values["project-root"]
    ? path.resolve(values["project-root"])
    : process.cwd();

  const corePath = findBetterCore();
  if (!corePath) {
    const err = { ok: false, kind: "better.lock.merge", reason: "better-core binary not found" };
    if (values.json) printJson(err); else printText("Error: better-core binary not found");
    process.exitCode = 1;
    return;
  }

  const res = await runCommand(corePath, ["lock", "--project-root", projectRoot, "merge", base, ours, theirs], {
    cwd: projectRoot, passthroughStdio: false, captureLimitBytes: 64 * 1024
  });
  let parsed = null;
  try { parsed = JSON.parse(res.stdout); } catch { /* ignore */ }
  if (values.json) {
    printJson(parsed ?? { ok: res.exitCode === 0, kind: "better.lock.merge" });
  } else if (parsed) {
    const conflicts = parsed.conflicts ?? [];
    if (conflicts.length === 0) {
      printText(`better lock merge: clean merge (${parsed.totalPackages ?? "?"} packages)`);
    } else {
      printText(`better lock merge: ${conflicts.length} conflict(s)\n${conflicts.map(c => `  - ${c}`).join("\n")}`);
    }
  }
  process.exitCode = res.exitCode;
}
