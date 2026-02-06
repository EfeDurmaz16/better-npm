import { parseArgs } from './cli/parser.js';
import { createOutput, Output } from './cli/output.js';
import { getCommand, commands } from './cli/commands/index.js';
import { VERSION } from './index.js';

// Import commands to register them
import './cli/commands/install.js';
import './cli/commands/analyze.js';
import './cli/commands/cache.js';
import './cli/commands/doctor.js';
import './cli/commands/serve.js';

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const output = createOutput({ json: args.flags['json'] === true });

  // Handle --version
  if (args.flags['version'] || args.flags['v']) {
    output.log(`better v${VERSION}`);
    return 0;
  }

  // Handle --help or no command
  if (args.flags['help'] || args.flags['h'] || !args.command) {
    printHelp(output);
    return 0;
  }

  // Route to command
  const cmd = getCommand(args.command);
  if (!cmd) {
    output.error(`Unknown command: ${args.command}`);
    output.log(`Run 'better --help' for usage.`);
    return 1;
  }

  // Run command (config will be added later)
  return cmd.run({ args, output, config: {} as any });
}

function printHelp(output: Output): void {
  output.log(`better v${VERSION} - Production-grade dependency toolkit`);
  output.log('');
  output.log('Usage: better <command> [options]');
  output.log('');
  output.log('Commands:');
  for (const [name, cmd] of commands) {
    output.log(`  ${name.padEnd(12)} ${cmd.description}`);
  }
  output.log('');
  output.log('Global Options:');
  output.log('  --help, -h       Show this help message');
  output.log('  --version, -v    Show version');
  output.log('  --json           Output as JSON');
  output.log('  --log-level      Set log level (debug, info, warn, error, silent)');
  output.log('  --config         Path to config file');
}

main()
  .then(code => process.exit(code))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
