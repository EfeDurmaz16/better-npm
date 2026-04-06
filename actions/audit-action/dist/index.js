// actions/audit-action/dist/index.js
// Runs better audit and posts results to GitHub Actions summary

const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// Minimal @actions/core shim if not available
const core = (() => {
  try { return require('@actions/core'); } catch { return {
    getInput: (name) => process.env[`INPUT_${name.toUpperCase().replace(/-/g, '_')}`] || '',
    setOutput: (name, value) => process.stdout.write(`::set-output name=${name}::${value}\n`),
    setFailed: (msg) => { console.error(`::error::${msg}`); process.exitCode = 1; },
    info: console.log,
    warning: console.warn,
    summary: { addHeading: () => core.summary, addTable: () => core.summary, write: async () => {} }
  }; }
})();

async function main() {
  const severity = core.getInput('severity') || 'moderate';
  const failOnVuln = core.getInput('fail-on-vuln') !== 'false';
  const projectRoot = path.resolve(core.getInput('project-root') || '.');

  core.info(`Running better audit in ${projectRoot}...`);

  let result;
  try {
    const output = execFileSync('better', ['audit', '--json', '--project-root', projectRoot], {
      encoding: 'utf8',
      timeout: 60000
    });
    result = JSON.parse(output);
  } catch (err) {
    const output = err.stdout || '';
    try {
      result = JSON.parse(output);
    } catch {
      core.setFailed(`better audit failed: ${err.message}`);
      return;
    }
  }

  const vulns = result.vulnerabilities || [];
  const severityOrder = ['critical', 'high', 'moderate', 'low', 'info'];
  const minSeverityIdx = severityOrder.indexOf(severity);

  const filtered = vulns.filter(v => {
    const idx = severityOrder.indexOf(v.severity || 'info');
    return idx <= minSeverityIdx;
  });

  // Count by severity
  const counts = { critical: 0, high: 0, moderate: 0, low: 0, info: 0 };
  for (const v of filtered) counts[v.severity || 'info']++;

  core.setOutput('vulnerabilities', String(filtered.length));
  core.setOutput('critical', String(counts.critical));
  core.setOutput('high', String(counts.high));

  // Write summary
  if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = filtered.map(v => [v.name || '', v.severity || '', v.title || '', v.version || '']);
    let summary = `## Better Audit Results\n\n`;
    if (filtered.length === 0) {
      summary += `✅ No vulnerabilities found (threshold: ${severity})\n`;
    } else {
      summary += `⚠️ Found ${filtered.length} vulnerabilities\n\n`;
      summary += `| Package | Severity | Description | Version |\n|---|---|---|---|\n`;
      for (const [pkg, sev, desc, ver] of rows) {
        summary += `| ${pkg} | ${sev} | ${desc} | ${ver} |\n`;
      }
    }
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  }

  if (filtered.length > 0 && failOnVuln) {
    core.setFailed(`Found ${filtered.length} vulnerabilities at or above ${severity} severity`);
  } else {
    core.info(`Audit complete: ${filtered.length} vulnerabilities found`);
  }
}

main().catch(err => { core.setFailed(err.message); });
