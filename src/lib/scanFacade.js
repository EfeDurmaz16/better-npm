import { scanTree } from "./fsScan.js";
import { findBetterCore, runBetterCoreScan, tryLoadNapiAddon, runBetterCoreScanNapi } from "./core.js";
import { runCommand } from "./spawn.js";

function parseDuKb(stdout) {
  const first = String(stdout ?? "").trim().split(/\s+/)[0];
  const kb = Number(first);
  return Number.isFinite(kb) ? kb : null;
}

async function duApparentKb(rootDir) {
  // BSD/macOS du: -A = apparent size. GNU du: --apparent-size.
  const try1 = await runCommand("du", ["-sk", "-A", rootDir], {
    cwd: rootDir,
    passthroughStdio: false,
    captureLimitBytes: 1024 * 128
  });
  if (try1.exitCode === 0) {
    const kb = parseDuKb(try1.stdout);
    if (kb != null) return kb;
  }
  const try2 = await runCommand("du", ["-sk", "--apparent-size", rootDir], {
    cwd: rootDir,
    passthroughStdio: false,
    captureLimitBytes: 1024 * 128
  });
  if (try2.exitCode === 0) {
    const kb = parseDuKb(try2.stdout);
    if (kb != null) return kb;
  }
  return null;
}

async function duScan(rootDir, opts = {}) {
  const quickLogical = opts.quickLogical === true;
  const quickLogicalThresholdBytes = Number.isFinite(opts.quickLogicalThresholdBytes)
    ? Math.max(0, Number(opts.quickLogicalThresholdBytes))
    : 512 * 1024 * 1024;
  // Fast approximate scan using `du`:
  // - physical: disk blocks
  // - logical: apparent size (best-effort)
  try {
    const phys = await runCommand("du", ["-sk", rootDir], { cwd: rootDir, passthroughStdio: false, captureLimitBytes: 1024 * 128 });
    if (phys.exitCode !== 0) throw new Error(`du failed: ${phys.stderrTail}`);
    const physKb = parseDuKb(phys.stdout);
    if (physKb == null) throw new Error("du parse failed");

    // Hybrid fast mode:
    // - large trees: skip apparent-size walk for speed
    // - smaller trees: do apparent-size walk for better logical accuracy
    let logicalKb = null;
    const physicalBytes = physKb * 1024;
    const shouldComputeApparentSize = !quickLogical || physicalBytes <= quickLogicalThresholdBytes;
    if (shouldComputeApparentSize) {
      logicalKb = await duApparentKb(rootDir);
    }

    const logicalBytes = (logicalKb == null ? physicalBytes : logicalKb * 1024);

    return {
      ok: true,
      rootDir,
      logicalBytes,
      physicalBytes,
      physicalBytesApprox: true,
      fileCount: 0,
      dirCount: 0,
      symlinkCount: 0,
      _method: "du"
    };
  } catch (err) {
    return { ok: false, rootDir, reason: err?.message ?? String(err) };
  }
}

/**
 * Scan a directory for logical/physical size.
 * Uses napi addon when available, then better-core binary, falls back to JS scanner.
 *
 * @param {string} rootDir
 * @param {Object} opts
 * @param {"auto"|"napi"|"force"|"off"} opts.coreMode
 * @param {"auto"|"on"|"off"} opts.duFallback
 */
export async function scanTreeWithBestEngine(rootDir, opts = {}) {
  const coreMode = opts.coreMode ?? "auto";
  const duFallback = opts.duFallback ?? "auto";
  const quickLogical = opts.quickLogical === true;
  const quickLogicalThresholdBytes = opts.quickLogicalThresholdBytes;
  if (coreMode === "off") {
    if (duFallback !== "off") {
      const du = await duScan(rootDir, { quickLogical, quickLogicalThresholdBytes });
      if (du.ok) return du;
    }
    return scanTree(rootDir);
  }

  // Try napi first (for "auto" or "napi" mode)
  if (coreMode === "napi" || coreMode === "auto") {
    const addon = tryLoadNapiAddon();
    if (addon) {
      try {
        const res = runBetterCoreScanNapi(rootDir);
        if (res && typeof res === "object") {
          return {
            rootDir,
            ok: !!res.ok,
            reason: res.reason ?? null,
            logicalBytes: Number(res.logicalBytes ?? 0),
            physicalBytes: Number(res.physicalBytes ?? 0),
            physicalBytesApprox: !!res.physicalBytesApprox,
            fileCount: Number(res.fileCount ?? 0),
            packageCount: Number(res.packageCount ?? 0),
            dirCount: 0,
            symlinkCount: 0
          };
        }
      } catch {
        if (coreMode === "napi") throw new Error("napi scan failed");
        // fall through
      }
    } else if (coreMode === "napi") {
      throw new Error("napi addon not found");
    }
  }

  try {
    const corePath = await findBetterCore();
    if (!corePath) {
      if (coreMode === "force") throw new Error("better-core not found");
      if (duFallback !== "off") {
        const du = await duScan(rootDir, { quickLogical, quickLogicalThresholdBytes });
        if (du.ok) return du;
      }
      return scanTree(rootDir);
    }
    const res = await runBetterCoreScan(corePath, rootDir);
    if (!res || typeof res !== "object") throw new Error("bad better-core scan output");
    return {
      rootDir,
      ok: !!res.ok,
      reason: res.reason ?? null,
      logicalBytes: Number(res.logicalBytes ?? 0),
      physicalBytes: Number(res.physicalBytes ?? 0),
      physicalBytesApprox: !!res.physicalBytesApprox,
      fileCount: Number(res.fileCount ?? 0),
      packageCount: Number(res.packageCount ?? 0),
      // Not provided by core scan yet
      dirCount: 0,
      symlinkCount: 0
    };
  } catch (err) {
    if (coreMode === "force") throw err;
    if (duFallback !== "off") {
      const du = await duScan(rootDir, { quickLogical, quickLogicalThresholdBytes });
      if (du.ok) return du;
    }
    return scanTree(rootDir);
  }
}
