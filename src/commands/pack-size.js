/**
 * better pack-size — analyze what npm pack will include
 *
 * Runs npm pack --dry-run and shows the file list with sizes,
 * total packed/unpacked sizes, and flags large or unexpected files.
 *
 * Usage:
 *   better pack-size
 *   better pack-size --threshold 100  (warn if > 100KB total)
 *   better pack-size --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import { spawnSync } from "node:child_process";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

// Files that probably shouldn't be in a published package
const SUSPICIOUS_PATTERNS = [
  /^\.env/,
  /\.test\.[jt]sx?$/,
  /\.spec\.[jt]sx?$/,
  /^test\//,
  /^tests\//,
  /^__tests__\//,
  /^\.github\//,
  /^\.circleci\//,
  /node_modules\//,
  /^coverage\//,
  /\.map$/,  // source maps (large, usually unnecessary)
];

function fmtBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function parseDryRunOutput(output) {
  // npm pack --dry-run --json returns a JSON array
  try {
    const arr = JSON.parse(output);
    if (Array.isArray(arr) && arr[0]?.files) {
      return {
        files: arr[0].files,
        bundleSize: arr[0].bundleSize,
        unpackedSize: arr[0].unpackedSize,
        entryCount: arr[0].entryCount,
        filename: arr[0].filename,
        name: arr[0].name,
        version: arr[0].version,
      };
    }
  } catch {}

  // Fallback: parse text output
  const files = [];
  for (const line of output.split("\n")) {
    const m = line.match(/npm notice\s+(\d+(?:\.\d+)?[kKMB]*)\s+(.+)/);
    if (m) {
      files.push({ path: m[2].trim(), size: 0 });
    }
  }
  return { files };
}

export async function cmdPackSize(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:      { type: "boolean", default: runtime.json === true },
      help:      { type: "boolean", short: "h", default: false },
      threshold: { type: "string" },
      all:       { type: "boolean", default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better pack-size [options]

Analyze what npm pack will include and the total publish size.

Options:
  --threshold <KB>   Warn if total unpacked size exceeds KB (default: 500)
  --all              Show all files (default: top 20 by size)
  --json             Machine-readable output
  -h, --help         Show this help
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;
  const thresholdKB = parseInt(values.threshold) || 500;

  if (!values.json) {
    process.stderr.write(`\x1b[90mRunning npm pack --dry-run…\x1b[0m\n`);
  }

  const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: projectRoot,
    stdio: ["pipe", "pipe", "pipe"],
    encoding: "utf8",
  });

  if (result.status !== 0) {
    const err = (result.stderr || result.stdout || "npm pack failed").slice(0, 300);
    if (values.json) {
      printJson({ ok: false, error: "npm pack failed", details: err });
    } else {
      printText(`\x1b[31m✖ npm pack failed:\x1b[0m\n${err}`);
    }
    process.exitCode = 1;
    return;
  }

  const parsed = parseDryRunOutput(result.stdout);
  const files = parsed.files || [];
  const unpackedSize = parsed.unpackedSize || files.reduce((s, f) => s + (f.size || 0), 0);
  const bundleSize = parsed.bundleSize || 0;

  // Sort by size desc
  const sortedFiles = [...files].sort((a, b) => (b.size || 0) - (a.size || 0));

  // Flag suspicious files
  const suspicious = files.filter(f =>
    SUSPICIOUS_PATTERNS.some(p => p.test(f.path))
  );

  const overThreshold = unpackedSize > thresholdKB * 1024;

  if (values.json) {
    printJson({
      ok: !overThreshold && suspicious.length === 0,
      kind: "better.pack-size",
      name: parsed.name,
      version: parsed.version,
      filename: parsed.filename,
      fileCount: files.length,
      unpackedSize,
      bundleSize,
      thresholdKB,
      overThreshold,
      suspiciousFiles: suspicious.map(f => f.path),
      topFiles: sortedFiles.slice(0, 20).map(f => ({ path: f.path, size: f.size })),
    });
    if (overThreshold || suspicious.length > 0) process.exitCode = 1;
    return;
  }

  const name = parsed.name ? `${parsed.name}@${parsed.version}` : "package";
  printText(`\n\x1b[1mbetter pack-size\x1b[0m — ${name}\n`);
  printText(`  Files:     ${files.length}`);
  printText(`  Unpacked:  ${fmtBytes(unpackedSize)}`);
  if (bundleSize) printText(`  Packed:    ${fmtBytes(bundleSize)}`);
  printText("");

  // Show files
  const displayFiles = values.all ? sortedFiles : sortedFiles.slice(0, 20);
  for (const f of displayFiles) {
    const isSuspicious = SUSPICIOUS_PATTERNS.some(p => p.test(f.path));
    const sizeStr = f.size ? fmtBytes(f.size).padStart(10) : "".padStart(10);
    const flag = isSuspicious ? " \x1b[33m⚠\x1b[0m" : "";
    printText(`  ${sizeStr}  ${f.path}${flag}`);
  }
  if (!values.all && sortedFiles.length > 20) {
    printText(`  \x1b[90m  ...and ${sortedFiles.length - 20} more files\x1b[0m`);
  }

  printText("");

  if (suspicious.length > 0) {
    printText(`\x1b[33m⚠ ${suspicious.length} suspicious file(s) in package:\x1b[0m`);
    for (const f of suspicious) printText(`  \x1b[90m→ ${f.path}\x1b[0m`);
    printText(`\x1b[90mAdd to .npmignore or use the "files" field in package.json\x1b[0m`);
    printText("");
  }

  if (overThreshold) {
    printText(`\x1b[33m⚠ Package is ${fmtBytes(unpackedSize)} — exceeds ${thresholdKB}KB threshold\x1b[0m`);
    printText(`\x1b[90mConsider adding a "files" field to reduce publish size\x1b[0m`);
  } else {
    const icon = suspicious.length === 0 ? "\x1b[32m✔\x1b[0m" : "\x1b[33m⚠\x1b[0m";
    printText(`${icon} Total: ${fmtBytes(unpackedSize)}`);
  }
}
