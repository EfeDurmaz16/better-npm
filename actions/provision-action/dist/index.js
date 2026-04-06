// actions/provision-action/dist/index.js
// Provisions OSP services for CI/CD environments using better

const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const core = (() => {
  try { return require('@actions/core'); } catch { return {
    getInput: (name) => process.env[`INPUT_${name.toUpperCase().replace(/-/g, '_')}`] || '',
    setOutput: (name, value) => process.stdout.write(`::set-output name=${name}::${value}\n`),
    setFailed: (msg) => { console.error(`::error::${msg}`); process.exitCode = 1; },
    info: console.log,
    exportVariable: (name, val) => {}
  }; }
})();

async function main() {
  const env = core.getInput('env') || 'preview';
  const projectRoot = path.resolve(core.getInput('project-root') || '.');
  const sardisToken = core.getInput('sardis-token');

  if (sardisToken) {
    process.env.SARDIS_TOKEN = sardisToken;
  }

  core.info(`Provisioning OSP services for ${env} environment in ${projectRoot}...`);

  try {
    const output = execFileSync(
      'better',
      ['infra', 'provision', '--json', '--env', env, '--project-root', projectRoot],
      { encoding: 'utf8', timeout: 120000 }
    );

    const result = JSON.parse(output);

    if (!result.ok) {
      core.setFailed(`Provisioning failed: ${result.error || 'unknown error'}`);
      return;
    }

    const services = result.services || [];
    core.setOutput('services', JSON.stringify(services));
    core.info(`Provisioned ${services.length} service(s)`);

    // Write .env file if credentials were returned
    if (result.env_vars) {
      const envPath = path.join(projectRoot, `.env.${env}`);
      const envContent = Object.entries(result.env_vars)
        .map(([k, v]) => `${k}=${v}`)
        .join('\n') + '\n';
      fs.writeFileSync(envPath, envContent);
      core.setOutput('env-file', envPath);
      core.info(`Environment variables written to ${envPath}`);

      // Export to GitHub Actions env
      for (const [k, v] of Object.entries(result.env_vars)) {
        core.exportVariable(k, String(v));
      }
    }
  } catch (err) {
    const output = err.stdout || '';
    try {
      const result = JSON.parse(output);
      if (result.error) {
        core.setFailed(`Provisioning failed: ${result.error}`);
        return;
      }
    } catch { /* ignore */ }
    core.setFailed(`better infra provision failed: ${err.message}`);
  }
}

main().catch(err => { core.setFailed(err.message); });
