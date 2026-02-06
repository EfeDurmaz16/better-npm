import fs from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const TARGET_DIRS = ["src", "test", "bin", "docs", ".github", "scripts"];
const FILE_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".json", ".md", ".ts", ".yml", ".yaml"]);
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
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      out.push(...(await listFiles(path.join(dir, entry.name))));
      continue;
    }

    if (FILE_EXTENSIONS.has(path.extname(entry.name))) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

function checkFileFormatting(content) {
  const issues = [];
  if (content.includes("\r\n")) {
    issues.push("contains CRLF line endings");
  }
  const lines = content.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    if (/[ \t]+$/.test(lines[index])) {
      issues.push(`trailing whitespace on line ${index + 1}`);
      break;
    }
  }
  if (content.length > 0 && !content.endsWith("\n")) {
    issues.push("missing trailing newline");
  }
  return issues;
}

async function run() {
  const files = [];
  for (const dir of TARGET_DIRS) {
    files.push(...(await listFiles(path.join(ROOT, dir))));
  }

  const failures = [];
  for (const filePath of files) {
    const raw = await fs.readFile(filePath, "utf8");
    const issues = checkFileFormatting(raw);
    if (issues.length > 0) {
      failures.push({ filePath, issues });
    }
  }

  if (failures.length === 0) {
    process.stdout.write(`format:check: ok (${files.length} files)\n`);
    return;
  }

  for (const failure of failures) {
    process.stderr.write(`format:check: ${path.relative(ROOT, failure.filePath)}\n`);
    for (const issue of failure.issues) {
      process.stderr.write(`  - ${issue}\n`);
    }
  }
  process.exitCode = 1;
}

await run();
