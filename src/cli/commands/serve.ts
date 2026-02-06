import type { Command, CommandContext } from './index.js';
import { registerCommand } from './index.js';
import { WebServer } from '../../web/server.js';
import { execFileNoThrow } from '../../utils/execFileNoThrow.js';
import * as os from 'node:os';

const serveCommand: Command = {
  name: 'serve',
  description: 'Start web UI server for dependency visualization',
  async run(ctx: CommandContext): Promise<number> {
    const port = typeof ctx.args.flags['port'] === 'number'
      ? ctx.args.flags['port']
      : 3000;

    const noOpen = ctx.args.flags['no-open'] === true;
    const cwd = process.cwd();

    ctx.output.log(`Starting web server on port ${port}...`);

    const server = new WebServer({ port, cwd });

    try {
      await server.start();

      const url = `http://localhost:${port}`;
      ctx.output.log(`Server running at ${url}`);
      ctx.output.log('Press Ctrl+C to stop');

      // Open browser if not disabled
      if (!noOpen) {
        await openBrowser(url);
      }

      // Keep process alive
      await new Promise(() => {
        // This promise never resolves, keeping the server running
      });

      return 0;
    } catch (error) {
      ctx.output.error(`Failed to start server: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  },
};

async function openBrowser(url: string): Promise<void> {
  const platform = os.platform();
  let command: string;
  let args: string[];

  switch (platform) {
    case 'darwin':
      command = 'open';
      args = [url];
      break;
    case 'win32':
      command = 'cmd';
      args = ['/c', 'start', url];
      break;
    default:
      command = 'xdg-open';
      args = [url];
      break;
  }

  try {
    await execFileNoThrow(command, args);
  } catch (error) {
    console.error('Failed to open browser:', error instanceof Error ? error.message : String(error));
  }
}

registerCommand(serveCommand);

export default serveCommand;
