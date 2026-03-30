/**
 * better duplicates — find duplicate packages with version conflicts
 *
 * Scans node_modules for packages installed multiple times with
 * different versions (version conflicts), shows disk waste,
 * and suggests resolution strategies.
 *
 * Usage:
 *   better duplicates
 *   better duplicates --threshold 3
 *   better duplicates --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

function fmtBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${bytes}B`;
}

async function getDirSize(dirPath) {
  let total = 0;
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    await Promise.all(entries.map(async e => {
      const full = path.join(dirPath, e.name);
      if (e.isDirectory()) total += await getDirSize(full);
      else if (e.isFile()) {
        const stat = await fs.stat(full);
        total += stat.size;
      }
    }));
  } catch {}
  return total;
}

async function scanForDuplicates(nmPath, maxDepth = 4) {
  // Map: package name -> [{version, path}]
  const found = {};

  async function scan(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }

    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const name = e.name;
      const full = path.join(dir, name);

      if (name.startsWith("@")) {
        // Scoped package — scan one level deeper
        let subEntries;
        try { subEntries = await fs.readdir(full, { withFileTypes: true }); } catch { continue; }
        for (const se of subEntries) {
          if (!se.isDirectory()) continue;
          const scopedName = `${name}/${se.name}`;
          const scopedFull = path.join(full, se.name);
          try {
            const pkg = JSON.parse(await fs.readFile(path.join(scopedFull, "package.json"), "utf8"));
            if (!found[scopedName]) found[scopedName] = [];
            found[scopedName].push({ version: pkg.version, path: scopedFull });
          } catch {}
        }
      } else if (name === "node_modules") {
        await scan(full, depth + 1);
      } else if (!name.startsWith(".")) {
        try {
          const pkg = JSON.parse(await fs.readFile(path.join(full, "package.json"), "utf8"));
          if (!found[name]) found[name] = [];
          found[name].push({ version: pkg.version, path: full });
        } catch {}

        // Check nested node_modules
        const nestedNm = path.join(full, "node_modules");
        try {
          await fs.access(nestedNm);
          await scan(nestedNm, depth + 1);
        } catch {}
      }
    }
  }

  await scan(nmPath, 0);

  // Return only packages with multiple different versions
  const duplicates = [];
  for (const [name, installs] of Object.entries(found)) {
    const versions = [...new Set(installs.map(i => i.version))];
    if (versions.length > 1) {
      duplicates.push({ name, versions, installs, count: installs.length });
    }
  }

  return duplicates.sort((a, b) => b.count - a.count);
}

export async function cmdDuplicates(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:      { type: "boolean", default: runtime.json === true },
      help:      { type: "boolean", short: "h", default: false },
      threshold: { type: "string" },
      sizes:     { type: "boolean", default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better duplicates [options]

Find duplicate packages installed with different versions.

Options:
  --threshold <N>  Only show packages with ≥N copies (default: 2)
  --sizes          Show disk size of each installation
  --json           Machine-readable output
  -h, --help       Show this help
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;
  const nmPath = path.join(projectRoot, "node_modules");
  const threshold = parseInt(values.threshold) || 2;

  try {
    await fs.access(nmPath);
  } catch {
    const msg = "node_modules not found — run npm install first";
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`Error: ${msg}`); }
    process.exitCode = 1;
    return;
  }

  if (!values.json) {
    process.stderr.write(`\x1b[90mScanning for duplicate packages…\x1b[0m\n`);
  }

  const duplicates = await scanForDuplicates(nmPath);
  const filtered = duplicates.filter(d => d.count >= threshold);

  // Optionally get sizes
  if (values.sizes) {
    for (const dup of filtered) {
      for (const install of dup.installs) {
        install.sizeBytes = await getDirSize(install.path);
      }
    }
  }

  const totalWasted = filtered.reduce((sum, dup) => {
    const extras = dup.installs.slice(1);
    return sum + extras.reduce((s, i) => s + (i.sizeBytes || 0), 0);
  }, 0);

  if (values.json) {
    printJson({
      ok: filtered.length === 0,
      kind: "better.duplicates",
      duplicateCount: filtered.length,
      totalWastedBytes: totalWasted,
      duplicates: filtered.map(d => ({
        name: d.name,
        count: d.count,
        versions: d.versions,
        installs: d.installs.map(i => ({
          version: i.version,
          path: path.relative(projectRoot, i.path),
          sizeBytes: i.sizeBytes,
        })),
      })),
    });
    if (filtered.length > 0) process.exitCode = 1;
    return;
  }

  printText(`\n\x1b[1mbetter duplicates\x1b[0m\n`);

  if (filtered.length === 0) {
    printText(`\x1b[32m✔ No duplicate packages found.\x1b[0m`);
    return;
  }

  printText(`\x1b[33m${filtered.length} package(s) installed in multiple versions:\x1b[0m\n`);

  for (const dup of filtered.slice(0, 20)) {
    printText(`  \x1b[1m${dup.name}\x1b[0m \x1b[90m(${dup.count} copies)\x1b[0m`);
    for (const install of dup.installs) {
      const rel = path.relative(nmPath, install.path);
      const sizeStr = install.sizeBytes ? ` \x1b[90m(${fmtBytes(install.sizeBytes)})\x1b[0m` : "";
      printText(`    ${install.version.padEnd(12)}  ${rel}${sizeStr}`);
    }
    printText("");
  }

  if (filtered.length > 20) printText(`\x1b[90m...and ${filtered.length - 20} more\x1b[0m\n`);

  if (totalWasted > 0) {
    printText(`\x1b[33m⚠ Estimated wasted disk space: ${fmtBytes(totalWasted)}\x1b[0m`);
  }
  printText(`\x1b[90mRun: better dedupe — to attempt deduplication\x1b[0m`);
  process.exitCode = 1;
}
