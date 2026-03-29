/**
 * Dependency risk scoring engine (#18).
 *
 * Computes a 0–100 risk score for a package based on:
 *   - Staleness (days since last publish)
 *   - Open CVE count (from OSV data if available)
 *   - Maintainer count (bus factor)
 *   - Weekly download rank (popularity proxy)
 *   - Deprecated flag
 *   - Missing metadata (description, homepage, repository)
 *
 * Score interpretation:
 *   0–20   LOW    (green)
 *   21–50  MEDIUM (yellow)
 *   51–80  HIGH   (orange)
 *   81–100 CRITICAL (red)
 *
 * Usage:
 *   import { scorePackage, riskGrade, riskLabel } from "./riskScore.js";
 *   const result = scorePackage(npmMeta, { vulnCount: 2 });
 */

const MS_PER_DAY = 86_400_000;

// --- Staleness thresholds (days) ---
const STALE_WARN = 365;       // 1 year  → low risk +5
const STALE_MED  = 365 * 2;   // 2 years → medium  +20
const STALE_HIGH = 365 * 3;   // 3 years → high    +35
const STALE_CRIT = 365 * 5;   // 5 years → critical +50

/**
 * Compute a numeric risk score 0–100 for a single package.
 *
 * @param {Object} meta  - npm packument metadata (from registry or local manifest)
 * @param {Object} [extra]
 * @param {number} [extra.vulnCount=0]  - number of open CVEs
 * @param {number} [extra.weeklyDownloads] - weekly download count (optional)
 * @returns {{ score: number, grade: string, label: string, signals: Object }}
 */
export function scorePackage(meta, extra = {}) {
  const signals = {};
  let score = 0;

  // 1. Deprecated
  if (meta?.deprecated) {
    signals.deprecated = true;
    score += 30;
  }

  // 2. Staleness
  const latestTime = meta?.time?.modified ?? meta?.time?.[meta?.["dist-tags"]?.latest];
  if (latestTime) {
    const ageDays = (Date.now() - new Date(latestTime).getTime()) / MS_PER_DAY;
    signals.ageDays = Math.round(ageDays);
    if (ageDays > STALE_CRIT) score += 50;
    else if (ageDays > STALE_HIGH) score += 35;
    else if (ageDays > STALE_MED) score += 20;
    else if (ageDays > STALE_WARN) score += 5;
  }

  // 3. Open CVEs
  const vulns = Number(extra.vulnCount ?? 0);
  signals.vulnCount = vulns;
  if (vulns >= 5) score += 40;
  else if (vulns >= 2) score += 25;
  else if (vulns === 1) score += 15;

  // 4. Maintainer count (bus factor)
  const maintainers = Array.isArray(meta?.maintainers) ? meta.maintainers.length : null;
  if (maintainers !== null) {
    signals.maintainerCount = maintainers;
    if (maintainers === 1) score += 10;
    else if (maintainers === 0) score += 20;
  }

  // 5. Missing critical metadata
  if (!meta?.description) { signals.noDescription = true; score += 3; }
  if (!meta?.repository)   { signals.noRepository  = true; score += 3; }
  if (!meta?.license)      { signals.noLicense      = true; score += 5; }

  // 6. Popularity (low downloads → higher risk proxy)
  const downloads = extra.weeklyDownloads;
  if (typeof downloads === "number") {
    signals.weeklyDownloads = downloads;
    if (downloads < 100) score += 10;
    else if (downloads < 1000) score += 5;
  }

  const clamped = Math.min(100, Math.max(0, score));
  return {
    score: clamped,
    grade: riskGrade(clamped),
    label: riskLabel(clamped),
    signals
  };
}

/**
 * Convert numeric score to letter grade.
 * @param {number} score 0–100
 * @returns {string} A | B | C | D | F
 */
export function riskGrade(score) {
  if (score <= 10) return "A";
  if (score <= 25) return "B";
  if (score <= 50) return "C";
  if (score <= 75) return "D";
  return "F";
}

/**
 * Human-readable risk label.
 * @param {number} score
 * @returns {string}
 */
export function riskLabel(score) {
  if (score <= 20) return "low";
  if (score <= 50) return "medium";
  if (score <= 80) return "high";
  return "critical";
}

/**
 * Aggregate risk score across multiple packages.
 * Returns the average score + per-package scores sorted by score desc.
 *
 * @param {Array<{name: string, meta: Object, vulnCount?: number, weeklyDownloads?: number}>} packages
 * @returns {{ aggregate: number, grade: string, packages: Array }}
 */
export function scorePortfolio(packages) {
  if (!packages.length) return { aggregate: 0, grade: "A", packages: [] };

  const scored = packages.map(({ name, version, meta, vulnCount, weeklyDownloads }) => ({
    name,
    version,
    ...scorePackage(meta, { vulnCount, weeklyDownloads })
  }));

  scored.sort((a, b) => b.score - a.score);

  const aggregate = Math.round(scored.reduce((s, p) => s + p.score, 0) / scored.length);
  return {
    aggregate,
    grade: riskGrade(aggregate),
    label: riskLabel(aggregate),
    packages: scored
  };
}
