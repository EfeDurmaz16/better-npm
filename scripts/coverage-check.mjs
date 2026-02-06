import { spawnSync } from "node:child_process";

const MIN_CORE_LINE_COVERAGE = Number(process.env.BETTER_COVERAGE_THRESHOLD ?? "80");
const CORE_FILES = [
  "src/analyze/analyzeProject.js",
  "src/lib/analyzeFacade.js",
  "src/lib/cache.js",
  "src/lib/config.js",
  "src/lib/core.js",
  "src/lib/fsScan.js",
  "src/lib/lockfile.js",
  "src/lib/log.js",
  "src/lib/nodeModules.js",
  "src/lib/projectRoot.js",
  "src/lib/scanFacade.js",
  "src/lib/spawn.js",
  "src/parity/checker.js",
  "src/parity/lockfileDrift.js",
  "src/pm/detect.js"
];

function parseLineCoverage(reportText) {
  const coverageByFile = new Map();
  const lines = reportText.split("\n");
  for (const line of lines) {
    const match = line.match(/^#\s+(src\/[^\s|]+)\s+\|\s+([0-9.]+)\s+\|/);
    if (!match) continue;
    coverageByFile.set(match[1], Number(match[2]));
  }
  return coverageByFile;
}

function summarizeCoreCoverage(coverageByFile) {
  const missing = [];
  let covered = 0;
  let total = 0;
  const details = [];
  for (const file of CORE_FILES) {
    const lineCoverage = coverageByFile.get(file);
    if (lineCoverage == null) {
      missing.push(file);
      continue;
    }
    covered += lineCoverage;
    total += 1;
    details.push({ file, lineCoverage });
  }
  return {
    average: total === 0 ? 0 : covered / total,
    missing,
    details: details.sort((a, b) => a.lineCoverage - b.lineCoverage)
  };
}

function runTestsWithCoverage() {
  const result = spawnSync(process.execPath, ["--test", "--experimental-test-coverage"], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? ""
  };
}

const run = runTestsWithCoverage();
const combinedOutput = `${run.stdout}\n${run.stderr}`;
process.stdout.write(combinedOutput);

if (run.status !== 0) {
  process.exitCode = run.status;
} else {
  const coverageByFile = parseLineCoverage(combinedOutput);
  const coreCoverage = summarizeCoreCoverage(coverageByFile);

  if (coreCoverage.missing.length > 0) {
    process.stderr.write(
      `coverage: missing core coverage rows: ${coreCoverage.missing.join(", ")}\n`
    );
    process.exitCode = 1;
  } else if (coreCoverage.average < MIN_CORE_LINE_COVERAGE) {
    process.stderr.write(
      `coverage: core line coverage ${coreCoverage.average.toFixed(2)}% is below ${MIN_CORE_LINE_COVERAGE}%\n`
    );
    process.stderr.write(
      `coverage: lowest core modules: ${coreCoverage.details
        .slice(0, 5)
        .map((entry) => `${entry.file}=${entry.lineCoverage.toFixed(2)}%`)
        .join(", ")}\n`
    );
    process.exitCode = 1;
  } else {
    process.stdout.write(
      `coverage: core line coverage ${coreCoverage.average.toFixed(2)}% (threshold ${MIN_CORE_LINE_COVERAGE}%)\n`
    );
  }
}
