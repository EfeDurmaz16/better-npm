// actions/setup-better/dist/index.js
// Sets up the 'better' universal package manager in GitHub Actions

const core = require('@actions/core') ?? { getInput: () => '', addPath: () => {}, setFailed: (m) => process.exit(1), info: console.log };
const { execSync } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

async function main() {
  const version = (process.env.INPUT_VERSION || 'latest').trim();

  // Determine install strategy: prefer npm global install for simplicity
  const installCmd = version === 'latest'
    ? 'npm install -g better-npm@latest'
    : `npm install -g better-npm@${version}`;

  try {
    core.info?.(`Installing better ${version}...`);
    execSync(installCmd, { stdio: 'inherit' });

    // Verify installation
    const betterPath = execSync('which better || where better', { encoding: 'utf8' }).trim();
    core.info?.(`better installed at: ${betterPath}`);

    const versionOutput = execSync('better --version', { encoding: 'utf8' }).trim();
    core.info?.(`Installed: ${versionOutput}`);
  } catch (err) {
    const msg = `Failed to install better: ${err.message}`;
    if (core.setFailed) {
      core.setFailed(msg);
    } else {
      console.error(msg);
      process.exit(1);
    }
  }
}

main();
