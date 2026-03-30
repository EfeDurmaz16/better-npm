/**
 * better source-map-check — validate source map files in build output
 *
 * Scans build output directories for JavaScript source maps,
 * checks their validity, and flags missing or broken source maps.
 *
 * Usage:
 *   better source-map-check
 *   better source-map-check --dir dist
 *   better source-map-check --json
 */
import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallProjectRoot } from "../lib/projectRoot.js";

function fmtBytes(n) {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

const BUNDLE_DIRS = ["dist", "build", ".next/static", "out", "public/build", "www", "lib"];

async function collectJsFiles(dir) {
  const files = [];
  async function walk(d, depth) {
    if (depth > 5) return;
    let entries;
    try { entries = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (["node_modules", ".git", "coverage"].includes(e.name)) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full, depth + 1);
      else if (e.isFile() && (e.name.endsWith(".js") || e.name.endsWith(".mjs"))) {
        files.push(full);
      }
    }
  }
  await walk(dir, 0);
  return files;
}

function extractSourceMapRef(content) {
  const m = content.match(/\/\/[#@] sourceMappingURL=(.+)$/m);
  return m ? m[1].trim() : null;
}

export async function cmdSourceMapCheck(argv) {
  const runtime = getRuntimeConfig();
  const { values } = parseArgs({
    args: argv,
    options: {
      json:   { type: "boolean", default: runtime.json === true },
      help:   { type: "boolean", short: "h", default: false },
      dir:    { type: "string", default: "" },
      strict: { type: "boolean", default: false },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values.help) {
    printText(`Usage: better source-map-check [options]

Validate source map files in your build output.

Options:
  --dir <path>    Directory to scan (default: auto-detect dist/build)
  --strict        Fail if any JS files are missing source maps
  --json          Machine-readable output
  -h, --help      Show this help

Checks:
  • Source map referenced in sourceMappingURL comment exists
  • Source map is valid JSON with required fields
  • Coverage of JS files with source maps
`);
    return;
  }

  const cwd = process.cwd();
  const resolvedRoot = await resolveInstallProjectRoot(cwd);
  const projectRoot = resolvedRoot.root;

  let foundDir = null;
  if (values.dir) {
    foundDir = path.resolve(cwd, values.dir);
    try { await fs.access(foundDir); } catch {
      const msg = `Directory not found: ${foundDir}`;
      if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`\x1b[31mError: ${msg}\x1b[0m`); }
      process.exitCode = 1;
      return;
    }
  } else {
    for (const d of BUNDLE_DIRS) {
      const candidate = path.join(projectRoot, d);
      try { await fs.access(candidate); foundDir = candidate; break; } catch {}
    }
  }

  if (!foundDir) {
    const msg = `No build output found. Checked: ${BUNDLE_DIRS.join(", ")}`;
    if (values.json) { printJson({ ok: false, error: msg }); } else { printText(`\x1b[33m⚠ ${msg}\x1b[0m\n  \x1b[90mRun your build first: npm run build\x1b[0m`); }
    process.exitCode = 1;
    return;
  }

  if (!values.json) {
    printText(`\n\x1b[1mbetter source-map-check\x1b[0m\n`);
    process.stderr.write(`\x1b[90mScanning ${path.relative(projectRoot, foundDir) || foundDir}…\x1b[0m\n`);
  }

  const jsFiles = await collectJsFiles(foundDir);

  const results = [];
  const BATCH = 10;
  for (let i = 0; i < jsFiles.length; i += BATCH) {
    const batch = jsFiles.slice(i, i + BATCH);
    await Promise.all(batch.map(async (jsFile) => {
      let content;
      try { content = await fs.readFile(jsFile, "utf8"); } catch { return; }

      const mapRef = extractSourceMapRef(content);
      const rel = path.relative(foundDir, jsFile);

      if (!mapRef) {
        results.push({ file: rel, hasMap: false, valid: null, issue: "no sourceMappingURL" });
        return;
      }

      // Resolve map file
      let mapPath;
      if (mapRef.startsWith("data:")) {
        results.push({ file: rel, hasMap: true, valid: true, issue: null, inline: true });
        return;
      } else if (mapRef.startsWith("http://") || mapRef.startsWith("https://")) {
        results.push({ file: rel, hasMap: true, valid: null, issue: "remote source map (not checked)", remote: true });
        return;
      } else {
        mapPath = path.join(path.dirname(jsFile), mapRef);
      }

      try {
        const mapContent = await fs.readFile(mapPath, "utf8");
        const mapJson = JSON.parse(mapContent);
        const hasRequiredFields = mapJson.version && mapJson.sources && mapJson.mappings !== undefined;
        const mapStat = await fs.stat(mapPath);
        results.push({
          file: rel,
          hasMap: true,
          valid: hasRequiredFields,
          mapFile: path.relative(foundDir, mapPath),
          mapSize: mapStat.size,
          sourcesCount: mapJson.sources?.length || 0,
          issue: hasRequiredFields ? null : "source map missing required fields (version/sources/mappings)",
        });
      } catch (err) {
        results.push({
          file: rel,
          hasMap: true,
          valid: false,
          mapFile: mapRef,
          issue: err.code === "ENOENT" ? "referenced source map file not found" : `invalid JSON: ${err.message}`,
        });
      }
    }));
  }

  const withMap = results.filter(r => r.hasMap && r.valid);
  const missing = results.filter(r => !r.hasMap);
  const broken = results.filter(r => r.hasMap && r.valid === false);
  const coverage = jsFiles.length > 0 ? Math.round(withMap.length / jsFiles.length * 100) : 0;
  const allOk = broken.length === 0 && (!values.strict || missing.length === 0);

  if (values.json) {
    printJson({
      ok: allOk,
      kind: "better.source-map-check",
      dir: foundDir,
      totalJsFiles: jsFiles.length,
      withSourceMap: withMap.length,
      missing: missing.length,
      broken: broken.length,
      coverage,
      results,
    });
    if (!allOk) process.exitCode = 1;
    return;
  }

  printText(`  Dir:           ${path.relative(projectRoot, foundDir) || foundDir}`);
  printText(`  JS files:      ${jsFiles.length}`);
  printText(`  With map:      ${withMap.length}  \x1b[90m(${coverage}% coverage)\x1b[0m`);
  printText(`  Missing map:   ${missing.length}`);
  printText(`  Broken map:    ${broken.length}\n`);

  if (broken.length > 0) {
    printText(`\x1b[31mBroken source maps:\x1b[0m`);
    for (const r of broken) {
      printText(`  \x1b[31m✖\x1b[0m  ${r.file}  \x1b[90m→ ${r.issue}\x1b[0m`);
    }
    printText("");
  }

  if (values.strict && missing.length > 0) {
    printText(`\x1b[33mJS files without source maps:\x1b[0m`);
    for (const r of missing.slice(0, 10)) {
      printText(`  \x1b[33m⚠\x1b[0m  ${r.file}`);
    }
    if (missing.length > 10) printText(`  \x1b[90m… and ${missing.length - 10} more\x1b[0m`);
    printText("");
  }

  if (allOk) {
    printText(`\x1b[32m✔ Source maps look good (${coverage}% coverage).\x1b[0m`);
  } else if (broken.length > 0) {
    printText(`\x1b[31m✖ ${broken.length} broken source map(s) found.\x1b[0m`);
    process.exitCode = 1;
  } else {
    printText(`\x1b[33m⚠ ${missing.length} JS file(s) missing source maps.\x1b[0m`);
    if (values.strict) process.exitCode = 1;
  }
  printText("");
}
