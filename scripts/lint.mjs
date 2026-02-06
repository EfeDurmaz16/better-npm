import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();
const TARGET_DIRS = ["src", "test", "bin", "docs"];
const FILE_EXTENSIONS = new Set([".js", ".mjs", ".cjs"]);
const IGNORE_DIRS = new Set(["node_modules", "dist", "crates", ".git", ".better"]);

async function listFiles(dir) {
  const out = [];
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      out.push(...(await listFiles(fullPath)));
      continue;
    }
    if (FILE_EXTENSIONS.has(path.extname(entry.name))) {
      out.push(fullPath);
    }
  }
  return out;
}

function checkSyntax(filePath) {
  const res = spawnSync(process.execPath, ["--check", filePath], {
    cwd: ROOT,
    encoding: "utf8"
  });
  if (res.status === 0) return null;
  return {
    filePath,
    output: [res.stdout, res.stderr].filter(Boolean).join("\n").trim()
  };
}

function hasMergeMarkers(content) {
  return (
    content.includes("<<<<<<< ") ||
    content.includes("=======\n") ||
    content.includes(">>>>>>> ")
  );
}

async function run() {
  const files = [];
  for (const dir of TARGET_DIRS) {
    files.push(...(await listFiles(path.join(ROOT, dir))));
  }

  const syntaxErrors = [];
  const mergeMarkerFiles = [];
  for (const file of files) {
    const syntaxError = checkSyntax(file);
    if (syntaxError) syntaxErrors.push(syntaxError);

    const content = await fs.readFile(file, "utf8");
    if (hasMergeMarkers(content)) mergeMarkerFiles.push(file);
  }

  if (syntaxErrors.length === 0 && mergeMarkerFiles.length === 0) {
    process.stdout.write(`lint: ok (${files.length} files)\n`);
    return;
  }

  for (const entry of syntaxErrors) {
    process.stderr.write(`lint: syntax error in ${path.relative(ROOT, entry.filePath)}\n`);
    if (entry.output) {
      process.stderr.write(`${entry.output}\n`);
    }
  }
  for (const file of mergeMarkerFiles) {
    process.stderr.write(`lint: unresolved merge markers in ${path.relative(ROOT, file)}\n`);
  }
  process.exitCode = 1;
}

await run();
